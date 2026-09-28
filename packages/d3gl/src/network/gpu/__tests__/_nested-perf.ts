/**
 * The shared harness of the GPU nested layout's per-frame guards (#355, #380): the fixtures (an
 * Infomap-shaped map, a Zipf module), the GL call log and the streaming signatures, the stream leg through
 * the real trigger, and the GPU-only rate. The guards are split across files so each stays within the
 * browser perf tier's 300 s per file: `gpu-nested-perf.browser.test.ts` (the Infomap-shaped stream, LOD off
 * and on; the per-tick signatures; the Zipf module's collision plan) and `gpu-nested-zipf-perf.browser.test.ts`
 * (the Zipf module's stream). See `gpu-nested-perf.browser.test.ts` for what they pin.
 */
import { expect } from "vitest";
import type { Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { GpuNestedLayout } from "../gpu-nested-layout.js";
import { nestedSolverTopology, type NestedSolverTopology } from "../nested-topology.js";
import { COLLISION_STEPS } from "../passes/collision.js";
import { MIN_FRAME_MS } from "../repaint-throttle.js";
import { makeTestDevice } from "./_device.js";
import { perfN } from "../../../__tests__/perf-budget.js";

export const LOCAL_N = 20_000; // the leaves the fixture defaults to (the ceilings below were measured there)
// Capped: SwiftShader runs the compact phase's collision gathers slowly (a dense segment falls back to
// its exact loop); real-GPU runs at 325k / 1M go through PERF_BROWSER_N by hand.
export const N = perfN(LOCAL_N, { max: 1_000_000 });
/**
 * Children of the Zipf module of the #380 legs (`gpu-nested-zipf-perf.browser.test.ts` and the plan legs
 * of `gpu-nested-perf.browser.test.ts`). Capped at 60,000 children, for two reasons measured at CI's 100k
 * on SwiftShader. The stream leg alone took 270 s (137 s at 60,000), and the tier gives a file 300 s. And
 * this fixture's layout piles more than 12 discs into a sub-cell at the first compact steps, so the exact
 * fallback runs (#380 D3, 9,503 slots at the first compact step), which the pair-work test rejects.
 */
export const ZIPF_BIG = Math.min(N, 60_000);
export const ITERATIONS = 30; // 18 organise + 12 compact solve ticks = 18 + 24 stream ticks
export const STREAM_TICKS = 18 + COLLISION_STEPS * 12;
export const W = 800;
export const H = 600;

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
export function infomapLike(n: number): { graph: NetworkGraph; modules: ModuleNode[] } {
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

/**
 * A two-level map with one module of `big` leaves of Zipf flows (1/rank: radii spanning √big) and 20
 * modules of 40, leaves chained inside each module plus a random link from 30% of them — the shape that
 * made a single-scale collision grid quadratic (#380).
 */
export function zipfLike(big: number): { graph: NetworkGraph; modules: ModuleNode[] } {
  const rng = makePrng(0x380);
  const n = big + 800;
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const flow = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    const inBig = id < big;
    const rank = inBig ? id : (id - big) % 40;
    modules.push({ id, path: [inBig ? 1 : 2 + Math.floor((id - big) / 40), rank + 1] });
    flow[id] = inBig ? 1 / (id + 1) : 0.001 * (rng() + 0.05) ** -1.2;
    if (rank > 0) {
      source.push(id - 1);
      target.push(id);
    }
    if (rng() < 0.3) {
      source.push(id);
      target.push(Math.floor(rng() * n));
    }
  }
  return { graph: buildGraph({ nodeCount: n, source, target, nodeFlow: flow }), modules };
}

/** The batched solve of a map, as the engine builds it (tests drive its work items directly). */
export function solverOf({ graph, modules }: { graph: NetworkGraph; modules: ModuleNode[] }, iterations: number): NestedSolverTopology {
  const tree = buildModuleLODTree(graph.nodeCount, modules, graph);
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  return nestedSolverTopology({ ...tree, parent }, { iterations, size: graph.flow ?? undefined });
}

// ── GL call log (the flat streaming guard's, _gpu-stream-harness.ts) ────────────────────────────────

export type GlEvent =
  | { kind: "copy"; toPbo: boolean }
  | { kind: "harvest" }
  | { kind: "fence"; sync: WebGLSync | null }
  | { kind: "wait"; sync: WebGLSync; signaled: boolean }
  | { kind: "layout-draw"; count: number; viewport1x1: boolean; points: boolean }
  | { kind: "create" }
  | { kind: "frame-end" };

export class GlCallLog {
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

export interface Leg {
  frames: GpuFrameSample[];
  events: GlEvent[];
  settledAfterFrame: number;
  elapsedMs: number;
}

export async function streamLeg(net: Network, graph: NetworkGraph, modules: ModuleNode[], lod: boolean): Promise<Leg> {
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

/**
 * The GPU-only rate of a map's solve on this machine, stream ticks per second: its stream ticks unsliced,
 * fenced by a read, on a device of its own, before any stream (one warm-up tick first).
 */
export async function gpuOnlyRate(map: { graph: NetworkGraph; modules: ModuleNode[] }): Promise<number> {
  const device = await makeTestDevice();
  try {
    const solver = solverOf(map, ITERATIONS);
    const solo = new GpuNestedLayout(device, solver);
    const local = new Float32Array(2 * solver.slotCount);
    solo.runTicks(1);
    solo.readLocal(local);
    const t0 = performance.now();
    solo.runTicks(ITERATIONS - 1);
    solo.readLocal(local);
    solo.destroy();
    return ((STREAM_TICKS - 1) * 1000) / (performance.now() - t0);
  } finally {
    device.destroy();
  }
}

export function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}
export function quantile(xs: number[], q: number): number {
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

export function assertSignatures(leg: Leg): void {
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

  const finalHarvest = frames.findIndex((s) => s.harvestedTicks === STREAM_TICKS);
  expect(finalHarvest, `harvested ticks: ${frames.filter((s) => s.harvested).map((s) => s.harvestedTicks).join(", ")}; ticks done ${frames.map((s) => s.ticksDone).slice(-5).join(", ")}`).toBeGreaterThanOrEqual(0);
  expect(finalHarvest).toBeLessThan(leg.settledAfterFrame);
}

export function report(label: string, leg: Leg): { transport: number[]; encode: number[]; ticksPerSec: number } {
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
