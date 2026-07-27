import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { buildLODTree, computeLODGeometry, computeLODPositions, computeLODStyle, updateLODPositionsForLeaves, type LODTree } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { buildGraph, type NetworkGraph } from "../graph.js";

/**
 * Incremental LOD geometry during node-drag (#211, AGENTS.md lifecycle §5). A node-drag is a
 * continuous pointer interaction (a per-frame path): before #211 every drag move ran the full
 * O(tree size) geometry recompute (`computeLODPositions` + `computeLODStyle`) even though only the
 * held leaves moved. The drag path now folds the held leaves in incrementally
 * (`updateLODPositionsForLeaves`, O(held · depth)) and runs one exact pass on release.
 *
 * Permanent guards (normal suite):
 *  1. **Equivalence** — after a drag sequence the incremental tree matches a from-scratch recompute
 *     exactly for the sum aggregates (centroids) and is a conservative superset for the max
 *     aggregate (extent); after the release pass it is exactly the from-scratch result.
 *  2. **Deterministic signature** — one move writes ONLY the held leaves ∪ their ancestor chains
 *     (≤ held · depth tree nodes), never the whole tree, and never touches style geometry.
 *  3. **Per-move budget** — a move stays orders of magnitude under one full pass.
 *
 * The engine-path signature (a real pointer drag issues no full-tree pass per move) is the
 * companion browser test in `network-drag.browser.test.ts`.
 *
 * Env-gated bench (BEFORE = full pass per move, AFTER = incremental per move) at ~1M leaves:
 *   BENCH_DRAG=1 NODE_OPTIONS=--expose-gc npx vitest run \
 *     packages/d3gl/src/network/__tests__/lod-drag-incremental.test.ts --no-file-parallelism
 * Appends to /tmp/lod-drag-perf.txt.
 */
const BENCH = !!process.env.BENCH_DRAG;
const BENCH_N = Number(process.env.BENCH_DRAG_NODES) || 1_000_000;
const OUT = "/tmp/lod-drag-perf.txt";
// The at-scale leg gates rather than only reporting (#258). Calibration at N=500k on an M-series
// laptop: BEFORE (full pass per move) ~307ms, AFTER (incremental) 0.001ms held=1 / 0.056ms held=100
// — a >5000× gap, so a 100× floor is far clear of noise while still catching a collapse back to
// the full pass. Node-drag is a continuous pointer interaction: AGENTS §5 treats it as per-frame.
const ASSERT = !!process.env.PERF_ASSERT;
const MOVE_MS = Number(process.env.PERF_DRAG_MOVE_MS) || 5;
const MIN_SPEEDUP = Number(process.env.PERF_DRAG_MIN_SPEEDUP) || 100;

/** A clustered graph (ring backbone + deterministic short-range chords) laid out by the real
 *  multilevel seed, coarsened into the real LOD tree — the fixture shape of `lod-perf.bench.test.ts`,
 *  with local chords so the super-edge pair set stays bounded at 1M leaves. */
function seededClusteredTree(n: number): { tree: LODTree; graph: NetworkGraph } {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 2 + Math.floor(rng() * 48)) % n);
  }
  const g = buildGraph({ nodeCount: n, source, target });
  multilevelSeed(g, { width: 2000, height: 2000 });
  const tree = buildLODTree(g, {});
  return { tree, graph: g };
}

/** Parent pointers from the children CSR (coarsening trees carry no `parent`) — built once, as
 *  `Network.treeParent` does. */
function parentOf(tree: LODTree): Int32Array {
  const parent = new Int32Array(tree.size).fill(-1);
  for (let g = 0; g < tree.size; g++) for (let p = tree.childOffset[g]!; p < tree.childOffset[g + 1]!; p++) parent[tree.children[p]!] = g;
  return parent;
}

/** Deterministic per-leaf RGBA (stands in for categorical module colours — turns on the HCL
 *  colour aggregation in `computeLODStyle`, the dominant cost of the old per-move style pass). */
function leafColors(n: number): Uint8Array {
  const c = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    c[i * 4] = (i * 97) & 255;
    c[i * 4 + 1] = (i * 57) & 255;
    c[i * 4 + 2] = (i * 31) & 255;
    c[i * 4 + 3] = 255;
  }
  return c;
}

/** The held set ∪ every ancestor of a held leaf — the only tree nodes a drag move may write. */
function heldChains(held: number[], parent: Int32Array): Set<number> {
  const s = new Set<number>();
  for (const i of held) for (let g = i; g !== -1; g = parent[g]!) s.add(g);
  return s;
}

