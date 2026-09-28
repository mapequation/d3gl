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
 * 3. **Pairs.** A pair of kept glyphs is drawn, a pair toward an off-screen cover is drawn (it exits the
 *    view toward it), and a pair toward a decluttered glyph on screen is skipped. The frontier is an
 *    antichain of cells, so there is no mixed-level projection to do: every neighbour already resolves to
 *    the one cover drawn for it.
 *
 * Where this differs from the CSR gather ({@link superEdges}) on the same tree — pinned against it for the
 * cases they share (every glyph on screen, `crossLevelEdges` on) by `lazy-super-edges.test.ts`:
 * - kept glyphs at **different depths** are always linked, as the CSR gather does only with
 *   `crossLevelEdges` (the option has no effect here);
 * - an **off-screen end** is the culled cover holding the neighbour — a culled subtree's root, drawn at its
 *   centroid — not the neighbour's same-depth cell, so links leaving the view bundle toward fewer, coarser
 *   points, which change as panning culls different subtrees;
 * - an **undirected** pair is drawn once with the flow of both directions (the CSR gather draws one line
 *   per direction).
 *
 * A row depends only on which nodes are covers, never on the view or on declutter, so rows are memoised
 * **per tree**: a row stays valid while every cover it names is still a cover (and not split by a
 * cross-fade band) — then all its leaves still resolve the same way. A held view, or any re-emit that does
 * not change the cut, re-evaluates each row in O(row length) instead of re-walking its leaves' edges.
 */
import type { CSR, NetworkGraph } from "./graph.js";
import type { LODTree } from "./lod.js";
import { PairIndex } from "./pair-index.js";
import { incidenceArrays, rowOf, type IncidenceArrays } from "./spatial-rows.js";
import { makeSuperEdgesScratch, superEdgeBatches, type SuperEdgeStyleResolved, type SuperEdgesData, type SuperEdgesScratch } from "./glyphs.js";

/**
 * Per-incidence weight and direction for the graph's undirected CSR (#343), parallel to
 * `graph.csr.neighbors`: what the lazy gather needs to sum flow per pair. Built once per graph (and
 * direction mode), O(edges).
 */
export interface LeafIncidence extends IncidenceArrays {
  /** The graph it was built for (a cache key: a new graph needs a new incidence). */
  graph: NetworkGraph;
  /** Whether it keeps edge direction (`out` is set). The lazy gather reads the direction only for a
   *  directed style; the row gather (#433) always does. */
  directed: boolean;
}

/**
 * The {@link LeafIncidence} of `graph`, in `buildCSR`'s entry order (each edge adds its source's entry,
 * then its target's). Memory: 4 B per CSR entry (8 B per edge) for the weights unless every edge has the
 * same weight, plus 1 B per entry (2 B per edge) for the direction when `directed`. O(edges), once.
 */
