import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { DEFAULT_FORCE } from "../force.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";

/**
 * The overlap rule's worst frame (#426, AGENTS lifecycle §5), through the real trigger: a worker layout's
 * **cold disc start** with the spatial LOD source at a fit view. The seed disc is evenly spaced, so where its
 * glyphs are at least a pixel apart none overlap, every aggregate opens, and the seed frame draws **every
 * leaf** — the LOD-on visible set is the whole graph, with its links from the worker's super-edge rows (#433).
 * That frame is timed against the same frame with LOD off (every node and edge drawn, the full-detail path),
 * on one engine, over the same graph and view.
 *
 * N is where that frontier peaks at this viewport. The seed disc spans ~85% of the shorter side at the fit
 * view and its spacing on screen falls as 1/√N, so the peak scales with the viewport's pixels: at 800 × 600
 * every node is drawn up to ~180k (the cut of the seed disc measured 150,000 of 150k and 178,668 of 180k), and
 * at 190k the nodes are closer than a pixel, overlap, and the cut aggregates them to ~160 glyphs. The guard
 * runs at 400 × 300, a quarter of the pixels, so the same frame peaks at a quarter of the N: 37.5k by
 * default (the margin under the ~47k cliff that 150k keeps under 190k), `PERF_BROWSER_N` capped at 45k — a
 * larger N is not a harder case, it aggregates. (At 800 × 600 and 150k, one cold start takes 20-50 s of
 * software GL locally, past the tier's per-file budget on CI.)
 * The test checks it is at the peak: the LOD-on seed frame must draw nearly every node.
 *
 * Asserted: the worst case is reached (the LOD-on seed frame draws nearly every node, at most one leaf per
 * viewport pixel); the frame reads the worker's super-edge rows, with no incidence walked or row computed on the
 * main thread; and its main-thread repaint stays under an absolute `c0 + c1·N` ceiling (~5× the measured
 * 61 ms at 37.5k, so an order-of-magnitude regression trips it). The ratio to the LOD-off seed frame is logged,
 * not asserted: the LOD path re-gathers and re-emits every link under the kept glyphs per frame (the super-edge
 * gather), where the full-detail path keeps its edges uploaded — here 61 vs 1.5 ms (40×); at 800 × 600 and 150k,
 * 243 vs 15 ms (16×), and 199 vs 11 ms (18×) on `main` for the same all-leaves cut forced with `expandPx` → 0.
 * That gap is the LOD path's, not the overlap rule's; it is tracked as #447.
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

/** The first layout repaint of a cold start (the seed frame): its main-thread ms and what it drew. */
interface SeedFrame {
  ms: number;
  source: string;
  glyphs: number;
  visits: number;
  misses: number;
}

/** Run a cold worker layout on `net` and return its seed frame's repaint — the first animation-frame
 *  callback after `layout()` that drew with the layout's positions. */
async function coldStart(net: Network, graph: NetworkGraph, lod: boolean): Promise<SeedFrame> {
  net.data(graph).lod(lod ? LOD : false);
  net.setTransform(fitView(graph.nodeCount));
  const installed = window.requestAnimationFrame;
  const frames: SeedFrame[] = [];
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    installed.call(window, (t: number) => {
      const t0 = performance.now();
      try {
        callback(t);
      } finally {
        const ms = performance.now() - t0;
        const gather = net.superEdgeStats;
        frames.push({ ms, source: net.lodSource, glyphs: net.declutterStats?.glyphs ?? -1, visits: gather?.visits ?? -1, misses: gather?.misses ?? -1 });
      }
    });
  try {
    net.layout({ backend: "worker", iterations: 1, multilevel: false }); // the seed frame, then one tick
    await net.whenSettled();
  } finally {
    window.requestAnimationFrame = installed;
  }
  // LOD on: the first repaint that drew the worker's tree; LOD off: the first repaint.
  const seed = lod ? frames.find((f) => f.source === "worker" && f.glyphs > 0) : frames[0];
  if (!seed) throw new Error(`the cold start (LOD ${lod ? "on" : "off"}) painted no layout frame`);
  return seed;
}

describe(`network() spatial LOD, a cold disc start's seed frame (#426) at N=${N.toLocaleString()}, ${W}×${H}`, () => {
  let host: HTMLElement;
  let net: Network;
  const on: SeedFrame[] = [];
  const off: SeedFrame[] = [];

  beforeAll(async () => {
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // Warm-up on the same engine: shader compiles, the lanes and the worker module.
    await coldStart(net, webLike(5_000, 1), true);
    await coldStart(net, webLike(5_000, 1), false);
    const graph = webLike(N, 0x426);
    for (let round = 0; round < ROUNDS; round++) {
      on.push(await coldStart(net, graph, true));
      off.push(await coldStart(net, graph, false));
    }
  }, perfBudget(240_000 + (240_000 * N) / LOCAL_N));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  it("is the worst case: the LOD-on seed frame draws nearly every node, at most one leaf per viewport pixel", () => {
    for (const f of on) {
      expect(f.glyphs, `seed frame glyphs ${f.glyphs} of ${N}`).toBeGreaterThanOrEqual(0.9 * N);
      expect(f.glyphs).toBeLessThanOrEqual(W * H);
    }
  });

  it("reads the worker's super-edge rows: no incidence walked or row computed on the main thread", () => {
    for (const f of on) {
      expect(f.visits, "edge incidences walked on the main thread").toBe(0);
      expect(f.misses, "rows computed on the main thread").toBe(0);
    }
  });

  it("renders under its ceiling; its ratio to the full-detail seed frame (LOD off, same graph and view) is logged", () => {
    const lodOn = Math.min(...on.map((f) => f.ms));
    const lodOff = Math.min(...off.map((f) => f.ms));
    const msg = `seed frame LOD on ${lodOn.toFixed(1)} ms (${on.map((f) => f.ms.toFixed(0)).join(", ")}) vs LOD off ${lodOff.toFixed(1)} ms (${off.map((f) => f.ms.toFixed(0)).join(", ")}), ratio ${(lodOn / Math.max(lodOff, 1e-3)).toFixed(1)}×, glyphs ${on.map((f) => f.glyphs).join(", ")}, N=${N}`;
    console.log(`  ${msg}`);
    expect(lodOn, msg).toBeLessThan(perfBudget(50 + (250 * N) / LOCAL_N));
  });
});
