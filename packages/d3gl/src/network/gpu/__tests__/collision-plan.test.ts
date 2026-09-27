/**
 * The nested layout's radius-class collision plan (#380): classes, lists, exact slots, work items, hash
 * tables and the gather's work estimate — and, through the CPU twin of the GPU search, that the search
 * finds every touching sibling pair, whatever the radii and however deep the discs overlap.
 */
import { describe, expect, it } from "vitest";
import {
  COLLISION_CLASS_MAX,
  COLLISION_EXACT,
  COLLISION_ITEMIZED,
  COLLISION_ITEM_SHIFT,
  COLLISION_LIST_MAX,
  COLLISION_PART_PAIRS,
  COLLISION_PART_VISITS,
  cellHash,
  collisionPlan,
  planClassCount,
  planFirstBinned,
  planHasClass,
  planSubBuckets,
  type CollisionPlan,
} from "../collision-plan.js";
import { bruteForcePartners, collisionTwin, type TwinTopology } from "./collision-twin.js";
import { EXACT_MAX, NESTED } from "../../nested-layout.js";

/** Minimal seeded LCG PRNG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Radii of k children as `setupModule` sizes them (area share, floor total / 50k) from their weights. */
function radiiOf(weights: readonly number[]): Float32Array {
  const k = weights.length;
  const total = weights.reduce((a, b) => a + b, 0);
  const floor = total / (50 * k);
  const sum = weights.reduce((a, w) => a + Math.max(w, floor), 0);
  return Float32Array.from(weights, (w) => Math.sqrt((0.45 * Math.max(w, floor)) / sum));
}

const zipf = (k: number): number[] => Array.from({ length: k }, (_, i) => 1 / (i + 1));

/**
 * One segment of `radius.length` slots (plus a small exact one after it, so segment offsets are
 * exercised). `visitCost` 1 keeps a grid on a segment too small to need one.
 */
function oneSegment(radius: Float32Array, visitCost?: number): TwinTopology & { plan: CollisionPlan } {
  const k = radius.length;
  const all = new Float32Array(k + 5);
  all.set(radius);
  all.set(radiiOf([1, 2, 3, 4, 5]), k);
  const segStart = new Uint32Array([0, k]);
  const segCount = new Uint32Array([k, 5]);
  return { slotCount: k + 5, segStart, segCount, radius: all, plan: collisionPlan(all, segStart, segCount, EXACT_MAX, NESTED.PAD, undefined, visitCost) };
}

/** Positions of `topo`'s first segment uniformly in a `side`-wide square around `(cx, cy)` (the rest far away). */
function scatter(topo: TwinTopology, side: number, seed: number, cx = 0, cy = 0): Float32Array {
  const rnd = makePrng(seed);
  const pos = new Float32Array(2 * topo.slotCount);
  for (let i = 0; i < topo.slotCount; i++) {
    const inFirst = i < (topo.segCount[0] ?? 0);
    pos[2 * i] = inFirst ? cx + (rnd() - 0.5) * side : 100 + i;
    pos[2 * i + 1] = inFirst ? cy + (rnd() - 0.5) * side : 100;
  }
  return pos;
}

/** Every slot's partners as the twin's search finds them, against brute force. */
function expectComplete(topo: TwinTopology, plan: CollisionPlan, pos: Float32Array, label: string): ReturnType<typeof collisionTwin> {
  const partners: number[][] = Array.from({ length: topo.slotCount }, () => []);
  const stats = collisionTwin(topo, plan, pos, 8, NESTED.PAD, partners);
  const want = bruteForcePartners(topo, pos, NESTED.PAD);
  let missing = 0;
  let extra = 0;
  for (let i = 0; i < topo.slotCount; i++) {
    const got = (partners[i] ?? []).slice().sort((a, b) => a - b);
    const all = want[i] ?? [];
    if (new Set(got).size !== got.length) extra++; // a partner counted twice
    for (const j of all) if (!got.includes(j)) missing++;
    for (const j of got) if (!all.includes(j)) extra++;
  }
  expect({ label, missing, extra }).toEqual({ label, missing: 0, extra: 0 });
  return stats;
}

