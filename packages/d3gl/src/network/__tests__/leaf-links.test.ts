import { describe, it, expect } from "vitest";
import { buildLODTree, buildMortonLODTree, computeLODGeometry, cut, declutterFrontier, makeCutScratch, makeDeclutterFrontierScratch, visibleWorldRect, type LODTransform, type LODTree } from "../lod.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLeafIncidence, lazySuperEdges, makeLazySuperEdgesScratch, type LazyCut } from "../lazy-super-edges.js";
import { buildKeptRows, incidenceSourceEdges, makeSpatialRowsScratch, spatialRowsByteLength, spatialRowsGraph, spatialRowsViews, type SpatialRows } from "../spatial-rows.js";
import { leafLinkEdges, linkLinesStyleAttrs, makeLeafLinksScratch, sortEdgeIds, superEdges, withLeafLinks, type LeafLinksScratch, type NoLodStyleCache, type SuperEdgeStyleResolved, type SuperEdgesData } from "../glyphs.js";

/**
 * #447: with `leafLinks`, the gathers leave the links between two kept leaves out and `withLeafLinks` draws
 * them as graph edges, from the full-detail path's cached columns. Together they draw the same pairs with the
 * same flow as the gather alone, on the spatial tree's lazy gather and a coarsening tree's CSR gather, over
 * views where most, some or no glyphs are leaves.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** A graph with community structure placed spatially plus long-range edges: no parallel edges, no self-loops. */
function fixture(n: number, seed: number): NetworkGraph {
  const r = rng(seed);
  const seen = new Set<number>();
  const src: number[] = [];
  const tgt: number[] = [];
  const w: number[] = [];
  const add = (a: number, b: number, weight: number): void => {
    if (a === b || seen.has(Math.min(a, b) * n + Math.max(a, b))) return;
    seen.add(Math.min(a, b) * n + Math.max(a, b));
    src.push(a); tgt.push(b); w.push(weight);
  };
  for (let i = 1; i < n; i++) {
    add(i, Math.max(0, i - 1 - Math.floor(r() * 20)), 1 + Math.floor(r() * 4));
    if (i % 4 === 0) add(Math.floor(r() * n), i, 0.5);
  }
  const g = buildGraph({ nodeCount: n, source: src, target: tgt, weight: w });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 6 + r() * 0.3;
    const d = 50 + (i / n) * 400 + r() * 30;
    g.positions[2 * i] = Math.cos(a) * d;
    g.positions[2 * i + 1] = Math.sin(a) * d;
  }
  return g;
}

const W = 800;
const H = 600;
const WIDTH = (w: number): number => Math.sqrt(w);
const COLOR = (): [number, number, number, number] => [10, 20, 30, 255];

function styleOf(directed: boolean, leafLinks: boolean): SuperEdgeStyleResolved {
  return { linkStyle: "line", directed, widthOf: WIDTH, colorOf: COLOR, bend: 0, arrowSize: 1, maxAggregateRadius: 20, leafLinks };
}

function cacheOf(g: NetworkGraph): NoLodStyleCache {
  return { kind: "lines", sizeMode: "screen", lines: linkLinesStyleAttrs(g, { widthOf: WIDTH, colorOf: COLOR, bend: 0 }), nodeGroups: new Float32Array(g.nodeCount) };
}

function cutAt(tree: LODTree, t: LODTransform, expandPx?: number): LazyCut {
  const sc = makeCutScratch();
  const drawn = cut(tree, t, W, H, { screenSized: true, maxAggregateRadius: 20, recordCulled: true, expandPx }, sc).slice();
  const kept = declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: 20, spacing: 1 }, makeDeclutterFrontierScratch()).slice();
  return { drawn, kept, culled: sc.culled.slice(0, sc.culledCount), split: sc.split.slice(0, sc.splitCount) };
}

/** The kept-leaf edges of a cut, listed by the walk of their rows (`leafLinkEdges`), in a fresh scratch. */
function listed(g: NetworkGraph, kept: Uint32Array): { m: number; sc: LeafLinksScratch } {
  const sc = makeLeafLinksScratch();
  return { m: leafLinkEdges(g, kept, incidenceSourceEdges(g.csr, g), sc), sc };
}

/** Pair → summed flow, the pair unordered for an undirected style. */
function pairs(tree: LODTree, out: SuperEdgesData, directed: boolean): Map<number, number> {
  const m = new Map<number, number>();
  out.ids.forEach((id, i) => {
    const a = Math.floor(id / tree.size);
    const b = id % tree.size;
    const key = directed ? id : Math.min(a, b) * tree.size + Math.max(a, b);
    m.set(key, (m.get(key) ?? 0) + (out.flows?.[i] ?? 0));
  });
  return m;
}