export function buildLeafIncidence(graph: NetworkGraph, directed: boolean): LeafIncidence {
  return { graph, directed, ...incidenceArrays(graph.csr, graph, directed) };
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
  /** Each kept glyph's valid memo row this call, or −1 for a row to rebuild (grown to the kept count). */
  keptRow: Int32Array;
  /** Last call: rows answered from the memo, rows rebuilt, graph incidences walked to rebuild them, and
   *  leaves labelled with their cover (only when a row was rebuilt — 0 on a held view). */
  hits: number;
  misses: number;
  visits: number;
  labelled: number;
  /**
   * {@link rowSuperEdges} (#433) in a cross-fade band: per kept split glyph and finest cover outside it, the
   * pairs of its members summed — keyed `(split, cover)` over `aggS`/`aggH`, `aggOut` from the split glyph,
   * `aggIn` into it, which directions carry an edge in `aggDir`. (Its per-cover rows use the entry arena
   * above.) 29 B per pair plus the index.
   */
  aggIndex: PairIndex;
  aggS: Int32Array;
  aggH: Int32Array;
  aggOut: Float64Array;
  aggIn: Float64Array;
  aggDir: Uint8Array;
  /**
   * {@link rowSuperEdges}' own rows (#433): for the tree `cacheTree`, the super-edge rows of cells its worker
   * rows did not list (the view moved since they were built), computed here from the cells' leaves once and
   * kept while the tree is drawn — the same partner rule as the worker's, so valid for any cut. Keyed
   * `(cell, cell)` over `cacheCell`; row `r` is `cacheNode/Out/In/Dir[cacheStart[r] .. + cacheLen[r])`, each
   * entry a partner with its flow out of and into the cell. 21 B per entry, bounded like the row memo.
   */
  cacheTree: LODTree | null;
  cacheIndex: PairIndex;
  cacheCell: Int32Array;
  cacheStart: Int32Array;
  cacheLen: Int32Array;
  cacheRows: number;
  cacheNode: Int32Array;
  cacheOut: Float64Array;
  cacheIn: Float64Array;
  cacheDir: Uint8Array;
  cacheEnts: number;
  /** The covers a {@link rowSuperEdges} call walks, and the cells among them it computes rows for. */
  walked: Uint32Array;
  missing: Uint32Array;
  /** Stamp of the leaf-lift memo {@link rowSuperEdges} keeps in `label` (negative: never a lazy generation). */
  liftGen: number;
  /** Last {@link rowSuperEdges} call: stored row entries and leaf covers' incidences it read (0 for the lazy
   *  gather). Its `misses` are the rows it computed from leaves, `visits` the incidences that walked. */
  entries: number;
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
    keptRow: new Int32Array(64),
    hits: 0,
    misses: 0,
    visits: 0,
    labelled: 0,
    aggIndex: new PairIndex(),
    aggS: new Int32Array(16),
    aggH: new Int32Array(16),
    aggOut: new Float64Array(16),
    aggIn: new Float64Array(16),
    aggDir: new Uint8Array(16),
    cacheTree: null,
    cacheIndex: new PairIndex(),
    cacheCell: new Int32Array(64),
    cacheStart: new Int32Array(64),
    cacheLen: new Int32Array(64),
    cacheRows: 0,
    cacheNode: new Int32Array(1024),
    cacheOut: new Float64Array(1024),
    cacheIn: new Float64Array(1024),
    cacheDir: new Uint8Array(1024),
    cacheEnts: 0,
    walked: new Uint32Array(256),
    missing: new Uint32Array(64),
    liftGen: 0,
    entries: 0,
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
  for (const g of kept) {
    const row = sc.rowIndex.find(g, g, sc.rowG, sc.rowG);
    if (row >= 0) rows.push(row);
  }
  // Entries move toward the front in their current order, so a row is never overwritten before it moves.
  rows.sort((a, b) => (sc.rowStart[a] ?? 0) - (sc.rowStart[b] ?? 0));
  const moved = rows.map((row) => ({ g: sc.rowG[row] ?? 0, from: sc.rowStart[row] ?? 0, n: sc.rowLen[row] ?? 0 }));
  sc.rowIndex.reset(rows.length);
  sc.rows = 0;
  let ents = 0;
  for (const { g, from, n } of moved) {
    sc.entH.copyWithin(ents, from, from + n);
    sc.entOut.copyWithin(ents, from, from + n);
    sc.entIn.copyWithin(ents, from, from + n);
    sc.entDir.copyWithin(ents, from, from + n);
    const i = sc.rows++;
    sc.rowG[i] = g;
    sc.rowStart[i] = ents;
    sc.rowLen[i] = n;
    sc.rowIndex.findOrAdd(g, g, i, sc.rowG, sc.rowG);
    ents += n;
  }
  sc.ents = ents;
}

/**
 * Stamp this call's covers into `sc` (#343, #433): each drawn glyph `stamp | DROPPED`, each kept one
 * `stamp | KEPT`, each culled root `stamp | CULLED` in `sc.cover`, and each drawn-and-expanded glyph of a
 * cross-fade band `−gen` in `sc.upGen`. Grows the per-tree-node stamps once per tree size (12 B per node)
 * and bumps the generation — the per-call clear. Returns the generation. O(drawn + culled).
 */
function stampCovers(sc: LazySuperEdgesScratch, size: number, cutSet: LazyCut): number {
  if (sc.cover.length < size) {
    sc.cover = new Int32Array(size);
    sc.up = new Int32Array(size);
    sc.upGen = new Int32Array(size);
  }
  if (sc.gen >= MAX_GEN) { sc.cover.fill(0); sc.upGen.fill(0); sc.label.fill(0); sc.gen = 0; }
  const gen = ++sc.gen;
  const stamp = gen << 3;
  const { cover, upGen } = sc;
  const { drawn, kept, culled, split } = cutSet;
  for (let i = 0; i < drawn.length; i++) cover[drawn[i]!] = stamp | DROPPED;
  for (let i = 0; i < kept.length; i++) cover[kept[i]!] = stamp | KEPT;
  for (let i = 0; i < culled.length; i++) cover[culled[i]!] = stamp | CULLED;
  for (let i = 0; i < split.length; i++) upGen[split[i]!] = -gen;
  return gen;
}

