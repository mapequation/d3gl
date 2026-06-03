import { describe, it, expect } from "vitest";
import type { TreeNode } from "./tree.js";
import {
  calcMaximumParsimonyPreliminaryPhase,
  calcMaximumParsimony,
  aggregateClusters,
  aggregateSpeciesCount,
  type ClustersPerSpecies,
} from "./parsimony.js";

// --- tiny builders -----------------------------------------------------------
function leaf(name: string): TreeNode { return { name, group: 0, length: 1, time: 0 }; }
function node(name: string, ...children: TreeNode[]): TreeNode {
  return { name, group: 0, length: 1, time: 1, children };
}

// Bioregion ids used in the Fitch figures: A=0, C=1, G=2.
const A = 0, C = 1, G = 2;
function cps(spec: Record<string, number[]>): ClustersPerSpecies {
  const out: ClustersPerSpecies = {};
  for (const [name, ids] of Object.entries(spec)) {
    out[name] = { totCount: ids.length, clusters: ids.map((clusterId) => ({ clusterId, count: 1 })) };
  }
  return out;
}

function find(root: TreeNode, name: string): TreeNode {
  let found: TreeNode | undefined;
  const walk = (n: TreeNode): void => { if (n.name === name) found = n; n.children?.forEach(walk); };
  walk(root);
  if (!found) throw new Error(`no node ${name}`);
  return found;
}
/** Sorted bioregion ids at a node — order-independent set comparison. */
function regions(root: TreeNode, name: string): number[] {
  return (find(root, name).ranges?.clusters ?? []).map((r) => r.clusterId).sort((a, b) => a - b);
}

// Fitch fig. 2 topologies.
const tree3 = (): TreeNode => node("root", node("0", leaf("00"), leaf("01")), leaf("1"));
const tree4 = (): TreeNode => node("root", node("0", node("00", leaf("000"), leaf("001")), leaf("01")), leaf("1"));

describe("calcMaximumParsimonyPreliminaryPhase", () => {
  it("fig 2a: intersection then union (bottom-up)", () => {
    const t = calcMaximumParsimonyPreliminaryPhase(tree3(), cps({ "00": [A], "01": [C], "1": [A] }));
    expect(regions(t, "0")).toEqual([A, C]); // union (disjoint children)
    expect(regions(t, "root")).toEqual([A]); // intersection {A,C}∩{A}
  });
  it("fig 2c: union propagates up when intersection empty", () => {
    const t = calcMaximumParsimonyPreliminaryPhase(tree3(), cps({ "00": [A], "01": [C], "1": [G] }));
    expect(regions(t, "0")).toEqual([A, C]);
    expect(regions(t, "root")).toEqual([A, C, G]);
  });
  it("fig 2e: deeper tree", () => {
    const t = calcMaximumParsimonyPreliminaryPhase(tree4(), cps({ "000": [A], "001": [C], "01": [A], "1": [C] }));
    expect(regions(t, "00")).toEqual([A, C]);
    expect(regions(t, "0")).toEqual([A]);
    expect(regions(t, "root")).toEqual([A, C]);
  });
});

// Two-phase Fitch results below are the GENUINELY-CORRECT optimal-state sets (verified by
// hand against the most-parsimonious reconstructions), NOT the bioregions1 outputs — its
// final phase reads node.byUnion instead of node.clusters.byUnion, so Rule IV never fires
// and Rules IV/V are effectively skipped, producing wrong sets for figs 2d and 2f.
describe("calcMaximumParsimony (two-phase, correct Fitch rules)", () => {
  it("fig 2b: node 0 → {A} (Rule II)", () => {
    const t = calcMaximumParsimony(tree3(), cps({ "00": [A], "01": [C], "1": [A] }));
    expect(regions(t, "0")).toEqual([A]);
    expect(regions(t, "root")).toEqual([A]);
  });
  it("fig 2d: node 0 → {A,C,G} (Rule IV, expanded ambiguity)", () => {
    // {A,C}∪{G} all reach optimal cost 2: node0 ∈ {A,C,G} all appear in some MPR.
    const t = calcMaximumParsimony(tree3(), cps({ "00": [A], "01": [C], "1": [G] }));
    expect(regions(t, "0")).toEqual([A, C, G]);
    expect(regions(t, "root")).toEqual([A, C, G]);
  });
  it("fig 2f: nodes 00 and 0 → {A,C} (Rule V, encompassing ambiguity)", () => {
    // MPRs (cost 2): (00,0,root) ∈ {(A,A,A),(A,A,C),(C,C,C)} ⇒ 00,0,root all = {A,C}.
    const t = calcMaximumParsimony(tree4(), cps({ "000": [A], "001": [C], "01": [A], "1": [C] }));
    expect(regions(t, "00")).toEqual([A, C]);
    expect(regions(t, "0")).toEqual([A, C]);
    expect(regions(t, "1")).toEqual([C]);
    expect(regions(t, "root")).toEqual([A, C]);
  });
  it("leaves keep their assigned distribution", () => {
    const t = calcMaximumParsimony(tree3(), cps({ "00": [A], "01": [C], "1": [A] }));
    expect(regions(t, "00")).toEqual([A]);
    expect(regions(t, "01")).toEqual([C]);
  });
});

