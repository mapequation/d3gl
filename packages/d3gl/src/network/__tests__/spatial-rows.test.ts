import { describe, it, expect } from "vitest";
import { buildMortonLODTree, computeLODPositions, computeLODStyle, cut, declutterFrontier, makeCutScratch, makeDeclutterFrontierScratch, visibleWorldRect, type LODTransform, type LODTree } from "../lod.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLeafIncidence, lazySuperEdges, makeLazySuperEdgesScratch, type LazyCut } from "../lazy-super-edges.js";
import { allocateSpatialRows, buildKeptRows, makeSpatialRowsScratch, rowOf, spatialRowsByteLength, spatialRowsGraph, type SpatialRows, type SpatialRowsGraph } from "../spatial-rows.js";
import { MAX_OUTSTANDING, lodFrameStep, lodTreeFromSpatialFrame, makeSpatialLODStream, recycleSpatialFrame, spatialFrameByteLength, type LODView, type SpatialLODFrame } from "../lod-frame.js";
import { layoutBox, layoutFitTransform } from "../fit.js";
import type { SuperEdgeStyleResolved, SuperEdgesData } from "../glyphs.js";

/**
 * Super-edge rows of a spatial tree's kept glyphs (#433): built off the main thread with each streamed tree,
 * for the view the main thread reported, they let the gather read the kept glyphs' rows — bounded by what
 * they link to — instead of walking every edge under the frontier. Pinned here:
 *   - the rows are exactly their definition (per kept cell, each edge's finest cover on the other side,
 *     summed per direction), checked edge by edge against a brute force, in a cross-fade band too;
 *   - `lazySuperEdges` on a tree with rows draws the **same super-edges** as without — every pair, flow,
 *     endpoint, width, colour and arrowhead — over zooms, pans, declutter on and off, a cross-fade band,
 *     directed and undirected lines and half-arrows, weighted and unweighted graphs: with rows for exactly
 *     that cut it walks no leaf run; with rows for another view's cut, or none, it walks the leaves of the
 *     glyphs the rows cannot serve and still draws the same;
 *   - a cut coarser than the one the rows were built at still takes every row (partners merged per cover);
 *     one that opened a partner up rebuilds the rows naming it, once, and a held view then walks nothing;
 *   - the rows read are bounded by what the kept glyphs link to, not by the edges under them;
 *   - a spatial stream given the edges and a view (a transform, or the fit) ships the rows of the glyphs that
 *     view keeps with every rebuilt tree, reuses returned buffers, and builds none without links or a view;
 *   - when the rows shrink (a zoom-in), the stream's pool drops the buffers too large for them, so a warm
 *     stream at the new view allocates nothing and holds no stale buffer.
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

/** The CSR a stream builds once from the graph's edges (#433), per graph. */
const rowsGraphs = new WeakMap<NetworkGraph, SpatialRowsGraph>();
function rowsGraphOf(g: NetworkGraph): SpatialRowsGraph {
  let built = rowsGraphs.get(g);
  if (!built) {
    built = spatialRowsGraph(g.nodeCount, g);
    rowsGraphs.set(g, built);
  }
  return built;
}

/** The rows a stream's worker builds for the cut `c`: one per kept cell. */
function rowsForCut(tree: LODTree, g: NetworkGraph, c: LazyCut): SpatialRows {
  const { leafOrder, leafStart, leafEnd } = tree;
  if (!leafOrder || !leafStart || !leafEnd) throw new Error("not a spatial tree");
  const out = { rows: allocateSpatialRows({ cells: 0, outEntries: 0, inEntries: 0 }) };
  buildKeptRows({ size: tree.size, leafCount: tree.leafCount, leafOrder, leafStart, leafEnd }, c, rowsGraphOf(g), makeSpatialRowsScratch(), (sz) => (out.rows = allocateSpatialRows(sz)));
  return out.rows;
}

function styleOf(directed: boolean, linkStyle: "line" | "half-arrow" = "line"): SuperEdgeStyleResolved {
  return { linkStyle, directed, widthOf: (w) => Math.sqrt(w), colorOf: (w) => [Math.min(255, Math.round(w * 10)), 20, 30, 255], bend: linkStyle === "line" ? 0 : 0.2, arrowSize: 1, maxAggregateRadius: 20 };
}

