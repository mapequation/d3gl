import { describe, it, expect } from "vitest";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle, cut } from "../lod.js";

/** Children of tree node `g`, as a sorted array (scatter order is an implementation detail). */
function childrenOf(tree: { childOffset: Uint32Array; children: Uint32Array }, g: number): number[] {
  return Array.from(tree.children.slice(tree.childOffset[g]!, tree.childOffset[g + 1]!)).sort((a, b) => a - b);
}

/**
 * Balanced two-module tree (Infomap JSON node shape): nodes 0,1 in module `1`; nodes 2,3 in module
 * `2`; both modules under the root. `path` is Infomap's 1-based child-index chain, so the module of
 * a node is `path.slice(0, -1)`.
 */
function balanced() {
  return buildModuleLODTree(4, [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [2, 2] },
  ]);
}

describe("buildModuleLODTree", () => {
  it("turns a balanced module tree into a leaves-first LOD tree with the root as the single coarsest node", () => {
    const tree = balanced();

    expect(tree.leafCount).toBe(4);
    expect(tree.size).toBe(7); // 4 leaves + 2 modules + root
    expect(tree.levelCount).toBe(3); // leaves (h0), modules (h1), root (h2)
    expect(Array.from(tree.levelOffset)).toEqual([0, 4, 6, 7]);

    // Modules 4 = {0,1}, 5 = {2,3}; root 6 = {4,5}. Leaves have no children.
    expect(childrenOf(tree, 4)).toEqual([0, 1]);
    expect(childrenOf(tree, 5)).toEqual([2, 3]);
    expect(childrenOf(tree, 6)).toEqual([4, 5]);
    expect(childrenOf(tree, 0)).toEqual([]);

    // No super-edges in N6a (deferred to N6c): adjacency is empty.
    expect(tree.edgeNeighbors.length).toBe(0);
    expect(tree.edgeOffset[tree.size]).toBe(0);
  });

  it("levels a ragged tree by height so every node's children sit in a strictly lower level", () => {
    // node 0 is a shallow leaf in module `1`; nodes 1,2 are deep in module `2:1`.
    const tree = buildModuleLODTree(3, [
      { id: 0, path: [1, 1] },
      { id: 1, path: [2, 1, 1] },
      { id: 2, path: [2, 1, 2] },
    ]);

    // Heights: leaves 0; modules `1` and `2:1` are 1; module `2` is 2; root is 3.
    expect(tree.levelCount).toBe(4);
    expect(tree.size).toBe(3 + 4); // 3 leaves + {`1`, `2:1`, `2`, root}
    expect(Array.from(tree.levelOffset)).toEqual([0, 3, 5, 6, 7]);

    // Module `1` (h1, id 3) -> {0}; module `2:1` (h1, id 4) -> {1,2}; module `2` (h2, id 5) -> {4};
    // root (h3, id 6) -> {3, 5}. Every child id < its parent id, and child level < parent level.
    expect(childrenOf(tree, 3)).toEqual([0]);
    expect(childrenOf(tree, 4)).toEqual([1, 2]);
    expect(childrenOf(tree, 5)).toEqual([4]);
    expect(childrenOf(tree, 6)).toEqual([3, 5]);
  });

  it("attaches a top-level leaf (path length 1) directly to the root", () => {
    // node 0 sits at the top level (no enclosing module); nodes 1,2 are in module `2`.
    const tree = buildModuleLODTree(3, [
      { id: 0, path: [1] },
      { id: 1, path: [2, 1] },
      { id: 2, path: [2, 2] },
    ]);
    // Module `2` (h1, id 3) -> {1,2}; root (h2, id 4) -> {0, 3}.
    expect(tree.levelCount).toBe(3);
    expect(childrenOf(tree, 3)).toEqual([1, 2]);
    expect(childrenOf(tree, 4)).toEqual([0, 3]);
  });

  describe("the adaptive cut walks the module tree", () => {
    // Two tight clusters far apart: {0@(0,0),1@(4,0)} and {2@(96,0),3@(100,0)}.
    function geo() {
      const tree = balanced();
      computeLODPositions(tree, new Float32Array([0, 0, 4, 0, 96, 0, 100, 0]));
      computeLODStyle(tree, new Float32Array([4, 4, 4, 4]), new Float32Array([1, 1, 1, 1]));
      return tree;
    }
    const W = 2000;
    const H = 2000;
    // Centre the content (centroid x≈50) in the viewport at scale k.
    const view = (k: number) => ({ k, x: W / 2 - 50 * k, y: H / 2 });
    const sortedCut = (tree: ReturnType<typeof geo>, k: number) =>
      Array.from(cut(tree, view(k), W, H)).sort((a, b) => a - b);

    it("draws the root alone when zoomed far out", () => {
      expect(sortedCut(geo(), 0.1)).toEqual([6]);
    });
    it("draws the two modules at mid zoom (root expanded, modules not yet)", () => {
      expect(sortedCut(geo(), 1)).toEqual([4, 5]);
    });
    it("expands modules into their leaves when zoomed in", () => {
      expect(sortedCut(geo(), 12)).toEqual([0, 1, 2, 3]);
    });
  });

  describe("validation", () => {
    it("rejects a record id outside [0, nodeCount)", () => {
      expect(() => buildModuleLODTree(2, [{ id: 0, path: [1] }, { id: 5, path: [1] }])).toThrow(/id/);
    });
    it("rejects records that don't cover every node exactly once", () => {
      expect(() => buildModuleLODTree(3, [{ id: 0, path: [1] }, { id: 1, path: [1] }])).toThrow();
      expect(() => buildModuleLODTree(2, [{ id: 0, path: [1] }, { id: 0, path: [1] }])).toThrow();
    });
    it("rejects an empty path", () => {
      expect(() => buildModuleLODTree(1, [{ id: 0, path: [] }])).toThrow(/path/);
    });
  });
});
