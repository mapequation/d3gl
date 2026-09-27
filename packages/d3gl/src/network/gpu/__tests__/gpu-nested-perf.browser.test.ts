/**
 * The GPU nested layout's per-frame guard (#355, AGENTS §5), through the real trigger:
 * `network().data(g, { modules }).lod(…).layout({ backend: "gpu", nested: true })`, real animation frames,
 * one engine for both reduction states (LOD off, then LOD on over the module tree).
 *
 * A cold nested layout streams as one animation of all depths: each frame polls fences, harvests a
 * composed copy the GPU finished earlier (leaf positions and module discs, packed in node order),
 * repaints (throttled), and encodes a budgeted slice of stream ticks — every pass cut into row bands
 * (#382), the composition of a readback too. Pinned here:
 *
 * - **Transport-only main thread per frame** (fence polls + harvest + encode + copy + fence, the repaint
 *   excluded) below a ceiling split into constant and linear terms, and the encode within the
 *   controller's 2 ms cap (N-independent).
 * - **Repaints** at least `minFrameMs` apart (the throttle), and **throughput**: stream ticks per second
 *   above a floor set by the same solve's GPU-only rate on this machine — the one check that sees a
 *   GPU-process stall (a harvest that waits on the GPU does not show in main-thread time).
 * - **Deterministic signatures:** every `readPixels` on the streaming path lands in a bound PBO; every
 *   harvest comes after a fence inserted after its copy was seen signalled; one fence per frame; the
 *   harvest precedes the frame's layout draws; no GPU object created per streamed frame once the stream
 *   runs; `settled` only after the final stream tick's positions were harvested.
 * - **Per tick:** a solve tick allocates nothing, and a compact collision step draws exactly one count
 *   scatter and {@link COLLISION_ROUNDS} round scatters of N points (the K-occupant grid's fixed passes) —
 *   in bands, scatters covering every slot once per pass — never a draw of N points into a 1×1 viewport
 *   (#349).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Device } from "@luma.gl/core";
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { GpuNestedLayout } from "../gpu-nested-layout.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { COLLISION_ROUNDS, COLLISION_STEPS } from "../passes/collision.js";
import { MIN_FRAME_MS } from "../repaint-throttle.js";
import { makeTestDevice } from "./_device.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";

const LOCAL_N = 20_000; // the leaves the fixture defaults to (the ceilings below were measured there)
// Capped: SwiftShader runs the compact phase's collision gathers slowly (a dense segment falls back to
// its exact loop); real-GPU runs at 325k / 1M go through PERF_BROWSER_N by hand.
const N = perfN(LOCAL_N, { max: 1_000_000 });
const ITERATIONS = 30; // 18 organise + 12 compact solve ticks = 18 + 24 stream ticks
const STREAM_TICKS = 18 + COLLISION_STEPS * 12;
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

/**
 * An Infomap-shaped map over `n` leaves: top modules of ~10 mid modules of ~40 leaves (so the bottom
 * segments take the tile + grid paths), leaves chained inside each bottom module, a few random links
 * between modules (the super-edges the sibling springs read), and a heavy-tailed flow.
 */
function infomapLike(n: number): { graph: NetworkGraph; modules: ModuleNode[] } {
  const rng = makePrng(0x355);
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const flow = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    const bottom = Math.floor(id / 40);
    modules.push({ id, path: [Math.floor(bottom / 10) + 1, (bottom % 10) + 1, (id % 40) + 1] });
    if (id % 40) {
      source.push(id - 1);
      target.push(id);
    }
    if (rng() < 0.2) {
      source.push(id);
      target.push(Math.floor(rng() * n));
    }
    flow[id] = (rng() + 0.05) ** -1.2;
  }
  return { graph: buildGraph({ nodeCount: n, source, target, nodeFlow: flow }), modules };
}

// ── GL call log (the flat streaming guard's, gpu-stream-perf.browser.test.ts) ────────────────────────

type GlEvent =
  | { kind: "copy"; toPbo: boolean }
  | { kind: "harvest" }
  | { kind: "fence"; sync: WebGLSync | null }
  | { kind: "wait"; sync: WebGLSync; signaled: boolean }
  | { kind: "layout-draw"; count: number; viewport1x1: boolean; points: boolean }
  | { kind: "create" }
  | { kind: "frame-end" };

