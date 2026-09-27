/**
 * **Lazy super-edges** for a spatial LOD tree (#343): the links between drawn glyphs, gathered per frame
 * from the graph's own adjacency through the tree's contiguous leaf runs — no super-edge CSR.
 *
 * A spatial (Morton) tree is rebuilt on every streamed layout frame, so precomputing its super-edge CSR
 * (132-189 ms and ~40 MB on a 325k-node web graph) per frame is out of the question. Instead, each frame:
 *
 * 1. **Covers.** The cut's frontier and its culled subtree roots together cover every leaf once; each is
 *    stamped with its role (kept after declutter, decluttered away, or culled).
 * 2. **Rows.** For each kept glyph `g`, walk the graph edges of the leaves in its run and resolve each
 *    neighbour leaf to the cover holding it (a memoised climb of the parent pointers — only touched nodes
 *    are written). Its **row** sums the flow toward each neighbouring cover, out and in.
 * 3. **Pairs.** The same drawing rules as the CSR gather: a pair of kept glyphs is drawn, a pair toward an
 *    off-screen cover is drawn (it exits the view toward it), and a pair toward a decluttered glyph on
 *    screen is skipped. The frontier is an antichain of cells, so there is no mixed-level projection to do:
 *    every neighbour already resolves to the one cover drawn for it.
 *
 * A row depends only on which nodes are covers, never on the view or on declutter, so rows are memoised
 * **per tree**: a row stays valid while every cover it names is still a cover (and not split by a
 * cross-fade band) — then all its leaves still resolve the same way. A held view, or any re-emit that does
 * not change the cut, re-evaluates each row in O(row length) instead of re-walking its leaves' edges.
 */
import type { CSR, NetworkGraph } from "./graph.js";
import type { LODTree } from "./lod.js";
import { PairIndex } from "./pair-index.js";
import { makeSuperEdgesScratch, superEdgeBatches, type SuperEdgeStyleResolved, type SuperEdgesData, type SuperEdgesScratch } from "./glyphs.js";

/**
 * Per-incidence weight and direction for the graph's undirected CSR (#343), parallel to
 * `graph.csr.neighbors`: what the lazy gather needs to sum flow per pair. Built once per graph (and
 * direction mode), O(edges).
 */
export interface LeafIncidence {
  /** The graph it was built for (a cache key: a new graph needs a new incidence). */
  graph: NetworkGraph;
  /** Whether the gather keeps edge direction (`out` is set). */
  directed: boolean;
  /** Each CSR entry's edge weight, or `null` when every edge weighs {@link uniform} (no array kept). */
  weight: Float32Array | null;
  /** The one weight of every edge when {@link weight} is `null`. */
  uniform: number;
  /** Each CSR entry's direction — 1 when its row's node is the edge's source, 0 when its target — or
   *  `null` for an undirected gather. */
  out: Uint8Array | null;
}

/**
 * The {@link LeafIncidence} of `graph`, in `buildCSR`'s entry order (each edge adds its source's entry,
 * then its target's). Memory: 4 B per CSR entry (8 B per edge) for the weights unless every edge has the
 * same weight, plus 1 B per entry (2 B per edge) for the direction when `directed`. O(edges), once.
 */
export function buildLeafIncidence(graph: NetworkGraph, directed: boolean): LeafIncidence {
  const { csr, source, target, weight: w, edgeCount, nodeCount } = graph;
  let uniformWeight = edgeCount > 0 ? w[0]! : 1;
  for (let e = 1; e < edgeCount; e++) {
    if (w[e] !== uniformWeight) { uniformWeight = NaN; break; }
  }
  const uniform = Number.isNaN(uniformWeight) ? 0 : uniformWeight;
  const keepWeights = Number.isNaN(uniformWeight);
  const entries = csr.neighbors.length;
  const weight = keepWeights ? new Float32Array(entries) : null;
  const out = directed ? new Uint8Array(entries) : null;
  if (weight || out) {
    const cursor = csr.offsets.slice(0, nodeCount);
    for (let e = 0; e < edgeCount; e++) {
      const s = source[e]!;
      const t = target[e]!;
      const ps = cursor[s]!;
      cursor[s] = ps + 1;
      const pt = cursor[t]!;
      cursor[t] = pt + 1;
      if (weight) { weight[ps] = w[e]!; weight[pt] = w[e]!; }
      if (out) out[ps] = 1; // out[pt] stays 0: an in-edge of t
    }
  }
  return { graph, directed, weight, uniform, out };
}