/**
 * The super-edges among the kept glyphs of a spatial tree's cut (#343), gathered from the graph's adjacency
 * through the tree's leaf runs ({@link LODTree.leafOrder}) — see the module comment for its drawing rules
 * and where they differ from {@link superEdges}. The same output shape: pairs keyed `a · tree.size + b`,
 * drawn per `style.linkStyle`. With `style.directed`, pairs keep the edges' direction (out-flow drawn from
 * its source); otherwise a pair of kept glyphs is drawn once with the flow of both directions.
 * `crossLevelEdges` and anchoring do not apply: every neighbour resolves to the one glyph (or culled cell)
 * that covers it. In a cross-fade band a neighbour resolves to its finest drawn cover.
 *
 * Per call: O(drawn + culled) to stamp the covers and O(kept + memoised rows' length) to check the memo;
 * then, only if some row missed, O(leaves under the frontier) to label them, and per missed glyph
 * O(Σ degree of its leaves) plus the climbs. A held view costs the first two terms alone. Needs `tree.leafOrder`/`leafStart`/`leafEnd` and
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
  sc.labelled = 0;
  sc.entries = 0;
  if (!leafOrder || !leafStart || !leafEnd || !parent) return { ids: [] };

  if (sc.rowMark.length < tree.size) {
    sc.rowMark = new Int32Array(tree.size);
    sc.rowSlot = new Int32Array(tree.size);
  }
  if (sc.label.length < 2 * tree.leafCount) sc.label = new Int32Array(2 * tree.leafCount);
  // Cover roles: O(drawn + culled). Leaves are labelled with their cover only if a row must be rebuilt.
  const gen = stampCovers(sc, tree.size, cutSet);
  const stamp = gen << 3;
  const cover = sc.cover;
  const label = sc.label;
  const up = sc.up;
  const upGen = sc.upGen;
  const { drawn, kept, culled, split } = cutSet;
  const fading = split.length > 0;

  // The row memo belongs to one tree and one incidence (weights + direction); start over otherwise.
  if (sc.memoTree !== tree || sc.memoIncidence !== incidence) {
    sc.memoTree = tree;
    sc.memoIncidence = incidence;
    sc.rowIndex.reset();
    sc.rows = 0;
    sc.ents = 0;
  }

  // A memoised row is valid while every cover it names is still a cover, and not split.
  const rowValid = (row: number): boolean => {
    const e1 = sc.rowStart[row]! + sc.rowLen[row]!;
    for (let e = sc.rowStart[row]!; e < e1; e++) {
      const h = sc.entH[e]!;
      if (cover[h]! >> 3 !== gen || upGen[h] === -gen) return false;
    }
    return true;
  };
  // Each kept glyph's memo row, checked before any leaf is labelled: a held view (every row valid) labels
  // nothing, so it costs O(kept + rows' length), not O(leaves under the frontier).
  if (sc.keptRow.length < kept.length) sc.keptRow = new Int32Array(Math.max(kept.length, 2 * sc.keptRow.length));
  const keptRow = sc.keptRow;
  let rebuild = false;
  for (let i = 0; i < kept.length; i++) {
    const g = kept[i]!;
    const row = sc.rowIndex.find(g, g, sc.rowG, sc.rowG);
    const ok = row >= 0 && rowValid(row);
    keptRow[i] = ok ? row : -1;
    if (!ok) rebuild = true;
  }
  if (rebuild) {
    // Label the drawn covers' leaves. The frontier lists a split node before the nodes below it, so the
    // finest drawn cover of a leaf is written last.
    let labelled = 0;
    for (let i = 0; i < drawn.length; i++) {
      const x = drawn[i]!;
      const r1 = leafEnd[x]!;
      labelled += r1 - leafStart[x]!;
      for (let r = leafStart[x]!; r < r1; r++) {
        const v = leafOrder[r]!;
        label[2 * v] = gen;
        label[2 * v + 1] = x;
      }
    }
    if (fading) {
      // A culled root under a split node (the only drawn cover with anything culled below it) is the finer
      // cover of its leaves: label them after the drawn ones. O(depth) per culled root, in a band only.
      for (let i = 0; i < culled.length; i++) {
        const c = culled[i]!;
        for (let x = parent[c]!; x >= 0; x = parent[x]!) {
          if (cover[x]! >> 3 !== gen) continue;
          labelled += leafEnd[c]! - leafStart[c]!;
          for (let r = leafStart[c]!; r < leafEnd[c]!; r++) {
            const v = leafOrder[r]!;
            label[2 * v] = gen;
            label[2 * v + 1] = c;
          }
          break;
        }
      }
    }
    sc.labelled = labelled;
  }

  // The culled root holding leaf v (a leaf no drawn cover labelled): the first stamped ancestor, memoised
  // with path compression over the climbed chain (only touched nodes are written).
  const climb = (v: number): number => {
    if (cover[v]! >> 3 === gen) {
      // A culled leaf (an off-screen member of an expanded cell) is its own cover.
      label[2 * v] = gen;
      label[2 * v + 1] = v;
      return v;
    }
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
  // Direction only for a directed style: an undirected gather sums every incidence as the glyph's own.
  const incOut = style.directed ? incidence.out : null;
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
    let row = keptRow[i]!;
    if (row >= 0) sc.hits++;
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

/** Grow the cached rows' records to hold `need` rows, keeping what they hold. */
function growCacheRows(sc: LazySuperEdgesScratch, need: number): void {
  if (need <= sc.cacheCell.length) return;
  const cap = Math.max(need, sc.cacheCell.length * 2);
  const c = new Int32Array(cap); c.set(sc.cacheCell); sc.cacheCell = c;
  const s0 = new Int32Array(cap); s0.set(sc.cacheStart); sc.cacheStart = s0;
  const l = new Int32Array(cap); l.set(sc.cacheLen); sc.cacheLen = l;
}

