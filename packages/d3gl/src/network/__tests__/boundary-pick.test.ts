import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { buildLODTree, cut, declutterFrontier, makeCutBoundaries, computeLODGeometry, type LODTree } from "../lod.js";
import { buildGraph } from "../graph.js";
import { BOUNDARY_PICK_MIN_PX, boundaryHighlightCircles, boundaryRingPickStats, descendantRun, pickBoundaryRing, type FrontierHalosData } from "../glyphs.js";

/**
 * Picking an open module by its boundary ring (#476): the shared CPU test every backend runs against the
 * rings a frame drew ({@link pickBoundaryRing}), the highlight drawn on a ring, and the frontier run of an
 * open module's drawn members that keeps them undimmed on hover.
 */

/** Modules 1 (sub-modules 1:1 and 1:2, three leaves each) and 2 (three leaves). */
function moduleTree(): { tree: LODTree; byPath: Map<string, number> } {
  const records: ModuleNode[] = [];
  for (const prefix of [[1, 1], [1, 2], [2]]) for (let l = 1; l <= 3; l++) records.push({ id: records.length, path: [...prefix, l] });
  const tree = buildModuleLODTree(records.length, records);
  const byPath = new Map<string, number>();
  const parent = tree.parent!;
  const branch = tree.branch!;
  for (let g = tree.leafCount; g < tree.size; g++) {
    const path: number[] = [];
    for (let x = g; parent[x]! >= 0; x = parent[x]!) path.unshift(branch[x]!);
    byPath.set(path.join(":"), g);
  }
  return { tree, byPath };
}

/** A ring batch as {@link boundaryRings} returns it: per ring `[module, cx, cy, r, width]` (world units). */
function ringsOf(rows: [number, number, number, number, number][], alpha = 255): FrontierHalosData {
  const n = rows.length;
  const rings: FrontierHalosData = {
    centers: new Float32Array(n * 2),
    radii: new Float32Array(n),
    borders: new Float32Array(n),
    borderColors: new Uint8Array(n * 4).fill(alpha),
    colors: new Uint8Array(n * 4),
    ids: new Uint32Array(n),
    count: n,
  };
  rows.forEach(([g, x, y, r, w], i) => {
    rings.ids[i] = g;
    rings.centers[i * 2] = x;
    rings.centers[i * 2 + 1] = y;
    rings.radii[i] = r;
    rings.borders[i] = w / r;
  });
  return rings;
}

const T = { k: 2, x: 10, y: 20 }; // screen = world · 2 + (10, 20)
const screen = (x: number, y: number): [number, number] => [x * T.k + T.x, y * T.k + T.y];

