/**
 * T0 — the segmented solver's CPU prep (node, pure): the reduction tree's packed layout, the range
 * query's canonical cover, the flat segment table and the slot ↔ texel mapping. The GPU passes read
 * all of these, so they are pinned here where a failure names the exact index.
 */
import { describe, expect, it } from "vitest";
import {
  REDUCE_FANOUT,
  REDUCE_MAX_LEVELS,
  canonicalCover,
  coverDepth,
  flatSegments,
  reduceLayout,
} from "../segments.js";
import { slotTexel, texelSlot } from "../textures.js";

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("reduceLayout — the packed 16-ary tree", () => {
  it("has the levels a query can reach: sizes ⌈n/16⌉ while 16^ℓ ≤ capacity", () => {
    // web-NotreDame: 325,729 slots → 20,359 → 1,273 → 80 → 5. The 1-texel level above them is never
    // read (a query's upper bound there is ⌊N/16^5⌋ = 0), so it is not built.
    expect(reduceLayout(325_729).levels.map((l) => l.size)).toEqual([20_359, 1_273, 80, 5]);
    expect(reduceLayout(1_000_000).levels.map((l) => l.size)).toEqual([62_500, 3_907, 245, 16]);
    expect(reduceLayout(16 ** 5).levels.map((l) => l.size)).toEqual([65_536, 4_096, 256, 16, 1]);
    expect(reduceLayout(15).levels).toEqual([]);
    expect(reduceLayout(16).levels.map((l) => l.size)).toEqual([1]);
    expect(reduceLayout(0).levels).toEqual([]);
  });

  it("packs odd levels into texture A and even levels into texture B, disjoint rows", () => {
    for (const cap of [0, 1, 15, 16, 17, 255, 256, 257, 4097, 65_536, 325_729, 1_000_000]) {
      const lay = reduceLayout(cap);
      expect(lay.width).toBeGreaterThanOrEqual(1);
      expect(lay.heightA).toBeGreaterThanOrEqual(1);
      expect(lay.heightB).toBeGreaterThanOrEqual(1);
      expect(lay.levels.length).toBeLessThanOrEqual(REDUCE_MAX_LEVELS);
      const used: [Set<number>, Set<number>] = [new Set<number>(), new Set<number>()];
      lay.levels.forEach((lvl, k) => {
        const level = k + 1;
        expect(lvl.texture).toBe(level % 2 === 1 ? 0 : 1);
        expect(lvl.rows).toBe(Math.ceil(lvl.size / lay.width));
        const height = lvl.texture === 0 ? lay.heightA : lay.heightB;
        expect(lvl.rowOffset + lvl.rows).toBeLessThanOrEqual(height);
        for (let r = lvl.rowOffset; r < lvl.rowOffset + lvl.rows; r++) {
          expect(used[lvl.texture].has(r)).toBe(false);
          used[lvl.texture].add(r);
        }
      });
    }
  });

  it("stays within ≈ N/15 texels per chain (the 0.70 MB at 325k the spec budgets)", () => {
    const lay = reduceLayout(325_729);
    const texels = lay.width * (lay.heightA + lay.heightB);
    // 2 chains × texels × 16 B.
    expect(2 * texels * 16).toBeLessThan(0.72e6);
    expect(texels).toBeLessThan(325_729 / 14);
  });
});

/** Brute-force check of one cover against the interval it must tile. */
function checkCover(start: number, count: number): void {
  const terms = canonicalCover(start, count);
  const lay = reduceLayout(start + count);
  const covered: Array<[number, number]> = [];
  const perLevel = new Map<number, number>();
  for (const t of terms) {
    const span = REDUCE_FANOUT ** t.level;
    covered.push([t.index * span, (t.index + 1) * span]);
    perLevel.set(t.level, (perLevel.get(t.level) ?? 0) + 1);
    if (t.level > 0) {
      // Every tree term exists in the layout of any capacity ≥ start + count.
      expect(t.level).toBeLessThanOrEqual(lay.levels.length);
      expect(t.index).toBeLessThan(lay.levels[t.level - 1]?.size ?? 0);
    }
  }
  for (const n of perLevel.values()) expect(n).toBeLessThanOrEqual(2 * (REDUCE_FANOUT - 1));
  covered.sort((a, b) => a[0] - b[0]);
  let cursor = start;
  for (const [a, b] of covered) {
    expect(a).toBe(cursor); // disjoint and gap-free
    cursor = b;
  }
  expect(cursor).toBe(start + count);
}

describe("canonicalCover — the range query's aligned blocks", () => {
  it("tiles [start, start+count) exactly for edge ranges", () => {
    checkCover(0, 0);
    checkCover(7, 0);
    checkCover(5, 1);
    checkCover(0, 1);
    checkCover(0, 16);
    checkCover(0, 325_729);
    checkCover(0, 1_000_000);
    // Straddling 16^ℓ boundaries.
    for (const b of [16, 256, 4096, 65_536, 1_048_576]) {
      checkCover(b - 1, 2);
      checkCover(b - 3, 7);
      checkCover(b - 17, 40);
      checkCover(b - b / 2, b);
    }
  });

  it("tiles random ranges (brute force)", () => {
    const rng = makePrng(0x70c0);
    for (let k = 0; k < 2000; k++) {
      const start = Math.floor(rng() * 200_000);
      const count = Math.floor(rng() ** 3 * 150_000);
      checkCover(start, count);
    }
  });

  it("lists terms in the query's add order: per level, head ascending then tail descending", () => {
    // [3, 40): level 0 head 3..15, level 0 tail 39..32, then level 1 texel 1 (slots 16..31).
    const terms = canonicalCover(3, 37);
    expect(terms).toEqual([
      ...Array.from({ length: 13 }, (_, i) => ({ level: 0, index: 3 + i })),
      ...Array.from({ length: 8 }, (_, i) => ({ level: 0, index: 39 - i })),
      { level: 1, index: 1 },
    ]);
  });

  it("coverDepth bounds every term's add depth (4 per tree level + the sequential query adds)", () => {
    expect(coverDepth(canonicalCover(0, 0))).toBe(0);
    expect(coverDepth(canonicalCover(4, 1))).toBe(1);
    const terms = canonicalCover(0, 325_729);
    const maxLevel = Math.max(...terms.map((t) => t.level));
    expect(coverDepth(terms)).toBe(4 * maxLevel + terms.length);
    // The spec's flat bound D ≤ 4·L + 15·L (no head on [0, N)).
    expect(coverDepth(terms)).toBeLessThanOrEqual(4 * 5 + 15 * 5);
  });
});

describe("flat segment table and slot ↔ texel mapping", () => {
  it("the flat layout is one segment over every slot", () => {
    expect(flatSegments(325_729)).toEqual([{ start: 0, count: 325_729 }]);
    expect(flatSegments(0)).toEqual([{ start: 0, count: 0 }]);
  });

  it("slotTexel and texelSlot round-trip", () => {
    for (const width of [1, 2, 7, 571, 1000]) {
      for (const slot of [0, 1, width - 1, width, width + 1, 5 * width + 3, 325_728]) {
        const [x, y] = slotTexel(slot, width);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(width);
        expect(texelSlot(x, y, width)).toBe(slot);
      }
    }
  });
});
