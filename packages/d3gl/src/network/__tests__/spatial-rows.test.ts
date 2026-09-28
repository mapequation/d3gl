import { describe, it, expect } from "vitest";
import { buildMortonLODTree, computeLODPositions, computeLODStyle, cut, declutterFrontier, makeCutScratch, makeDeclutterFrontierScratch, visibleWorldRect, type LODTransform, type LODTree } from "../lod.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLeafIncidence, lazySuperEdges, makeLazySuperEdgesScratch, rowSuperEdges, type LazyCut } from "../lazy-super-edges.js";
import { allocateSpatialRows, buildCoverRows, cutRowCells, makeSpatialRowsScratch, rowOf, spatialRowsGraph, type SpatialRows } from "../spatial-rows.js";
import { lodFrameStep, lodTreeFromSpatialFrame, makeSpatialLODStream, recycleSpatialFrame, type LODView } from "../lod-frame.js";
import { layoutBox, layoutFitTransform } from "../fit.js";
import type { SuperEdgeStyleResolved, SuperEdgesData } from "../glyphs.js";

/**
 * Super-edge rows of a spatial tree's covers (#433): built off the main thread with each streamed tree, for
 * the view the main thread reported, they let the gather read O(visible) rows instead of walking every edge
 * under the frontier. Pinned here:
 *   - the rows are exactly their definition (per listed cell, each edge's partner at the cell's depth, or a
 *     shallower leaf), checked edge by edge against a brute force;
 *   - `rowSuperEdges` draws the **same super-edges** as `lazySuperEdges` on the same cut — every pair, flow,
 *     endpoint, width, colour and arrowhead — over zooms, pans, declutter on and off, a cross-fade band,
 *     directed and undirected lines and half-arrows, weighted and unweighted graphs: with rows for exactly
 *     that cut's covers it walks no leaf run; with rows for another view's cut, or none, it walks the unlisted
 *     covers' leaves and still draws the same;
 *   - a spatial stream given the edges and a view (a transform, or the fit) ships the rows of that view's
 *     covers with every rebuilt tree, reuses returned buffers, and builds none without links or a view.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Community structure placed spatially, long-range edges, self-loops and parallel edges. */
function fixture(n: number, seed: number, unit = false): NetworkGraph {
  const r = rng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  const w: number[] = [];
  for (let i = 1; i < n; i++) {
    src.push(i); tgt.push(Math.max(0, i - 1 - Math.floor(r() * 20))); w.push(unit ? 1 : 1 + Math.floor(r() * 4));
    if (i % 4 === 0) { src.push(Math.floor(r() * n)); tgt.push(i); w.push(unit ? 1 : 0.5); }
    if (i % 7 === 0) { src.push(i); tgt.push(Math.floor(r() * n)); w.push(unit ? 1 : 0.25 + r()); }
    if (i % 97 === 0) { src.push(i); tgt.push(i); w.push(1); } // self-loop
    if (i % 53 === 0) { src.push(i); tgt.push(i - 1); w.push(unit ? 1 : 2); } // parallel to the chain edge (sometimes)
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

function spatialTree(g: NetworkGraph): LODTree {
  const tree = buildMortonLODTree(g.positions, g.nodeCount);
  computeLODPositions(tree, g.positions);
  computeLODStyle(tree, new Float32Array(g.nodeCount).fill(3), g.strength);
  return tree;
}

/** The rows of the cells among `covers`, as a stream's worker builds them. */
function rowsFor(tree: LODTree, g: NetworkGraph, covers: ArrayLike<number>): SpatialRows {
  const { parent, leafOrder, leafStart, leafEnd } = tree;
  if (!parent || !leafOrder || !leafStart || !leafEnd) throw new Error("not a spatial tree");
  const out = { rows: allocateSpatialRows({ size: 0, leafCount: 0, cells: 0, outEntries: 0, inEntries: 0 }) };
  buildCoverRows({ size: tree.size, leafCount: tree.leafCount, parent, leafOrder, leafStart, leafEnd }, covers, spatialRowsGraph(g.nodeCount, g), makeSpatialRowsScratch(), (sz) => (out.rows = allocateSpatialRows(sz)));
  return out.rows;
}

/** The rows a worker builds for the cut `c`: its cells whose rows can matter, the drawn glyphs as the floor. */
function rowsForCut(tree: LODTree, g: NetworkGraph, c: LazyCut): SpatialRows {
  const { parent } = tree;
  if (!parent) throw new Error("not a spatial tree");
  const cells = { cells: new Uint32Array(0) };
  const m = cutRowCells(parent, c, c.drawn, cells);
  return rowsFor(tree, g, cells.cells.subarray(0, m));
}

function styleOf(directed: boolean, linkStyle: "line" | "half-arrow" = "line"): SuperEdgeStyleResolved {
  return { linkStyle, directed, widthOf: (w) => Math.sqrt(w), colorOf: (w) => [Math.min(255, Math.round(w * 10)), 20, 30, 255], bend: linkStyle === "line" ? 0 : 0.2, arrowSize: 1, maxAggregateRadius: 20 };
}

/** The cut the engine runs (screen-sized, declutter optional), with its covers. */
function cutAt(tree: LODTree, t: LODTransform, declutter: boolean, fadeBand = 0): LazyCut & { fade?: Float32Array } {
  const sc = makeCutScratch();
  const fade = fadeBand > 0 ? new Float32Array(tree.size) : undefined;
  const drawn = cut(tree, t, W, H, { screenSized: true, maxAggregateRadius: 20, recordCulled: true, fadeBand, fadeAlpha: fade }, sc).slice();
  const kept = declutter ? declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: 20 }, makeDeclutterFrontierScratch()).slice() : drawn;
  return { drawn, kept, culled: sc.culled.slice(0, sc.culledCount), split: sc.split.slice(0, sc.splitCount), fade };
}