function expectSame(got: Map<number, number>, want: Map<number, number>): void {
  expect([...got.keys()].sort((x, y) => x - y)).toEqual([...want.keys()].sort((x, y) => x - y));
  for (const [k, v] of want) expect(got.get(k)).toBeCloseTo(v, 4);
}

describe("leaf links (#447): the gathers leave kept-leaf pairs to the full-detail path, and together draw the same links", () => {
  const g = fixture(6000, 7);
  const radii = new Float32Array(g.nodeCount).fill(3);
  const spatial = buildMortonLODTree(g.positions, g.nodeCount);
  computeLODGeometry(spatial, g, radii, g.strength);
  const structure = buildLODTree(g, {});
  computeLODGeometry(structure, g, radii, g.strength);
  // Fit (mostly aggregates), zoomed in (a mix) and every leaf kept (expandPx → 0).
  const views: { name: string; t: LODTransform; expandPx?: number }[] = [
    { name: "fit", t: { k: 0.9, x: W / 2, y: H / 2 } },
    { name: "zoomed", t: { k: 4, x: W / 2 - 150 * 4, y: H / 2 - 80 * 4 } },
    { name: "all leaves", t: { k: 0.9, x: W / 2, y: H / 2 }, expandPx: 1e-6 },
  ];
  for (const directed of [false, true]) {
    for (const { name, t, expandPx } of views) {
      it(`spatial tree, ${directed ? "directed" : "undirected"}, ${name}`, () => {
        const inc = buildLeafIncidence(g, directed);
        const c = cutAt(spatial, t, expandPx);
        const view = visibleWorldRect(t, W, H);
        const before = lazySuperEdges(spatial, c, styleOf(directed, false), view, g.csr, inc);
        const gathered = lazySuperEdges(spatial, c, styleOf(directed, true), view, g.csr, inc);
        for (const id of gathered.ids) {
          const a = Math.floor(id / spatial.size);
          const b = id % spatial.size;
          const leafPair = a < spatial.leafCount && b < spatial.leafCount && c.kept.includes(a) && c.kept.includes(b);
          expect(leafPair, "a gathered pair between two kept leaves").toBe(false);
        }
        const { m, sc } = listed(g, c.kept);
        const after = withLeafLinks(spatial, g, m, cacheOf(g), gathered, undefined, sc);
        expectSame(pairs(spatial, after, directed), pairs(spatial, before, directed));
        expect(after.lines?.count).toBe(after.ids.length);
      });
    }
    it(`coarsening tree (CSR gather), ${directed ? "directed" : "undirected"}: the same pairs`, () => {
      for (const { t, expandPx } of views) {
        const c = cutAt(structure, t, expandPx);
        const view = visibleWorldRect(t, W, H);
        const before = superEdges(structure, c.kept, styleOf(directed, false), view);
        const gathered = superEdges(structure, c.kept, styleOf(directed, true), view);
        const { m, sc } = listed(g, c.kept);
        const after = withLeafLinks(structure, g, m, cacheOf(g), gathered, undefined, sc);
        const got = [...pairs(structure, after, false).keys()].sort((x, y) => x - y);
        const want = [...pairs(structure, before, false).keys()].sort((x, y) => x - y);
        expect(got).toEqual(want);
      }
    });
  }

  it("every kept leaf pair is one graph edge, with the full-detail path's width and colour", () => {
    const t = views[2]!.t;
    const c = cutAt(spatial, t, 1e-6);
    const inc = buildLeafIncidence(g, false);
    const gathered = lazySuperEdges(spatial, c, styleOf(false, true), visibleWorldRect(t, W, H), g.csr, inc);
    const cache = cacheOf(g);
    const { m, sc } = listed(g, c.kept);
    const after = withLeafLinks(spatial, g, m, cache, gathered, undefined, sc);
    const kept = new Set(c.kept);
    let leafEdges = 0;
    for (let e = 0; e < g.edgeCount; e++) if (kept.has(g.source[e]!) && kept.has(g.target[e]!)) leafEdges++;
    expect(leafEdges, "the view keeps leaves").toBeGreaterThan(500);
    expect(after.ids.length).toBe(leafEdges + gathered.ids.length);
    const lines = after.lines;
    if (!lines || !cache.lines) throw new Error("no lines");
    for (let i = 0; i < leafEdges; i++) {
      const a = Math.floor((after.ids[i] ?? 0) / spatial.size);
      expect(lines.sources[2 * i]).toBe(spatial.cx[a]);
      expect(lines.widths[i]).toBeCloseTo(WIDTH(after.flows?.[i] ?? 0), 5);
    }
  });

  it("the WebGL index (leafLinkEdges) lists exactly the kept-leaf edges, in edge order, reading only the kept leaves' rows", () => {
    // Self-loops and parallel edges (both directions, and a repeat) on top of the fixture's edges.
    const n = 3000;
    const r = rng(7);
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 0; i < 12_000; i++) {
      const a = Math.floor(r() * n);
      const b = r() < 0.05 ? a : Math.floor(r() * n);
      src.push(a); tgt.push(b);
      if (r() < 0.1) { src.push(b); tgt.push(a); }
      if (r() < 0.05) { src.push(a); tgt.push(b); }
    }
    const graph = buildGraph({ nodeCount: n, source: src, target: tgt });
    const entries = incidenceSourceEdges(graph.csr, graph);
    const sc = makeLeafLinksScratch();
    for (const share of [0, 0.01, 0.3, 1]) {
      // A frontier of kept leaves in no particular order, with aggregate ids (≥ n) mixed in.
      const frontier: number[] = [];
      for (let v = n - 1; v >= 0; v--) if (r() < share) frontier.push(v);
      for (let k = 0; k < 50; k++) frontier.push(n + k);
      const f = Uint32Array.from(frontier.sort(() => r() - 0.5));
      const kept = new Set(frontier.filter((v) => v < n));
      const want: number[] = [];
      for (let e = 0; e < graph.edgeCount; e++) {
        const a = graph.source[e]!;
        const b = graph.target[e]!;
        if (a !== b && kept.has(a) && kept.has(b)) want.push(e);
      }
      const m = leafLinkEdges(graph, f, entries, sc);
      expect(Array.from(sc.edges.subarray(0, m)), `share ${share}`).toEqual(want);
      let degrees = 0;
      for (const v of kept) degrees += graph.csr.degree[v]!;
      expect(sc.entries, `share ${share}: entries read`).toBe(degrees);
    }
  });

  it("the lazy gather lists the kept-leaf edges as it reads their rows: sorted, the same list as the walk (#447)", () => {
    // Self-loops and parallel edges (both directions, and a repeat), spatially placed.
    const n = 3000;
    const r = rng(11);
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 0; i < 12_000; i++) {
      const a = Math.floor(r() * n);
      const b = r() < 0.05 ? a : Math.min(n - 1, Math.max(0, a + Math.floor((r() - 0.5) * 60)));
      src.push(a); tgt.push(b);
      if (r() < 0.1) { src.push(b); tgt.push(a); }
      if (r() < 0.05) { src.push(a); tgt.push(b); }
    }
    for (const directed of [false, true]) {
      const graph = buildGraph({ nodeCount: n, source: src, target: tgt, directed });
      for (let i = 0; i < n; i++) {
        graph.positions[2 * i] = Math.cos(i * 0.01) * (100 + i * 0.1);
        graph.positions[2 * i + 1] = Math.sin(i * 0.01) * (100 + i * 0.1);
      }
      const tree = buildMortonLODTree(graph.positions, graph.nodeCount);
      computeLODGeometry(tree, graph, new Float32Array(n).fill(2), graph.strength);
      const entries = incidenceSourceEdges(graph.csr, graph);
      const inc = buildLeafIncidence(graph, directed);
      const lazy = makeLazySuperEdgesScratch();
      for (const { t, expandPx } of [
        { t: { k: 0.9, x: W / 2, y: H / 2 } },
        { t: { k: 3, x: W / 2 - 100 * 3, y: H / 2 } },
        { t: { k: 0.9, x: W / 2, y: H / 2 }, expandPx: 1e-6 },
      ]) {
        const c = cutAt(tree, t, expandPx);
        lazySuperEdges(tree, c, styleOf(directed, true), visibleWorldRect(t, W, H), graph.csr, inc, lazy, entries);
        const sc = makeLeafLinksScratch();
        const m = sortEdgeIds(lazy.leafEdges, lazy.leafLinks, graph.edgeCount, sc);
        const walk = listed(graph, c.kept);
        expect(Array.from(sc.edges.subarray(0, m)), `${directed ? "directed" : "undirected"}, k ${t.k}`).toEqual(Array.from(walk.sc.edges.subarray(0, walk.m)));
        // Without the entry map the gather lists nothing (the CSR gather's callers walk instead).
        lazySuperEdges(tree, c, styleOf(directed, true), visibleWorldRect(t, W, H), graph.csr, inc, lazy);
        expect(lazy.leafLinks).toBe(0);
      }
    }
  });

  it("sortEdgeIds sorts a list from outside the scratch, or one of its buffers, into edge order", () => {
    const r = rng(3);
    for (const E of [10, 5000, 1 << 25]) {
      const ids = Array.from({ length: 4000 }, () => Math.floor(r() * E));
      const want = [...ids].sort((a, b) => a - b);
      const sc = makeLeafLinksScratch();
      const sorted = (list: () => Uint32Array): number[] => {
        const m = sortEdgeIds(list(), ids.length, E, sc);
        return Array.from(sc.edges.subarray(0, m));
      };
      expect(sorted(() => Uint32Array.from(ids))).toEqual(want);
      sc.edges.set(ids.reverse());
      expect(sorted(() => sc.edges)).toEqual(want);
      sc.sorted.set(ids);
      expect(sorted(() => sc.sorted)).toEqual(want);
    }
  });

  it("a kept leaf's row is memoised (#463): the same pairs, flows and leaf links as a fresh gather over a moving view, none rebuilt on a held one", () => {
    for (const directed of [false, true]) {
      const inc = buildLeafIncidence(g, directed);
      const entries = incidenceSourceEdges(g.csr, g);
      const memo = makeLazySuperEdgesScratch();
      // Zooms in and out, pans, and cuts that coarsen and refine: leaves join and leave the kept set between calls.
      const steps: { t: LODTransform; expandPx?: number }[] = [];
      for (let i = 0; i < 24; i++) {
        const k = 0.9 * Math.pow(1.35, (i % 12) - (i >= 12 ? 3 : 0));
        steps.push({ t: { k, x: W / 2 - (i % 5) * 37, y: H / 2 + (i % 3) * 29 }, expandPx: i % 7 === 0 ? 120 : i % 4 === 0 ? 12 : undefined });
      }
      let compared = 0;
      let carried = 0;
      for (const { t, expandPx } of steps) {
        const c = cutAt(spatial, t, expandPx);
        const view = visibleWorldRect(t, W, H);
        const got = lazySuperEdges(spatial, c, styleOf(directed, true), view, g.csr, inc, memo, entries);
        const gotLinks = Array.from(memo.leafEdges.subarray(0, memo.leafLinks)).sort((a, b) => a - b);
        const fresh = makeLazySuperEdgesScratch();
        const want = lazySuperEdges(spatial, c, styleOf(directed, true), view, g.csr, inc, fresh, entries);
        const wantLinks = Array.from(fresh.leafEdges.subarray(0, fresh.leafLinks)).sort((a, b) => a - b);
        expectSame(pairs(spatial, got, directed), pairs(spatial, want, directed));
        expect(gotLinks).toEqual(wantLinks);
        compared += got.ids.length + gotLinks.length;
        carried += memo.hits; // rows the memo answered across a view change
        // The same view again: every kept leaf's row from the memo.
        const again = lazySuperEdges(spatial, c, styleOf(directed, true), view, g.csr, inc, memo, entries);
        expect(memo.leafRows, "held view: kept-leaf rows rebuilt").toBe(0);
        expectSame(pairs(spatial, again, directed), pairs(spatial, want, directed));
      }
      expect(compared, "not vacuous").toBeGreaterThan(1000);
      expect(carried, "rows carried over from the previous view (the memo is exercised, not only rebuilt)").toBeGreaterThan(100);
    }
  });

  it("a kept leaf's full row (no leaf links) built from a streamed tree's rows is answered by the memo on the next call", () => {
    const t = views[1]!.t;
    const c = cutAt(spatial, t);
    const { leafOrder, leafStart, leafEnd } = spatial;
    if (!leafOrder || !leafStart || !leafEnd) throw new Error("a spatial tree carries its leaf runs");
    let rows: SpatialRows | null = null;
    buildKeptRows({ size: spatial.size, leafCount: spatial.leafCount, leafOrder, leafStart, leafEnd }, c, spatialRowsGraph(g.nodeCount, g), makeSpatialRowsScratch(), (sizes) => {
      rows = spatialRowsViews(new ArrayBuffer(spatialRowsByteLength(sizes)), sizes);
      return rows;
    });
    if (!rows) throw new Error("no rows");
    const streamed = { ...spatial, rows: rows as SpatialRows };
    const inc = buildLeafIncidence(g, false);
    const memo = makeLazySuperEdgesScratch();
    const view = visibleWorldRect(t, W, H);
    const a = lazySuperEdges(streamed, c, styleOf(false, false), view, g.csr, inc, memo);
    let leaves = 0;
    for (const v of c.kept) if (v < spatial.leafCount) leaves++;
    expect(leaves, "the view keeps leaves").toBeGreaterThan(0);
    const b = lazySuperEdges(streamed, c, styleOf(false, false), view, g.csr, inc, memo);
    expect(memo.hits, "every kept glyph's row from the memo, the leaves' too").toBe(c.kept.length);
    expect(memo.leafRows).toBe(0);
    expectSame(pairs(spatial, b, false), pairs(spatial, a, false));
  });
});
