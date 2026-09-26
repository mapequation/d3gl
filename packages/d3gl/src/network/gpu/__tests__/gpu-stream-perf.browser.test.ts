/**
 * T7 — the streaming GPU layout's per-frame guard (#352, spec §13), through the real trigger:
 * `network().data(g).lod(…).layout({ backend: "gpu" })`, real animation frames, one engine for both
 * reduction states (LOD off, then the Navigator's structural LOD on).
 *
 * Before #352 every streamed frame ran a synchronous `readPixels` after queueing a batch of ticks, so the
 * main thread waited for the whole batch: ~230 ms per frame at 325k (a 4 fps UI). Now a frame polls
 * fences, harvests a copy the GPU finished earlier, repaints (throttled), and encodes a budgeted slice of
 * ticks. Pinned here:
 *
 * - **Transport-only main thread per frame** (fence polls + harvest + encode + copy + fence, the
 *   repaint excluded) below a ceiling split into constant and linear terms, and the encode part within
 *   the controller's 2 ms cap (N-independent). A reintroduced synchronous read waits for the queued GPU
 *   work and trips it.
 * - **Deterministic signatures:** every `readPixels` on the streaming path lands in a bound PBO (a numeric
 *   offset, never a CPU array); every `getBufferSubData` comes after a fence inserted after the last copy
 *   has been seen signalled; within each frame the harvest precedes every layout draw; exactly one fence
 *   per frame; no GPU object created per frame once the stream runs; repaints at least `minFrameMs`
 *   (50 ms) apart; `settled` resolves only after the final tick's positions were harvested.
 * - **Throughput:** ticks/s under rendering, reported and floored against the GPU-only tick rate
 *   measured in the same file (a separate solver, before the stream).
 *
 * The LOD-on leg reports the main-thread ms per layout repaint (on this path the main thread still
 * builds and refits the LOD tree — PR 3c moves the refit to the worker and compares against the worker
 * baseline); both legs assert the same transport signatures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { DEFAULT_FORCE, seedPositions } from "../../force.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { MIN_FRAME_MS } from "../repaint-throttle.js";
import { makeTestDevice } from "./_device.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";

const LOCAL_N = 100_000; // the N the ceilings below were calibrated at
// Capped: SwiftShader (CI) ticks at ~3.4 ms per 1k nodes, so even the short run below would exceed the
// tier's per-file budget far past 200k. Real-GPU runs at 325k / 1M go through PERF_BROWSER_N by hand.
const N = perfN(LOCAL_N, { max: 1_000_000 });
const ITERATIONS = 60;
const W = 800;
const H = 600;

/** Minimal seeded LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A clustered graph at ~2.3 edges per node (mostly intra-community), the GPU guards' fixture shape. */
function clustered(n: number, seed: number): NetworkGraph {
  const rng = makePrng(seed);
  const communities = Math.max(1, Math.round(n / 400));
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.floor((i / n) * communities);
    const c0 = Math.floor((c / communities) * n);
    const c1 = Math.floor(((c + 1) / communities) * n);
    source.push(i);
    target.push(c0 + Math.floor(rng() * Math.max(1, c1 - c0)));
    if (rng() < 0.3) {
      source.push(i);
      target.push(Math.floor(rng() * n));
    }
  }
  return buildGraph({ nodeCount: n, source, target });
}

// ── GL call log ─────────────────────────────────────────────────────────────

type GlEvent =
  | { kind: "copy"; toPbo: boolean }
  | { kind: "harvest" }
  | { kind: "fence"; sync: WebGLSync | null }
  | { kind: "wait"; sync: WebGLSync; signaled: boolean }
  | { kind: "layout-draw" }
  | { kind: "create" }
  | { kind: "frame-end" };

/**
 * Logs the GL calls the streaming contract is about, in order, by wrapping the installed prototype
 * methods (cast-free: `defineProperty` takes the wrapper as a plain value) and restoring them after.
 */
