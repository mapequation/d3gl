import { describe, it, expect } from "vitest";
import { CONVERGED_STEP, Cooling, DEFAULT_FORCE, DRAG_HEAT, ForceLayout, MIN_HEAT, MIN_SETTLE_TICKS, RECOOL_TICKS, STEP_CAP, equilibriumSpacing, seedPositions } from "../force.js";
import { BarnesHutTree } from "../quadtree.js";
import { buildGraph } from "../graph.js";

const dist = (p: Float32Array, a: number, b: number) =>
  Math.hypot(p[a * 2]! - p[b * 2]!, p[a * 2 + 1]! - p[b * 2 + 1]!);

/** 95th-percentile distance from the centroid. */
function r95(p: Float32Array, n: number): number {
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += p[i * 2]!; cy += p[i * 2 + 1]!; }
  cx /= n; cy /= n;
  const r = Array.from({ length: n }, (_, i) => Math.hypot(p[i * 2]! - cx, p[i * 2 + 1]! - cy)).sort((a, b) => a - b);
  return r[Math.floor(0.95 * (n - 1))]!;
}

/** A ring of `C` cliques of size `S`, consecutive cliques joined by one bridge edge. */
function ringOfCliques(C: number, S: number) {
  const source: number[] = [];
  const target: number[] = [];
  for (let c = 0; c < C; c++) {
    const base = c * S;
    for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) (source.push(base + i), target.push(base + j));
    source.push(base);
    target.push(((c + 1) % C) * S);
  }
  return buildGraph({ nodeCount: C * S, source, target });
}

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
    // A connected pair ~447k apart along 26.57° (dx = 2·dy): the raw spring step (~4000) is far above
    // the clamp of STEP_CAP equilibrium spacings (16 × 56 ≈ 897 at the defaults). A component-wise
    // clamp would emit (±897, ±897), i.e. snap the motion onto the diagonal (dy/dx = 1) — exactly the
    // #203 four-corners artifact. The isotropic clamp must keep |Δp| = cap and dy/dx = 0.5.
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 400_000, 200_000]);
    const cap = STEP_CAP * equilibriumSpacing(DEFAULT_FORCE);

    new ForceLayout(g).tick();

    const dx = g.positions[0]!;
    const dy = g.positions[1]!;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(cap * 0.999); // clamp engaged…
    expect(Math.hypot(dx, dy)).toBeLessThan(cap * 1.001); // …at the vector magnitude, not per axis
    expect(dy / dx).toBeCloseTo(0.5, 3); // direction preserved (component clamp gives 1.0)
  });

  it("caps the step at a multiple of the equilibrium spacing, not of the starting span", () => {
    // A pair seeded 1e6 apart used to get a cap of 4 × span0 = 4e6 — every node free to cross the
    // layout in one tick (the web-NotreDame "explosion"). The cap is now STEP_CAP spacings whatever
    // the starting extent.
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 1e6, 0]);
    new ForceLayout(g).tick();
    expect(g.positions[0]!).toBeCloseTo(STEP_CAP * equilibriumSpacing(DEFAULT_FORCE), 0);
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

