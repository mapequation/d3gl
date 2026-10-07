import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import {
  buildMortonLODTree,
  computeLODCrowding,
  computeLODGeometry,
  crowdingHorizon,
  cut,
  declutterFrontier,
  makeCutScratch,
  makeDeclutterFrontierScratch,
  updateLODPositionsForLeaves,
  visibleWorldRect,
  type LODTransform,
  type LODTree,
} from "../lod.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLeafIncidence, lazySuperEdges, makeLazySuperEdgesScratch, type LazySuperEdgesScratch } from "../lazy-super-edges.js";
import { buildKeptRows, incidenceSourceEdges, makeSpatialRowsScratch, spatialRowsByteLength, spatialRowsGraph, spatialRowsViews, type SpatialRows, type SpatialRowsGraph, type SpatialRowsScratch } from "../spatial-rows.js";
import type { SuperEdgeStyleResolved } from "../glyphs.js";

/**
 * Per-frame regression guard for the spatial LOD source (#343, AGENTS.md lifecycle §5): one frame is the
 * engine's `computeFrontier` + super-edge emit on a spatial tree — `cut` (recording culled roots) →
 * `declutterFrontier` → `lazySuperEdges` — over a web-like graph whose communities the layout spreads out.
 *
 * Legs (each a sweep of real transforms, the engine call shape on engine-owned scratch):
 *   - **streamed**: the zoom sweep with the row memo cold every frame, as each streamed frame rebuilds the
 *     tree — reductions ON (declutter, default expandPx); the frontier must stay screen-bounded;
 *   - **zoom**: the same sweep after the layout settled (one tree, the memo warm across frames);
 *   - **all leaves**: reductions ON over a visible frontier of every leaf (expandPx → 0, declutter on) —
 *     LOD is not allowed to shrink the set;
 *   - **reductions off**: every leaf drawn and kept (no declutter), so the gather walks every incidence
 *     and draws every edge;
 *   - **drag**: one held leaf moved per frame (`updateLODPositionsForLeaves`, the drag repaint) with the
 *     memo warm;
 *   - **streamed-rows** (#433): the streamed sweep on the trees a streaming layout delivers — each with the
 *     super-edge rows its worker built for the glyphs that frame's view keeps: zero rows computed and zero
 *     incidences walked on every frame, the same super-edges as the lazy gather (pinned at the fit frame), and
 *     row entries read bounded by the kept glyphs' rows (at most twice the lazy gather's row entries, plus the
 *     kept leaves' own edges) — not by the edges under them. The worker's rows build is timed apart and
 *     reported as **rows-build** (not a main-thread cost);
 *   - **mixed-pan** / **mixed-pan-leaf** (#447, #463): 1-px pans of a large mixed view (a seed disc of overlapping
 *     glyphs at a threshold where about half the kept glyphs are leaves, linked to each other), the second with the
 *     engine's leaf links (the gather lists the links between two kept leaves as it reads their rows). A kept leaf's
 *     row comes from the memo: none rebuilt on a held view, at most 1% of the kept glyphs per pan;
 *   - **streamed-gesture** (#433): a pan and zoom while the layout streams, each tree's rows built one view
 *     behind the one it is drawn at (the worker's round trip): the same super-edges, and never more
 *     incidences walked than the lazy gather at that cut (the kept glyphs whose rows name a cover the view
 *     opened up walk their leaves; the rest take their rows).
 *
 * Deterministic signatures, asserted unconditionally: the spatial tree carries **no super-edge CSR** (the
 * gather never builds one); a **held view** re-emits from the row memo with zero rows rebuilt and zero
 * incidences walked, byte-identical; the gather's per-tree-node and per-leaf scratch is never reallocated
 * once warm; the streamed frontier stays bounded by the screen. Wall-clock ceilings: generous (~5-10× the
 * calibrated medians) always-on at 100k; under `PERF_ASSERT` at the tier's N:
 *   BENCH_SPATIAL_LOD=1 BENCH_SPATIAL_LOD_NODES=1000000 pnpm exec vitest run packages/d3gl/src/network/__tests__/spatial-lod-perf.test.ts
 * Each bench run appends a labelled line per leg to /tmp/spatial-lod-perf.txt (BENCH_SPATIAL_LOD_LABEL).
 */