/** The cut the engine runs (screen-sized, declutter optional), with its covers. */
function cutAt(tree: LODTree, t: LODTransform, declutter: boolean, fadeBand = 0): LazyCut & { fade?: Float32Array } {
  const sc = makeCutScratch();
  const fade = fadeBand > 0 ? new Float32Array(tree.size) : undefined;
  const drawn = cut(tree, t, W, H, { screenSized: true, maxAggregateRadius: 20, recordCulled: true, fadeBand, fadeAlpha: fade }, sc).slice();
  const kept = declutter ? declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: 20, fadeAlpha: fade }, makeDeclutterFrontierScratch()).slice() : drawn;
  return { drawn, kept, culled: sc.culled.slice(0, sc.culledCount), split: sc.split.slice(0, sc.splitCount), fade };
}

/** Every drawn super-edge, by its pair id: flow and every per-instance attribute it is drawn with. */
function byId(d: SuperEdgesData): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const put = (e: number, vals: number[]): void => {
    const id = d.ids[e] ?? -1;
    expect(m.has(id), `pair ${id} drawn twice`).toBe(false);
    m.set(id, vals);
  };
  for (let e = 0; e < d.ids.length; e++) {
    const vals = [d.flows?.[e] ?? NaN];
    const ha = d.halfArrows;
    if (ha) vals.push(...ha.sources.subarray(2 * e, 2 * e + 2), ...ha.targets.subarray(2 * e, 2 * e + 2), ...ha.radii.subarray(2 * e, 2 * e + 2), ...ha.widths.subarray(2 * e, 2 * e + 2), ...ha.colors.subarray(4 * e, 4 * e + 4));
    const l = d.lines;
    if (l) vals.push(...l.sources.subarray(2 * e, 2 * e + 2), ...l.targets.subarray(2 * e, 2 * e + 2), l.widths[e] ?? NaN, ...l.colors.subarray(4 * e, 4 * e + 4));
    const a = d.arrows;
    if (a) vals.push(a.radii[e] ?? NaN, a.sizes[e] ?? NaN);
    put(e, vals);
  }
  return m;
}

function expectSameEdges(got: SuperEdgesData, want: SuperEdgesData | Map<number, number[]>): void {
  const g = byId(got);
  const w = want instanceof Map ? want : byId(want);
  expect(g.size).toBe(w.size);
  for (const [id, vals] of w) {
    const have = g.get(id);
    // One compare per pair on the hot path; the matcher only for a pair that differs (its message names it).
    if (!have || have.length !== vals.length || have.some((v, i) => !Object.is(v, vals[i]))) expect(have, `pair ${id}`).toEqual(vals);
  }
}

/** A tree without the rows: what the lazy gather alone sees. */
const bare = (tree: LODTree): LODTree => ({ ...tree, rows: undefined });