const N = 50_000;
const MOVES = 50;

describe("#211 incremental LOD geometry during node-drag", () => {
  const { tree, graph } = seededClusteredTree(N);
  const parent = parentOf(tree);
  const radii = new Float32Array(N).fill(4);
  const colors = leafColors(N);
  const resetGeometry = (): void => computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);

  /** Index of the first differing element, or -1 (plain scan — per-element `expect` is too slow on CI). */
  const firstDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
    return -1;
  };

  for (const heldCount of [1, 100]) {
    it(
      `matches a from-scratch recompute after a ${MOVES}-move drag of ${heldCount} held leaf(s) — exact sums, conservative extent, exact on release`,
      () => {
        resetGeometry();
        const held = Array.from({ length: heldCount }, (_, k) => (k * 37) % N);
        const styleBefore = { radius: tree.radius.slice(), weight: tree.weight.slice(), border: tree.border.slice(), color: tree.color.slice() };

        for (let m = 0; m < MOVES; m++) {
          for (const i of held) {
            graph.positions[i * 2] = graph.positions[i * 2]! + 2;
            graph.positions[i * 2 + 1] = graph.positions[i * 2 + 1]! + 1;
          }
          updateLODPositionsForLeaves(tree, graph.positions, held, parent);
        }

        // From-scratch reference over the same (moved) positions.
        const ref: LODTree = { ...tree, cx: new Float32Array(tree.size), cy: new Float32Array(tree.size), extent: new Float32Array(tree.size), count: new Uint32Array(tree.size) };
        computeLODPositions(ref, graph.positions);

        let maxCentroidErr = 0;
        let extentViolations = 0;
        for (let g = 0; g < tree.size; g++) {
          // Sum aggregates (centroids): exact up to Float32 accumulation across the drag.
          const ex = Math.abs(tree.cx[g]! - ref.cx[g]!);
          const ey = Math.abs(tree.cy[g]! - ref.cy[g]!);
          if (ex > maxCentroidErr) maxCentroidErr = ex;
          if (ey > maxCentroidErr) maxCentroidErr = ey;
          // Max aggregate (extent): conservative superset during the drag — never below the true extent.
          if (tree.extent[g]! < ref.extent[g]! - 1e-3) extentViolations++;
        }
        expect(maxCentroidErr).toBeLessThan(0.1);
        expect(extentViolations).toBe(0);

        // Style-derived geometry is untouched by drag moves.
        expect(firstDiff(tree.radius, styleBefore.radius)).toBe(-1);
        expect(firstDiff(tree.weight, styleBefore.weight)).toBe(-1);
        expect(firstDiff(tree.border, styleBefore.border)).toBe(-1);
        expect(firstDiff(tree.color, styleBefore.color)).toBe(-1);

        // Release (settleAfterDrag): one exact pass — bit-identical to the from-scratch reference.
        computeLODPositions(tree, graph.positions);
        expect(firstDiff(tree.cx, ref.cx)).toBe(-1);
        expect(firstDiff(tree.cy, ref.cy)).toBe(-1);
        expect(firstDiff(tree.extent, ref.extent)).toBe(-1);
      },
      30_000,
    );
  }

  it("deterministic signature: one move writes only the held leaves' ancestor chains, never the tree", () => {
    resetGeometry();
    const held = [0, 37, 74];
    const before = { cx: tree.cx.slice(), cy: tree.cy.slice(), extent: tree.extent.slice() };
    for (const i of held) {
      graph.positions[i * 2] = graph.positions[i * 2]! + 25;
      graph.positions[i * 2 + 1] = graph.positions[i * 2 + 1]! - 10;
    }
    updateLODPositionsForLeaves(tree, graph.positions, held, parent);

    const allowed = heldChains(held, parent);
    expect(allowed.size).toBeLessThanOrEqual(held.length * (tree.levelCount + 1)); // O(held · depth)
    const touched: number[] = [];
    for (let g = 0; g < tree.size; g++) {
      if (tree.cx[g] !== before.cx[g] || tree.cy[g] !== before.cy[g] || tree.extent[g] !== before.extent[g]) touched.push(g);
    }
    expect(touched.length).toBeGreaterThan(0); // the chains did move
    for (const g of touched) expect(allowed.has(g)).toBe(true); // …and nothing outside them
  });

  it("per-move budget: an incremental move stays far under one full-tree pass", () => {
    resetGeometry();
    const held = Array.from({ length: 100 }, (_, k) => (k * 37) % N);

    // One full pass (what the old repaintDuringDrag ran per move), median of 5.
    const full: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      computeLODPositions(tree, graph.positions);
      computeLODStyle(tree, radii, graph.strength, undefined, colors);
      full.push(performance.now() - t0);
    }
    const fullMedian = full.sort((a, b) => a - b)[2]!;

    // 200 incremental moves of 100 held leaves, total.
    const t0 = performance.now();
    for (let m = 0; m < 200; m++) {
      for (const i of held) {
        graph.positions[i * 2] = graph.positions[i * 2]! + 2;
        graph.positions[i * 2 + 1] = graph.positions[i * 2 + 1]! + 1;
      }
      updateLODPositionsForLeaves(tree, graph.positions, held, parent);
    }
    const perMove = (performance.now() - t0) / 200;

    // A regression back to a full pass per move would cost ≥ fullMedian per move; the incremental
    // path is O(held · depth) ≈ 100 · ~10 writes — orders of magnitude under it.
    expect(perMove).toBeLessThan(fullMedian / 10);
    expect(perMove).toBeLessThan(5); // absolute ceiling (ms), generous against machine noise
  });
});