describe("equilibrium scale", () => {
  it("equilibriumSpacing is √(π·repulsion/centering), and 0 for a model without one", () => {
    expect(equilibriumSpacing(DEFAULT_FORCE)).toBeCloseTo(Math.sqrt((Math.PI * 200) / 0.2), 6);
    expect(equilibriumSpacing({ ...DEFAULT_FORCE, centering: 0 })).toBe(0);
    expect(equilibriumSpacing({ ...DEFAULT_FORCE, repulsion: 0 })).toBe(0);
  });

  it("an edgeless layout settles into the predicted disc radius √(repulsion·N/centering)", () => {
    // 1/d repulsion against linear centering: a uniform disc of radius R = √(repulsion·N/centering),
    // so the 95th-percentile radius is √0.95·R. Seeded at that scale, it must stay there — no
    // overshoot on the way (the seed-scale mismatch behind the web-NotreDame explosion).
    const n = 2000;
    const g = buildGraph({ nodeCount: n, source: [], target: [] });
    seedPositions(g, 800, 600, { force: {} });
    const R = Math.sqrt((DEFAULT_FORCE.repulsion * n) / DEFAULT_FORCE.centering);
    expect(r95(g.positions, n) / (Math.sqrt(0.95) * R)).toBeCloseTo(1, 1); // the seed is at scale
    const sim = new ForceLayout(g);
    sim.cool(200);
    let peak = 0;
    for (let t = 0; t < 200; t++) { sim.tick(); peak = Math.max(peak, r95(g.positions, n)); }
    const final = r95(g.positions, n);
    expect(final / (Math.sqrt(0.95) * R)).toBeGreaterThan(0.9);
    expect(final / (Math.sqrt(0.95) * R)).toBeLessThan(1.1);
    expect(peak / final).toBeLessThan(1.1); // no explosion
  });

  it("a mass-m node repels like m unit nodes (Barnes-Hut tree with masses)", () => {
    const pos = new Float32Array([0, 0, 10, 0]);
    const unit = { fx: new Float32Array(2), fy: new Float32Array(2) };
    const heavy = { fx: new Float32Array(2), fy: new Float32Array(2) };
    const tree = new BarnesHutTree();
    tree.build(pos, 2);
    tree.applyForce(0, 200, 0, unit.fx, unit.fy);
    tree.build(pos, 2, new Float32Array([1, 5]));
    tree.applyForce(0, 200, 0, heavy.fx, heavy.fy);
    expect(heavy.fx[0]! / unit.fx[0]!).toBeCloseTo(5, 5);
    expect(tree.rootMass()).toBe(6);
  });

  it("a mass-weighted level settles at the scale of the finest nodes it stands for", () => {
    // 64 supernodes of mass 16 each stand for 1024 finest nodes: their equilibrium disc must be the
    // 1024-node one (radius √(repulsion·1024/centering)), not the 64-node one — the property that
    // lets every multilevel level share the finest equilibrium.
    const n = 64;
    const mass = new Float32Array(n).fill(16);
    const positions = new Float32Array(n * 2);
    const g = { nodeCount: n, edgeCount: 0, source: new Uint32Array(0), target: new Uint32Array(0), positions, mass };
    seedPositions(g, 0, 0, { force: {} });
    new ForceLayout(g).run(300);
    const R = Math.sqrt((DEFAULT_FORCE.repulsion * n * 16) / DEFAULT_FORCE.centering);
    const rms = Math.sqrt(Array.from({ length: n }, (_, i) => positions[i * 2]! ** 2 + positions[i * 2 + 1]! ** 2).reduce((a, b) => a + b) / n);
    // A uniform disc's rms radius is R/√2 (a 64-body disc sits a little wider than the continuum
    // one); the unweighted 64-node disc would be a quarter of it.
    expect(rms / (R / Math.SQRT2)).toBeGreaterThan(0.85);
    expect(rms / (R / Math.SQRT2)).toBeLessThan(1.25);
  });
});

