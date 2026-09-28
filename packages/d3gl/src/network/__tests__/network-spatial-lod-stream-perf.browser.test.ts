import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { spatialRowBuilds } from "../spatial-rows.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";

/**
 * Per-frame guard for a **streamed** spatial LOD tree's links (#433, AGENTS lifecycle §5), through the real
 * trigger: `network().lod({ source: "spatial" }).layout({ backend: "worker", fit: true })`, real animation frames.
 *
 * With the spatial source every streamed frame brings a new tree, so the lazy gather's per-tree row memo never
 * hit and each repaint walked every edge under the frontier — O(edges) on the main thread per frame (2E
 * incidences at a fit view). The worker now builds, with each tree, the super-edge rows of the covers the
 * engine's cut will draw (it cuts at the engine's view, or at the fit it computes from the frame's positions),
 * and the repaint reads O(rows of the drawn and culled covers).
 *
 * Deterministic signature, on every animation frame that drew a worker tree while the layout streamed (the
 * camera following the fit): **0 edge incidences walked** and **0 rows computed** on the main thread
 * (`superEdgeStats.visits` / `misses`), rows read (`entries > 0`), fewer than the graph's incidences, and **no row
 * build in this realm** (`spatialRowBuilds`: the worker's builds never touch the page's counter). Counts are
 * never scaled; only the timeout follows `PERF_BUDGET_SCALE`. The settle reframes to the exact box, a view the
 * last streamed tree's rows were not cut for: its missing rows are summed once there, outside the stream.
 */
const N = perfN(20_000, { max: 50_000 });

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Communities joined by random long-range links — a force layout spreads each community out. */
function webLike(n: number, seed = 5): NetworkGraph {
  const r = rng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  const size = 40;
  for (let i = 1; i < n; i++) {
    const base = i - (i % size);
    src.push(i); tgt.push(base + Math.floor(r() * (i - base)));
    if (r() < 0.6) { src.push(i); tgt.push(Math.floor(r() * n)); }
  }
  return buildGraph({ nodeCount: n, source: src, target: tgt });
}

describe("streamed spatial LOD links (#433) — network().lod({ source: 'spatial' }).layout({ backend: 'worker' })", () => {
  it(`every streamed repaint reads the worker's super-edge rows: no edge walked, no row computed or built on the main thread (N=${N.toLocaleString()})`, async () => {
    const host = perfHost(400, 400);
    const net = network(host, { width: 400, height: 400 });
    const installed = window.requestAnimationFrame;
    try {
      await net.whenReady();
      const g = webLike(N);
      let settled = false;
      const samples: { visits: number; entries: number; misses: number }[] = [];
      window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
        installed.call(window, (t: number) => {
          callback(t);
          const stats = net.superEdgeStats;
          if (!settled && stats && net.lodSource === "worker") samples.push({ visits: stats.visits, entries: stats.entries, misses: stats.misses });
        });
      const builds0 = spatialRowBuilds;
      net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 200, multilevel: false, fit: true }); // a cold start keeps its heat: a long stream
      await net.whenSettled().then(() => { settled = true; });
      expect(samples.length, "no repaint drew a worker tree").toBeGreaterThan(3);
      for (const [i, s] of samples.entries()) {
        expect(s.visits, `streamed repaint ${i} of ${samples.length} walked edge incidences on the main thread`).toBe(0);
        expect(s.misses, `streamed repaint ${i} of ${samples.length} computed rows on the main thread`).toBe(0);
        expect(s.entries).toBeGreaterThan(0);
      }
      expect(spatialRowBuilds - builds0, "super-edge rows built on the main thread").toBe(0);
      // What the lazy gather walked per repaint was every incidence under the frontier; the rows read are fewer.
      expect(Math.max(...samples.map((s) => s.entries))).toBeLessThan(g.csr.neighbors.length);
    } finally {
      window.requestAnimationFrame = installed;
      net.destroy();
      host.remove();
    }
  }, perfBudget(60_000));
});
