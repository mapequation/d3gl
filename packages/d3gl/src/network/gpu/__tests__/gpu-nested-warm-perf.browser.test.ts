/**
 * The GPU nested layout's per-frame guard for the **warm re-layout with a transition** (#375, #328), through
 * the real trigger: `layout({ backend: "auto", nested: { warm: true }, transition })`, the call an app makes
 * after re-clustering, which `"auto"` sends to the GPU solve where it used to run on the worker. It reads
 * back only the final layout, in one frame, then eases to it. Pinned against the worker's warm + transition
 * run on the same engine and map, LOD off and on: the same transport bounds and GL signatures over the
 * solve's frames as the cold stream (`gpu-nested-perf.browser.test.ts`, whose header lists them), exactly
 * one copy (each PBO written once and read once), and every callback of each solve frame within the
 * transport ceiling (the worker spends no main-thread frame on the solve; the tween's frames are the same
 * code on both paths). A file of its own, so each nested guard stays within the browser perf tier's 300 s
 * per file. The fixture, the GL call log and the per-frame timer are `_nested-perf.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { network, type Network } from "../../network.js";
import type { NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import {
  GlCallLog,
  H,
  ITERATIONS,
  N,
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

describe("GPU nested warm re-layout with a transition per frame (#375) — network().layout({ backend: 'auto', nested: { warm: true }, transition })", () => {
  let host: HTMLElement;
  let net: Network;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };

  beforeAll(async () => {
    fixture = infomapLike(N);
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

  // The cold stream guard's ceilings (`gpu-nested-perf.browser.test.ts`): fence polls, a harvest's memcpy
  // and at most 2 ms of encode per frame.
  const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / 100_000));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

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
