import { describe, it, expect } from "vitest";
import type { DrawableVector } from "../../core/index.js";
import { overlayBounds } from "../overlay-bounds.js";

// #519: the Canvas hover slot keeps the pixels under this rectangle and puts them back on a change, so it
// must cover everything `drawShapes` paints for the overlay, in screen px, under each placement mode.
const base = (over: Partial<DrawableVector>): DrawableVector => ({
  id: 0, subpaths: [], fill: [0, 0, 0, 255], stroke: [0, 0, 0, 0], lineWidth: 0, lineJoin: "bevel", miterLimit: 4,
  lineCap: "butt", flags: 1, circles: [], anchor: null, ...over,
});
const t = { k: 2, x: 10, y: 20 };

describe("overlayBounds (#519)", () => {
  it("a world circle scales with the view, a screen circle keeps its pixel radius", () => {
    const d = base({ circles: [{ x: 5, y: 5, r: 3 }], lineWidth: 2 });
    // centre (20, 30); world radius (3 + 1) * k = 8, plus 1 px antialiasing.
    expect(overlayBounds([d], false, t)).toEqual([11, 21, 29, 39]);
    expect(overlayBounds([d], true, t)).toEqual([15, 25, 25, 35]);
  });

  it("an anchored screen glyph is offset in px around its projected anchor", () => {
    const d = base({ anchor: [5, 5], subpaths: [{ points: [3, 5, 8, 5], closed: false }] });
    expect(overlayBounds([d], true, t)).toEqual([17, 29, 24, 31]); // anchor at (20, 30), offsets -2..+3 px
  });

  it("a world path's stroke reaches past it by its join (miter limit) and scales with the view", () => {
    const d = base({ subpaths: [{ points: [0, 0, 10, 0], closed: false }], stroke: [0, 0, 0, 255], lineWidth: 1, lineJoin: "miter", miterLimit: 4 });
    // half width 0.5 × miter 4 = 2 world units → 4 px at k = 2, plus 1.
    expect(overlayBounds([d], false, t)).toEqual([5, 15, 35, 25]);
  });

  it("hidden drawables and an empty overlay have no rectangle", () => {
    expect(overlayBounds([base({ circles: [{ x: 0, y: 0, r: 1 }], flags: 0 })], false, t)).toBeNull();
    expect(overlayBounds([], false, t)).toBeNull();
  });
});