/** Every drawn super-edge, by its pair id: flow and every per-instance attribute it is drawn with. */
function byId(d: SuperEdgesData): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const put = (e: number, vals: number[]): void => {
    const id = d.ids[e]!;
    expect(m.has(id), `pair ${id} drawn twice`).toBe(false);
    m.set(id, vals);
  };
  for (let e = 0; e < d.ids.length; e++) {
    const vals = [d.flows?.[e] ?? NaN];
    const ha = d.halfArrows;
    if (ha) vals.push(...ha.sources.subarray(2 * e, 2 * e + 2), ...ha.targets.subarray(2 * e, 2 * e + 2), ...ha.radii.subarray(2 * e, 2 * e + 2), ...ha.widths.subarray(2 * e, 2 * e + 2), ...ha.colors.subarray(4 * e, 4 * e + 4));
    const l = d.lines;
    if (l) vals.push(...l.sources.subarray(2 * e, 2 * e + 2), ...l.targets.subarray(2 * e, 2 * e + 2), l.widths[e]!, ...l.colors.subarray(4 * e, 4 * e + 4));
    const a = d.arrows;
    if (a) vals.push(a.radii[e]!, a.sizes[e]!);
    put(e, vals);
  }
  return m;
}

function expectSameEdges(got: SuperEdgesData, want: SuperEdgesData): void {
  const g = byId(got);
  const w = byId(want);
  expect([...g.keys()].sort((x, y) => x - y)).toEqual([...w.keys()].sort((x, y) => x - y));
  for (const [id, vals] of w) expect(g.get(id), `pair ${id}`).toEqual(vals);
}

