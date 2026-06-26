import { describe, it, expect } from "vitest";
import { declutterScreen, declutterMembers } from "../declutter.js";

const run = (count: number, sx: number[], sy: number[], radius: number | Float64Array, order: number[] | undefined, spacing = 1) =>
  Array.from(declutterScreen(count, sx, sy, radius, order, 100, 100, spacing, new Uint8Array(count)));

describe("declutterScreen", () => {
  it("drops a later glyph that overlaps a kept one (centre dist < rᵢ + rⱼ)", () => {
    // r=10 each at x=0 and x=15 → dist 15 < 20 ⇒ overlap; visiting [0,1] keeps 0.
    expect(run(2, [0, 15], [0, 0], 10, [0, 1])).toEqual([1, 0]);
  });

  it("keeps both when they don't overlap", () => {
    expect(run(2, [0, 30], [0, 0], 10, undefined)).toEqual([1, 1]); // dist 30 > 20
  });

  it("visits in the given order, so the higher-importance glyph survives a tie", () => {
    expect(run(2, [0, 15], [0, 0], 10, [1, 0])).toEqual([0, 1]); // order favours glyph 1
  });

  it("keeps an off-screen-centre glyph and lets it not occlude on-screen ones", () => {
    // glyph 0 off-screen (x=-50) would overlap glyph 1 if counted; it's kept but excluded from occlusion.
    expect(run(2, [-50, 5], [0, 0], 10, [0, 1])).toEqual([1, 1]);
  });

  it("honours per-glyph radii", () => {
    expect(run(2, [0, 5], [0, 0], new Float64Array([2, 2]), [0, 1])).toEqual([1, 1]); // dist 5 > 4
    expect(run(2, [0, 5], [0, 0], new Float64Array([3, 3]), [0, 1])).toEqual([1, 0]); // dist 5 < 6
  });

  it("scales the exclusion by spacing", () => {
    expect(run(2, [0, 25], [0, 0], 10, [0, 1], 1)).toEqual([1, 1]); // 25 > 20
    expect(run(2, [0, 25], [0, 0], 10, [0, 1], 1.5)).toEqual([1, 0]); // 25 < 30
  });

  it("records winners: a hidden glyph maps to the kept glyph that occluded it; a kept glyph to itself", () => {
    // Three glyphs in a row, r=10: 0 kept; 1 (x=15) and 2 (x=18) both within 20 of glyph 0 ⇒ absorbed by 0.
    const winners = new Int32Array(3);
    declutterScreen(3, [0, 15, 18], [0, 0, 0], 10, [0, 1, 2], 100, 100, 1, new Uint8Array(3), undefined, undefined, winners);
    expect(Array.from(winners)).toEqual([0, 0, 0]);
    // members(): the kept survivor (0) represents itself + both absorbed glyphs; an unrelated index is empty.
    expect(declutterMembers(winners, 0, 3)).toEqual([0, 1, 2]);
  });

  it("winners point each cluster to its own survivor", () => {
    // Two separate clusters: {0 keeps 1} near x≈0, {2 keeps 3} near x≈60.
    const winners = new Int32Array(4);
    declutterScreen(4, [0, 12, 60, 72], [0, 0, 0, 0], 10, [0, 1, 2, 3], 100, 100, 1, new Uint8Array(4), undefined, undefined, winners);
    expect(declutterMembers(winners, 0, 4)).toEqual([0, 1]);
    expect(declutterMembers(winners, 2, 4)).toEqual([2, 3]);
  });
});
