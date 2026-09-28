/**
 * **Super-edge rows** of a spatial LOD tree's kept glyphs (#433) — built off the main thread with each
 * streamed tree, for the view the main thread last reported, and moved to it with the tree.
 *
 * The lazy gather (`lazySuperEdges`) finds a kept glyph's links by walking the graph edges of every leaf
 * under it into a **row**: per cover its leaves link to, the flow out of and into the glyph. On a streamed
 * layout the tree changes every frame, its row memo never hits, and a repaint walks every edge under the
 * kept glyphs: O(edges) on the main thread, up to 2E incidences at a fit view. The thread that rebuilt the
 * tree builds those rows instead, for the cut the main thread will draw — it runs the engine's cut and
 * declutter at the engine's view — and hands them over, so the repaint reads the rows of the kept glyphs.
 *
 * **What a row holds.** A kept cell `g`'s **out-row** sums, per cover `h` of the cut, the weight of each
 * graph edge `u → v` with `u` under `g` and `v` under `h`; its **in-row** does the same for edges into `g`.
 * `h` is the finest cover of `v` — a drawn glyph the cut does not split, or a culled root — and never `g`
 * itself nor, in a cross-fade band, a cover nested in or around `g`: exactly the partners of the lazy
 * gather's row of `g`. A row thus has one entry per cover `g` links to, in each direction, so the rows of a
 * frame are bounded by what its kept glyphs can link to — (kept cells) × (covers) — whatever the number of
 * edges under them. Kept leaves have no stored row: a leaf's row is its own graph edges, which the main
 * thread reads as the lazy gather does (O(its degree), the size of what it draws).
 *
 * **Why the main thread can use a row at another cut.** The main thread takes the row of a kept glyph it
 * draws when every partner in it lies at or below a cover of its own cut: each partner then resolves to that
 * cover (a memoised climb) and the row, merged per cover, is the lazy row of the glyph at the main thread's
 * cut — exact. When the view moved since the worker cut (a gesture, the settle's reframe), a glyph the rows do
 * not list, or one whose row names a partner the main thread's cut opened up, gets its row from its leaves, as
 * the lazy gather's.
 *
 * **Cost.** O(leaves) to label every leaf with its cover, then O(Σ graph edges under the kept cells) (plus the
 * split glyphs' members again, in a band) to sum the rows, O(Σ rows) out. The rows buffer is 12 B per entry
 * and 12 B per kept cell.
 */
import { buildCSR, type CSR } from "./graph.js";

/** What a packed rows buffer holds: enough for {@link spatialRowsViews} to read it. */
export interface SpatialRowsSizes {
  /** Cells with a row. */
  cells: number;
  /** Entries of all out-rows, and of all in-rows. */
  outEntries: number;
  inEntries: number;
}

/**
 * Super-edge rows of a spatial tree's kept cells (#433) — see the module comment. `cell` lists the cells
 * with a row, ascending ({@link rowOf} finds one); the `i`-th one's out-row is
 * `outNode[outOffset[i] .. outOffset[i + 1])` with the summed flow in `outFlow`, its in-row the same in the
 * `in*` arrays. Every entry names a cover of the cut the rows were built at.
 */
export interface SpatialRows {
  cell: Uint32Array;
  outOffset: Uint32Array;
  outNode: Uint32Array;
  outFlow: Float64Array;
  inOffset: Uint32Array;
  inNode: Uint32Array;
  inFlow: Float64Array;
}

/** A packed rows buffer and its sizes, moved between threads with the tree it belongs to. */
export interface SpatialRowsFrame {
  sizes: SpatialRowsSizes;
  buffer: ArrayBuffer;
}

/** Bytes a packed rows buffer of these sizes needs: the 8-byte flows first, then the cells, offsets and
 *  nodes. 12 B per entry and 12 B per cell. */