class GlCallLog {
  readonly events: GlEvent[] = [];
  private readonly restores: (() => void)[] = [];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    const log = this.events;
    this.wrap(proto, "readPixels", (gl, args) => log.push({ kind: "copy", toPbo: typeof args[6] === "number" }));
    this.wrap(proto, "getBufferSubData", (gl, args) => {
      if (args[0] === gl.PIXEL_PACK_BUFFER) log.push({ kind: "harvest" });
    });
    this.wrap(proto, "clientWaitSync", (gl, args, result) => {
      const sync = args[0];
      if (sync instanceof WebGLSync) {
        log.push({ kind: "wait", sync, signaled: result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED });
      }
    });
    this.wrap(proto, "fenceSync", (_gl, _args, result) => log.push({ kind: "fence", sync: result instanceof WebGLSync ? result : null }));
    // The layout draws into its own framebuffers with plain drawArrays; the engine's lanes are instanced
    // draws into the canvas.
    this.wrap(proto, "drawArrays", (gl) => {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) log.push({ kind: "layout-draw" });
    });
    for (const name of ["createBuffer", "createTexture", "createFramebuffer"] as const) {
      this.wrap(proto, name, () => log.push({ kind: "create" }));
    }
  }

  private wrap(
    proto: WebGL2RenderingContext,
    name: "readPixels" | "getBufferSubData" | "clientWaitSync" | "fenceSync" | "drawArrays" | "createBuffer" | "createTexture" | "createFramebuffer",
    after: (gl: WebGL2RenderingContext, args: unknown[], result: unknown) => void,
  ): void {
    const installed: unknown = Reflect.get(proto, name);
    if (typeof installed !== "function") throw new Error(`no ${name}`);
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const result: unknown = Reflect.apply(installed, this, args);
        after(this, args, result);
        return result;
      },
    });
    this.restores.push(() => Object.defineProperty(proto, name, { configurable: true, writable: true, value: installed }));
  }

  restore(): void {
    for (const r of this.restores) r();
  }
}

/** What one leg observed. */
interface Leg {
  frames: GpuFrameSample[];
  events: GlEvent[];
  settledAfterFrame: number;
  elapsedMs: number;
}

/** Run one GPU layout on `net` over `graph`, recording every streamed frame and the GL call log. */
async function streamLeg(net: Network, graph: NetworkGraph, lod: boolean): Promise<Leg> {
  const frames: GpuFrameSample[] = [];
  const log = new GlCallLog();
  let settledAfterFrame = -1;
  const unobserve = observeGpuLayoutFrames((s) => {
    frames.push({ ...s });
    log.events.push({ kind: "frame-end" });
  });
  const t0 = performance.now();
  try {
    net.data(graph).lod(lod ? { source: "structure", declutter: true, superEdges: true } : false);
    net.layout({ backend: "gpu", iterations: ITERATIONS });
    await net.whenSettled();
    settledAfterFrame = frames.length;
  } finally {
    unobserve();
    log.restore();
  }
  expect(net.layoutTransport).toBe("gpu");
  return { frames, events: log.events, settledAfterFrame, elapsedMs: performance.now() - t0 };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}
function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

/** Split the log into per-frame segments (the observer closes each frame). */
function perFrame(events: GlEvent[]): GlEvent[][] {
  const out: GlEvent[][] = [[]];
  for (const e of events) {
    if (e.kind === "frame-end") out.push([]);
    else out[out.length - 1]?.push(e);
  }
  out.pop(); // after the last frame-end: the settle repaint etc., not a streamed frame
  return out;
}

