import { describe, it, expect } from "vitest";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier } from "../lod.js";
import { frontierCircles } from "../glyphs.js";
import { buildGraph } from "../graph.js";

/**
 * Two strongly-bound pairs bridged weakly: heavy-edge matching pairs {0,1} and {2,3} into two
 * aggregates at level 1, joined by the bridge. `minNodes: 2` forces the one coarsening step (the
 * default stops at ≤ 8 nodes, so a tiny graph would otherwise stay single-level).
 */
function pairedGraph() {
  return buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [2, 2, 1] });
}

describe("buildLODTree", () => {
  it("flattens the coarsening hierarchy into a leaves-first SoA tree with a children CSR", () => {
    const tree = buildLODTree(pairedGraph(), { minNodes: 2 });

    expect(tree.levelCount).toBe(2);
    expect(tree.leafCount).toBe(4);
    expect(tree.size).toBe(6); // 4 leaves + 2 aggregates
    expect(Array.from(tree.levelOffset)).toEqual([0, 4, 6]);
    // aggregate 4 = {0,1}, aggregate 5 = {2,3}
    expect(Array.from(tree.children.slice(tree.childOffset[4]!, tree.childOffset[5]!))).toEqual([0, 1]);
    expect(Array.from(tree.children.slice(tree.childOffset[5]!, tree.childOffset[6]!))).toEqual([2, 3]);
  });

  it("leaves a non-coarsenable graph single-level (every node is its own root)", () => {
    const tree = buildLODTree(buildGraph({ nodeCount: 3, source: [0], target: [1] }));
    expect(tree.levelCount).toBe(1);
    expect(tree.size).toBe(3);
    expect(tree.childOffset[tree.size]).toBe(0); // no children anywhere
  });
});

describe("computeLODGeometry", () => {
  it("gives each aggregate the centroid, summed count/weight, area-additive radius, and bounding extent", () => {
    const g = pairedGraph();
    g.positions.set([0, 0, 2, 0, 10, 0, 12, 0]); // nodes 0..3 on a line
    const tree = buildLODTree(g, { minNodes: 2 });
    // leaf radii all 4; default leafWeight = strength: edges (0,1,2),(2,3,2),(1,2,1) → [2,3,3,2]
    computeLODGeometry(tree, g, new Float32Array([4, 4, 4, 4]));

    // aggregate 4 = {0,1}
    expect(tree.cx[4]).toBeCloseTo(1);
    expect(tree.cy[4]).toBeCloseTo(0);
    expect(tree.count[4]).toBe(2);
    expect(tree.weight[4]).toBeCloseTo(5); // strength0 + strength1 = 2 + 3
    expect(tree.radius[4]).toBeCloseTo(Math.sqrt(32)); // √(4² + 4²) area-additive
    expect(tree.extent[4]).toBeCloseTo(1); // half the pair's span
    // aggregate 5 = {2,3}
    expect(tree.cx[5]).toBeCloseTo(11);
    expect(tree.count[5]).toBe(2);
    expect(tree.weight[5]).toBeCloseTo(5); // strength2 + strength3 = 3 + 2
  });
});

