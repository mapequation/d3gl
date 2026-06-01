import { describe, it, expect } from "vitest";
import type { TreeNode } from "./tree.js";
import {
  calcMaximumParsimonyPreliminaryPhase,
  calcMaximumParsimony,
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

describe("calcMaximumParsimony (two-phase)", () => {
  it("fig 2b: final phase narrows node 0 to {A}", () => {
    const t = calcMaximumParsimony(tree3(), cps({ "00": [A], "01": [C], "1": [A] }));
    expect(regions(t, "0")).toEqual([A]);
    expect(regions(t, "root")).toEqual([A]);
  });
  it("fig 2d: node 0 stays {A,C}, root {A,C,G}", () => {
    const t = calcMaximumParsimony(tree3(), cps({ "00": [A], "01": [C], "1": [G] }));
    expect(regions(t, "0")).toEqual([A, C]);
    expect(regions(t, "root")).toEqual([A, C, G]);
  });
  it("fig 2f: node 00 narrows to {A}", () => {
    const t = calcMaximumParsimony(tree4(), cps({ "000": [A], "001": [C], "01": [A], "1": [C] }));
    expect(regions(t, "00")).toEqual([A]);
    expect(regions(t, "0")).toEqual([A]);
    expect(regions(t, "1")).toEqual([C]);
    expect(regions(t, "root")).toEqual([A, C]);
  });
  it("leaves keep their assigned distribution", () => {
    const t = calcMaximumParsimony(tree3(), cps({ "00": [A], "01": [C], "1": [A] }));
    expect(regions(t, "00")).toEqual([A]);
    expect(regions(t, "01")).toEqual([C]);
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