/** Grow the cached rows' entries to hold `need` entries, keeping what they hold. */
function growCacheEntries(sc: LazySuperEdgesScratch, need: number): void {
  if (need <= sc.cacheNode.length) return;
  const cap = Math.max(need, sc.cacheNode.length * 2);
  const h = new Int32Array(cap); h.set(sc.cacheNode); sc.cacheNode = h;
  const o = new Float64Array(cap); o.set(sc.cacheOut); sc.cacheOut = o;
  const i = new Float64Array(cap); i.set(sc.cacheIn); sc.cacheIn = i;
  const d = new Uint8Array(cap); d.set(sc.cacheDir); sc.cacheDir = d;
}

/**
 * Drop every cached row but those of `keep` (this call's walked covers), moving their entries to the front in
 * place, as {@link compactRows} does for the row memo. Only when the cache has grown past its bound.
 */
function compactCache(sc: LazySuperEdgesScratch, keep: Uint32Array): void {
  const rows: number[] = [];
  for (const x of keep) {
    const r = sc.cacheIndex.find(x, x, sc.cacheCell, sc.cacheCell);
    if (r >= 0) rows.push(r);
  }
  rows.sort((a, b) => (sc.cacheStart[a] ?? 0) - (sc.cacheStart[b] ?? 0));
  const moved = rows.map((r) => ({ x: sc.cacheCell[r] ?? 0, from: sc.cacheStart[r] ?? 0, n: sc.cacheLen[r] ?? 0 }));
  sc.cacheIndex.reset(rows.length);
  sc.cacheRows = 0;
  let ents = 0;
  for (const { x, from, n } of moved) {
    sc.cacheNode.copyWithin(ents, from, from + n);
    sc.cacheOut.copyWithin(ents, from, from + n);
    sc.cacheIn.copyWithin(ents, from, from + n);
    sc.cacheDir.copyWithin(ents, from, from + n);
    const r = sc.cacheRows++;
    sc.cacheCell[r] = x;
    sc.cacheStart[r] = ents;
    sc.cacheLen[r] = n;
    sc.cacheIndex.findOrAdd(x, x, r, sc.cacheCell, sc.cacheCell);
    ents += n;
  }
  sc.cacheEnts = ents;
}

/** Grow the split-glyph pair records to hold `need` pairs, keeping what they hold. */
function growAggregates(sc: LazySuperEdgesScratch, need: number): void {
  if (need <= sc.aggS.length) return;
  const cap = Math.max(need, sc.aggS.length * 2);
  const a = new Int32Array(cap); a.set(sc.aggS); sc.aggS = a;
  const h = new Int32Array(cap); h.set(sc.aggH); sc.aggH = h;
  const o = new Float64Array(cap); o.set(sc.aggOut); sc.aggOut = o;
  const i = new Float64Array(cap); i.set(sc.aggIn); sc.aggIn = i;
  const d = new Uint8Array(cap); d.set(sc.aggDir); sc.aggDir = d;
}

