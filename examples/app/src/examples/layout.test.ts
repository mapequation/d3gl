import { describe, it, expect } from "vitest";
import { makeTree } from "./tree.js";
import { layoutRectangular, layoutRadial } from "./layout.js";

describe("tree layout", () => {
  it("rectangular: finite px/py coords, leaves at increasing depth", () => {
    const h = layoutRectangular(makeTree(64), 800, 600);
    const ns = h.descendants() as any[];
    expect(ns.length).toBeGreaterThan(64);
    for (const n of ns) {
      expect(Number.isFinite(n.px)).toBe(true);
      expect(Number.isFinite(n.py)).toBe(true);
    }
    expect(h.links().length).toBe(ns.length - 1);
  });
  it("radial: finite px/py coords (origin-centred, centred by view transform)", () => {
    const h = layoutRadial(makeTree(64), 800, 600) as any;
    for (const n of h.descendants()) {
      expect(Number.isFinite(n.px)).toBe(true);
      expect(Number.isFinite(n.py)).toBe(true);
      // origin-centred: tip radius <= min(800,600)/2 - pad = 270
      expect(Math.hypot(n.px, n.py)).toBeLessThanOrEqual(280);
    }
  });
});
