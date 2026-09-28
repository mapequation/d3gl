import { describe, it, expect, vi } from "vitest";
import { buildGraph } from "../graph.js";
import {
  coarsenLevel,
  buildHierarchy,
  multilevelLayout,
  multilevelSeed,
  multilevelSeedSteps,
  type CoarseLevel,
  type SeedProgress,
} from "../coarsen.js";
import { DEFAULT_FORCE, ForceLayout, seedPositions } from "../force.js";
import { BarnesHutTree } from "../quadtree.js";

const level = (nodeCount: number, edges: [number, number, number][]): CoarseLevel => ({
  nodeCount,
  source: Uint32Array.from(edges.map((e) => e[0])),
  target: Uint32Array.from(edges.map((e) => e[1])),
  weight: Float32Array.from(edges.map((e) => e[2])),
});

/** Collect a level's undirected edges as a sorted `"a-b:w"` set for order-independent comparison. */
const edgeSet = (l: CoarseLevel): string[] => {
  const out: string[] = [];
  for (let e = 0; e < l.source.length; e++) {
    const a = Math.min(l.source[e]!, l.target[e]!);
    const b = Math.max(l.source[e]!, l.target[e]!);
    out.push(`${a}-${b}:${l.weight[e]}`);
  }
  return out.sort();
};

describe("coarsenLevel (heavy-edge matching)", () => {
  it("matches each node to its heaviest unmatched neighbour", () => {
    // 0=1 (w3) -- 1-2 (w1) -- 2=3 (w3): the two heavy edges collapse, the light bridge survives.
    const { coarse, projection } = coarsenLevel(
      level(4, [
        [0, 1, 3],
        [1, 2, 1],
        [2, 3, 3],
      ]),
    );

    expect(Array.from(projection)).toEqual([0, 0, 1, 1]);
    expect(coarse.nodeCount).toBe(2);
    expect(edgeSet(coarse)).toEqual(["0-1:1"]);
  });

  it("adopts a node with no unmatched neighbour into its heaviest matched neighbour's group", () => {
    // Triangle 0=1 (w2), 0-2 (w1), 1-2 (w1): 0 matches 1; node 2 has no unmatched neighbour, so it
    // adopts into their group rather than becoming a singleton → the dense triangle collapses to one.
    const { coarse, projection } = coarsenLevel(
      level(3, [
        [0, 1, 2],
        [0, 2, 1],
        [1, 2, 1],
      ]),
    );

    expect(Array.from(projection)).toEqual([0, 0, 0]);
    expect(coarse.nodeCount).toBe(1);
    expect(coarse.source.length).toBe(0); // every edge is now internal
  });

  it("collapses a star via adoption instead of stalling (the power-law coarsening fix, #117)", () => {
    // Hub 0 + 12 leaves: heavy-edge matching alone pairs one leaf and strands the other 11 as
    // singletons (≈ no reduction → the level-cap stall). Adoption pulls every leaf into the hub group.
    const edges: [number, number, number][] = [];
    for (let i = 1; i < 13; i++) edges.push([0, i, 1]);
    const { coarse } = coarsenLevel(level(13, edges));
    expect(coarse.nodeCount).toBe(1);
  });

  it("halves a path without over-collapsing (adoption only fires for stragglers)", () => {
    // Path 0-1-…-9: matching always finds an unmatched neighbour, so it pairs (no adoption) → 5.
    const edges: [number, number, number][] = [];
    for (let i = 0; i < 9; i++) edges.push([i, i + 1, 1]);
    const { coarse } = coarsenLevel(level(10, edges));
    expect(coarse.nodeCount).toBe(5);
  });

  it("leaves an edgeless graph fully unmatched (no reduction, no adoption)", () => {
    const { coarse, projection } = coarsenLevel(level(3, []));
    expect(Array.from(projection)).toEqual([0, 1, 2]);
    expect(coarse.nodeCount).toBe(3);
    expect(coarse.source.length).toBe(0);
  });
});