describe("pickBoundaryRing (#476)", () => {
  const { tree, byPath } = moduleTree();
  const m1 = byPath.get("1")!;
  const m11 = byPath.get("1:1")!;
  const m2 = byPath.get("2")!;

  it("hits a point on the stroke [r − w, r], and nothing inside the disc off the stroke or outside it", () => {
    // Module 1: radius 50, a 5-unit stroke = 10 px at k = 2 (wider than the minimum hit band).
    const rings = ringsOf([[m1, 0, 0, 50, 5]]);
    expect(pickBoundaryRing(tree, rings, ...screen(48, 0), T)).toBe(0); // on the stroke
    expect(pickBoundaryRing(tree, rings, ...screen(0, -46), T)).toBe(0); // inner edge, anywhere round
    expect(pickBoundaryRing(tree, rings, ...screen(40, 0), T)).toBe(-1); // inside the disc, off the stroke
    expect(pickBoundaryRing(tree, rings, ...screen(0, 0), T)).toBe(-1); // the centre
    expect(pickBoundaryRing(tree, rings, ...screen(52, 0), T)).toBe(-1); // outside
  });

  it("widens a thin stroke about its centreline to the minimum hit width in screen px", () => {
    // A 0.5-unit stroke = 1 px at k = 2: the hit band is 6 px (3 world units) about its centreline r − 0.25.
    const rings = ringsOf([[m1, 0, 0, 50, 0.5]]);
    const c = 50 - 0.25;
    const half = BOUNDARY_PICK_MIN_PX / 2 / T.k;
    expect(pickBoundaryRing(tree, rings, ...screen(c + half - 0.05, 0), T)).toBe(0);
    expect(pickBoundaryRing(tree, rings, ...screen(c - half + 0.05, 0), T)).toBe(0);
    expect(pickBoundaryRing(tree, rings, ...screen(c + half + 0.1, 0), T)).toBe(-1);
    expect(pickBoundaryRing(tree, rings, ...screen(c - half - 0.1, 0), T)).toBe(-1);
    expect(pickBoundaryRing(tree, rings, ...screen(c, 0), T, 1)).toBe(0); // a caller's narrower minimum
    expect(pickBoundaryRing(tree, rings, ...screen(c + 1, 0), T, 1)).toBe(-1);
  });

  it("where strokes overlap, the deepest module wins, whatever the order the rings were drawn in", () => {
    // Module 1 and its sub-module 1:1 share a rim point at x = 50 (the sub-module's disc touches it).
    const deepLast = ringsOf([[m1, 0, 0, 50, 4], [m11, 30, 0, 20, 4]]);
    const deepFirst = ringsOf([[m11, 30, 0, 20, 4], [m1, 0, 0, 50, 4]]);
    expect(pickBoundaryRing(tree, deepLast, ...screen(49, 0), T)).toBe(1);
    expect(pickBoundaryRing(tree, deepFirst, ...screen(49, 0), T)).toBe(0);
    // Off the sub-module's stroke only module 1 is hit.
    expect(pickBoundaryRing(tree, deepLast, ...screen(0, 49), T)).toBe(0);
    // Two modules at one depth: the one drawn last (on top) wins.
    const siblings = ringsOf([[m1, 0, 0, 50, 4], [m2, 100, 0, 50, 4]]);
    expect(pickBoundaryRing(tree, siblings, ...screen(50, 0), T)).toBe(1);
  });

  it("skips a ring drawn fully transparent", () => {
    expect(pickBoundaryRing(tree, ringsOf([[m1, 0, 0, 50, 5]], 0), ...screen(48, 0), T)).toBe(-1);
  });

  it("orders depth by level on a tree without a parent map (a spatial tree has none)", () => {
    const n = 64;
    const g = buildGraph({ nodeCount: n, source: Array.from({ length: n - 1 }, (_, i) => i), target: Array.from({ length: n - 1 }, (_, i) => i + 1) });
    for (let i = 0; i < n; i++) {
      g.positions[2 * i] = Math.cos(i);
      g.positions[2 * i + 1] = Math.sin(i);
    }
    // A coarsening tree numbered by level, its parent map dropped: the level orders depth.
    const { parent: _parent, depth: _depth, ...st } = buildLODTree(g);
    expect(st.levelCount).toBeGreaterThan(2);
    const fine = st.levelOffset[1]!; // an aggregate one level above the leaves
    const coarse = st.levelOffset[st.levelCount - 1]! - 1; // one on the level below the roots
    const rings = ringsOf([[fine, 0, 0, 50, 4], [coarse, 0, 0, 50, 4]]);
    expect(pickBoundaryRing(st, rings, ...screen(49, 0), T)).toBe(0); // the finer (deeper) one
  });

  it("counts one ring test per drawn ring per pick", () => {
    const rows: [number, number, number, number, number][] = [];
    for (let i = 0; i < 1000; i++) rows.push([m1, i * 3, 0, 1, 0.1]);
    const rings = ringsOf(rows);
    const before = boundaryRingPickStats.tests;
    for (let i = 0; i < 100; i++) pickBoundaryRing(tree, rings, i, i, T);
    expect(boundaryRingPickStats.tests - before).toBe(100 * 1000);
  });
});

