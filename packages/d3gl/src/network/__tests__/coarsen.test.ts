import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { coarsenLevel, buildHierarchy, multilevelLayout, type CoarseLevel } from "../coarsen.js";
import { ForceLayout, seedPositions } from "../force.js";

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

  it("aggregates parallel coarse edges, drops internal (self) edges, makes a singleton when no unmatched neighbour remains", () => {
    // Triangle 0=1 (w2), 0-2 (w1), 1-2 (w1): 0 matches 1 (heaviest); 2 is left a singleton.
    const { coarse, projection } = coarsenLevel(
      level(3, [
        [0, 1, 2],
        [0, 2, 1],
        [1, 2, 1],
      ]),
    );

    expect(Array.from(projection)).toEqual([0, 0, 1]);
    expect(coarse.nodeCount).toBe(2);
    // 0-2 and 1-2 both become coarse 0-1; weights sum; the internal 0-1 edge is dropped.
    expect(edgeSet(coarse)).toEqual(["0-1:2"]);
  });

  it("leaves an edgeless graph fully unmatched (no reduction)", () => {
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

  it("converges to a better (less tangled) clustered layout than a cold start at equal iterations", () => {
    const cold = ringOfCliques(16, 6);
    const multi = ringOfCliques(16, 6);
    const iterations = 80;

    seedPositions(cold, 800, 600);
    new ForceLayout(cold).run(iterations);
    multilevelLayout(multi, { width: 800, height: 600, iterations });

    expect(tangleRatio(multi)).toBeLessThan(tangleRatio(cold));
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
