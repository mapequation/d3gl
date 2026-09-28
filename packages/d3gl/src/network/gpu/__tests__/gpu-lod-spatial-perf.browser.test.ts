/**
 * T7's LOD-while-streaming leg for the **spatial source** (#343 × #377), through the real trigger:
 * `network().data(g).lod({ source: "spatial" }).layout({ backend: "gpu" })`, real animation frames, one engine.
 *
 * Before this the GPU layout's LOD relay only refit a coarsening tree, so with `source: "spatial"` the engine
 * rebuilt the spatial tree on the main thread from every harvested frame: an O(N) Morton sort plus O(tree)
 * geometry and style passes per repaint (~30 ms on web-NotreDame, 141 ms at 1M). Now the relay's worker
 * rebuilds it per relayed frame with the worker backend's own step (`lodFrameStep`) and the engine adopts it in
 * O(1). Pinned here, at a fixture shaped like web-NotreDame (communities the layout spreads out, 4.6 edges per
 * node — 1.5M edges at its 325k nodes, `PERF_BROWSER_N=325729` on real hardware):
 *
 * - **Deterministic signature, per streamed repaint:** no main-thread spatial tree build
 *   (`mortonTopologyBuilds`) and no main-thread style aggregation (`lodStylePasses`) on any frame of the
 *   stream — live counters of the page's own `lod.ts`, which a real worker's builds never touch — and no
 *   O(edges) link gather (#433): every repaint with the relay's tree reads the super-edge rows the LOD worker
 *   built for the view (`superEdgeStats`: 0 incidences walked, 0 rows computed here, and no row build in this
 *   realm). The frontier stays the spatial one: screen-bounded glyphs.
 * - **Main thread per repaint:** the commit (8 B per node of positions + the O(1) adoption) under a ceiling
 *   split into constant and linear terms. **Against the worker backend** on the same engine, graph and view
 *   (AGENTS lifecycle §5: the baseline the GPU path must not exceed), both from a disc cold start: the same
 *   deterministic per-repaint work on both sides — no main-thread tree build or style pass, no edge
 *   incidence walked, no row computed or built here, a screen-bounded frontier — everywhere; and commit +
 *   repaint within the worker backend's repaint **only on a hardware GPU** (`PERF_REAL_GPU=1`, the tier #392
 *   sets up). On SwiftShader (CI) GL is CPU work competing with the relay's worker for the runner's cores, so
 *   that ratio measured the runner (3.6× on CI against 1.3× locally for the same code) and is only reported.
 * - **Transport only per frame** (fence polls, harvest, encode): T7's bounds — the relay must not add work to
 *   the stream's frames.
 *
 * The Navigator's configuration (the default multilevel seed, whose plan the same worker builds) gets its own
 * leg with the same count signature and transport bounds, and reports its per-repaint cost.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { DEFAULT_FORCE } from "../../force.js";
import { lodStylePasses, mortonTopologyBuilds } from "../../lod.js";
import { spatialRowBuilds } from "../../spatial-rows.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { perfBudget, perfN, perfRealGpu, softwareRenderer } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";

const LOCAL_N = 100_000; // the N the ceilings below were calibrated at (the browser tier's CI scale)
// Capped as T7 is: SwiftShader (CI) ticks far too slowly past a few hundred thousand nodes; real-GPU runs at
// web-NotreDame's 325,729 and at 1M go through PERF_BROWSER_N by hand.
const N = perfN(LOCAL_N, { max: 1_000_000 });
const ITERATIONS = 40;
/**
 * Ticks of the worker-backend baseline: as many as the GPU legs', so both draw the same layout state — the
 * spatial frontier and its super-edge rows grow as the disc unfolds (at 10 CPU ticks against 40 GPU ticks the
 * worker leg read a median 37k row entries per repaint against the GPU leg's 66k, for the same cost per entry).
 * A CPU tick at this N takes ~0.2-0.5 s and posts one frame; the run stops once converged.
 */
const WORKER_ITERATIONS = ITERATIONS;
const W = 800;
const H = 600;
const LOD = { source: "spatial" as const, declutter: true, superEdges: true, maxAggregateRadius: 26 };

/** Minimal seeded LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * web-NotreDame's shape, scaled with N: communities of 40 joined by random long-range links (the layout spreads
 * each community across the view — the case the spatial source exists for), 4.6 edges per node.
 */
