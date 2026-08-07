import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { HitIndex } from "./hit-test.js";
import type { DrawableVector } from "./scene.js";

const OUT = "/tmp/hit-test-bench.txt";

// Bench: per-pick latency of HitIndex.pick at large N (#216). pick() runs on EVERY
// pointermove, so this is the hover/tooltip/click latency a user feels on a large
// full-detail layer. Writes median/p95 per pick to /tmp/hit-test-bench.txt — and, since
// #258, gates on what it measures instead of only reporting it.
//
// SKIPPED in the regular suite (it allocates ~1M drawables and adds wall-time).
// Run it deliberately:
//   rm -f /tmp/hit-test-bench.txt
//   BENCH_HIT=1 npx vitest run packages/d3gl/src/core/hit-test.bench.test.ts --no-file-parallelism
//   cat /tmp/hit-test-bench.txt
const RUN = !!process.env.BENCH_HIT;
// Honour the tier's scale convention (#258): scripts/run-perf-tier.mjs sets BENCH_<NAME>_N to
// $PERF_N. This used to hard-code 1M and ignore it.
const N = Number(process.env.BENCH_HIT_N) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
// The signature that matters: the grid visits a small neighbourhood per pick, never the layer.
// Measured 2-3 tested/pick at 1M; a regression to the pre-#216 linear scan is N per pick, so any
// bound far below N catches it while leaving room for a denser fixture.
const MAX_TESTED_PER_PICK = Number(process.env.PERF_HIT_TESTED_PER_PICK) || 2000;
// Calibration at 1M on an M-series laptop: medians 0.0002-0.0030 ms/pick (pre-grid was ~13 ms).
const PICK_MS = Number(process.env.PERF_HIT_PICK_MS) || 0.5;

/** Deterministic LCG so BEFORE/AFTER runs see the identical fixture. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const STYLE = {
  fill: [0, 0, 0, 1] as [number, number, number, number],
  stroke: [0, 0, 0, 1] as [number, number, number, number],
  lineJoin: "bevel" as const,
  miterLimit: 4,
  lineCap: "butt" as const,
};

/** N drawables over a WORLD×WORLD extent: 70% circles (r 0.5–3), 30% small closed
 *  rect polygons (1–8 units) — realistic bbox mix for a geo/plot layer. */
function makeDrawables(n: number, world: number, rnd: () => number): DrawableVector[] {
  const out: DrawableVector[] = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * world;
    const y = rnd() * world;
    if (rnd() < 0.7) {
      out.push({
        id: i, subpaths: [], lineWidth: 0, flags: 1,
        circles: [{ x, y, r: 0.5 + rnd() * 2.5 }], anchor: [x, y], ...STYLE,
      });
    } else {
      const w = 1 + rnd() * 7, h = 1 + rnd() * 7;
      out.push({
        id: i,
        subpaths: [{ points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true }],
        lineWidth: 1, flags: 1, circles: [], anchor: null, ...STYLE,
      });
    }
  }
  return out;
}

interface SweepStats { medianMs: number; p95Ms: number; hits: number; picks: number; tested: number }

/** ≥`steps` picks along a diagonal; per-pick wall time via hrtime (ns resolution). */
function sweep(idx: HitIndex, x0: number, y0: number, x1: number, y1: number, steps: number,
  t = { k: 1, x: 0, y: 0 }): SweepStats {
  const times: number[] = [];
  let hits = 0;
  const testedBefore = idx.testedEntries;
  for (let i = 0; i < steps; i++) {
    const f = i / (steps - 1);
    const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
    const a = process.hrtime.bigint();
    const id = idx.pick(x, y, t);
    const b = process.hrtime.bigint();
    times.push(Number(b - a) / 1e6);
    if (id != null) hits++;
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
    hits,
    picks: steps,
    tested: idx.testedEntries - testedBefore,
  };
}

function report(label: string, s: SweepStats) {
  const testedPerPick = s.tested / s.picks;
  // Deterministic signature — contention-immune, so it asserts on every bench run.
  expect(testedPerPick, `${label}: ${testedPerPick.toFixed(1)} tested/pick — the grid is scanning, not indexing`).toBeLessThan(MAX_TESTED_PER_PICK);
  if (ASSERT) {
    expect(s.medianMs, `${label}: median ${s.medianMs.toFixed(4)}ms/pick exceeds ${PICK_MS}ms`).toBeLessThan(PICK_MS);
  }
  appendFileSync(
    OUT,
    `${label.padEnd(34)} median ${s.medianMs.toFixed(4).padStart(9)} ms  ` +
      `p95 ${s.p95Ms.toFixed(4).padStart(9)} ms  (${s.hits}/${s.picks} hits, ` +
      `${Math.round(s.tested / s.picks)} tested/pick)\n`,
  );
}

describe.skipIf(!RUN)("HitIndex.pick bench (#216)", () => {
  const WORLD = 16_384; // ~0.004 drawables/unit² → the diagonal sweep mixes hits and misses

  it("hover sweep at 1M drawables — world mode", { timeout: 300_000 }, () => {
    const drawables = makeDrawables(N, WORLD, lcg(42));
    const idx = new HitIndex(drawables);
    sweep(idx, 0, 0, WORLD, WORLD, 20); // warm-up
    report(`world hit/miss mix N=${N}`, sweep(idx, 0, 0, WORLD, WORLD, 400));
    // All-miss sweep outside the data extent: the linear scan's worst case (never early-outs).
    report(`world all-miss N=${N}`, sweep(idx, -2 * WORLD, -2 * WORLD, -WORLD, -WORLD, 200));
  });

  it("hover sweep at 1M drawables — screen mode", { timeout: 300_000 }, () => {
    const drawables = makeDrawables(N, WORLD, lcg(42));
    const idx = new HitIndex(drawables, 1, true);
    const t = { k: 2, x: -WORLD / 2, y: -WORLD / 2 };
    sweep(idx, 0, 0, WORLD, WORLD, 20, t); // warm-up
    report(`screen hit/miss mix N=${N}`, sweep(idx, 0, 0, WORLD, WORLD, 400, t));
  });
});
