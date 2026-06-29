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

  it("setPinned holds a node in place while the rest of the layout moves (#140 drag)", () => {
    // A connected pair far apart: normally attraction contracts BOTH toward each other. Pin node 0 →
    // it must not move at all, while node 1 still gets pulled in (the pinned node anchors the spring).
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 100, 0]);
    const sim = new ForceLayout(g);
    sim.setPinned([0]);

    sim.run(60);

    expect(g.positions[0]).toBe(0); // node 0 pinned — x exactly where it started
    expect(g.positions[1]).toBe(0); // node 0 pinned — y exactly where it started
    expect(g.positions[2]!).toBeLessThan(100); // node 1 (x at index 2) was pulled toward the held node 0
    expect(g.positions[2]!).toBeGreaterThan(0); // ...but not past it

    // Releasing the pin lets node 0 move again on the next ticks.
    sim.setPinned(null);
    sim.run(10);
    expect(g.positions[0]).not.toBe(0);
  });

  it("stays finite and bounded on a large near-coincident cluster (softening + step clamp)", () => {
    // A 256-node hub star seeded in a sub-pixel disc: without softening the repulsion ~ 1/d² is
    // enormous and (with the old same-direction coincidence hack) velocities ran away to ±∞ → NaN,
    // which cascaded through the multilevel coarse solves (#118).
    const n = 256;
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 1; i < n; i++) {
      source.push(0);
      target.push(i);
    }
    const g = buildGraph({ nodeCount: n, source, target });
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996323;
      g.positions[i * 2] = 1e-3 * Math.cos(a);
      g.positions[i * 2 + 1] = 1e-3 * Math.sin(a);
    }

    new ForceLayout(g).run(100);

    const xs = Array.from(g.positions);
    expect(xs.every((v) => Number.isFinite(v))).toBe(true); // no NaN/∞
    expect(Math.max(...xs.map((v) => Math.abs(v)))).toBeLessThan(1e5); // no runaway drift
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
