import { describe, it, expect } from "vitest";
import { signedArea, pointInRing, groupRings } from "../rings.js";
import type { Subpath } from "../path-context.js";

const ccwSquare = (): Subpath => ({
  // counter-clockwise outer ring, area > 0
  points: [0, 0, 10, 0, 10, 10, 0, 10],
  closed: true,
});
const cwHole = (): Subpath => ({
  // clockwise inner ring (opposite winding), area < 0, inside the square
  points: [3, 3, 3, 7, 7, 7, 7, 3],
  closed: true,
});

describe("signedArea", () => {
  it("is positive for CCW and negative for CW rings", () => {
    expect(signedArea(ccwSquare().points)).toBeGreaterThan(0);
    expect(signedArea(cwHole().points)).toBeLessThan(0);
  });
  it("equals the geometric area magnitude (100 for a 10x10 square)", () => {
    expect(Math.abs(signedArea(ccwSquare().points))).toBeCloseTo(100, 6);
  });
});

describe("pointInRing", () => {
  it("detects inside and outside points", () => {
    const r = ccwSquare().points;
    expect(pointInRing(5, 5, r)).toBe(true);
    expect(pointInRing(15, 5, r)).toBe(false);
  });
});

describe("groupRings", () => {
  it("returns a single outer with no holes for one ring", () => {
    const groups = groupRings([ccwSquare()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(0);
  });

  it("assigns a contained, opposite-wound ring as a hole of its container", () => {
    const groups = groupRings([ccwSquare(), cwHole()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(1);
    expect(groups[0]!.outer.points).toEqual(ccwSquare().points);
  });

  it("assigns two separate interior rings as two holes of the same outer", () => {
    // big outer 0..30, two disjoint interior holes
    const outer: Subpath = { points: [0, 0, 30, 0, 30, 30, 0, 30], closed: true };
    const hole1: Subpath = { points: [3, 3, 3, 9, 9, 9, 9, 3], closed: true };
    const hole2: Subpath = { points: [20, 20, 20, 26, 26, 26, 26, 20], closed: true };
    const groups = groupRings([outer, hole1, hole2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(2);
  });

  it("keeps two disjoint rings as two separate outers", () => {
    const a = ccwSquare();
    const b: Subpath = { points: [20, 20, 30, 20, 30, 30, 20, 30], closed: true };
    const groups = groupRings([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.holes.length === 0)).toBe(true);
  });

  it("ignores open and degenerate subpaths", () => {
    const open: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const tiny: Subpath = { points: [0, 0, 1, 0], closed: true };
    expect(groupRings([open, tiny])).toHaveLength(0);
  });
});
