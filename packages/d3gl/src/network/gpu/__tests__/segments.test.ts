/**
 * T0 — the segmented solver's CPU prep (node, pure): the reduction tree's packed layout, the range
 * query's canonical cover, the flat segment table and the slot ↔ texel mapping. The GPU passes read
 * all of these, so they are pinned here where a failure names the exact index.
 */
import { describe, expect, it } from "vitest";
import {
  FLAT_TILE_MIN_SIDE,
  REDUCE_FANOUT,
  REDUCE_MAX_LEVELS,
  SEGMENT_EXACT,
  SEGMENT_HAS_TILE,
  TILE_MAX_SIDE,
  TILE_MIN_SIDE,
  assertSegmentLocalEdges,
  canonicalCover,
  coverDepth,
  demorton,
  flatSegments,
  packTiles,
  reduceLayout,
  segmentInfo,
  segmentSoftening,
  slotSegments,
  tileSide,
  validateSegments,
  type SlotRange,
  type TileAtlas,
} from "../segments.js";
import { chooseGrid } from "../passes/grid-pyramid.js";
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

/** Segments of the given sizes, laid out contiguously from slot 0. */
function segmentsOf(counts: readonly number[]): SlotRange[] {
  let start = 0;
  return counts.map((count) => {
    const seg = { start, count };
    start += count;
    return seg;
  });
}

/** An axis-aligned rectangle in texels. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether two rectangles share a texel. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Throws if any two rectangles share a texel (pairwise: tiles and levels are few). */
function expectDisjoint(rects: readonly Rect[]): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a && b) expect(overlaps(a, b), `rects ${i} and ${j} overlap`).toBe(false);
    }
  }
}

