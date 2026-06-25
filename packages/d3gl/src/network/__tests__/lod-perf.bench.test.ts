import { describe, it } from "vitest";
import { appendFileSync } from "node:fs";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier, visibleWorldRect, type LODTree, type LODTransform } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { superEdges, frontierCircles } from "../glyphs.js";
import { buildGraph } from "../graph.js";

// General per-frame LOD performance harness (the WebGL hot path: cut → declutter → super-edges →
// frontier circles, all pure CPU). Use it to get EMPIRICAL before/after per-frame timings at scale when
// a feature or fix changes the per-frame path, instead of reasoning about complexity in the abstract.
//
// SKIPPED in the normal suite (it builds + lays out ~1M nodes and runs for tens of seconds). Run it
// deliberately, e.g. on the two sides of a change:
//   BENCH_LOD=1 npx vitest run packages/d3gl/src/network/__tests__/lod-perf.bench.test.ts --no-file-parallelism
//   BENCH_LOD=1 BENCH_LOD_NODES=1000000 npx vitest run … --no-file-parallelism   (default is 1M)
// Each run appends a labelled block to /tmp/lod-perf.txt and prints it; diff the two blocks.
const RUN = !!process.env.BENCH_LOD;
const N = Number(process.env.BENCH_LOD_NODES) || 1_000_000;
const LABEL = process.env.BENCH_LOD_LABEL ?? "run";
const OUT = "/tmp/lod-perf.txt";
const W = 1280;
const H = 800;

/** A clustered graph (ring backbone + deterministic chords) laid out by the real multilevel seed, so the
 *  coarsening groups are spatially compact — the locality that makes the cut's per-frame work ∝ visible. */
function seededClusteredTree(n: number): { tree: LODTree; centroid: [number, number]; baseK: number } {
  let s = 7 >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  const g = buildGraph({ nodeCount: n, source, target });
  multilevelSeed(g, { width: 2000, height: 2000 });
  const tree = buildLODTree(g, {});
  computeLODGeometry(tree, g, new Float32Array(n).fill(4));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = g.positions[i * 2]!, y = g.positions[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const baseK = 0.9 * Math.min(W / (maxX - minX), H / (maxY - minY));
  return { tree, centroid: [(minX + maxX) / 2, (minY + maxY) / 2], baseK };
}

const SE_STYLE = {
  linkStyle: "line" as const,
  directed: false,
  widthOf: () => 1,
  colorOf: () => [100, 110, 140, 200] as [number, number, number, number],
  bend: 0,
  arrowSize: 5,
  maxAggregateRadius: 26,
};
const FC_STYLE = { nodeFill: "#4878d0", aggregateFill: "#7f97c8", maxAggregateRadius: 26 };

/** Run one frame of the per-frame LOD compute at transform `t`, returning the visible frontier size. */
function frame(tree: LODTree, t: LODTransform, opts: { crossFade?: number; crossLevelEdges?: boolean; scratch: Float32Array }): number {
  const fadeBand = opts.crossFade ?? 0;
  const fadeAlpha = fadeBand > 0 ? opts.scratch : undefined;
  const raw = cut(tree, t, W, H, { expandPx: 48, maxAggregateRadius: 26, fadeBand, fadeAlpha });
  const frontier = declutterFrontier(tree, raw, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 26, fadeAlpha });
  const view = visibleWorldRect(t, W, H);
  superEdges(tree, frontier, { ...SE_STYLE, crossLevelEdges: opts.crossLevelEdges, fadeAlpha }, view);
  frontierCircles(tree, frontier, { ...FC_STYLE, fadeAlpha });
  return frontier.length;
}

/** Median / mean / p90 ms over `iters` timed frames after `warm` warmups. */
function measure(label: string, run: () => number): { label: string; frontier: number; median: number; mean: number; p90: number } {
  let frontier = 0;
  for (let i = 0; i < 5; i++) frontier = run(); // warm up the JIT
  const iters = 30;
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    frontier = run();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  const mean = ts.reduce((a, b) => a + b, 0) / iters;
  return { label, frontier, median: ts[Math.floor(iters / 2)]!, mean, p90: ts[Math.floor(iters * 0.9)]! };
}

describe("LOD per-frame performance", () => {
  (RUN ? it : it.skip)(
    "per-frame compute (cut → declutter → super-edges → circles) at scale",
    () => {
      const { tree, centroid, baseK } = seededClusteredTree(N);
      const scratch = new Float32Array(tree.size);
      // A zoomed-in view (≈6× the whole-graph fit), centred — gives a mixed frontier (some regions
      // expanded to finer levels, others still collapsed), which is what exercises cross-level edges.
      const k = baseK * 6;
      const t: LODTransform = { k, x: W / 2 - centroid[0] * k, y: H / 2 - centroid[1] * k };

      const rows = [
        measure("baseline (no cross-fade, no cross-level)", () => frame(tree, t, { scratch })),
        measure("crossLevelEdges on", () => frame(tree, t, { crossLevelEdges: true, scratch })),
        measure("crossFade 0.3", () => frame(tree, t, { crossFade: 0.3, scratch })),
        measure("crossFade 0.3 + crossLevelEdges on", () => frame(tree, t, { crossFade: 0.3, crossLevelEdges: true, scratch })),
      ];

      const lines = [
        `\n=== ${LABEL}  N=${N.toLocaleString()} nodes  S=${tree.size.toLocaleString()} tree-nodes  (${W}×${H}, k=${k.toExponential(2)}) ===`,
        ...rows.map(
          (r) => `${r.label.padEnd(44)} frontier=${String(r.frontier).padStart(6)}  median=${r.median.toFixed(2).padStart(8)}ms  mean=${r.mean.toFixed(2).padStart(8)}ms  p90=${r.p90.toFixed(2).padStart(8)}ms`,
        ),
      ];
      const block = lines.join("\n") + "\n";
      console.log(block);
      appendFileSync(OUT, block);
    },
    600_000,
  );
});