export function spatialRowsByteLength({ cells, outEntries, inEntries }: SpatialRowsSizes): number {
  return 8 * (outEntries + inEntries) + 4 * (cells + 2 * (cells + 1) + outEntries + inEntries);
}

/** The arrays of a packed rows buffer, viewed in `buffer` — the one layout writer and reader share. O(1). */
export function spatialRowsViews(buffer: ArrayBufferLike, { cells, outEntries, inEntries }: SpatialRowsSizes): SpatialRows {
  let at = 0;
  const f64 = (n: number): Float64Array => { const v = new Float64Array(buffer, at, n); at += 8 * n; return v; };
  const u32 = (n: number): Uint32Array => { const v = new Uint32Array(buffer, at, n); at += 4 * n; return v; };
  const outFlow = f64(outEntries);
  const inFlow = f64(inEntries);
  const cell = u32(cells);
  const outOffset = u32(cells + 1);
  const outNode = u32(outEntries);
  const inOffset = u32(cells + 1);
  const inNode = u32(inEntries);
  return { cell, outOffset, outNode, outFlow, inOffset, inNode, inFlow };
}

/** The row index of cell `x` in `rows` (a binary search of `rows.cell`), or −1 when it has none. */
export function rowOf(rows: SpatialRows, x: number): number {
  const cell = rows.cell;
  let lo = 0;
  let hi = cell.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cell[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < cell.length && cell[lo] === x ? lo : -1;
}

/** The tree a build reads: the leaf runs of a spatial tree's topology. */
export interface SpatialRowsTree {
  size: number;
  leafCount: number;
  leafOrder: Uint32Array;
  leafStart: Uint32Array;
  leafEnd: Uint32Array;
}

/** Per CSR entry of a graph's undirected CSR: its edge's weight (or one weight for all) and direction. */
export interface IncidenceArrays {
  /** Each CSR entry's edge weight, or `null` when every edge weighs {@link uniform} (no array kept). */
  weight: Float32Array | null;
  /** The one weight of every edge when {@link weight} is `null`. */
  uniform: number;
  /** Each CSR entry's direction — 1 when its row's node is the edge's source, 0 when its target — or `null`
   *  when built undirected. */
  out: Uint8Array | null;
}

/** An edge list and the node count its `buildCSR` CSR was built over. */
export interface IncidenceEdges {
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  weight: ArrayLike<number>;
  edgeCount: number;
  nodeCount: number;
}

/**
 * Per CSR entry of `csr` — the `buildCSR` CSR of `edges`, whose entries each edge adds as its source's,
 * then its target's — the edge's weight (`null` when every edge weighs the same, then `uniform`) and, when
 * `directed`, its direction. 4 B per entry for the weights (unless uniform), 1 B for the direction. O(edges).
 */
export function incidenceArrays(csr: CSR, edges: IncidenceEdges, directed: boolean): IncidenceArrays {
  const { edgeCount, weight: w } = edges;
  let uniformWeight = edgeCount > 0 ? (w[0] ?? 0) : 1;
  for (let e = 1; e < edgeCount; e++) {
    if (w[e] !== uniformWeight) { uniformWeight = NaN; break; }
  }
  const keepWeights = Number.isNaN(uniformWeight);
  return {
    weight: keepWeights ? incidenceWeights(csr, edges) : null,
    uniform: keepWeights ? 0 : uniformWeight,
    out: directed ? incidenceDirections(csr, edges) : null,
  };
}

/** Each CSR entry's edge weight (see {@link incidenceArrays}). */
function incidenceWeights(csr: CSR, { source, target, weight: w, edgeCount, nodeCount }: IncidenceEdges): Float32Array {
  const weight = new Float32Array(csr.neighbors.length);
  const cursor = csr.offsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const s = source[e] ?? 0;
    const t = target[e] ?? 0;
    weight[cursor[s] ?? 0] = w[e] ?? 0;
    cursor[s] = (cursor[s] ?? 0) + 1;
    weight[cursor[t] ?? 0] = w[e] ?? 0;
    cursor[t] = (cursor[t] ?? 0) + 1;
  }
  return weight;
}

