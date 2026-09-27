import { describe, expect, it } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import {
  buildLODTree,
  buildMortonLODTree,
  computeLODCrowding,
  computeLODGeometry,
  crowdingHorizon,
  cut,
  declutterFrontier,
  defaultExpandPx,
  leavesUnder,
  makeLODCrowdingScratch,
  type LODTransform,
  type LODTree,
} from "../lod.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";

/**
 * #426 — the LOD cut aggregates only nodes whose glyphs would overlap on screen. An aggregate opens once
 * its members' glyphs clear each other at the current zoom (`k ≥ clearZoom`), whatever its footprint;
 * the footprint rule (`expandPx`) keeps deciding how coarse the map is where members *would* overlap.
 * One rule for every tree kind and graph size — no node-count threshold anywhere.
 */

const W = 1000;
const H = 800;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** A ring-free chain graph (edges only so the coarsening tree has something to match). */
function chainGraph(n: number): NetworkGraph {
  const source = new Uint32Array(Math.max(0, n - 1));
  const target = new Uint32Array(Math.max(0, n - 1));
  for (let i = 0; i + 1 < n; i++) {
    source[i] = i;
    target[i] = i + 1;
  }
  return buildGraph({ nodeCount: n, source, target });
}

/** `side × side` lattice with `pitch` world units between neighbours, centred on the origin. */
function lattice(graph: NetworkGraph, side: number, pitch: number): void {
  for (let i = 0; i < graph.nodeCount; i++) {
    graph.positions[2 * i] = ((i % side) - (side - 1) / 2) * pitch;
    graph.positions[2 * i + 1] = (Math.floor(i / side) - (side - 1) / 2) * pitch;
  }
}

/** The transform that frames `graph`'s bounding box into ~85% of the view (as the engine's fit does). */
function fitOf(graph: NetworkGraph): LODTransform {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < graph.nodeCount; i++) {
    const x = graph.positions[2 * i]!, y = graph.positions[2 * i + 1]!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const k = (0.85 * Math.min(W, H)) / Math.max(x1 - x0, y1 - y0, 1e-6);
  return { k, x: W / 2 - k * (x0 + x1) / 2, y: H / 2 - k * (y0 + y1) / 2 };
}

/** One module per `size` consecutive nodes (two-level Infomap shape). */
function blocks(n: number, size: number): ModuleNode[] {
  return Array.from({ length: n }, (_, id) => ({ id, path: [Math.floor(id / size) + 1, (id % size) + 1] }));
}

/** One module per `w × h` patch of a `side × side` lattice (two-level Infomap shape). */
function patches(side: number, w: number, h: number): ModuleNode[] {
  const per = Math.ceil(side / w);
  const rank = new Map<number, number>();
  return Array.from({ length: side * side }, (_, id) => {
    const m = Math.floor(Math.floor(id / side) / h) * per + Math.floor((id % side) / w);
    const r = (rank.get(m) ?? 0) + 1;
    rank.set(m, r);
    return { id, path: [m + 1, r] };
  });
}

/** Geometry + crowding for a tree over `graph`, radii `radii`, the cut's own horizon. */
function prepare(tree: LODTree, graph: NetworkGraph, radii: Float32Array, screenSized = true, expandPx?: number): LODTree {
  computeLODGeometry(tree, graph, radii, graph.strength);
  computeLODCrowding(tree, { screenSized, expandPx: crowdingHorizon(tree, expandPx) });
  return tree;
}

const MIN_R = 0.5;
/** Brute force: the zoom from which no two of `g`'s members overlap on screen (see LODTree.clearZoom). */
function bruteClearZoom(tree: LODTree, g: number, screenSized: boolean): number {
  const m = leavesUnder(tree, g);
  let z = 0;
  for (let a = 0; a < m.length; a++) {
    for (let b = a + 1; b < m.length; b++) {
      const i = m[a]!, j = m[b]!;
      const d = Math.hypot(tree.cx[i]! - tree.cx[j]!, tree.cy[i]! - tree.cy[j]!);
      let p: number;
      if (screenSized) {
        p = (Math.max(tree.radius[i]!, MIN_R) + Math.max(tree.radius[j]!, MIN_R)) / d;
      } else {
        const hi = Math.max(tree.radius[i]!, tree.radius[j]!), lo = Math.min(tree.radius[i]!, tree.radius[j]!);
        p = d < hi + lo ? Infinity : d >= 2 * hi ? (2 * MIN_R) / d : MIN_R / (d - hi);
      }
      if (p > z) z = p;
    }
  }
  return z;
}

