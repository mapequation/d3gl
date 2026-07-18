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

  it("per-tick step clamp is isotropic — preserves direction instead of snapping to ±45° (#203)", () => {
    // Two unconnected nodes 0.559 apart along 26.57° (dx=0.5, dy=0.25). span0 floors at 1 so
    // maxStep = 4, while the raw repulsion step is ~60 — far above the clamp. A component-wise
    // clamp would emit (±4, ±4), i.e. snap the motion onto the diagonal (dy/dx = 1) — exactly the
    // #203 four-corners artifact. The isotropic clamp must keep |Δp| = maxStep and dy/dx = 0.5.
    const g = buildGraph({ nodeCount: 2, source: [], target: [] });
    g.positions.set([0, 0, 0.5, 0.25]);

    new ForceLayout(g).tick();

    const dx = g.positions[2]! - 0.5;
    const dy = g.positions[3]! - 0.25;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(3.9); // clamp engaged…
    expect(Math.hypot(dx, dy)).toBeLessThan(4.01); // …at the vector magnitude, not per axis
    expect(dy / dx).toBeCloseTo(0.5, 3); // direction preserved (component clamp gives 1.0)
  });

  it("a high-degree hub cannot turn the spring integration unstable (#203 runaway)", () => {
    // Star hub with 1200 leaves, each edge doubled (reciprocal pair) → 2400 spring incidences on
    // the hub: per-tick spring gain K̃ = damping·α·attraction·deg ≈ 21.6, way past the explicit
    // integrator's oscillatory stability bound (K̃ ≈ 3.8). Pre-#203 the hub oscillates with
    // exponentially growing amplitude (contained only by the step clamp — permanent maxStep-sized
    // jitter); the per-node semi-implicit stabilizer keeps it unconditionally stable, so after a
    // few hundred ticks the layout must be SETTLED (tiny last-tick steps), not just finite.
    const n = 1201;
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 1; i < n; i++) {
      source.push(0, i);
      target.push(i, 0);
    }
    const g = buildGraph({ nodeCount: n, source, target });
    seedPositions(g, 1000, 1000);

    const sim = new ForceLayout(g);
    sim.run(299);
    const before = g.positions.slice();
    sim.tick();

    let span = 0;
    let maxStepSeen = 0;
    for (let i = 0; i < n; i++) {
      const sx = g.positions[i * 2]! - before[i * 2]!;
      const sy = g.positions[i * 2 + 1]! - before[i * 2 + 1]!;
      maxStepSeen = Math.max(maxStepSeen, Math.hypot(sx, sy));
      span = Math.max(span, Math.abs(g.positions[i * 2]!), Math.abs(g.positions[i * 2 + 1]!));
    }
    expect(Array.from(g.positions).every((v) => Number.isFinite(v))).toBe(true);
    expect(span).toBeLessThan(50_000); // no runaway drift
    expect(maxStepSeen).toBeLessThan(20); // settled — pre-#203 the hub still jumps ~maxStep (≈4000)
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
