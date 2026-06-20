import { describe, it, expect } from "vitest";
import { ForceLayout, seedPositions } from "../force.js";
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

describe("seedPositions", () => {
  it("spreads nodes deterministically (no coincident, reproducible)", () => {
    const g = buildGraph({ nodeCount: 20, source: [], target: [] });

    seedPositions(g, 200, 200);
    const first = Float32Array.from(g.positions);

    // Spread out (not all at the origin) and node 0 != node 1.
    expect(Array.from(g.positions).some((v) => v !== 0)).toBe(true);
    expect(g.positions[0] !== g.positions[2] || g.positions[1] !== g.positions[3]).toBe(true);

    // Deterministic: re-seeding gives identical coordinates.
    seedPositions(g, 200, 200);
    expect(Array.from(g.positions)).toEqual(Array.from(first));
  });
});