describe("buildCoverRows (#433)", () => {
  it("holds, per listed cell, each edge's partner at the cell's depth (or a shallower leaf), summed — brute force", () => {
    const g = fixture(1500, 5);
    const tree = spatialTree(g);
    const { parent, leafStart, leafEnd } = tree;
    if (!parent || !leafStart || !leafEnd) throw new Error("not a spatial tree");
    const n = tree.leafCount;
    // Every cell but one listed, plus leaves and repeats (left out).
    const skipped = n + 3;
    const all = Array.from({ length: tree.size }, (_, i) => i).filter((x) => x !== skipped);
    const rows = rowsFor(tree, g, [...all, ...all.slice(n, n + 50)]);
    const depth = new Int32Array(tree.size);
    for (let x = tree.size - 1; x >= 0; x--) depth[x] = parent[x]! < 0 ? 0 : depth[parent[x]!]! + 1;
    for (let x = 0; x < tree.size; x++) expect(rows.depth[x]).toBe(depth[x]);
    expect(rows.cell.length).toBe(tree.size - n - 1);
    expect(rowOf(rows, skipped)).toBe(-1);
    expect(rowOf(rows, 0)).toBe(-1); // leaves have no stored row
    const inside = (t: number, x: number): boolean => leafStart[t]! >= leafStart[x]! && leafStart[t]! < leafEnd[x]!;
    const partner = (v: number, d: number): number => {
      let t = v;
      while (depth[t]! > d) t = parent[t]!;
      return t;
    };
    const wantOut = new Map<string, number>();
    const wantIn = new Map<string, number>();
    const put = (m: Map<string, number>, x: number, t: number, w: number): void => { m.set(`${x}:${t}`, (m.get(`${x}:${t}`) ?? 0) + w); };
    for (let e = 0; e < g.edgeCount; e++) {
      const u = g.source[e]!;
      const v = g.target[e]!;
      if (u === v) continue;
      const w = g.weight[e]!;
      for (let x = parent[u]!; x >= 0 && !inside(v, x); x = parent[x]!) if (x !== skipped) put(wantOut, x, partner(v, depth[x]!), w);
      for (let y = parent[v]!; y >= 0 && !inside(u, y); y = parent[y]!) if (y !== skipped) put(wantIn, y, partner(u, depth[y]!), w);
    }
    const gotOut = new Map<string, number>();
    const gotIn = new Map<string, number>();
    for (let i = 0; i < rows.cell.length; i++) {
      const x = rows.cell[i]!;
      if (i > 0) expect(x).toBeGreaterThan(rows.cell[i - 1]!); // ascending, for rowOf
      expect(rowOf(rows, x)).toBe(i);
      for (let e = rows.outOffset[i]!; e < rows.outOffset[i + 1]!; e++) {
        expect(gotOut.has(`${x}:${rows.outNode[e]}`), "an out-row lists a partner once").toBe(false);
        gotOut.set(`${x}:${rows.outNode[e]}`, rows.outFlow[e]!);
      }
      for (let e = rows.inOffset[i]!; e < rows.inOffset[i + 1]!; e++) {
        expect(gotIn.has(`${x}:${rows.inNode[e]}`), "an in-row lists a partner once").toBe(false);
        gotIn.set(`${x}:${rows.inNode[e]}`, rows.inFlow[e]!);
      }
    }
    expect(gotOut).toEqual(wantOut);
    expect(gotIn).toEqual(wantIn);
    expect(wantOut.size).toBeGreaterThan(1000); // non-vacuity
    // Lift entries toward a shallower leaf exist (a ragged tree), and no entry names a deeper node.
    let lifts = 0;
    for (let i = 0; i < rows.cell.length; i++) {
      const x = rows.cell[i]!;
      for (let e = rows.outOffset[i]!; e < rows.outOffset[i + 1]!; e++) {
        const t = rows.outNode[e]!;
        expect(depth[t]).toBeLessThanOrEqual(depth[x]!);
        if (depth[t]! < depth[x]!) lifts++;
      }
    }
    expect(lifts).toBeGreaterThan(0);
  });
});