describe("buildKeptRows (#433)", () => {
  for (const band of [0, 0.4]) {
    it(`holds, per kept cell, each edge's finest cover on the other side, summed per direction — brute force${band > 0 ? ", in a cross-fade band" : ""}`, () => {
      const g = fixture(3000, 5);
      const tree = spatialTree(g);
      const { leafStart, leafEnd, leafOrder } = tree;
      if (!leafStart || !leafEnd || !leafOrder) throw new Error("not a spatial tree");
      const n = tree.leafCount;
      const c = cutAt(tree, { k: 2.2, x: W / 2 - 120 * 2.2, y: H / 2 + 60 * 2.2 }, true, band);
      const rows = rowsForCut(tree, g, c);
      const leafOf = (x: number): number[] => Array.from(leafOrder.subarray(leafStart[x] ?? 0, leafEnd[x] ?? 0));
      const size = (x: number): number => (leafEnd[x] ?? 0) - (leafStart[x] ?? 0);
      // Each leaf's finest cover: the smallest drawn glyph not split, or culled root, holding it.
      const split = new Set(c.split);
      const finest = new Int32Array(n).fill(-1);
      for (const x of [...c.drawn, ...c.culled]) {
        if (split.has(x)) continue;
        for (const v of leafOf(x)) if (finest[v] === -1 || size(x) < size(finest[v] ?? 0)) finest[v] = x;
      }
      for (let v = 0; v < n; v++) expect(finest[v], "the covers hold every leaf").toBeGreaterThanOrEqual(0);
      const inside = (v: number, x: number): boolean => {
        const r = tree.leafStart?.[v] ?? -1; // a leaf's rank is its own run
        return r >= (leafStart[x] ?? 0) && r < (leafEnd[x] ?? 0);
      };
      const nestedIn = (h: number, x: number): boolean => (leafStart[h] ?? 0) < (leafEnd[x] ?? 0) && (leafStart[x] ?? 0) < (leafEnd[h] ?? 0);
      const wantOut = new Map<string, number>();
      const wantIn = new Map<string, number>();
      const put = (m: Map<string, number>, x: number, h: number, w: number): void => { m.set(`${x}:${h}`, (m.get(`${x}:${h}`) ?? 0) + w); };
      const keptCells = [...new Set(c.kept)].filter((x) => x >= n).sort((a, b) => a - b);
      for (const x of keptCells) {
        for (let e = 0; e < g.edgeCount; e++) {
          const u = g.source[e] ?? 0;
          const v = g.target[e] ?? 0;
          const w = g.weight[e] ?? 0;
          const hv = finest[v] ?? -1;
          const hu = finest[u] ?? -1;
          if (inside(u, x) && hv !== x && !(band > 0 && nestedIn(hv, x))) put(wantOut, x, hv, w);
          if (inside(v, x) && hu !== x && !(band > 0 && nestedIn(hu, x))) put(wantIn, x, hu, w);
        }
      }
      expect(Array.from(rows.cell)).toEqual(keptCells); // ascending, for rowOf; leaves have no stored row
      const gotOut = new Map<string, number>();
      const gotIn = new Map<string, number>();
      for (let i = 0; i < rows.cell.length; i++) {
        const x = rows.cell[i] ?? -1;
        expect(rowOf(rows, x)).toBe(i);
        for (let e = rows.outOffset[i] ?? 0; e < (rows.outOffset[i + 1] ?? 0); e++) {
          expect(gotOut.has(`${x}:${rows.outNode[e]}`), "an out-row lists a partner once").toBe(false);
          gotOut.set(`${x}:${rows.outNode[e]}`, rows.outFlow[e] ?? NaN);
        }
        for (let e = rows.inOffset[i] ?? 0; e < (rows.inOffset[i + 1] ?? 0); e++) {
          expect(gotIn.has(`${x}:${rows.inNode[e]}`), "an in-row lists a partner once").toBe(false);
          gotIn.set(`${x}:${rows.inNode[e]}`, rows.inFlow[e] ?? NaN);
        }
      }
      expect(gotOut).toEqual(wantOut);
      expect(gotIn).toEqual(wantIn);
      expect(wantOut.size).toBeGreaterThan(200); // non-vacuity
      expect(c.culled.length).toBeGreaterThan(0);
      if (band > 0) expect(c.split.length).toBeGreaterThan(0);
      expect(rowOf(rows, 0)).toBe(-1);
    });
  }
});