const BENCH = !!process.env.BENCH_SPATIAL_LOD;
const BENCH_N = Number(process.env.BENCH_SPATIAL_LOD_NODES) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
const W = 1280;
const H = 800;
const MAX_AGG = 26;
const LOCAL_N = 100_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/**
 * A web-like graph laid out the way a force layout spreads it: communities of 50 (two intra-community
 * edges per node) plus one long-range edge per node, each community's members scattered widely around a
 * random centre, so communities overlap in the plane.
 */
function webLike(n: number): { graph: NetworkGraph; tree: LODTree; centroid: [number, number]; baseK: number } {
  const r = rng(11);
  const m = 3 * n;
  const src = new Uint32Array(m);
  const tgt = new Uint32Array(m);
  const size = 50;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const base = i - (i % size);
    const span = Math.min(size, n - base);
    src[e] = i; tgt[e++] = base + Math.floor(r() * span);
    src[e] = i; tgt[e++] = base + Math.floor(r() * span);
    src[e] = i; tgt[e++] = Math.floor(r() * n);
  }
  const graph = buildGraph({ nodeCount: n, source: src, target: tgt });
  const R = 20 * Math.sqrt(n);
  const cx = new Float64Array(Math.ceil(n / size));
  const cy = new Float64Array(Math.ceil(n / size));
  for (let c = 0; c < cx.length; c++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * R;
    cx[c] = Math.cos(a) * d;
    cy[c] = Math.sin(a) * d;
  }
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / size);
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(-2 * Math.log(r() + 1e-12)) * R * 0.15;
    graph.positions[2 * i] = cx[c]! + Math.cos(a) * d;
    graph.positions[2 * i + 1] = cy[c]! + Math.sin(a) * d;
  }
  const tree = buildMortonLODTree(graph.positions, n);
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) radii[i] = 2 + Math.sqrt(graph.csr.degree[i]!);
  computeLODGeometry(tree, graph, radii, graph.strength);
  // As the engine does with every tree it draws (#426): the cut opens an aggregate whose members clear.
  computeLODCrowding(tree, { screenSized: true, expandPx: crowdingHorizon(tree) });
  const baseK = (0.85 * Math.min(W, H)) / (2.4 * R);
  return { graph, tree, centroid: [0, 0], baseK };
}

const at = (centroid: [number, number], k: number): LODTransform => ({ k, x: W / 2 - centroid[0] * k, y: H / 2 - centroid[1] * k });
const STYLE: SuperEdgeStyleResolved = {
  linkStyle: "line",
  directed: false,
  widthOf: (w) => Math.min(4, 0.4 + Math.sqrt(w)),
  colorOf: () => [90, 100, 120, 120],
  bend: 0,
  arrowSize: 1,
  maxAggregateRadius: MAX_AGG,
};

const LEAF_STYLE: SuperEdgeStyleResolved = { ...STYLE, leafLinks: true };

/** One engine frame on a spatial tree: cut (culled roots recorded) → declutter → super-edges — lazy, or from
 *  the worker's rows when `rows` is given (a streamed tree, #433). */
function frame(
  f: ReturnType<typeof webLike>,
  t: LODTransform,
  s: { cut: ReturnType<typeof makeCutScratch>; dc: ReturnType<typeof makeDeclutterFrontierScratch>; lazy: LazySuperEdgesScratch },
  inc: ReturnType<typeof buildLeafIncidence>,
  opts: { expandPx?: number; declutter: boolean; rows?: SpatialRows; sourceEdges?: Uint32Array },
): { drawn: number; kept: number; edges: number; ids: number[]; flows: number[] } {
  const drawn = cut(f.tree, t, W, H, { expandPx: opts.expandPx, screenSized: true, maxAggregateRadius: MAX_AGG, recordCulled: true }, s.cut);
  const kept = opts.declutter ? declutterFrontier(f.tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG }, s.dc) : drawn;
  const covers = { drawn, kept, culled: s.cut.culled.subarray(0, s.cut.culledCount), split: s.cut.split.subarray(0, s.cut.splitCount) };
  const view = visibleWorldRect(t, W, H);
  // With `sourceEdges`, as the engine gathers on a spatial tree (#447): the links between two kept leaves are left
  // to the full-detail path and listed in the same read of the kept leaves' rows.
  const style = opts.sourceEdges ? LEAF_STYLE : STYLE;
  const out = lazySuperEdges(opts.rows ? { ...f.tree, rows: opts.rows } : f.tree, covers, style, view, f.graph.csr, inc, s.lazy, opts.sourceEdges);
  return { drawn: drawn.length, kept: kept.length, edges: out.ids.length, ids: out.ids, flows: out.flows ?? [] };
}