/** Cover roles, in the low 3 bits of a {@link LazySuperEdgesScratch.cover} stamp. */
const KEPT = 1;
const DROPPED = 2;
const CULLED = 3;
/** Direction flags per row entry. */
const HAS_OUT = 1;
const HAS_IN = 2;
/** Row entries the memo may hold (21 B each: ~5 MB) before it drops the rows the last frame did not use. */
const MEMO_MAX_ENTRIES = 1 << 18;
/** Generations before the stamps wrap (`gen << 3` must stay a positive Int32). */
const MAX_GEN = (1 << 28) - 1;

/**
 * Reusable state for {@link lazySuperEdges} (#343), engine-owned. Everything is generation-stamped, so a
 * frame writes only what it touches and the stamp bump is the clear: the cover roles, the culled-climb memo
 * and the per-row accumulation slots over tree nodes (20 B per tree node), and each leaf's cover label
 * (8 B per leaf) — grown once per tree size. Plus the row memo (valid for one tree + incidence)
 * and the gather arrays shared with {@link superEdgeBatches}. Counters report what the last call did, for
 * the per-frame guards.
 */
export interface LazySuperEdgesScratch {
  /** Gather arrays, pair index and paired rows for {@link superEdgeBatches}. */
  edges: SuperEdgesScratch;
  gen: number;
  /** `cover[x] >> 3 === gen` ⇔ x covers leaves this call (drawn or culled); the low 3 bits are its role. */
  cover: Int32Array;
  /** Each leaf's cover, interleaved `[gen, cover]`: leaf `v` is under `label[2v + 1]` while `label[2v] ===
   *  gen`. Written over the drawn covers' runs (finest last), and by a culled climb for the leaf it starts at. */
  label: Int32Array;
  /** Culled-climb memo: `upGen[x] === gen` ⇒ `up[x]` is the culled root holding x; `upGen[x] === −gen`
   *  marks a cover the cut split (drew and expanded, in a cross-fade band). */
  up: Int32Array;
  upGen: Int32Array;
  /** Per-row accumulation: `rowMark[h] === rowSeq` ⇒ `rowSlot[h]` is h's entry in the row being built. */
  rowMark: Int32Array;
  rowSlot: Int32Array;
  rowSeq: number;
  /** The tree and incidence the row memo belongs to. */
  memoTree: LODTree | null;
  memoIncidence: LeafIncidence | null;
  /** Row memo: kept glyph → its row (keyed `(g, g)` over `rowG`), the row's entries `rowStart..+rowLen`. */
  rowIndex: PairIndex;
  rowG: Int32Array;
  rowStart: Int32Array;
  rowLen: Int32Array;
  rows: number;
  /** Row entries: neighbouring cover, flow out of / into the glyph, direction flags. */
  entH: Int32Array;
  entOut: Float64Array;
  entIn: Float64Array;
  entDir: Uint8Array;
  ents: number;
  /** Last call: rows answered from the memo, rows rebuilt, and graph incidences walked to rebuild them. */
  hits: number;
  misses: number;
  visits: number;
}

/** A fresh {@link LazySuperEdgesScratch}. */
export function makeLazySuperEdgesScratch(): LazySuperEdgesScratch {
  return {
    edges: makeSuperEdgesScratch(),
    gen: 0,
    cover: new Int32Array(0),
    label: new Int32Array(0),
    up: new Int32Array(0),
    upGen: new Int32Array(0),
    rowMark: new Int32Array(0),
    rowSlot: new Int32Array(0),
    rowSeq: 0,
    memoTree: null,
    memoIncidence: null,
    rowIndex: new PairIndex(),
    rowG: new Int32Array(64),
    rowStart: new Int32Array(64),
    rowLen: new Int32Array(64),
    rows: 0,
    entH: new Int32Array(1024),
    entOut: new Float64Array(1024),
    entIn: new Float64Array(1024),
    entDir: new Uint8Array(1024),
    ents: 0,
    hits: 0,
    misses: 0,
    visits: 0,
  };
}

/** What the cut drew and culled this frame — the covers. */
export interface LazyCut {
  /** The cut frontier, before declutter. */
  drawn: Uint32Array;
  /** The glyphs kept after declutter (`drawn` itself without declutter). */
  kept: Uint32Array;
  /** The culled subtree roots ({@link CutScratch.culled}). */
  culled: Uint32Array;
  /** The nodes drawn and expanded in a cross-fade band ({@link CutScratch.split}). */
  split: Uint32Array;
}

