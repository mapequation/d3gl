import { describe, it, expect } from "vitest";
import { ForceLayout } from "../force.js";
import { buildGraph } from "../graph.js";

const dist = (p: Float32Array, a: number, b: number) =>
  Math.hypot(p[a * 2]! - p[b * 2]!, p[a * 2 + 1]! - p[b * 2 + 1]!);

describe("ForceLayout", () => {
  it("repulsion pushes unconnected nodes apart", () => {
    const g = buildGraph({ nodeCount: 2, source: [], target: [] });
    g.positions.set([0, 0, 1, 0]);

    new ForceLayout(g).run(60);

    expect(dist(g.positions, 0, 1)).toBeGreaterThan(5);
  });

  it("attraction contracts a far-apart connected pair", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 100, 0]);

    new ForceLayout(g).run(60);

    expect(dist(g.positions, 0, 1)).toBeLessThan(100);
  });

  it("keeps positions finite even when nodes start coincident", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    g.positions.set([0, 0, 0, 0, 0, 0]); // all stacked at the origin

    new ForceLayout(g).run(30);

    expect(Array.from(g.positions).every((v) => Number.isFinite(v))).toBe(true);
  });
});
