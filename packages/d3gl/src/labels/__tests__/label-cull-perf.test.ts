import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { cullLabels, labelCullScratch, type LabelBox } from "../cull.js";

/**
 * Per-frame regression guard for #204 (AGENTS.md lifecycle §5): label placement runs on EVERY
 * `setTransform` (`afterTransform` → `refreshLabels`/`refreshDataLabels` → `placeLabels` →
 * `cullLabels`), so its cost must stay **linear in the in-view candidate count** and its buffers
 * must be retained across frames.
 *
 * What it would have caught: the pre-#204 culler kept an array of placed boxes and ran
 * `placed.some(overlaps)` per candidate — O(candidates × placed) — while allocating a wrapper
 * object per candidate for the sort plus a `LabelGeometry` (five objects: four corner tuples) per
 * candidate per frame. On a dense uncapped label set that is quadratic per frame.
 *
 * Both regimes run, because they stress opposite halves of the algorithm and a green result on one
 * does not prove the other (§5's reductions-on / reductions-off pairing, in this path's terms):
 *   - **DENSE** (reductions OFF — every labelled glyph is a candidate, boxes overlap heavily): few
 *     survivors, so the *rejection* path dominates. This is where the quadratic scan explodes.
 *   - **SPREAD** (reductions ON — a decluttered frontier of small, separated labels): the placed set
 *     is as large as the viewport can physically hold (~110k boxes here, from the same ≈1M
 *     candidates), so the *placement* half dominates. This is the regime a grid whose cells are too
 *     coarse — or any linear scan of placed boxes — degenerates in, and it is the large-visible-set
 *     case the core values require to be no more expensive than a reduced one.
 *
 * Signatures asserted (deterministic first; wall-clock is the order-of-magnitude backstop):
 *   1. `scratch.lastTests` — pairwise overlap tests per call — stays under a small constant per
 *      candidate. Quadratic behaviour blows this by orders of magnitude at any N, on any machine.
 *   2. Scratch buffer identity is stable across frames once warm: no per-frame grid/geometry
 *      re-allocation.
 *   3. A generous per-frame wall-clock ceiling in both regimes.
 *
 * N is 200k in the normal suite; the ≈1M leg is env-gated (it holds N label objects, ~0.3 GB):
 *   BENCH_LABEL_CULL=1 npx vitest run packages/d3gl/src/labels/__tests__/label-cull-perf.test.ts --no-file-parallelism
 */
const BENCH = !!process.env.BENCH_LABEL_CULL;
const BENCH_N = Number(process.env.BENCH_LABEL_CULL_N) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
const N = BENCH ? BENCH_N : 200_000;
const W = 1280;
const H = 800;
/** Overlap tests per candidate. Measured (M-series laptop, both N-independent — that is the point):
 *  dense 3.52 at 200k / 3.72 at 1M, spread 2.30 at 200k / 1.87 at 1M. The ceiling is ~5× that. The
 *  quadratic scan this replaces runs `placed` tests per candidate — 875 at 200k, i.e. 175M tests. */
const MAX_TESTS_PER_CANDIDATE = 20;
/** Wall-clock ceilings (ms per placement pass), split into a constant and an N-linear term per
 *  AGENTS §Perf-guard. Measured best-of-3: dense 64ms / spread 77ms at 200k, 490ms / 564ms at 1M —
 *  so ~0.5µs per candidate plus a fixed radix/grid cost. Ceilings are ~4× the 200k measurement and
 *  ~2.5× the 1M one. */
const DENSE_MS = Number(process.env.PERF_LABEL_CULL_DENSE_MS) || 40 + 240 * (N / 200_000);
const SPREAD_MS = Number(process.env.PERF_LABEL_CULL_SPREAD_MS) || 40 + 280 * (N / 200_000);

/** Deterministic PRNG so both regimes are reproducible across runs and machines. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** DENSE: full-size labels (a realistic 11px row box, 30-90px wide) over the whole viewport — the
 *  uncapped "label every visible node" set, where almost everything collides. */
function denseField(n: number): LabelBox[] {
  const r = rng(11);
  const out: LabelBox[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      id: i,
      x: r() * W,
      y: r() * H,
      width: 30 + r() * 60,
      height: 14,
      priority: r(),
      textAnchor: "middle",
      baseline: "middle",
    };
  }
  return out;
}

