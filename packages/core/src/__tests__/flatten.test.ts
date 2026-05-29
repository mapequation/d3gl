import { describe, it, expect } from "vitest";
import { flattenCubic, flattenQuadratic, flattenArc } from "../flatten.js";

describe("flattenCubic", () => {
  it("collapses a straight (collinear) curve to just the endpoint", () => {
    // p0..p3 all on the x-axis => already flat
    const out: number[] = [];
    flattenCubic(0, 0, 1, 0, 2, 0, 3, 0, 0.1, out);
    expect(out).toEqual([3, 0]);
  });

  it("subdivides a genuinely curved segment into multiple points", () => {
    const out: number[] = [];
    flattenCubic(0, 0, 0, 10, 10, 10, 10, 0, 0.01, out);
    expect(out.length / 2).toBeGreaterThan(2);
    // last point is the curve endpoint
    expect(out.slice(-2)).toEqual([10, 0]);
  });

  it("produces more points at a tighter tolerance", () => {
    const coarse: number[] = [];
    const fine: number[] = [];
    flattenCubic(0, 0, 0, 10, 10, 10, 10, 0, 1, coarse);
    flattenCubic(0, 0, 0, 10, 10, 10, 10, 0, 0.001, fine);
    expect(fine.length).toBeGreaterThan(coarse.length);
  });
});

describe("flattenQuadratic", () => {
  it("collapses a straight quadratic to just the endpoint", () => {
    const out: number[] = [];
    flattenQuadratic(0, 0, 1, 0, 2, 0, 0.1, out);
    expect(out).toEqual([2, 0]);
  });

  it("subdivides a curved quadratic", () => {
    const out: number[] = [];
    flattenQuadratic(0, 0, 5, 10, 10, 0, 0.01, out);
    expect(out.length / 2).toBeGreaterThan(2);
    expect(out.slice(-2)).toEqual([10, 0]);
  });
});

describe("flattenArc", () => {
  it("emits the endpoint of a quarter circle", () => {
    const out: number[] = [];
    // centre (0,0), r=1, from angle 0 to PI/2 CCW
    flattenArc(0, 0, 1, 0, Math.PI / 2, false, 0.001, out);
    const lastX = out[out.length - 2]!;
    const lastY = out[out.length - 1]!;
    expect(lastX).toBeCloseTo(0, 5);
    expect(lastY).toBeCloseTo(1, 5);
  });

  it("emits intermediate points along the arc", () => {
    const out: number[] = [];
    flattenArc(0, 0, 10, 0, Math.PI, false, 0.01, out);
    expect(out.length / 2).toBeGreaterThan(2);
  });
});
