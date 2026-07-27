import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { declutterPointsStrategy } from "../points-lane.js";

// Empirical per-frame harness for the declutter points-lane `select()` (#217): projects n points,
// runs the shared declutter, and compacts the kept indices — the plot/geo instanced-lane hot path
// that runs on EVERY zoom/pan frame. Use it to get before/after ms-per-frame and allocation numbers
// when a change touches this path, instead of reasoning in the abstract.
//
// SKIPPED in the normal suite (1M points, tens of seconds). Run it deliberately:
//   BENCH_POINTS=1 NODE_OPTIONS=--expose-gc npx vitest run \
//     packages/d3gl/src/map/__tests__/points-lane-perf.bench.test.ts --no-file-parallelism
//   BENCH_POINTS=1 BENCH_POINTS_LABEL=after … (default label "run"; results append to /tmp/points-lane-perf.txt)
//
// Allocation methodology + caveats: typed-array backing stores live OUTSIDE the V8 heap, so
// `heapUsed` misses them — we read `process.memoryUsage().arrayBuffers` instead (gc() first so the
// delta isn't polluted by collectable garbage from setup). The delta over the sweep ÷ frames is the
// average bytes allocated per frame that are still live at the end; if minor GC reclaims some
// mid-sweep the figure UNDER-reports true allocation churn, so treat it as a lower bound on
// steady-state pressure (the deterministic buffer-identity guard in points-lane-scratch.test.ts is
// the precise signature; this is the empirical magnitude).
const RUN = !!process.env.BENCH_POINTS;
const N = Number(process.env.BENCH_POINTS_N) || 1_000_000;
const LABEL = process.env.BENCH_POINTS_LABEL ?? "run";
const OUT = "/tmp/points-lane-perf.txt";
// The at-scale leg gates rather than only reporting (#258). Calibration at N=500k on an M-series
// laptop: median 10.4ms (p95 26.4ms), arrayBuffers Δ 0.00MB over the whole sweep.
const ASSERT = !!process.env.PERF_ASSERT;
const FRAME_MS = Number(process.env.PERF_POINTS_FRAME_MS) || 150;
const ALLOC_KB_PER_FRAME = Number(process.env.PERF_POINTS_ALLOC_KB) || 64;
const W = 1280;
const H = 800;
const FRAMES = 24;

function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) {
    g();
    g();
  }
}

describe("points-lane select() per-frame performance (#217)", () => {
  (RUN ? it : it.skip)(
    "zoom sweep at scale: ms/frame + allocation/frame",
    () => {
      // Deterministic uniform scatter in a 2000×2000 world box (LCG), radius 4 — the shape
      // syncPointsLayer feeds the strategy (pre-resolved SoA centers; no accessor calls here).
      let s = 7 >>> 0;
      const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const centers = new Float32Array(N * 2);
      for (let i = 0; i < N * 2; i++) centers[i] = rng() * 2000;
      const radii = new Float32Array(N).fill(4);
      const strat = declutterPointsStrategy(N, centers, radii, 12, undefined, W, H, false);

      // Zoom sweep 1×→64× (geometric), centred on the data. Zoomed out ⇒ declutter compacts hard
      // (kept ≪ n); zoomed in ⇒ most centres are off-screen and off-screen glyphs are always kept,
      // so the kept count approaches n — the worst case for the visible-index compaction.
      const baseK = Math.min(W, H) / 2000;
      const transform = (f: number): { k: number; x: number; y: number } => {
        const k = baseK * Math.pow(64, f / (FRAMES - 1));
        return { k, x: W / 2 - 1000 * k, y: H / 2 - 1000 * k };
      };

      for (let f = 0; f < FRAMES; f++) strat.select(transform(f), W, H); // JIT + scratch warm-up
      gc();
      const bufBefore = process.memoryUsage().arrayBuffers;
      const ts: number[] = [];
      let minKept = Infinity;
      let maxKept = 0;
      for (let f = 0; f < FRAMES; f++) {
        const t0 = performance.now();
        const vis = strat.select(transform(f), W, H);
        ts.push(performance.now() - t0);
        if (vis.length < minKept) minKept = vis.length;
        if (vis.length > maxKept) maxKept = vis.length;
      }
      const bufAfter = process.memoryUsage().arrayBuffers; // read BEFORE gc: live sweep allocations
      ts.sort((a, b) => a - b);
      const median = ts[Math.floor(FRAMES / 2)]!;
      const p95 = ts[Math.floor(FRAMES * 0.95)]!;
      const mean = ts.reduce((a, b) => a + b, 0) / FRAMES;
      const allocPerFrame = (bufAfter - bufBefore) / FRAMES;

      const block =
        `\n=== ${LABEL}  N=${N.toLocaleString()} points  ${FRAMES}-frame zoom sweep 1×→64× (${W}×${H}) ===\n` +
        `kept: ${minKept.toLocaleString()}…${maxKept.toLocaleString()}  ` +
        `median=${median.toFixed(2)}ms  mean=${mean.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  ` +
        `arrayBuffers Δ=${((bufAfter - bufBefore) / 1024 / 1024).toFixed(2)}MB  ` +
        `≈${(allocPerFrame / 1024).toFixed(1)}KB/frame\n`;
      console.log(block);
      appendFileSync(OUT, block);

      // --- signatures (always, whenever the bench runs) --------------------------------------
      // The sweep must actually reach a near-N visible set at its widest — otherwise it is
      // measuring a cheap zoomed-in frame and the at-scale claim is hollow (AGENTS §5).
      expect(maxKept, `widest frame kept only ${maxKept.toLocaleString()} of ${N.toLocaleString()} points`).toBeGreaterThan(N * 0.9);
      // Allocation-free steady state — the #217 scratch-reuse guarantee, at scale.
      expect(allocPerFrame / 1024, `${(allocPerFrame / 1024).toFixed(1)}KB/frame of typed-array growth in select()`).toBeLessThan(ALLOC_KB_PER_FRAME);
      // --- wall-clock (uncontended runs only) ------------------------------------------------
      if (ASSERT) {
        expect(median, `median ${median.toFixed(1)}ms/frame exceeds ${FRAME_MS}ms at N=${N}`).toBeLessThan(FRAME_MS);
      }
    },
    600_000,
  );
});