describe("buildHierarchy", () => {
  it("produces strictly coarsening levels with valid, composable projections", () => {
    // 4×4 grid graph (16 nodes).
    const src: number[] = [];
    const tgt: number[] = [];
    const idx = (r: number, c: number) => r * 4 + c;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        if (c < 3) (src.push(idx(r, c)), tgt.push(idx(r, c + 1)));
        if (r < 3) (src.push(idx(r, c)), tgt.push(idx(r + 1, c)));
      }
    const g = buildGraph({ nodeCount: 16, source: src, target: tgt });

    const h = buildHierarchy(g, { minNodes: 2 });

    expect(h.levels[0]!.nodeCount).toBe(16);
    expect(h.projections.length).toBe(h.levels.length - 1);
    // Strictly decreasing node counts.
    for (let k = 1; k < h.levels.length; k++) {
      expect(h.levels[k]!.nodeCount).toBeLessThan(h.levels[k - 1]!.nodeCount);
    }
    // Coarsest is small.
    expect(h.levels[h.levels.length - 1]!.nodeCount).toBeLessThanOrEqual(2 * 2); // ≤ minNodes after the last reducing pass
    // Each projection maps every node into the next level's id range.
    for (let k = 0; k < h.projections.length; k++) {
      const p = h.projections[k]!;
      expect(p.length).toBe(h.levels[k]!.nodeCount);
      for (const c of p) expect(c).toBeLessThan(h.levels[k + 1]!.nodeCount);
    }
  });
});

/** Build a ring of `C` cliques of size `S`, consecutive cliques joined by one bridge edge. */
function ringOfCliques(C: number, S: number) {
  const source: number[] = [];
  const target: number[] = [];
  for (let c = 0; c < C; c++) {
    const base = c * S;
    for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) (source.push(base + i), target.push(base + j));
    const next = ((c + 1) % C) * S;
    source.push(base); // bridge: first node of this clique → first node of next
    target.push(next);
  }
  return buildGraph({ nodeCount: C * S, source, target });
}

/** 95th-percentile distance from the centroid. */
function r95(p: Float32Array, n: number): number {
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += p[i * 2]!; cy += p[i * 2 + 1]!; }
  cx /= n; cy /= n;
  const r = Array.from({ length: n }, (_, i) => Math.hypot(p[i * 2]! - cx, p[i * 2 + 1]! - cy)).sort((a, b) => a - b);
  return r[Math.floor(0.95 * (n - 1))]!;
}

const dist = (p: Float32Array, a: number, b: number) =>
  Math.hypot(p[a * 2]! - p[b * 2]!, p[a * 2 + 1]! - p[b * 2 + 1]!);

/** Mean edge length / mean all-pairs distance — lower means a tighter, less tangled layout. */
function tangleRatio(g: ReturnType<typeof ringOfCliques>): number {
  let edgeSum = 0;
  for (let e = 0; e < g.edgeCount; e++) edgeSum += dist(g.positions, g.source[e]!, g.target[e]!);
  let pairSum = 0;
  let pairs = 0;
  for (let i = 0; i < g.nodeCount; i++)
    for (let j = i + 1; j < g.nodeCount; j++) (pairSum += dist(g.positions, i, j), pairs++);
  return edgeSum / g.edgeCount / (pairSum / pairs);
}

