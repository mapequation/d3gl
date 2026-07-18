import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { buildLODTree, computeLODGeometry, cut, makeCutScratch, declutterFrontier, makeDeclutterFrontierScratch, type LODTree, type LODTransform, type CutOptions, type DeclutterOptions } from "../lod.js";
import { declutterScreen } from "../../core/declutter.js";
import { multilevelSeed } from "../coarsen.js";
import { buildGraph } from "../graph.js";

/**
 * Per-frame regression guard for #213 (AGENTS.md lifecycle §5): the LOD visible-set pipeline
 * (`cut` → `declutterFrontier`) must be **allocation-free steady-state** on the engine-owned scratch —
 * no boxed number[]s, no O(F) output copies, no per-frame Float64Array/order-array churn, and a typed
 * index sort on a flat key array instead of a boxed-lookup closure comparator.
 *
 * Signature asserted deterministically:
 *   1. every scratch buffer's identity is stable across frames once warm (before #213: fresh
 *      frontier/stack arrays + a full output copy in cut, 3×Float64Array + Array.from order + Uint8Array
 *      flags + a second output copy in declutterFrontier, per frame);
 *   2. reusing the scratch is semantically invisible — every frame's cut AND declutter output is
 *      element-identical to a fresh-allocation call, with cross-fade (#133, incl. its declutter
 *      ancestor-exemption) both off and on;
 *   3. a generous-but-real frame budget over both frontier regimes — the reductions-ON everything-
 *      expanded frontier of ~all leaves (LOD not allowed to shrink the set, AGENTS §5) and the default
 *      expandPx sweep.
 *
 * N is held at 100k in the normal suite (a few seconds to build, like super-edges-perf.test.ts);
 * the 1M empirical numbers come from the env-gated bench below:
 *   BENCH_FRONTIER=1 npx vitest run packages/d3gl/src/network/__tests__/frontier-perf.test.ts --no-file-parallelism
 * Each bench run appends a labelled line per regime to /tmp/frontier-perf.txt (BENCH_FRONTIER_LABEL).
 */
const BENCH = !!process.env.BENCH_FRONTIER;
const BENCH_N = Number(process.env.BENCH_FRONTIER_NODES) || 1_000_000;
const W = 1280;
const H = 800;

/** Clustered graph (ring backbone + local chords) laid out by the real multilevel seed — the same
 *  fixture super-edges-perf.test.ts / lod-perf.bench.test.ts use, so numbers are comparable. */
function seededClusteredTree(n: number): { tree: LODTree; centroid: [number, number]; baseK: number } {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  const span = Math.min(50, Math.max(2, n - 2));
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 1 + Math.floor(rng() * span)) % n);
  }
  const g = buildGraph({ nodeCount: n, source, target });
  multilevelSeed(g, { width: 2000, height: 2000 });
  const tree = buildLODTree(g, {});
  computeLODGeometry(tree, g, new Float32Array(n).fill(4));
  // The coarsening tree carries no parent map; derive one from the children CSR so the cross-fade
  // declutter ancestor-exemption (#133, `onSamePath`) is exercised too.
  const parent = new Int32Array(tree.size).fill(-1);
  for (let p = tree.leafCount; p < tree.size; p++) {
    for (let c = tree.childOffset[p]!; c < tree.childOffset[p + 1]!; c++) parent[tree.children[c]!] = p;
  }
  tree.parent = parent;
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

const at = (centroid: [number, number], k: number): LODTransform => ({ k, x: W / 2 - centroid[0] * k, y: H / 2 - centroid[1] * k });