describe("#211 drag-move LOD geometry bench (env-gated)", () => {
  (BENCH ? it : it.skip)(
    "full recompute per move (BEFORE) vs incremental (AFTER) at scale",
    () => {
      const { tree, graph } = seededClusteredTree(BENCH_N);
      const parent = parentOf(tree);
      const radii = new Float32Array(BENCH_N).fill(4);
      const colors = leafColors(BENCH_N);
      computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);

      const gc = (globalThis as { gc?: () => void }).gc;
      const lines: string[] = [`\n=== #211 drag bench  N=${BENCH_N.toLocaleString()}  tree=${tree.size.toLocaleString()} nodes  depth=${tree.levelCount} ===`];

      const measure = (label: string, heldCount: number, move: (held: number[]) => void): number => {
        const held = Array.from({ length: heldCount }, (_, k) => k * 37);
        const ts: number[] = [];
        gc?.();
        const h0 = process.memoryUsage().heapUsed;
        for (let m = 0; m < 50; m++) {
          for (const i of held) {
            graph.positions[i * 2] = graph.positions[i * 2]! + 2;
            graph.positions[i * 2 + 1] = graph.positions[i * 2 + 1]! + 1;
          }
          const t0 = performance.now();
          move(held);
          ts.push(performance.now() - t0);
        }
        const h1 = process.memoryUsage().heapUsed;
        const s = [...ts].sort((a, b) => a - b);
        const median = s[Math.floor(s.length / 2)] ?? 0;
        const p95 = s[Math.floor(s.length * 0.95)] ?? 0;
        lines.push(
          `${label.padEnd(18)} held=${String(heldCount).padStart(3)}  median=${median.toFixed(3).padStart(10)}ms  p95=${p95.toFixed(3).padStart(10)}ms  heapΔ=${((h1 - h0) / 1e6).toFixed(1)}MB/50moves`,
        );
        return median;
      };

      /** (held-node count, full-pass median, incremental median) per regime — the ratio is the guard. */
      const regimes: { heldCount: number; before: number; after: number }[] = [];
      for (const heldCount of [1, 100]) {
        const before = measure("BEFORE full/move", heldCount, () => {
          computeLODPositions(tree, graph.positions);
          computeLODStyle(tree, radii, graph.strength, undefined, colors);
        });
        const after = measure("AFTER incr/move", heldCount, (held) => updateLODPositionsForLeaves(tree, graph.positions, held, parent));
        regimes.push({ heldCount, before, after });
      }

      const block = lines.join("\n") + "\n";
      console.log(block);
      appendFileSync(OUT, block);

      for (const { heldCount, before, after } of regimes) {
        // --- signature (always): the incremental path must stay orders below a full pass. -----
        expect(
          before / after,
          `held=${heldCount}: incremental ${after.toFixed(3)}ms vs full pass ${before.toFixed(1)}ms — only ${(before / after).toFixed(0)}× faster`,
        ).toBeGreaterThan(MIN_SPEEDUP);
        // --- wall-clock (uncontended runs only) ----------------------------------------------
        if (ASSERT) {
          expect(after, `held=${heldCount}: ${after.toFixed(3)}ms per pointer-move exceeds ${MOVE_MS}ms at N=${BENCH_N}`).toBeLessThan(MOVE_MS);
        }
      }
    },
    600_000,
  );
});