/** Each node's parent (-1 for a root), from the children CSR. */
function parentsOf(tree: LODTree): Int32Array {
  const up = new Int32Array(tree.size).fill(-1);
  for (let g = tree.leafCount; g < tree.size; g++) {
    for (let q = tree.childOffset[g] ?? 0; q < (tree.childOffset[g + 1] ?? 0); q++) up[tree.children[q] ?? 0] = g;
  }
  return up;
}

/**
 * The zoom up to which `g`'s clear zoom must be exact: its own horizon (where its footprint reaches `horizon`)
 * or any ancestor's, whichever is larger — an ancestor starts from its children's values, and extents need not
 * grow up the tree. A node whose extent is not finite (a non-finite member) asks for none: the cut never opens
 * it, its footprint being NaN.
 */
function neededCap(tree: LODTree, up: Int32Array, g: number, horizon: number): number {
  let cap = 0;
  for (let a = g; a >= 0; a = up[a] ?? -1) {
    const e = tree.extent[a] ?? NaN;
    const c = e > 0 ? horizon / (2 * e) : e === 0 ? Infinity : 0;
    if (c > cap) cap = c;
  }
  return cap;
}

/** Every aggregate's clear zoom is exact below the horizon it is needed to, and `Infinity` only past it. */
function expectExact(tree: LODTree, screenSized: boolean, horizon: number): number {
  const up = parentsOf(tree);
  let finite = 0;
  for (let g = tree.leafCount; g < tree.size; g++) {
    const want = bruteClearZoom(tree, g, screenSized);
    const got = tree.clearZoom[g] ?? NaN;
    const cap = neededCap(tree, up, g, horizon);
    if (got === Infinity) {
      expect(want >= cap * (1 - 1e-5) || want === Infinity).toBe(true);
    } else {
      finite++;
      expect(got).toBeCloseTo(want, 4);
      expect(want).toBeLessThan(cap * (1 + 1e-5));
    }
  }
  return finite;
}

