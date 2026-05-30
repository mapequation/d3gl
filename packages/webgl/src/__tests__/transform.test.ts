import { describe, it, expect } from "vitest";
import { clipFromView } from "../transform.js";

/** Apply a column-major mat3 to a 2D point. */
function apply(m: Float32Array, x: number, y: number): [number, number] {
  const cx = m[0]! * x + m[3]! * y + m[6]!;
  const cy = m[1]! * x + m[4]! * y + m[7]!;
  return [cx, cy];
}

/** Assert a mapped point matches expected clip coords within Float32 tolerance. */
function expectPoint([cx, cy]: [number, number], ex: number, ey: number): void {
  expect(cx).toBeCloseTo(ex, 5);
  expect(cy).toBeCloseTo(ey, 5);
}

describe("clipFromView", () => {
  it("maps the pixel rectangle to clip space at identity zoom", () => {
    const m = clipFromView({ k: 1, x: 0, y: 0 }, 100, 100);
    expectPoint(apply(m, 0, 0), -1, 1); // top-left pixel -> top-left clip
    expectPoint(apply(m, 100, 100), 1, -1); // bottom-right pixel -> bottom-right clip
    expectPoint(apply(m, 50, 50), 0, 0);
  });

  it("applies zoom scale k about the pixel origin", () => {
    const m = clipFromView({ k: 2, x: 0, y: 0 }, 100, 100);
    // pixel (50,50) at k=2 maps like pixel (100,100) did at k=1
    expectPoint(apply(m, 50, 50), 1, -1);
  });

  it("applies pan translation in pixels", () => {
    const m = clipFromView({ k: 1, x: 50, y: 0 }, 100, 100);
    // pixel (0,0) shifted right by 50px -> clip x 0
    const [cx] = apply(m, 0, 0);
    expect(cx).toBeCloseTo(0, 6);
  });

  it("is column-major with translation in the third column", () => {
    const m = clipFromView({ k: 1, x: 0, y: 0 }, 200, 100);
    expect(m.length).toBe(9);
    expect(m[2]).toBe(0);
    expect(m[5]).toBe(0);
    expect(m[8]).toBe(1);
  });
});
