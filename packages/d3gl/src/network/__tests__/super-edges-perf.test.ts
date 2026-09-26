import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier, visibleWorldRect, type LODTree, type LODTransform } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { superEdges, makeSuperEdgesScratch, type SuperEdgesData, type SuperEdgesScratch } from "../glyphs.js";
import { buildGraph } from "../graph.js";
import { fitInto } from "./fit-into.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";

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
  fitInto(g.positions, 2000); // the extent the budgets were calibrated on (see fit-into.ts)
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

// ---- #325: a RAGGED module tree — super-edges between tree nodes at different depths ---------------

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * A ragged, Infomap-shaped module tree over `n` leaves (#325): modules split recursively into 2-15
 * sub-modules and bottom out at random (below 16-96 leaves, with probability 0.3 below 4000, or at depth
 * 8), and ~30% of non-bottom modules also hold 1-4 leaves directly beside their sub-modules — so at 1M,
 * leaves sit at depths 4-9 and sibling subtrees bottom out at different depths. Each leaf has one edge
 * inside its module and one to a leaf ≤ 4096 ranks on (a nearby module, often at another depth); every
 * 16th leaf also has a random long-range edge. At 1M that is 35% of edges between different depths and
 * Σ|Δdepth| = 0.54 per edge — ~12× an Infomap map of web-NotreDame (4.1%, 0.044; 25 levels) and ~50×
 * science2001 (1.0%, 0.010) — a stress load of cross-depth (lift) pairs. Positions nest each module's
 * children in its disc, so modules are spatially compact and the cut stays O(visible).
 */
function raggedModuleTree(n: number): { tree: LODTree; centroid: [number, number]; baseK: number; depth: Int32Array; liftSteps: number } {
  let s = 11 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const records: ModuleNode[] = new Array<ModuleNode>(n);
  const positions = new Float32Array(n * 2);
  const leafDepth = new Uint8Array(n);
  const groupLo = new Uint32Array(n); // the leaf's module's leaf range — its local edge stays inside it
  const groupHi = new Uint32Array(n);
  const leaf = (i: number, path: number[], x: number, y: number, lo: number, hi: number): void => {
    records[i] = { id: i, path };
    positions[2 * i] = x;
    positions[2 * i + 1] = y;
    leafDepth[i] = path.length;
    groupLo[i] = lo;
    groupHi[i] = hi;
  };
  const place = (lo: number, hi: number, prefix: number[], x: number, y: number, R: number): void => {
    const size = hi - lo;
    const depth = prefix.length;
    if (depth >= 1 && (depth >= 8 || size <= 16 + rng() * 80 || (size <= 4000 && rng() < 0.3))) {
      for (let i = lo; i < hi; i++) {
        const rank = i - lo;
        const rr = R * Math.sqrt((rank + 0.5) / size);
        leaf(i, [...prefix, rank + 1], x + rr * Math.cos(rank * GOLDEN), y + rr * Math.sin(rank * GOLDEN), lo, hi);
      }
      return;
    }
    const direct = depth >= 1 && rng() < 0.3 ? 1 + Math.floor(rng() * 4) : 0;
    const k = Math.min(2 + Math.floor(rng() * 14), size - direct);
    const weights = Array.from({ length: k }, () => 0.2 + rng());
    const total = weights.reduce((a, b) => a + b, 0);
    const slots = direct + k;
    const at = (j: number): [number, number] => {
      const rr = 0.8 * R * Math.sqrt((j + 0.5) / slots);
      return [x + rr * Math.cos(j * GOLDEN), y + rr * Math.sin(j * GOLDEN)];
    };
    for (let j = 0; j < direct; j++) leaf(lo + j, [...prefix, j + 1], ...at(j), lo, hi);
    const first = lo + direct;
    const rest = hi - first;
    let start = first;
    let cum = 0;
    for (let j = 0; j < k; j++) {
      cum += weights[j]!;
      const end = j === k - 1 ? hi : Math.min(hi - (k - 1 - j), Math.max(start + 1, first + Math.round((rest * cum) / total)));
      const branch = [...prefix, direct + j + 1];
      if (end - start === 1) leaf(start, branch, ...at(direct + j), lo, hi);
      else place(start, end, branch, ...at(direct + j), (0.9 * R) / Math.sqrt(slots));
      start = end;
    }
  };
  place(0, n, [], 0, 0, 4 * Math.sqrt(n));

  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push(groupLo[i]! + Math.floor(rng() * (groupHi[i]! - groupLo[i]!)), (i + 1 + Math.floor(rng() * 4096)) % n);
    if (i % 16 === 0) {
      source.push(i);
      target.push(Math.floor(rng() * n));
    }
  }
  let liftSteps = 0; // Σ |depth(u) − depth(v)| over the edges: the build's added (pre-dedup) contributions
  for (let e = 0; e < source.length; e++) if (source[e] !== target[e]) liftSteps += Math.abs(leafDepth[source[e]!]! - leafDepth[target[e]!]!);
  const g = buildGraph({ nodeCount: n, source, target, directed: true });
  g.positions.set(positions);
  const tree = buildModuleLODTree(n, records, g);
  computeLODGeometry(tree, g, new Float32Array(n).fill(4));
  const parent = tree.parent!;
  const depth = new Int32Array(tree.size);
  for (let v = tree.size - 2; v >= 0; v--) depth[v] = depth[parent[v]!]! + 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 2]!, y = positions[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const baseK = 0.9 * Math.min(W / (maxX - minX), H / (maxY - minY));
  return { tree, centroid: [(minX + maxX) / 2, (minY + maxY) / 2], baseK, depth, liftSteps };
}

