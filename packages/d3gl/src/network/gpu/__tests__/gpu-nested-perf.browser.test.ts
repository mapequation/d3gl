/**
 * The GPU nested layout's per-frame guard (#355, AGENTS §5), through the real trigger:
 * `network().data(g, { modules }).lod(…).layout({ backend: "gpu", nested: true })`, real animation frames,
 * one engine for both reduction states (LOD off, then LOD on over the module tree).
 *
 * A cold nested layout streams as one animation of all depths: each frame polls fences, harvests a
 * composed copy the GPU finished earlier (leaf positions and module discs, packed in node order),
 * repaints (throttled), and encodes a budgeted slice of stream ticks — the organise ticks' repulsion and
 * the compact ticks' collision gathers cut into row bands. Pinned here:
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
 *   scatter and K round scatters per hash table (the class cells', {@link COLLISION_ROUNDS}; the sub-cells',
 *   {@link COLLISION_SUB_ROUNDS}) of the binned slots (the radius-class grid's fixed passes), never a draw
 *   of N points into a 1×1 viewport (#349).
 * - **A module of very uneven child sizes** (#380; a single-scale grid made its gather quadratic, 157 ms
 *   frames at 60,000 children): the same per-frame bounds and signatures through the real trigger, a
 *   collision step's pair work within 3× of the collision plan's estimate with no slot on the exact
 *   fallback, and the gather cut into bands of equal estimated work (the frame budget admits a band by its
 *   share of the estimate; bands of equal rows put the big module's work in the first).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Device } from "@luma.gl/core";
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { GpuNestedLayout } from "../gpu-nested-layout.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { COLLISION_ROUNDS, COLLISION_STEPS, COLLISION_SUB_ROUNDS } from "../passes/collision.js";
import type { NestedSolverTopology } from "../nested-topology.js";
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

/**
 * A two-level map with one module of `big` leaves of Zipf flows (1/rank: radii spanning √big) and 20
 * modules of 40, leaves chained inside each module plus a random link from 30% of them — the shape that
 * made a single-scale collision grid quadratic (#380).
 */
function zipfLike(big: number): { graph: NetworkGraph; modules: ModuleNode[] } {
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
function solverOf({ graph, modules }: { graph: NetworkGraph; modules: ModuleNode[] }, iterations: number): NestedSolverTopology {
  const tree = buildModuleLODTree(graph.nodeCount, modules, graph);
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  return nestedSolverTopology({ ...tree, parent }, { iterations, size: graph.flow ?? undefined });
}

// ── GL call log (the flat streaming guard's, _gpu-stream-harness.ts) ────────────────────────────────

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

/**
 * The GPU-only rate of a map's solve on this machine, stream ticks per second: its stream ticks unsliced,
 * fenced by a read, on a device of its own, before any stream (one warm-up tick first).
 */
async function gpuOnlyRate(map: { graph: NetworkGraph; modules: ModuleNode[] }): Promise<number> {
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
    gpuOnlyTicksPerSec = await gpuOnlyRate(fixture);
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

describe("GPU nested solve per tick (#355, #380)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("allocates nothing per tick or per readback, and a collision step draws its fixed scatters", () => {
    // A Zipf module, so the radius-class grid bins slots (an even map's small modules take the exact loop).
    const solver = solverOf(zipfLike(Math.min(N, 20_000)), 10);
    const binned = solver.collision.binnedSlots.length;
    expect(binned).toBeGreaterThan(0);
    const layout = new GpuNestedLayout(device, solver);
    const log = new GlCallLog();
    try {
      layout.runTicks(6); // organise
      layout.prepareReadback();
      const organiseCreates = log.events.filter((e) => e.kind === "create").length;
      const before = log.events.length;
      layout.beginTick(); // compact, collision step 1: its cells, then each table's counts and rounds
      layout.forceBand(0, 3);
      layout.forceBand(1, 3);
      layout.forceBand(2, 3);
      layout.integrate();
      const step = log.events.slice(before).filter((e) => e.kind === "layout-draw" && e.points);
      layout.runTicks(3);
      layout.prepareReadback();
      expect(organiseCreates, "GPU objects created by organise ticks or a readback").toBe(0);
      expect(log.events.filter((e) => e.kind === "create").length, "GPU objects created by compact ticks").toBe(0);
      // Per table one count scatter and its rounds, each over the binned slots: the grid's fixed pass count.
      expect(step.length).toBe(2 + COLLISION_ROUNDS + COLLISION_SUB_ROUNDS);
      expect(step.every((e) => e.kind === "layout-draw" && e.count === binned)).toBe(true);
      expect(log.events.some((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= solver.slotCount)).toBe(false);
    } finally {
      log.restore();
      layout.destroy();
    }
  });
});

