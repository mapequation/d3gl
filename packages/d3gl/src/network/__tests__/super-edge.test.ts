import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type LODTree } from "../index.js";

/** Balanced tree: leaves 0,1 in module 4; leaves 2,3 in module 5; both under root 6. */
const RECORDS = [
  { id: 0, path: [1, 1] },
  { id: 1, path: [1, 2] },
  { id: 2, path: [2, 1] },
  { id: 3, path: [2, 2] },
];

/** Directed super-edges out of tree node `g`, as sorted `[target, flow]` pairs. */
function superOut(tree: LODTree, g: number): [number, number][] {
  const off = tree.superEdgeOffset!;
  const out: [number, number][] = [];
  for (let p = off[g]!; p < off[g + 1]!; p++) out.push([tree.superEdgeTarget![p]!, tree.superEdgeFlow![p]!]);
  return out.sort((a, b) => a[0] - b[0]);
}

describe("directed module super-edges", () => {
  it("adds a directed entry at every level from the crossing leaves up to their common module", () => {
    // A single cross-module edge 0→2 (flow 3): leaves 0 and 2 differ, and so do their modules 4, 5.
    const tree = buildModuleLODTree(4, RECORDS, { source: [0], target: [2], weight: [3] });
    expect(superOut(tree, 0)).toEqual([[2, 3]]); // leaf level
    expect(superOut(tree, 4)).toEqual([[5, 3]]); // module level
    // Nothing in the reverse direction or off the other nodes.
    expect(superOut(tree, 2)).toEqual([]);
    expect(superOut(tree, 5)).toEqual([]);
    expect(superOut(tree, 6)).toEqual([]); // root: both endpoints share it (LCA), so no self-edge
  });

  it("sums flow over edges that cross the same module pair, keeping leaf entries distinct", () => {
    // 0→2 (flow 1) and 1→3 (flow 4) both cross module 4 → module 5.
    const tree = buildModuleLODTree(4, RECORDS, { source: [0, 1], target: [2, 3], weight: [1, 4] });
    expect(superOut(tree, 0)).toEqual([[2, 1]]);
    expect(superOut(tree, 1)).toEqual([[3, 4]]);
    expect(superOut(tree, 4)).toEqual([[5, 5]]); // 1 + 4 summed at the module level
  });

  it("ignores intra-module edges and self-loops (no crossing → no super-edge)", () => {
    // 0→1 is within module 4; 2→2 is a self-loop.
    const tree = buildModuleLODTree(4, RECORDS, { source: [0, 2], target: [1, 2], weight: [1, 1] });
    // 0→1 is a real leaf-level crossing (different leaves, same module) — entry at the leaf level only.
    expect(superOut(tree, 0)).toEqual([[1, 1]]);
    expect(superOut(tree, 4)).toEqual([]); // no edge leaves module 4
    expect(superOut(tree, 2)).toEqual([]); // self-loop dropped
  });

  it("omits super-edges entirely when no edges are passed (N6a node-only behaviour)", () => {
    const tree = buildModuleLODTree(4, RECORDS);
    expect(tree.superEdgeOffset).toBeUndefined();
  });
});
