/**
 * The streaming layout's fence controller (#352, spec §6.5.3) — node, pure, with fake fences and a fake
 * clock. It sizes the row bands every pass of a tick is cut into (#382) and decides how many work items
 * the GPU transport encodes in one animation frame: at most 33 ms of frames of layout work in flight (2 frames at 60 Hz, 4 at 120 Hz;
 * a miss counts only against the oldest frame in flight), a GPU budget per frame of
 * min(10 ms, 0.6 × the rAF interval), and at most 2 ms of main-thread encode time.
 */
import { describe, expect, it } from "vitest";
import {
  FrameBudget,
  frameBudgetMs,
  framesInFlight,
  itemCostMs,
  stageBands,
  type FenceSource,
  type FenceStatus,
} from "../frame-budget.js";
import { StreamSchedule, type StageCost, type StreamStage } from "../stream-schedule.js";

/** Fences numbered in insertion order; everything up to `signaledThrough` has signalled. */
class FakeFences implements FenceSource<number> {
  inserted = 0;
  signaledThrough = 0;
  lost = false;
  readonly dropped: number[] = [];
  insert(): number {
    return ++this.inserted;
  }
  poll(fence: number): FenceStatus {
    if (this.lost) return "lost";
    return fence <= this.signaledThrough ? "signaled" : "pending";
  }
  drop(fence: number): void {
    this.dropped.push(fence);
  }
  /** The GPU caught up: every fence inserted so far has signalled. */
  catchUp(): void {
    this.signaledThrough = this.inserted;
  }
}

/** A clock the test advances by hand. */
class FakeClock {
  t = 0;
  readonly now = (): number => this.t;
}

interface Rig {
  fences: FakeFences;
  clock: FakeClock;
  budget: FrameBudget<number>;
  /** rAF timestamp of the next frame. */
  now: number;
  /** A flat force pass of `nodes` nodes over `rows` atlas rows (the flat model): what the items are bands of. */
  pass: StageCost;
  /** The next band of {@link pass}, and its band count (fixed at its first band). */
  band: number;
  bands: number;
}

function rig(opts: { nodes?: number; rows?: number; budgetMs?: number; encodeCapMs?: number } = {}): Rig {
  const fences = new FakeFences();
  const clock = new FakeClock();
  const budget = new FrameBudget(fences, clock.now, {
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.encodeCapMs !== undefined ? { encodeCapMs: opts.encodeCapMs } : {}),
  });
  // Default: an 8 ms force pass (200k nodes): 2 bands at a 10 ms budget, which the band growth can cut finer.
  const pass = { costMs: itemCostMs("force", opts.nodes ?? 200_000), fixedMs: 0, rows: opts.rows ?? 448 };
  return { fences, clock, budget, now: 0, pass, band: 0, bands: 1 };
}

/** The bands the rig's force pass would be cut into if it started now. */
function bands(r: Rig): number {
  return r.budget.bandsFor(r.pass.costMs, r.pass.rows);
}

/** A pass of one row: it always runs whole, so no band growth can cut it. */
const WHOLE: StageCost = { costMs: 1, fixedMs: 0, rows: 1 };

/**
 * One animation frame: poll fences, then encode items while the controller admits them (each costs
 * `costMs` of estimated GPU time and `encodeMs` of main thread), then insert the frame's budget fence.
 * `sliceable`: the items are consecutive bands of the rig's pass (else each is a whole one-row pass).
 * Returns the number of items encoded.
 */
function frame(
  r: Rig,
  { costMs = 0.01, encodeMs = 0.01, intervalMs = 1000 / 60, sliceable = true, repainted = false } = {},
): number {
  r.now += intervalMs;
  expect(r.budget.beginFrame(r.now)).toBe("ok");
  let items = 0;
  if (r.budget.open()) {
    while (r.budget.admit(costMs)) {
      r.clock.t += encodeMs;
      if (sliceable) {
        if (r.band === 0) r.bands = bands(r);
        r.budget.spent(costMs, r.pass, r.band, r.bands);
        r.band = (r.band + 1) % r.bands;
      } else {
        r.budget.spent(costMs, WHOLE, 0, 1);
      }
      items++;
    }
  }
  r.budget.endFrame(repainted);
  return items;
}