/** Grow the row-entry arrays to hold `need` entries, keeping what they hold. */
function growEntries(sc: LazySuperEdgesScratch, need: number): void {
  if (need <= sc.entH.length) return;
  const cap = Math.max(need, sc.entH.length * 2);
  const h = new Int32Array(cap); h.set(sc.entH); sc.entH = h;
  const o = new Float64Array(cap); o.set(sc.entOut); sc.entOut = o;
  const i = new Float64Array(cap); i.set(sc.entIn); sc.entIn = i;
  const d = new Uint8Array(cap); d.set(sc.entDir); sc.entDir = d;
}

/** Grow the row records to hold `need` rows, keeping what they hold. */
function growRows(sc: LazySuperEdgesScratch, need: number): void {
  if (need <= sc.rowG.length) return;
  const cap = Math.max(need, sc.rowG.length * 2);
  const g = new Int32Array(cap); g.set(sc.rowG); sc.rowG = g;
  const s = new Int32Array(cap); s.set(sc.rowStart); sc.rowStart = s;
  const l = new Int32Array(cap); l.set(sc.rowLen); sc.rowLen = l;
}

/**
 * Drop every memoised row but those of `kept` (this frame's glyphs), moving their entries to the front of
 * the arena in place — a held view that follows then still answers from the memo. O(this frame's rows'
 * entries + kept · log kept), only when the arena has grown past its bound.
 */
function compactRows(sc: LazySuperEdgesScratch, kept: Uint32Array): void {
  const rows: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    const g = kept[i]!;
    const row = sc.rowIndex.find(g, g, sc.rowG, sc.rowG);
    if (row >= 0) rows.push(row);
  }
  // Entries move toward the front in their current order, so a row is never overwritten before it moves.
  rows.sort((a, b) => sc.rowStart[a]! - sc.rowStart[b]!);
  const g = new Int32Array(rows.length);
  const start = new Int32Array(rows.length);
  const len = new Int32Array(rows.length);
  let ents = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const from = sc.rowStart[row]!;
    const n = sc.rowLen[row]!;
    sc.entH.copyWithin(ents, from, from + n);
    sc.entOut.copyWithin(ents, from, from + n);
    sc.entIn.copyWithin(ents, from, from + n);
    sc.entDir.copyWithin(ents, from, from + n);
    g[i] = sc.rowG[row]!;
    start[i] = ents;
    len[i] = n;
    ents += n;
  }
  sc.rowIndex.reset(rows.length);
  sc.rows = 0;
  for (let i = 0; i < rows.length; i++) {
    sc.rowG[i] = g[i]!;
    sc.rowStart[i] = start[i]!;
    sc.rowLen[i] = len[i]!;
    sc.rowIndex.findOrAdd(g[i]!, g[i]!, i, sc.rowG, sc.rowG);
    sc.rows++;
  }
  sc.ents = ents;
}

/**
 * The super-edges among the kept glyphs of a spatial tree's cut (#343), gathered from the graph's adjacency
 * through the tree's leaf runs ({@link LODTree.leafOrder}) — see the module comment. Same output as
 * {@link superEdges}: pairs keyed `a · tree.size + b`, drawn per `style.linkStyle`. With `style.directed`,
 * pairs keep the edges' direction (out-flow drawn from its source); otherwise a pair of kept glyphs is drawn
 * once with the flow of both directions. `crossLevelEdges` and anchoring do not apply: every neighbour
 * resolves to the one glyph (or culled cell) that covers it. In a cross-fade band a neighbour resolves to
 * its finest drawn cover.
 *
 * Per call: O(drawn + culled) to stamp the covers, then per kept glyph either O(row length) (memo hit) or
 * O(Σ degree of its leaves) plus the climbs (memo miss). Needs `tree.leafOrder`/`leafStart`/`leafEnd` and
 * `tree.parent`; returns `{ ids: [] }` without them.
 */
