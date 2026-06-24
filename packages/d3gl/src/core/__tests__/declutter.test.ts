import { describe, it, expect } from "vitest";
import { declutterScreen } from "../declutter.js";

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
});