describe("tile packing — pow2 tiles in descending size along a Morton curve (spec §6.2.1)", () => {
  it("tileSide is clamp(nextPow2(⌈√k⌉), min, 1024), and the flat floor reproduces chooseGrid", () => {
    expect(tileSide(1, TILE_MIN_SIDE)).toBe(8);
    expect(tileSide(33, TILE_MIN_SIDE)).toBe(8); // ⌈√33⌉ = 6 → 8
    expect(tileSide(65, TILE_MIN_SIDE)).toBe(16); // ⌈√65⌉ = 9 → 16
    expect(tileSide(4097, TILE_MIN_SIDE)).toBe(128); // ⌈√4097⌉ = 65 → 128
    expect(tileSide(5_000_000, TILE_MIN_SIDE)).toBe(TILE_MAX_SIDE);
    for (const n of [1, 200, 2000, 4097, 5000, 30_000, 325_729, 1_000_000, 2_000_000]) {
      expect(tileSide(n, FLAT_TILE_MIN_SIDE)).toBe(chooseGrid(n));
    }
  });

  it("demorton de-interleaves x from the even bits and y from the odd bits", () => {
    expect(demorton(0)).toEqual([0, 0]);
    expect(demorton(1)).toEqual([1, 0]);
    expect(demorton(2)).toEqual([0, 1]);
    expect(demorton(3)).toEqual([1, 1]);
    expect(demorton(0b101101)).toEqual([0b011, 0b110]); // even bits 1,1,0 → x; odd bits 0,1,1 → y
    // 2²⁸ − 1 (the largest code a 16384² atlas uses) decodes to its corner.
    expect(demorton(2 ** 28 - 1)).toEqual([16_383, 16_383]);
  });

  it("the flat layout is one tile at (0, 0) with side chooseGrid(N), and the atlas is that grid", () => {
    for (const n of [4097, 5000, 30_000, 325_729, 1_000_000]) {
      const atlas = packTiles(flatSegments(n), 4096, FLAT_TILE_MIN_SIDE);
      const g = chooseGrid(n);
      expect(atlas.tiles).toEqual([{ x: 0, y: 0, side: g }]);
      expect(atlas.width).toBe(g);
      expect(atlas.height).toBe(g);
      expect(atlas.levels.length).toBe(Math.log2(g) + 1);
    }
  });

  it("segments at or below exactMax get no tile (the exact loop); with none left there is no atlas", () => {
    const atlas = packTiles(segmentsOf([32, 0, 1, 33, 4096]), 32, TILE_MIN_SIDE);
    expect(atlas.tiles.map((t) => t?.side ?? null)).toEqual([null, null, null, 8, 64]);
    const none = packTiles(flatSegments(4096), 4096, FLAT_TILE_MIN_SIDE);
    expect(none.tiles).toEqual([null]);
    expect(none.width).toBe(0);
    expect(none.height).toBe(0);
    expect(none.levels).toEqual([]);
  });

  it("every tile is aligned to its side, disjoint, inside the atlas, and placed in descending size", () => {
    const rng = makePrng(0x711e);
    for (let trial = 0; trial < 50; trial++) {
      const counts = Array.from({ length: 1 + Math.floor(rng() * 60) }, () => Math.floor(rng() ** 4 * 1_200_000));
      const atlas = packTiles(segmentsOf(counts), 32, TILE_MIN_SIDE);
      let area = 0;
      atlas.tiles.forEach((tile, s) => {
        if ((counts[s] ?? 0) <= 32) {
          expect(tile).toBeNull();
          return;
        }
        expect(tile).not.toBeNull();
        if (!tile) return;
        expect(tile.side).toBe(tileSide(counts[s] ?? 0, TILE_MIN_SIDE));
        // Aligned at level 0, hence at every level up to the tile's root: the 2×2 reduce never mixes tiles.
        expect(tile.x % tile.side).toBe(0);
        expect(tile.y % tile.side).toBe(0);
        expect(tile.x + tile.side).toBeLessThanOrEqual(atlas.width);
        expect(tile.y + tile.side).toBeLessThanOrEqual(atlas.height);
        area += tile.side * tile.side;
      });
      expectDisjoint(atlas.tiles.flatMap((t) => (t ? [{ x: t.x, y: t.y, width: t.side, height: t.side }] : [])));
      // The tiles fill the first Σ G² cells of the curve exactly: nothing is lost to gaps.
      expect(area).toBeLessThanOrEqual(atlas.width * atlas.height);
      // A = nextPow2(⌈√Σ G²⌉), half height when the tiles fit in the bottom half.
      if (area > 0) {
        const a = 2 ** Math.ceil(Math.log2(Math.ceil(Math.sqrt(area))));
        expect(atlas.width).toBe(a);
        expect(atlas.height).toBe(area <= (a * a) / 2 ? a / 2 : a);
      }
      // Larger tiles come first on the curve: a tile's Morton offset never precedes a larger tile's.
      const placed = atlas.tiles.flatMap((t) => (t ? [t] : []));
      const offset = (t: { x: number; y: number }): number => {
        let code = 0;
        for (let b = 0; b < 16; b++) code += (((t.x >> b) & 1) << (2 * b)) + (((t.y >> b) & 1) << (2 * b + 1));
        return code >>> 0;
      };
      for (const a of placed) for (const b of placed) if (a.side > b.side) expect(offset(a)).toBeLessThan(offset(b));
    }
  });

  it("a small second tile keeps the atlas at half height (the Morton top bit is y)", () => {
    // 64² + 16² = 4352 ≤ 128²/2: the 16-tile goes right of the 64-tile, the atlas is 128 × 64.
    const half = packTiles(segmentsOf([3000, 200]), 32, TILE_MIN_SIDE);
    expect(half.tiles).toEqual([{ x: 0, y: 0, side: 64 }, { x: 64, y: 0, side: 16 }]);
    expect([half.width, half.height]).toEqual([128, 64]);
    // Two 64-tiles and a 16-tile overflow the bottom half: the 16-tile starts a new row of 64s.
    const full = packTiles(segmentsOf([200, 3000, 1500]), 32, TILE_MIN_SIDE);
    expect(full.tiles).toEqual([{ x: 0, y: 64, side: 16 }, { x: 0, y: 0, side: 64 }, { x: 64, y: 0, side: 64 }]);
    expect([full.width, full.height]).toEqual([128, 128]);
  });
});