describe("rowSuperEdges draws the lazy gather's super-edges (#433)", () => {
  for (const unit of [false, true]) {
    const n = 6000;
    const g = fixture(n, unit ? 9 : 3, unit);
    const tree = spatialTree(g);
    const inc = buildLeafIncidence(g, true);
    const views: [string, LODTransform][] = [
      ["fit", { k: 0.9, x: W / 2, y: H / 2 }],
      ["zoomed", { k: 4, x: W / 2 - 150 * 4, y: H / 2 - 80 * 4 }],
      ["deep", { k: 30, x: W / 2 - 300 * 30, y: H / 2 + 120 * 30 }],
      ["panned", { k: 1.6, x: -200, y: 500 }],
    ];
    for (const [linkStyle, directed] of [["line", false], ["line", true], ["half-arrow", true]] as const) {
      it(`${unit ? "unweighted" : "weighted"} ${directed ? "directed" : "undirected"} ${linkStyle}: every view, declutter on/off, cross-fade band`, () => {
        const style = styleOf(directed, linkStyle);
        let culledLeaves = 0;
        let splits = 0;
        let drawnPairs = 0;
        for (const [, t] of views) {
          for (const declutter of [false, true]) {
            for (const band of [0, 0.4]) {
              const c = cutAt(tree, t, declutter, band);
              const edgeStyle = band > 0 ? { ...style, fadeAlpha: c.fade } : style;
              const view = visibleWorldRect(t, W, H);
              const lazy = lazySuperEdges(tree, c, edgeStyle, view, g.csr, inc, makeLazySuperEdgesScratch());
              // Rows for exactly this cut (the worker saw the same view): no leaf run is walked.
              const sc = makeLazySuperEdgesScratch();
              const rows = rowSuperEdges({ ...tree, rows: rowsForCut(tree, g, c) }, c, edgeStyle, view, g.csr, inc, sc);
              expectSameEdges(rows, lazy);
              expect(sc.visits, "the row gather walks no leaf run").toBe(0);
              expect(sc.labelled).toBe(0);
              // Rows for another view's cut (the view moved since), and none: the unlisted covers' leaves are
              // walked, and the edges drawn are still the same.
              const other = cutAt(tree, { k: t.k * 1.7, x: t.x - 90, y: t.y + 40 }, false, band);
              const moved = rowSuperEdges({ ...tree, rows: rowsForCut(tree, g, other) }, c, edgeStyle, view, g.csr, inc, makeLazySuperEdgesScratch());
              expectSameEdges(moved, lazy);
              const none = rowSuperEdges({ ...tree, rows: rowsFor(tree, g, []) }, c, edgeStyle, view, g.csr, inc, makeLazySuperEdgesScratch());
              expectSameEdges(none, lazy);
              culledLeaves += [...c.culled].filter((x) => x < n).length;
              splits += c.split.length;
              drawnPairs += rows.ids.length;
            }
          }
        }
        // Non-vacuity: culled leaves, a band's split glyphs and many pairs were all exercised.
        expect(culledLeaves).toBeGreaterThan(0);
        expect(splits).toBeGreaterThan(0);
        expect(drawnPairs).toBeGreaterThan(1000);
      });
    }
  }

  it("computes the row of a cell the worker's rows do not list once per tree: the view moved, then holds", () => {
    const g = fixture(6000, 3);
    const tree = spatialTree(g);
    const inc = buildLeafIncidence(g, true);
    const fit: LODTransform = { k: 0.9, x: W / 2, y: H / 2 };
    const zoomed: LODTransform = { k: 4, x: W / 2 - 150 * 4, y: H / 2 - 80 * 4 };
    const rowTree: LODTree = { ...tree, rows: rowsForCut(tree, g, cutAt(tree, fit, true)) }; // the worker saw the fit
    const c = cutAt(tree, zoomed, true); // the main thread has zoomed in since
    const view = visibleWorldRect(zoomed, W, H);
    const sc = makeLazySuperEdgesScratch();
    const first = rowSuperEdges(rowTree, c, styleOf(true), view, g.csr, inc, sc);
    expect(sc.misses, "cells the worker's rows did not list").toBeGreaterThan(0);
    expect(sc.visits).toBeGreaterThan(0);
    const held = rowSuperEdges(rowTree, c, styleOf(true), view, g.csr, inc, sc);
    expect(sc.misses, "held view: rows computed").toBe(0);
    expect(sc.visits, "held view: incidences walked").toBe(0);
    expect(sc.hits).toBeGreaterThan(0);
    expectSameEdges(held, first);
    expectSameEdges(held, lazySuperEdges(tree, c, styleOf(true), view, g.csr, inc));
    // Another tree (the next streamed frame): the cache starts over.
    const next: LODTree = { ...rowTree };
    rowSuperEdges(next, c, styleOf(true), view, g.csr, inc, sc);
    expect(sc.misses).toBeGreaterThan(0);
  });

  it("reads rows bounded by the view, not by the edges under it: 4× the graph in the same extent", () => {
    const t: LODTransform = { k: 0.9, x: W / 2, y: H / 2 };
    const view = visibleWorldRect(t, W, H);
    const measure = (n: number): { entries: number; visits: number; drawn: number; pairs: number } => {
      const g = fixture(n, 4);
      const tree = spatialTree(g);
      const inc = buildLeafIncidence(g, true);
      const c = cutAt(tree, t, false);
      const rowTree: LODTree = { ...tree, rows: rowsForCut(tree, g, c) };
      const lazySc = makeLazySuperEdgesScratch();
      lazySuperEdges(tree, c, styleOf(false), view, g.csr, inc, lazySc);
      const sc = makeLazySuperEdgesScratch();
      const out = rowSuperEdges(rowTree, c, styleOf(false), view, g.csr, inc, sc);
      return { entries: sc.entries, visits: lazySc.visits, drawn: c.drawn.length, pairs: out.ids.length };
    };
    const small = measure(20_000);
    const large = measure(80_000);
    // The lazy gather walks every incidence under the frontier: 4× the edges, ~4× the work.
    expect(large.visits).toBeGreaterThan(3 * small.visits);
    // The rows it reads follow what the screen-bounded frontier draws instead (measured: 205 → 223 glyphs,
    // 5.5k → 11.8k pairs as the pairs among them fill in, 2.5-2.9 entries per pair).
    expect(large.drawn).toBeLessThan(1.5 * small.drawn);
    for (const m of [small, large]) expect(m.entries).toBeLessThan(4 * m.pairs);
    expect(large.entries * 4).toBeLessThan(large.visits);
  });
});