/** Each CSR entry's direction: 1 for the source's entry of its edge, 0 for the target's. */
function incidenceDirections(csr: CSR, { source, target, edgeCount, nodeCount }: IncidenceEdges): Uint8Array {
  const out = new Uint8Array(csr.neighbors.length);
  const cursor = csr.offsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const s = source[e] ?? 0;
    const t = target[e] ?? 0;
    out[cursor[s] ?? 0] = 1; // the target's entry stays 0: an in-edge of t
    cursor[s] = (cursor[s] ?? 0) + 1;
    cursor[t] = (cursor[t] ?? 0) + 1;
  }
  return out;
}

/**
 * The graph a spatial stream builds rows from (#433): the CSR of `edges` over `nodeCount` nodes with each
 * entry's weight and direction. O(edges), once per stream.
 */
export function spatialRowsGraph(nodeCount: number, edges: { source: Uint32Array; target: Uint32Array; weight: Float32Array }): SpatialRowsGraph {
  const csr = buildCSR(nodeCount, edges.source, edges.target);
  const all: IncidenceEdges = { ...edges, edgeCount: edges.source.length, nodeCount };
  const { weight, uniform } = incidenceArrays(csr, all, false);
  return { csr, weight, uniform, out: incidenceDirections(csr, all) };
}

/** The graph a build reads: its undirected CSR and, per CSR entry, the edge's weight and direction. */
export interface SpatialRowsGraph {
  csr: CSR;
  /** Each CSR entry's edge weight, or `null` when every edge weighs {@link uniform}. */
  weight: Float32Array | null;
  uniform: number;
  /** Each CSR entry's direction: 1 when its row's node is the edge's source, 0 when its target. */
  out: Uint8Array;
}

/**
 * Reusable working storage for {@link buildKeptRows}: each leaf's cover (4 B per leaf), each cover's node
 * and the per-row merge marks over the covers (20 B per cover), the kept cells, and the growable row
 * arenas. Grown to the largest build and kept, so a stream that rebuilds every frame allocates nothing
 * here once warm.
 */
export interface SpatialRowsScratch {
  /** Leaf `v`'s cover, as an index into {@link coverNode}. */
  label: Int32Array;
  coverNode: Int32Array;
  markOut: Int32Array;
  slotOut: Int32Array;
  markIn: Int32Array;
  slotIn: Int32Array;
  seq: number;
  /** The kept cells, ascending. */
  cells: Uint32Array;
  outOffset: Uint32Array;
  inOffset: Uint32Array;
  outNode: Uint32Array;
  outFlow: Float64Array;
  inNode: Uint32Array;
  inFlow: Float64Array;
}

/** A fresh, empty {@link SpatialRowsScratch}. */
export function makeSpatialRowsScratch(): SpatialRowsScratch {
  return {
    label: new Int32Array(0),
    coverNode: new Int32Array(64),
    markOut: new Int32Array(64),
    slotOut: new Int32Array(64),
    markIn: new Int32Array(64),
    slotIn: new Int32Array(64),
    seq: 0,
    cells: new Uint32Array(64),
    outOffset: new Uint32Array(65),
    inOffset: new Uint32Array(65),
    outNode: new Uint32Array(1024),
    outFlow: new Float64Array(1024),
    inNode: new Uint32Array(1024),
    inFlow: new Float64Array(1024),
  };
}

/** Grow the per-cover arrays to hold `need` covers (their contents are rewritten by every build). */
function growCovers(sc: SpatialRowsScratch, need: number): void {
  if (need <= sc.coverNode.length) return;
  const cap = Math.max(need, sc.coverNode.length * 2);
  sc.coverNode = new Int32Array(cap);
  sc.markOut = new Int32Array(cap);
  sc.slotOut = new Int32Array(cap);
  sc.markIn = new Int32Array(cap);
  sc.slotIn = new Int32Array(cap);
  sc.seq = 0;
}