describe("FrameBudget gate: at most 2 frames of layout work in flight", () => {
  it("encodes in the first two frames of a GPU that never finishes, then nothing", () => {
    const r = rig();
    const encoded = Array.from({ length: 10 }, () => frame(r));
    expect(encoded.slice(0, 2).every((n) => n > 0)).toBe(true);
    expect(encoded.slice(2)).toEqual(Array(8).fill(0));
    expect(r.budget.inFlight).toBe(10); // every frame still inserted its fence
  });

  it("opens frame f only once the fence of frame f−2 has signalled", () => {
    const r = rig();
    frame(r);
    frame(r);
    expect(frame(r)).toBe(0); // frames 1 and 2 pending
    r.fences.signaledThrough = 1; // frame 4: frame 2 (its f−2) is still pending
    expect(frame(r)).toBe(0);
    r.fences.signaledThrough = 2; // frame 5: frame 3 (its f−2) is still pending
    expect(frame(r)).toBe(0);
    r.fences.signaledThrough = 4; // frame 6: only frame 5 (its f−1) is pending
    expect(frame(r)).toBeGreaterThan(0);
  });

  it("drops each fence once it has signalled, in order, and reports the last completed frame", () => {
    const r = rig();
    for (let f = 0; f < 4; f++) frame(r);
    r.fences.signaledThrough = 3;
    frame(r);
    expect(r.fences.dropped).toEqual([1, 2, 3]);
    expect(r.budget.completedFrame).toBe(3);
  });

  it("inserts exactly one budget fence per frame, with or without items", () => {
    const r = rig();
    for (let f = 0; f < 6; f++) {
      const before = r.fences.inserted;
      frame(r);
      expect(r.fences.inserted - before).toBe(1);
      if (f % 2 === 1) r.fences.catchUp();
    }
    // A frame that encodes nothing on purpose (no work) still fences.
    r.now += 16;
    r.budget.beginFrame(r.now);
    r.budget.open();
    const before = r.fences.inserted;
    r.budget.endFrame();
    expect(r.fences.inserted - before).toBe(1);
  });

  it("reports a lost context from any fence poll", () => {
    const r = rig();
    frame(r);
    r.fences.lost = true;
    expect(r.budget.beginFrame(r.now + 16)).toBe("lost");
  });

  it("dispose drops every queued fence, or none when the context is gone", () => {
    const a = rig();
    for (let f = 0; f < 3; f++) frame(a);
    a.budget.dispose(true);
    expect(a.fences.dropped.sort()).toEqual([1, 2, 3]);
    const b = rig();
    for (let f = 0; f < 3; f++) frame(b);
    b.budget.dispose(false);
    expect(b.fences.dropped).toEqual([]);
  });
});

describe("framesInFlight: the gate in time", () => {
  it("is 2 frames at 60 Hz and the same 33 ms at higher rates, never below 2 or above 8", () => {
    expect(framesInFlight(1000 / 60)).toBe(2);
    expect(framesInFlight(1000 / 120)).toBe(4);
    expect(framesInFlight(1000 / 144)).toBe(5);
    expect(framesInFlight(1000 / 30)).toBe(2);
    expect(framesInFlight(1)).toBe(8);
  });

  it("lets 4 frames be in flight at 120 Hz", () => {
    const r = rig();
    const encoded = Array.from({ length: 8 }, () => frame(r, { intervalMs: 1000 / 120 }));
    // The first frame has no interval yet (60 Hz assumed: 2 in flight); from the second, 120 Hz.
    expect(encoded.slice(0, 4).every((n) => n > 0)).toBe(true);
    expect(encoded.slice(4)).toEqual([0, 0, 0, 0]);
  });
});