describe("a spatial stream ships the rows of its view's covers with each tree (#433)", () => {
  it("builds them for every rebuilt tree at the view (a transform, or the fit), reuses buffers, and builds none without links or a view", () => {
    const g = fixture(3000, 7);
    const style = { radii: new Float32Array(g.nodeCount).fill(3), weight: g.strength };
    const t: LODTransform = { k: 1.3, x: W / 2 - 60, y: H / 2 + 30 };
    const view: LODView = { transform: t, fitPad: 3, width: W, height: H, maxAggregateRadius: 20, screenSized: true, fadeBand: 0 };
    const stream = makeSpatialLODStream(g.nodeCount, style, 1, g, view);
    const f1 = lodFrameStep(stream, g.positions, 1);
    if (!f1?.rows) throw new Error("no rows");
    const tree = lodTreeFromSpatialFrame(f1);
    // Exactly the rows of the covers the engine's cut draws at that view.
    const c = cutAt(tree, t, false);
    const want = rowsForCut(tree, g, c);
    expect(tree.rows?.cell).toEqual(want.cell);
    expect(tree.rows?.outNode).toEqual(want.outNode);
    expect(tree.rows?.outFlow).toEqual(want.outFlow);
    expect(tree.rows?.inNode).toEqual(want.inNode);
    expect(tree.rows?.depth).toEqual(want.depth);
    expect(want.cell.length).toBeGreaterThan(10);
    // A returned rows buffer is reused by the next rebuild.
    const rowsBuffer = f1.rows.buffer;
    recycleSpatialFrame(stream, f1.buffer, f1.rows.buffer);
    const f2 = lodFrameStep(stream, g.positions, 2);
    expect(f2?.rows?.buffer).toBe(rowsBuffer);
    // Following the fit: the cut at the fit the engine frames the positions at.
    stream.view = { ...view, transform: null };
    const f3 = lodFrameStep(stream, g.positions, 3);
    if (!f3?.rows) throw new Error("no rows at the fit");
    const fitTree = lodTreeFromSpatialFrame(f3);
    const box = layoutBox(g.positions, g.nodeCount, { trimStragglers: true });
    if (!box) throw new Error("no fit box");
    const fitT = layoutFitTransform(box, W, H, 3, true);
    expect(fitTree.rows?.cell).toEqual(rowsForCut(fitTree, g, cutAt(fitTree, fitT, false)).cell);
    // No links drawn, or no view: no rows.
    stream.style = { ...style, links: false };
    const f4 = lodFrameStep(stream, g.positions, 4);
    expect(f4).not.toBeNull();
    expect(f4?.rows).toBeUndefined();
    stream.style = style;
    stream.view = null;
    expect(lodFrameStep(stream, g.positions, 5)?.rows).toBeUndefined();
    // No edges given: no rows either.
    const bare = makeSpatialLODStream(g.nodeCount, style, 1, undefined, view);
    expect(lodFrameStep(bare, g.positions, 1)?.rows).toBeUndefined();
  });
});
