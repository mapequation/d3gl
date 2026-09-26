/**
 * The streaming layout's fence controller (#352, spec §6.5.3) — node, pure, with fake fences and a fake
 * clock. It decides how many work items (tick prep, force bands, integrate) the GPU transport encodes in
 * one animation frame: at most 2 frames of layout work in flight, a GPU budget per frame of
 * min(10 ms, 0.6 × the rAF interval), and at most 2 ms of main-thread encode time.
 */
import { describe, expect, it } from "vitest";
import {
  FrameBudget,
  frameBudgetMs,
  framesInFlight,
  itemCostMs,
  staticBands,
  type FenceSource,
  type FenceStatus,
} from "../frame-budget.js";

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
}

function rig(opts: { nodes?: number; rows?: number; budgetMs?: number; encodeCapMs?: number } = {}): Rig {
  const fences = new FakeFences();
  const clock = new FakeClock();
  const budget = new FrameBudget(fences, clock.now, {
    nodes: opts.nodes ?? 1_000,
    rows: opts.rows ?? 64,
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.encodeCapMs !== undefined ? { encodeCapMs: opts.encodeCapMs } : {}),
  });
  return { fences, clock, budget, now: 0 };
}

/**
 * One animation frame: poll fences, then encode items while the controller admits them (each costs
 * `costMs` of estimated GPU time and `encodeMs` of main thread), then insert the frame's budget fence.
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
      r.budget.spent(costMs, sliceable);
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
    expect(r.budget.k).toBe(5); // ⌊10 / 2⌋ — half of what the late frames actually encoded
    // Still behind for a few more frames: one miss episode halves once.
    frame(r);
    frame(r);
    expect(r.budget.k).toBe(5);
    r.fences.catchUp();
    // The hold: k stays 5 for 30 frames from the miss, then grows by one per frame again.
    const held: number[] = [];
    for (let f = 0; f < 27; f++) {
      held.push(frame(r));
      r.fences.catchUp();
    }
    expect(new Set(held)).toEqual(new Set([5]));
    const grown: number[] = [];
    for (let f = 0; f < 3; f++) {
      grown.push(frame(r));
      r.fences.catchUp();
    }
    expect(grown).toEqual([5, 6, 7]);
  });

  it("a miss behind a frame that carried the engine's repaint blocks, but resizes neither k nor B", () => {
    const r = rig();
    for (let f = 0; f < 6; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.k).toBe(7);
    frame(r, { repainted: true }); // the render queues behind the layout
    frame(r);
    expect(frame(r)).toBe(0); // blocked: two frames in flight, one of them repainted
    expect(r.budget.k).toBeGreaterThanOrEqual(7);
    expect(r.budget.bands).toBe(1);
    r.fences.catchUp();
    expect(frame(r)).toBeGreaterThanOrEqual(7); // no hold, no halving
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

describe("FrameBudget bands: row bands per force pass", () => {
  it("starts from the static estimate: a band is about half the budget", () => {
    // ≈ 40 ns per node for the whole force pass (M1 Max): 325k → 13 ms → 3 bands of 5 ms at a 10 ms budget.
    expect(staticBands(325_729, 10, 571)).toBe(3);
    expect(staticBands(1_000_000, 10, 1000)).toBe(8);
    expect(staticBands(1_000, 10, 32)).toBe(1);
    expect(staticBands(1_000_000, 5, 1000)).toBe(16); // 120 Hz halves the budget
    expect(staticBands(1_000_000, 10, 4)).toBe(4); // never more bands than atlas rows
    expect(rig({ nodes: 325_729, rows: 571 }).budget.bands).toBe(3);
  });

  it("doubles when one item per frame still misses the gate and a force band was late", () => {
    const r = rig();
    expect(r.budget.bands).toBe(1);
    // A GPU so slow that even one item per frame falls behind: k is driven to 1 by the first miss…
    frame(r);
    frame(r);
    frame(r); // miss 1: k = ⌊2 / 2⌋ = 1
    expect(r.budget.k).toBe(1);
    expect(r.budget.bands).toBe(1);
    r.fences.catchUp();
    frame(r);
    frame(r);
    frame(r); // miss 2 with k = 1 — the band itself is too large
    expect(r.budget.bands).toBe(2);
  });

  it("does not slice further when the late items were P or I (slicing cannot shrink them)", () => {
    const r = rig();
    frame(r, { sliceable: false });
    frame(r, { sliceable: false });
    frame(r, { sliceable: false }); // miss 1
    r.fences.catchUp();
    frame(r, { sliceable: false });
    frame(r, { sliceable: false });
    frame(r, { sliceable: false }); // miss 2 at k = 1, but only prep / integrate were in flight
    expect(r.budget.k).toBe(1);
    expect(r.budget.bands).toBe(1);
  });

  it("halves back, with k, once two items per frame have fit for 30 frames", () => {
    const r = rig();
    frame(r);
    frame(r);
    frame(r);
    r.fences.catchUp();
    frame(r);
    frame(r);
    frame(r);
    expect(r.budget.bands).toBe(2);
    r.fences.catchUp();
    let frames = 0;
    let kBefore = 0;
    while (r.budget.bands === 2 && frames < 200) {
      kBefore = r.budget.k;
      frame(r);
      r.fences.catchUp();
      frames++;
    }
    expect(r.budget.bands).toBe(1);
    expect(r.budget.k).toBe(Math.max(1, Math.floor((kBefore + 1) / 2)));
    // The hold after the miss (30) + growing k to 2 + 30 frames of ≥ 2 items.
    expect(frames).toBeGreaterThanOrEqual(30);
  });

  it("recovers from a transient stall: B returns to the static estimate", () => {
    // A first-use stall (e.g. a shader compile on the first draw) misses the gate over and over at
    // k = 1 and doubles B each time; a GPU that then keeps up must bring B back down.
    const r = rig();
    for (let miss = 0; miss < 4; miss++) {
      frame(r);
      frame(r);
      frame(r);
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.bands).toBeGreaterThanOrEqual(8);
    for (let f = 0; f < 600 && r.budget.bands > 1; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.bands).toBe(1);
  });

  it("slices at most 8× the static estimate, however often one band misses", () => {
    const r = rig({ nodes: 100_000, rows: 317 }); // static: 1 band at 60 Hz
    for (let miss = 0; miss < 12; miss++) {
      frame(r);
      frame(r);
      frame(r);
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.bands).toBe(8);
  });

  it("never halves below the static estimate", () => {
    const r = rig({ nodes: 325_729, rows: 571 });
    for (let f = 0; f < 300; f++) {
      frame(r);
      r.fences.catchUp();
    }
    expect(r.budget.bands).toBe(3);
  });
});

describe("itemCostMs — the static cost model behind the budget", () => {
  it("splits the force pass evenly over the bands and scales every item with N", () => {
    expect(itemCostMs("force", 325_729, 3)).toBeCloseTo(itemCostMs("force", 325_729, 1) / 3, 9);
    expect(itemCostMs("prep", 650_000, 1)).toBeCloseTo(2 * itemCostMs("prep", 325_000, 1), 9);
    // At 325k a whole tick is in the measured 14-16 ms range (M1 Max, #349).
    const tick = itemCostMs("prep", 325_729, 1) + itemCostMs("force", 325_729, 1) + itemCostMs("integrate", 325_729, 1);
    expect(tick).toBeGreaterThan(12);
    expect(tick).toBeLessThan(18);
  });
});