function webLike(n: number, seed: number): NetworkGraph {
  const rng = makePrng(seed);
  const source: number[] = [];
  const target: number[] = [];
  const size = 40;
  for (let i = 0; i < n; i++) {
    const base = i - (i % size);
    const span = Math.min(size, n - base);
    for (let k = 0; k < 2; k++) {
      source.push(i);
      target.push(base + Math.floor(rng() * span));
    }
    const far = 2 + (rng() < 0.6 ? 1 : 0);
    for (let k = 0; k < far; k++) {
      source.push(i);
      target.push(Math.floor(rng() * n));
    }
  }
  return buildGraph({ nodeCount: n, source, target });
}

/** The whole force-equilibrium disc in view: the Navigator's `fit: true` framing, as T7's LOD legs. */
function fitView(): { k: number; x: number; y: number } {
  const radius = Math.sqrt((DEFAULT_FORCE.repulsion * N) / DEFAULT_FORCE.centering);
  return { k: (0.85 * Math.min(W, H)) / (2 * radius), x: W / 2, y: H / 2 };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}
function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

/** One streamed frame, with the main-thread tree builds, style passes and row builds counted so far in the leg,
 *  and what the last link gather did (#433). */
interface SpatialFrame extends GpuFrameSample {
  source: string;
  builds: number;
  styles: number;
  rowBuilds: number;
  visits: number;
  misses: number;
  entries: number;
}

/** Run one GPU layout with the spatial source on `net` over `graph`, recording every streamed frame. */
async function streamLeg(net: Network, graph: NetworkGraph, multilevel: boolean): Promise<SpatialFrame[]> {
  net.data(graph).lod(LOD);
  // Counted from here: a first lod() on new data builds its tree at once (#373 defers it); the stream's frames
  // are the per-frame path.
  const builds0 = mortonTopologyBuilds;
  const styles0 = lodStylePasses;
  const rows0 = spatialRowBuilds;
  const frames: SpatialFrame[] = [];
  const unobserve = observeGpuLayoutFrames((s) => {
    const gather = net.superEdgeStats;
    frames.push({
      ...s,
      source: net.lodSource,
      builds: mortonTopologyBuilds - builds0,
      styles: lodStylePasses - styles0,
      rowBuilds: spatialRowBuilds - rows0,
      visits: gather?.visits ?? -1,
      misses: gather?.misses ?? -1,
      entries: gather?.entries ?? -1,
    });
  });
  try {
    net.layout({ backend: "gpu", iterations: ITERATIONS, multilevel });
    await net.whenSettled();
  } finally {
    unobserve();
  }
  expect(net.layoutTransport).toBe("gpu");
  return frames;
}

/** One worker-backend layout repaint: its main-thread ms and what its link gather did (#433). */
interface WorkerRepaint {
  ms: number;
  source: string;
  visits: number;
  misses: number;
  entries: number;
  glyphs: number;
}

/** Every animation-frame callback while installed — the worker backend's layout repaints — timed, with the
 *  link gather's counts after it. */
function recordAnimationFrames(net: Network): { repaints: WorkerRepaint[]; restore: () => void } {
  const installed = window.requestAnimationFrame;
  const repaints: WorkerRepaint[] = [];
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    installed.call(window, (t: number) => {
      const t0 = performance.now();
      try {
        callback(t);
      } finally {
        const ms = performance.now() - t0;
        const gather = net.superEdgeStats;
        repaints.push({ ms, source: net.lodSource, visits: gather?.visits ?? -1, misses: gather?.misses ?? -1, entries: gather?.entries ?? -1, glyphs: net.declutterStats?.glyphs ?? -1 });
      }
    });
  return { repaints, restore: () => { window.requestAnimationFrame = installed; } };
}

