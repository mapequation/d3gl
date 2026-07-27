import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier, visibleWorldRect, type LODTree, type LODTransform } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { superEdges, makeSuperEdgesScratch, type SuperEdgesData } from "../glyphs.js";
import { buildGraph } from "../graph.js";

/**
 * Per-frame regression guard for #210 (AGENTS.md lifecycle §5): `superEdges` must do **zero
 * O(tree.size) work per frame** when fed the engine-owned scratch — its cost is
 * O(frontier + drawn super-edges) only.
 *
 * Signature asserted deterministically:
 *   1. the O(tree.size) presence array (`scratch.seen`) is allocated ONCE per tree and its identity
 *      is stable across every subsequent frame (before #210 a `new Uint8Array(tree.size)` was
 *      allocated + zeroed on every zoom-frame emit);
 *   2. the gather grow-arrays stop reallocating once warm (per-frame allocations are outputs only);
 *   3. reusing the scratch is semantically invisible — every frame's output is deep-equal to a
 *      fresh-scratch call (no stale presence stamps / dirty maps leaking across frames), with
 *      cross-level edges (#139) and cross-fade (#133) both exercised;
 *   4. a generous-but-real frame budget over a zoom sweep, plus an everything-visible frontier
 *      (all leaves at once — LOD not allowed to shrink the set) under its own budget.
 *
 * N is held at 100k in the normal suite (a few seconds to build, like `selection-dim-perf.test.ts`);
 * the 1M empirical numbers come from the env-gated bench below:
 *   BENCH_SUPER_EDGES=1 npx vitest run packages/d3gl/src/network/__tests__/super-edges-perf.test.ts --no-file-parallelism
 * Each bench run appends a labelled line to /tmp/super-edges-perf.txt (BENCH_SUPER_EDGES_LABEL).
 */
const BENCH = !!process.env.BENCH_SUPER_EDGES;
const BENCH_N = Number(process.env.BENCH_SUPER_EDGES_NODES) || 1_000_000;
// The at-scale leg gates rather than only reporting (#258). Signatures assert whenever the bench
// runs; wall-clock only under PERF_ASSERT (the single-threaded CI tier), per lod-perf.bench.test.ts.
// Calibration at N=500k on an M-series laptop: sweep median 0.19-0.34ms (p95 0.67-1.48ms);
// abDelta ~32 KB/frame. The everything-visible frontier is measured separately — the zoom sweep
// alone only reaches a ~1.4k frontier even at 500k leaves, so on its own it would leave the
// reductions-ON at-scale case (AGENTS §5) unmeasured here.
const ASSERT = !!process.env.PERF_ASSERT;
const SWEEP_FRAME_MS = Number(process.env.PERF_SUPER_EDGES_MS) || 20;
const ALL_FRONTIER_MS = Number(process.env.PERF_SUPER_EDGES_ALL_MS) || 3000;
const ALLOC_KB_PER_FRAME = Number(process.env.PERF_SUPER_EDGES_ALLOC_KB) || 256;
const W = 1280;
const H = 800;

function seededClusteredTree(n: number): { tree: LODTree; centroid: [number, number]; baseK: number } {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  // Ring backbone + LOCAL chords (span ≤ 50): keeps edge LCAs low in the tree so the distinct-pair
  // count per level converges and the super-edge CSR builds at 1M leaves without hitting the
  // buildSuperEdges Map ceiling (#177 — a non-goal here).
  const span = Math.min(50, Math.max(2, n - 2));
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 1 + Math.floor(rng() * span)) % n);
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

type Frame = { frontier: Uint32Array; view: { minX: number; maxX: number; minY: number; maxY: number } };

/** Precompute a zoom sweep's frontiers OUTSIDE the timed region — only superEdges is timed. */
function sweepFrames(tree: LODTree, centroid: [number, number], baseK: number, count: number): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const k = baseK * Math.pow(2, i / 4); // 1× → ~55× over 24 frames
    const t: LODTransform = { k, x: W / 2 - centroid[0] * k, y: H / 2 - centroid[1] * k };
    const raw = cut(tree, t, W, H, { expandPx: 48, maxAggregateRadius: 26 });
    const frontier = declutterFrontier(tree, raw, t, W, H, { screenSized: false, k, maxAggregateRadius: 26 });
    frames.push({ frontier, view: visibleWorldRect(t, W, H) });
  }
  return frames;
}