class GlCallLog {
  readonly events: GlEvent[] = [];
  private readonly restores: (() => void)[] = [];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    const log = this.events;
    this.wrap(proto, "readPixels", (_gl, args) => log.push({ kind: "copy", toPbo: typeof args[6] === "number" }));
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
    this.wrap(proto, "drawArrays", (gl, args) => {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === null) return;
      const vp: unknown = gl.getParameter(gl.VIEWPORT);
      const one = vp instanceof Int32Array && vp[2] === 1 && vp[3] === 1;
      log.push({ kind: "layout-draw", count: typeof args[2] === "number" ? args[2] : 0, viewport1x1: one, points: args[0] === gl.POINTS });
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

interface Leg {
  frames: GpuFrameSample[];
  events: GlEvent[];
  settledAfterFrame: number;
  elapsedMs: number;
}

async function streamLeg(net: Network, graph: NetworkGraph, modules: ModuleNode[], lod: boolean): Promise<Leg> {
  const frames: GpuFrameSample[] = [];
  const log = new GlCallLog();
  let settledAfterFrame = -1;
  const unobserve = observeGpuLayoutFrames((s) => {
    frames.push({ ...s });
    log.events.push({ kind: "frame-end" });
  });
  const t0 = performance.now();
  try {
    net.data(graph, { modules }).lod(lod ? { declutter: true } : false);
    net.layout({ backend: "gpu", nested: { iterations: ITERATIONS } });
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

function perFrame(events: GlEvent[]): GlEvent[][] {
  const out: GlEvent[][] = [[]];
  for (const e of events) {
    if (e.kind === "frame-end") out.push([]);
    else out[out.length - 1]?.push(e);
  }
  out.pop();
  return out;
}

function assertSignatures(leg: Leg): void {
  const { frames, events } = leg;
  expect(frames.length).toBeGreaterThan(3);
  const copies = events.filter((e) => e.kind === "copy");
  expect(copies.length).toBeGreaterThan(1); // a cold layout streams: more than the final copy
  expect(copies.every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels on the streaming path").toBe(true);

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
    expect(seg.filter((e) => e.kind === "fence").length, `frame ${f} fences`).toBe(1);
    const harvest = seg.findIndex((e) => e.kind === "harvest");
    if (harvest >= 0) {
      const firstDraw = seg.findIndex((e) => e.kind === "layout-draw");
      if (firstDraw >= 0) expect(harvest, `frame ${f}: harvest after an encode`).toBeLessThan(firstDraw);
    }
  });
  const firstRepaint = frames.findIndex((s) => s.repaintMs > 0);
  const later = segments.slice(firstRepaint + 1).flat().filter((e) => e.kind === "create").length;
  expect(later, "GPU objects created per streamed frame").toBe(0);
  // Repaints (a harvest runs onFrame) throttled to ≥ minFrameMs apart; the final one always paints.
  const repaints = frames.filter((s) => s.harvested).map((s) => s.now);
  for (let i = 1; i < repaints.length - 1; i++) {
    expect((repaints[i] ?? 0) - (repaints[i - 1] ?? 0), `repaint ${i} after the previous`).toBeGreaterThanOrEqual(MIN_FRAME_MS - 2);
  }
  const onePixel = events.filter((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= N);
  expect(onePixel.length, "a draw of ≥ N points into a 1×1 viewport").toBe(0);

  // The real transport keeps a frame's estimated layout GPU work within its budget, readback frames
  // included (#382): past the first item the budget admits one only while the sum fits.
  frames.forEach((s, f) => {
    if (s.items > 1) expect(s.itemsMs, `frame ${f}: ${s.items} items`).toBeLessThanOrEqual(s.budgetMs + 1e-9);
  });

  const finalHarvest = frames.findIndex((s) => s.harvestedTicks === STREAM_TICKS);
  expect(finalHarvest, `harvested ticks: ${frames.filter((s) => s.harvested).map((s) => s.harvestedTicks).join(", ")}; ticks done ${frames.map((s) => s.ticksDone).slice(-5).join(", ")}`).toBeGreaterThanOrEqual(0);
  expect(finalHarvest).toBeLessThan(leg.settledAfterFrame);
}

function report(label: string, leg: Leg): { transport: number[]; encode: number[]; ticksPerSec: number } {
  const { frames } = leg;
  const transport = frames.map((s) => s.harvestMs + s.encodeMs);
  const encode = frames.map((s) => s.encodeMs);
  const repaint = frames.filter((s) => s.repaintMs > 0).map((s) => s.repaintMs);
  const first = frames[0]?.now ?? 0;
  const last = frames[frames.length - 1]?.now ?? first;
  const ticksPerSec = (STREAM_TICKS / Math.max(1, last - first)) * 1000;
  console.log(
    `  GPU nested stream [${label}] N=${N}: ${frames.length} frames, ${repaint.length} repaints, ` +
      `transport ms/frame median ${median(transport).toFixed(2)} p95 ${quantile(transport, 0.95).toFixed(2)} max ${Math.max(...transport).toFixed(2)}; ` +
      `encode median ${median(encode).toFixed(2)}; repaint ms median ${median(repaint).toFixed(1)}; ` +
      `${STREAM_TICKS} stream ticks in ${leg.elapsedMs.toFixed(0)} ms (${ticksPerSec.toFixed(1)} stream ticks/s over the frames); ` +
      `bands max ${Math.max(...frames.map((s) => s.bands))}, blocked ${frames.filter((s) => s.blocked).length}`,
  );
  return { transport, encode, ticksPerSec };
}

describe("GPU nested layout per frame (#355) — network().layout({ backend: 'gpu', nested })", () => {
  let host: HTMLElement;
  let net: Network;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let gpuOnlyTicksPerSec = 0;

  beforeAll(async () => {
    fixture = infomapLike(N);
    // The GPU-only rate of the same solve on this machine: its stream ticks unsliced, fenced by a read, on
    // a device of its own, before any stream (one warm-up tick first).
    const device = await makeTestDevice();
    try {
      const tree = buildModuleLODTree(fixture.graph.nodeCount, fixture.modules, fixture.graph);
      const parent = tree.parent;
      if (!parent) throw new Error("module trees carry a parent map");
      const solver = nestedSolverTopology({ ...tree, parent }, { iterations: ITERATIONS, size: fixture.graph.flow ?? undefined });
      const solo = new GpuNestedLayout(device, solver);
      const local = new Float32Array(2 * solver.slotCount);
      solo.runTicks(1);
      solo.readLocal(local);
      const t0 = performance.now();
      solo.runTicks(ITERATIONS - 1);
      solo.readLocal(local);
      gpuOnlyTicksPerSec = ((STREAM_TICKS - 1) * 1000) / (performance.now() - t0);
      solo.destroy();
    } finally {
      device.destroy();
    }
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // Warm-up on the same engine: the capability probe, shader compiles and the lane programs.
    const warm = infomapLike(2_000);
    net.data(warm.graph, { modules: warm.modules }).layout({ backend: "gpu", nested: { iterations: 5 } });
    await net.whenSettled();
  }, perfBudget(120_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  // The transport's own main-thread work per frame is fence polls, a memcpy of 8 B per leaf (+ 16 B per
  // module, about 0.4 B per leaf here) on harvest frames and at most 2 ms of encode: the flat guard's
  // ceiling, whose linear term is per 100k nodes (measured at 20k leaves on SwiftShader: p95 2.0 ms, max
  // 2.6 ms, against 4.4 ms). A synchronous read in the frame waits for every queued stream tick.
  const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / 100_000));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

  it("LOD off: bounded transport main thread, the async readback signatures, throughput", async () => {
    const leg = await streamLeg(net, fixture.graph, fixture.modules, false);
    const { transport, encode, ticksPerSec } = report("LOD off", leg);
    console.log(`  GPU-only nested solve: ${gpuOnlyTicksPerSec.toFixed(1)} stream ticks/s`);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    // The layout gets ≤ 60% of each frame's GPU time and the repaints share the main thread: a quarter of
    // that share of the GPU-only rate is a floor a working stream clears with room to spare (the flat guard's).
    expect(ticksPerSec).toBeGreaterThan(0.25 * gpuOnlyTicksPerSec * 0.6);
  }, perfBudget(300_000));

  it("LOD on (the module tree, declutter): the same transport bounds and signatures", async () => {
    const leg = await streamLeg(net, fixture.graph, fixture.modules, true);
    const { transport, encode } = report("LOD on", leg);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
  }, perfBudget(300_000));
});

describe("GPU nested solve per tick (#355)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("allocates nothing per tick or per readback, and a collision step draws its fixed scatters", () => {
    const { graph, modules } = infomapLike(Math.min(N, 50_000));
    const tree = buildModuleLODTree(graph.nodeCount, modules, graph);
    const parent = tree.parent;
    if (!parent) throw new Error("module trees carry a parent map");
    const solver = nestedSolverTopology({ ...tree, parent }, { iterations: 10, size: graph.flow ?? undefined });
    const layout = new GpuNestedLayout(device, solver);
    const log = new GlCallLog();
    const scatters = (from: number): number[] =>
      log.events.slice(from).flatMap((e) => (e.kind === "layout-draw" && e.points ? [e.count] : []));
    try {
      layout.runTicks(6); // organise
      layout.composeReadback();
      const organiseCreates = log.events.filter((e) => e.kind === "create").length;
      // Compact, collision step 1, whole: one count scatter and the rounds, each over every slot.
      let before = log.events.length;
      for (const stage of layout.tickStages()) stage.run(0, 1);
      const whole = scatters(before);
      // Collision step 2 with every pass in 3 bands: the same passes, each cut into 3 slot ranges.
      before = log.events.length;
      for (const stage of layout.tickStages()) for (let b = 0; b < 3; b++) stage.run(b, 3);
      const sliced = scatters(before);
      layout.runTicks(3);
      for (const stage of layout.readbackStages()) for (let b = 0; b < 4; b++) stage.run(b, 4);
      expect(organiseCreates, "GPU objects created by organise ticks or a readback").toBe(0);
      expect(log.events.filter((e) => e.kind === "create").length, "GPU objects created by compact ticks or a sliced readback").toBe(0);
      // One count scatter and the rounds, each over every slot: the grid's fixed pass count.
      expect(whole).toEqual(new Array<number>(1 + COLLISION_ROUNDS).fill(solver.slotCount));
      expect(sliced.length).toBe(3 * (1 + COLLISION_ROUNDS));
      expect(sliced.reduce((a, c) => a + c, 0)).toBe((1 + COLLISION_ROUNDS) * solver.slotCount);
      expect(log.events.some((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= solver.slotCount)).toBe(false);
    } finally {
      log.restore();
      layout.destroy();
    }
  });
});