describe("lazySuperEdges takes a streamed tree's rows and draws the same super-edges (#433)", () => {
  for (const unit of [false, true]) {
    const n = 6000;
    const g = fixture(n, unit ? 9 : 3, unit);
    const tree = spatialTree(g);
    const views: [string, LODTransform][] = [
      ["fit", { k: 0.9, x: W / 2, y: H / 2 }],
      ["zoomed", { k: 4, x: W / 2 - 150 * 4, y: H / 2 - 80 * 4 }],
      ["deep", { k: 30, x: W / 2 - 300 * 30, y: H / 2 + 120 * 30 }],
      ["panned", { k: 1.6, x: -200, y: 500 }],
    ];
    for (const [linkStyle, directed] of [["line", false], ["line", true], ["half-arrow", true]] as const) for (const band of [0, 0.4]) {
      it(`${unit ? "unweighted" : "weighted"} ${directed ? "directed" : "undirected"} ${linkStyle}: every view, declutter on/off${band > 0 ? ", in a cross-fade band" : ""}`, () => {
        const style = styleOf(directed, linkStyle);
        const inc = buildLeafIncidence(g, directed);
        let culledLeaves = 0;
        let splits = 0;
        let drawnPairs = 0;
        let rebuiltWhenMoved = 0;
        let importedWhenMoved = 0;
        for (const [, t] of views) {
          for (const declutter of [false, true]) {
            {
              const c = cutAt(tree, t, declutter, band);
              const edgeStyle = band > 0 ? { ...style, fadeAlpha: c.fade } : style;
              const view = visibleWorldRect(t, W, H);
              const lazy = byId(lazySuperEdges(bare(tree), c, edgeStyle, view, g.csr, inc, makeLazySuperEdgesScratch()));
              // Rows for exactly this cut (the worker saw the same view): no leaf run is walked.
              const sc = makeLazySuperEdgesScratch();
              const rows = lazySuperEdges({ ...tree, rows: rowsForCut(tree, g, c) }, c, edgeStyle, view, g.csr, inc, sc);
              expectSameEdges(rows, lazy);
              expect(sc.visits, "the row gather walks no leaf run").toBe(0);
              expect(sc.misses).toBe(0);
              expect(sc.labelled).toBe(0);
              expect(sc.imported).toBe(new Set([...c.kept].filter((x) => x >= n)).size);
              // Rows for another view's cut (the view moved since), and none: the glyphs the rows cannot serve
              // walk their leaves, and the edges drawn are still the same.
              const other = cutAt(tree, { k: t.k * 1.7, x: t.x - 90, y: t.y + 40 }, declutter, band);
              const msc = makeLazySuperEdgesScratch();
              const moved = lazySuperEdges({ ...tree, rows: rowsForCut(tree, g, other) }, c, edgeStyle, view, g.csr, inc, msc);
              expectSameEdges(moved, lazy);
              rebuiltWhenMoved += msc.misses;
              importedWhenMoved += msc.imported;
              const none = lazySuperEdges({ ...tree, rows: rowsForCut(tree, g, { ...c, kept: new Uint32Array(0) }) }, c, edgeStyle, view, g.csr, inc, makeLazySuperEdgesScratch());
              expectSameEdges(none, lazy);
              culledLeaves += [...c.culled].filter((x) => x < n).length;
              splits += c.split.length;
              drawnPairs += rows.ids.length;
            }
          }
        }
        // Non-vacuity: culled leaves, a band's split glyphs and many pairs were all exercised, and a moved view
        // both took rows and rebuilt some.
        expect(culledLeaves).toBeGreaterThan(0);
        if (band > 0) expect(splits).toBeGreaterThan(0);
        expect(drawnPairs).toBeGreaterThan(500);
        expect(rebuiltWhenMoved).toBeGreaterThan(0);
        expect(importedWhenMoved).toBeGreaterThan(0);
      });
    }
  }

  it("takes every row at a cut coarser than the rows', merging the partners it coarsened; a cut that opened a partner up rebuilds the rows naming it, once", () => {
    const g = fixture(6000, 3);
    const tree = spatialTree(g);
    const inc = buildLeafIncidence(g, true);
    const t: LODTransform = { k: 0.9, x: W / 2, y: H / 2 };
    const view = visibleWorldRect(t, W, H);
    const c = cutAt(tree, t, true);
    const rows = rowsForCut(tree, g, c);
    const { parent } = tree;
    if (!parent) throw new Error("not a spatial tree");
    // Coarsen: a parent all of whose children are drawn and decluttered away is drawn instead of them.
    const kept = new Set(c.kept);
    const drawnSet = new Set(c.drawn);
    const children = new Map<number, number[]>();
    for (let x = 0; x < tree.size; x++) {
      const p = parent[x] ?? -1;
      if (p >= 0) children.set(p, [...(children.get(p) ?? []), x]);
    }
    const merged = [...children].filter(([, ch]) => ch.every((x) => drawnSet.has(x) && !kept.has(x))).map(([p, ch]) => ({ p, ch }));
    expect(merged.length, "a parent of decluttered glyphs only").toBeGreaterThan(0);
    const gone = new Set(merged.flatMap((m) => m.ch));
    const coarse: LazyCut = { ...c, drawn: Uint32Array.from([...[...c.drawn].filter((x) => !gone.has(x)), ...merged.map((m) => m.p)]) };
    const sc = makeLazySuperEdgesScratch();
    const out = lazySuperEdges({ ...tree, rows }, coarse, styleOf(true), view, g.csr, inc, sc);
    expectSameEdges(out, lazySuperEdges(bare(tree), coarse, styleOf(true), view, g.csr, inc));
    expect(sc.misses, "every kept cell's row is taken").toBe(0);
    expect(sc.visits).toBe(0);
    expect(sc.imported).toBe(new Set([...c.kept].filter((x) => x >= tree.leafCount)).size);
    // Open up: a decluttered glyph some kept row names is drawn as its children instead — the rows naming it
    // are rebuilt from leaves (the others are taken), then a held view walks nothing.
    const named = new Set<number>();
    for (let i = 0; i < rows.outNode.length; i++) named.add(rows.outNode[i] ?? -1);
    const opened = [...c.drawn].find((x) => !kept.has(x) && x >= tree.leafCount && named.has(x) && (children.get(x) ?? []).length > 1);
    if (opened === undefined) throw new Error("no decluttered cell a row names");
    const fine: LazyCut = { ...c, drawn: Uint32Array.from([...[...c.drawn].filter((x) => x !== opened), ...(children.get(opened) ?? [])]) };
    const fsc = makeLazySuperEdgesScratch();
    const rowTree: LODTree = { ...tree, rows };
    const first = lazySuperEdges(rowTree, fine, styleOf(true), view, g.csr, inc, fsc);
    expectSameEdges(first, lazySuperEdges(bare(tree), fine, styleOf(true), view, g.csr, inc));
    expect(fsc.misses).toBeGreaterThan(0);
    expect(fsc.imported).toBeGreaterThan(0);
    expect(fsc.misses + fsc.imported + [...fine.kept].filter((x) => x < tree.leafCount).length).toBe(fine.kept.length);
    const held = lazySuperEdges(rowTree, fine, styleOf(true), view, g.csr, inc, fsc);
    expect(fsc.misses, "held view: rows rebuilt").toBe(0);
    expect(fsc.visits, "held view: incidences walked").toBe(0);
    expect(fsc.hits).toBe(fine.kept.length);
    expectSameEdges(held, first);
    // Another tree (the next streamed frame): the memo starts over and takes the rows again.
    lazySuperEdges({ ...rowTree }, c, styleOf(true), view, g.csr, inc, fsc);
    expect(fsc.hits).toBe(0);
    expect(fsc.misses).toBe(0);
  });

  it("reads rows bounded by what the kept glyphs link to, not by the edges under them: 4× the graph in the same extent", () => {
    const t: LODTransform = { k: 0.9, x: W / 2, y: H / 2 };
    const view = visibleWorldRect(t, W, H);
    const measure = (n: number): { entries: number; lazyRows: number; leafDegrees: number; visits: number; drawn: number } => {
      const g = fixture(n, 4);
      const tree = spatialTree(g);
      const inc = buildLeafIncidence(g, false);
      const c = cutAt(tree, t, false);
      const lazySc = makeLazySuperEdgesScratch();
      lazySuperEdges(bare(tree), c, styleOf(false), view, g.csr, inc, lazySc);
      const sc = makeLazySuperEdgesScratch();
      lazySuperEdges({ ...tree, rows: rowsForCut(tree, g, c) }, c, styleOf(false), view, g.csr, inc, sc);
      let leafDegrees = 0;
      for (const x of c.kept) if (x < n) leafDegrees += g.csr.degree[x] ?? 0;
      return { entries: sc.entries, lazyRows: lazySc.ents, leafDegrees, visits: lazySc.visits, drawn: c.drawn.length };
    };
    const small = measure(20_000);
    const large = measure(80_000);
    // The lazy gather walks every incidence under the frontier: 4× the edges, ~4× the work.
    expect(large.visits).toBeGreaterThan(3 * small.visits);
    expect(large.drawn).toBeLessThan(1.5 * small.drawn);
    // The rows read are the kept glyphs' rows — one entry per cover they link to, per direction — plus the kept
    // leaves' own edges: at most twice what the lazy gather's rows hold, whatever the edges under them.
    for (const m of [small, large]) expect(m.entries).toBeLessThanOrEqual(2 * m.lazyRows + m.leafDegrees);
    expect(large.entries * 4).toBeLessThan(large.visits);
  });
});