/** The super-edge rows a streaming layout's worker builds for the glyphs `t`'s cut and declutter keep (#433), timed. */
function workerRows(f: ReturnType<typeof webLike>, t: LODTransform, graph: SpatialRowsGraph, scratch: SpatialRowsScratch, cutSc: ReturnType<typeof makeCutScratch>, dcSc: ReturnType<typeof makeDeclutterFrontierScratch>): { rows: SpatialRows; ms: number; bytes: number } {
  const { leafOrder, leafStart, leafEnd } = f.tree;
  if (!leafOrder || !leafStart || !leafEnd) throw new Error("a spatial tree carries its leaf runs");
  const t0 = performance.now();
  const drawn = cut(f.tree, t, W, H, { screenSized: true, maxAggregateRadius: MAX_AGG, recordCulled: true }, cutSc);
  const kept = declutterFrontier(f.tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG }, dcSc);
  const covers = { drawn, kept, culled: cutSc.culled.subarray(0, cutSc.culledCount), split: cutSc.split.subarray(0, cutSc.splitCount) };
  let rows: SpatialRows | null = null;
  let bytes = 0;
  buildKeptRows({ size: f.tree.size, leafCount: f.tree.leafCount, leafOrder, leafStart, leafEnd }, covers, graph, scratch, (sizes) => {
    bytes = spatialRowsByteLength(sizes);
    rows = spatialRowsViews(new ArrayBuffer(bytes), sizes);
    return rows;
  });
  const ms = performance.now() - t0;
  if (!rows) throw new Error("no rows built");
  return { rows, ms, bytes };
}

function stats(ts: number[]): { median: number; worst: number } {
  const s = [...ts].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, worst: s[s.length - 1]! };
}

interface LegResult { name: string; median: number; worst: number; drawn: number; kept: number; edges: number; visits: number; entries: number }