/** Deep equality of two superEdges outputs (every batch field, ids, flows) — order-sensitive. */
function expectSameOutput(a: SuperEdgesData, b: SuperEdgesData): void {
  expect(a.ids).toEqual(b.ids);
  expect(a.flows).toEqual(b.flows);
  expect(!!a.lines).toBe(!!b.lines);
  expect(!!a.halfArrows).toBe(!!b.halfArrows);
  expect(!!a.arrows).toBe(!!b.arrows);
  if (a.lines && b.lines) {
    expect(a.lines.count).toBe(b.lines.count);
    expect(a.lines.sources).toEqual(b.lines.sources);
    expect(a.lines.targets).toEqual(b.lines.targets);
    expect(a.lines.widths).toEqual(b.lines.widths);
    expect(a.lines.colors).toEqual(b.lines.colors);
  }
  if (a.halfArrows && b.halfArrows) {
    expect(a.halfArrows.count).toBe(b.halfArrows.count);
    expect(a.halfArrows.sources).toEqual(b.halfArrows.sources);
    expect(a.halfArrows.targets).toEqual(b.halfArrows.targets);
    expect(a.halfArrows.radii).toEqual(b.halfArrows.radii);
    expect(a.halfArrows.widths).toEqual(b.halfArrows.widths);
    expect(a.halfArrows.colors).toEqual(b.halfArrows.colors);
  }
  if (a.arrows && b.arrows) {
    expect(a.arrows.count).toBe(b.arrows.count);
    expect(a.arrows.radii).toEqual(b.arrows.radii);
    expect(a.arrows.colors).toEqual(b.arrows.colors);
  }
}