export function lazySuperEdges(
  tree: LODTree,
  cutSet: LazyCut,
  style: SuperEdgeStyleResolved,
  view: { minX: number; maxX: number; minY: number; maxY: number },
  csr: CSR,
  incidence: LeafIncidence,
  scratch: LazySuperEdgesScratch = makeLazySuperEdgesScratch(),
): SuperEdgesData {
  const { leafOrder, leafStart, leafEnd, parent } = tree;
  const sc = scratch;
  sc.hits = 0;
  sc.misses = 0;
  sc.visits = 0;
  if (!leafOrder || !leafStart || !leafEnd || !parent) return { ids: [] };

  // Stamps: grown once per tree size; the generation bump is the per-call clear.
  if (sc.cover.length < tree.size) {
    sc.cover = new Int32Array(tree.size);
    sc.up = new Int32Array(tree.size);
    sc.upGen = new Int32Array(tree.size);
    sc.rowMark = new Int32Array(tree.size);
    sc.rowSlot = new Int32Array(tree.size);
  }
  if (sc.label.length < 2 * tree.leafCount) sc.label = new Int32Array(2 * tree.leafCount);
  if (sc.gen >= MAX_GEN) { sc.cover.fill(0); sc.upGen.fill(0); sc.label.fill(0); sc.gen = 0; }
  const gen = ++sc.gen;
  const stamp = gen << 3;
  const cover = sc.cover;
  const label = sc.label;
  const up = sc.up;
  const upGen = sc.upGen;
  const { drawn, kept, culled, split } = cutSet;
  // Drawn covers: role, and their leaves labelled. The frontier lists a split node before the nodes below
  // it, so the finest drawn cover of a leaf is written last.
  for (let i = 0; i < drawn.length; i++) {
    const x = drawn[i]!;
    cover[x] = stamp | DROPPED;
    for (let r = leafStart[x]!; r < leafEnd[x]!; r++) {
      const v = leafOrder[r]!;
      label[2 * v] = gen;
      label[2 * v + 1] = x;
    }
  }
  for (let i = 0; i < kept.length; i++) cover[kept[i]!] = stamp | KEPT;
  for (let i = 0; i < culled.length; i++) cover[culled[i]!] = stamp | CULLED;
  for (let i = 0; i < split.length; i++) upGen[split[i]!] = -gen;
  const fading = split.length > 0;
  if (fading) {
    // A culled root under a split node (the only drawn cover with anything culled below it) is the finer
    // cover of its leaves: label them after the drawn ones. O(depth) per culled root, in a band only.
    for (let i = 0; i < culled.length; i++) {
      const c = culled[i]!;
      for (let x = parent[c]!; x >= 0; x = parent[x]!) {
        if (cover[x]! >> 3 !== gen) continue;
        for (let r = leafStart[c]!; r < leafEnd[c]!; r++) {
          const v = leafOrder[r]!;
          label[2 * v] = gen;
          label[2 * v + 1] = c;
        }
        break;
      }
    }
  }

  // The row memo belongs to one tree and one incidence (weights + direction); start over otherwise.
  if (sc.memoTree !== tree || sc.memoIncidence !== incidence) {
    sc.memoTree = tree;
    sc.memoIncidence = incidence;
    sc.rowIndex.reset();
    sc.rows = 0;
    sc.ents = 0;
  }

  // The culled root holding leaf v (a leaf no drawn cover labelled): the first stamped ancestor, memoised
  // with path compression over the climbed chain (only touched nodes are written).
  const climb = (v: number): number => {
    let x = parent[v]!;
    while (x >= 0 && cover[x]! >> 3 !== gen && upGen[x] !== gen) x = parent[x]!;
    const c = x < 0 ? -1 : cover[x]! >> 3 === gen ? x : up[x]!;
    label[2 * v] = gen;
    label[2 * v + 1] = c;
    for (let y = parent[v]!; y !== x; y = parent[y]!) { up[y] = c; upGen[y] = gen; }
    return c;
  };

  const { offsets, neighbors } = csr;
  const incW = incidence.weight;
  const incOut = incidence.out;
  const uniform = incidence.uniform;
  const rowIndex = sc.rowIndex;
  const rowMark = sc.rowMark;
  const rowSlot = sc.rowSlot;

  // Build g's row at the end of the entry arena; returns its row id.
  const buildRow = (g: number): number => {
    const start = sc.ents;
    let ents = start;
    let entH = sc.entH;
    let entOut = sc.entOut;
    let entIn = sc.entIn;
    let entDir = sc.entDir;
    let visits = 0;
    if (sc.rowSeq === 0x7fffffff) { rowMark.fill(0); sc.rowSeq = 0; }
    const seq = ++sc.rowSeq;
    const g0 = leafStart[g]!;
    const g1 = leafEnd[g]!;
    for (let r = g0; r < g1; r++) {
      const u = leafOrder[r]!;
      const p1 = offsets[u + 1]!;
      visits += p1 - offsets[u]!;
      for (let p = offsets[u]!; p < p1; p++) {
        const v = neighbors[p]!;
        const h = label[2 * v] === gen ? label[2 * v + 1]! : climb(v);
        // Not a pair with itself — nor, in a fade band, with a cover nested in or around it.
        if (h === g || h < 0 || (fading && leafStart[h]! < g1 && g0 < leafEnd[h]!)) continue;
        let e: number;
        if (rowMark[h] === seq) e = rowSlot[h]!;
        else {
          if (ents === entH.length) {
            sc.ents = ents;
            growEntries(sc, ents + 1);
            entH = sc.entH;
            entOut = sc.entOut;
            entIn = sc.entIn;
            entDir = sc.entDir;
          }
          e = ents++;
          rowMark[h] = seq;
          rowSlot[h] = e;
          entH[e] = h;
          entOut[e] = 0;
          entIn[e] = 0;
          entDir[e] = 0;
        }
        const w = incW ? incW[p]! : uniform;
        if (!incOut || incOut[p] === 1) {
          entOut[e] = entOut[e]! + w;
          entDir[e] = entDir[e]! | HAS_OUT;
        } else {
          entIn[e] = entIn[e]! + w;
          entDir[e] = entDir[e]! | HAS_IN;
        }
      }
    }
    sc.ents = ents;
    sc.visits += visits;
    growRows(sc, sc.rows + 1);
    const row = rowIndex.findOrAdd(g, g, sc.rows, sc.rowG, sc.rowG);
    if (row === sc.rows) {
      sc.rowG[row] = g;
      sc.rows++;
    }
    sc.rowStart[row] = start;
    sc.rowLen[row] = ents - start;
    return row;
  };

  // A memoised row is valid while every cover it names is still a cover, and not split.
  const rowValid = (row: number): boolean => {
    const e1 = sc.rowStart[row]! + sc.rowLen[row]!;
    for (let e = sc.rowStart[row]!; e < e1; e++) {
      const h = sc.entH[e]!;
      if (cover[h]! >> 3 !== gen || upGen[h] === -gen) return false;
    }
    return true;
  };

  const out = sc.edges;
  let len = 0;
  let paired = 0;
  const reciprocal = style.linkStyle === "half-arrow" && style.directed;
  const directed = incOut !== null;
  const push = (a: number, b: number, w: number): void => {
    if (len === out.aS.length) {
      const cap = len * 2;
      const na = new Int32Array(cap); na.set(out.aS); out.aS = na;
      const nb = new Int32Array(cap); nb.set(out.bS); out.bS = nb;
      const nw = new Float64Array(cap); nw.set(out.wS); out.wS = nw;
    }
    out.aS[len] = a;
    out.bS[len] = b;
    out.wS[len] = w;
    len++;
  };
  const pairLast = (): void => {
    if (paired === out.pairedRows.length) {
      const nr = new Int32Array(paired * 2);
      nr.set(out.pairedRows);
      out.pairedRows = nr;
    }
    out.pairedRows[paired++] = len - 1;
  };
  const offScreen = (h: number): boolean => tree.cx[h]! < view.minX || tree.cx[h]! > view.maxX || tree.cy[h]! < view.minY || tree.cy[h]! > view.maxY;

  for (let i = 0; i < kept.length; i++) {
    const g = kept[i]!;
    let row = rowIndex.find(g, g, sc.rowG, sc.rowG);
    if (row >= 0 && rowValid(row)) sc.hits++;
    else {
      row = buildRow(g);
      sc.misses++;
    }
    const e1 = sc.rowStart[row]! + sc.rowLen[row]!;
    for (let e = sc.rowStart[row]!; e < e1; e++) {
      const h = sc.entH[e]!;
      const role = cover[h]! & 7;
      const dir = sc.entDir[e]!;
      if (role === KEPT) {
        // Both drawn: a directed pair from its source's row; an undirected one once, from its lower id.
        if (directed) {
          if (dir & HAS_OUT) {
            push(g, h, sc.entOut[e]!);
            if (reciprocal) pairLast();
          }
        } else if (g < h) {
          push(g, h, sc.entOut[e]!);
        }
      } else if (offScreen(h)) {
        // Toward an off-screen cover (culled, or a glyph at the edge declutter dropped): drawn from g.
        if (dir & HAS_OUT) push(g, h, sc.entOut[e]!);
        if (dir & HAS_IN) push(h, g, sc.entIn[e]!);
      }
      // else: a decluttered glyph on screen — skipped, as by the CSR gather.
    }
  }
  // Rebuilt rows append, so the arena grows as the view moves: past its bound, keep only this frame's rows.
  if (sc.ents > MEMO_MAX_ENTRIES) compactRows(sc, kept);
  return superEdgeBatches(tree, out, len, paired, style, cover, stamp | KEPT, null);
}
