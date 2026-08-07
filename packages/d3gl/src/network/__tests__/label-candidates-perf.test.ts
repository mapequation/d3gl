import { describe, it, expect } from "vitest";
import { visibleWorldRect, type LODTransform } from "../lod.js";
import {
  buildCandidateGrid,
  gatherCandidates,
  gridCandidates,
  scanCandidates,
  descendingByKey,
  CandidateList,
  type CandidateSource,
  type WorldRect,
} from "../label-candidates.js";

/**
 * Per-frame regression guard for #212 (AGENTS.md lifecycle §5): the no-LOD label branch of
 * `refreshLabels` used to scan ALL `nodeCount` positions (plus a full comparator sort when capped)
 * on EVERY pan/zoom frame. The gather now lives in `label-candidates.ts`; `network.ts` marks the
 * source stale from `rebuild()` / `scheduleLayoutRepaint()` (every position-mutating repaint) and
 * otherwise queries a coarse uniform grid built at most once per position change. This test:
 *
 *   1. **Output equality** — the grid path (any zoom, capped or not, custom importance or not,
 *      null labels skipped) selects the *identical* label id sequence as the replaced scan +
 *      stable full sort, on randomized fixtures.
 *   2. **Deterministic signature** — while stale the gather scans (streaming keeps the old cost,
 *      no index work); once settled the grid is built exactly ONCE (identity-stable across a pan
 *      sweep — no per-frame rebuild) and the touched-node counter stays ≪ N for a zoomed-in view.
 *   3. **Frame budget** — a 24-frame settled pan/zoom sweep at 100k nodes stays under a generous
 *      wall-clock ceiling (order-of-magnitude drops fail; machine noise doesn't).
 *
 * N is held at 100k for the normal suite; the 1M empirical BEFORE/AFTER timing is env-gated
 * (`BENCH_LABEL_CANDIDATES=1`), methodology as in the #210 super-edges bench.
 */
const W = 1280;
const H = 800;
// The at-scale leg gates rather than only reporting (#258). Signatures assert whenever the bench
// runs; wall-clock only under PERF_ASSERT (the single-threaded CI tier), per lod-perf.bench.test.ts.
// Calibration at 1M on an M-series laptop: settled medians 0.5-7.2ms across the four regimes.
const ASSERT = !!process.env.PERF_ASSERT;
const FRAME_MS = Number(process.env.PERF_LABEL_CANDIDATES_MS) || 80;
const ALLOC_KB_PER_FRAME = Number(process.env.PERF_LABEL_CANDIDATES_ALLOC_KB) || 64;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

interface Fixture {
  positions: Float32Array;
  strength: Float32Array;
  nodeCount: number;
  baseK: number;
  cx: number;
  cy: number;
}

/** Clustered positions in a ~2000×2000 world (mimics a settled force layout) + quantized strengths
 *  so importance TIES are common — the tiebreak (stable sort ↔ heap id-ascending) is exercised. */
function makeFixture(n: number, seed: number): Fixture {
  const rng = makeRng(seed);
  const positions = new Float32Array(2 * n);
  const strength = new Float32Array(n);
  const clusters = 40;
  const centers: number[] = [];
  for (let c = 0; c < clusters; c++) centers.push(rng() * 2000, rng() * 2000);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(rng() * clusters);
    positions[2 * i] = centers[2 * c]! + (rng() - 0.5) * 300;
    positions[2 * i + 1] = centers[2 * c + 1]! + (rng() - 0.5) * 300;
    strength[i] = Math.floor(rng() * 8); // few distinct values → many ties
  }
  const baseK = 0.9 * Math.min(W / 2000, H / 2000);
  return { positions, strength, nodeCount: n, baseK, cx: 1000, cy: 1000 };
}

function transformAt(f: Fixture, k: number, cx: number, cy: number): LODTransform {
  return { k, x: W / 2 - cx * k, y: H / 2 - cy * k };
}

type LabelOf = (id: number) => string | null;
type ImpOf = ((id: number) => number) | undefined;

/** The REPLACED algorithm, verbatim (network.ts pre-#212): boxed candidate array from a full scan,
 *  full stable comparator sort when capped, then the skip-null selection loop. The equality
 *  reference and the BEFORE side of the bench. */