/** CSR entries whose endpoints sit at different depths (the #325 lift pairs), and the CSR total. */
function liftPairCount(tree: LODTree, depth: Int32Array): { lift: number; total: number } {
  const off = tree.superEdgeOffset!;
  const tgt = tree.superEdgeTarget!;
  let lift = 0;
  for (let g = 0; g < tree.size; g++) for (let p = off[g]!; p < off[g + 1]!; p++) if (depth[tgt[p]!] !== depth[g]) lift++;
  return { lift, total: tgt.length };
}

/**
 * A large **mixed-level** cut: every leaf of the even-branch top modules, and the depth-3 cut (modules at
 * depth 3, shallower leaves) of the odd ones — about half the leaves present at once, next to thousands
 * of collapsed modules at other depths, so the cross-level projection runs over every edge between the
 * two halves (reductions ON with a large visible set, AGENTS §5).
 */
function mixedFrontier(tree: LODTree, depth: Int32Array): Uint32Array {
  const parent = tree.parent!;
  const branch = tree.branch!;
  const top = new Int32Array(tree.size).fill(-1); // top-module branch id of each node (root: -1)
  for (let v = tree.size - 2; v >= 0; v--) top[v] = depth[v] === 1 ? branch[v]! : top[parent[v]!]!;
  const out: number[] = [];
  for (let v = 0; v < tree.size - 1; v++) {
    const odd = top[v]! % 2 === 1;
    if (odd ? depth[v] === 3 || (v < tree.leafCount && depth[v]! < 3) : v < tree.leafCount) out.push(v);
  }
  return Uint32Array.from(out);
}

/** One timed superEdges call (after one warm call on the same scratch). */
function timeOnce(tree: LODTree, frontier: Uint32Array, crossLevelEdges: boolean, scratch: SuperEdgesScratch): { ms: number; edges: number } {
  const wide = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
  superEdges(tree, frontier, { ...SE_STYLE, crossLevelEdges }, wide, scratch);
  const t0 = performance.now();
  const { ids } = superEdges(tree, frontier, { ...SE_STYLE, crossLevelEdges }, wide, scratch);
  return { ms: performance.now() - t0, edges: ids.length };
}

