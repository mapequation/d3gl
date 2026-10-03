import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { DEFAULT_FORCE } from "../force.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";

/**
 * The overlap rule's worst frame (#426, AGENTS lifecycle §5), through the real trigger: a worker layout that
 * **settles where no glyphs overlap**, with the spatial LOD source at a fit view — the evenly spaced seed disc,
 * run with `iterations: 0` so the disc is the settled layout. While a layout streams, the cut opens aggregates by
 * the footprint rule alone (the crowding pass waits for the settle: it costs 0.35-1 s per frame at 2M nodes), so
 * the disc's streamed seed frame aggregates; its settled frame — the worker's `done`, which carries the crowding —
 * opens every aggregate whose members are at least a pixel apart, and draws **every leaf**: the LOD-on visible
 * set is the whole graph, with its links from the worker's super-edge rows (#433) and the leaf links (#447).
 * That frame is timed against the same run with LOD off (every node and edge drawn, the full-detail path), on
 * one engine, over the same graph and view. Every rebuild is timed, the settle's included.
 *
 * N is where that frontier peaks at this viewport. The seed disc spans ~85% of the shorter side at the fit
 * view and its spacing on screen falls as 1/√N, so the peak scales with the viewport's pixels: at 800 × 600
 * every node is drawn up to ~180k (the cut of the seed disc measured 150,000 of 150k and 178,668 of 180k), and
 * at 190k the nodes are closer than a pixel, overlap, and the cut aggregates them to ~160 glyphs. The guard
 * runs at 400 × 300, a quarter of the pixels, so the same frame peaks at a quarter of the N: 37.5k by
 * default (the margin under the ~47k cliff that 150k keeps under 190k), `PERF_BROWSER_N` capped at 45k — a
 * larger N is not a harder case, it aggregates. (At 800 × 600 and 150k, one run takes 20-50 s of software GL
 * locally, past the tier's per-file budget on CI.)
 *
 * Asserted: the worst case is reached (the LOD-on settled frame draws nearly every node, at most one leaf per
 * viewport pixel); the frame reads the worker's super-edge rows, with no incidence walked or row computed on the
 * main thread; its main-thread rebuild stays under an absolute `c0 + c1·N` ceiling; and the links between two
 * kept leaves (#447) are drawn on that frame and the pans after it. The ratio to LOD off is logged, not asserted.
 */

const LOCAL_N = 37_500;
const N = perfN(LOCAL_N, { max: 45_000 });
const W = 400;
const H = 300;
const ROUNDS = 2;
const LOD = { source: "spatial" as const, declutter: true, superEdges: true, maxAggregateRadius: 26 };

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** web-NotreDame's shape, as gpu-lod-spatial-perf's fixture: communities of 40 and long-range links, 4.6 edges per node. */
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

/** The whole force-equilibrium disc in view (the Navigator's `fit: true` framing). */
function fitView(n: number): { k: number; x: number; y: number } {
  const radius = Math.sqrt((DEFAULT_FORCE.repulsion * n) / DEFAULT_FORCE.centering);
  return { k: (0.85 * Math.min(W, H)) / (2 * radius), x: W / 2, y: H / 2 };
}

/** One engine rebuild of a run: its main-thread ms and what it drew. */
interface SeedFrame {
  ms: number;
  source: string;
  glyphs: number;
  visits: number;
  misses: number;
  /** Links drawn as graph edges between two kept leaves (#447). */
  leafLinks: number;
}

/** The all-leaves frame of one run, and every frame after it: then three pans. */
interface ColdStart {
  seed: SeedFrame;
  after: SeedFrame[];
}

/**
 * Run a worker layout of the evenly spaced seed disc on `net` — `iterations: 0`, so the disc is the settled
 * layout — and return its all-leaves frame: with LOD on, the engine's rebuild (cut + emit, whichever frame or
 * settle ran it) that kept the most glyphs of the worker's tree; with LOD off, its slowest rebuild. While a
 * layout streams the cut uses the footprint rule alone (#426: the crowding waits for the settle), so the disc's
 * streamed seed frame aggregates, and the settled frame — the worker's `done`, which carries the crowding —
 * opens every leaf. Every rebuild is timed, the settle's included (it runs outside an animation frame).
 */