/**
 * The super-edges among the kept glyphs of a spatial tree's cut, from the **super-edge rows** a streaming
 * layout built with the tree (#433, `tree.rows` — see `spatial-rows.ts`): the same pairs and flows as
 * {@link lazySuperEdges} on the same cut, without walking the edges under the kept glyphs.
 *
 * The finest covers — the drawn glyphs not split by a cross-fade band, and the culled roots — partition the
 * leaves. Each cover whose pairs can be drawn (kept, off-screen, or inside a kept split glyph) is walked
 * once: a leaf through its graph edges (`csr` and `incidence`, which must carry directions), a cell through
 * its stored row — the worker's, or, for a cell the worker's rows do not list (its view moved since), one
 * computed here from the cell's leaves by the same rule and cached for as long as the tree is drawn. Every
 * entry resolves to the finest cover at or above its node (a memoised climb) and is kept when that cover is
 * strictly shallower than the walked one, or at its depth with a larger id: that finds every pair of covers
 * exactly once, from one side, with both directions' flow summed into that side's row. The pairs are drawn
 * by the lazy gather's rules: two kept glyphs are linked (each direction that carries flow, or once
 * undirected); a kept glyph and an off-screen cover likewise; a decluttered glyph on screen is not. A kept
 * glyph the band splits draws its members' pairs toward the covers outside it, as the lazy gather's row of
 * it does. Output order differs from the lazy gather's; the pairs, flows and styles are the same.
 *
 * Per call: O(drawn + culled) to stamp the covers, O(Σ rows read) — stored entries, and the graph edges of
 * leaf covers — plus the climbs, and O(cover pairs) to draw; a walked cell with no row yet adds its leaves'
 * edges once per tree (`scratch.misses` rows, `scratch.visits` incidences: 0 when the worker's rows cover the
 * cut, and on a held view); in a band, O(pairs · depth) more. Clears the lazy gather's row memo (the two
 * share the entry arena). Needs `tree.rows`, `tree.parent` and the leaf runs; returns `{ ids: [] }` without
 * them.
 */