describe("#325 superEdges per-frame cost over a RAGGED module tree (cross-depth lift pairs)", () => {
  it("stays within budget with reductions ON (LOD + declutter, cross-level on/off) and OFF (every leaf present)", () => {
    const N = 100_000;
    const { tree, centroid, baseK, depth } = raggedModuleTree(N);
    const frames = sweepFrames(tree, centroid, baseK, 24);
    const scratch = makeSuperEdgesScratch();
    for (const crossLevelEdges of [false, true]) for (const f of frames) superEdges(tree, f.frontier, { ...SE_STYLE, crossLevelEdges }, f.view, scratch); // warm
    const seenRef = scratch.seen;

    // Reductions ON, zoom sweep: scratch reuse stays invisible + identity-stable, and within budget.
    const ts: number[] = [];
    let maxEdges = 0;
    for (const crossLevelEdges of [false, true]) {
      for (const f of frames) {
        const style = { ...SE_STYLE, crossLevelEdges };
        const t0 = performance.now();
        const out = superEdges(tree, f.frontier, style, f.view, scratch);
        ts.push(performance.now() - t0);
        maxEdges = Math.max(maxEdges, out.ids.length);
        expect(scratch.seen).toBe(seenRef); // no O(tree.size) realloc per frame (#210)
        expectSameOutput(out, superEdges(tree, f.frontier, style, f.view));
      }
    }
    expect(maxEdges).toBeGreaterThan(0);
    // ~10× headroom over dev hardware at 100k (median ~0.4ms, worst frame ~9-12ms at an 8k frontier) —
    // catches an order-of-magnitude drop without flaking on a slower runner.
    expect(stats(ts).median).toBeLessThan(5);
    expect(Math.max(...ts)).toBeLessThan(100);

    // Reductions ON over a large mixed-level visible set, and OFF (every leaf present), cross-level on/off.
    const mixed = mixedFrontier(tree, depth);
    const allLeaves = new Uint32Array(tree.leafCount).map((_, i) => i);
    expect(mixed.length).toBeGreaterThan(N / 4);
    for (const crossLevelEdges of [false, true]) {
      const m = timeOnce(tree, mixed, crossLevelEdges, scratch);
      const a = timeOnce(tree, allLeaves, crossLevelEdges, scratch);
      expect(a.edges).toBeGreaterThan(N); // ~2 directed edges per leaf drawn
      // ~10× headroom over dev hardware at 100k (mixed ~15-25ms, all leaves ~30-40ms).
      expect(m.ms, `mixed frontier crossLevel=${crossLevelEdges}`).toBeLessThan(400);
      expect(a.ms, `all-leaves frontier crossLevel=${crossLevelEdges}`).toBeLessThan(400);
    }
    expect(scratch.seen).toBe(seenRef);

    // Non-vacuity: the tree really is ragged, and its CSR really carries cross-depth (lift) pairs.
    const { lift, total } = liftPairCount(tree, depth);
    expect(lift, `lift pairs ${lift} of ${total}`).toBeGreaterThan(total / 50);
  });

  (BENCH ? it : it.skip)(
    `bench: superEdges per frame over a ragged module tree at ${BENCH_N.toLocaleString()} leaves`,
    () => {
      const tb = performance.now();
      const { tree, centroid, baseK, depth, liftSteps } = raggedModuleTree(BENCH_N);
      const buildMs = performance.now() - tb;
      const { lift, total } = liftPairCount(tree, depth);
      const log = (line: string): void => {
        console.log(line);
        appendFileSync("/tmp/super-edges-perf.txt", `[${process.env.BENCH_SUPER_EDGES_LABEL ?? "run"}] ragged ${line}\n`);
      };
      log(`tree.size=${tree.size.toLocaleString()}  csr=${total.toLocaleString()}  liftPairs=${lift.toLocaleString()}  liftSteps=${liftSteps.toLocaleString()}  fixture+build=${buildMs.toFixed(0)}ms`);

      const frames = sweepFrames(tree, centroid, baseK, 24);
      const maxFrontier = Math.max(...frames.map((f) => f.frontier.length));
      const scratch = makeSuperEdgesScratch();
      for (const crossLevelEdges of [false, true]) {
        const style = { ...SE_STYLE, crossLevelEdges };
        for (const f of frames) superEdges(tree, f.frontier, style, f.view, scratch); // warm
        const gc = (globalThis as { gc?: () => void }).gc;
        gc?.();
        const m0 = process.memoryUsage();
        const ts: number[] = [];
        let edges = 0;
        let outBytes = 0; // the frames' own typed-array outputs — the only per-frame allocation allowed
        for (const f of frames) {
          const t0 = performance.now();
          const { ids, lines } = superEdges(tree, f.frontier, style, f.view, scratch);
          ts.push(performance.now() - t0);
          edges = Math.max(edges, ids.length);
          if (lines) outBytes += lines.sources.byteLength + lines.targets.byteLength + lines.widths.byteLength + lines.colors.byteLength;
        }
        const m1 = process.memoryUsage();
        const { median, p95 } = stats(ts);
        const abKB = (m1.arrayBuffers - m0.arrayBuffers - outBytes) / frames.length / 1024;
        log(`sweep crossLevel=${crossLevelEdges}  maxFrontier=${maxFrontier}  maxEdges=${edges}  median=${median.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  abDelta-outputs=${abKB.toFixed(1)}KB/frame  outputs=${(outBytes / frames.length / 1024).toFixed(1)}KB/frame${gc ? "" : " (no --expose-gc; rough)"}`);
        if (gc) expect(abKB, `crossLevel=${crossLevelEdges}: typed-array growth per frame beyond its outputs`).toBeLessThan(ALLOC_KB_PER_FRAME);
        if (ASSERT) expect(median, `sweep crossLevel=${crossLevelEdges}: median ${median.toFixed(2)}ms at N=${BENCH_N}`).toBeLessThan(SWEEP_FRAME_MS);
      }

      const mixed = mixedFrontier(tree, depth);
      const allLeaves = new Uint32Array(tree.leafCount).map((_, i) => i);
      for (const crossLevelEdges of [false, true]) {
        const m = timeOnce(tree, mixed, crossLevelEdges, makeSuperEdgesScratch());
        const a = timeOnce(tree, allLeaves, crossLevelEdges, makeSuperEdgesScratch());
        log(`mixed frontier=${mixed.length.toLocaleString()} crossLevel=${crossLevelEdges}  edges=${m.edges.toLocaleString()}  ${m.ms.toFixed(1)}ms`);
        log(`all-leaves frontier=${allLeaves.length.toLocaleString()} crossLevel=${crossLevelEdges}  edges=${a.edges.toLocaleString()}  ${a.ms.toFixed(1)}ms`);
        expect(a.edges, "all-leaves frontier drew no super-edges").toBeGreaterThan(tree.leafCount);
        if (ASSERT) {
          expect(m.ms, `mixed frontier crossLevel=${crossLevelEdges}: ${m.ms.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ALL_FRONTIER_MS);
          expect(a.ms, `all-leaves frontier crossLevel=${crossLevelEdges}: ${a.ms.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ALL_FRONTIER_MS);
        }
      }
      expect(lift, "the ragged fixture's CSR carries no cross-depth pairs").toBeGreaterThan(total / 50);
    },
    600_000,
  );
});