describe("a spatial stream ships the rows of the glyphs its view keeps with each tree (#433)", () => {
  it("builds them for every rebuilt tree at the view (a transform, or the fit), reuses buffers, and builds none without links or a view", () => {
    const g = fixture(3000, 7);
    const style = { radii: new Float32Array(g.nodeCount).fill(3), weight: g.strength };
    const t: LODTransform = { k: 1.3, x: W / 2 - 60, y: H / 2 + 30 };
    const view: LODView = { transform: t, fitPad: 3, width: W, height: H, maxAggregateRadius: 20, screenSized: true, fadeBand: 0, declutter: true };
    const stream = makeSpatialLODStream(g.nodeCount, style, 1, g, view);
    const f1 = lodFrameStep(stream, g.positions, 1);
    if (!f1?.rows) throw new Error("no rows");
    const tree = lodTreeFromSpatialFrame(f1);
    // Exactly the rows of the glyphs the engine's cut and declutter keep at that view.
    const c = cutAt(tree, t, true);
    const want = rowsForCut(tree, g, c);
    expect(tree.rows?.cell).toEqual(want.cell);
    expect(tree.rows?.outNode).toEqual(want.outNode);
    expect(tree.rows?.outFlow).toEqual(want.outFlow);
    expect(tree.rows?.inNode).toEqual(want.inNode);
    expect(tree.rows?.inFlow).toEqual(want.inFlow);
    expect(want.cell.length).toBeGreaterThan(10);
    // A returned rows buffer is reused by the next rebuild.
    const rowsBuffer = f1.rows.buffer;
    recycleSpatialFrame(stream, f1.buffer, f1.rows.buffer);
    const f2 = lodFrameStep(stream, g.positions, 2);
    expect(f2?.rows?.buffer).toBe(rowsBuffer);
    // Without declutter, those of every drawn glyph.
    stream.view = { ...view, declutter: false };
    const f0 = lodFrameStep(stream, g.positions, 100);
    if (!f0?.rows) throw new Error("no rows");
    const all = lodTreeFromSpatialFrame(f0);
    expect(all.rows?.cell).toEqual(rowsForCut(all, g, cutAt(all, t, false)).cell);
    expect(all.rows?.cell.length).toBeGreaterThan(want.cell.length);
    recycleSpatialFrame(stream, f0.buffer, f0.rows.buffer);
    stream.view = view;
    // Following the fit: the cut at the fit the engine frames the positions at.
    stream.view = { ...view, transform: null };
    const f3 = lodFrameStep(stream, g.positions, 3);
    if (!f3?.rows) throw new Error("no rows at the fit");
    const fitTree = lodTreeFromSpatialFrame(f3);
    const box = layoutBox(g.positions, g.nodeCount, { trimStragglers: true });
    if (!box) throw new Error("no fit box");
    const fitT = layoutFitTransform(box, W, H, 3, true);
    expect(fitTree.rows?.cell).toEqual(rowsForCut(fitTree, g, cutAt(fitTree, fitT, true)).cell);
    // The frame names the box it framed, so the engine frames the same one — in shared mode the live positions
    // are newer than the tree by the time it repaints; at a transform there is none to name.
    expect(f3.header.fitBox).toEqual(box);
    expect(f1.header.fitBox).toBeUndefined();
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

  it("drops pooled rows buffers too large for the rows after a zoom-in: the warm stream reuses buffers and holds no stale one", () => {
    const g = fixture(6000, 11);
    const style = { radii: new Float32Array(g.nodeCount).fill(3), weight: g.strength };
    const fit: LODView = { transform: { k: 0.6, x: W / 2, y: H / 2 }, fitPad: 3, width: W, height: H, maxAggregateRadius: 20, screenSized: true, fadeBand: 0, declutter: false };
    const stream = makeSpatialLODStream(g.nodeCount, style, 1, g, fit);
    // The engine draws one tree and holds the one it replaced until the next repaint, then hands it back.
    const held: SpatialLODFrame[] = [];
    let id = 0;
    const seen = new Set<ArrayBuffer>();
    const step = (): SpatialLODFrame => {
      const f = lodFrameStep(stream, g.positions, ++id);
      if (!f?.rows) throw new Error("no rows");
      held.push(f);
      const old = held.length > 2 ? held.shift() : undefined;
      if (old) recycleSpatialFrame(stream, old.buffer, old.rows?.buffer);
      return f;
    };
    for (let i = 0; i < 6; i++) seen.add(step().rows?.buffer ?? new ArrayBuffer(0));
    const fitBytes = spatialRowsByteLength(held[held.length - 1]?.rows?.sizes ?? { cells: 0, outEntries: 0, inEntries: 0 });
    // Zoom in: the rows shrink by far more than half.
    stream.view = { ...fit, transform: { k: 40, x: W / 2, y: H / 2 } };
    let fresh = 0;
    for (let i = 0; i < 12; i++) {
      const f = step();
      const rows = f.rows;
      if (!rows) throw new Error("no rows");
      const bytes = spatialRowsByteLength(rows.sizes);
      expect(bytes * 4).toBeLessThan(fitBytes);
      if (!seen.has(rows.buffer)) {
        seen.add(rows.buffer);
        // Only while the fit view's frames are still out does the stream allocate for the new size.
        if (i >= MAX_OUTSTANDING) fresh++;
      }
      // Once the fit view's frames are back, nothing pooled is too large (or too small) for this view's rows.
      const links = stream.links;
      if (!links) throw new Error("no links");
      if (i >= MAX_OUTSTANDING) for (const b of links.pool) {
        expect(b.byteLength).toBeGreaterThanOrEqual(bytes);
        expect(b.byteLength).toBeLessThanOrEqual(2 * bytes);
      }
    }
    expect(fresh).toBe(0);
  });

  it("drops pooled frame buffers too small for the tree after it grows (a collapsed layout spreads out)", () => {
    const g = fixture(6000, 12);
    const style = { radii: new Float32Array(g.nodeCount).fill(3), weight: g.strength };
    const stream = makeSpatialLODStream(g.nodeCount, style, 1);
    const held: SpatialLODFrame[] = [];
    const seen = new Set<ArrayBuffer>();
    let id = 0;
    const step = (positions: Float32Array): SpatialLODFrame => {
      const f = lodFrameStep(stream, positions, ++id);
      if (!f) throw new Error("no frame");
      held.push(f);
      const old = held.length > 2 ? held.shift() : undefined;
      if (old) recycleSpatialFrame(stream, old.buffer);
      return f;
    };
    // Every node on one of a few dozen points: the tree has a few cells over its leaves.
    const collapsed = g.positions.map((v, i) => Math.round((v + (i % 2) * 7) / 120) * 120);
    let small = 0;
    for (let i = 0; i < 6; i++) {
      const f = step(collapsed);
      seen.add(f.buffer);
      small = spatialFrameByteLength(f.header);
    }
    let fresh = 0;
    for (let i = 0; i < 12; i++) {
      const f = step(g.positions);
      const bytes = spatialFrameByteLength(f.header);
      expect(bytes).toBeGreaterThan((9 / 8) * small); // past the slack of the buffers the collapsed trees used
      if (!seen.has(f.buffer)) {
        seen.add(f.buffer);
        if (i >= MAX_OUTSTANDING) fresh++;
      }
      if (i >= MAX_OUTSTANDING) for (const b of stream.pool) {
        expect(b.byteLength).toBeGreaterThanOrEqual(bytes);
        expect(b.byteLength).toBeLessThanOrEqual(2 * bytes);
      }
    }
    expect(fresh).toBe(0);
  });
});
