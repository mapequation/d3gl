/**
 * **Super-edge rows** for the covers of a spatial LOD tree's cut (#433) — built off the main thread with each
 * streamed tree, for the view the main thread last reported, and moved to it with the tree.
 *
 * The lazy gather (`lazySuperEdges`) finds a kept glyph's links by walking the graph edges of every leaf
 * under it. On a streamed layout the tree changes every frame, its row memo never hits, and a repaint walks
 * every edge under the frontier: O(edges) on the main thread, 2E incidences at a coarse view. The thread
 * that rebuilt the tree does that walk instead, for the cut the main thread will draw, and hands over each
 * cover's summed row — so the repaint reads O(rows of the drawn and culled covers).
 *
 * **What a row holds.** A listed cell `x`'s **out-row** sums, per partner `t`, the weight of each graph edge
 * `u → v` with `u` under `x` and `v` outside it, where `t` is the node on `v`'s side at `x`'s depth — or `v`
 * itself when `v` is a leaf shallower than `x`. Its **in-row** does the same for edges into `x`. So every
 * entry names a node no deeper than the row's cell. (A leaf's row would be its graph edges resolved the same
 * way; the main thread has the graph, so leaves need no stored row.)
 *
 * **Why that is exact for any cut.** Whatever the cut, its finest covers (the drawn glyphs not also
 * expanded, plus the culled subtree roots) partition the leaves. For two covers `g` and `h` with `h` no
 * shallower than `g`, each edge between them appears in `h`'s rows as an entry whose node lies inside `g`
 * (at `h`'s depth, or a shallower leaf), and climbing from that node reaches `g` as its first cover; from
 * `g`'s rows the matching node is an ancestor of `h`, above every cover, and resolves to nothing. Walking
 * each cover's rows and keeping the partners strictly shallower than the cover — or at its depth with a
 * larger id — thus finds every pair of covers once, from one side, with the flow of both directions.
 * `rowSuperEdges` (in `lazy-super-edges.ts`) does that and draws with the lazy gather's rules. The rows only
 * decide how fast: a cover the main thread's cut draws but the rows do not list (the view moved since, or a
 * tree the main thread refit) is walked through its leaves under the same rule, as the lazy gather would.
 *
 * **Cost.** Built by walking the graph edges under each listed cell once, deepest cell first, each neighbour
 * lifted on to the cell's depth from where the last lift left it: O(Σ edges under the listed cells) — at most
 * 2E for the covers of one cut, which partition the leaves — plus O(depth) climbing per leaf, and O(Σ rows)
 * out, bounded by what the covers can draw.
 */
import { buildCSR, type CSR } from "./graph.js";

/** What a packed rows buffer holds: enough for {@link spatialRowsViews} to read it. */
export interface SpatialRowsSizes {
  /** Tree nodes (leaves + cells). */
  size: number;
  leafCount: number;
  /** Cells with a row. */
  cells: number;
  /** Entries of all out-rows, and of all in-rows. */
  outEntries: number;
  inEntries: number;
}

/**
 * Super-edge rows of a spatial tree's listed cells (#433) — see the module comment. `cell` lists the cells
 * with a row, ascending ({@link rowOf} finds one); the `i`-th one's out-row is
 * `outNode[outOffset[i] .. outOffset[i + 1])` with the summed flow in `outFlow`, its in-row the same in the
 * `in*` arrays. `depth` is every tree node's depth below its root: the partner rule compares depths.
 */
