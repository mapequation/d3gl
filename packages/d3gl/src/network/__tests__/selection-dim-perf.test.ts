import { describe, it, expect } from "vitest";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier, visibleWorldRect, type LODTree, type LODTransform } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { superEdges, frontierCircles } from "../glyphs.js";
import { buildGraph } from "../graph.js";
import { dimOthers } from "../../map/selection-dim.js";

/**
 * Per-frame regression guard for the #162 `selection.others` dim on the LOD node lane (AGENTS.md step 5).
 *
 * The dim is applied in `network.frontierLayers` AFTER the existing per-frame emit (`superEdges` +
 * `frontierCircles`), as a per-instance alpha multiply over the **visible frontier** (nodes) and the
 * **emitted super-edges** (links) — gated to run only when a selection is active. This test reconstructs
 * that exact per-frame pipeline (the same shape as `lod-perf.bench.test.ts`) with a selection active and
 * asserts:
 *   1. **Signature — O(visible), not O(N):** the dim's keep predicate runs exactly `frontier.length`
 *      (nodes) + `ids.length` (links) times per frame, and the frontier is a small fraction of N. So a
 *      future change that made the dim O(N) (e.g. allocating an N-sized dim-alpha array per frame) would
 *      blow this count.
 *   2. **Frame budget:** each frame's cut → super-edges → circles → dim stays under a generous wall-clock
 *      ceiling at scale, catching an order-of-magnitude regression without flakiness.
 *
 * N is held at 100k (a few seconds to build) — the 1M empirical timing is the env-gated `lod-perf.bench`.
 */
const W = 1280;
const H = 800;

function seededClusteredTree(n: number): { tree: LODTree; centroid: [number, number]; baseK: number } {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
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

/** One per-frame compute at transform `t` with the #162 dim applied for `sel`, mirroring `frontierLayers`. */
function frameWithDim(tree: LODTree, t: LODTransform, sel: Set<number>): { frontier: number; links: number; nodeKeepCalls: number; linkKeepCalls: number } {
  const raw = cut(tree, t, W, H, { expandPx: 48, maxAggregateRadius: 26 });
  const frontier = declutterFrontier(tree, raw, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 26 });
  const view = visibleWorldRect(t, W, H);
  const { lines, ids } = superEdges(tree, frontier, SE_STYLE, view);
  const circles = frontierCircles(tree, frontier, FC_STYLE);

  // The dim, exactly as frontierLayers applies it (others-opacity 0.3, kept = selection by tree-node id):
  let nodeKeepCalls = 0;
  let linkKeepCalls = 0;
  dimOthers(circles.colors, frontier.length, 0.3, (k) => { nodeKeepCalls++; return sel.has(frontier[k]!); });
  dimOthers(circles.borderColors, frontier.length, 0.3, (k) => sel.has(frontier[k]!));
  dimOthers(lines?.colors, ids.length, 0.3, (k) => {
    linkKeepCalls++;
    const pair = ids[k]!;
    const src = Math.floor(pair / tree.size);
    return sel.has(src) || sel.has(pair - src * tree.size); // undirected: either endpoint
  });
  return { frontier: frontier.length, links: ids.length, nodeKeepCalls, linkKeepCalls };
}

describe("#162 others-dim per-frame cost (LOD node lane)", () => {
  it("dims over the visible frontier only — O(visible), not O(N) — and holds a frame budget over a zoom sweep", () => {
    const N = 100_000;
    const { tree, centroid, baseK } = seededClusteredTree(N);

    // A selection of a handful of nodes (the dim's kept set stays this small regardless of N).
    const sel = new Set<number>([0, 1, 2, 3, 4]);

    // A zoom-in sweep: progressively magnify toward the centroid (the realistic interaction).
    const frames: { k: number }[] = [1, 2, 4, 8, 16, 32].map((m) => ({ k: baseK * m }));
    let maxFrontier = 0;
    let worstMs = 0;
    for (let i = 0; i < frames.length; i++) {
      const k = frames[i]!.k;
      const t: LODTransform = { k, x: W / 2 - centroid[0] * k, y: H / 2 - centroid[1] * k };
      // Warm + timed: take the min of a few runs to shed scheduler noise.
      let best = Infinity;
      let r = { frontier: 0, links: 0, nodeKeepCalls: 0, linkKeepCalls: 0 };
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        r = frameWithDim(tree, t, sel);
        best = Math.min(best, performance.now() - t0);
      }
      // Signature: the keep predicate runs once per VISIBLE instance, never N times.
      expect(r.nodeKeepCalls).toBe(r.frontier);
      expect(r.linkKeepCalls).toBe(r.links);
      maxFrontier = Math.max(maxFrontier, r.frontier);
      worstMs = Math.max(worstMs, best);
    }

    // The frontier is a small fraction of N at every step (LOD culls + aggregates), so the dim — bounded
    // by the frontier — can never approach O(N). This is the core regression guard.
    expect(maxFrontier).toBeLessThan(N / 5);

    // Frame budget: the whole per-frame compute (cut + super-edges + circles + dim) is generous-ceiling
    // fast at 100k. 50ms is ~5–10× typical headroom — tight enough to catch an order-of-magnitude drop.
    expect(worstMs).toBeLessThan(50);
  });
});