describe("computeLODCrowding (#426)", () => {
  const trees = (graph: NetworkGraph): [string, LODTree][] => [
    ["spatial", buildMortonLODTree(graph.positions, graph.nodeCount)],
    ["structure", buildLODTree(graph)],
    ["modules", buildModuleLODTree(graph.nodeCount, blocks(graph.nodeCount, 13))],
  ];

  for (const screenSized of [true, false]) {
    it(`is exact per node below the horizon on every tree kind (${screenSized ? "screen" : "world"} radii)`, () => {
      const n = 600;
      const graph = chainGraph(n);
      const r = rng(9);
      // Clumps plus scatter: some members overlap, some sit far apart.
      for (let i = 0; i < n; i++) {
        const c = i % 7;
        const spread = c < 3 ? 6 : 140;
        graph.positions[2 * i] = (c - 3) * 300 + (r() - 0.5) * spread;
        graph.positions[2 * i + 1] = ((i * 37) % 5) * 90 + (r() - 0.5) * spread;
      }
      const radii = Float32Array.from({ length: n }, () => (screenSized ? 0.2 + r() * 9 : 0.5 + r() * 4));
      for (const [, tree] of trees(graph)) {
        prepare(tree, graph, radii, screenSized);
        const finite = expectExact(tree, screenSized, crowdingHorizon(tree));
        expect(finite).toBeGreaterThan(0); // not vacuous: some aggregates clear below their horizon
      }
    });
  }

  it("is exact everywhere with an infinite horizon, and monotone up the tree", () => {
    const n = 300;
    const graph = chainGraph(n);
    const r = rng(4);
    for (let i = 0; i < 2 * n; i++) graph.positions[i] = (r() - 0.5) * 2000;
    const radii = Float32Array.from({ length: n }, () => 1 + r() * 6);
    for (const [, tree] of trees(graph)) {
      computeLODGeometry(tree, graph, radii, graph.strength);
      computeLODCrowding(tree, { screenSized: true, expandPx: Infinity }, makeLODCrowdingScratch());
      for (let g = tree.leafCount; g < tree.size; g++) {
        expect(tree.clearZoom[g]).toBeCloseTo(bruteClearZoom(tree, g, true), 4);
        const p = tree.parent?.[g] ?? -1;
        if (p >= 0) expect(tree.clearZoom[p]!).toBeGreaterThanOrEqual(tree.clearZoom[g]!);
      }
    }
  });

  it("treats a glyph as covering at least half a pixel, and coincident members as never parting", () => {
    const graph = chainGraph(3);
    graph.positions.set([0, 0, 10, 0, 10, 0]); // 1 and 2 coincide
    const tree = buildMortonLODTree(graph.positions, 3, { bucket: 8 });
    prepare(tree, graph, new Float32Array([0.01, 0.01, 0.01]), true, Infinity);
    const root = tree.size - 1;
    expect(tree.clearZoom[root]).toBe(Infinity);
    // Without the coincident pair: two sub-pixel glyphs 10 apart part at k = (½ + ½) / 10.
    const two = chainGraph(2);
    two.positions.set([0, 0, 10, 0]);
    const t2 = prepare(buildMortonLODTree(two.positions, 2), two, new Float32Array([0.01, 0.01]), true, Infinity);
    expect(t2.clearZoom[t2.size - 1]).toBeCloseTo(0.1, 6);
    // World radii: discs that overlap in the world overlap at every zoom; apart ones part once a pixel apart.
    const tw = prepare(buildMortonLODTree(two.positions, 2), two, new Float32Array([6, 6]), false, Infinity);
    expect(tw.clearZoom[tw.size - 1]).toBe(Infinity);
    const tw2 = prepare(buildMortonLODTree(two.positions, 2), two, new Float32Array([1, 1]), false, Infinity);
    // d = 10 ≥ 2·hi: both below half a pixel until they are 1 px apart → k = 1 / 10.
    expect(tw2.clearZoom[tw2.size - 1]).toBeCloseTo(0.1, 6);
  });

  it("ignores a non-finite position instead of letting it crowd everything", () => {
    const n = 64;
    const graph = chainGraph(n);
    lattice(graph, 8, 50);
    graph.positions[0] = NaN;
    const tree = prepare(buildMortonLODTree(graph.positions, n), graph, new Float32Array(n).fill(3));
    for (let g = tree.leafCount; g < tree.size; g++) expect(Number.isNaN(tree.clearZoom[g] ?? NaN)).toBe(false);
    // Every other aggregate is exact over its finite members (the brute force skips the NaN pairs). The NaN
    // leaf's ancestors have a NaN footprint, so the cut never opens them and they need no value.
    expect(expectExact(tree, true, crowdingHorizon(tree))).toBeGreaterThan(0);
  });

  it("leaves a non-finite member out of the sweep, so it cannot hide a real pair (#426)", () => {
    // A module on a nested layout's disc keeps a finite extent although one member is NaN (#329), so the cut
    // can open it by overlap: its clear zoom must still see every finite pair. Sorted by x, the NaN member
    // used to stall the sort and the sweep stopped at x = 20 before reaching x = 1, the closest pair's.
    const xs = [0, 5, 20, NaN, 1];
    const graph = chainGraph(xs.length);
    xs.forEach((x, i) => {
      graph.positions[2 * i] = x;
      graph.positions[2 * i + 1] = 0;
    });
    const tree = buildModuleLODTree(xs.length, xs.map((_, id) => ({ id, path: [1, id + 1] })));
    const cells = tree.size - tree.leafCount;
    const discs = { dx: new Float32Array(cells), dy: new Float32Array(cells), r: new Float32Array(cells).fill(30) };
    computeLODGeometry(tree, graph, new Float32Array(xs.length).fill(1), graph.strength, undefined, undefined, undefined, discs);
    computeLODCrowding(tree, { screenSized: true, expandPx: 1e6 });
    const module = parentsOf(tree)[0] ?? -1;
    expect(tree.extent[module]).toBe(30);
    expect(tree.clearZoom[module]).toBeCloseTo(2, 6); // leaves 0 and 4, 1 apart: (1 + 1) / 1
    expectExact(tree, true, 1e6);
  });

  it("stays exact where a child reaches farther from its centroid than its parent (skewed siblings)", () => {
    // Two mirrored groups, each a tight clump plus one member near the other clump. A group's centroid sits in
    // its clump, so its extent reaches the far member; the root's centroid is midway, so its extent is smaller.
    // The group's own horizon comes first — but the root still needs the group's pairs up to its own.
    const pts = [[0, 0], [0.08, 0], [0, 0.08], [0.08, 0.08], [1, 1], [1, 0.84], [0.92, 0.84], [1, 0.76], [0.92, 0.76], [0.16, 0]];
    const graph = chainGraph(pts.length);
    pts.forEach(([x, y], i) => {
      graph.positions[2 * i] = x ?? 0;
      graph.positions[2 * i + 1] = y ?? 0;
    });
    const tree = buildModuleLODTree(pts.length, pts.map((_, id) => ({ id, path: [1, id < 5 ? 1 : 2, (id % 5) + 1] })));
    prepare(tree, graph, new Float32Array(pts.length).fill(1), true, 48);
    const up = parentsOf(tree);
    const group = up[0] ?? -1;
    expect(tree.extent[group] ?? 0, "precondition: the group reaches farther than its parent").toBeGreaterThan(tree.extent[up[group] ?? -1] ?? Infinity);
    expectExact(tree, true, 48);
    // At k = 28 every pair is ≥ 0.08 · 28 = 2.24 px apart with a 2 px radius sum: every node is drawn.
    const k = 28;
    const frontier = Array.from(cut(tree, { k, x: W / 2 - 0.5 * k, y: H / 2 - 0.5 * k }, W, H, { screenSized: true, expandPx: 48 }));
    expect(frontier.sort((a, b) => a - b)).toEqual(pts.map((_, i) => i));
  });

  it("stays exact on skewed siblings at scale, on every tree kind", () => {
    // Clumps of 6, each with one member flung next to a partner clump (the shape above, repeated), at spreads
    // over two decades so some clumps clear between their own horizon and their parent's.
    const groups = 60;
    const n = groups * 7;
    const graph = chainGraph(n);
    const r = rng(21);
    const gx = Float64Array.from({ length: groups }, (_, c) => (c % 2 ? 1 : -1) * 150 + (r() - 0.5) * 40);
    const gy = Float64Array.from({ length: groups }, () => (r() - 0.5) * 300);
    const spread = Float64Array.from({ length: groups }, () => 4 * Math.pow(10, 2 * r()));
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / 7);
      const o = c ^ 1; // the partner clump, mirrored across the middle
      const at = i % 7 === 6 ? o : c;
      graph.positions[2 * i] = (gx[at] ?? 0) + (r() - 0.5) * (spread[at] ?? 0);
      graph.positions[2 * i + 1] = (gy[at] ?? 0) + (r() - 0.5) * (spread[at] ?? 0);
    }
    const radii = Float32Array.from({ length: n }, () => 0.5 + r() * 3);
    const modules: ModuleNode[] = Array.from({ length: n }, (_, id) => ({ id, path: [Math.floor(id / 14) + 1, (Math.floor(id / 7) % 2) + 1, (id % 7) + 1] }));
    let skewed = 0;
    for (const tree of [buildMortonLODTree(graph.positions, n), buildLODTree(graph), buildModuleLODTree(n, modules)]) {
      for (const horizon of [48, 240]) {
        computeLODGeometry(tree, graph, radii, graph.strength);
        computeLODCrowding(tree, { screenSized: true, expandPx: horizon });
        expectExact(tree, true, horizon);
      }
      const up = parentsOf(tree);
      for (let g = tree.leafCount; g < tree.size; g++) if ((up[g] ?? -1) >= 0 && (tree.extent[g] ?? 0) > (tree.extent[up[g] ?? 0] ?? 0)) skewed++;
    }
    expect(skewed, "not vacuous: some child reaches farther than its parent").toBeGreaterThan(0);
  });
});

