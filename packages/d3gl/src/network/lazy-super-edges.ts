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
 *
 * A tree a layout streamed can carry the **rows its worker built** for the glyphs it kept at the main thread's
 * view (#433, `tree.rows`, see `spatial-rows.ts`): a kept glyph the memo cannot answer takes its row from
 * there — each partner resolved to the cover of this cut at or above it — before any leaf is walked, and a
 * kept leaf reads its own graph edges. Only a glyph those rows cannot serve (the view moved since the worker
 * cut) walks its leaves.
 */
import type { CSR, NetworkGraph } from "./graph.js";
import type { LODTree } from "./lod.js";
import { PairIndex } from "./pair-index.js";
import { incidenceArrays, rowOf, type IncidenceArrays, type SpatialRows } from "./spatial-rows.js";
import { makeSuperEdgesScratch, superEdgeBatches, type SuperEdgeStyleResolved, type SuperEdgesData, type SuperEdgesScratch } from "./glyphs.js";

/**
 * Per-incidence weight and direction for the graph's undirected CSR (#343), parallel to
 * `graph.csr.neighbors`: what the lazy gather needs to sum flow per pair. Built once per graph (and
 * direction mode), O(edges).
 */
export interface LeafIncidence extends IncidenceArrays {
  /** The graph it was built for (a cache key: a new graph needs a new incidence). */
  graph: NetworkGraph;
  /** Whether it keeps edge direction (`out` is set): the gather reads the direction only for a directed style. */
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
/** A kept leaf's row with nothing to gather (#447: every neighbour a kept leaf): no memo row, no pairs. */
const EMPTY_ROW = -2;
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
  /** Last call: rows answered from the memo, rows rebuilt from leaves, graph incidences walked to rebuild them,
   *  and leaves labelled with their cover (only when a row was rebuilt — 0 on a held view). */
  hits: number;
  misses: number;
  visits: number;
  labelled: number;
  /** Last call: the rows its worker built with a streamed tree (#433) that answered a kept glyph, and their
   *  entries plus the graph edges of the kept leaves read with them (0 without `tree.rows`). */
  imported: number;
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
    imported: 0,
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
  for (let i = 0; i < drawn.length; i++) cover[drawn[i] ?? 0] = stamp | DROPPED;
  for (let i = 0; i < kept.length; i++) cover[kept[i] ?? 0] = stamp | KEPT;
  for (let i = 0; i < culled.length; i++) cover[culled[i] ?? 0] = stamp | CULLED;
  for (let i = 0; i < split.length; i++) upGen[split[i] ?? 0] = -gen;
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
 * Per call: O(drawn + culled) to stamp the covers and O(kept + memoised rows' length) to check the memo.
 * A kept glyph the memo cannot answer takes, on a tree a layout streamed with its rows (#433, `tree.rows`),
 * its worker-built row — O(row length + log cells) plus the climbs of partners this cut coarsened — or, for a
 * kept leaf, its graph edges: O(degree). Only then, if some row still missed, O(leaves under the frontier) to
 * label them, and per missed glyph O(Σ degree of its leaves) plus the climbs. A held view costs the first two
 * terms alone; a streamed repaint at the view its rows were built for, the first three. Needs
 * `tree.leafOrder`/`leafStart`/`leafEnd` and `tree.parent`; returns `{ ids: [] }` without them.
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
  const { leafOrder, leafStart, leafEnd, parent, rows } = tree;
  const sc = scratch;
  sc.hits = 0;
  sc.misses = 0;
  sc.visits = 0;
  sc.labelled = 0;
  sc.imported = 0;
  sc.entries = 0;
  if (!leafOrder || !leafStart || !leafEnd || !parent) return { ids: [] };

  if (sc.rowMark.length < tree.size) {
    sc.rowMark = new Int32Array(tree.size);
    sc.rowSlot = new Int32Array(tree.size);
  }
  // Cover roles: O(drawn + culled). Leaves are labelled with their cover only if a row must be rebuilt.
  const gen = stampCovers(sc, tree.size, cutSet);
  const stamp = gen << 3;
  const cover = sc.cover;
  const up = sc.up;
  const upGen = sc.upGen;
  const { drawn, kept, culled } = cutSet;
  const fading = cutSet.split.length > 0;
  const n = tree.leafCount;

  // The row memo belongs to one tree and one incidence (weights + direction); start over otherwise.
  if (sc.memoTree !== tree || sc.memoIncidence !== incidence) {
    sc.memoTree = tree;
    sc.memoIncidence = incidence;
    sc.rowIndex.reset();
    sc.rows = 0;
    sc.ents = 0;
  }

  const { offsets, neighbors } = csr;
  const incW = incidence.weight;
  // Direction only for a directed style: an undirected gather sums every incidence as the glyph's own.
  const incOut = style.directed ? incidence.out : null;
  const directed = incOut !== null;
  const uniform = incidence.uniform;
  const rowIndex = sc.rowIndex;
  const rowMark = sc.rowMark;
  const rowSlot = sc.rowSlot;

  // A memoised row is valid while every cover it names is still a cover, and not split.
  const rowValid = (row: number): boolean => {
    const e0 = sc.rowStart[row] ?? 0;
    const e1 = e0 + (sc.rowLen[row] ?? 0);
    for (let e = e0; e < e1; e++) {
      const h = sc.entH[e] ?? 0;
      if ((cover[h] ?? 0) >> 3 !== gen || upGen[h] === -gen) return false;
    }
    return true;
  };

  // Whether cover h is nested in or around glyph g (their leaf runs overlap) — a pair a band never draws.
  const nested = (g: number, h: number): boolean => (leafStart[h] ?? 0) < (leafEnd[g] ?? 0) && (leafStart[g] ?? 0) < (leafEnd[h] ?? 0);

  // Row building at the end of the entry arena: open a row, add flow toward a cover (appending its entry on
  // its first flow; `out` flows out of the glyph), then close it as glyph g's memo row.
  let seq = 0;
  let start = 0;
  const open = (): void => {
    if (sc.rowSeq === 0x7fffffff) { rowMark.fill(0); sc.rowSeq = 0; }
    seq = ++sc.rowSeq;
    start = sc.ents;
  };
  const add = (h: number, w: number, out: boolean): void => {
    let e: number;
    if (rowMark[h] === seq) e = rowSlot[h] ?? 0;
    else {
      if (sc.ents === sc.entH.length) growEntries(sc, sc.ents + 1);
      e = sc.ents++;
      rowMark[h] = seq;
      rowSlot[h] = e;
      sc.entH[e] = h;
      sc.entOut[e] = 0;
      sc.entIn[e] = 0;
      sc.entDir[e] = 0;
    }
    if (out) {
      sc.entOut[e] = (sc.entOut[e] ?? 0) + w;
      sc.entDir[e] = (sc.entDir[e] ?? 0) | HAS_OUT;
    } else {
      sc.entIn[e] = (sc.entIn[e] ?? 0) + w;
      sc.entDir[e] = (sc.entDir[e] ?? 0) | HAS_IN;
    }
  };
  const close = (g: number): number => {
    growRows(sc, sc.rows + 1);
    const row = rowIndex.findOrAdd(g, g, sc.rows, sc.rowG, sc.rowG);
    if (row === sc.rows) {
      sc.rowG[row] = g;
      sc.rows++;
    }
    sc.rowStart[row] = start;
    sc.rowLen[row] = sc.ents - start;
    return row;
  };

  // The finest cover at or above node t — a drawn glyph the band does not split, or a culled root — or −1 when
  // t lies above the covers (this cut opened it up). Memoised with path compression over the climbed chain in
  // `up` (only touched nodes are written; a split glyph's `−gen` mark sits on a stamped node, never written).
  const resolve = (t: number): number => {
    let x = t;
    while (x >= 0 && (cover[x] ?? 0) >> 3 !== gen && upGen[x] !== gen) x = parent[x] ?? -1;
    const c = x < 0 ? -1 : (cover[x] ?? 0) >> 3 === gen ? (upGen[x] === -gen ? -1 : x) : (up[x] ?? -1);
    for (let y = t; y !== x; y = parent[y] ?? -1) { up[y] = c; upGen[y] = gen; }
    return c;
  };

  // Kept glyph g's row from what the streaming worker built with the tree (#433): a cell's stored row, each
  // partner resolved to its cover in this cut (merged where this cut coarsened several), or a leaf's graph
  // edges. −1 when the rows cannot serve it: a cell they do not list, or a partner this cut opened up.
  // Without `style.leafLinks` no cover matches −1 (stamps are ≥ 0), so every neighbour is resolved as before.
  const keptStamp = style.leafLinks === true ? stamp | KEPT : -1;
  // Kept leaf g's row from its own graph edges. With `style.leafLinks` (#447) its links to other kept leaves are
  // not gathered — the engine draws them as the full-detail path does (`withLeafLinks` in glyphs.ts) — so a
  // neighbour that is itself a kept leaf is skipped before it is resolved (one read), and the row holds the flow
  // toward aggregates and covers off the kept set only; such a row is built fresh on every call (O(degree)),
  // never taken from the memo, since which neighbours it skips depends on the cut and a memo row names only the
  // covers it holds.
  const leafRow = (g: number): number => {
    const p0 = offsets[g] ?? 0;
    const p1 = offsets[g + 1] ?? 0;
    sc.entries += p1 - p0;
    // Every neighbour a kept leaf (the all-leaves view): nothing to gather, and no row to register.
    let p = p0;
    while (p < p1 && cover[neighbors[p] ?? 0] === keptStamp) p++;
    if (p === p1) return EMPTY_ROW;
    open();
    for (; p < p1; p++) {
      const v = neighbors[p] ?? 0;
      if (cover[v] === keptStamp) continue;
      const h = resolve(v);
      if (h === g || h < 0 || (fading && nested(g, h))) continue;
      add(h, incW ? (incW[p] ?? 0) : uniform, !incOut || incOut[p] === 1);
    }
    return close(g);
  };

  const streamedRow = (stored: SpatialRows, g: number): number => {
    if (g < n) return leafRow(g);
    open();
    const r = rowOf(stored, g);
    if (r < 0) return -1;
    const { outOffset, outNode, outFlow, inOffset, inNode, inFlow } = stored;
    const o0 = outOffset[r] ?? 0;
    const o1 = outOffset[r + 1] ?? 0;
    const i0 = inOffset[r] ?? 0;
    const i1 = inOffset[r + 1] ?? 0;
    sc.entries += o1 - o0 + i1 - i0;
    for (let e = o0; e < o1; e++) {
      const h = resolve(outNode[e] ?? 0);
      if (h < 0 || h === g || (fading && nested(g, h))) { sc.ents = start; return -1; }
      add(h, outFlow[e] ?? 0, true);
    }
    for (let e = i0; e < i1; e++) {
      const h = resolve(inNode[e] ?? 0);
      if (h < 0 || h === g || (fading && nested(g, h))) { sc.ents = start; return -1; }
      add(h, inFlow[e] ?? 0, !directed);
    }
    sc.imported++;
    return close(g);
  };

  // Each kept glyph's row, before any leaf is labelled: from the memo (a held view: every row valid, so it
  // costs O(kept + rows' length), not O(leaves under the frontier)), else from a streamed tree's rows.
  if (sc.keptRow.length < kept.length) sc.keptRow = new Int32Array(Math.max(kept.length, 2 * sc.keptRow.length));
  const keptRow = sc.keptRow;
  let rebuild = false;
  for (let i = 0; i < kept.length; i++) {
    const g = kept[i] ?? 0;
    if (g < n && keptStamp >= 0) {
      keptRow[i] = leafRow(g);
      continue;
    }
    let row = rowIndex.find(g, g, sc.rowG, sc.rowG);
    if (row >= 0 && rowValid(row)) sc.hits++;
    else row = rows ? streamedRow(rows, g) : -1;
    keptRow[i] = row;
    if (row < 0) rebuild = true;
  }
  // Each leaf's cover label (8 B per leaf, allocated only once a row is rebuilt from leaves).
  if (rebuild && sc.label.length < 2 * n) sc.label = new Int32Array(2 * n);
  const label = sc.label;
  if (rebuild) {
    // Label the drawn covers' leaves. The frontier lists a split node before the nodes below it, so the
    // finest drawn cover of a leaf is written last.
    let labelled = 0;
    for (let i = 0; i < drawn.length; i++) {
      const x = drawn[i] ?? 0;
      const r1 = leafEnd[x] ?? 0;
      labelled += r1 - (leafStart[x] ?? 0);
      for (let r = leafStart[x] ?? 0; r < r1; r++) {
        const v = leafOrder[r] ?? 0;
        label[2 * v] = gen;
        label[2 * v + 1] = x;
      }
    }
    if (fading) {
      // A culled root under a split node (the only drawn cover with anything culled below it) is the finer
      // cover of its leaves: label them after the drawn ones. O(depth) per culled root, in a band only.
      for (let i = 0; i < culled.length; i++) {
        const c = culled[i] ?? 0;
        for (let x = parent[c] ?? -1; x >= 0; x = parent[x] ?? -1) {
          if ((cover[x] ?? 0) >> 3 !== gen) continue;
          const r1 = leafEnd[c] ?? 0;
          labelled += r1 - (leafStart[c] ?? 0);
          for (let r = leafStart[c] ?? 0; r < r1; r++) {
            const v = leafOrder[r] ?? 0;
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
    const own = cover[v];
    if (own !== undefined && own >> 3 === gen) {
      // A culled leaf (an off-screen member of an expanded cell) is its own cover.
      label[2 * v] = gen;
      label[2 * v + 1] = v;
      return v;
    }
    let x = parent[v] ?? -1;
    while (x >= 0 && (cover[x] ?? 0) >> 3 !== gen && upGen[x] !== gen) x = parent[x] ?? -1;
    const c = x < 0 ? -1 : (cover[x] ?? 0) >> 3 === gen ? x : (up[x] ?? -1);
    label[2 * v] = gen;
    label[2 * v + 1] = c;
    for (let y = parent[v] ?? -1; y !== x; y = parent[y] ?? -1) { up[y] = c; upGen[y] = gen; }
    return c;
  };

  // Build g's row from its leaves' graph edges at the end of the entry arena; returns its row id. The arena
  // is held in locals over the walk (the hot loop), and written back when it grows and at the end.
  const buildRow = (g: number): number => {
    open();
    let ents = start;
    let entH = sc.entH;
    let entOut = sc.entOut;
    let entIn = sc.entIn;
    let entDir = sc.entDir;
    let visits = 0;
    const g0 = leafStart[g] ?? 0;
    const g1 = leafEnd[g] ?? 0;
    for (let r = g0; r < g1; r++) {
      const u = leafOrder[r] ?? 0;
      const p1 = offsets[u + 1] ?? 0;
      visits += p1 - (offsets[u] ?? 0);
      for (let p = offsets[u] ?? 0; p < p1; p++) {
        const v = neighbors[p] ?? 0;
        const h = label[2 * v] === gen ? (label[2 * v + 1] ?? -1) : climb(v);
        // Not a pair with itself — nor, in a fade band, with a cover nested in or around it.
        if (h === g || h < 0 || (fading && (leafStart[h] ?? 0) < g1 && g0 < (leafEnd[h] ?? 0))) continue;
        let e: number;
        if (rowMark[h] === seq) e = rowSlot[h] ?? 0;
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
        const w = incW ? (incW[p] ?? 0) : uniform;
        if (!incOut || incOut[p] === 1) {
          entOut[e] = (entOut[e] ?? 0) + w;
          entDir[e] = (entDir[e] ?? 0) | HAS_OUT;
        } else {
          entIn[e] = (entIn[e] ?? 0) + w;
          entDir[e] = (entDir[e] ?? 0) | HAS_IN;
        }
      }
    }
    sc.ents = ents;
    sc.visits += visits;
    return close(g);
  };

  const out = sc.edges;
  let len = 0;
  let paired = 0;
  const reciprocal = style.linkStyle === "half-arrow" && style.directed;
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
  const offScreen = (h: number): boolean => {
    const x = tree.cx[h] ?? 0;
    const y = tree.cy[h] ?? 0;
    return x < view.minX || x > view.maxX || y < view.minY || y > view.maxY;
  };

  for (let i = 0; i < kept.length; i++) {
    const g = kept[i] ?? 0;
    let row = keptRow[i] ?? -1;
    if (row === EMPTY_ROW) continue;
    if (row < 0) {
      row = buildRow(g);
      sc.misses++;
    }
    const e0 = sc.rowStart[row] ?? 0;
    const e1 = e0 + (sc.rowLen[row] ?? 0);
    for (let e = e0; e < e1; e++) {
      const h = sc.entH[e] ?? 0;
      const role = (cover[h] ?? 0) & 7;
      const dir = sc.entDir[e] ?? 0;
      if (role === KEPT) {
        // Both drawn: a directed pair from its source's row; an undirected one once, from its lower id.
        if (directed) {
          if (dir & HAS_OUT) {
            push(g, h, sc.entOut[e] ?? 0);
            if (reciprocal) pairLast();
          }
        } else if (g < h) {
          push(g, h, sc.entOut[e] ?? 0);
        }
      } else if (offScreen(h)) {
        // Toward an off-screen cover (culled, or a glyph at the edge declutter dropped): drawn from g.
        if (dir & HAS_OUT) push(g, h, sc.entOut[e] ?? 0);
        if (dir & HAS_IN) push(h, g, sc.entIn[e] ?? 0);
      }
      // else: a decluttered glyph on screen — skipped, as by the CSR gather.
    }
  }
  // Rebuilt rows append, so the arena grows as the view moves: past its bound, keep only this frame's rows.
  if (sc.ents > MEMO_MAX_ENTRIES) compactRows(sc, kept);
  return superEdgeBatches(tree, out, len, paired, style, cover, stamp | KEPT, null);
}