function stats(ts: number[]): { median: number; p95: number } {
  const s = [...ts].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

describe("#210 superEdges per-frame cost", () => {
  it("does zero O(tree.size) work per frame with the engine scratch, byte-identical to a fresh call, within budget", () => {
    const N = 100_000;
    const { tree, centroid, baseK } = seededClusteredTree(N);
    const frames = sweepFrames(tree, centroid, baseK, 24);
    // Cross-fade alpha (#133) for half the frames, so the fade path's presence reads are covered too.
    const fadeAlpha = new Float32Array(tree.size).fill(0.5);

    const scratch = makeSuperEdgesScratch();
    // Warm sweep: grows `seen` once to tree.size and the gather arrays to the sweep's max edge count.
    for (const f of frames) superEdges(tree, f.frontier, { ...SE_STYLE, crossLevelEdges: true }, f.view, scratch);
    const seenRef = scratch.seen;
    const aRef = scratch.aS;
    const genBefore = scratch.gen;
    expect(seenRef.length).toBeGreaterThanOrEqual(tree.size);

    // Timed sweep with the warm scratch: identity-stable scratch + output equal to a fresh-scratch call.
    let worstMs = 0;
    let maxEdges = 0;
    frames.forEach((f, i) => {
      const style = { ...SE_STYLE, crossLevelEdges: i % 2 === 0, fadeAlpha: i % 3 === 0 ? fadeAlpha : undefined };
      const t0 = performance.now();
      const out = superEdges(tree, f.frontier, style, f.view, scratch);
      worstMs = Math.max(worstMs, performance.now() - t0);
      maxEdges = Math.max(maxEdges, out.ids.length);
      // 1. + 2. Deterministic signature: the O(tree.size) array and the warm gather arrays are REUSED —
      // no per-frame reallocation (before #210: a fresh O(tree.size) alloc + zero on every emit).
      expect(scratch.seen).toBe(seenRef);
      expect(scratch.aS).toBe(aRef);
      // 3. Scratch reuse is invisible: same output as a throwaway-scratch call (no state leaks across
      // frames — stale presence stamps, dirty pair/cover maps, gather leftovers).
      expectSameOutput(out, superEdges(tree, f.frontier, style, f.view));
    });
    expect(scratch.gen).toBe(genBefore + frames.length); // one stamp bump per call — never a clear
    expect(maxEdges).toBeGreaterThan(0); // the sweep actually drew super-edges

    // 4. Frame budget (generous ~50× headroom, catches an order-of-magnitude drop): superEdges-only,
    // per zoom frame, at a 100k-leaf tree — sub-ms typical on dev hardware.
    expect(worstMs).toBeLessThan(25);

    // Everything-visible frontier: all leaves at once (reductions not allowed to shrink the set —
    // AGENTS §5). Cost is O(frontier + all leaf-level super-edges), still well under a frame-scale
    // budget; the point is it cannot regress to O(tree.size · frames) or worse.
    const allLeaves = new Uint32Array(tree.leafCount);
    for (let i = 0; i < tree.leafCount; i++) allLeaves[i] = i;
    const wide = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
    const t0 = performance.now();
    const outAll = superEdges(tree, allLeaves, { ...SE_STYLE, crossLevelEdges: true }, wide, scratch);
    const allMs = performance.now() - t0;
    expect(outAll.ids.length).toBeGreaterThan(N); // ~2 directed edges per leaf drawn
    expect(scratch.seen).toBe(seenRef); // still no O(tree.size) realloc
    expect(allMs).toBeLessThan(250); // ~10× headroom over dev-hardware typical (~15-25ms at 100k)
  });

  (BENCH ? it : it.skip)(
    `bench: superEdges per zoom-frame at ${BENCH_N.toLocaleString()} leaves`,
    () => {
      const { tree, centroid, baseK } = seededClusteredTree(BENCH_N);
      const frames = sweepFrames(tree, centroid, baseK, 24);
      const maxFrontier = Math.max(...frames.map((f) => f.frontier.length));
      const scratch = makeSuperEdgesScratch(); // the engine call shape (#210)

      for (const crossLevelEdges of [false, true]) {
        const style = { ...SE_STYLE, crossLevelEdges };
        // Warm up the JIT (and the scratch) on the whole sweep once.
        for (const f of frames) superEdges(tree, f.frontier, style, f.view, scratch);
        const gc = (globalThis as { gc?: () => void }).gc;
        gc?.();
        const m0 = process.memoryUsage(); // heapUsed misses typed-array backing stores; arrayBuffers has them
        const ts: number[] = [];
        let edges = 0;
        for (const f of frames) {
          const t0 = performance.now();
          const { ids } = superEdges(tree, f.frontier, style, f.view, scratch);
          ts.push(performance.now() - t0);
          edges = Math.max(edges, ids.length);
        }
        const m1 = process.memoryUsage();
        const { median, p95 } = stats(ts);
        const perFrameKB = (a: number, b: number): string => ((b - a) / frames.length / 1024).toFixed(1);
        const line =
          `crossLevel=${crossLevelEdges}  tree.size=${tree.size.toLocaleString()}  maxFrontier=${maxFrontier}  maxEdges=${edges}  ` +
          `median=${median.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  heapDelta=${perFrameKB(m0.heapUsed, m1.heapUsed)}KB/frame  ` +
          `abDelta=${perFrameKB(m0.arrayBuffers, m1.arrayBuffers)}KB/frame${gc ? "" : " (no --expose-gc; rough)"}\n`;
        console.log(line);
        appendFileSync("/tmp/super-edges-perf.txt", `[${process.env.BENCH_SUPER_EDGES_LABEL ?? "run"}] ${line}`);

        if (gc) {
          const abKB = (m1.arrayBuffers - m0.arrayBuffers) / frames.length / 1024;
          expect(abKB, `crossLevel=${crossLevelEdges}: ${abKB.toFixed(1)}KB/frame of typed-array growth`).toBeLessThan(ALLOC_KB_PER_FRAME);
        }
        if (ASSERT) {
          expect(median, `crossLevel=${crossLevelEdges}: median ${median.toFixed(2)}ms exceeds ${SWEEP_FRAME_MS}ms at N=${BENCH_N}`).toBeLessThan(SWEEP_FRAME_MS);
        }
      }

      // Everything-visible frontier at scale: ALL leaves at once. The zoom sweep above tops out at a
      // ~1.4k frontier even at 500k leaves, so without this the at-scale leg never exercises the
      // reductions-ON large-visible-set case that AGENTS §5 makes the primary goal. The always-on leg
      // does this at 100k; this is the same shape at BENCH_N.
      const allLeaves = new Uint32Array(tree.leafCount);
      for (let i = 0; i < tree.leafCount; i++) allLeaves[i] = i;
      const wide = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
      const allScratch = makeSuperEdgesScratch();
      superEdges(tree, allLeaves, { ...SE_STYLE, crossLevelEdges: true }, wide, allScratch); // warm
      const a0 = performance.now();
      const outAll = superEdges(tree, allLeaves, { ...SE_STYLE, crossLevelEdges: true }, wide, allScratch);
      const allMs = performance.now() - a0;
      const allLine = `all-leaves frontier  leaves=${tree.leafCount.toLocaleString()}  edges=${outAll.ids.length.toLocaleString()}  ${allMs.toFixed(1)}ms\n`;
      console.log(allLine);
      appendFileSync("/tmp/super-edges-perf.txt", `[${process.env.BENCH_SUPER_EDGES_LABEL ?? "run"}] ${allLine}`);

      // Signature: the frontier really was every leaf, and it really drew super-edges over it.
      expect(allLeaves.length).toBe(tree.leafCount);
      expect(outAll.ids.length, "all-leaves frontier drew no super-edges").toBeGreaterThan(tree.leafCount);
      if (ASSERT) {
        expect(allMs, `all-leaves frontier ${allMs.toFixed(0)}ms exceeds ${ALL_FRONTIER_MS}ms at N=${BENCH_N}`).toBeLessThan(ALL_FRONTIER_MS);
      }
      expect(frames.length).toBe(24);
    },
    600_000,
  );
});