describe("cut: aggregate only where glyphs would overlap (#426)", () => {
  const SIDE = 40;
  // Modules: 8 × 6 patches of the lattice in the grid test, one per clump in the clump test.
  const kinds: [string, (g: NetworkGraph, clumps: boolean) => LODTree][] = [
    ["spatial", (g) => buildMortonLODTree(g.positions, g.nodeCount)],
    ["structure", (g) => buildLODTree(g)],
    ["modules", (g, clumps) => buildModuleLODTree(g.nodeCount, clumps ? blocks(g.nodeCount, 100) : patches(SIDE, 8, 6))],
  ];

  for (const [kind, build] of kinds) {
    it(`a spread grid whose glyphs do not overlap at the fit view cuts to every leaf (${kind})`, () => {
      const side = SIDE; // 1600 nodes, ~17 px apart at the fit
      const graph = chainGraph(side * side);
      lattice(graph, side, 10);
      const radii = new Float32Array(graph.nodeCount).fill(4); // 8 px glyphs
      const tree = prepare(build(graph, false), graph, radii);
      const t = fitOf(graph);
      const frontier = cut(tree, t, W, H, { screenSized: true });
      expect(frontier.length).toBe(graph.nodeCount);
      for (const g of frontier) expect(g).toBeLessThan(tree.leafCount);
      // …and the declutter keeps every one of them: they do not overlap.
      const kept = declutterFrontier(tree, frontier, t, W, H, { screenSized: true, k: t.k });
      expect(kept.length).toBe(graph.nodeCount);
      // Without a crowding pass the footprint rule alone aggregates the same grid (the #426 bug).
      tree.clearZoom.fill(Infinity);
      expect(cut(tree, t, W, H, { screenSized: true }).length).toBeLessThan(graph.nodeCount);
    });

    it(`the same nodes packed into overlapping clumps stay aggregated (${kind})`, () => {
      const side = SIDE;
      const graph = chainGraph(side * side);
      const r = rng(3);
      // 16 clumps of 100, each ~6 world units across, the clumps ~300 apart.
      for (let i = 0; i < graph.nodeCount; i++) {
        const c = Math.floor(i / 100);
        graph.positions[2 * i] = (c % 4) * 300 + (r() - 0.5) * 6;
        graph.positions[2 * i + 1] = Math.floor(c / 4) * 300 + (r() - 0.5) * 6;
      }
      const tree = prepare(build(graph, true), graph, new Float32Array(graph.nodeCount).fill(4));
      const frontier = cut(tree, fitOf(graph), W, H, { screenSized: true });
      let aggregates = 0;
      for (const g of frontier) if (g >= tree.leafCount) aggregates++;
      expect(aggregates).toBeGreaterThan(0);
      expect(frontier.length).toBeLessThan(graph.nodeCount / 4);
    });
  }

  it("opens an aggregate exactly at its clear zoom, however small its footprint", () => {
    // Two pairs far apart: the root opens by its footprint, each pair (a bottom cell) at its clear zoom.
    const graph = chainGraph(4);
    graph.positions.set([0, 0, 10, 0, 1000, 0, 1010, 0]);
    const tree = prepare(buildMortonLODTree(graph.positions, 4, { bucket: 2 }), graph, new Float32Array(4).fill(2));
    const parent = tree.parent ?? new Int32Array(0);
    const cell = parent[0] ?? -1;
    expect(cell).toBeGreaterThanOrEqual(tree.leafCount);
    expect(parent[1]).toBe(cell);
    const z = tree.clearZoom[cell]!;
    expect(z).toBeCloseTo(0.4, 6); // (2 + 2) / 10
    expect(2 * tree.extent[cell]! * z).toBeLessThan(defaultExpandPx(tree, W, H)); // the footprint rule keeps it shut
    const at = (k: number): LODTransform => ({ k, x: W / 2 - 505 * k, y: H / 2 });
    const open = Array.from(cut(tree, at(z * 1.001), W, H, { screenSized: true }));
    expect(open).toContain(0);
    expect(open).toContain(1);
    const shut = Array.from(cut(tree, at(z * 0.999), W, H, { screenSized: true }));
    expect(shut).toContain(cell);
    expect(shut).not.toContain(0);
  });

  it("a mixed view keeps the crowded part aggregated and opens the rest", () => {
    const side = 20;
    const graph = chainGraph(2 * side * side);
    lattice(graph, side, 10); // the first half: a spread lattice…
    const r = rng(8);
    for (let i = side * side; i < graph.nodeCount; i++) { // …the second: one dense clump beside it
      graph.positions[2 * i] = 400 + (r() - 0.5) * 8;
      graph.positions[2 * i + 1] = (r() - 0.5) * 8;
    }
    const tree = prepare(buildMortonLODTree(graph.positions, graph.nodeCount), graph, new Float32Array(graph.nodeCount).fill(2));
    const frontier = Array.from(cut(tree, fitOf(graph), W, H, { screenSized: true }));
    const leaves = frontier.filter((g) => g < tree.leafCount);
    expect(leaves.filter((g) => g < side * side).length).toBe(side * side); // the lattice is fully open
    expect(frontier.length - leaves.length).toBeGreaterThan(0); // the clump is still aggregated
  });

  it("cross-fades an overlap split over k / clearZoom in [1 − band, 1 + band]", () => {
    const graph = chainGraph(2);
    graph.positions.set([0, 0, 10, 0]);
    const tree = prepare(buildMortonLODTree(graph.positions, 2), graph, new Float32Array([2, 2]), true, 1e6);
    const root = tree.size - 1;
    const z = tree.clearZoom[root]!;
    expect(z).toBeCloseTo(0.4, 6); // (2 + 2) / 10
    const alpha = new Float32Array(tree.size);
    const at = (k: number): LODTransform => ({ k, x: W / 2 - 5 * k, y: H / 2 });
    const f = cut(tree, at(z), W, H, { screenSized: true, expandPx: 1e6, fadeBand: 0.2, fadeAlpha: alpha });
    expect(Array.from(f).sort()).toEqual([0, 1, root].sort());
    expect(alpha[root]).toBeCloseTo(0.5, 5); // midway through the band
    expect(Array.from(cut(tree, at(z * 1.25), W, H, { screenSized: true, expandPx: 1e6, fadeBand: 0.2, fadeAlpha: alpha })).sort()).toEqual([0, 1]);
    expect(Array.from(cut(tree, at(z * 0.75), W, H, { screenSized: true, expandPx: 1e6, fadeBand: 0.2, fadeAlpha: alpha }))).toEqual([root]);
  });

  it("the horizon never exceeds what a cut needs: at least the cut's own threshold at any viewport", () => {
    const graph = chainGraph(400);
    lattice(graph, 20, 10);
    for (const tree of [buildMortonLODTree(graph.positions, 400), buildLODTree(graph), buildModuleLODTree(400, blocks(400, 200))]) {
      computeLODGeometry(tree, graph, new Float32Array(400).fill(2), graph.strength);
      for (const [w, h] of [[200, 150], [1000, 800], [4000, 3000]] as const) {
        expect(crowdingHorizon(tree)).toBeGreaterThanOrEqual(defaultExpandPx(tree, w, h));
      }
      expect(crowdingHorizon(tree, 123)).toBe(123);
    }
  });
});