/** Run every leg on `f`, asserting the deterministic signatures; returns the timings per leg. */
function runLegs(f: ReturnType<typeof webLike>, frames: number): LegResult[] {
  const inc = buildLeafIncidence(f.graph, true);
  const s = { cut: makeCutScratch(), dc: makeDeclutterFrontierScratch(), lazy: makeLazySuperEdgesScratch() };
  const results: LegResult[] = [];
  expect(f.tree.superEdgeOffset).toBeUndefined(); // the gather never builds a super-edge CSR
  const sweepK = (i: number): number => f.baseK * Math.pow(2, (6 * i) / (frames - 1)); // fit → 64×
  let sweepAt = 0; // the streamed-rows leg's frame, set by its worker step
  const leg = (name: string, body: (i: number) => { drawn: number; kept: number; edges: number }, before?: (i: number) => void): void => {
    const ts: number[] = [];
    let drawn = 0, kept = 0, edges = 0, visits = 0, entries = 0;
    for (let i = 0; i < frames; i++) {
      before?.(i);
      const t0 = performance.now();
      const r = body(i);
      ts.push(performance.now() - t0);
      drawn = Math.max(drawn, r.drawn);
      kept = Math.max(kept, r.kept);
      edges = Math.max(edges, r.edges);
      visits = Math.max(visits, s.lazy.visits);
      entries = Math.max(entries, s.lazy.entries);
    }
    results.push({ name, ...stats(ts), drawn, kept, edges, visits, entries });
  };

  // Warm-up: JIT and scratch high-water (the reductions-off frame is the largest).
  frame(f, at(f.centroid, f.baseK * 0.5), s, inc, { expandPx: 1e-6, declutter: false });
  frame(f, at(f.centroid, f.baseK), s, inc, { declutter: true });
  const warm = { cover: s.lazy.cover, label: s.lazy.label, up: s.lazy.up, upGen: s.lazy.upGen, rowMark: s.lazy.rowMark, rowSlot: s.lazy.rowSlot };

  // streamed: memo cold every frame (each streamed frame is a new tree).
  leg("streamed", (i) => frame(f, at(f.centroid, sweepK(i)), s, inc, { declutter: true }), () => { s.lazy.memoTree = null; });
  for (const r of results) if (r.name === "streamed") expect(r.drawn, "the spatial frontier stays bounded by the screen").toBeLessThan(5000);
  // zoom: one settled tree, memo warm across frames.
  leg("zoom", (i) => frame(f, at(f.centroid, sweepK(i)), s, inc, { declutter: true }));
  // all leaves: a visible frontier of every leaf, reductions (declutter) on.
  // (Half the fit scale, so the scattered tails are on screen too.)
  leg("all-leaves", (i) => frame(f, at(f.centroid, f.baseK * (0.5 + i * 0.005)), s, inc, { expandPx: 1e-6, declutter: true }));
  // reductions off: every leaf drawn and kept.
  leg("reductions-off", (i) => frame(f, at(f.centroid, f.baseK * (0.5 + i * 0.005)), s, inc, { expandPx: 1e-6, declutter: false }));
  for (const r of results) if (r.name === "reductions-off") expect(r.drawn, "reductions off draws every leaf").toBe(f.tree.leafCount);
  // The kept glyphs are disjoint covers, so a frame walks each graph incidence at most once: the gather is
  // O(edges under the kept glyphs), never a multiple of the edge count (e.g. a walk per pair or per cover).
  const incidences = f.graph.csr.neighbors.length;
  for (const r of results) expect(r.visits, `${r.name}: incidences walked in one frame`).toBeLessThanOrEqual(incidences);
  // drag: one held leaf moves per frame (the drag repaint), memo warm.
  const held = new Uint32Array([7]);
  const parent = f.tree.parent;
  if (!parent) throw new Error("a spatial tree carries its parent map");
  const t4 = at(f.centroid, f.baseK * 4);
  frame(f, t4, s, inc, { declutter: true });
  leg("drag", () => frame(f, t4, s, inc, { declutter: true }), (i) => {
    f.graph.positions[14] = f.graph.positions[14]! + (i % 2 === 0 ? 3 : -3) / t4.k;
    updateLODPositionsForLeaves(f.tree, f.graph.positions, held, parent);
  });

  // streamed-rows (#433): the same sweep on streamed trees, whose links come from the rows the worker built
  // for each frame's view (a new tree object per frame: nothing carries over, as for a streamed frame).
  const rowsGraph = spatialRowsGraph(f.graph.nodeCount, f.graph);
  const rowsScratch = makeSpatialRowsScratch();
  const workerCut = makeCutScratch();
  const workerDeclutter = makeDeclutterFrontierScratch();
  const fit = at(f.centroid, f.baseK);
  const fitRows = workerRows(f, fit, rowsGraph, rowsScratch, workerCut, workerDeclutter);
  const lazyFit = frame(f, fit, s, inc, { declutter: true });
  s.lazy.memoTree = null;
  const rowsFit = frame(f, fit, s, inc, { declutter: true, rows: fitRows.rows });
  const byId = (ids: number[], flows: number[]): Map<number, number> => new Map(ids.map((id, i) => [id, flows[i] ?? NaN]));
  expect(byId(rowsFit.ids, rowsFit.flows), "the rows gather draws the lazy gather's super-edges").toEqual(byId(lazyFit.ids, lazyFit.flows));
  const buildMs: number[] = [];
  let buildBytes = 0;
  let buildEntries = 0;
  let frameRows: SpatialRows = fitRows.rows;
  const lazyCheck = makeLazySuperEdgesScratch();
  leg("streamed-rows", () => {
    const r = frame(f, at(f.centroid, sweepK(sweepAt)), s, inc, { declutter: true, rows: frameRows });
    expect(s.lazy.misses, "a streamed repaint with the worker's rows computes no row").toBe(0);
    expect(s.lazy.visits, "a streamed repaint with the worker's rows walks no incidence").toBe(0);
    return r;
  }, (i) => {
    sweepAt = i;
    if (i > 0) {
      // The last frame's rows read against the lazy gather's rows of the same cut (outside the timing): one
      // entry per cover a kept glyph links to, per direction, plus the kept leaves' own edges.
      const t = at(f.centroid, sweepK(i - 1));
      const drawn = cut(f.tree, t, W, H, { screenSized: true, maxAggregateRadius: MAX_AGG, recordCulled: true }, workerCut);
      const kept = declutterFrontier(f.tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG }, workerDeclutter);
      let leafDegrees = 0;
      for (const g of kept) if (g < f.tree.leafCount) leafDegrees += f.graph.csr.degree[g] ?? 0;
      const read = s.lazy.entries;
      lazySuperEdges({ ...f.tree }, { drawn, kept, culled: workerCut.culled.subarray(0, workerCut.culledCount), split: workerCut.split.subarray(0, workerCut.splitCount) }, STYLE, visibleWorldRect(t, W, H), f.graph.csr, inc, lazyCheck);
      expect(read, "row entries read, bounded by the kept glyphs' rows").toBeLessThanOrEqual(2 * lazyCheck.ents + leafDegrees);
    }
    const b = workerRows(f, at(f.centroid, sweepK(i)), rowsGraph, rowsScratch, workerCut, workerDeclutter);
    frameRows = b.rows;
    buildMs.push(b.ms);
    buildBytes = Math.max(buildBytes, b.bytes);
    buildEntries = Math.max(buildEntries, b.rows.outNode.length + b.rows.inNode.length);
  });
  // streamed-gesture (#433): a pan and zoom while the layout streams. Each tree's rows were built one view
  // behind the one it is drawn at (the worker's round trip), so a kept glyph whose row names a cover the new
  // view opened up, or that the rows do not list, walks its leaves — never more than the lazy gather walks at
  // that cut, and drawing the same super-edges; the rest take their rows.
  const k0 = f.baseK * 4;
  const gestureT = (i: number): LODTransform => {
    const k = k0 * Math.pow(1.08, i);
    const base = at(f.centroid, k);
    return { k, x: base.x + 30 * i, y: base.y - 12 * i };
  };
  const gestureCut = makeCutScratch();
  const gestureDeclutter = makeDeclutterFrontierScratch();
  const lazyAt = (t: LODTransform): { visits: number; ids: number[]; flows: number[] } => {
    const drawn = cut(f.tree, t, W, H, { screenSized: true, maxAggregateRadius: MAX_AGG, recordCulled: true }, gestureCut);
    const kept = declutterFrontier(f.tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG }, gestureDeclutter);
    const out = lazySuperEdges({ ...f.tree }, { drawn, kept, culled: gestureCut.culled.subarray(0, gestureCut.culledCount), split: gestureCut.split.subarray(0, gestureCut.splitCount) }, STYLE, visibleWorldRect(t, W, H), f.graph.csr, inc, lazyCheck);
    return { visits: lazyCheck.visits, ids: out.ids, flows: out.flows ?? [] };
  };
  let gestureRows: SpatialRows = fitRows.rows;
  let imported = 0;
  let rebuilt = 0;
  let gestureLazyVisits = 0;
  leg("streamed-gesture", (i) => frame(f, gestureT(i + 1), s, inc, { declutter: true, rows: gestureRows }), (i) => {
    if (i > 0) {
      // The last repaint (at gestureT(i)) against the lazy gather at the same cut, outside the timing.
      const read = { visits: s.lazy.visits, imported: s.lazy.imported, misses: s.lazy.misses };
      const lazy = lazyAt(gestureT(i));
      expect(read.visits, "a repaint one view behind walks no more than the lazy gather").toBeLessThanOrEqual(lazy.visits);
      imported += read.imported;
      rebuilt += read.misses;
      gestureLazyVisits = Math.max(gestureLazyVisits, lazy.visits);
    }
    gestureRows = workerRows(f, gestureT(i), rowsGraph, rowsScratch, workerCut, workerDeclutter).rows;
  });
  {
    // The same super-edges as the lazy gather, one view behind.
    const behind = frame(f, gestureT(1), s, inc, { declutter: true, rows: workerRows(f, gestureT(0), rowsGraph, rowsScratch, workerCut, workerDeclutter).rows });
    const lazy = lazyAt(gestureT(1));
    expect(byId(behind.ids, behind.flows), "one view behind, the rows gather draws the lazy gather's super-edges").toEqual(byId(lazy.ids, lazy.flows));
    expect(imported, "kept glyphs whose rows carried over to the next view").toBeGreaterThan(0);
    console.log(`streamed-gesture: rows taken ${imported}, rebuilt from leaves ${rebuilt}; lazy walks up to ${gestureLazyVisits.toLocaleString()} incidences per repaint`);
  }
  const lazyStreamed = results.find((r) => r.name === "streamed");
  const rowsStreamed = results.find((r) => r.name === "streamed-rows");
  if (!lazyStreamed || !rowsStreamed) throw new Error("missing legs");
  expect(rowsStreamed.visits).toBe(0);
  expect(rowsStreamed.entries).toBeGreaterThan(0);
  expect(rowsStreamed.entries, "row entries read vs the lazy streamed leg's incidences").toBeLessThan(lazyStreamed.visits);
  const build = stats(buildMs);
  results.push({ name: "rows-build", median: build.median, worst: build.worst, drawn: 0, kept: 0, edges: buildBytes, visits: 0, entries: buildEntries });

  // Held view: the second emit of an unchanged view walks no incidence and rebuilds no row.
  const tHeld = at(f.centroid, f.baseK * 2);
  const a = frame(f, tHeld, s, inc, { declutter: true });
  const b = frame(f, tHeld, s, inc, { declutter: true });
  expect(s.lazy.misses, "held view: rows rebuilt").toBe(0);
  expect(s.lazy.visits, "held view: incidences walked").toBe(0);
  expect(s.lazy.labelled, "held view: leaves labelled (O(leaves under the frontier))").toBe(0);
  expect(s.lazy.hits).toBe(b.kept);
  expect(b.ids).toEqual(a.ids);
  // Scratch over tree nodes / leaves is never reallocated once warm.
  expect(s.lazy.cover).toBe(warm.cover);
  expect(s.lazy.label).toBe(warm.label);
  expect(s.lazy.up).toBe(warm.up);
  expect(s.lazy.upGen).toBe(warm.upGen);
  expect(s.lazy.rowMark).toBe(warm.rowMark);
  expect(s.lazy.rowSlot).toBe(warm.rowSlot);
  return results;
}