describe("cut", () => {
  const treeOnLine = () => {
    const g = pairedGraph();
    g.positions.set([0, 0, 2, 0, 10, 0, 12, 0]);
    const tree = buildLODTree(g, { minNodes: 2 });
    computeLODGeometry(tree, g, new Float32Array([4, 4, 4, 4]));
    return tree;
  };

  it("draws aggregates when their on-screen footprint is small", () => {
    const tree = treeOnLine();
    // k = 1: each aggregate spans 2 world units → 2 px, well under the 48px expand threshold.
    const frontier = cut(tree, { k: 1, x: 0, y: 0 }, 200, 200);
    expect(Array.from(frontier).sort((a, b) => a - b)).toEqual([4, 5]); // both aggregates
  });

  it("expands aggregates into leaves once zoomed in past the threshold", () => {
    const tree = treeOnLine();
    // k = 100: footprint 200px ≥ 48 → expand. Viewport spans world x [0,16] (1600px / k), so all
    // four leaves (x = 0,2,10,12) stay in view.
    const frontier = cut(tree, { k: 100, x: 0, y: 0 }, 1600, 400, { expandPx: 48 });
    expect(Array.from(frontier).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("culls subtrees whose bounding box misses the viewport", () => {
    const tree = treeOnLine();
    // World viewport ≈ [5, 20] in x at k=1 → aggregate 4 (centre x=1) is off-screen, only 5 visible.
    const frontier = cut(tree, { k: 1, x: -5, y: 0 }, 15, 200);
    expect(Array.from(frontier)).toEqual([5]);
  });
});

describe("frontierCircles", () => {
  const treeOnLine = () => {
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [2, 2, 1] });
    g.positions.set([0, 0, 2, 0, 10, 0, 12, 0]);
    const tree = buildLODTree(g, { minNodes: 2 });
    computeLODGeometry(tree, g, new Float32Array([4, 4, 4, 4])); // aggregate radius = √32 ≈ 5.657
    return tree;
  };

  it("draws leaves and aggregates at their tree radius, with distinct fills", () => {
    const tree = treeOnLine();
    const c = frontierCircles(tree, new Uint32Array([0, 4]), { nodeFill: "#ff0000", aggregateFill: "#00ff00" });

    expect(c.count).toBe(2);
    expect(c.radii[0]).toBeCloseTo(4); // leaf 0
    expect(c.radii[1]).toBeCloseTo(Math.sqrt(32)); // aggregate 4
    expect(Array.from(c.colors)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]); // leaf red, aggregate green
  });

  it("caps aggregate radius (not leaves) at maxAggregateRadius", () => {
    const tree = treeOnLine();
    const c = frontierCircles(tree, new Uint32Array([0, 4]), {
      nodeFill: "#000",
      aggregateFill: "#000",
      maxAggregateRadius: 5,
    });
    expect(c.radii[0]).toBeCloseTo(4); // leaf uncapped
    expect(c.radii[1]).toBeCloseTo(5); // aggregate clamped from √32 to 5
  });
});

describe("declutterFrontier", () => {
  // Four leaves on a line at x = 0,2,10,12 (radius 4); strength weights [2,3,3,2].
  const treeOnLine = () => {
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [2, 2, 1] });
    g.positions.set([0, 0, 2, 0, 10, 0, 12, 0]);
    const tree = buildLODTree(g, { minNodes: 2 });
    computeLODGeometry(tree, g, new Float32Array([4, 4, 4, 4]));
    return tree;
  };

  it("drops lower-importance glyphs covered by a kept one, keeping the higher-strength member", () => {
    const tree = treeOnLine();
    // screen-sized radius 4; pairs (0,1) at x=0,2 and (2,3) at x=10,12 overlap (gap 2 < radius 4).
    // Within each pair the higher-strength node (1 and 2, strength 3) survives; 0 and 3 (strength 2) drop.
    const kept = declutterFrontier(tree, new Uint32Array([0, 1, 2, 3]), { k: 1, x: 0, y: 0 }, 200, 200, {
      screenSized: true,
      k: 1,
    });
    expect(Array.from(kept)).toEqual([1, 2]);
  });

  it("keeps every glyph when nothing overlaps", () => {
    const tree = treeOnLine();
    // The two aggregates sit at x = 1 and x = 11 (gap 10) with radius √32 ≈ 5.66 → no overlap.
    const kept = declutterFrontier(tree, new Uint32Array([4, 5]), { k: 1, x: 0, y: 0 }, 200, 200, {
      screenSized: true,
      k: 1,
    });
    expect(Array.from(kept).sort((a, b) => a - b)).toEqual([4, 5]);
  });
});