export function rowSuperEdges(
  tree: LODTree,
  cutSet: LazyCut,
  style: SuperEdgeStyleResolved,
  view: { minX: number; maxX: number; minY: number; maxY: number },
  csr: CSR,
  incidence: LeafIncidence,
  scratch: LazySuperEdgesScratch = makeLazySuperEdgesScratch(),
): SuperEdgesData {
  const { rows, parent, leafOrder, leafStart, leafEnd } = tree;
  const sc = scratch;
  sc.hits = 0;
  sc.misses = 0;
  sc.visits = 0;
  sc.labelled = 0;
  sc.entries = 0;
  const incOut = incidence.out;
  if (!rows || !parent || !leafOrder || !leafStart || !leafEnd || !incOut) return { ids: [] };
  if (sc.rowMark.length < tree.size) {
    sc.rowMark = new Int32Array(tree.size);
    sc.rowSlot = new Int32Array(tree.size);
  }
  const gen = stampCovers(sc, tree.size, cutSet);
  const stamp = gen << 3;
  const { cover, up, upGen, rowMark, rowSlot } = sc;
  const { drawn, culled, split } = cutSet;
  const fading = split.length > 0;
  const n = tree.leafCount;
  const { depth, outOffset, outNode, outFlow, inOffset, inNode, inFlow } = rows;
  // The walked covers' rows go into the entry arena the lazy gather memoises its rows in: its memo is void.
  sc.memoTree = null;
  sc.memoIncidence = null;
  sc.rowIndex.reset();
  sc.rows = 0;
  sc.ents = 0;

  // The finest cover at or above t — a drawn glyph not split by the band, or a culled root — or −1 when t
  // lies above the covers (expanded). Memoised with path compression over the climbed chain (`up`, only
  // touched nodes are written; a split glyph's `−gen` mark sits on a stamped node, so it is never written).
  const resolve = (t: number): number => {
    let x = t;
    while (x >= 0 && cover[x]! >> 3 !== gen && upGen[x] !== gen) x = parent[x]!;
    const c = x < 0 ? -1 : cover[x]! >> 3 === gen ? (upGen[x] === -gen ? -1 : x) : up[x]!;
    for (let y = t; y !== x; y = parent[y]!) { up[y] = c; upGen[y] = gen; }
    return c;
  };

  const { offsets, neighbors } = csr;
  const incW = incidence.weight;
  const uniform = incidence.uniform;
  let entries = 0;

  // Walk only the covers whose pairs can be drawn: the kept glyphs, and the covers off-screen (every culled
  // root, and a decluttered glyph whose centre left the view). A decluttered glyph on screen is linked to
  // nothing, so a pair found only from its rows would be dropped anyway — except, in a band, inside a kept
  // split glyph, whose row sums its members' pairs.
  const offScreen = (h: number): boolean => tree.cx[h]! < view.minX || tree.cx[h]! > view.maxX || tree.cy[h]! < view.minY || tree.cy[h]! > view.maxY;
  const inKeptSplit = (c: number): boolean => {
    for (let y = parent[c]!; y >= 0; y = parent[y]!) if (upGen[y] === -gen && (cover[y]! & 7) === KEPT) return true;
    return false;
  };
  // Outside a band, a cover shallower than every kept glyph is not walked either: its row keeps only
  // partners shallower than itself, none kept, so no pair it finds is drawn (`cutRowCells`' rule, with the
  // kept glyphs — a subset of the drawn ones the worker used — as the floor).
  let floor = 0;
  if (!fading) {
    floor = Infinity;
    for (let i = 0; i < cutSet.kept.length; i++) floor = Math.min(floor, depth[cutSet.kept[i]!]!);
  }
  if (sc.walked.length < drawn.length + culled.length) sc.walked = new Uint32Array(Math.max(drawn.length + culled.length, 2 * sc.walked.length));
  const walked = sc.walked;
  let m = 0;
  for (let i = 0; i < drawn.length; i++) {
    const c = drawn[i]!;
    if (fading && upGen[c] === -gen) continue; // split: its members are the finer covers
    const kept = (cover[c]! & 7) === KEPT;
    if (kept || (depth[c]! >= floor && (offScreen(c) || (fading && inKeptSplit(c))))) walked[m++] = c;
  }
  for (let i = 0; i < culled.length; i++) if (depth[culled[i]!]! >= floor) walked[m++] = culled[i]!;
  const walkList = walked.subarray(0, m);

  // A walked cell the worker's rows do not list (its view moved since): its row from this tree's cache, or
  // computed here from its leaves — once per tree, then kept — by the worker's rule, so it serves any cut.
  // Computed by depth, so the leaf-lift memo (in `label`) serves every cell of one depth.
  if (sc.cacheTree !== tree) {
    sc.cacheTree = tree;
    sc.cacheIndex.reset();
    sc.cacheRows = 0;
    sc.cacheEnts = 0;
  } else if (sc.cacheEnts > MEMO_MAX_ENTRIES) {
    compactCache(sc, walkList);
  }
  if (sc.missing.length < m) sc.missing = new Uint32Array(Math.max(m, 2 * sc.missing.length));
  let k = 0;
  for (let i = 0; i < m; i++) {
    const c = walkList[i]!;
    if (c < n) continue; // a leaf's row is its graph edges
    if (rowOf(rows, c) >= 0 || sc.cacheIndex.find(c, c, sc.cacheCell, sc.cacheCell) >= 0) sc.hits++;
    else sc.missing[k++] = c;
  }
  if (k > 0) {
    const missing = sc.missing.subarray(0, k);
    missing.sort((a, b) => depth[a]! - depth[b]!);
    if (sc.label.length < 2 * n) sc.label = new Int32Array(2 * n);
    const label = sc.label;
    let liftDepth = -1;
    let lift = 0;
    for (let i = 0; i < k; i++) {
      const c = missing[i]!;
      const dc = depth[c]!;
      if (dc !== liftDepth) {
        liftDepth = dc;
        if (sc.liftGen <= -MAX_GEN) { label.fill(0); sc.liftGen = 0; }
        lift = --sc.liftGen;
      }
      if (sc.rowSeq === 0x7fffffff) { rowMark.fill(0); sc.rowSeq = 0; }
      const rs = ++sc.rowSeq;
      const first = sc.cacheEnts;
      for (let q = leafStart[c]!; q < leafEnd[c]!; q++) {
        const u = leafOrder[q]!;
        const p1 = offsets[u + 1]!;
        sc.visits += p1 - offsets[u]!;
        for (let p = offsets[u]!; p < p1; p++) {
          // The neighbour's node at this cell's depth (itself when shallower), memoised per leaf and depth.
          const v = neighbors[p]!;
          let t: number;
          if (label[2 * v] === lift) t = label[2 * v + 1]!;
          else {
            t = v;
            while (depth[t]! > dc) t = parent[t]!;
            label[2 * v] = lift;
            label[2 * v + 1] = t;
          }
          if (t === c) continue; // inside the cell
          let e: number;
          if (rowMark[t] === rs) e = rowSlot[t]!;
          else {
            if (sc.cacheEnts === sc.cacheNode.length) growCacheEntries(sc, sc.cacheEnts + 1);
            e = sc.cacheEnts++;
            rowMark[t] = rs;
            rowSlot[t] = e;
            sc.cacheNode[e] = t;
            sc.cacheOut[e] = 0;
            sc.cacheIn[e] = 0;
            sc.cacheDir[e] = 0;
          }
          const w = incW ? incW[p]! : uniform;
          if (incOut[p] === 1) {
            sc.cacheOut[e] = sc.cacheOut[e]! + w;
            sc.cacheDir[e] = sc.cacheDir[e]! | HAS_OUT;
          } else {
            sc.cacheIn[e] = sc.cacheIn[e]! + w;
            sc.cacheDir[e] = sc.cacheDir[e]! | HAS_IN;
          }
        }
      }
      growCacheRows(sc, sc.cacheRows + 1);
      const r = sc.cacheIndex.findOrAdd(c, c, sc.cacheRows, sc.cacheCell, sc.cacheCell);
      if (r === sc.cacheRows) sc.cacheRows++;
      sc.cacheCell[r] = c;
      sc.cacheStart[r] = first;
      sc.cacheLen[r] = sc.cacheEnts - first;
    }
    sc.misses = k;
  }

  // The walked cover's row: partner c's entry, appended on its first flow; `out` flows x → c, else c → x.
  let x = 0;
  let dx = 0;
  let seq = 0;
  const add = (c: number, w: number, out: boolean): void => {
    let e: number;
    if (rowMark[c] === seq) e = rowSlot[c]!;
    else {
      if (sc.ents === sc.entH.length) growEntries(sc, sc.ents + 1);
      e = sc.ents++;
      rowMark[c] = seq;
      rowSlot[c] = e;
      sc.entH[e] = c;
      sc.entOut[e] = 0;
      sc.entIn[e] = 0;
      sc.entDir[e] = 0;
    }
    if (out) {
      sc.entOut[e] = sc.entOut[e]! + w;
      sc.entDir[e] = sc.entDir[e]! | HAS_OUT;
    } else {
      sc.entIn[e] = sc.entIn[e]! + w;
      sc.entDir[e] = sc.entDir[e]! | HAS_IN;
    }
  };
  // Whether the walked cover keeps the pair with cover c: c strictly shallower, or at its depth with a larger id.
  const keeps = (c: number): boolean => c >= 0 && c !== x && (depth[c]! < dx || (depth[c]! === dx && x < c));
  const walk = (cov: number): void => {
    x = cov;
    dx = depth[cov]!;
    if (sc.rowSeq === 0x7fffffff) { rowMark.fill(0); sc.rowSeq = 0; }
    seq = ++sc.rowSeq;
    const start = sc.ents;
    if (cov < n) {
      // A leaf: its graph edges are its row, each resolved from the neighbour — the row's entry would be the
      // neighbour's node at this depth (or the neighbour, when shallower), whose finest cover is the
      // neighbour's when that is no deeper than the leaf, and none otherwise — so `keeps` applies as is.
      const p1 = offsets[cov + 1]!;
      entries += p1 - offsets[cov]!;
      for (let p = offsets[cov]!; p < p1; p++) {
        const c = resolve(neighbors[p]!);
        if (keeps(c)) add(c, incW ? incW[p]! : uniform, incOut[p] === 1);
      }
    } else {
      const r = rowOf(rows, cov);
      if (r >= 0) {
        const o1 = outOffset[r + 1]!;
        const i1 = inOffset[r + 1]!;
        entries += o1 - outOffset[r]! + i1 - inOffset[r]!;
        for (let e = outOffset[r]!; e < o1; e++) {
          const c = resolve(outNode[e]!);
          if (keeps(c)) add(c, outFlow[e]!, true);
        }
        for (let e = inOffset[r]!; e < i1; e++) {
          const c = resolve(inNode[e]!);
          if (keeps(c)) add(c, inFlow[e]!, false);
        }
      } else {
        const cr = sc.cacheIndex.find(cov, cov, sc.cacheCell, sc.cacheCell);
        const e0 = sc.cacheStart[cr]!;
        const e1 = e0 + sc.cacheLen[cr]!;
        entries += e1 - e0;
        for (let e = e0; e < e1; e++) {
          const c = resolve(sc.cacheNode[e]!);
          if (!keeps(c)) continue;
          const d = sc.cacheDir[e]!;
          if (d & HAS_OUT) add(c, sc.cacheOut[e]!, true);
          if (d & HAS_IN) add(c, sc.cacheIn[e]!, false);
        }
      }
    }
    growRows(sc, sc.rows + 1);
    const i = sc.rows++;
    sc.rowG[i] = cov;
    sc.rowStart[i] = start;
    sc.rowLen[i] = sc.ents - start;
  };
  for (let i = 0; i < m; i++) walk(walkList[i]!);
  sc.entries = entries;

  // Draw, by the lazy gather's rules.
  const out = sc.edges;
  let len = 0;
  let paired = 0;
  const directed = style.directed;
  const reciprocal = style.linkStyle === "half-arrow" && directed;
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
  // A kept glyph g and a cover h that is not kept: drawn from g when h is off-screen (flow `gh` from g,
  // `hg` into it, in the directions `dir` carries: HAS_OUT = g → h, HAS_IN = h → g).
  const towardOffScreen = (g: number, h: number, gh: number, hg: number, dir: number): void => {
    if (!offScreen(h)) return;
    if (!directed) push(g, h, gh + hg);
    else {
      if (dir & HAS_OUT) push(g, h, gh);
      if (dir & HAS_IN) push(h, g, hg);
    }
  };
  const swap = (dir: number): number => ((dir & HAS_OUT) << 1) | ((dir & HAS_IN) >> 1);
  for (let i = 0; i < sc.rows; i++) {
    const a = sc.rowG[i]!;
    const aKept = (cover[a]! & 7) === KEPT;
    const e1 = sc.rowStart[i]! + sc.rowLen[i]!;
    for (let e = sc.rowStart[i]!; e < e1; e++) {
      const b = sc.entH[e]!;
      const ab = sc.entOut[e]!;
      const ba = sc.entIn[e]!;
      const dir = sc.entDir[e]!;
      const bKept = (cover[b]! & 7) === KEPT;
      if (aKept && bKept) {
        if (!directed) push(a < b ? a : b, a < b ? b : a, ab + ba);
        else {
          if (dir & HAS_OUT) { push(a, b, ab); if (reciprocal) pairLast(); }
          if (dir & HAS_IN) { push(b, a, ba); if (reciprocal) pairLast(); }
        }
      } else if (aKept) {
        towardOffScreen(a, b, ab, ba, dir);
      } else if (bKept) {
        towardOffScreen(b, a, ba, ab, swap(dir));
      }
    }
  }

  // A cross-fade band: a kept glyph the band splits (drawn over its expanded members) draws, as the lazy
  // gather's row of it does, its members' pairs toward the finest covers outside it — summed per cover.
  if (fading) {
    const agg = sc.aggIndex;
    agg.reset();
    let aggs = 0;
    const addAgg = (s: number, h: number, sh: number, hs: number, dir: number): void => {
      growAggregates(sc, aggs + 1);
      const r = agg.findOrAdd(s, h, aggs, sc.aggS, sc.aggH);
      if (r === aggs) {
        sc.aggS[r] = s;
        sc.aggH[r] = h;
        sc.aggOut[r] = 0;
        sc.aggIn[r] = 0;
        sc.aggDir[r] = 0;
        aggs++;
      }
      sc.aggOut[r] = sc.aggOut[r]! + sh;
      sc.aggIn[r] = sc.aggIn[r]! + hs;
      sc.aggDir[r] = sc.aggDir[r]! | dir;
    };
    // Every kept split glyph above cover c that does not also hold cover h.
    const lift = (c: number, h: number, ch: number, hc: number, dir: number): void => {
      const r = leafStart[h]!;
      for (let y = parent[c]!; y >= 0; y = parent[y]!) {
        if (upGen[y] !== -gen || (cover[y]! & 7) !== KEPT) continue;
        if (r >= leafStart[y]! && r < leafEnd[y]!) continue;
        addAgg(y, h, ch, hc, dir);
      }
    };
    for (let i = 0; i < sc.rows; i++) {
      const a = sc.rowG[i]!;
      const e1 = sc.rowStart[i]! + sc.rowLen[i]!;
      for (let e = sc.rowStart[i]!; e < e1; e++) {
        const b = sc.entH[e]!;
        const dir = sc.entDir[e]!;
        lift(a, b, sc.entOut[e]!, sc.entIn[e]!, dir);
        lift(b, a, sc.entIn[e]!, sc.entOut[e]!, swap(dir));
      }
    }
    for (let r = 0; r < aggs; r++) {
      const g = sc.aggS[r]!;
      const h = sc.aggH[r]!;
      const gh = sc.aggOut[r]!;
      const hg = sc.aggIn[r]!;
      const dir = sc.aggDir[r]!;
      if ((cover[h]! & 7) === KEPT) {
        // Only from the split glyph's side: the other glyph's members resolve to its finer covers.
        if (!directed) { if (g < h) push(g, h, gh + hg); }
        else if (dir & HAS_OUT) { push(g, h, gh); if (reciprocal) pairLast(); }
      } else {
        towardOffScreen(g, h, gh, hg, dir);
      }
    }
  }
  return superEdgeBatches(tree, out, len, paired, style, cover, stamp | KEPT, null);
}