/** Grow the per-cell arrays to hold `need` cells (their contents are rewritten by every build). */
function growCells(sc: SpatialRowsScratch, need: number): void {
  if (need <= sc.cells.length) return;
  const cap = Math.max(need, sc.cells.length * 2);
  sc.cells = new Uint32Array(cap);
  sc.outOffset = new Uint32Array(cap + 1);
  sc.inOffset = new Uint32Array(cap + 1);
}

/** Grow the out-row arena to hold `need` entries, keeping what it holds. */
function growOut(sc: SpatialRowsScratch, need: number): void {
  if (need <= sc.outNode.length) return;
  const cap = Math.max(need, sc.outNode.length * 2);
  const n = new Uint32Array(cap); n.set(sc.outNode); sc.outNode = n;
  const f = new Float64Array(cap); f.set(sc.outFlow); sc.outFlow = f;
}

/** Grow the in-row arena to hold `need` entries, keeping what it holds. */
function growIn(sc: SpatialRowsScratch, need: number): void {
  if (need <= sc.inNode.length) return;
  const cap = Math.max(need, sc.inNode.length * 2);
  const n = new Uint32Array(cap); n.set(sc.inNode); sc.inNode = n;
  const f = new Float64Array(cap); f.set(sc.inFlow); sc.inFlow = f;
}

/** Rows built ({@link buildKeptRows}) in this realm since module load — test instrumentation, like
 *  `mortonTopologyBuilds`: a main-thread guard asserts none is built there. Never read on a render path. */
export let spatialRowBuilds = 0;

/** A cut, as {@link buildKeptRows} reads it: the frontier, the glyphs declutter kept, the culled roots and the
 *  glyphs a cross-fade band drew and expanded. */
export interface SpatialRowsCut {
  drawn: ArrayLike<number>;
  kept: ArrayLike<number>;
  culled: ArrayLike<number>;
  split: ArrayLike<number>;
}

/**
 * Build the super-edge rows of the kept cells of `cut` (#433) over `graph` — see the module comment for what
 * a row holds. The rows are built in `scratch`, then copied into the arrays `allocate` returns for their final
 * sizes — a caller that transfers them passes views of a pooled buffer ({@link spatialRowsViews}).
 * O(leaves + Σ graph edges under the kept cells + Σ rows); allocates nothing once `scratch` is warm but what
 * `allocate` hands out. Returns the sizes the rows were allocated with.
 */
