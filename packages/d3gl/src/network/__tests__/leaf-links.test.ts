import { describe, it, expect } from "vitest";
import { buildLODTree, buildMortonLODTree, computeLODGeometry, cut, declutterFrontier, makeCutScratch, makeDeclutterFrontierScratch, visibleWorldRect, type LODTransform, type LODTree } from "../lod.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLeafIncidence, lazySuperEdges, type LazyCut } from "../lazy-super-edges.js";
import { incidenceSourceEdges } from "../spatial-rows.js";
import { leafLinkEdges, linkLinesStyleAttrs, makeLeafLinksScratch, superEdges, withLeafLinks, type NoLodStyleCache, type SuperEdgeStyleResolved, type SuperEdgesData } from "../glyphs.js";

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
  const kept = declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: 20 }, makeDeclutterFrontierScratch()).slice();
  return { drawn, kept, culled: sc.culled.slice(0, sc.culledCount), split: sc.split.slice(0, sc.splitCount) };
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
        const after = withLeafLinks(spatial, g, c.kept, cacheOf(g), gathered, undefined, makeLeafLinksScratch());
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
        const after = withLeafLinks(structure, g, c.kept, cacheOf(g), gathered, undefined, makeLeafLinksScratch());
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
    const after = withLeafLinks(spatial, g, c.kept, cache, gathered, undefined, makeLeafLinksScratch());
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
});