/** SPREAD: small boxes on a jittered lattice, so the placed set saturates the viewport instead of
 *  collapsing to a handful — the large *visible* set (a decluttered ≈1M-glyph frontier must cost no
 *  more than a non-reduced one). */
function spreadField(n: number): LabelBox[] {
  const r = rng(23);
  const cols = Math.ceil(Math.sqrt(n));
  const out: LabelBox[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = (i - col) / cols;
    out[i] = {
      id: i,
      // A lattice finer than the viewport: most anchors are in view, all boxes are tiny, so the
      // placed set stays ≈ the candidate set.
      x: ((col * 3) % W) + r() * 0.5,
      y: ((row * 3) % H) + r() * 0.5,
      width: 2,
      height: 2,
      priority: r(),
      textAnchor: "middle",
      baseline: "middle",
    };
  }
  return out;
}

/** Best-of-3 wall clock for one placement pass (the per-frame unit). */
function timePass(field: readonly LabelBox[], scratch: ReturnType<typeof labelCullScratch>): { ms: number; placed: number } {
  let best = Infinity;
  let placed = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const out = cullLabels(field, { viewport: { width: W, height: H }, scratch });
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
    placed = out.length;
  }
  return { ms: best, placed };
}

function report(label: string, ms: number, scratch: ReturnType<typeof labelCullScratch>): void {
  const line = `${process.env.BENCH_LABEL_CULL_LABEL ?? "label-cull"} ${label} n=${N} ms=${ms.toFixed(1)} placed=${scratch.lastPlaced} tests=${scratch.lastTests} tests/cand=${(scratch.lastTests / Math.max(1, scratch.lastCandidates)).toFixed(2)}`;
  if (BENCH) appendFileSync("/tmp/label-cull-perf.txt", `${line}\n`);
  console.log(line);
}

describe(`cullLabels per-frame cost (n=${N})`, () => {
  it("DENSE field: linear overlap tests, retained buffers, and a real frame budget", () => {
    const field = denseField(N);
    const scratch = labelCullScratch();
    // Warm-up allocates the grid + placement buffers; the frames after it must reuse them.
    cullLabels(field, { viewport: { width: W, height: H }, scratch });
    const order = scratch.order;
    const head = scratch.head;
    const boxes = scratch.boxes;
    const { ms, placed } = timePass(field, scratch);
    report("dense", ms, scratch);

    expect(scratch.lastCandidates).toBeGreaterThan(N * 0.9); // non-vacuous: they really are in view
    expect(placed).toBeLessThan(N / 10); // …and the field really is collision-dominated
    expect(placed).toBeGreaterThan(0);
    // 1. Linear, not quadratic.
    expect(scratch.lastTests).toBeLessThan(scratch.lastCandidates * MAX_TESTS_PER_CANDIDATE);
    // 2. Steady-state buffer identity: nothing re-allocated per frame.
    expect(scratch.order).toBe(order);
    expect(scratch.head).toBe(head);
    expect(scratch.boxes).toBe(boxes);
    // 3. Frame budget (wall-clock ceilings only assert in the single-threaded perf tier / locally).
    if (ASSERT || !BENCH) expect(ms).toBeLessThan(DENSE_MS);
  });

  it("SPREAD field: a nearly all-placed visible set stays linear too", () => {
    const field = spreadField(N);
    const scratch = labelCullScratch();
    cullLabels(field, { viewport: { width: W, height: H }, scratch });
    const head = scratch.head;
    const boxes = scratch.boxes;
    const { ms, placed } = timePass(field, scratch);
    report("spread", ms, scratch);

    // Non-vacuous in the opposite direction: the placed set is as large as the VIEWPORT can hold —
    // ~110k boxes here — so this leg really does exercise the "many placed boxes" half the dense leg
    // cannot. (A 1280×800 viewport physically cannot hold 1M non-overlapping boxes, so the bound is
    // the screen, not the candidate count: that IS the large-visible-set case.)
    expect(placed).toBeGreaterThan(Math.min(scratch.lastCandidates * 0.4, 50_000));
    expect(scratch.lastTests).toBeLessThan(scratch.lastCandidates * MAX_TESTS_PER_CANDIDATE);
    expect(scratch.head).toBe(head);
    expect(scratch.boxes).toBe(boxes);
    if (ASSERT || !BENCH) expect(ms).toBeLessThan(SPREAD_MS);
  });
});