describe("multilevelLayout", () => {
  it("is deterministic and leaves all positions finite", () => {
    const g1 = ringOfCliques(8, 5);
    const g2 = ringOfCliques(8, 5);
    multilevelLayout(g1, { width: 800, height: 600, iterations: 60 });
    multilevelLayout(g2, { width: 800, height: 600, iterations: 60 });

    expect(Array.from(g1.positions).every(Number.isFinite)).toBe(true);
    expect(Array.from(g1.positions)).toEqual(Array.from(g2.positions));
  });

  it("caps the solve on levels above maxSeedNodes yet still lays out tightly (#117)", () => {
    // Force the cap to bite even on a small graph (larger levels get a proportionally shorter solve,
    // or none). The finest refinement still produces a finite, well-clustered layout.
    const g = ringOfCliques(16, 6); // 96 nodes
    multilevelLayout(g, { width: 800, height: 600, iterations: 60, maxSeedNodes: 8 });

    expect(Array.from(g.positions).every(Number.isFinite)).toBe(true);
    expect(tangleRatio(g)).toBeLessThan(0.5); // still tight, not a tangled mess
  });

  it("converges to a better (less tangled) clustered layout than a cold start at equal iterations", () => {
    const cold = ringOfCliques(16, 6);
    const multi = ringOfCliques(16, 6);
    const iterations = 80;

    // The cold start as the backends run it: an equilibrium-scale disc at full heat.
    seedPositions(cold, 800, 600, { force: {} });
    new ForceLayout(cold).run(iterations, "hot");
    multilevelLayout(multi, { width: 800, height: 600, iterations });

    expect(tangleRatio(multi)).toBeLessThan(tangleRatio(cold));
  });

  it("seeds at the force equilibrium's scale, so the refinement neither explodes nor collapses", () => {
    // The finest layout settles into a disc of radius R = √(repulsion·N/centering). The seed must
    // already be there — mass-weighted coarse levels + mass-proportional prolongation — instead of
    // the old viewport-sized seed that the refinement then blew up ~2.7× past its final extent.
    const g = ringOfCliques(100, 12); // 1200 nodes
    const n = g.nodeCount;
    multilevelSeed(g, { width: 800, height: 600 });
    const R95 = Math.sqrt(0.95) * Math.sqrt((DEFAULT_FORCE.repulsion * n) / DEFAULT_FORCE.centering);
    expect(r95(g.positions, n) / R95).toBeGreaterThan(0.75);
    expect(r95(g.positions, n) / R95).toBeLessThan(1.25);

    const sim = new ForceLayout(g);
    sim.cool(300);
    let peak = r95(g.positions, n);
    let ticks = 0;
    while (ticks < 300) {
      sim.tick();
      ticks++;
      peak = Math.max(peak, r95(g.positions, n));
      if (sim.converged) break;
    }
    const final = r95(g.positions, n);
    expect(peak / final).toBeLessThan(1.3); // no explosion
    expect(final / R95).toBeGreaterThan(0.75); // no collapse
    expect(ticks).toBeLessThan(300); // converged before the budget
  });

  it("bounds the seed's solve work at coarsenIterations · maxSeedNodes node-ticks per level", () => {
    // Count every coarse-level Barnes-Hut build (one per tick) weighted by its node count.
    const g = ringOfCliques(64, 12); // 768 nodes → several levels above the tiny cap
    const hierarchy = buildHierarchy(g);
    const levels = hierarchy.levels.length;
    const spy = vi.spyOn(BarnesHutTree.prototype, "build");
    multilevelSeed(g, { width: 800, height: 600, coarsenIterations: 10, maxSeedNodes: 16 }, hierarchy);
    const sizes = spy.mock.calls.map((call) => call[1]);
    spy.mockRestore();
    const nodeTicks = sizes.reduce((sum, n) => sum + n, 0);
    expect(nodeTicks).toBeGreaterThan(0);
    expect(nodeTicks).toBeLessThanOrEqual((levels - 1) * 10 * 16);
    // Levels past coarsenIterations · maxSeedNodes nodes are prolongated through, never solved.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(160);
    expect(hierarchy.levels.some((l, k) => k > 0 && l.nodeCount > 160)).toBe(true); // …and there is one
  });

  it("keeps clusters distinct but compact — inter-cluster spacing within a few × the cluster size", () => {
    // Regression guard: the default positional gravity (centering) must stop loosely-bridged
    // cliques from flying far apart (was ~9× the cluster size with weak gravity).
    const C = 30;
    const S = 10;
    const g = ringOfCliques(C, S);
    multilevelLayout(g, { width: 800, height: 600, iterations: 120 });

    // intra: mean within-clique pairwise distance; inter: mean adjacent-clique centroid distance.
    let intra = 0;
    let intraN = 0;
    const cx: number[] = [];
    const cy: number[] = [];
    for (let c = 0; c < C; c++) {
      const base = c * S;
      let mx = 0;
      let my = 0;
      for (let i = 0; i < S; i++) {
        mx += g.positions[(base + i) * 2]!;
        my += g.positions[(base + i) * 2 + 1]!;
        for (let j = i + 1; j < S; j++) (intra += dist(g.positions, base + i, base + j), intraN++);
      }
      cx.push(mx / S);
      cy.push(my / S);
    }
    intra /= intraN;
    let inter = 0;
    for (let c = 0; c < C; c++) inter += Math.hypot(cx[c]! - cx[(c + 1) % C]!, cy[c]! - cy[(c + 1) % C]!);
    inter /= C;

    const ratio = inter / intra;
    expect(ratio).toBeGreaterThan(1.5); // clusters stay separated, not collapsed into one blob
    expect(ratio).toBeLessThan(6); // …but compact, not flung apart
  });
});