export function buildKeptRows(
  tree: SpatialRowsTree,
  cut: SpatialRowsCut,
  graph: SpatialRowsGraph,
  scratch: SpatialRowsScratch,
  allocate: (sizes: SpatialRowsSizes) => SpatialRows,
): SpatialRowsSizes {
  spatialRowBuilds++;
  const { leafCount: n, leafOrder, leafStart, leafEnd } = tree;
  const sc = scratch;
  const { drawn, kept, culled, split } = cut;
  const fading = split.length > 0;
  if (sc.label.length < n) sc.label = new Int32Array(n);
  growCovers(sc, drawn.length + culled.length);
  // Every leaf's finest cover: the drawn glyphs' runs in frontier order — a split glyph before the glyphs
  // below it, so the finest is written last — then the culled roots', which in a band may lie under a split
  // glyph and are finer than it (anywhere else no drawn glyph holds them).
  const { label, coverNode } = sc;
  let covers = 0;
  const labelRun = (x: number): void => {
    const k = covers++;
    coverNode[k] = x;
    const r1 = leafEnd[x] ?? 0;
    for (let r = leafStart[x] ?? 0; r < r1; r++) label[leafOrder[r] ?? 0] = k;
  };
  for (let i = 0; i < drawn.length; i++) labelRun(drawn[i] ?? 0);
  for (let i = 0; i < culled.length; i++) labelRun(culled[i] ?? 0);
  // The kept cells, ascending (rowOf's order); a leaf's row is its graph edges.
  growCells(sc, kept.length);
  let cells = 0;
  for (let i = 0; i < kept.length; i++) {
    const g = kept[i] ?? 0;
    if (g >= n) sc.cells[cells++] = g;
  }
  const cellIds = sc.cells.subarray(0, cells);
  cellIds.sort();
  const { markOut, slotOut, markIn, slotIn } = sc;
  const { offsets, neighbors } = graph.csr;
  const incW = graph.weight;
  const incOut = graph.out;
  const uniform = graph.uniform;
  let outLen = 0;
  let inLen = 0;
  for (let i = 0; i < cells; i++) {
    const g = cellIds[i] ?? 0;
    if (sc.seq >= 0x7fffffff) { markOut.fill(0); markIn.fill(0); sc.seq = 0; }
    const seq = ++sc.seq;
    sc.outOffset[i] = outLen;
    sc.inOffset[i] = inLen;
    const g0 = leafStart[g] ?? 0;
    const g1 = leafEnd[g] ?? 0;
    for (let r = g0; r < g1; r++) {
      const u = leafOrder[r] ?? 0;
      const p1 = offsets[u + 1] ?? 0;
      for (let p = offsets[u] ?? 0; p < p1; p++) {
        const k = label[neighbors[p] ?? 0] ?? 0;
        const h = coverNode[k] ?? 0;
        // Not a pair with itself — nor, in a band, with a cover nested in or around it (the lazy gather's rule).
        if (h === g || (fading && (leafStart[h] ?? 0) < g1 && g0 < (leafEnd[h] ?? 0))) continue;
        const w = incW ? (incW[p] ?? 0) : uniform;
        if (incOut[p] === 1) {
          if (markOut[k] === seq) {
            const e = slotOut[k] ?? 0;
            sc.outFlow[e] = (sc.outFlow[e] ?? 0) + w;
          } else {
            if (outLen === sc.outNode.length) growOut(sc, outLen + 1);
            markOut[k] = seq;
            slotOut[k] = outLen;
            sc.outNode[outLen] = h;
            sc.outFlow[outLen++] = 0 + w; // a sum from +0, as the lazy gather's
          }
        } else if (markIn[k] === seq) {
          const e = slotIn[k] ?? 0;
          sc.inFlow[e] = (sc.inFlow[e] ?? 0) + w;
        } else {
          if (inLen === sc.inNode.length) growIn(sc, inLen + 1);
          markIn[k] = seq;
          slotIn[k] = inLen;
          sc.inNode[inLen] = h;
          sc.inFlow[inLen++] = 0 + w;
        }
      }
    }
  }
  sc.outOffset[cells] = outLen;
  sc.inOffset[cells] = inLen;
  const sizes: SpatialRowsSizes = { cells, outEntries: outLen, inEntries: inLen };
  const rows = allocate(sizes);
  rows.cell.set(cellIds);
  rows.outOffset.set(sc.outOffset.subarray(0, cells + 1));
  rows.inOffset.set(sc.inOffset.subarray(0, cells + 1));
  rows.outNode.set(sc.outNode.subarray(0, outLen));
  rows.outFlow.set(sc.outFlow.subarray(0, outLen));
  rows.inNode.set(sc.inNode.subarray(0, inLen));
  rows.inFlow.set(sc.inFlow.subarray(0, inLen));
  return sizes;
}

/** Allocate a rows set as separate typed arrays (tests, and a caller that does not transfer them). */
export function allocateSpatialRows(sizes: SpatialRowsSizes): SpatialRows {
  return spatialRowsViews(new ArrayBuffer(spatialRowsByteLength(sizes)), sizes);
}