describe("boundaryHighlightCircles (#476)", () => {
  const { byPath } = moduleTree();
  const m1 = byPath.get("1")!;
  const m2 = byPath.get("2")!;
  const RED: readonly [number, number, number, number] = [220, 38, 38, 255];

  it("draws the highlighted rings on their own circle, at least as wide as the ring and the minimum px", () => {
    const rings = ringsOf([[m1, 0, 0, 50, 5], [m2, 100, 0, 30, 0.1]]);
    const hl = boundaryHighlightCircles(rings, () => true, () => RED, 2, 2);
    expect(hl.count).toBe(2);
    expect(Array.from(hl.ids)).toEqual([m1, m2]);
    // Module 1: the ring's own band [45, 50] (5 units = 10 px, past the 2 px minimum).
    expect(hl.radii[0]).toBeCloseTo(50, 5);
    expect(hl.radii[0]! * hl.borders[0]!).toBeCloseTo(5, 5);
    // Module 2: a 0.1-unit ring (0.2 px) highlighted 2 px (1 unit) wide, centred on its centreline 29.95.
    const outer = hl.radii[1]!;
    const w = outer * hl.borders[1]!;
    expect(w).toBeCloseTo(1, 5);
    expect(outer - w / 2).toBeCloseTo(29.95, 4);
    expect(Array.from(hl.borderColors.subarray(0, 4))).toEqual([...RED]);
    expect(Array.from(hl.colors).every((c) => c === 0)).toBe(true); // no fill: the members stay visible
  });

  it("draws only the highlighted modules' rings", () => {
    const rings = ringsOf([[m1, 0, 0, 50, 5], [m2, 100, 0, 30, 1]]);
    const hl = boundaryHighlightCircles(rings, (g) => g === m2, () => RED, 1);
    expect(hl.count).toBe(1);
    expect(hl.ids[0]).toBe(m2);
    expect(hl.centers[0]).toBe(100);
  });
});

describe("descendantRun (#476)", () => {
  /** A ragged 3-level map on a grid, so a cut at a mid zoom opens some modules and keeps others collapsed. */
  function grid(): LODTree {
    const records: ModuleNode[] = [];
    const n = 4 * 4 * 6;
    for (let i = 0; i < n; i++) records.push({ id: i, path: [1 + Math.floor(i / 24), 1 + (Math.floor(i / 6) % 4), 1 + (i % 6)] });
    const g = buildGraph({ nodeCount: n, source: [], target: [] });
    for (let i = 0; i < n; i++) {
      const top = Math.floor(i / 24);
      const sub = Math.floor(i / 6) % 4;
      g.positions[2 * i] = top * 400 + sub * 80 + (i % 6) * 10;
      g.positions[2 * i + 1] = (top % 2) * 400 + (i % 3) * 10;
    }
    const tree = buildModuleLODTree(n, records);
    computeLODGeometry(tree, g, new Float32Array(n).fill(3));
    return tree;
  }

  it("is exactly the drawn members of each open module, one contiguous run, with declutter on and off", () => {
    const tree = grid();
    const parent = tree.parent!;
    const under = (x: number, g: number): boolean => {
      for (let a = x; a >= 0; a = parent[a]!) if (a === g) return true;
      return false;
    };
    let checked = 0;
    for (const k of [0.5, 1, 2, 4]) {
      const t = { k, x: 0, y: 0 };
      const bnd = makeCutBoundaries();
      const full = Uint32Array.from(cut(tree, t, 1600, 800, { expandPx: 60, boundaries: bnd }));
      for (const frontier of [full, Uint32Array.from(declutterFrontier(tree, full, t, 1600, 800, { screenSized: false, k }))]) {
        for (let i = 0; i < bnd.count; i++) {
          const g = bnd.ids[i]!;
          const [lo, hi] = descendantRun(frontier, g, parent, [0, 0]);
          const expected = Array.from(frontier).filter((x) => under(x, g));
          expect(Array.from(frontier.subarray(lo, hi))).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(4); // non-vacuous: modules really opened
  });

  it("is the module's own run, and empty for a module none of whose members is drawn", () => {
    const { tree, byPath } = moduleTree(); // leaves 0-2 in 1:1, 3-5 in 1:2, 6-8 in 2
    const frontier = Uint32Array.from([6, 0, 1, 2, byPath.get("1:2")!, 7]);
    expect(descendantRun(frontier, byPath.get("1")!, tree.parent!, [9, 9])).toEqual([1, 5]);
    expect(descendantRun(frontier, byPath.get("1:1")!, tree.parent!, [9, 9])).toEqual([1, 4]);
    expect(descendantRun(Uint32Array.from([0, 1, 2]), byPath.get("2")!, tree.parent!, [9, 9])).toEqual([0, 0]);
  });
});