describe("packed pyramid levels — L0 / Podd / Peven (spec §6.2.3, Q2)", () => {
  it("at G = 1024: L0 1024², Podd 640 × 512, Peven 320 × 256 (the spec's 23.33 MB)", () => {
    const atlas = packTiles(flatSegments(325_729), 4096, FLAT_TILE_MIN_SIDE);
    expect(atlas.levels.length).toBe(11);
    expect([atlas.odd.width, atlas.odd.height]).toEqual([640, 512]);
    expect([atlas.even.width, atlas.even.height]).toEqual([320, 256]);
    const bytes = 16 * (atlas.width * atlas.height + atlas.odd.width * atlas.odd.height + atlas.even.width * atlas.even.height);
    expect(bytes).toBe(23_330_816);
  });

  it("level 0 is L0; odd levels live in Podd and even levels in Peven, level 1 / 2 at (0, 0), the rest in a column", () => {
    const atlas = packTiles(flatSegments(325_729), 4096, FLAT_TILE_MIN_SIDE);
    expect(atlas.levels.map((l) => [l.texture, l.x, l.y, l.width, l.height])).toEqual([
      ["l0", 0, 0, 1024, 1024],
      ["odd", 0, 0, 512, 512],
      ["even", 0, 0, 256, 256],
      ["odd", 512, 0, 128, 128],
      ["even", 256, 0, 64, 64],
      ["odd", 512, 128, 32, 32],
      ["even", 256, 64, 16, 16],
      ["odd", 512, 160, 8, 8],
      ["even", 256, 80, 4, 4],
      ["odd", 512, 168, 2, 2],
      ["even", 256, 84, 1, 1],
    ]);
  });

  it("level ℓ is the atlas halved ℓ times; levels never overlap and stay inside their texture", () => {
    for (const counts of [[4097], [325_729], [3000, 200], [200, 3000, 1500], [1_000_000, 50, 9000, 9000, 70]]) {
      const atlas = packTiles(segmentsOf(counts), 32, counts.length === 1 ? FLAT_TILE_MIN_SIDE : TILE_MIN_SIDE);
      const maxSide = Math.max(...atlas.tiles.map((t) => t?.side ?? 0));
      expect(atlas.levels.length).toBe(Math.log2(maxSide) + 1);
      atlas.levels.forEach((lvl, l) => {
        expect(lvl.texture).toBe(l === 0 ? "l0" : l % 2 === 1 ? "odd" : "even");
        expect(lvl.width).toBe(atlas.width >> l);
        expect(lvl.height).toBe(atlas.height >> l);
        expect(lvl.height).toBeGreaterThanOrEqual(1); // every tile still has cells up to its root
        const tex = lvl.texture === "l0" ? atlas : lvl.texture === "odd" ? atlas.odd : atlas.even;
        expect(lvl.x + lvl.width).toBeLessThanOrEqual(tex.width);
        expect(lvl.y + lvl.height).toBeLessThanOrEqual(tex.height);
      });
      for (const texture of ["odd", "even"] as const) expectDisjoint(atlas.levels.filter((l) => l.texture === texture));
    }
  });
});

describe("segment table rows — validation, per-slot segment ids, the info texel, softening", () => {
  it("validateSegments accepts a contiguous cover of [0, N) and rejects gaps, overlaps and a wrong total", () => {
    expect(() => validateSegments(segmentsOf([3, 0, 5]), 8)).not.toThrow();
    expect(() => validateSegments(flatSegments(0), 0)).not.toThrow();
    expect(() => validateSegments([], 0)).toThrow(/at least one segment/);
    expect(() => validateSegments([{ start: 1, count: 3 }], 4)).toThrow(/slot 0/);
    expect(() => validateSegments([{ start: 0, count: 3 }, { start: 4, count: 1 }], 5)).toThrow(/slot 3/);
    expect(() => validateSegments([{ start: 0, count: 3 }, { start: 2, count: 2 }], 4)).toThrow(/slot 3/);
    expect(() => validateSegments(segmentsOf([3, 4]), 8)).toThrow(/8 slots/);
  });

  it("slotSegments maps every slot to its segment", () => {
    expect(Array.from(slotSegments(segmentsOf([2, 0, 3, 1]), 6))).toEqual([0, 0, 2, 2, 2, 3]);
  });

  it("assertSegmentLocalEdges rejects the first edge that crosses segments (it would break isolation)", () => {
    const seg = slotSegments(segmentsOf([3, 3]), 6);
    expect(() => assertSegmentLocalEdges(seg, Uint32Array.of(0, 4), Uint32Array.of(2, 5), 2)).not.toThrow();
    expect(() => assertSegmentLocalEdges(seg, Uint32Array.of(0, 2, 4), Uint32Array.of(1, 3, 5), 3)).toThrow(
      /edge 1 joins slot 2 \(segment 0\) and slot 3 \(segment 1\)/,
    );
  });

  it("segmentInfo packs (start, count, x | y << 16, rootLevel | flags << 8)", () => {
    expect(segmentInfo({ start: 7, count: 20 }, null)).toEqual([7, 20, 0, SEGMENT_EXACT << 8]);
    expect(segmentInfo({ start: 100, count: 5000 }, { x: 256, y: 1024, side: 128 })).toEqual([
      100, 5000, 256 | (1024 << 16), 7 | (SEGMENT_HAS_TILE << 8),
    ]);
  });

  it("softening: the world frame keeps the flat 1e-2 on both paths; the unit frame uses the CPU nested values", () => {
    expect(segmentSoftening("world", true)).toBe(1e-2);
    expect(segmentSoftening("world", false)).toBe(1e-2);
    // repel()'s exact loop adds 1e-9 in unit coordinates; its BH runs ×1000 (BH_SCALE) with 1e-2.
    expect(segmentSoftening("unit", true)).toBe(1e-9);
    expect(segmentSoftening("unit", false)).toBe(1e-8);
  });
});
