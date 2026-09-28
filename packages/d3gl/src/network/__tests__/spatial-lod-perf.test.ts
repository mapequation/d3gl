import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import {
  buildMortonLODTree,
  computeLODGeometry,
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
import { buildLeafIncidence, lazySuperEdges, makeLazySuperEdgesScratch, rowSuperEdges, type LazySuperEdgesScratch } from "../lazy-super-edges.js";
import { buildCoverRows, cutRowCells, makeSpatialRowsScratch, spatialRowsByteLength, spatialRowsGraph, spatialRowsViews, type SpatialRows, type SpatialRowsGraph, type SpatialRowsScratch } from "../spatial-rows.js";
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
 *     super-edge rows its worker built for that frame's view — gathered by `rowSuperEdges`: zero rows computed
 *     and zero incidences walked on every frame, the same super-edges as the lazy gather (pinned at the fit
 *     frame), and fewer row entries read than the lazy streamed leg walks incidences. The worker's rows build
 *     is timed apart and reported as **rows-build** (not a main-thread cost).
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

/** One engine frame on a spatial tree: cut (culled roots recorded) → declutter → super-edges — lazy, or from
 *  the worker's rows when `rows` is given (a streamed tree, #433). */
function frame(
  f: ReturnType<typeof webLike>,
  t: LODTransform,
  s: { cut: ReturnType<typeof makeCutScratch>; dc: ReturnType<typeof makeDeclutterFrontierScratch>; lazy: LazySuperEdgesScratch },
  inc: ReturnType<typeof buildLeafIncidence>,
  opts: { expandPx?: number; declutter: boolean; rows?: SpatialRows },
): { drawn: number; kept: number; edges: number; ids: number[]; flows: number[] } {
  const drawn = cut(f.tree, t, W, H, { expandPx: opts.expandPx, screenSized: true, maxAggregateRadius: MAX_AGG, recordCulled: true }, s.cut);
  const kept = opts.declutter ? declutterFrontier(f.tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG }, s.dc) : drawn;
  const covers = { drawn, kept, culled: s.cut.culled.subarray(0, s.cut.culledCount), split: s.cut.split.subarray(0, s.cut.splitCount) };
  const view = visibleWorldRect(t, W, H);
  const out = opts.rows
    ? rowSuperEdges({ ...f.tree, rows: opts.rows }, covers, STYLE, view, f.graph.csr, inc, s.lazy)
    : lazySuperEdges(f.tree, covers, STYLE, view, f.graph.csr, inc, s.lazy);
  return { drawn: drawn.length, kept: kept.length, edges: out.ids.length, ids: out.ids, flows: out.flows ?? [] };
}

/** The super-edge rows a streaming layout's worker builds for the covers of `t`'s cut (#433), timed. */
function workerRows(f: ReturnType<typeof webLike>, t: LODTransform, graph: SpatialRowsGraph, scratch: SpatialRowsScratch, cutSc: ReturnType<typeof makeCutScratch>): { rows: SpatialRows; ms: number; bytes: number } {
  const { parent, leafOrder, leafStart, leafEnd } = f.tree;
  if (!parent || !leafOrder || !leafStart || !leafEnd) throw new Error("a spatial tree carries its parent map and leaf runs");
  const t0 = performance.now();
  const drawn = cut(f.tree, t, W, H, { screenSized: true, maxAggregateRadius: MAX_AGG, recordCulled: true }, cutSc);
  const cells = { cells: new Uint32Array(0) };
  const m = cutRowCells(parent, { drawn, culled: cutSc.culled.subarray(0, cutSc.culledCount), split: cutSc.split.subarray(0, cutSc.splitCount) }, drawn, cells);
  let rows: SpatialRows | null = null;
  let bytes = 0;
  buildCoverRows({ size: f.tree.size, leafCount: f.tree.leafCount, parent, leafOrder, leafStart, leafEnd }, cells.cells.subarray(0, m), graph, scratch, (sizes) => {
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
  const fit = at(f.centroid, f.baseK);
  const fitRows = workerRows(f, fit, rowsGraph, rowsScratch, workerCut);
  const lazyFit = frame(f, fit, s, inc, { declutter: true });
  s.lazy.memoTree = null;
  const rowsFit = frame(f, fit, s, inc, { declutter: true, rows: fitRows.rows });
  const byId = (ids: number[], flows: number[]): Map<number, number> => new Map(ids.map((id, i) => [id, flows[i] ?? NaN]));
  expect(byId(rowsFit.ids, rowsFit.flows), "the rows gather draws the lazy gather's super-edges").toEqual(byId(lazyFit.ids, lazyFit.flows));
  const buildMs: number[] = [];
  let buildBytes = 0;
  let buildEntries = 0;
  let frameRows: SpatialRows = fitRows.rows;
  leg("streamed-rows", () => {
    const r = frame(f, at(f.centroid, sweepK(sweepAt)), s, inc, { declutter: true, rows: frameRows });
    expect(s.lazy.misses, "a streamed repaint with the worker's rows computes no row").toBe(0);
    expect(s.lazy.visits, "a streamed repaint with the worker's rows walks no incidence").toBe(0);
    return r;
  }, (i) => {
    sweepAt = i;
    const b = workerRows(f, at(f.centroid, sweepK(i)), rowsGraph, rowsScratch, workerCut);
    frameRows = b.rows;
    buildMs.push(b.ms);
    buildBytes = Math.max(buildBytes, b.bytes);
    buildEntries = Math.max(buildEntries, b.rows.outNode.length + b.rows.inNode.length);
  });
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
// streamed-rows (#433) ≈ 4 ms: the ceiling of the streamed leg it replaces. rows-build ≈ 12-20 ms is the
// worker's step, off the main thread; ~10× its median keeps it O(edges under the covers).
const LOCAL_BUDGET: Record<string, number> = { streamed: 50, zoom: 40, "all-leaves": 160, "reductions-off": 400, drag: 15, "streamed-rows": 50, "rows-build": 200 };
const CONSTANT_MS: Record<string, number> = { streamed: 10, zoom: 10, "all-leaves": 20, "reductions-off": 40, drag: 5, "streamed-rows": 10, "rows-build": 20 };

describe("#343 spatial LOD frame: cut + declutter + lazy super-edges", () => {
  it(`stays within budget at ${LOCAL_N.toLocaleString()} leaves, with the deterministic signatures`, () => {
    const f = webLike(LOCAL_N);
    const results = runLegs(f, 12);
    report(results, LOCAL_N, "local");
    for (const r of results) expect(r.median, `${r.name} median`).toBeLessThan(LOCAL_BUDGET[r.name]!);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: the same legs at ${BENCH_N.toLocaleString()} leaves`, () => {
    const f = webLike(BENCH_N);
    const results = runLegs(f, 8);
    report(results, BENCH_N, process.env.BENCH_SPATIAL_LOD_LABEL ?? "run");
    if (ASSERT) {
      for (const r of results) {
        const local = LOCAL_BUDGET[r.name]!;
        const c0 = CONSTANT_MS[r.name]!;
        const env = Number(process.env[`PERF_SPATIAL_LOD_${r.name.replace("-", "_").toUpperCase()}_MS`]);
        const ceiling = env > 0 ? env : c0 + ((local - c0) * BENCH_N) / LOCAL_N;
        expect(r.median, `${r.name}: median ${r.median.toFixed(1)}ms exceeds ${ceiling.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ceiling);
      }
    }
  }, 600_000);
});