describe("GPU layout streaming with the spatial LOD source (#343 × #377) — network().lod({ source: 'spatial' }).layout({ backend: 'gpu' })", () => {
  let host: HTMLElement;
  let net: Network;
  let graph: NetworkGraph;
  /** The disc-start GPU leg's main-thread ms per repaint with the relay's tree drawn, for the baseline leg. */
  let gpuRepaintMs: number[] = [];
  /** …and the super-edge row entries each of those repaints read. */
  let gpuEntries: number[] = [];

  beforeAll(async () => {
    graph = webLike(N, 0x343);
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // Warm-up on the same engine: the capability probe, shader compiles, the lane programs and the worker module.
    net.data(webLike(2_000, 1)).lod(LOD).layout({ backend: "gpu", iterations: 5 });
    await net.whenSettled();
  }, perfBudget(120_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  // Calibrated at LOCAL_N. The transport's own work per frame is T7's: a fence poll, a memcpy of 8 B per node on
  // harvest frames, at most 2 ms of encode. The commit copies the relayed positions (8 B per node) and adopts the
  // relay's tree in O(1) (views over its buffer; a selected aggregate's remap is O(depth)): a main-thread
  // rebuild in the commit (~10 ms at this N) trips its ceiling at any scale.
  const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / LOCAL_N));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);
  const COMMIT_P95_MS = perfBudget(1 + 1 * (N / LOCAL_N));
  // The spatial frontier is bounded by the screen (a cut of ~300-600 glyphs at a fit view on web-NotreDame);
  // the coarsening tree's on this graph is a fifth of the nodes.
  const MAX_GLYPHS = 3_000;

  /** Assert a spatial leg's per-frame signatures and bounds; its per-repaint main-thread ms with the tree drawn. */
  function assertLeg(label: string, frames: SpatialFrame[]): number[] {
    const repaints = frames.filter((f) => f.repainted);
    const withTree = repaints.filter((f) => f.source === "worker");
    expect(withTree.length, `${label}: no repaint drew the relay's spatial tree`).toBeGreaterThan(3);
    // The deterministic signature: not one main-thread spatial build or style pass on any streamed frame.
    const last = frames[frames.length - 1];
    expect(last?.builds, `${label}: main-thread spatial tree builds while the GPU streamed`).toBe(0);
    expect(last?.styles, `${label}: main-thread style passes while the GPU streamed`).toBe(0);
    // #433: no O(edges) gather on the main thread — each repaint with the relay's tree read the rows its LOD
    // worker built for the view, and none was built here.
    expect(last?.rowBuilds, `${label}: super-edge rows built on the main thread while the GPU streamed`).toBe(0);
    for (const f of withTree) {
      expect(f.visits, `${label}: a streamed repaint walked ${f.visits} edge incidences on the main thread`).toBe(0);
      expect(f.misses, `${label}: a streamed repaint computed ${f.misses} rows on the main thread`).toBe(0);
      expect(f.entries, `${label}: a streamed repaint read no super-edge row`).toBeGreaterThan(0);
    }
    const transport = frames.map((f) => f.harvestMs + f.encodeMs); // T7's measure: the commit included
    const encode = frames.map((f) => f.encodeMs);
    const commit = withTree.map((f) => f.commitMs);
    const perRepaint = withTree.map((f) => f.commitMs + f.repaintMs);
    console.log(
      `  GPU stream [spatial, ${label}] N=${N} E=${graph.edgeCount}: ${frames.length} frames, ${repaints.length} repaints ` +
        `(${withTree.length} with the relay's tree); main thread per repaint (commit + repaint) median ${median(perRepaint).toFixed(2)} ` +
        `p95 ${quantile(perRepaint, 0.95).toFixed(2)} ms; commit median ${median(commit).toFixed(2)} p95 ${quantile(commit, 0.95).toFixed(2)} ` +
        `max ${Math.max(0, ...commit).toFixed(2)} ms; transport p95 ${quantile(transport, 0.95).toFixed(2)} ms, encode median ${median(encode).toFixed(2)} ms; ` +
        `glyphs ${net.declutterStats?.glyphs ?? "?"}; row entries read per repaint median ${median(withTree.map((f) => f.entries))} (E=${graph.edgeCount})`,
    );
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    expect(quantile(commit, 0.95)).toBeLessThan(COMMIT_P95_MS);
    // The frontier stays the spatial one: links from the worker's rows (no super-edge CSR), glyphs screen-bounded.
    expect(net.lodSource).toBe("worker");
    expect(net.superEdgeStats).not.toBeNull();
    expect(net.declutterStats?.glyphs ?? Infinity).toBeLessThan(MAX_GLYPHS);
    return perRepaint;
  }

  it("disc start, fit view: no main-thread spatial build or style pass per repaint; bounded commit and transport", async () => {
    net.setTransform(fitView());
    const frames = await streamLeg(net, graph, false);
    gpuRepaintMs = assertLeg("disc start", frames);
    gpuEntries = frames.filter((f) => f.repainted && f.source === "worker").map((f) => f.entries);
  }, perfBudget(240_000));

  // Lifecycle §5 baseline: the worker backend on the same engine, graph and view, from the same disc start, over
  // as many ticks. Everywhere: both sides do the same deterministic work per repaint (no main-thread tree build
  // or style pass, no edge incidence walked, no row computed or built here, a screen-bounded frontier). On a
  // hardware GPU only (`PERF_REAL_GPU`, #392): the GPU side's commit + repaint within the worker's repaint. Its
  // frames arrive one per posted CPU frame, each coalesced into one animation-frame repaint (its message
  // handler's adoption is left out, so the baseline is if anything low); the margin absorbs the solvers'
  // different layouts at equal ticks.
  const BASELINE_RATIO = 1.5;
  const BASELINE_SLACK_MS = perfBudget(2);

  it("disc start: the worker backend's repaints do the same per-repaint work (lifecycle §5 baseline); within its time on a hardware GPU", async () => {
    expect(gpuRepaintMs.length, "the disc-start GPU leg must run first").toBeGreaterThan(0);
    net.data(graph).lod(LOD);
    net.setTransform(fitView());
    const builds0 = mortonTopologyBuilds;
    const styles0 = lodStylePasses;
    const rows0 = spatialRowBuilds;
    const recorded = recordAnimationFrames(net);
    let settled = false;
    let streamed: WorkerRepaint[] = [];
    try {
      net.layout({ backend: "worker", iterations: WORKER_ITERATIONS, multilevel: false });
      await net.whenSettled().then(() => {
        settled = true;
        streamed = recorded.repaints.slice();
      });
    } finally {
      recorded.restore();
    }
    expect(settled).toBe(true);
    expect(net.lodSource).toBe("worker");
    // The worker side's deterministic signature, as the GPU leg's (assertLeg): no main-thread tree build, style
    // pass or row build; every repaint that drew the worker's tree walked no incidence and computed no row.
    expect(mortonTopologyBuilds - builds0, "worker backend: main-thread spatial tree builds").toBe(0);
    expect(lodStylePasses - styles0, "worker backend: main-thread style passes").toBe(0);
    expect(spatialRowBuilds - rows0, "worker backend: main-thread row builds").toBe(0);
    const withTree = streamed.filter((r) => r.source === "worker" && r.entries >= 0);
    expect(withTree.length, "the worker streamed no repaint with its tree").toBeGreaterThanOrEqual(1);
    for (const r of withTree) {
      expect(r.visits, `worker backend: a streamed repaint walked ${r.visits} edge incidences on the main thread`).toBe(0);
      expect(r.misses, `worker backend: a streamed repaint computed ${r.misses} rows on the main thread`).toBe(0);
      expect(r.glyphs, "worker backend: the frontier is the spatial one").toBeLessThan(MAX_GLYPHS);
    }
    const gpu = median(gpuRepaintMs);
    const base = median(withTree.map((r) => r.ms));
    const software = softwareRenderer();
    console.log(
      `  spatial repaint baseline N=${N}: GPU (commit + repaint) median ${gpu.toFixed(2)} ms over ${gpuRepaintMs.length} repaints; ` +
        `worker backend repaint median ${base.toFixed(2)} ms (p95 ${quantile(withTree.map((r) => r.ms), 0.95).toFixed(2)}) over ${withTree.length} repaints; ` +
        `ratio ${(gpu / Math.max(1e-3, base)).toFixed(2)} (${perfRealGpu ? "asserted: hardware GPU" : "reported only"}${software ? ", software GL" : ""}); ` +
        `row entries read per repaint median GPU ${median(gpuEntries)}, worker ${median(withTree.map((r) => r.entries))}`,
    );
    if (perfRealGpu) {
      expect(software, "PERF_REAL_GPU is set, but WebGL renders in software").toBe(false);
      expect(gpu).toBeLessThan(BASELINE_RATIO * base + BASELINE_SLACK_MS);
    }
  }, perfBudget(240_000));

  it("seeded (the Navigator's config), fit view: the same count signature and bounds", async () => {
    net.setTransform(fitView());
    const frames = await streamLeg(net, graph, true);
    assertLeg("seeded", frames);
  }, perfBudget(240_000));
});