describe("multilevelSeedSteps (#368)", () => {
  const W = 800;
  const H = 600;

  it("drains to multilevelSeed's exact seed, even when every step is prolongated along the way", () => {
    const plain = ringOfCliques(100, 12); // 1200 nodes
    const stepped = ringOfCliques(100, 12);
    multilevelSeed(plain, { width: W, height: H });
    let steps = 0;
    for (const step of multilevelSeedSteps(stepped, { width: W, height: H })) {
      step.prolongate(); // scratch writes into the finer levels + graph.positions must not leak into the seed
      steps++;
    }
    expect(steps).toBeGreaterThan(0); // one per coarse tick
    expect(Array.from(stepped.positions)).toEqual(Array.from(plain.positions));
  });

  it("yields once per coarse tick the seed runs", () => {
    const g = ringOfCliques(64, 12); // 768 nodes
    const hierarchy = buildHierarchy(g);
    const spy = vi.spyOn(BarnesHutTree.prototype, "build"); // one build per tick
    let steps = 0;
    for (const _step of multilevelSeedSteps(g, { width: W, height: H, coarsenIterations: 10, maxSeedNodes: 16 }, hierarchy)) steps++;
    const ticks = spy.mock.calls.length;
    spy.mockRestore();
    expect(ticks).toBeGreaterThan(0);
    expect(steps).toBe(ticks);
  });

  it("flags the steps drawn at the finished seed's extent: every node, finite, centred, no jump into the seed", () => {
    // Each progress frame is the level being solved, spread over its finer levels as if those were
    // unsolved, at the equilibrium density. The coarsest levels are a handful of mass-sized discs that
    // pack with gaps — wider than the seed — so only a level of about a thousand nodes or more is
    // `atScale`: from the first frame a caller shows, the fitted view and the LOD extents hold still
    // into the refinement.
    const g = ringOfCliques(2000, 10); // 20k nodes: levels from 7 to 10000 nodes
    const n = g.nodeCount;
    const R95 = Math.sqrt(0.95) * Math.sqrt((DEFAULT_FORCE.repulsion * n) / DEFAULT_FORCE.centering);
    const coarse: number[] = [];
    const atScale: number[] = [];
    const flags: boolean[] = [];
    let level: SeedProgress | null = null;
    for (const step of multilevelSeedSteps(g, { width: W, height: H })) {
      flags.push(step.atScale);
      if (step === level) continue; // one progress object per level: measure each level's first tick
      level = step;
      g.positions.fill(Number.NaN); // prove the step writes every node
      step.prolongate();
      expect(g.positions.every(Number.isFinite)).toBe(true);
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) (cx += g.positions[i * 2] ?? 0, cy += g.positions[i * 2 + 1] ?? 0);
      expect(Math.hypot(cx / n - W / 2, cy / n - H / 2)).toBeLessThan(0.05 * R95); // centred on the viewport
      (step.atScale ? atScale : coarse).push(r95(g.positions, n));
    }
    const seed = r95(g.positions, n); // the drained generator left the finished seed
    expect(seed / R95).toBeGreaterThan(0.9); // …at the force equilibrium
    expect(seed / R95).toBeLessThan(1.1);
    expect(flags.indexOf(true)).toBeGreaterThan(0); // coarse first, then at scale for good
    expect(flags.lastIndexOf(false)).toBe(flags.indexOf(true) - 1);
    // Why the gate: the coarsest level spans ~1.25x the seed (web-NotreDame 1.4x, a scale-free graph 2.4x).
    expect(Math.max(...coarse) / seed).toBeGreaterThan(1.15);
    expect(atScale.length).toBeGreaterThan(1);
    for (const r of atScale) {
      expect(r / seed).toBeGreaterThan(0.9);
      expect(r / seed).toBeLessThan(1.1);
    }
  });

  it("yields nothing for a graph with no coarsening (the disc seed)", () => {
    const g = buildGraph({ nodeCount: 5, source: [], target: [] });
    expect([...multilevelSeedSteps(g, { width: W, height: H })]).toEqual([]);
    expect(g.positions.every(Number.isFinite)).toBe(true);
  });
});
