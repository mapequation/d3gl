import { describe, it, expect } from "vitest";
import {
  buildLODTree,
  computeLODGeometry,
  computeLODPositions,
  computeLODStyle,
  flattenHierarchyToTopology,
  lodTreeFromTopology,
  cut,
  declutterFrontier,
} from "../lod.js";
import { buildHierarchy, multilevelSeed } from "../coarsen.js";
import { lodGeometryViews, lodGeometryByteLength } from "../worker-protocol.js";
import { frontierCircles, superEdgeLines } from "../glyphs.js";
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
    // coarse same-level adjacency: the two aggregates are neighbours (the bridge between the pairs)
    expect(Array.from(tree.edgeNeighbors.slice(tree.edgeOffset[4]!, tree.edgeOffset[5]!))).toEqual([5]);
    expect(Array.from(tree.edgeNeighbors.slice(tree.edgeOffset[5]!, tree.edgeOffset[6]!))).toEqual([4]);
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

describe("worker-LOD split (#103)", () => {
  const placed = () => {
    const g = pairedGraph();
    g.positions.set([0, 0, 2, 0, 10, 0, 12, 0]);
    return g;
  };

  it("flattenHierarchyToTopology reproduces buildLODTree's topology (worker builds the same tree)", () => {
    const g = placed();
    const main = buildLODTree(g, { minNodes: 2 });
    const topo = flattenHierarchyToTopology(buildHierarchy(g, { minNodes: 2 }), g.nodeCount);

    expect(topo.size).toBe(main.size);
    expect(topo.leafCount).toBe(main.leafCount);
    expect(topo.levelCount).toBe(main.levelCount);
    expect(Array.from(topo.levelOffset)).toEqual(Array.from(main.levelOffset));
    expect(Array.from(topo.childOffset)).toEqual(Array.from(main.childOffset));
    expect(Array.from(topo.children)).toEqual(Array.from(main.children));
    expect(Array.from(topo.edgeOffset)).toEqual(Array.from(main.edgeOffset));
    expect(Array.from(topo.edgeNeighbors)).toEqual(Array.from(main.edgeNeighbors));
  });

  it("computeLODPositions + computeLODStyle equals the fused computeLODGeometry", () => {
    const g = placed();
    const radii = new Float32Array([4, 4, 4, 4]);

    const fused = buildLODTree(g, { minNodes: 2 });
    computeLODGeometry(fused, g, radii);

    const split = buildLODTree(g, { minNodes: 2 });
    computeLODPositions(split, g.positions); // the worker's per-frame pass
    computeLODStyle(split, radii, g.strength); // the main thread's once-per-style pass

    for (const k of ["cx", "cy", "extent", "radius", "count", "weight"] as const) {
      expect(Array.from(split[k])).toEqual(Array.from(fused[k]));
    }
  });

  it("lodTreeFromTopology binds cx/cy/extent to the provided (shared) geometry buffer", () => {
    const g = placed();
    const topo = flattenHierarchyToTopology(buildHierarchy(g, { minNodes: 2 }), g.nodeCount);
    const buffer = new ArrayBuffer(lodGeometryByteLength(topo.size));
    const views = lodGeometryViews(buffer, topo.size);
    const tree = lodTreeFromTopology(topo, views);

    expect(tree.cx).toBe(views.cx); // the tree reads the worker-written buffer with no copy
    expect(tree.cy).toBe(views.cy);
    expect(tree.extent).toBe(views.extent);

    // Writing geometry through the tree lands in the underlying buffer the worker shares.
    computeLODPositions(tree, g.positions);
    const cx = new Float32Array(buffer, 0, topo.size);
    expect(cx[0]).toBeCloseTo(0); // leaf 0 position
    expect(cx[4]).toBeCloseTo(1); // aggregate {0,1} centroid
  });

  it("lodGeometryViews packs [cx, cy, extent] contiguously", () => {
    const size = 6;
    const buffer = new ArrayBuffer(lodGeometryByteLength(size));
    expect(lodGeometryByteLength(size)).toBe(3 * size * 4);
    const { cx, cy, extent } = lodGeometryViews(buffer, size);
    expect(cx.length).toBe(size);
    expect(cy.byteOffset).toBe(size * 4);
    expect(extent.byteOffset).toBe(2 * size * 4);
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

  it("culls a subtree only once its whole drawn body misses the viewport", () => {
    const tree = treeOnLine(); // aggregate 4 at x=1, extent 1, draw radius √32 ≈ 5.66 → body ≈ [-5.66, 7.66]
    // Viewport world x = [10, 25]: aggregate 4's body (max ≈ 7.66) is fully left of it → culled.
    const frontier = cut(tree, { k: 1, x: -10, y: 0 }, 15, 200);
    expect(Array.from(frontier)).toEqual([5]);
  });

  it("keeps a node whose centre is off-screen while its draw radius still pokes in", () => {
    const tree = treeOnLine();
    // Viewport world x = [5, 20]: aggregate 4's centre (x=1) is off-screen, but its body (max ≈ 7.66)
    // overlaps → kept (no popping at the edge).
    const frontier = cut(tree, { k: 1, x: -5, y: 0 }, 15, 200);
    expect(Array.from(frontier).sort((a, b) => a - b)).toEqual([4, 5]);
  });
});

describe("cut bounds work to the visible set (#103 worker-LOD perf)", () => {
  // A clustered graph (ring backbone + deterministic chords) laid out by the real multilevel seed, so
  // the coarsening groups are spatially compact and the cut's spatial pruning applies — the property
  // that makes per-frame work ∝ visible rather than ∝ N. (Random positions would scatter each
  // aggregate's members and defeat pruning; the layout's whole job is to give the hierarchy locality.)
  function seededClusteredTree(n: number) {
    let s = 7 >>> 0;
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 0; i < n; i++) {
      source.push(i);
      target.push((i + 1) % n);
      source.push(i);
      target.push((i + 1 + Math.floor(rng() * (n - 2))) % n);
    }
    const g = buildGraph({ nodeCount: n, source, target });
    multilevelSeed(g, { width: 2000, height: 2000 });
    const tree = buildLODTree(g, {});
    computeLODGeometry(tree, g, new Float32Array(n).fill(4));
    return { g, tree };
  }

  const W = 1200, H = 800;
  /** Bounds + a transform that frames the whole layout (90% of the viewport). */
  function wholeView(g: ReturnType<typeof seededClusteredTree>["g"], n: number) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = g.positions[i * 2]!, y = g.positions[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const k = 0.9 * Math.min(W / (maxX - minX), H / (maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    return { k, x: W / 2 - cx * k, y: H / 2 - cy * k };
  }

  it("expandPx is the detail knob: a coarser threshold draws fewer glyphs, collapsing toward the roots", () => {
    const N = 5000;
    const { g, tree } = seededClusteredTree(N);
    const view = wholeView(g, N);

    const fine = cut(tree, view, W, H, { expandPx: 4 }).length;
    const mid = cut(tree, view, W, H, { expandPx: 64 }).length;
    const coarse = cut(tree, view, W, H, { expandPx: 1e9 }).length; // nothing expands → roots only

    expect(fine).toBeGreaterThan(mid); // finer threshold resolves more glyphs…
    expect(mid).toBeGreaterThan(coarse); // …coarser collapses them (monotone)

    // At the coarsest threshold the frontier is exactly the root aggregates — a handful, not N.
    const rootCount = tree.size - tree.levelOffset[tree.levelCount - 1]!;
    expect(coarse).toBeLessThanOrEqual(rootCount);
    expect(coarse).toBeLessThan(N / 50); // work ∝ visible detail, independent of the node count
    expect(coarse).toBeGreaterThan(0);
  });

  it("viewport culling bounds the frontier: zooming into a region draws far fewer than N", () => {
    const N = 5000;
    const { g, tree } = seededClusteredTree(N);
    const out = wholeView(g, N);
    // Zoom 6× into the layout centre — most of the graph scrolls off-screen and is culled.
    const k = out.k * 6;
    const cx = (W / 2 - out.x) / out.k, cy = (H / 2 - out.y) / out.k; // world point at screen centre
    const view = { k, x: W / 2 - cx * k, y: H / 2 - cy * k };

    const frontier = cut(tree, view, W, H, { expandPx: 48 });
    expect(frontier.length).toBeGreaterThan(0); // the region isn't empty
    expect(frontier.length).toBeLessThan(N / 2); // …but the off-screen majority is culled
    expect(frontier.length).toBeLessThanOrEqual(tree.size); // never more than the whole tree
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
    // Aggregates at x = 1 and x = 11, radius √32 ≈ 5.66 (sum ≈ 11.3). At k = 2 their screen centres
    // are 20px apart (> 11.3) so they don't overlap → both kept. (Screen-sized radius stays constant.)
    const kept = declutterFrontier(tree, new Uint32Array([4, 5]), { k: 2, x: 0, y: 0 }, 200, 200, {
      screenSized: true,
      k: 2,
    });
    expect(Array.from(kept).sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it("keeps kept glyphs overlap-free (no overdraw) on a dense cluster", () => {
    // 16 leaves packed in a small box, radius 4 each; declutter must leave a non-overlapping subset.
    const N = 16;
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 1; i < N; i++) {
      source.push(0);
      target.push(i); // star so they coarsen into one tree
    }
    const g = buildGraph({ nodeCount: N, source, target });
    for (let i = 0; i < N; i++) {
      g.positions[i * 2] = (i % 4) * 3; // 4×4 grid, 3px spacing ⇒ heavy overlap at radius 4
      g.positions[i * 2 + 1] = Math.floor(i / 4) * 3;
    }
    const tree = buildLODTree(g, { minNodes: 2 });
    computeLODGeometry(tree, g, new Float32Array(N).fill(4));
    const frontier = Uint32Array.from({ length: N }, (_, i) => i);

    const kept = declutterFrontier(tree, frontier, { k: 1, x: 0, y: 0 }, 200, 200, { screenSized: true, k: 1 });

    expect(kept.length).toBeLessThan(N); // some dropped
    for (let a = 0; a < kept.length; a++) {
      for (let b = a + 1; b < kept.length; b++) {
        const ga = kept[a]!;
        const gb = kept[b]!;
        const dx = tree.cx[ga]! - tree.cx[gb]!;
        const dy = tree.cy[ga]! - tree.cy[gb]!;
        const dist = Math.hypot(dx, dy);
        expect(dist).toBeGreaterThanOrEqual(tree.radius[ga]! + tree.radius[gb]! - 1e-6); // no overlap
      }
    }
  });
});

describe("superEdgeLines", () => {
  const make = () => {
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [2, 2, 1] });
    g.positions.set([0, 0, 2, 0, 10, 0, 12, 0]);
    const tree = buildLODTree(g, { minNodes: 2 });
    computeLODGeometry(tree, g, new Float32Array([4, 4, 4, 4]));
    return { g, tree };
  };

  it("links leaf neighbours present in the frontier (via the graph CSR)", () => {
    const { g, tree } = make();
    const lines = superEdgeLines(g, tree, new Uint32Array([0, 1, 2, 3]), { width: 1, stroke: "#000" });
    expect(lines.count).toBe(3); // edges (0,1), (1,2), (2,3)
  });

  it("links aggregate neighbours via the coarse adjacency (deduped when both visible)", () => {
    const { g, tree } = make();
    const both = superEdgeLines(g, tree, new Uint32Array([4, 5]), { width: 1, stroke: "#000" });
    expect(both.count).toBe(1); // the bridge between the two aggregates, emitted once
    expect(Array.from(both.sources.slice(0, 2))).toEqual([1, 0]); // centroid of aggregate 4
    expect(Array.from(both.targets.slice(0, 2))).toEqual([11, 0]); // centroid of aggregate 5
  });

  it("keeps a visible node's edge to an off-screen / absent neighbour (drawn toward its position)", () => {
    const { g, tree } = make();
    // Only aggregate 4 is visible; neighbour 5 is absent, but the edge is still drawn from 4 to 5.
    const one = superEdgeLines(g, tree, new Uint32Array([4]), { width: 1, stroke: "#000" });
    expect(one.count).toBe(1);
    expect(Array.from(one.sources.slice(0, 2))).toEqual([1, 0]); // aggregate 4
    expect(Array.from(one.targets.slice(0, 2))).toEqual([11, 0]); // toward absent aggregate 5's centroid
  });
});