export interface SpatialRows {
  depth: Uint8Array;
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
 *  nodes, then the depths. 12 B per entry, 12 B per listed cell and 1 B per tree node. */
export function spatialRowsByteLength({ size, cells, outEntries, inEntries }: SpatialRowsSizes): number {
  return 8 * (outEntries + inEntries) + 4 * (cells + 2 * (cells + 1) + outEntries + inEntries) + size;
}

/** The arrays of a packed rows buffer, viewed in `buffer` — the one layout writer and reader share. O(1). */
export function spatialRowsViews(buffer: ArrayBufferLike, { size, cells, outEntries, inEntries }: SpatialRowsSizes): SpatialRows {
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
  const depth = new Uint8Array(buffer, at, size);
  return { depth, cell, outOffset, outNode, outFlow, inOffset, inNode, inFlow };
}

/** The row index of cell `x` in `rows` (a binary search of `rows.cell`), or −1 when it has none. */
export function rowOf(rows: SpatialRows, x: number): number {
  const cell = rows.cell;
  let lo = 0;
  let hi = cell.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cell[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < cell.length && cell[lo] === x ? lo : -1;
}

/** The tree a build reads: the parents and the leaf runs (of a spatial tree's topology). */
export interface SpatialRowsTree {
  size: number;
  leafCount: number;
  parent: Int32Array;
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
  let uniformWeight = edgeCount > 0 ? w[0]! : 1;
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
    const s = source[e]!;
    const t = target[e]!;
    weight[cursor[s]!] = w[e]!;
    cursor[s] = cursor[s]! + 1;
    weight[cursor[t]!] = w[e]!;
    cursor[t] = cursor[t]! + 1;
  }
  return weight;
}

/** Each CSR entry's direction: 1 for the source's entry of its edge, 0 for the target's. */
function incidenceDirections(csr: CSR, { source, target, edgeCount, nodeCount }: IncidenceEdges): Uint8Array {
  const out = new Uint8Array(csr.neighbors.length);
  const cursor = csr.offsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const s = source[e]!;
    const t = target[e]!;
    out[cursor[s]!] = 1; // the target's entry stays 0: an in-edge of t
    cursor[s] = cursor[s]! + 1;
    cursor[t] = cursor[t]! + 1;
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
 * Reusable working storage for {@link buildCoverRows}: the depths, the per-row merge marks and the lift memo
 * over tree nodes (21 B per node), the listed cells with their build order and row segments, and the
 * growable row arenas. Grown to the largest build and kept, so a stream that rebuilds every frame allocates
 * nothing here once warm.
 */
export interface SpatialRowsScratch {
  depth: Uint8Array;
  markOut: Int32Array;
  slotOut: Int32Array;
  markIn: Int32Array;
  slotIn: Int32Array;
  seq: number;
  /** Lift memo: `up[v]` is leaf `v`'s node at the depth it was last lifted to while `upGen[v] === liftGen`. */
  up: Int32Array;
  upGen: Int32Array;
  liftGen: number;
  /** The listed cells, deduplicated ascending; their build order (by depth); each one's row segments. */
  cells: Uint32Array;
  /** Counting-sort buckets by depth (257 words). */
  byDepth: Uint32Array;
  order: Uint32Array;
  outStart: Uint32Array;
  outLen: Uint32Array;
  inStart: Uint32Array;
  inLen: Uint32Array;
  outNode: Uint32Array;
  outFlow: Float64Array;
  inNode: Uint32Array;
  inFlow: Float64Array;
}

/** A fresh, empty {@link SpatialRowsScratch}. */
export function makeSpatialRowsScratch(): SpatialRowsScratch {
  return {
    depth: new Uint8Array(0),
    markOut: new Int32Array(0),
    slotOut: new Int32Array(0),
    markIn: new Int32Array(0),
    slotIn: new Int32Array(0),
    seq: 0,
    up: new Int32Array(0),
    upGen: new Int32Array(0),
    liftGen: 0,
    cells: new Uint32Array(64),
    byDepth: new Uint32Array(257),
    order: new Uint32Array(64),
    outStart: new Uint32Array(64),
    outLen: new Uint32Array(64),
    inStart: new Uint32Array(64),
    inLen: new Uint32Array(64),
    outNode: new Uint32Array(1024),
    outFlow: new Float64Array(1024),
    inNode: new Uint32Array(1024),
    inFlow: new Float64Array(1024),
  };
}

/** Grow the per-cell arrays to hold `need` cells (their contents are rewritten by every build). */
function growCells(sc: SpatialRowsScratch, need: number): void {
  if (need <= sc.cells.length) return;
  const cap = Math.max(need, sc.cells.length * 2);
  sc.cells = new Uint32Array(cap);
  sc.order = new Uint32Array(cap);
  sc.outStart = new Uint32Array(cap);
  sc.outLen = new Uint32Array(cap);
  sc.inStart = new Uint32Array(cap);
  sc.inLen = new Uint32Array(cap);
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

/** Rows built ({@link buildCoverRows}) in this realm since module load — test instrumentation, like
 *  `mortonTopologyBuilds`: a main-thread guard asserts none is built there. Never read on a render path. */
export let spatialRowBuilds = 0;

/**
 * The cells of a cut whose super-edge rows can matter (#433), into `out.cells` (grown; returns the count):
 * its drawn glyphs that the band does not split, and its culled roots — except, outside a band, a cover
 * shallower than every glyph `floor` lists: its row keeps only partners shallower than itself, whose covers
 * `floor` does not hold, so every pair it finds joins two covers of which neither is in `floor`. The worker
 * passes the drawn glyphs as `floor` (the main thread links only the kept ones, a subset); the main thread's
 * gather applies the same rule with its kept glyphs. O((drawn + culled) · depth).
 */
export function cutRowCells(
  parent: Int32Array,
  cutSet: { drawn: ArrayLike<number>; culled: ArrayLike<number>; split: ArrayLike<number> },
  floor: ArrayLike<number>,
  out: { cells: Uint32Array },
): number {
  const depthOf = (x: number): number => {
    let d = 0;
    for (let y = parent[x]!; y >= 0; y = parent[y]!) d++;
    return d;
  };
  const { drawn, culled, split } = cutSet;
  const fading = split.length > 0;
  let min = 0;
  if (!fading) {
    min = Infinity;
    for (let i = 0; i < floor.length; i++) min = Math.min(min, depthOf(floor[i]!));
  }
  const need = drawn.length + culled.length;
  if (out.cells.length < need) out.cells = new Uint32Array(Math.max(need, 2 * out.cells.length));
  const cells = out.cells;
  // In a band: the split glyphs, sorted, to leave them out by binary search (a band splits few).
  const splits = fading ? Uint32Array.from(split).sort() : null;
  const isSplit = (g: number): boolean => {
    if (!splits) return false;
    let lo = 0;
    let hi = splits.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (splits[mid]! < g) lo = mid + 1;
      else hi = mid;
    }
    return lo < splits.length && splits[lo] === g;
  };
  let m = 0;
  for (let i = 0; i < drawn.length; i++) {
    const g = drawn[i]!;
    if (isSplit(g) || (!fading && depthOf(g) < min)) continue;
    cells[m++] = g;
  }
  for (let i = 0; i < culled.length; i++) {
    const g = culled[i]!;
    if (!fading && depthOf(g) < min) continue;
    cells[m++] = g;
  }
  return m;
}

/**
 * Build the super-edge rows of the cells among `covers` (#433; leaves and repeats are left out) over `graph`
 * — see the module comment for what a row holds. The rows are built in `scratch`, then copied into the
 * arrays `allocate` returns for their final sizes — a caller that transfers them passes views of a pooled
 * buffer ({@link spatialRowsViews}). O(Σ graph edges under the listed cells + O(depth) lifting per leaf);
 * allocates nothing once `scratch` is warm but what `allocate` hands out. Returns the sizes the rows were
 * allocated with.
 */
export function buildCoverRows(
  tree: SpatialRowsTree,
  covers: ArrayLike<number>,
  graph: SpatialRowsGraph,
  scratch: SpatialRowsScratch,
  allocate: (sizes: SpatialRowsSizes) => SpatialRows,
): SpatialRowsSizes {
  spatialRowBuilds++;
  const { size, leafCount: n, parent, leafOrder, leafStart, leafEnd } = tree;
  const sc = scratch;
  if (sc.depth.length < size) {
    sc.depth = new Uint8Array(size);
    sc.markOut = new Int32Array(size);
    sc.slotOut = new Int32Array(size);
    sc.markIn = new Int32Array(size);
    sc.slotIn = new Int32Array(size);
    sc.up = new Int32Array(size);
    sc.upGen = new Int32Array(size);
    sc.seq = 0;
    sc.liftGen = 0;
  }
  // Depth below the root: a spatial tree numbers a parent above its children, so a descending pass sets it first.
  const depth = sc.depth;
  for (let g = size - 1; g >= 0; g--) {
    const p = parent[g]!;
    depth[g] = p < 0 ? 0 : depth[p]! + 1;
  }
  // The listed cells, deduplicated (a mark per cell, from the merge marks' sequence) and ascending.
  growCells(sc, covers.length);
  if (sc.seq >= 0x7fffffff - covers.length - 1) { sc.markOut.fill(0); sc.markIn.fill(0); sc.seq = 0; }
  const listed = ++sc.seq;
  let cells = 0;
  for (let i = 0; i < covers.length; i++) {
    const x = covers[i]!;
    if (x < n || x >= size || sc.markOut[x] === listed) continue;
    sc.markOut[x] = listed;
    sc.cells[cells++] = x;
  }
  const cellIds = sc.cells.subarray(0, cells);
  cellIds.sort();
  // Built deepest first, so each leaf's lift only ever moves up: `up[v]` holds leaf v's node at the depth
  // last lifted to, and a shallower cell lifts it further from there — O(depth) climbing per leaf per build,
  // whatever the mix of cover depths. A counting sort of the cell indices by depth, descending.
  const byDepth = sc.byDepth;
  byDepth.fill(0);
  for (let i = 0; i < cells; i++) byDepth[255 - depth[cellIds[i]!]! + 1]!++;
  for (let d = 0; d < 256; d++) byDepth[d + 1] = byDepth[d + 1]! + byDepth[d]!;
  for (let i = 0; i < cells; i++) {
    const d = 255 - depth[cellIds[i]!]!;
    sc.order[byDepth[d]!] = i;
    byDepth[d] = byDepth[d]! + 1;
  }
  const { markOut, slotOut, markIn, slotIn, up, upGen } = sc;
  const { offsets, neighbors } = graph.csr;
  const incW = graph.weight;
  const incOut = graph.out;
  const uniform = graph.uniform;
  let outLen = 0;
  let inLen = 0;
  if (sc.liftGen >= 0x7fffffff) { upGen.fill(0); sc.liftGen = 0; }
  const gen = ++sc.liftGen; // up[v] is valid for this build while upGen[v] === gen
  for (let o = 0; o < cells; o++) {
    const i = sc.order[o]!;
    const x = cellIds[i]!;
    const dx = depth[x]!;
    const seq = ++sc.seq;
    sc.outStart[i] = outLen;
    sc.inStart[i] = inLen;
    const r1 = leafEnd[x]!;
    for (let r = leafStart[x]!; r < r1; r++) {
      const u = leafOrder[r]!;
      const p1 = offsets[u + 1]!;
      for (let p = offsets[u]!; p < p1; p++) {
        // The neighbour's node at this cell's depth (itself when shallower), lifted on from where it last was.
        const v = neighbors[p]!;
        let t = upGen[v] === gen ? up[v]! : v;
        while (depth[t]! > dx) t = parent[t]!;
        up[v] = t;
        upGen[v] = gen;
        // Only a node under this cell lifts onto it, and nothing at its depth or above lies inside it: so
        // `t === x` is exactly an edge inside the cell, self-loops included.
        if (t === x) continue;
        const w = incW ? incW[p]! : uniform;
        if (incOut[p] === 1) {
          if (markOut[t] === seq) {
            const e = slotOut[t]!;
            sc.outFlow[e] = sc.outFlow[e]! + w;
          } else {
            if (outLen === sc.outNode.length) growOut(sc, outLen + 1);
            markOut[t] = seq;
            slotOut[t] = outLen;
            sc.outNode[outLen] = t;
            sc.outFlow[outLen++] = 0 + w; // a sum from +0
          }
        } else if (markIn[t] === seq) {
          const e = slotIn[t]!;
          sc.inFlow[e] = sc.inFlow[e]! + w;
        } else {
          if (inLen === sc.inNode.length) growIn(sc, inLen + 1);
          markIn[t] = seq;
          slotIn[t] = inLen;
          sc.inNode[inLen] = t;
          sc.inFlow[inLen++] = 0 + w;
        }
      }
    }
    sc.outLen[i] = outLen - sc.outStart[i]!;
    sc.inLen[i] = inLen - sc.inStart[i]!;
  }
  const sizes: SpatialRowsSizes = { size, leafCount: n, cells, outEntries: outLen, inEntries: inLen };
  const rows = allocate(sizes);
  rows.depth.set(depth.subarray(0, size));
  rows.cell.set(cellIds);
  // Copy the rows out in cell order (they were built by depth).
  let oa = 0;
  let ia = 0;
  for (let i = 0; i < cells; i++) {
    rows.outOffset[i] = oa;
    rows.inOffset[i] = ia;
    const os = sc.outStart[i]!;
    const ol = sc.outLen[i]!;
    rows.outNode.set(sc.outNode.subarray(os, os + ol), oa);
    rows.outFlow.set(sc.outFlow.subarray(os, os + ol), oa);
    oa += ol;
    const is = sc.inStart[i]!;
    const il = sc.inLen[i]!;
    rows.inNode.set(sc.inNode.subarray(is, is + il), ia);
    rows.inFlow.set(sc.inFlow.subarray(is, is + il), ia);
    ia += il;
  }
  rows.outOffset[cells] = oa;
  rows.inOffset[cells] = ia;
  return sizes;
}

/** Allocate a rows set as separate typed arrays (tests, and a caller that does not transfer them). */
export function allocateSpatialRows(sizes: SpatialRowsSizes): SpatialRows {
  return spatialRowsViews(new ArrayBuffer(spatialRowsByteLength(sizes)), sizes);
}