/** The pre-#213 `cut` (boxed frontier/stack number[]s + a full output copy) — the byte-identity reference. */
function referenceCut(tree: LODTree, t: LODTransform, opts: CutOptions): Uint32Array {
  const { leafCount, levelCount, levelOffset, childOffset, children, cx, cy, extent, radius } = tree;
  const expandPx = opts.expandPx!;
  const maxAgg = opts.maxAggregateRadius ?? Infinity;
  const ax = (0 - t.x) / t.k, bx = (W - t.x) / t.k, ay = (0 - t.y) / t.k, by = (H - t.y) / t.k;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
  const fadeBand = opts.fadeBand ?? 0;
  const fade = fadeBand > 0;
  const lo = expandPx * (1 - fadeBand);
  const hi = expandPx * (1 + fadeBand);
  const alphaOut = opts.fadeAlpha;
  const smoothstep = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const frontier: number[] = [];
  const stack: number[] = [];
  const alphaStack: number[] = [];
  for (let g = levelOffset[levelCount - 1]!; g < levelOffset[levelCount]!; g++) {
    stack.push(g);
    if (fade) alphaStack.push(1);
  }
  while (stack.length > 0) {
    const g = stack.pop()!;
    const a = fade ? alphaStack.pop()! : 1;
    const r = g < leafCount ? radius[g]! : Math.min(radius[g]!, maxAgg);
    const m = extent[g]! + (opts.screenSized ? r / t.k : r);
    const gx = cx[g]!, gy = cy[g]!;
    if (gx + m < minX || gx - m > maxX || gy + m < minY || gy - m > maxY) continue;
    if (g < leafCount) { frontier.push(g); if (fade && alphaOut) alphaOut[g] = a; continue; }
    const footprint = 2 * extent[g]! * t.k;
    let drawA = -1, childA = -1;
    if (!fade) { if (footprint >= expandPx) childA = 1; else drawA = 1; }
    else if (footprint >= hi) childA = a;
    else if (footprint >= lo) { const aggA = smoothstep((hi - footprint) / (hi - lo)); drawA = a * aggA; childA = a * (1 - aggA); }
    else drawA = a;
    if (drawA > 0) { frontier.push(g); if (fade && alphaOut) alphaOut[g] = drawA; }
    if (childA > 0) for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) { stack.push(children[p]!); if (fade) alphaStack.push(childA); }
  }
  return Uint32Array.from(frontier);
}

/** The pre-#213 `declutterFrontier` (fresh Float64Array×3 + Array.from order + a stable closure-
 *  comparator Array#sort + fresh flags + output copy) — the byte-identity reference the radix index
 *  sort must reproduce exactly (stable, descending weight, ties in index order). */
function referenceDeclutter(tree: LODTree, frontier: Uint32Array, t: LODTransform, opts: DeclutterOptions): Uint32Array {
  const F = frontier.length;
  if (F <= 1) return frontier;
  const maxAgg = opts.maxAggregateRadius ?? Infinity;
  const px = new Float64Array(F), py = new Float64Array(F), pr = new Float64Array(F);
  for (let i = 0; i < F; i++) {
    const g = frontier[i]!;
    const drawn = g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    pr[i] = opts.screenSized ? drawn : drawn * opts.k;
    px[i] = tree.cx[g]! * t.k + t.x;
    py[i] = tree.cy[g]! * t.k + t.y;
  }
  const order = Array.from({ length: F }, (_, i) => i);
  order.sort((a, b) => tree.weight[frontier[b]!]! - tree.weight[frontier[a]!]!);
  const par = opts.fadeAlpha ? tree.parent : undefined;
  const onSamePath = (a: number, b: number): boolean => {
    for (let x = par![a]!; x >= 0; x = par![x]!) if (x === b) return true;
    for (let x = par![b]!; x >= 0; x = par![x]!) if (x === a) return true;
    return false;
  };
  const ignore = par ? (i: number, j: number) => onSamePath(frontier[i]!, frontier[j]!) : undefined;
  const kept = declutterScreen(F, px, py, pr, order, W, H, opts.spacing ?? 1, new Uint8Array(F), undefined, ignore);
  let n = 0;
  for (let i = 0; i < F; i++) if (kept[i]) n++;
  const out = new Uint32Array(n);
  let w = 0;
  for (let i = 0; i < F; i++) if (kept[i]) out[w++] = frontier[i]!;
  return out;
}

/** Element-wise Uint32Array equality without vitest's deep-equal walk (frontiers reach ~100k–1M). */
function expectSameU32(actual: Uint32Array, reference: Uint32Array, what: string): void {
  expect(actual.length, `${what} length`).toBe(reference.length);
  let mismatch = -1;
  for (let i = 0; i < reference.length; i++) {
    if (actual[i] !== reference[i]) { mismatch = i; break; }
  }
  expect(mismatch, `${what} first mismatching index`).toBe(-1);
}

// Two frontier regimes (AGENTS §5): "large" = a reductions-ON frontier of ~all leaves (fit view,
// everything expanded — LOD not allowed to shrink the set); "small" = the default expandPx sweep
// (fit → deep zoom-in), the everyday navigation shape.
const REGIMES: { name: string; expandPx: number; kOf: (baseK: number, i: number) => number }[] = [
  { name: "large", expandPx: 1e-6, kOf: (baseK, i) => baseK * (1 + i * 0.01) },
  { name: "small", expandPx: 48, kOf: (baseK, i) => baseK * Math.pow(2, i / 4) },
];