function referenceSelect(f: Fixture, rect: WorldRect, max: number, impOf: ImpOf, labelOf: LabelOf): number[] {
  const pos = f.positions;
  const strength = f.strength;
  const inView = (x: number, y: number): boolean => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
  const cand: number[] = [];
  for (let i = 0; i < f.nodeCount; i++) if (inView(pos[2 * i]!, pos[2 * i + 1]!)) cand.push(i);
  if (cand.length > max) cand.sort((a, b) => (impOf ? impOf(b) - impOf(a) : strength[b]! - strength[a]!));
  const chosen: number[] = [];
  for (const id of cand) {
    if (!labelOf(id)) continue;
    chosen.push(id);
    if (chosen.length >= max) break;
  }
  return chosen;
}

/** The NEW algorithm, exactly as network.ts drives it: gatherCandidates (scan-when-stale / grid
 *  otherwise), heap top-`max` when capped, ascending order restored when not. */
function newSelect(src: CandidateSource, list: CandidateList, f: Fixture, rect: WorldRect, max: number, impOf: ImpOf, labelOf: LabelOf): number[] {
  const strength = f.strength;
  const ascending = gatherCandidates(src, f.positions, f.nodeCount, rect, list);
  const chosen: number[] = [];
  if (list.length > max) {
    const ids = list.ids;
    const keys = list.keysFor(list.length);
    if (impOf) for (let i = 0; i < list.length; i++) keys[i] = impOf(ids[i]!);
    else for (let i = 0; i < list.length; i++) keys[i] = strength[ids[i]!]!;
    const next = descendingByKey(ids, keys, list.length);
    for (let id = next(); id >= 0; id = next()) {
      if (!labelOf(id)) continue;
      chosen.push(id);
      if (chosen.length >= max) break;
    }
  } else {
    if (!ascending) list.sortAscending();
    for (let i = 0; i < list.length; i++) {
      const id = list.ids[i]!;
      if (!labelOf(id)) continue;
      chosen.push(id);
    }
  }
  return chosen;
}