/**
 * The mixed view (#447, #463): a layout's evenly spaced seed disc (the cold start's), world-sized glyphs, and an
 * expand threshold at which about half the kept glyphs are leaves, many of them linked to each other — a large
 * visible set of leaves and aggregates (~30k glyphs at 100k nodes, ~300k at 1M). On it, the engine's gather lists
 * the links between two kept leaves as it reads their rows (`sourceEdges`, the leaf links) and gathers the rest.
 */
function seedDisc(n: number, directed: boolean): { graph: NetworkGraph; tree: LODTree; fit: LODTransform; spacingPx: number } {
  const r = rng(0x426);
  const src = new Uint32Array(5 * n);
  const tgt = new Uint32Array(5 * n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const base = i - (i % 40);
    const span = Math.min(40, n - base);
    for (let k = 0; k < 2; k++) { src[e] = i; tgt[e++] = base + Math.floor(r() * span); }
    const far = 2 + (r() < 0.6 ? 1 : 0);
    for (let k = 0; k < far; k++) { src[e] = i; tgt[e++] = Math.floor(r() * n); }
  }
  const graph = buildGraph({ nodeCount: n, source: src.subarray(0, e), target: tgt.subarray(0, e), directed });
  const R = Math.sqrt(1000 * n); // the force equilibrium radius of the default parameters
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const d = R * Math.sqrt((i + 0.5) / n);
    graph.positions[2 * i] = d * Math.cos(i * golden);
    graph.positions[2 * i + 1] = d * Math.sin(i * golden);
  }
  // Glyphs 1.5 spacings in radius: neighbours overlap at the fit view, so the footprint threshold, not the
  // overlap rule, decides what opens (as on a dense layout), at any n.
  const spacing = R * Math.sqrt(Math.PI / n);
  const tree = buildMortonLODTree(graph.positions, n);
  computeLODGeometry(tree, graph, new Float32Array(n).fill(1.5 * spacing), graph.strength);
  computeLODCrowding(tree, { screenSized: false, expandPx: crowdingHorizon(tree) });
  const k = (0.85 * Math.min(W, H)) / (2 * R);
  return { graph, tree, fit: { k, x: W / 2, y: H / 2 }, spacingPx: spacing * k };
}

