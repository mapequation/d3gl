import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { referenceFromScreen, lonLatFromScreen, viewTransform } from "../inverse.js";

describe("referenceFromScreen", () => {
  it("inverts the d3-zoom pixel transform", () => {
    // screen = k*reference + (x,y)  =>  reference = (screen - (x,y)) / k
    expect(referenceFromScreen({ k: 2, x: 10, y: 20 }, 50, 60)).toEqual([20, 20]);
  });
  it("is identity at k=1, no pan", () => {
    expect(referenceFromScreen({ k: 1, x: 0, y: 0 }, 33, 44)).toEqual([33, 44]);
  });
});

describe("lonLatFromScreen", () => {
  it("round-trips a projected point back to lon/lat", () => {
    const projection = geoEquirectangular();
    const lonlat: [number, number] = [12, -7];
    const [px, py] = projection(lonlat)!;
    const back = lonLatFromScreen(projection, { k: 1, x: 0, y: 0 }, px, py);
    expect(back).not.toBeNull();
    expect(back![0]).toBeCloseTo(12, 4);
    expect(back![1]).toBeCloseTo(-7, 4);
  });

  it("accounts for zoom/pan before inverting", () => {
    const projection = geoEquirectangular();
    const lonlat: [number, number] = [30, 10];
    const [px, py] = projection(lonlat)!;
    const k = 3, x = 100, y = 50;
    const screenX = k * px + x;
    const screenY = k * py + y;
    const back = lonLatFromScreen(projection, { k, x, y }, screenX, screenY);
    expect(back![0]).toBeCloseTo(30, 3);
    expect(back![1]).toBeCloseTo(10, 3);
  });
});

describe("viewTransform", () => {
  it("produces a 9-element clip-space matrix from a zoom transform", () => {
    const m = viewTransform({ k: 1, x: 0, y: 0 }, 100, 100);
    expect(m.length).toBe(9);
    expect(m instanceof Float32Array).toBe(true);
  });
});