describe("cooling + convergence (#124)", () => {
  it("Cooling decays geometrically to MIN_HEAT over its budget, then holds; hold() keeps a constant heat", () => {
    const c = new Cooling();
    expect(c.heat).toBe(1); // full heat until a schedule is set
    c.cool(10);
    for (let t = 0; t < 10; t++) c.next();
    expect(c.heat).toBeCloseTo(MIN_HEAT, 6);
    c.next();
    expect(c.heat).toBeCloseTo(MIN_HEAT, 6); // floored
    c.cool(4, 0.5);
    c.next();
    expect(c.heat).toBeLessThan(0.5);
    c.hold(0.3);
    for (let t = 0; t < 5; t++) c.next();
    expect(c.heat).toBe(0.3);
  });

  it("run() stops once converged — iterations is the maximum, not a fixed count", () => {
    const g = ringOfCliques(12, 8);
    seedPositions(g, 800, 600, { force: {} });
    const sim = new ForceLayout(g);
    const ticks = sim.run(1000);
    expect(ticks).toBeLessThan(1000);
    expect(sim.converged).toBe(true);
    expect(sim.meanStep).toBeLessThan(CONVERGED_STEP * sim.spacing);
  });

  it("run(n) keeps full heat by default (a cold start untangles); run(n, 'cool') decays it", () => {
    // Same far-apart pair, same 5 ticks: the cooled run has decayed to MIN_HEAT by its last tick (only
    // momentum left), the default (hot) one still steps at full heat.
    const hot = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const cold = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    hot.positions.set([0, 0, 5000, 0]);
    cold.positions.set([0, 0, 5000, 0]);
    const h = new ForceLayout(hot);
    const c = new ForceLayout(cold);
    h.run(5);
    c.run(5, "cool");
    expect(h.meanStep).toBeGreaterThan(2 * c.meanStep);
  });

  it("batched run(n) calls shorter than MIN_SETTLE_TICKS tick exactly n times at full heat, as before #124", () => {
    // The pre-#124 contract of run(n) — n ticks at full heat — for a caller that drives the layout in
    // batches: each call restarts the (hot) schedule, so no batch can stop early or cool.
    const a = ringOfCliques(6, 5);
    const b = ringOfCliques(6, 5);
    seedPositions(a, 400, 400, { force: {} });
    seedPositions(b, 400, 400, { force: {} });
    const batched = new ForceLayout(a);
    const batch = MIN_SETTLE_TICKS - 1;
    for (let k = 0; k < 8; k++) expect(batched.run(batch)).toBe(batch);
    const reference = new ForceLayout(b);
    reference.hold(1);
    for (let t = 0; t < 8 * batch; t++) reference.tick();
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });

  it("hold(DRAG_HEAT) steps a drag reflow at that fraction of a full-heat tick", () => {
    // From rest the first step is linear in the heat (v = f·α·heat·damping·stab), so a drag's reflow
    // at DRAG_HEAT moves nodes exactly that fraction of a fresh full-heat tick.
    const full = ringOfCliques(6, 5);
    const drag = ringOfCliques(6, 5);
    seedPositions(full, 400, 400, { force: {} });
    seedPositions(drag, 400, 400, { force: {} });
    const f = new ForceLayout(full);
    const d = new ForceLayout(drag);
    f.hold(1);
    d.hold(DRAG_HEAT);
    f.tick();
    d.tick();
    expect(d.meanStep / f.meanStep).toBeCloseTo(DRAG_HEAT, 5);
  });

  it("a re-cool from DRAG_HEAT stops once converged, before its RECOOL_TICKS budget", () => {
    // The post-drag tail every backend runs: cool from DRAG_HEAT over RECOOL_TICKS, stopping at convergence.
    const g = ringOfCliques(12, 8);
    seedPositions(g, 800, 600, { force: {} });
    const sim = new ForceLayout(g);
    sim.run(1000); // converged layout
    const held = g.positions[0]!;
    g.positions[0] = held + 3 * sim.spacing; // a drag moved one node away
    sim.cool(RECOOL_TICKS, DRAG_HEAT);
    let ticks = 0;
    while (ticks < RECOOL_TICKS) {
      sim.tick();
      ticks++;
      if (sim.converged) break;
    }
    expect(sim.converged).toBe(true);
    expect(ticks).toBeLessThan(RECOOL_TICKS);
  });

  it("is not converged while accelerating from rest", () => {
    // A layout starting at rest takes small first steps however far from equilibrium it is.
    const g = buildGraph({ nodeCount: 2, source: [], target: [] });
    g.positions.set([0, 0, 1, 0]);
    const sim = new ForceLayout(g);
    sim.tick();
    expect(sim.converged).toBe(false);
  });

  it("a model without an equilibrium spacing runs its whole budget", () => {
    const g = ringOfCliques(4, 4);
    seedPositions(g, 400, 400);
    expect(new ForceLayout(g, { centering: 0 }).run(40)).toBe(40);
  });
});

describe("seedPositions", () => {
  it("with force params, sizes the disc to the equilibrium instead of the viewport", () => {
    const n = 500;
    const g = buildGraph({ nodeCount: n, source: [], target: [] });
    seedPositions(g, 200, 100);
    expect(r95(g.positions, n)).toBeLessThan(55); // viewport disc: radius min(w, h) / 2
    seedPositions(g, 200, 100, { force: { repulsion: 50 } });
    const R = Math.sqrt((50 * n) / DEFAULT_FORCE.centering);
    expect(r95(g.positions, n) / (Math.sqrt(0.95) * R)).toBeCloseTo(1, 1);
    expect(g.positions[0]! + g.positions[2]!).not.toBe(0); // still centred on the viewport (100, 50)
    seedPositions(g, 200, 100, { force: { centering: 0 } }); // no equilibrium → viewport disc
    expect(r95(g.positions, n)).toBeLessThan(55);
  });

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