/** The deterministic streaming signatures every leg must show. */
function assertSignatures(leg: Leg): void {
  const { frames, events } = leg;
  expect(frames.length).toBeGreaterThan(3);

  // Every readPixels on the streaming path lands in a PBO.
  const copies = events.filter((e) => e.kind === "copy");
  expect(copies.length).toBeGreaterThan(0);
  expect(copies.every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels on the streaming path").toBe(true);

  // Every harvest reads a copy whose fence (inserted after the copy) was seen signalled before it.
  const fenceAt = new Map<WebGLSync, number>();
  let lastCopy = -1;
  events.forEach((e, i) => {
    if (e.kind === "copy") lastCopy = i;
    else if (e.kind === "fence" && e.sync) fenceAt.set(e.sync, i);
    else if (e.kind === "harvest") {
      let ok = false;
      for (let j = i - 1; j > lastCopy && !ok; j--) {
        const w = events[j];
        if (w?.kind === "wait" && w.signaled && (fenceAt.get(w.sync) ?? -1) > lastCopy) ok = true;
      }
      expect(ok, `harvest #${i} before its copy's fence signalled`).toBe(true);
    }
  });

  const segments = perFrame(events);
  expect(segments.length).toBe(frames.length);
  segments.forEach((seg, f) => {
    // One budget fence per frame.
    expect(seg.filter((e) => e.kind === "fence").length, `frame ${f} fences`).toBe(1);
    // The harvest precedes every layout draw of the frame.
    const harvest = seg.findIndex((e) => e.kind === "harvest");
    if (harvest >= 0) {
      const firstDraw = seg.findIndex((e) => e.kind === "layout-draw");
      if (firstDraw >= 0) expect(harvest, `frame ${f}: harvest after an encode`).toBeLessThan(firstDraw);
    }
  });

  // No GPU object created per frame once the stream runs (the first repaint of new data may allocate
  // the lanes' buffers; everything after it reuses them).
  const firstRepaint = frames.findIndex((s) => s.repaintMs > 0);
  const later = segments.slice(firstRepaint + 1).flat().filter((e) => e.kind === "create").length;
  expect(later, "GPU objects created per streamed frame").toBe(0);

  // Repaints throttled to ≥ minFrameMs apart (the final one, which always paints, excepted).
  const repaints = frames.filter((s) => s.repaintMs > 0).map((s) => s.now);
  for (let i = 1; i < repaints.length - 1; i++) {
    expect((repaints[i] ?? 0) - (repaints[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_FRAME_MS - 2);
  }

  // settled only after the final positions were harvested.
  const finalHarvest = frames.findIndex((s) => s.harvestedTicks === ITERATIONS);
  expect(finalHarvest).toBeGreaterThanOrEqual(0);
  expect(finalHarvest).toBeLessThan(leg.settledAfterFrame);
}

function report(label: string, leg: Leg): { transport: number[]; encode: number[]; ticksPerSec: number } {
  const { frames } = leg;
  const transport = frames.map((s) => s.harvestMs + s.encodeMs);
  const encode = frames.map((s) => s.encodeMs);
  const repaint = frames.filter((s) => s.repaintMs > 0).map((s) => s.repaintMs);
  const intervals = frames.slice(1).map((s, i) => s.now - (frames[i]?.now ?? s.now));
  const first = frames[0]?.now ?? 0;
  const last = frames[frames.length - 1]?.now ?? first;
  const ticksPerSec = (ITERATIONS / Math.max(1, last - first)) * 1000;
  console.log(
    `  GPU stream [${label}] N=${N}: ${frames.length} frames, ${repaint.length} repaints, ` +
      `transport ms/frame median ${median(transport).toFixed(2)} p95 ${quantile(transport, 0.95).toFixed(2)} max ${Math.max(...transport).toFixed(2)}; ` +
      `encode median ${median(encode).toFixed(2)} p95 ${quantile(encode, 0.95).toFixed(2)}; ` +
      `repaint ms median ${median(repaint).toFixed(1)} max ${Math.max(0, ...repaint).toFixed(1)}; ` +
      `rAF interval median ${median(intervals).toFixed(1)} ms; ${ticksPerSec.toFixed(1)} ticks/s; ` +
      `${ITERATIONS} ticks in ${leg.elapsedMs.toFixed(0)} ms; bands ${frames[frames.length - 1]?.bands}, blocked ${frames.filter((s) => s.blocked).length}`,
  );
  return { transport, encode, ticksPerSec };
}

describe("GPU layout streaming per frame (#352) — network().layout({ backend: 'gpu' })", () => {
  let host: HTMLElement;
  let net: Network;
  let graph: NetworkGraph;
  let gpuOnlyTicksPerSec = 0;

  beforeAll(async () => {
    graph = clustered(N, 0x5712);
    // The GPU-only tick rate on this machine: a separate solver from the seed the layout starts from,
    // run and fenced, before any stream.
    const device: Device = await makeTestDevice();
    try {
      const seeded = { ...graph, positions: graph.positions.slice() };
      seedPositions(seeded, W, H, { force: DEFAULT_FORCE });
      const solo = new GpuForceLayout(device, seeded, DEFAULT_FORCE);
      const out = new Float32Array(N * 2);
      solo.runFrame(2);
      solo.readPositions(out);
      const t0 = performance.now();
      solo.runFrame(10);
      solo.readPositions(out);
      gpuOnlyTicksPerSec = 10_000 / (performance.now() - t0);
      solo.destroy();
    } finally {
      device.destroy();
    }
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // Warm-up on the same engine: the capability probe, shader compiles and the lane programs.
    net.data(clustered(2_000, 1)).layout({ backend: "gpu", iterations: 5 });
    await net.whenSettled();
  }, perfBudget(120_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  // Calibrated at LOCAL_N (see the PR's Performance section for the measured numbers). The transport's
  // own main-thread work per frame is a fence poll, a memcpy of 8 B per node on harvest frames, and at
  // most 2 ms of encode: constant plus a small linear term. A synchronous read in the frame waits for
  // every queued tick (tens of ms at this N on a real GPU, seconds under SwiftShader).
  const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / LOCAL_N));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

  it("LOD off: bounded transport main thread, async readback signatures, throughput", async () => {
    const leg = await streamLeg(net, graph, false);
    const { transport, encode, ticksPerSec } = report("LOD off", leg);
    console.log(`  GPU-only tick rate: ${gpuOnlyTicksPerSec.toFixed(1)} ticks/s`);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    // The layout gets ≤ 60% of each frame's GPU time, and the encode cap binds at small N: a quarter of
    // the GPU-only rate is a floor a working stream clears with room to spare.
    expect(ticksPerSec).toBeGreaterThan(0.25 * gpuOnlyTicksPerSec * 0.6);
  }, perfBudget(240_000));

  it("LOD on (structural cut, declutter, super-edges): the same transport bounds; repaint cost reported", async () => {
    const leg = await streamLeg(net, graph, true);
    const { transport, encode } = report("LOD on", leg);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
  }, perfBudget(240_000));
});