function stats(ts: number[]): { median: number; p95: number } {
  const s = [...ts].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

describe("#213 cut + declutterFrontier per-frame cost", () => {
  it("is allocation-free steady-state on the engine scratch, element-identical to fresh calls, within budget", () => {
    const N = 100_000;
    const { tree, centroid, baseK } = seededClusteredTree(N);
    const FRAMES = 16;
    const cutSc = makeCutScratch();
    const dcSc = makeDeclutterFrontierScratch();
    const fadeS = new Float32Array(tree.size);
    const fadeR = new Float32Array(tree.size);
    const cutOpts = (expandPx: number, fadeBand: number, fadeAlpha: Float32Array): CutOptions =>
      ({ expandPx, maxAggregateRadius: 26, fadeBand, fadeAlpha: fadeBand > 0 ? fadeAlpha : undefined });
    const dcOpts = (k: number, fadeBand: number, fadeAlpha: Float32Array): DeclutterOptions =>
      ({ screenSized: false, k, maxAggregateRadius: 26, fadeAlpha: fadeBand > 0 ? fadeAlpha : undefined });

    // 2. Byte-identity + scratch invisibility: sweep both regimes × fade off/on, comparing the
    // scratch-path cut AND declutter outputs (and the written fade alphas) against the PRE-#213
    // implementation (boxed arrays, closure-comparator Array#sort, fresh allocations) — so both the
    // scratch reuse across frames and the radix index sort are proven output-identical to the old code.
    let sawFullLeafFrontier = false;
    for (const regime of REGIMES) {
      for (const fadeBand of [0, 0.3]) {
        for (let i = 0; i < FRAMES; i++) {
          const t = at(centroid, regime.kOf(baseK, i));
          const rawS = cut(tree, t, W, H, cutOpts(regime.expandPx, fadeBand, fadeS), cutSc);
          const outS = declutterFrontier(tree, rawS, t, W, H, dcOpts(t.k, fadeBand, fadeS), dcSc);
          const rawR = referenceCut(tree, t, cutOpts(regime.expandPx, fadeBand, fadeR));
          const outR = referenceDeclutter(tree, rawR, t, dcOpts(t.k, fadeBand, fadeR));
          expectSameU32(rawS, rawR, `${regime.name} fade=${fadeBand} frame=${i} cut`);
          expectSameU32(outS, outR, `${regime.name} fade=${fadeBand} frame=${i} declutter`);
          if (fadeBand > 0) {
            let alphaMismatch = -1;
            for (let j = 0; j < rawS.length; j++) {
              const g = rawS[j]!;
              if (fadeS[g] !== fadeR[g]) { alphaMismatch = g; break; }
            }
            expect(alphaMismatch, `${regime.name} frame=${i} fadeAlpha first mismatching node`).toBe(-1);
          }
          if (rawS.length >= tree.leafCount) sawFullLeafFrontier = true;
        }
      }
    }
    // The large regime really drove a reductions-ON frontier of ALL leaves through the pipeline.
    expect(sawFullLeafFrontier).toBe(true);

    // 1. Deterministic no-alloc signature: the sweep above warmed every buffer to its high-water size —
    // from here on, no scratch buffer is ever reallocated (before #213, every one was per frame).
    const refs = { frontier: cutSc.frontier, stack: cutSc.stack, alpha: cutSc.alpha, px: dcSc.px, py: dcSc.py, pr: dcSc.pr, key: dcSc.key, keyBits: dcSc.keyBits, keyBits2: dcSc.keyBits2, order: dcSc.order, order2: dcSc.order2, counts: dcSc.counts, kept: dcSc.kept, gridHead: dcSc.grid.head, gridNext: dcSc.grid.next, out: dcSc.out };
    // 3. Frame budget over the warm scratch, per regime (scratch path only — the engine call shape).
    for (const regime of REGIMES) {
      for (const fadeBand of [0, 0.3]) {
        let worstMs = 0;
        for (let i = 0; i < FRAMES; i++) {
          const t = at(centroid, regime.kOf(baseK, i));
          const t0 = performance.now();
          const raw = cut(tree, t, W, H, cutOpts(regime.expandPx, fadeBand, fadeS), cutSc);
          const out = declutterFrontier(tree, raw, t, W, H, dcOpts(t.k, fadeBand, fadeS), dcSc);
          worstMs = Math.max(worstMs, performance.now() - t0);
          expect(out.length).toBeGreaterThan(0);
        }
        // ~10× headroom over dev-hardware typical (large ≈ 10-15ms at a 100k-leaf full frontier,
        // small ≈ sub-ms) — catches an order-of-magnitude drop without being flaky.
        expect(worstMs, `${regime.name} fade=${fadeBand} worst frame`).toBeLessThan(regime.name === "large" ? 150 : 25);
      }
    }
    expect(cutSc.frontier).toBe(refs.frontier);
    expect(cutSc.stack).toBe(refs.stack);
    expect(cutSc.alpha).toBe(refs.alpha);
    expect(dcSc.px).toBe(refs.px);
    expect(dcSc.py).toBe(refs.py);
    expect(dcSc.pr).toBe(refs.pr);
    expect(dcSc.key).toBe(refs.key);
    expect(dcSc.keyBits).toBe(refs.keyBits);
    expect(dcSc.keyBits2).toBe(refs.keyBits2);
    expect(dcSc.order).toBe(refs.order);
    expect(dcSc.order2).toBe(refs.order2);
    expect(dcSc.counts).toBe(refs.counts);
    expect(dcSc.kept).toBe(refs.kept);
    expect(dcSc.grid.head).toBe(refs.gridHead);
    expect(dcSc.grid.next).toBe(refs.gridNext);
    expect(dcSc.out).toBe(refs.out);
  }, 120_000);

  (BENCH ? it : it.skip)(
    `bench: cut + declutterFrontier per zoom-frame at ${BENCH_N.toLocaleString()} leaves`,
    () => {
      const { tree, centroid, baseK } = seededClusteredTree(BENCH_N);
      const fadeAlpha = new Float32Array(tree.size);
      const FRAMES = 20;
      const cutSc = makeCutScratch(); // the engine call shape (#213)
      const dcSc = makeDeclutterFrontierScratch();

      for (const regime of REGIMES) {
        for (const fadeBand of [0, 0.3]) {
          let rawF = 0;
          const run = (i: number): number => {
            const t = at(centroid, regime.kOf(baseK, i));
            const raw = cut(tree, t, W, H, { expandPx: regime.expandPx, maxAggregateRadius: 26, fadeBand, fadeAlpha: fadeBand > 0 ? fadeAlpha : undefined }, cutSc);
            rawF = Math.max(rawF, raw.length);
            const frontier = declutterFrontier(tree, raw, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 26, fadeAlpha: fadeBand > 0 ? fadeAlpha : undefined }, dcSc);
            return frontier.length;
          };
          for (let i = 0; i < FRAMES; i++) run(i); // warm up the JIT and the scratch growth
          const gc = (globalThis as { gc?: () => void }).gc;
          gc?.();
          const m0 = process.memoryUsage(); // heapUsed misses typed-array backing stores; arrayBuffers has them
          const ts: number[] = [];
          let maxKept = 0;
          for (let i = 0; i < FRAMES; i++) {
            const t0 = performance.now();
            const kept = run(i);
            ts.push(performance.now() - t0);
            if (kept > maxKept) maxKept = kept;
          }
          const m1 = process.memoryUsage();
          const { median, p95 } = stats(ts);
          const perFrameKB = (a: number, b: number): string => ((b - a) / FRAMES / 1024).toFixed(1);
          const line =
            `${regime.name}  fadeBand=${fadeBand}  tree.size=${tree.size.toLocaleString()}  rawCut=${rawF.toLocaleString()}  kept=${maxKept.toLocaleString()}  ` +
            `median=${median.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  heapDelta=${perFrameKB(m0.heapUsed, m1.heapUsed)}KB/frame  ` +
            `abDelta=${perFrameKB(m0.arrayBuffers, m1.arrayBuffers)}KB/frame${gc ? "" : " (no --expose-gc; rough)"}\n`;
          console.log(line);
          appendFileSync("/tmp/frontier-perf.txt", `[${process.env.BENCH_FRONTIER_LABEL ?? "run"}] ${line}`);
        }
      }
      expect(true).toBe(true);
    },
    600_000,
  );
});