describe("#212 no-LOD label candidates", () => {
  const N = 100_000;
  const fixture = makeFixture(N, 42);

  it("grid path output equals the reference scan across randomized viewports, caps, and importance", () => {
    const rng = makeRng(7);
    const labelOf: LabelOf = (id) => (id % 7 === 0 ? null : `n${id}`); // ~14% unlabelled → skip-past-cap exercised
    const impOf = (id: number): number => fixture.strength[id]! % 3; // quantized custom importance (more ties)
    const src: CandidateSource = { grid: null, stale: false };
    const list = new CandidateList();

    const zooms = [0.5, 1, 2, 4, 8, 16, 64];
    for (const mul of zooms) {
      for (let rep = 0; rep < 3; rep++) {
        const k = fixture.baseK * mul;
        const cx = rng() * 2000;
        const cy = rng() * 2000;
        const rect = visibleWorldRect(transformAt(fixture, k, cx, cy), W, H);
        for (const max of [Infinity, 50, 5]) {
          for (const imp of [undefined, impOf]) {
            const want = referenceSelect(fixture, rect, max, imp, labelOf);
            // Grid path (settled): identical sequence.
            const gotGrid = newSelect(src, list, fixture, rect, max, imp, labelOf);
            expect(gotGrid).toEqual(want);
            expect(list.lastPath).toBe("grid");
            // Stale path (streaming/drag): also identical.
            const staleSrc: CandidateSource = { grid: src.grid, stale: true };
            const gotScan = newSelect(staleSrc, list, fixture, rect, max, imp, labelOf);
            expect(gotScan).toEqual(want);
            expect(list.lastPath).toBe("scan");
          }
        }
      }
    }
  });

  it("handles degenerate inputs identically to the scan", () => {
    const rect: WorldRect = { minX: -10, maxX: 10, minY: -10, maxY: 10 };
    const list = new CandidateList();
    const ref = new CandidateList();

    // Empty graph.
    let grid = buildCandidateGrid(new Float32Array(0), 0);
    gridCandidates(grid, rect, list);
    expect(list.length).toBe(0);

    // All-coincident positions (degenerate bbox), in and out of view.
    const coincident = new Float32Array([5, 5, 5, 5, 5, 5]);
    grid = buildCandidateGrid(coincident, 3);
    gridCandidates(grid, rect, list);
    list.sortAscending();
    scanCandidates(coincident, 3, rect, ref);
    expect([...list.ids.subarray(0, list.length)]).toEqual([...ref.ids.subarray(0, ref.length)]);
    gridCandidates(grid, { minX: 100, maxX: 200, minY: 100, maxY: 200 }, list); // rect fully outside
    expect(list.length).toBe(0);

    // NaN positions are excluded by both paths (never pass the closed in-view test).
    const withNaN = new Float32Array([0, 0, NaN, NaN, 3, 3, NaN, 7]);
    grid = buildCandidateGrid(withNaN, 4);
    gridCandidates(grid, rect, list);
    list.sortAscending();
    scanCandidates(withNaN, 4, rect, ref);
    expect([...list.ids.subarray(0, list.length)]).toEqual([...ref.ids.subarray(0, ref.length)]);
    expect([...ref.ids.subarray(0, ref.length)]).toEqual([0, 2]);
  });

  it("scans while stale, builds the grid ONCE when settled, then touches ≪ N per frame", () => {
    const src: CandidateSource = { grid: null, stale: true };
    const list = new CandidateList();
    // Zoomed-in viewport: 8× base zoom → ~1/64 of the world area in view.
    const rect = visibleWorldRect(transformAt(fixture, fixture.baseK * 8, fixture.cx, fixture.cy), W, H);

    // Streaming frame (stale): plain scan, NO grid work — the deterministic streaming signature.
    gatherCandidates(src, fixture.positions, fixture.nodeCount, rect, list);
    expect(list.lastPath).toBe("scan");
    expect(src.grid).toBeNull();

    // First settled refresh: builds the grid exactly once…
    gatherCandidates(src, fixture.positions, fixture.nodeCount, rect, list);
    const builtGrid = src.grid;
    expect(builtGrid).not.toBeNull();
    expect(list.lastPath).toBe("grid");

    // …then a 24-frame pan sweep NEVER rebuilds it (identity-stable) and each frame's
    // touched-node counter stays a small fraction of N (O(visible), not O(nodeCount)).
    const rng = makeRng(3);
    let maxTested = 0;
    for (let frame = 0; frame < 24; frame++) {
      const cx = fixture.cx + (rng() - 0.5) * 400;
      const cy = fixture.cy + (rng() - 0.5) * 400;
      const r = visibleWorldRect(transformAt(fixture, fixture.baseK * 8, cx, cy), W, H);
      gatherCandidates(src, fixture.positions, fixture.nodeCount, r, list);
      expect(src.grid).toBe(builtGrid); // no per-frame index rebuild
      expect(list.lastPath).toBe("grid");
      maxTested = Math.max(maxTested, list.lastTested);
    }
    expect(maxTested).toBeLessThan(N / 10); // ~1/64 of the area in view; generous 10× headroom
  });

  it("holds a frame budget over a settled pan/zoom sweep at 100k", () => {
    const src: CandidateSource = { grid: null, stale: false };
    const list = new CandidateList();
    const labelOf: LabelOf = (id) => `n${id}`;
    const rng = makeRng(11);
    let worstMs = 0;
    for (let frame = 0; frame < 24; frame++) {
      const mul = [1, 2, 4, 8, 16, 32][frame % 6]!;
      const cx = fixture.cx + (rng() - 0.5) * 600;
      const cy = fixture.cy + (rng() - 0.5) * 600;
      const rect = visibleWorldRect(transformAt(fixture, fixture.baseK * mul, cx, cy), W, H);
      let best = Infinity;
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        newSelect(src, list, fixture, rect, 50, undefined, labelOf);
        newSelect(src, list, fixture, rect, Infinity, undefined, labelOf);
        best = Math.min(best, performance.now() - t0);
      }
      worstMs = Math.max(worstMs, best);
    }
    // Both the capped and uncapped selection per frame: generous ceiling (~10× typical headroom),
    // tight enough to catch an O(N)-per-frame or full-sort regression at 100k.
    expect(worstMs).toBeLessThan(50);
  });

  // Empirical BEFORE/AFTER at 1M — env-gated; prints the PR's table. Methodology as the #210
  // bench: warm sweep, gc(), then timed frames with process.memoryUsage() deltas per frame.
  it.runIf(process.env.BENCH_LABEL_CANDIDATES)("bench: at-scale 24-frame settled pan sweep", () => {
    // Honour the tier's scale convention (#258): scripts/run-perf-tier.mjs sets
    // BENCH_<NAME>_N to $PERF_N. This used to hard-code 1M and silently ignore it, so PERF_N
    // couldn't shrink the run and the CI tier wasn't measuring the scale it thought it was.
    const M = Number(process.env.BENCH_LABEL_CANDIDATES_N) || 1_000_000;
    const f = makeFixture(M, 1234);
    const labelOf: LabelOf = (id) => (id % 7 === 0 ? null : `n${id}`);
    const gc = globalThis.gc;
    const makeFrames = (muls: number[], seed: number): WorldRect[] => {
      const rng0 = makeRng(seed);
      const out: WorldRect[] = [];
      for (let i = 0; i < 24; i++) {
        const mul = muls[i % muls.length]!;
        out.push(visibleWorldRect(transformAt(f, f.baseK * mul, f.cx + (rng0() - 0.5) * 800, f.cy + (rng0() - 0.5) * 800), W, H));
      }
      return out;
    };

    let frames: WorldRect[] = [];
    const run = (name: string, fn: (rect: WorldRect) => number[]): { median: number; bufKB: number } => {
      for (const rect of frames) fn(rect); // warm
      gc?.();
      const m0 = process.memoryUsage();
      const times: number[] = [];
      for (const rect of frames) {
        const t0 = performance.now();
        fn(rect);
        times.push(performance.now() - t0);
      }
      const m1 = process.memoryUsage();
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)]!;
      const p95 = times[Math.floor(times.length * 0.95)]!;
      const heapKB = (m1.heapUsed - m0.heapUsed) / 1024 / frames.length;
      const bufKB = (m1.arrayBuffers - m0.arrayBuffers) / 1024 / frames.length;
      // eslint-disable-next-line no-console
      console.log(`${name}: median ${median.toFixed(3)} ms/frame, p95 ${p95.toFixed(3)} ms/frame, heapUsed ${heapKB.toFixed(0)} KB/frame, arrayBuffers ${bufKB.toFixed(0)} KB/frame`);
      return { median, bufKB };
    };

    for (const [muls, sweepName] of [[[2, 4, 8], "mixed 2-8x"], [[8, 12, 16], "zoomed-in 8-16x"]] as const) {
      frames = makeFrames([...muls], 5);
      for (const [cap, capName] of [[50, "max=50"], [Infinity, "uncapped"]] as const) {
        // BEFORE: the replaced per-frame scan (+ full sort when capped).
        const before = run(`BEFORE ${sweepName} ${capName}`, (rect) => referenceSelect(f, rect, cap, undefined, labelOf));
        // AFTER (settled): grid built once outside the timed frames, as in steady-state panning.
        const src: CandidateSource = { grid: buildCandidateGrid(f.positions, f.nodeCount), stale: false };
        const list = new CandidateList();
        const settled = run(`AFTER settled ${sweepName} ${capName}`, (rect) => newSelect(src, list, f, rect, cap, undefined, labelOf));
        // AFTER (streaming): stale every frame — must stay at the BEFORE scan's cost, no index work.
        const staleSrc: CandidateSource = { grid: null, stale: true };
        const streaming = run(`AFTER streaming ${sweepName} ${capName}`, (rect) => {
          staleSrc.stale = true;
          return newSelect(staleSrc, list, f, rect, cap, undefined, labelOf);
        });

        // --- signatures (always, whenever the bench runs) -----------------------------------
        // The settled grid path must actually beat the scan it replaced. If the grid ever
        // degraded to a per-frame scan this ratio collapses to ~1 — the regression #212 exists to
        // prevent. Measured ratios at 1M: 6.7× / 1.9× / 20.1× / 7.1× across the four regimes, so
        // 1.3× is comfortably clear of noise while still catching a collapse.
        expect(
          before.median / settled.median,
          `${sweepName} ${capName}: settled grid (${settled.median.toFixed(2)}ms) is not meaningfully faster than the scan (${before.median.toFixed(2)}ms)`,
        ).toBeGreaterThan(1.3);
        // Streaming (grid stale every frame) must not be *worse* than the scan — it falls back to
        // scanning, and must not pay index-rebuild cost on top.
        expect(
          streaming.median,
          `${sweepName} ${capName}: streaming ${streaming.median.toFixed(2)}ms exceeds the scan's ${before.median.toFixed(2)}ms — the stale path is doing index work`,
        ).toBeLessThan(before.median * 2);
        if (gc) {
          expect(settled.bufKB, `${sweepName} ${capName}: settled path grows typed arrays ${settled.bufKB.toFixed(0)}KB/frame`).toBeLessThan(ALLOC_KB_PER_FRAME);
        }
        // --- wall-clock (uncontended runs only) ---------------------------------------------
        if (ASSERT) {
          expect(settled.median, `${sweepName} ${capName}: settled median ${settled.median.toFixed(2)}ms exceeds ${FRAME_MS}ms at N=${M}`).toBeLessThan(FRAME_MS);
        }
      }
    }
    const t0 = performance.now();
    buildCandidateGrid(f.positions, f.nodeCount);
    // eslint-disable-next-line no-console
    console.log(`grid build (once per position change): ${(performance.now() - t0).toFixed(1)} ms at ${M.toLocaleString()}`);
  }, 120_000);
});