/** The mixed view's pans, without leaf links (`main`'s gather) and with them (the engine's), and their signatures —
 *  with straight lines, or with directed half-arrows (the reciprocal pairing, the Navigator's default). */
function mixedLegs(n: number, frames: number, directed = false): LegResult[] {
  const f = seedDisc(n, directed);
  const inc = buildLeafIncidence(f.graph, directed);
  const plainStyle: SuperEdgeStyleResolved = directed ? { ...STYLE, linkStyle: "half-arrow", directed: true } : STYLE;
  const leafStyle: SuperEdgeStyleResolved = { ...plainStyle, leafLinks: true };
  const tag = directed ? "-half" : "";
  const sourceEdges = incidenceSourceEdges(f.graph.csr, f.graph);
  const opts = { screenSized: false, maxAggregateRadius: MAX_AGG };
  // The threshold that keeps about half the glyphs as leaves, linked to each other.
  const probe = { cut: makeCutScratch(), dc: makeDeclutterFrontierScratch(), lazy: makeLazySuperEdgesScratch() };
  const run = (t: LODTransform, expandPx: number, s: typeof probe, leaf: boolean) => {
    const drawn = cut(f.tree, t, W, H, { ...opts, expandPx, recordCulled: true }, s.cut);
    const kept = declutterFrontier(f.tree, drawn, t, W, H, { ...opts, k: t.k }, s.dc);
    const covers = { drawn, kept, culled: s.cut.culled.subarray(0, s.cut.culledCount), split: s.cut.split.subarray(0, s.cut.splitCount) };
    const out = lazySuperEdges(f.tree, covers, leaf ? leafStyle : plainStyle, visibleWorldRect(t, W, H), f.graph.csr, inc, s.lazy, leaf ? sourceEdges : undefined);
    let leaves = 0;
    for (const g of kept) if (g < f.tree.leafCount) leaves++;
    return { kept: kept.length, leaves, ids: out.ids };
  };
  let expandPx = 0;
  let share = 0;
  for (const m of [4, 3.6, 3.3, 3, 2.8, 2.6, 2.4, 2.2, 2, 1.8, 1.6]) {
    const e = m * f.spacingPx; // footprints of a few spacings: the bottom cells' sizes straddle it
    const r = run(f.fit, e, probe, true);
    share = r.leaves / Math.max(1, r.kept);
    if (share >= 0.3 && share <= 0.7 && probe.lazy.leafLinks > 0.2 * r.leaves) {
      expandPx = e;
      break;
    }
  }
  expect(expandPx, `a mixed view: about half the kept glyphs leaves, linked to each other (last share ${share.toFixed(2)})`).toBeGreaterThan(0);
  const pan = (i: number): LODTransform => ({ ...f.fit, x: f.fit.x + (i % 2 ? 1 : -1) });
  const results: LegResult[] = [];
  const timed = (name: string, leaf: boolean): { leafRows: number; kept: number; leafLinks: number } => {
    const s = { cut: makeCutScratch(), dc: makeDeclutterFrontierScratch(), lazy: makeLazySuperEdgesScratch() };
    run(pan(0), expandPx, s, leaf); // warm: the memo holds the view's rows
    const ts: number[] = [];
    let leafRows = 0;
    let kept = 0;
    let leafLinks = 0;
    for (let i = 1; i <= frames; i++) {
      const t0 = performance.now();
      const r = run(pan(i), expandPx, s, leaf);
      ts.push(performance.now() - t0);
      leafRows += s.lazy.leafRows;
      kept = Math.max(kept, r.kept);
      leafLinks = Math.max(leafLinks, s.lazy.leafLinks);
    }
    const st = stats(ts);
    results.push({ name, median: st.median, worst: st.worst, drawn: 0, kept, edges: leafLinks, visits: s.lazy.visits, entries: s.lazy.entries });
    if (leaf) {
      // An unchanged view: no kept leaf's row rebuilt, the same super-edges and leaf links.
      const a = run(pan(0), expandPx, s, true);
      const listed = Array.from(s.lazy.leafEdges.subarray(0, s.lazy.leafLinks));
      const b = run(pan(0), expandPx, s, true);
      expect(s.lazy.leafRows, "held view, leaf links: kept-leaf rows rebuilt").toBe(0);
      expect(s.lazy.misses, "held view, leaf links: rows rebuilt from leaves").toBe(0);
      expect(s.lazy.visits, "held view, leaf links: incidences walked").toBe(0);
      expect(b.ids).toEqual(a.ids);
      expect(Array.from(s.lazy.leafEdges.subarray(0, s.lazy.leafLinks))).toEqual(listed);
    }
    return { leafRows, kept, leafLinks };
  };
  timed(`mixed-pan${tag}`, false);
  const leaf = timed(`mixed-pan-leaf${tag}`, true);
  expect(leaf.leafLinks, "the mixed view lists leaf links (not vacuous)").toBeGreaterThan(0);
  // A pan of a pixel changes the cut at the view's edge at most: the kept leaves' rows come from the memo (#463).
  expect(leaf.leafRows, `kept-leaf rows rebuilt over ${frames} pans of ${leaf.kept} kept glyphs`).toBeLessThanOrEqual(Math.ceil(0.01 * frames * leaf.kept));
  const [plain, withLeaf] = results;
  if (plain && withLeaf) console.log(`mixed pan${tag} at N=${n}: leaf links ${withLeaf.median.toFixed(2)} ms vs without ${plain.median.toFixed(2)} ms (${(withLeaf.median / Math.max(plain.median, 1e-3)).toFixed(2)}×), expandPx ${expandPx.toFixed(2)}, leaf share ${share.toFixed(2)}, kept ${leaf.kept}, leaf links ${leaf.leafLinks}`);
  return results;
}

