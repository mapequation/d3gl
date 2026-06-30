import { describe, it, expect } from "vitest";
import { leavesUnder, lodTreeFromTopology, ancestorAwareSelected } from "../lod.js";
import type { LODTopology } from "../lod.js";

/**
 * Minimal 4-leaf balanced tree (no geometry, no super-edges):
 *   root 6
 *   ├─ 4 ─ {0, 1}
 *   └─ 5 ─ {2, 3}
 * Leaves are global ids [0, leafCount) and equal the original node ids.
 */
function tinyTree(): LODTopology {
  return {
    size: 7,
    leafCount: 4,
    levelCount: 3,
    levelOffset: new Uint32Array([0, 4, 6, 7]),
    // children CSR: only nodes 4,5,6 have children.
    childOffset: new Uint32Array([0, 0, 0, 0, 0, 2, 4, 6]),
    children: new Uint32Array([0, 1, 2, 3, 4, 5]),
    edgeOffset: new Uint32Array(8),
    edgeNeighbors: new Uint32Array(0),
  };
}

describe("leavesUnder", () => {
  it("returns the single leaf for a leaf node", () => {
    expect(leavesUnder(tinyTree(), 2)).toEqual([2]);
  });

  it("returns a subtree's leaves, sorted, for an aggregate", () => {
    const t = tinyTree();
    expect(leavesUnder(t, 4)).toEqual([0, 1]);
    expect(leavesUnder(t, 5)).toEqual([2, 3]);
    expect(leavesUnder(t, 6)).toEqual([0, 1, 2, 3]); // whole tree
  });

  it("is deterministic regardless of children traversal order", () => {
    // A reversed child order must still yield the same sorted leaf set.
    const t = tinyTree();
    t.children = new Uint32Array([1, 0, 3, 2, 5, 4]);
    expect(leavesUnder(t, 6)).toEqual([0, 1, 2, 3]);
  });
});

describe("lodTreeFromTopology — count (#105)", () => {
  it("fills leaf-descendant count from topology (the worker path streams cx/cy/extent, not count)", () => {
    // Reproduces the 'aggregate shows 0 nodes' bug: a worker-streamed tree never re-runs the per-frame
    // computeLODPositions on the main thread, so count must be filled at construction.
    const tree = lodTreeFromTopology(tinyTree());
    expect(Array.from(tree.count)).toEqual([1, 1, 1, 1, 2, 2, 4]); // leaves=1, modules=2, root=4
  });
});

describe("ancestorAwareSelected (#162)", () => {
  // tinyTree: root 6 ├─ 4 ─ {0,1}  └─ 5 ─ {2,3}; parent pointers for that tree.
  const parent = Int32Array.from([4, 4, 5, 5, 6, 6, -1]);

  it("selecting an aggregate marks its whole subtree, not ancestors/siblings", () => {
    const sel = new Set([4]); // the aggregate over leaves 0, 1
    const isSel = ancestorAwareSelected(parent, (g) => sel.has(g));
    expect([0, 1, 4].map((g) => isSel(g))).toEqual([true, true, true]); // node 4 + its descendants
    expect([2, 3, 5, 6].map((g) => isSel(g))).toEqual([false, false, false, false]); // sibling module, root
  });

  it("selecting a leaf marks only that leaf (no ancestor inflation)", () => {
    const isSel = ancestorAwareSelected(parent, (g) => g === 2);
    expect(isSel(2)).toBe(true);
    expect([0, 1, 3, 4, 5, 6].map((g) => isSel(g))).toEqual([false, false, false, false, false, false]);
  });

  it("selecting the root marks every node", () => {
    const isSel = ancestorAwareSelected(parent, (g) => g === 6);
    expect([0, 1, 2, 3, 4, 5, 6].map((g) => isSel(g))).toEqual([true, true, true, true, true, true, true]);
  });
});