describe("FrameBudget k: items per frame", () => {
  it("starts at one item and grows by one per frame while k binds and the GPU keeps up", () => {
    const r = rig();
    const encoded: number[] = [];
    for (let f = 0; f < 6; f++) {
      encoded.push(frame(r));
      r.fences.catchUp();
    }
    expect(encoded).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("halves on a miss, holds for 30 frames, then grows again; never below 1", () => {
    const r = rig();
    for (let f = 0; f < 8; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.k).toBe(9); // grew 1 → 9
    // The GPU falls behind: two frames stay pending, the third is blocked (the miss).
    frame(r); // 9 items
    frame(r); // 10 items
    expect(frame(r)).toBe(0);
    expect(r.budget.k).toBe(4); // ⌊9 / 2⌋ — half of what the late frame (the oldest in flight) encoded
    // Still behind for a few more frames: one miss episode halves once.
    frame(r);
    frame(r);
    expect(r.budget.k).toBe(4);
    r.fences.catchUp();
    // The hold: k stays 4 for 30 frames from the miss, then grows by one per frame again.
    const held: number[] = [];
    for (let f = 0; f < 27; f++) {
      held.push(frame(r));
      r.fences.catchUp();
    }
    expect(new Set(held)).toEqual(new Set([4]));
    const grown: number[] = [];
    for (let f = 0; f < 3; f++) {
      grown.push(frame(r));
      r.fences.catchUp();
    }
    expect(grown).toEqual([4, 5, 6]);
  });

  it("a miss on the frame that carried the engine's repaint blocks, but resizes neither k nor the bands", () => {
    const r = rig();
    for (let f = 0; f < 6; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.k).toBe(7);
    frame(r, { repainted: true }); // the late frame: its render queues ahead of its layout items
    frame(r);
    expect(frame(r)).toBe(0); // blocked: two frames in flight, the oldest repainted
    expect(r.budget.k).toBeGreaterThanOrEqual(7);
    expect(r.budget.growth).toBe(1);
    r.fences.catchUp();
    expect(frame(r)).toBeGreaterThanOrEqual(7); // no hold, no halving
  });

  it("a repaint in a newer frame in flight does not excuse the late frame: k halves and holds", () => {
    // The GPU runs work in order, so a repaint queued after the late frame's fence cannot have delayed it.
    const r = rig();
    for (let f = 0; f < 6; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.k).toBe(7);
    frame(r); // the late frame: 7 layout items, no repaint
    frame(r, { repainted: true }); // behind it on the GPU
    expect(frame(r)).toBe(0);
    expect(r.budget.k).toBe(3); // ⌊7 / 2⌋
    r.fences.catchUp();
    const held: number[] = [];
    for (let f = 0; f < 10; f++) {
      held.push(frame(r));
      r.fences.catchUp();
    }
    expect(new Set(held)).toEqual(new Set([3]));
  });

  it("a repaint that completed just before the late frame excuses the miss: its GPU time ran first", () => {
    // Frame 1 repaints and completes, but its render pushed frame 2's layout items late.
    const r = rig();
    for (let f = 0; f < 6; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.k).toBe(7);
    const repaintFence = r.fences.inserted + 1;
    frame(r, { repainted: true });
    frame(r); // the late frame
    r.fences.signaledThrough = repaintFence;
    frame(r); // opens: only the late frame is in flight
    expect(frame(r)).toBe(0); // blocked on the late frame, one frame after the repaint
    expect(r.budget.k).toBeGreaterThanOrEqual(7);
    r.fences.catchUp();
    expect(frame(r)).toBeGreaterThanOrEqual(7); // no hold, no halving
  });

  it("a miss on a frame that encoded no item only blocks", () => {
    // An empty late frame (a blocked one) holds no layout work that k or B could shrink.
    const r = rig();
    for (let f = 0; f < 6; f++) {
      frame(r);
      r.fences.catchUp();
    }
    frame(r); // 7 items
    frame(r); // 8 items
    const emptyFence = r.fences.inserted + 1;
    expect(frame(r)).toBe(0); // miss 1: k = ⌊7 / 2⌋ = 3, and this blocked frame's fence is empty
    expect(r.budget.k).toBe(3);
    r.fences.signaledThrough = emptyFence - 1;
    expect(frame(r)).toBe(3); // opens behind the empty fence
    expect(frame(r)).toBe(0); // blocked again, on the empty frame
    expect(r.budget.k).toBe(3);
  });

  it("keeps k ≥ 1 through repeated misses", () => {
    const r = rig();
    for (let f = 0; f < 200; f++) {
      frame(r);
      if (f % 7 === 6) r.fences.catchUp(); // mostly behind
      expect(r.budget.k).toBeGreaterThanOrEqual(1);
    }
  });

  it("caps the estimated GPU time per frame at the budget, always admitting a first item", () => {
    const r = rig({ budgetMs: 10 });
    for (let f = 0; f < 20; f++) {
      frame(r, { costMs: 4 });
      r.fences.catchUp();
    }
    expect(frame(r, { costMs: 4 })).toBe(2); // 4 + 4 ≤ 10 < 12
    r.fences.catchUp();
    expect(frame(r, { costMs: 25 })).toBe(1); // one item larger than the whole budget still runs
  });

  it("caps the measured main-thread encode time per frame at 2 ms", () => {
    const r = rig({ encodeCapMs: 2 });
    for (let f = 0; f < 30; f++) {
      frame(r, { encodeMs: 0.5 });
      r.fences.catchUp();
    }
    const start = r.clock.t;
    expect(frame(r, { encodeMs: 0.5 })).toBe(4);
    expect(r.clock.t - start).toBeLessThanOrEqual(2);
  });
});

describe("FrameBudget budget: min(budgetMs, 0.6 × median rAF interval)", () => {
  it("is 10 ms at 60 Hz and 30 Hz, 5 ms at 120 Hz", () => {
    for (const [hz, expected] of [[60, 10], [30, 10], [120, 5]] as const) {
      const r = rig();
      for (let f = 0; f < 20; f++) frame(r, { intervalMs: 1000 / hz });
      expect(r.budget.budgetMs).toBeCloseTo(expected, 6);
    }
  });

  it("uses the median, so one long frame does not move it", () => {
    const r = rig();
    for (let f = 0; f < 10; f++) frame(r, { intervalMs: 1000 / 120 });
    frame(r, { intervalMs: 400 });
    expect(r.budget.budgetMs).toBeCloseTo(5, 6);
  });

  it("does not count the idle gap before a resumed run as a frame interval", () => {
    const r = rig();
    for (let f = 0; f < 3; f++) frame(r, { intervalMs: 1000 / 120 });
    r.budget.resume();
    for (let f = 0; f < 3; f++) frame(r, { intervalMs: 1000 / 120 });
    r.budget.resume();
    frame(r, { intervalMs: 60_000 });
    expect(r.budget.budgetMs).toBeCloseTo(5, 6);
  });

  it("assumes 60 Hz before it has seen a frame", () => {
    expect(rig().budget.budgetMs).toBeCloseTo(10, 6);
    expect(frameBudgetMs(10, 1000 / 60)).toBeCloseTo(10, 6);
    expect(frameBudgetMs(10, 1000 / 144)).toBeCloseTo(0.6 * (1000 / 144), 6);
  });
});

describe("stageBands: every pass is cut into bands of at most half the budget (#382)", () => {
  it("cuts a pass into bands of about half the budget, at most its rows", () => {
    // ≈ 40 ns per node for the whole flat force pass (M1 Max): 325k → 13 ms → 3 bands of 5 ms at a 10 ms budget.
    expect(stageBands(itemCostMs("force", 325_729), 10, 571)).toBe(3);
    expect(stageBands(itemCostMs("force", 1_000_000), 10, 1000)).toBe(8);
    expect(stageBands(itemCostMs("force", 1_000), 10, 32)).toBe(1);
    expect(stageBands(itemCostMs("force", 1_000_000), 5, 1000)).toBe(16); // 120 Hz halves the budget
    expect(stageBands(itemCostMs("force", 1_000_000), 10, 4)).toBe(4); // never more bands than rows
    expect(stageBands(1_000, 10, 1_000_000)).toBe(64); // never more than MAX_BANDS
    expect(stageBands(0, 10, 100)).toBe(1);
  });

  it("leaves room for what every band pays whatever its size", () => {
    // 4 ms of divisible work plus 1 ms per band: bands of ≤ 5 ms need ⌈4 / (5 − 1)⌉ = 1 band at 10 ms,
    // ⌈4 / (2.5 − 1)⌉ = 3 at 5 ms (each 1 + 4/3 ≤ 2.5 ms).
    expect(stageBands(4, 10, 100, 1, 1)).toBe(1);
    expect(stageBands(4, 5, 100, 1, 1)).toBe(3);
    for (const [cost, fixed, budget] of [[4, 1, 5], [30, 0.6, 10], [12, 0.2, 5], [0.5, 0.4, 5], [30, 2.5, 10]] as const) {
      const b = stageBands(cost, budget, 1_000, 1, fixed);
      expect(fixed + cost / b, `${cost} + ${fixed}/band at ${budget} ms`).toBeLessThanOrEqual(budget / 2 + 1e-9);
    }
  });

  it("sizes the bands of a pass whose fixed cost is past half a band to the whole budget, one per frame", () => {
    // The nested collision gather at 1M at 120 Hz: ~7 ms of work, and each band waits ~2.1 ms for its longest
    // fragment. Bands of half the budget would be 6 thin ones of 3.3 ms, each alone in its frame; bands of
    // the budget are 3 of 4.4 ms.
    expect(stageBands(7, 5, 1_000, 1, 2.1)).toBe(3);
    for (const [cost, fixed, budget] of [[7, 2.1, 5], [30, 3, 10], [12, 3.7, 5], [55, 7, 10]] as const) {
      const b = stageBands(cost, budget, 1_000, 1, fixed);
      expect(fixed + cost / b, `${cost} + ${fixed}/band at ${budget} ms`).toBeLessThanOrEqual(budget + 1e-9);
    }
    // Past three quarters of the budget no band fits it: bands get half a target of work each.
    expect(stageBands(55, 10, 1_000, 1, 18)).toBe(Math.ceil(55 / 2.5));
  });

  it("switches to bands of the whole budget exactly where a half-budget band would carry more fixed than divisible work", () => {
    // At 5 ms a half-budget band is 2.5 ms: with f ≤ 1.25 ms its divisible part 2.5 − f is at least f.
    // Past that, most of every such band would be the fixed cost paid again, so the bands aim at 5 ms.
    expect(stageBands(9, 5, 1_000, 1, 1.25)).toBe(Math.ceil(9 / 1.25)); // 2.5 − 1.25 = 1.25 of work per band
    expect(stageBands(9, 5, 1_000, 1, 1.26)).toBe(Math.ceil(9 / (5 - 1.26)));
    for (const f of [0, 0.3, 0.9, 1.25]) {
      const b = stageBands(9, 5, 1_000, 1, f);
      // Half-budget bands: each within 2.5 ms, and the fixed cost it repeats at most its divisible work.
      expect(f + 9 / b).toBeLessThanOrEqual(2.5 + 1e-9);
      expect(f).toBeLessThanOrEqual(2.5 - f + 1e-9);
    }
  });

  it("scales the estimate by the band growth, so a pass far below half the budget stays one band", () => {
    expect(stageBands(4, 10, 317, 8)).toBe(7); // ⌈8 · 4 / 5⌉
    expect(stageBands(itemCostMs("force", 325_729), 10, 571, 2)).toBe(6);
    expect(stageBands(0.05, 10, 1_000, 8)).toBe(1); // a 0.05 ms pass: one band however slow the GPU
  });

  it("never lets the growth cut a pass into bands that carry less divisible work than fixed", () => {
    // The nested collision gather at 1M: 9 ms of work, and each band waits ~2.09 ms for its longest
    // fragment. The budget asks for 4 bands at 60 and 120 Hz; a fifth band would carry 1.8 ms of work for
    // 2.09 ms of tail, so no growth adds one (at g = 8 it would be 25 bands, ~61 ms per gather).
    for (const budget of [10, 5]) {
      for (const g of [1, 2, 4, 8]) expect(stageBands(9, budget, 1_000, g, 2.09), `${budget} ms, g = ${g}`).toBe(4);
    }
    // At 325k (2.93 ms of work, 1.48 ms of tail): one band, whatever the growth.
    for (const g of [1, 2, 4, 8]) expect(stageBands(2.93, 5, 1_000, g, 1.48)).toBe(1);
    // A pass whose fixed cost is small keeps growing: the nested repulsion at 1M (6.2 ms, 0.2 ms per band).
    expect(stageBands(6.2, 10, 1_000, 1, 0.2)).toBe(2);
    expect(stageBands(6.2, 10, 1_000, 8, 0.2)).toBe(11);
    // Wherever the growth adds bands, each keeps at least its fixed cost in divisible work (B·f ≤ c); it
    // never takes away the bands the budget itself needs.
    for (const [cost, fixed] of [[9, 2.09], [4, 1], [30, 0.6], [12, 0.2], [0.5, 0.4], [55, 18], [3, 0.7]] as const) {
      for (const budget of [10, 5]) {
        const base = stageBands(cost, budget, 1_000, 1, fixed);
        for (const g of [2, 4, 8]) {
          const b = stageBands(cost, budget, 1_000, g, fixed);
          expect(b).toBeGreaterThanOrEqual(base);
          if (b > base) expect(b * fixed, `${cost} + ${fixed}/band at ${budget} ms, g = ${g}`).toBeLessThanOrEqual(cost + 1e-9);
        }
      }
    }
  });
});

describe("FrameBudget band growth: how far every pass's estimate is scaled when bands still miss", () => {
  it("starts at 1: the bands are the static estimate's", () => {
    const r = rig({ nodes: 325_729, rows: 571 });
    expect(r.budget.growth).toBe(1);
    expect(bands(r)).toBe(3);
    expect(r.budget.bandsFor(4, 317, 0)).toBe(1);
  });

  it("doubles when one item per frame still misses the gate and a sliceable item was late", () => {
    const r = rig({ nodes: 200_000, rows: 448 }); // an 8 ms force pass: 2 bands at growth 1
    expect(bands(r)).toBe(2);
    // A GPU so slow that even one item per frame falls behind: k is driven to 1 by the first miss…
    frame(r);
    frame(r);
    frame(r); // miss 1: k = ⌊2 / 2⌋ = 1
    expect(r.budget.k).toBe(1);
    expect(r.budget.growth).toBe(1);
    r.fences.catchUp();
    frame(r);
    frame(r);
    frame(r); // miss 2 with k = 1 — the band itself is too large
    expect(r.budget.growth).toBe(2);
    expect(bands(r)).toBe(4);
  });

  it("does not grow when the late items could not be cut (passes of one row)", () => {
    const r = rig();
    frame(r, { sliceable: false });
    frame(r, { sliceable: false });
    frame(r, { sliceable: false }); // miss 1
    r.fences.catchUp();
    frame(r, { sliceable: false });
    frame(r, { sliceable: false });
    frame(r, { sliceable: false }); // miss 2 at k = 1, but only whole passes were in flight
    expect(r.budget.k).toBe(1);
    expect(r.budget.growth).toBe(1);
  });

  it("does not grow when only a newer frame in flight held a sliceable item", () => {
    const r = rig();
    frame(r);
    frame(r);
    frame(r); // miss 1: k = 1
    r.fences.catchUp();
    frame(r, { sliceable: false }); // the late frame: a whole pass
    frame(r); // a band, queued behind it
    frame(r); // miss 2 at k = 1
    expect(r.budget.k).toBe(1);
    expect(r.budget.growth).toBe(1);
  });

  it("halves back, with k, once two consecutive bands of the pass have fit a frame 30 times", () => {
    const r = rig();
    frame(r);
    frame(r);
    frame(r);
    r.fences.catchUp();
    frame(r);
    frame(r);
    frame(r);
    expect(r.budget.growth).toBe(2);
    r.fences.catchUp();
    let frames = 0;
    let kBefore = 0;
    while (r.budget.growth === 2 && frames < 200) {
      kBefore = r.budget.k;
      frame(r);
      r.fences.catchUp();
      frames++;
    }
    expect(r.budget.growth).toBe(1);
    // The evidence arrives with the fence poll as the frame begins: k halves there, then grows by one as
    // that frame's items fill it.
    expect(r.budget.k).toBe(Math.max(1, Math.floor(kBefore / 2)) + 1);
    // The hold after the miss (30) + growing k to 2 + 30 frames whose two bands finished in time.
    expect(frames).toBeGreaterThanOrEqual(30);
  });

  it("neither grows nor cuts k when the late frame is one band that cannot be cut finer: no lever shortens it", () => {
    // The nested gather at 1M: 4 bands already carry about as much tail as work each, so more growth would
    // only repeat the tail — and fewer items per frame would only slow every other pass.
    const r = rig();
    for (let f = 0; f < 12; f++) {
      frame(r, { sliceable: false });
      r.fences.catchUp();
    }
    const k = r.budget.k;
    expect(k).toBeGreaterThan(4);
    const gather: StageCost = { costMs: 9, fixedMs: 2.09, rows: 1_000 };
    const gatherFrame = (): void => {
      r.now += 1000 / 60;
      r.budget.beginFrame(r.now);
      if (r.budget.open() && r.budget.admit(4.34)) r.budget.spent(4.34, gather, 0, 4);
      r.budget.endFrame();
    };
    for (let miss = 0; miss < 4; miss++) {
      gatherFrame();
      gatherFrame();
      gatherFrame();
      gatherFrame();
      r.fences.catchUp();
    }
    expect(r.budget.k).toBe(k);
    expect(r.budget.growth).toBe(1);
  });

  it("counts toward halving back only frames that held two consecutive bands of a pass the growth cut finer, on time", () => {
    const r = rig();
    frame(r);
    frame(r);
    frame(r); // miss 1: k = 1
    r.fences.catchUp();
    frame(r);
    frame(r);
    frame(r); // miss 2 at k = 1: growth 2 — the pass now runs in 4 bands where 2 would do at growth 1
    expect(r.budget.growth).toBe(2);
    r.fences.catchUp();
    // Frames of several whole passes each fit, and on time — but say nothing about a band twice the size.
    for (let f = 0; f < 200; f++) {
      frame(r, { sliceable: false });
      r.fences.catchUp();
    }
    expect(r.budget.growth).toBe(2);
    // Frames whose consecutive bands of the pass finish a frame late (every fence signals two frames after
    // its frame: never a miss, since two frames may be in flight) do not count.
    for (let f = 0; f < 200; f++) {
      frame(r);
      r.fences.signaledThrough = r.fences.inserted - 1;
    }
    expect(r.budget.growth).toBe(2);
    // Frames whose consecutive bands finish within the frame do: one band of twice the size fits there too.
    let frames = 0;
    while (r.budget.growth === 2 && frames < 200) {
      frame(r);
      r.fences.catchUp();
      frames++;
    }
    expect(r.budget.growth).toBe(1);
    expect(frames).toBeGreaterThanOrEqual(30);
  });

  it("recovers from a transient stall: the growth returns to 1", () => {
    // A first-use stall (e.g. a shader compile on the first draw) misses the gate over and over at
    // k = 1 and doubles the growth each time; a GPU that then keeps up must bring it back down.
    const r = rig();
    for (let miss = 0; miss < 4; miss++) {
      frame(r);
      frame(r);
      frame(r);
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.growth).toBe(8);
    for (let f = 0; f < 600 && r.budget.growth > 1; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.growth).toBe(1);
  });

  it("grows at most 8×, however often one band misses", () => {
    const r = rig({ nodes: 100_000, rows: 317 }); // a 4 ms force pass: 1 band at 60 Hz
    for (let miss = 0; miss < 12; miss++) {
      frame(r);
      frame(r);
      frame(r);
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.growth).toBe(8);
    expect(bands(r)).toBe(7); // ⌈8 · 4 ms / 5 ms⌉
  });

  it("never halves below 1: the static estimate", () => {
    const r = rig({ nodes: 325_729, rows: 571 });
    for (let f = 0; f < 300; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.growth).toBe(1);
    expect(bands(r)).toBe(3);
  });
});

describe("itemCostMs — the flat layout's static cost model behind the budget", () => {
  it("scales every pass with N", () => {
    expect(itemCostMs("prep", 650_000)).toBeCloseTo(2 * itemCostMs("prep", 325_000), 9);
    expect(itemCostMs("force", 1_000_000)).toBeCloseTo(40, 9);
    // At 325k a whole tick is in the measured 14-16 ms range (M1 Max, #349).
    const tick = itemCostMs("prep", 325_729) + itemCostMs("force", 325_729) + itemCostMs("integrate", 325_729);
    expect(tick).toBeGreaterThan(12);
    expect(tick).toBeLessThan(18);
  });
});

/**
 * A GPU that runs each frame's work in submission order, starting no earlier than the frame's rAF time, at
 * `factor` × the work's estimate per pass: its fences signal when the work before them is done.
 */
class LaggingGpu implements FenceSource<number> {
  private readonly doneAt: number[] = [];
  /** The current frame's rAF time. */
  now = 0;
  /** Real GPU ms encoded in the current frame so far. */
  pendingMs = 0;
  private busyUntil = 0;
  insert(): number {
    this.busyUntil = Math.max(this.busyUntil, this.now) + this.pendingMs;
    this.pendingMs = 0;
    this.doneAt.push(this.busyUntil);
    return this.doneAt.length - 1;
  }
  poll(fence: number): FenceStatus {
    return (this.doneAt[fence] ?? Number.POSITIVE_INFINITY) <= this.now ? "signaled" : "pending";
  }
  drop(): void {}
}

/**
 * Stream ticks of one large pass (whose real GPU time is `factor` × its estimate) and 16 small passes of
 * 0.5 ms (at their estimate) through the real schedule and budget at 120 Hz for `frames` frames. Returns
 * how often the band growth changed, its largest value, and the ticks done.
 */
function lagging(large: { costMs: number; fixedMs: number; factor: number }, frames: number): { changes: number; maxGrowth: number; ticks: number } {
  const gpu = new LaggingGpu();
  const budget = new FrameBudget(gpu, () => 0);
  const pass = (costMs: number, fixedMs: number, rows: number, factor: number): StreamStage => ({
    costMs,
    fixedMs,
    rows,
    run: (_band, bands) => {
      gpu.pendingMs += factor * (fixedMs + costMs / bands);
    },
  });
  const stages = [pass(large.costMs, large.fixedMs, 1_000, large.factor), ...Array.from({ length: 16 }, () => pass(0.5, 0.05, 100, 1))];
  let ticks = 0;
  const schedule = new StreamSchedule(budget, { tickStages: () => stages }, {
    tickStart: () => {},
    tickEnd: () => {
      ticks++;
    },
    readbackStart: () => {},
    copy: () => {},
  });
  let changes = 0;
  let maxGrowth = 1;
  let growth = budget.growth;
  for (let f = 0; f < frames; f++) {
    gpu.now = f * (1000 / 120);
    budget.beginFrame(gpu.now);
    schedule.frame(budget.open(), () => true, () => false);
    budget.endFrame();
    if (budget.growth !== growth) changes++;
    growth = budget.growth;
    maxGrowth = Math.max(maxGrowth, growth);
  }
  return { changes, maxGrowth, ticks };
}

describe("FrameBudget band growth on a stream of passes of very different sizes, on a GPU slower than estimated", () => {
  it("does not oscillate: frames of small passes are no evidence that a band twice the size fits", () => {
    // A 6 ms pass (0.1 ms per band) running at 4× its estimate: 3 bands of 8.4 ms real at growth 1, more than
    // a 120 Hz frame; 5 bands of 5.2 ms at growth 2. Frames of the 0.5 ms passes fit, but two bands of the
    // large pass never finish within a frame, so the growth must stay where one band does.
    const run = lagging({ costMs: 6, fixedMs: 0.1, factor: 4 }, 6_000);
    expect(run.maxGrowth).toBeGreaterThan(1);
    expect(run.changes, `the growth changed ${run.changes} times`).toBeLessThanOrEqual(2);
  });

  it("does not grow for a pass bound by its fixed cost, which more bands cannot shrink", () => {
    // The nested gather at 1M (9 ms, 2.09 ms of tail per band) running at 5× its estimate. More bands would
    // only pay the tail again: at growth 8 its 25 bands would cost 3.3× its 4.
    const run = lagging({ costMs: 9, fixedMs: 2.09, factor: 5 }, 6_000);
    expect(run.maxGrowth).toBe(1);
  });

  it("keeps the other passes' frames when one band that cannot be cut finer runs long", () => {
    // The gather of one 60,000-child module: 0.6 ms of work and ~18 ms of tail per band (one band a tick),
    // running at ~3.2× that (~60 ms, as measured). Its every frame is late, and nothing shortens it; cutting
    // k to one item per frame after each such miss left the 16 small passes one per frame — ~18 frames a
    // tick where the gather alone needs ~7.
    const frames = 6_000;
    const run = lagging({ costMs: 0.6, fixedMs: 18.1, factor: 3.2 }, frames);
    const floor = (3.2 * 18.7) / (1000 / 120);
    expect(run.maxGrowth).toBe(1);
    expect(frames / run.ticks, `${run.ticks} ticks in ${frames} frames`).toBeLessThan(floor + 3);
  });
});