describe("GPU nested layout per frame on a module of very uneven child sizes (#380)", () => {
  // Capped at 60,000 children, for two reasons measured at CI's 100k on SwiftShader. This leg alone took
  // 270 s (137 s at 60,000), and the tier gives the whole file 300 s. And this fixture's layout piles more
  // than 12 discs into a sub-cell at the first compact steps, so the exact fallback runs (#380 D3, 9,503
  // slots at the first compact step), which the pair-work test rejects.
  const BIG = Math.min(N, 60_000);
  let host: HTMLElement;
  let net: Network;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let gpuOnlyTicksPerSec = 0;
  let device: Device;

  beforeAll(async () => {
    fixture = zipfLike(BIG);
    gpuOnlyTicksPerSec = await gpuOnlyRate(fixture);
    device = await makeTestDevice();
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const warm = zipfLike(2_000);
    net.data(warm.graph, { modules: warm.modules }).layout({ backend: "gpu", nested: { iterations: 5 } });
    await net.whenSettled();
  }, perfBudget(300_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  const TRANSPORT_P95_MS = perfBudget(4 + 2 * ((BIG + 800) / 100_000));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

  it("LOD off: bounded transport main thread, the async readback signatures, throughput", async () => {
    const leg = await streamLeg(net, fixture.graph, fixture.modules, false);
    const { transport, encode, ticksPerSec } = report("Zipf, LOD off", leg);
    console.log(`  GPU-only nested solve (Zipf ${BIG}): ${gpuOnlyTicksPerSec.toFixed(1)} stream ticks/s`);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    expect(ticksPerSec).toBeGreaterThan(0.25 * gpuOnlyTicksPerSec * 0.6);
  }, perfBudget(600_000));

  it("a collision step's pair work stays within 3× of the collision plan's estimate, with no slot on the exact fallback", () => {
    const solver = solverOf(fixture, ITERATIONS);
    const layout = new GpuNestedLayout(device, solver, { collisionStats: true });
    try {
      layout.runTicks(Math.ceil(0.6 * ITERATIONS));
      const ratios: number[] = [];
      while (layout.ticks < ITERATIONS) {
        layout.beginTick();
        const stats = layout.collisionStats();
        let work = 0;
        let overflow = 0;
        for (let i = 0; i < solver.slotCount; i++) {
          work += 16 * (stats[4 * i] ?? 0) + (stats[4 * i + 1] ?? 0);
          if (stats[4 * i + 3] === 2) overflow++;
        }
        expect(overflow, `tick ${layout.ticks}: slots sent to the exact fallback`).toBe(0);
        ratios.push(work / solver.collision.gatherWork);
        layout.forceBand(0, 1);
        layout.integrate();
      }
      console.log(`  Zipf ${BIG}: pair work per collision step / plan estimate: ${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)} (single-scale grid at 60,000 children: 36)`);
      expect(Math.max(...ratios)).toBeLessThan(3);
    } finally {
      layout.destroy();
    }
  }, perfBudget(300_000));

  it("cuts the gather into bands of equal estimated work, which rows alone would not", () => {
    // The frame budget admits a band by its share of the gather's estimate; a band must carry that share.
    // Rows alone would not: the big module's slots sit in the first rows.
    const solver = solverOf(fixture, ITERATIONS);
    const layout = new GpuNestedLayout(device, solver);
    try {
      const width = Math.max(1, Math.ceil(Math.sqrt(solver.slotCount)));
      const rows = Math.ceil(solver.slotCount / width);
      const rowWork = (r0: number, r1: number): number => {
        let w = 0;
        for (let i = r0 * width; i < Math.min(solver.slotCount, r1 * width); i++) w += (solver.collision.slotWork[i] ?? 0) + 16;
        return w;
      };
      const total = rowWork(0, rows);
      let widestRow = 0;
      for (let r = 0; r < rows; r++) widestRow = Math.max(widestRow, rowWork(r, r + 1));
      for (const bands of [2, 4, 8]) {
        let next = 0;
        const shares: string[] = [];
        for (let b = 0; b < bands; b++) {
          const [r0, r1] = layout.gatherBandRows(b, bands);
          expect(r0).toBe(next);
          next = r1;
          const share = rowWork(r0, r1) / total;
          shares.push(share.toFixed(3));
          expect(share, `band ${b} of ${bands}`).toBeLessThanOrEqual(1 / bands + widestRow / total);
        }
        expect(next).toBe(rows);
        const firstEqualRows = rowWork(0, Math.floor(rows / bands)) / total;
        console.log(`  Zipf ${BIG}, ${bands} bands: work shares ${shares.join(" / ")} (the first of ${bands} equal-row bands: ${firstEqualRows.toFixed(3)})`);
      }
    } finally {
      layout.destroy();
    }
  });
});
