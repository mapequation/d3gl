import { describe, it, expect } from "vitest";
import { makeTree } from "./tree.js";
import { layoutRectangular, layoutRadial, nodeXY } from "./layout.js";

describe("tree layout", () => {
  it("rectangular: finite coords, one link per non-root node", () => {
    const h = layoutRectangular(makeTree(64), 800, 600, "linear");
    const ns = h.descendants();
    expect(ns.length).toBeGreaterThan(64);
    for (const n of ns) {
      const [x, y] = nodeXY(n, "rectangular");
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    expect(h.links().length).toBe(ns.length - 1); // HierarchyPointLink[], no cast
  });

  it("radial: finite origin-centred coords within the disc", () => {
    const h = layoutRadial(makeTree(64), 800, 600, "linear");
    for (const n of h.descendants()) {
      const [x, y] = nodeXY(n, "radial");
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(280); // <= min(800,600)/2 - pad
    }
  });

  it("log time scale also yields finite coords", () => {
    const h = layoutRadial(makeTree(128), 800, 600, "log");
    for (const n of h.descendants()) {
      const [x, y] = nodeXY(n, "radial");
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});
