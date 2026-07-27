import { describe, it, expect } from "vitest";
import { declutterPointsStrategy } from "../points-lane.js";

/**
 * Per-frame regression guard for the declutter points-lane `select()` (#217, AGENTS.md step 5).
 *
 * `select` runs on EVERY zoom/pan frame of a plot/geo instanced points layer. It used to allocate a
 * fresh `Uint32Array(count)` per frame as the visible set — with `count` approaching n when zoomed in
 * (off-screen centres are always kept), that was up to ~4 MB of GC churn per frame at 1M points. The
 * fix reuses a lazily-grown strategy-owned scratch and returns a `subarray(0, count)` view, valid only
 * until the next `select` (the single-frame contract documented on `SelectionStrategy.select`).
 *
 * Asserts, over a 1M-point zoom sweep that exercises BOTH regimes — declutter compacting hard
 * (kept ≪ n, zoomed out) and kept ≈ n (zoomed in, most centres off-screen so the reduction can't
 * shrink the set):
 *   1. **Signature — allocation-free steady state:** once the scratch has grown, every subsequent
 *      select returns a view over the SAME backing ArrayBuffer (`out.buffer === prev.buffer`).
 *   2. **Determinism under reuse:** re-selecting an earlier transform reproduces the exact visible
 *      set snapshotted before the buffer was overwritten by other frames.
 *   3. **Frame budget:** median ms/frame stays under a generous ceiling (≈10× local headroom) —
 *      catches an order-of-magnitude drop without flakiness. Empirical numbers: the env-gated
 *      `points-lane-perf.bench.test.ts`.
 */
const N = 1_000_000;
const W = 1280;
const H = 800;
const FRAMES = 24;

function makeStrategy(): ReturnType<typeof declutterPointsStrategy> {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const centers = new Float32Array(N * 2);
  for (let i = 0; i < N * 2; i++) centers[i] = rng() * 2000;
  const radii = new Float32Array(N).fill(4);
  return declutterPointsStrategy(N, centers, radii, 12, undefined, W, H, false);
}

// Zoom sweep 1×→64× (geometric), centred on the data box.
const baseK = Math.min(W, H) / 2000;
function transform(f: number): { k: number; x: number; y: number } {
  const k = baseK * Math.pow(64, f / (FRAMES - 1));
  return { k, x: W / 2 - 1000 * k, y: H / 2 - 1000 * k };
}

describe("declutterPointsStrategy select() scratch reuse (#217)", () => {
  it("is allocation-free steady-state, deterministic under reuse, and within frame budget at 1M points", () => {
    const strat = makeStrategy();

    // Warm sweep: JIT + grows the kept scratch to its high-water mark (the zoomed-in kept ≈ n frame).
    let minKept = Infinity;
    let maxKept = 0;
    for (let f = 0; f < FRAMES; f++) {
      const vis = strat.select(transform(f), W, H);
      if (vis.length < minKept) minKept = vis.length;
      if (vis.length > maxKept) maxKept = vis.length;
    }
    // Both regimes were actually exercised: hard compaction AND a kept set the reduction can't shrink.
    expect(minKept).toBeLessThan(N / 100); // zoomed out: declutter compacts (kept ≪ n)
    expect(maxKept).toBeGreaterThan(N * 0.9); // zoomed in: kept ≈ n (off-screen centres always kept)

    // Snapshot one zoomed-out frame's visible set (copied immediately, per the single-frame contract).
    const snapshotFrame = 0;
    const snapshot = Array.from(strat.select(transform(snapshotFrame), W, H));

    // 1. Signature: once grown, every select returns a view over the SAME backing ArrayBuffer.
    // 3. Frame budget: median over the sweep under a generous ceiling.
    const buf = strat.select(transform(0), W, H).buffer;
    const ts: number[] = [];
    for (let f = 0; f < FRAMES; f++) {
      const t0 = performance.now();
      const vis = strat.select(transform(f), W, H);
      ts.push(performance.now() - t0);
      expect(vis.buffer).toBe(buf); // reused scratch — no per-frame index-array allocation
      expect(vis.byteOffset).toBe(0);
    }
    ts.sort((a, b) => a - b);
    expect(ts[Math.floor(FRAMES / 2)]!).toBeLessThan(250); // median ms/frame (≈21ms local; 10× headroom)

    // 2. Determinism: re-selecting the snapshotted transform reproduces the exact visible set,
    // even though every other frame overwrote the same backing buffer in between.
    expect(Array.from(strat.select(transform(snapshotFrame), W, H))).toEqual(snapshot);
  });
});