async function coldStart(net: Network, graph: NetworkGraph, lod: boolean): Promise<ColdStart> {
  net.data(graph).lod(lod ? LOD : false);
  net.setTransform(fitView(graph.nodeCount));
  const engine = net as unknown as { rebuild: () => unknown };
  const installed = engine.rebuild;
  const frames: SeedFrame[] = [];
  engine.rebuild = function (this: unknown): unknown {
    const t0 = performance.now();
    try {
      return installed.call(this);
    } finally {
      const ms = performance.now() - t0;
      const gather = net.superEdgeStats;
      frames.push({
        ms, source: net.lodSource, glyphs: net.declutterStats?.glyphs ?? -1, visits: gather?.visits ?? -1, misses: gather?.misses ?? -1,
        leafLinks: gather?.leafLinks ?? 0,
      });
    }
  };
  let run = 0;
  try {
    net.layout({ backend: "worker", iterations: 0, multilevel: false }); // the seed disc, settled
    await net.whenSettled();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    run = frames.length;
  } finally {
    delete (engine as { rebuild?: unknown }).rebuild; // the prototype's again
  }
  // Then pans of a pixel (a re-cut and a re-emit of the lane at a view whose cut barely changes), each through
  // its frame — not a rebuild, so each is recorded from the counters around it.
  const view = fitView(graph.nodeCount);
  for (let i = 1; i <= 3; i++) {
    net.setTransform({ ...view, x: view.x + (i % 2 ? 1 : -1) });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const gather = net.superEdgeStats;
    frames.push({
      ms: 0, source: net.lodSource, glyphs: net.declutterStats?.glyphs ?? -1, visits: gather?.visits ?? -1, misses: gather?.misses ?? -1,
      leafLinks: gather?.leafLinks ?? 0,
    });
  }
  const ofRun = frames.slice(0, run);
  let at = -1;
  for (let i = 0; i < ofRun.length; i++) {
    const f = ofRun[i]!;
    const best = at < 0 ? undefined : ofRun[at]!;
    if (lod ? f.source === "worker" && f.glyphs > (best?.glyphs ?? 0) : f.ms > (best?.ms ?? -1)) at = i;
  }
  const seed = frames[at];
  if (!seed) throw new Error(`the run (LOD ${lod ? "on" : "off"}) painted no layout frame`);
  return { seed, after: frames.slice(at + 1) };
}

describe(`network() spatial LOD, the all-leaves frame of a layout that settles spread out (#426) at N=${N.toLocaleString()}, ${W}×${H}`, () => {
  let host: HTMLElement;
  let net: Network;
  const on: SeedFrame[] = [];
  const off: SeedFrame[] = [];
  /** The LOD-on frames after each all-leaves frame: the pans. */
  const onAfter: SeedFrame[] = [];

  beforeAll(async () => {
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // Warm-up on the same engine: shader compiles, the lanes and the worker module.
    await coldStart(net, webLike(5_000, 1), true);
    await coldStart(net, webLike(5_000, 1), false);
    const graph = webLike(N, 0x426);
    for (let round = 0; round < ROUNDS; round++) {
      const lodOn = await coldStart(net, graph, true);
      on.push(lodOn.seed);
      onAfter.push(...lodOn.after);
      off.push((await coldStart(net, graph, false)).seed);
    }
  }, perfBudget(240_000 + (240_000 * N) / LOCAL_N));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  it("is the worst case: the LOD-on settled frame draws nearly every node, at most one leaf per viewport pixel", () => {
    for (const f of on) {
      expect(f.glyphs, `settled frame glyphs ${f.glyphs} of ${N}`).toBeGreaterThanOrEqual(0.9 * N);
      expect(f.glyphs).toBeLessThanOrEqual(W * H);
    }
  });

  it("draws the leaf links (#447): the settled frame and the pans after it draw links between two kept leaves", () => {
    for (const f of on) expect(f.leafLinks, "the settled frame's leaf links").toBeGreaterThan(0);
    expect(onAfter.length, "frames after the all-leaves frame").toBeGreaterThanOrEqual(3);
    for (const f of onAfter) expect(f.leafLinks, "a pan's leaf links").toBeGreaterThan(0);
  });

  it("reads the worker's super-edge rows: no incidence walked or row computed on the main thread", () => {
    for (const f of on) {
      expect(f.visits, "edge incidences walked on the main thread").toBe(0);
      expect(f.misses, "rows computed on the main thread").toBe(0);
    }
  });

  it("renders under its ceiling; its ratio to the full-detail run (LOD off, same graph and view) is logged", () => {
    const lodOn = Math.min(...on.map((f) => f.ms));
    const lodOff = Math.min(...off.map((f) => f.ms));
    const msg = `all-leaves frame LOD on ${lodOn.toFixed(1)} ms (${on.map((f) => f.ms.toFixed(0)).join(", ")}) vs LOD off ${lodOff.toFixed(1)} ms (${off.map((f) => f.ms.toFixed(0)).join(", ")}), ratio ${(lodOn / Math.max(lodOff, 1e-3)).toFixed(1)}×, glyphs ${on.map((f) => f.glyphs).join(", ")}, N=${N}`;
    console.log(`  ${msg}`);
    expect(lodOn, msg).toBeLessThan(perfBudget(50 + (250 * N) / LOCAL_N));
  });
});
