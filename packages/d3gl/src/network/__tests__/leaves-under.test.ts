import { describe, it, expect } from "vitest";
import { leavesUnder } from "../lod.js";
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