function report(results: LegResult[], n: number, label: string): void {
  for (const r of results) {
    const line = `${r.name.padEnd(15)} N=${n.toLocaleString()} drawn=${r.drawn.toLocaleString()} kept=${r.kept.toLocaleString()} ${r.name === "rows-build" ? "bytes" : "edges"}=${r.edges.toLocaleString()} visits=${r.visits.toLocaleString()} entries=${r.entries.toLocaleString()} median=${r.median.toFixed(2)}ms worst=${r.worst.toFixed(2)}ms\n`;
    console.log(line.trimEnd());
    if (BENCH) appendFileSync("/tmp/spatial-lod-perf.txt", `[${label}] ${line}`);
  }
}

// Calibrated on an M-series laptop at 100k (medians): streamed ≈ 5 ms, zoom ≈ 4 ms, all-leaves ≈ 16 ms,
// reductions-off ≈ 36 ms (every one of the ~290k edges drawn), drag ≈ 1.5 ms. Ceilings are ~10× those;
// the at-scale leg splits each into a constant and a per-100k-leaves term.
// streamed-rows (#433) ≈ 2.5 ms and streamed-gesture ≈ 3.5 ms: the ceiling of the streamed leg they replace.
// rows-build ≈ 2 ms is the worker's step, off the main thread; its ceiling keeps it O(edges under the kept cells).
// mixed-pan ≈ 22 ms and mixed-pan-leaf ≈ 23 ms (11.6k glyphs, host load ~80): under PERF_ASSERT the leaf-links pan
// must also stay within 1.5× + 5 ms of the same pan without them (#463: it was ~2× before kept-leaf rows were memoised).
const LOCAL_BUDGET: Record<string, number> = { streamed: 50, zoom: 40, "all-leaves": 160, "reductions-off": 400, drag: 15, "streamed-rows": 50, "streamed-gesture": 50, "rows-build": 200, "mixed-pan": 200, "mixed-pan-leaf": 200, "mixed-pan-half": 300, "mixed-pan-leaf-half": 300 };
const CONSTANT_MS: Record<string, number> = { streamed: 10, zoom: 10, "all-leaves": 20, "reductions-off": 40, drag: 5, "streamed-rows": 10, "streamed-gesture": 10, "rows-build": 20, "mixed-pan": 20, "mixed-pan-leaf": 20, "mixed-pan-half": 20, "mixed-pan-leaf-half": 20 };

