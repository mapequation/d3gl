import { describe, it, expect } from "vitest";
import { regionNodes } from "../glyphs.js";

// Marquee region query over the no-LOD full graph (#159): node indices whose projected CENTRE is in the
// screen-space rect. Centre-in-rect, so it's independent of node radius / sizeMode.
describe("regionNodes (#159)", () => {
  const positions = new Float32Array([0, 0, 10, 10, 20, 20, 5, 15]);
  const count = 4;

  it("returns the node indices whose centre is inside the rect (identity transform)", () => {
    const got = regionNodes(positions, count, { x0: 4, y0: 4, x1: 16, y1: 16 }, { k: 1, x: 0, y: 0 });
    expect(got).toEqual([1, 3]); // (10,10) and (5,15); (0,0) and (20,20) excluded
  });

  it("applies the view transform (scale + translate) before testing", () => {
    // screen = world*k + t. k=2,tx=ty=0: (0,0)->(0,0) (10,10)->(20,20) (20,20)->(40,40) (5,15)->(10,30).
    const got = regionNodes(positions, count, { x0: 5, y0: 5, x1: 25, y1: 25 }, { k: 2, x: 0, y: 0 });
    expect(got).toEqual([1]); // only (20,20) lands in the box
  });

  it("is inclusive of the rect edges and empty when nothing is inside", () => {
    expect(regionNodes(positions, count, { x0: 10, y0: 10, x1: 10, y1: 10 }, { k: 1, x: 0, y: 0 })).toEqual([1]);
    expect(regionNodes(positions, count, { x0: 100, y0: 100, x1: 200, y1: 200 }, { k: 1, x: 0, y: 0 })).toEqual([]);
  });
});
