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
 *   scatter and {@link COLLISION_ROUNDS} round scatters of N points (the K-occupant grid's fixed passes),
 *   never a draw of N points into a 1×1 viewport (#349).
 *
 * The **warm re-layout with a transition** — `layout({ backend: "auto", nested: { warm: true }, transition })`,
 * the call an app makes after re-clustering, which `"auto"` sends to the GPU solve (#375) where it used to
 * run on the worker — reads back only the final layout, in one frame, then eases to it. Pinned against
 * the worker's warm + transition run on the same engine and map: the same transport bounds and GL
 * signatures over the solve's frames, exactly one copy (each PBO written once and read once), and every
 * callback of each solve frame within the transport ceiling (the worker spends no main-thread frame on the
 * solve; the tween's frames are the same code on both paths).
 *
 * A node drag and a zoom sweep while the nested solve runs have their own guard,
 * `gpu-nested-interaction-perf.browser.test.ts`; the fixture and the GL call log are `_nested-perf.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Device } from "@luma.gl/core";
import { network, type Network } from "../../network.js";
import type { NetworkGraph } from "../../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { GpuNestedLayout, nestedLayoutPlan } from "../gpu-nested-layout.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { COLLISION_ROUNDS } from "../passes/collision.js";
import { MIN_FRAME_MS } from "../repaint-throttle.js";
import { makeTestDevice } from "./_device.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import {
  GlCallLog,
  H,
  ITERATIONS,
  RafTimer,
  STREAM_TICKS,
  W,
  assertFencedHarvests,
  infomapLike,
  median,
  pboAccesses,
  perFrame,
  quantile,
  type GlEvent,
} from "./_nested-perf.js";

const LOCAL_N = 20_000; // the leaves the fixture defaults to (the ceilings below were measured there)
// Capped: SwiftShader runs the compact phase's collision gathers slowly (a dense segment falls back to
// its exact loop); real-GPU runs at 325k / 1M go through PERF_BROWSER_N by hand.
const N = perfN(LOCAL_N, { max: 1_000_000 });

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

function assertSignatures(leg: Leg): void {
  const { frames, events } = leg;
  expect(frames.length).toBeGreaterThan(3);
  const copies = events.filter((e) => e.kind === "copy");
  expect(copies.length).toBeGreaterThan(1); // a cold layout streams: more than the final copy
  expect(copies.every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels on the streaming path").toBe(true);

  assertFencedHarvests(events);
  // One write, then one read, per PBO per copy: a harvest that reads a PBO twice (positions, then the
  // module discs, from one buffer) stalls the GPU pipeline once per harvest.
  for (const accesses of pboAccesses(events)) expect(accesses, "a readback PBO's writes (w) and reads (r)").toMatch(/^(wr)*w?$/);

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

// ── The warm re-layout with a transition (#328, #375) ────────────────────────────────────────────────

// About 60 tween frames on a real GPU. Software GL (SwiftShader) renders a tween frame of 20k leaves in
// 250-800 ms (LOD off), so there the tween has a handful of frames: the per-frame bound below is taken over
// the solve's frames, where the two paths differ, not over the tween's, where they run the same code.
const TRANSITION_MS = 1000;

interface WarmLeg {
  /** The GPU stream's frames (none on the worker). */
  frames: GpuFrameSample[];
  events: GlEvent[];
  /** Main-thread ms of every frame from the call until it settled: the solve's and the tween's. */
  rafMs: number[];
  /** Main-thread ms of every callback of each GPU solve frame (the transport's, and anything else in that frame). */
  solveMs: number[];
  transport: string | null;
  elapsedMs: number;
}

/**
 * Lay the map out cold on the worker (the map a re-clustering starts from), then time the warm re-layout
 * with a transition on `backend` until it settles (the transition's end).
 */
async function warmLeg(net: Network, graph: NetworkGraph, modules: ModuleNode[], lod: boolean, backend: "auto" | "worker"): Promise<WarmLeg> {
  net.data(graph, { modules }).lod(lod ? { declutter: true } : false);
  net.layout({ backend: "worker", nested: { iterations: ITERATIONS } });
  await net.whenSettled();
  const frames: GpuFrameSample[] = [];
  const log = new GlCallLog();
  const raf = new RafTimer();
  const unobserve = observeGpuLayoutFrames((s) => {
    frames.push({ ...s });
    log.events.push({ kind: "frame-end" });
  });
  const t0 = performance.now();
  let transport: string | null = null;
  try {
    net.layout({ backend, nested: { warm: true, iterations: ITERATIONS }, transition: TRANSITION_MS });
    await net.whenSettled();
    transport = net.layoutTransport;
  } finally {
    unobserve();
    raf.restore();
    log.restore();
  }
  return { frames, events: log.events, rafMs: raf.frames, solveMs: raf.at(frames.map((f) => f.now)), transport, elapsedMs: performance.now() - t0 };
}

/** The one-frame GPU solve's signatures: one copy, each PBO written once and read once after its fence. */
function assertOneFrameSignatures(leg: WarmLeg): void {
  const { frames, events } = leg;
  expect(frames.length).toBeGreaterThan(1);
  const copies = events.filter((e) => e.kind === "copy");
  expect(copies.every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels on the one-frame path").toBe(true);
  // Exactly one copy: the final layout — positions, stats and module discs, one PBO each.
  expect(pboAccesses(events), "each readback PBO's writes (w) and reads (r)").toEqual(["wr", "wr", "wr"]);
  assertFencedHarvests(events);
  expect(frames.filter((s) => s.copied).length, "copies").toBe(1);
  expect(frames.filter((s) => s.harvested).map((s) => s.harvestedTicks), "harvests").toEqual([STREAM_TICKS]);
  const segments = perFrame(events);
  expect(segments.length).toBe(frames.length);
  segments.forEach((seg, f) => expect(seg.filter((e) => e.kind === "fence").length, `frame ${f} fences`).toBe(1));
  // The solve's GPU objects are all built before its first frame.
  expect(segments.slice(1).flat().filter((e) => e.kind === "create").length, "GPU objects created per solve frame").toBe(0);
  expect(events.filter((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= N).length, "a draw of ≥ N points into a 1×1 viewport").toBe(0);
}

function reportWarm(label: string, gpu: WarmLeg, worker: WarmLeg): number[] {
  const transport = gpu.frames.map((s) => s.harvestMs + s.encodeMs);
  const f = (xs: number[]): string => `p95 ${quantile(xs, 0.95).toFixed(2)} max ${Math.max(0, ...xs).toFixed(2)} (${xs.length} frames)`;
  console.log(
    `  warm re-layout + ${TRANSITION_MS} ms transition [${label}] N=${N}: "auto" (GPU) ${gpu.elapsedMs.toFixed(0)} ms, ` +
      `${gpu.frames.length} solve frames, transport ms/frame median ${median(transport).toFixed(2)} p95 ${quantile(transport, 0.95).toFixed(2)}, ` +
      `main thread ms/frame over the solve ${f(gpu.solveMs)}, over solve + tween ${f(gpu.rafMs)}; ` +
      `worker ${worker.elapsedMs.toFixed(0)} ms, main thread ms/frame (its tween) ${f(worker.rafMs)}`,
  );
  return transport;
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
      const solo = new GpuNestedLayout(device, nestedLayoutPlan(solver));
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

  // The warm re-layout's frames are the one-frame solve's (transport only: nothing repaints until it
  // lands) and then the tween's. The worker spends no main-thread frame on the solve (it posts only the
  // final layout), so each "auto" solve frame — every callback in it — is bounded by the transport's
  // ceiling alone. The tween's frames run the same code on both paths (the transition guard,
  // `transition-perf.test.ts`, bounds them); both runs' are reported.
  it.each([
    ["LOD off", false],
    ["LOD on", true],
  ])("warm re-layout with a transition on \"auto\" (%s): one copy, fenced, each solve frame within the transport ceiling", async (label, lod) => {
    const worker = await warmLeg(net, fixture.graph, fixture.modules, lod, "worker");
    const gpu = await warmLeg(net, fixture.graph, fixture.modules, lod, "auto");
    const transport = reportWarm(label, gpu, worker);
    expect(worker.transport).toBe("copy"); // the worker's transport (`layoutTransport`)
    expect(worker.frames.length).toBe(0);
    expect(gpu.transport).toBe("gpu");
    assertOneFrameSignatures(gpu);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(gpu.frames.map((s) => s.encodeMs))).toBeLessThan(ENCODE_MEDIAN_MS);
    // Every solve frame's callbacks (the frames the worker leaves idle): a sample of every solve frame.
    expect(gpu.solveMs.length, "solve frames timed").toBe(gpu.frames.length);
    expect(quantile(gpu.solveMs, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
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
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    const log = new GlCallLog();
    try {
      layout.runTicks(6); // organise
      layout.prepareReadback();
      const organiseCreates = log.events.filter((e) => e.kind === "create").length;
      const before = log.events.length;
      layout.beginTick(); // compact, collision step 1: its cells, counts and rounds
      layout.forceBand(0, 3);
      layout.forceBand(1, 3);
      layout.forceBand(2, 3);
      layout.integrate();
      const step = log.events.slice(before).filter((e) => e.kind === "layout-draw" && e.points);
      layout.runTicks(3);
      layout.prepareReadback();
      expect(organiseCreates, "GPU objects created by organise ticks or a readback").toBe(0);
      expect(log.events.filter((e) => e.kind === "create").length, "GPU objects created by compact ticks").toBe(0);
      // One count scatter and the rounds, each over every slot: the grid's fixed pass count.
      expect(step.length).toBe(1 + COLLISION_ROUNDS);
      expect(step.every((e) => e.kind === "layout-draw" && e.count === solver.slotCount)).toBe(true);
      expect(log.events.some((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= solver.slotCount)).toBe(false);
    } finally {
      log.restore();
      layout.destroy();
    }
  });
});