describe("#343 spatial LOD frame: cut + declutter + lazy super-edges", () => {
  it(`stays within budget at ${LOCAL_N.toLocaleString()} leaves, with the deterministic signatures`, () => {
    const f = webLike(LOCAL_N);
    const results = [...runLegs(f, 12), ...mixedLegs(LOCAL_N, 12), ...mixedLegs(LOCAL_N, 12, true)];
    report(results, LOCAL_N, "local");
    for (const r of results) expect(r.median, `${r.name} median`).toBeLessThan(LOCAL_BUDGET[r.name]!);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: the same legs at ${BENCH_N.toLocaleString()} leaves`, () => {
    const f = webLike(BENCH_N);
    const results = [...runLegs(f, 8), ...mixedLegs(BENCH_N, 8), ...mixedLegs(BENCH_N, 8, true)];
    report(results, BENCH_N, process.env.BENCH_SPATIAL_LOD_LABEL ?? "run");
    if (ASSERT) {
      for (const r of results) {
        const local = LOCAL_BUDGET[r.name]!;
        const c0 = CONSTANT_MS[r.name]!;
        const env = Number(process.env[`PERF_SPATIAL_LOD_${r.name.replace("-", "_").toUpperCase()}_MS`]);
        const ceiling = env > 0 ? env : c0 + ((local - c0) * BENCH_N) / LOCAL_N;
        expect(r.median, `${r.name}: median ${r.median.toFixed(1)}ms exceeds ${ceiling.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ceiling);
      }
      for (const tag of ["", "-half"]) {
        const plain = results.find((r) => r.name === `mixed-pan${tag}`);
        const leaf = results.find((r) => r.name === `mixed-pan-leaf${tag}`);
        if (plain && leaf) expect(leaf.median, `mixed pan${tag} with leaf links vs without (#463) at N=${BENCH_N}`).toBeLessThan(1.5 * plain.median + 5);
      }
    }
  }, 600_000);
});