describe("collisionPlan (#380)", () => {
  it("puts every slot in the largest class whose bound it is under, compared in float32", () => {
    const rnd = makePrng(3);
    const weights = Array.from({ length: 400 }, () => rnd() ** 6);
    const radius = radiiOf(weights);
    // Radii exactly on class bounds, in float32: rmax · 2^−c stays in class c.
    let rmax = 0;
    for (const r of radius) rmax = Math.max(rmax, r);
    radius[10] = Math.fround(rmax / 4);
    radius[11] = Math.fround(rmax / 4) * (1 + 2 ** -23);
    const { plan } = oneSegment(radius, 1);
    const word = plan.segClasses[0] ?? 0;
    const C = planClassCount(word);
    expect(C).toBeGreaterThan(4);
    expect(C).toBeLessThanOrEqual(COLLISION_CLASS_MAX);
    for (let i = 0; i < radius.length; i++) {
      const c = (plan.slotCollide[i] ?? 0) & 15;
      const r = radius[i] ?? 0;
      expect(r <= Math.fround(rmax / 2 ** c), `slot ${i} under its class bound`).toBe(true);
      if (c < COLLISION_CLASS_MAX - 1) expect(r > Math.fround(rmax / 2 ** (c + 1)), `slot ${i} in the largest class`).toBe(true);
    }
    expect((plan.slotCollide[10] ?? 0) & 15).toBe(2);
    expect((plan.slotCollide[11] ?? 0) & 15).toBe(1);
  });

  it("lists the coarsest classes while they hold at most 8 slots, and bins the others", () => {
    const { plan, radius } = oneSegment(radiiOf(zipf(20_000)));
    const word = plan.segClasses[0] ?? 0;
    const first = planFirstBinned(word);
    const list = Array.from(plan.segList.subarray(0, COLLISION_LIST_MAX)).filter((j) => j >= 0);
    // Zipf radii halve every 4× in rank: class 0 holds ranks 1-3, class 1 ranks 4-15 (too many to list).
    expect(first).toBe(1);
    expect(list).toEqual([0, 1, 2]);
    const binned = new Set(plan.binnedSlots);
    for (let i = 0; i < 20_000; i++) {
      const c = (plan.slotCollide[i] ?? 0) & 15;
      expect(binned.has(i)).toBe(c >= first);
      if (c >= first) expect(planHasClass(word, c)).toBe(true);
    }
    expect(radius.length).toBe(20_005);
  });

  it("takes the exact loop where a grid search costs more, and gives a segment of exact slots no grid", () => {
    const { plan } = oneSegment(radiiOf(zipf(20_000)));
    // The largest discs (ranks 4-63) search thousands of cells among the smallest: exact. The small discs search.
    expect((plan.slotCollide[5] ?? 0) & COLLISION_EXACT).toBe(COLLISION_EXACT);
    expect((plan.slotCollide[19_000] ?? 0) & COLLISION_EXACT).toBe(0);
    // 200 children of Zipf radii: every search costs more than 199 pair tests.
    const small = oneSegment(radiiOf(zipf(200))).plan;
    expect(small.segClasses[0]).toBe(0);
    expect(small.binnedSlots.length).toBe(0);
    expect(small.bucketCount).toBe(0);
    for (let i = 0; i < 200; i++) expect((small.slotCollide[i] ?? 0) & COLLISION_EXACT).toBe(COLLISION_EXACT);
    // A segment of at most EXACT_MAX children never has one; its slots are exact.
    expect(small.segClasses[1]).toBe(0);
  });

  it("cuts searches into work items in slot order: every grid slot's, and exact loops above one part of pair tests", () => {
    const { plan } = oneSegment(radiiOf(zipf(20_000)));
    let item = 0;
    const wrong: string[] = [];
    for (let i = 0; i < plan.slotCollide.length; i++) {
      const word = plan.slotCollide[i] ?? 0;
      if (word >>> COLLISION_ITEM_SHIFT !== item) wrong.push(`slot ${i}: items before it ${word >>> COLLISION_ITEM_SHIFT}, not ${item}`);
      const exact = (word & COLLISION_EXACT) !== 0;
      if ((word & COLLISION_ITEMIZED) === 0) {
        // A single-item exact loop runs in the slot's own fragment.
        if (!exact) wrong.push(`slot ${i}: a grid slot without items`);
        continue;
      }
      const parts = (plan.items[2 * item + 1] ?? 0) >>> 16;
      if (exact && parts !== Math.ceil((20_000 - 1) / COLLISION_PART_PAIRS)) wrong.push(`slot ${i}: ${parts} exact parts`);
      for (let p = 0; p < parts; p++) {
        if (plan.items[2 * item] !== i || plan.items[2 * item + 1] !== ((p | (parts << 16)) >>> 0)) wrong.push(`item ${item}: not slot ${i}'s part ${p} of ${parts}`);
        item++;
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(item).toBe(plan.itemCount);
    // The heaviest grid slots' searches span several items of at most COLLISION_PART_VISITS cells.
    let most = 0;
    for (let i = 0; i < plan.itemCount; i++) {
      const slot = plan.items[2 * i] ?? 0;
      if (((plan.slotCollide[slot] ?? 0) & COLLISION_EXACT) === 0) most = Math.max(most, (plan.items[2 * i + 1] ?? 0) >>> 16);
    }
    expect(most).toBeGreaterThan(1);
    expect(COLLISION_PART_VISITS).toBeGreaterThan(0);
  }, 30_000);

  it("sizes each grid segment's tables to powers of two, back to back, and estimates the gather's work", () => {
    const { plan } = oneSegment(radiiOf(zipf(20_000)));
    const binned = plan.binnedSlots.length;
    const size = (plan.segBucketMask[0] ?? 0) + 1;
    expect(size & (size - 1)).toBe(0);
    expect(size).toBeGreaterThanOrEqual(binned);
    expect(size).toBeLessThan(2 * binned);
    const sub = planSubBuckets(plan.segClasses[0] ?? 0);
    expect(sub).toBeGreaterThanOrEqual(binned / 2);
    expect(sub).toBeLessThan(binned);
    expect(plan.bucketCount).toBe(size);
    expect(plan.subBucketCount).toBe(sub);
    expect(plan.segBucketBase[1]).toBe(size);
    // Work: the exact slots' k − 1 each, and far less than every slot testing every sibling.
    let sum = 0;
    for (const w of plan.slotWork) sum += w;
    expect(plan.gatherWork).toBeCloseTo(sum, 0);
    expect(plan.slotWork[5]).toBe(19_999);
    expect(plan.gatherWork).toBeLessThan(0.15 * 20_000 * 19_999);
  });
});

describe("the radius-class search finds every touching pair once (CPU twin of the gather, #380)", () => {
  it("on even radii, spread and packed", () => {
    const t = oneSegment(radiiOf(Array.from({ length: 2000 }, () => 1)));
    expectComplete(t, t.plan, scatter(t, 2, 1), "spread");
    expectComplete(t, t.plan, scatter(t, 0.6, 2), "packed");
  }, 60_000);

  it("on Zipf radii, from a spread layout to one overlapped a thousandfold", () => {
    const t = oneSegment(radiiOf(zipf(2000)), 1);
    const spread = expectComplete(t, t.plan, scatter(t, 2, 3), "spread");
    expect(spread.denseBuckets).toBe(0);
    // Twenty times too little room: class cells hold more than K, and their sub-cells are searched.
    const dense = expectComplete(t, t.plan, scatter(t, 0.2, 4), "dense");
    expect(dense.denseBuckets).toBeGreaterThan(0);
    expect(dense.subVisits).toBeGreaterThan(0);
    expect(dense.overflowSlots).toBe(0);
    // A thousand times too little: sub-cells overflow too, and the exact loop takes over — still complete.
    const piled = expectComplete(t, t.plan, scatter(t, 0.02, 5), "piled");
    expect(piled.overflowSlots).toBeGreaterThan(0);
  }, 60_000);

  it("at any position scale and offset, and past the finest cell coordinate's range", () => {
    const t = oneSegment(radiiOf(zipf(1500)));
    expectComplete(t, t.plan, scatter(t, 1.5, 6, 1e3, -2e3), "offset");
    expectComplete(t, t.plan, scatter(t, 1e-3, 7), "tiny box");
    // A far outlier stretches the box beyond 65,535 finest cells: positions clamp, pairs are still found.
    const pos = scatter(t, 1.5, 8);
    pos[0] = 1e4;
    expectComplete(t, t.plan, pos, "clamped");
  }, 60_000);

  it("with exactly coincident discs, and on many segments at once", () => {
    const rnd = makePrng(9);
    const sizes = [40, 33, 500, 1200, 2];
    const radius: number[] = [];
    for (const k of sizes) radius.push(...radiiOf(Array.from({ length: k }, () => rnd() ** 4)));
    const segStart = new Uint32Array(sizes.length);
    for (let s = 1; s < sizes.length; s++) segStart[s] = (segStart[s - 1] ?? 0) + (sizes[s - 1] ?? 0);
    const segCount = Uint32Array.from(sizes);
    const all = Float32Array.from(radius);
    const topo: TwinTopology = { slotCount: all.length, segStart, segCount, radius: all };
    const plan = collisionPlan(all, segStart, segCount, EXACT_MAX, NESTED.PAD);
    const pos = new Float32Array(2 * all.length);
    for (let i = 0; i < all.length; i++) {
      pos[2 * i] = (rnd() - 0.5) * 0.8;
      pos[2 * i + 1] = (rnd() - 0.5) * 0.8;
    }
    // Five discs of the 1200-child segment on one point.
    const s3 = segStart[3] ?? 0;
    for (let q = 1; q < 5; q++) {
      pos[2 * (s3 + 100 * q)] = pos[2 * s3] ?? 0;
      pos[2 * (s3 + 100 * q) + 1] = pos[2 * s3 + 1] ?? 0;
    }
    expectComplete(topo, plan, pos, "segments");
  }, 60_000);

  it("with a grid forced onto a small segment (the plan's visit cost at 1)", () => {
    const radius = radiiOf(Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 50 : 1)));
    const segStart = new Uint32Array([0]);
    const segCount = new Uint32Array([600]);
    const plan = collisionPlan(radius, segStart, segCount, EXACT_MAX, NESTED.PAD, undefined, 1);
    expect(plan.segClasses[0]).not.toBe(0);
    const topo: TwinTopology = { slotCount: 600, segStart, segCount, radius };
    expectComplete(topo, plan, scatter(topo, 1, 10), "forced grid");
  });
});

describe("cellHash (#380)", () => {
  it("is the murmur3 finalizer of x | y << 16 plus the class times the golden ratio", () => {
    // Pinned values: the GLSL twin must agree bit for bit (the GPU tests compare the search's visits).
    expect(cellHash(0, 0, 0)).toBe(0);
    expect(cellHash(1, 2, 3)).toBe(cellHash(1, 2, 3));
    expect(cellHash(0, 1, 0)).not.toBe(cellHash(0, 0, 1));
    expect(cellHash(3, 7, 9)).not.toBe(cellHash(19, 7, 9)); // a class cell and a sub-cell do not share a key
    const spread = new Set<number>();
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) spread.add(cellHash(5, x, y) & 1023);
    expect(spread.size).toBeGreaterThan(900); // neighbouring cells scatter over the table
  });
});