// Rigorous correctness check: for single-region leaves (classic Fitch), the final set at
// each internal node must equal the set of states it takes in SOME minimum-cost full
// assignment. Brute-force that over many random trees and compare to calcMaximumParsimony.
describe("calcMaximumParsimony equals brute-force optimal-state sets (random trees)", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function randomTree(n: number, rnd: () => number, ctr: { i: number }, R: number): TreeNode {
    if (n <= 1) { const region = Math.floor(rnd() * R); return { name: `L${ctr.i++}`, group: 0, length: 1, time: 0, _region: region } as TreeNode & { _region: number }; }
    const left = 1 + Math.floor(rnd() * (n - 1));
    return { name: `I${ctr.i++}`, group: 0, length: 1, time: 1, children: [randomTree(left, rnd, ctr, R), randomTree(n - left, rnd, ctr, R)] };
  }
  function leafRegion(n: TreeNode): number { return (n as TreeNode & { _region: number })._region; }

  function bruteForceSets(root: TreeNode, R: number): Map<TreeNode, Set<number>> {
    const internals: TreeNode[] = [];
    const collect = (n: TreeNode): void => { if (n.children) { internals.push(n); n.children.forEach(collect); } };
    collect(root);
    const k = internals.length;
    const state = new Map<TreeNode, number>();
    const cost = (): number => {
      let c = 0;
      const walk = (n: TreeNode): void => {
        if (!n.children) return;
        const s = state.get(n)!;
        for (const ch of n.children) { c += (ch.children ? state.get(ch)! : leafRegion(ch)) !== s ? 1 : 0; walk(ch); }
      };
      walk(root);
      return c;
    };
    let best = Infinity;
    const sets = new Map<TreeNode, Set<number>>(internals.map((n) => [n, new Set<number>()]));
    const total = R ** k;
    for (let code = 0; code < total; code++) {
      let c = code;
      for (const n of internals) { state.set(n, c % R); c = Math.floor(c / R); }
      const cc = cost();
      if (cc < best) { best = cc; for (const n of internals) sets.set(n, new Set([state.get(n)!])); }
      else if (cc === best) { for (const n of internals) sets.get(n)!.add(state.get(n)!); }
    }
    return sets;
  }

  it("matches on 60 random trees", () => {
    const R = 3;
    for (let trial = 0; trial < 60; trial++) {
      const rnd = mulberry32(trial + 1);
      const nLeaves = 3 + Math.floor(rnd() * 5); // 3..7 leaves → ≤6 internal, 3^6 enum
      const tree = randomTree(nLeaves, rnd, { i: 0 }, R);
      const cps: ClustersPerSpecies = {};
      const collectLeaves = (n: TreeNode): void => { if (n.children) n.children.forEach(collectLeaves); else cps[n.name] = { totCount: 1, clusters: [{ clusterId: leafRegion(n), count: 1 }] }; };
      collectLeaves(tree);
      const expected = bruteForceSets(tree, R);
      calcMaximumParsimony(tree, cps);
      for (const [node, want] of expected) {
        const got = new Set((node.ranges?.clusters ?? []).map((r) => r.clusterId));
        expect([...got].sort()).toEqual([...want].sort());
      }
    }
  });
});

describe("aggregateClusters (occurrence counts summed up the tree)", () => {
  const t = (): TreeNode => node("r", node("x", node("y", leaf("a"), leaf("b")), leaf("c")), node("z", leaf("d")));
  // a: A×3 · b: A×2,C×1 · c: none · d: C×4
  const data: ClustersPerSpecies = {
    a: { totCount: 3, clusters: [{ clusterId: A, count: 3 }] },
    b: { totCount: 3, clusters: [{ clusterId: A, count: 2 }, { clusterId: C, count: 1 }] },
    d: { totCount: 4, clusters: [{ clusterId: C, count: 4 }] },
  };
  const countOf = (root: TreeNode, name: string): Record<number, number> =>
    Object.fromEntries((find(root, name).clusters?.clusters ?? []).map((r) => [r.clusterId, r.count]));

  it("sums leaf counts up the tree and reports totCount", () => {
    const root = aggregateClusters(t(), data);
    expect(countOf(root, "a")).toEqual({ [A]: 3 });
    expect(countOf(root, "y")).toEqual({ [A]: 5, [C]: 1 });   // a+b
    expect(countOf(root, "x")).toEqual({ [A]: 5, [C]: 1 });   // +c (empty)
    expect(countOf(root, "r")).toEqual({ [A]: 5, [C]: 5 });   // +d
    expect(find(root, "r").clusters?.totCount).toBe(10);
  });

  it("sorts a node's regions by descending count", () => {
    const root = aggregateClusters(t(), data);
    const yc = find(root, "y").clusters!.clusters;
    expect(yc.map((r) => r.clusterId)).toEqual([A, C]); // 5 before 1
  });
});

describe("aggregateSpeciesCount", () => {
  const t = (): TreeNode => node("r", node("x", node("y", leaf("a"), leaf("b")), leaf("c")), node("z", leaf("d")));

  it("counts subtended terminals (all present by default)", () => {
    const root = aggregateSpeciesCount(t());
    expect(find(root, "a").speciesCount).toBe(1);
    expect(find(root, "y").speciesCount).toBe(2);
    expect(find(root, "x").speciesCount).toBe(3);
    expect(find(root, "z").speciesCount).toBe(1);
    expect(find(root, "r").speciesCount).toBe(4);
  });
  it("respects a presence map (absent species count 0)", () => {
    const root = aggregateSpeciesCount(t(), { a: 5, b: 2, d: 3 }); // c absent
    expect(find(root, "c").speciesCount).toBe(0);
    expect(find(root, "x").speciesCount).toBe(2); // a,b present; c absent
    expect(find(root, "r").speciesCount).toBe(3); // a,b,d
  });
});
