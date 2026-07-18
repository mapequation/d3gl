/**
 * No-LOD label candidate gathering (#212): the in-view node-id set `refreshLabels` ranks and
 * places when the full graph is drawn (no LOD tree). The naive path scans all `nodeCount`
 * positions on every pan/zoom frame; this module makes the settled steady state O(visible):
 *
 * - **Positions moving** (layout streaming, node drag — the caller marks {@link CandidateSource}
 *   `stale`): fall back to the plain O(N) scan. Those frames already pay O(N) to move the
 *   positions, and any index built now would be outdated by the next frame — building one would
 *   only *add* per-frame cost.
 * - **Positions settled** (user pan/zoom): build a coarse uniform grid ONCE — on the first
 *   refresh after the positions stop moving, never per frame — then answer each frame's in-view
 *   query in O(covered cells + nodes in them) ≈ O(visible).
 *
 * Output-equality contract: for the same positions + rect, {@link gatherCandidates} yields
 * exactly the id set the reference scan yields. Order: the scan path is ascending by id (the
 * reference order); the grid path is per-cell ascending — call {@link CandidateList.sortAscending}
 * when the consumer is order-sensitive (the un-capped anchor loop). The capped top-`max` path is
 * order-insensitive: {@link descendingByKey} imposes the *total* order (key desc, ties id asc)
 * that the old stable full sort produced from an id-ascending array, so any input permutation
 * pops the identical sequence.
 */

/** The visible world rectangle (from `visibleWorldRect`); membership is the closed test
 *  `minX <= x <= maxX && minY <= y <= maxY`, matching the scan the grid replaces. */
export interface WorldRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Target average nodes per grid cell: `cols = rows = ceil(sqrt(n / λ))` → ≈n/λ cells,
 *  so cell iteration stays a fraction of the node work it prunes. */
const NODES_PER_CELL = 4;
/** Below this many gathered ids, insertion sort beats radix (whose 2×64Ki histogram clears
 *  would dominate a tiny input). */
const INSERTION_SORT_MAX = 256;
const RADIX_BUCKETS = 0x10000; // 16-bit digits, 2 LSD passes cover the Uint32 id range

/**
 * Coarse uniform grid over node positions, CSR layout: `ids` holds all node ids cell-major,
 * ascending within each cell (filled by one id-ascending pass); `cellStart[c]..cellStart[c+1]`
 * is cell `c`'s slice. Built from a *snapshot* of the positions buffer — the caller invalidates
 * it (drops the grid) whenever positions may have moved.
 */
export interface CandidateGrid {
  /** The positions buffer the grid indexes (identity-checked by the caller for staleness). */
  readonly positions: Float32Array;
  readonly nodeCount: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minY: number;
  /** 1 / cell width|height (multiply, don't divide, in the hot per-node cell computation). */
  readonly invW: number;
  readonly invH: number;
  readonly cellStart: Uint32Array; // length cols*rows + 1
  readonly ids: Uint32Array; // length nodeCount
}

/** Clamp a (possibly non-finite) cell coordinate into `[0, max]`. A NaN position falls into
 *  bucket 0 — harmless, since it can never pass the in-view test at query time (the reference
 *  scan excludes it the same way). */
function clampCell(v: number, max: number): number {
  const c = Math.floor(v);
  if (!(c >= 0)) return 0; // negative or NaN
  return c > max ? max : c;
}

/** Build the uniform grid over `positions[0 .. 2*nodeCount)`. O(nodeCount + cells) — run at most
 *  once per position change (on the first settled refresh), never per frame. */
export function buildCandidateGrid(positions: Float32Array, nodeCount: number): CandidateGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nodeCount; i++) {
    const x = positions[2 * i]!;
    const y = positions[2 * i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Degenerate spans (0 or 1 node, all-coincident, or all-NaN positions) collapse to one cell.
  const degenerate = !(maxX > minX) || !(maxY > minY);
  const side = degenerate ? 1 : Math.max(1, Math.ceil(Math.sqrt(nodeCount / NODES_PER_CELL)));
  const cols = side;
  const rows = side;
  if (degenerate) {
    minX = Number.isFinite(minX) ? minX : 0;
    minY = Number.isFinite(minY) ? minY : 0;
    maxX = minX + 1;
    maxY = minY + 1;
  }
  const invW = cols / (maxX - minX);
  const invH = rows / (maxY - minY);

  const cells = cols * rows;
  const cellStart = new Uint32Array(cells + 1);
  // Count into cellStart[cell + 1], prefix-sum, then fill with a cursor copy — classic CSR build.
  for (let i = 0; i < nodeCount; i++) {
    const cx = clampCell((positions[2 * i]! - minX) * invW, cols - 1);
    const cy = clampCell((positions[2 * i + 1]! - minY) * invH, rows - 1);
    const c = cy * cols + cx + 1;
    cellStart[c] = cellStart[c]! + 1;
  }
  for (let c = 1; c <= cells; c++) cellStart[c] = cellStart[c]! + cellStart[c - 1]!;
  const ids = new Uint32Array(nodeCount);
  const cursor = cellStart.slice(0, cells); // transient O(cells), freed after the build
  for (let i = 0; i < nodeCount; i++) {
    const cx = clampCell((positions[2 * i]! - minX) * invW, cols - 1);
    const cy = clampCell((positions[2 * i + 1]! - minY) * invH, rows - 1);
    ids[cursor[cy * cols + cx]!++] = i;
  }
  return { positions, nodeCount, cols, rows, minX, minY, invW, invH, cellStart, ids };
}

/**
 * Reusable candidate id list — retained typed buffers (grow-doubling), so the per-frame gather
 * allocates nothing in the steady state (the old path grew a fresh boxed `number[]` per frame).
 */
export class CandidateList {
  ids: Uint32Array = new Uint32Array(0);
  length = 0;
  /** Which path filled the list last — the deterministic signature tests key on this. */
  lastPath: "scan" | "grid" = "scan";
  /** Nodes examined by the last gather (grid: nodes in covered cells; scan: nodeCount) —
   *  the "touched-node counter" the per-frame regression guard bounds. */
  lastTested = 0;
  private aux: Uint32Array = new Uint32Array(0); // radix scatter target
  private hist: Uint32Array = new Uint32Array(0); // radix histogram (64Ki buckets)
  private keys: Float64Array = new Float64Array(0); // importance keys for descendingByKey

  clear(): void {
    this.length = 0;
  }

  push(id: number): void {
    if (this.length === this.ids.length) {
      const grown = new Uint32Array(Math.max(64, this.ids.length * 2));
      grown.set(this.ids);
      this.ids = grown;
    }
    this.ids[this.length++] = id;
  }

  /** Retained key scratch sized to the current candidate count (for {@link descendingByKey}). */
  keysFor(length: number): Float64Array {
    if (this.keys.length < length) this.keys = new Float64Array(Math.max(64, length, this.keys.length * 2));
    return this.keys;
  }

  /** Sort the gathered ids ascending in place — restores the reference (scan) order after a grid
   *  gather when the consumer is order-sensitive. O(length) radix (2×16-bit LSD passes) above a
   *  small insertion-sorted cutoff; uses retained scratch, no steady-state allocation. */
  sortAscending(): void {
    const n = this.length;
    const ids = this.ids;
    if (n <= INSERTION_SORT_MAX) {
      for (let i = 1; i < n; i++) {
        const v = ids[i]!;
        let j = i - 1;
        while (j >= 0 && ids[j]! > v) {
          ids[j + 1] = ids[j]!;
          j--;
        }
        ids[j + 1] = v;
      }
      return;
    }
    if (this.aux.length < n) this.aux = new Uint32Array(Math.max(n, this.aux.length * 2));
    if (this.hist.length === 0) this.hist = new Uint32Array(RADIX_BUCKETS);
    const aux = this.aux;
    const hist = this.hist;
    // Pass 1: low 16 bits, ids → aux.
    hist.fill(0);
    for (let i = 0; i < n; i++) { const b = ids[i]! & 0xffff; hist[b] = hist[b]! + 1; }
    for (let b = 1; b < RADIX_BUCKETS; b++) hist[b] = hist[b]! + hist[b - 1]!;
    for (let i = n - 1; i >= 0; i--) aux[--hist[ids[i]! & 0xffff]!] = ids[i]!;
    // Pass 2: high 16 bits, aux → ids.
    hist.fill(0);
    for (let i = 0; i < n; i++) { const b = aux[i]! >>> 16; hist[b] = hist[b]! + 1; }
    for (let b = 1; b < RADIX_BUCKETS; b++) hist[b] = hist[b]! + hist[b - 1]!;
    for (let i = n - 1; i >= 0; i--) ids[--hist[aux[i]! >>> 16]!] = aux[i]!;
  }
}

/** Reference gather: scan every node against the closed in-view test. O(nodeCount); ascending by
 *  id. Used while positions are moving (and as the equality reference in tests). */
export function scanCandidates(positions: Float32Array, nodeCount: number, rect: WorldRect, out: CandidateList): void {
  out.clear();
  out.lastPath = "scan";
  out.lastTested = nodeCount;
  const { minX, maxX, minY, maxY } = rect;
  for (let i = 0; i < nodeCount; i++) {
    const x = positions[2 * i]!;
    const y = positions[2 * i + 1]!;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(i);
  }
}

/** Grid gather: walk only the cells the rect covers, testing each contained node against the same
 *  closed in-view predicate as the scan (border cells hold out-of-rect nodes; interior nodes all
 *  pass). O(covered cells + nodes in them). Output is per-cell ascending, NOT globally ascending —
 *  returns `false` so order-sensitive consumers know to {@link CandidateList.sortAscending}. */
export function gridCandidates(grid: CandidateGrid, rect: WorldRect, out: CandidateList): boolean {
  out.clear();
  out.lastPath = "grid";
  out.lastTested = 0;
  const { positions, cols, rows, cellStart, ids } = grid;
  const { minX, maxX, minY, maxY } = rect;
  // Covered cell range (unclamped first, to detect a rect fully outside the grid).
  const rx0 = Math.floor((minX - grid.minX) * grid.invW);
  const rx1 = Math.floor((maxX - grid.minX) * grid.invW);
  const ry0 = Math.floor((minY - grid.minY) * grid.invH);
  const ry1 = Math.floor((maxY - grid.minY) * grid.invH);
  if (!(rx1 >= 0) || !(ry1 >= 0) || rx0 >= cols || ry0 >= rows) return false; // no overlap (NaN-safe)
  const x0 = rx0 > 0 ? rx0 : 0;
  const y0 = ry0 > 0 ? ry0 : 0;
  const x1 = rx1 < cols - 1 ? rx1 : cols - 1;
  const y1 = ry1 < rows - 1 ? ry1 : rows - 1;
  let tested = 0;
  for (let cy = y0; cy <= y1; cy++) {
    const rowBase = cy * cols;
    // Covered cells in a row are contiguous in the CSR: one slice per row.
    const from = cellStart[rowBase + x0]!;
    const to = cellStart[rowBase + x1 + 1]!;
    tested += to - from;
    for (let p = from; p < to; p++) {
      const id = ids[p]!;
      const x = positions[2 * id]!;
      const y = positions[2 * id + 1]!;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(id);
    }
  }
  out.lastTested = tested;
  return false;
}

/**
 * The gather protocol state a caller owns per graph: the lazily-built grid + the staleness flag
 * the caller raises whenever positions may have moved (every position-mutating repaint).
 */
export interface CandidateSource {
  grid: CandidateGrid | null;
  /** Positions may have moved since the last gather → the next gather scans (and drops the grid). */
  stale: boolean;
}

/**
 * Gather the in-view candidate ids for one label refresh. Stale positions → plain scan (the
 * streaming/drag path — no index work on frames that already move O(N) positions); settled →
 * grid query, (re)building the grid at most once per position change. Returns `true` when the
 * output is ascending by id (the scan path), `false` when order-sensitive consumers must
 * {@link CandidateList.sortAscending} first.
 */
export function gatherCandidates(
  src: CandidateSource,
  positions: Float32Array,
  nodeCount: number,
  rect: WorldRect,
  out: CandidateList,
): boolean {
  if (src.stale) {
    src.grid = null; // any grid indexes the old coordinates
    src.stale = false; // stable from here until the caller raises it again
    scanCandidates(positions, nodeCount, rect, out);
    return true;
  }
  let grid = src.grid;
  if (!grid || grid.positions !== positions || grid.nodeCount !== nodeCount) {
    grid = src.grid = buildCandidateGrid(positions, nodeCount); // once per position change
  }
  return gridCandidates(grid, rect, out);
}

/**
 * Lazy exact top-k order over the gathered candidates: pops ids by importance key **descending,
 * ties by ascending id** — precisely the order the replaced `cand.sort((a, b) => key(b) - key(a))`
 * (a stable sort over an id-ascending array) produced, but O(length) to build (Floyd heapify) and
 * O(log length) per pop, so a capped selection stops after ~`max` pops instead of paying a full
 * O(V log V) comparator sort of the whole viewport. Permutes `ids`/`keys` in place (they are
 * per-refresh scratch). Returns a pop function yielding -1 when exhausted.
 */
export function descendingByKey(ids: Uint32Array, keys: Float64Array, length: number): () => number {
  // `a` outranks `b` when its key is larger, or keys tie (incl. both NaN — matching the old
  // comparator, where a NaN difference sorts as equal) and its id is smaller.
  const outranks = (ka: number, ia: number, kb: number, ib: number): boolean =>
    ka > kb || (!(ka < kb) && !(kb < ka) && ia < ib);
  const siftDown = (i: number, size: number): void => {
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) return;
      const r = l + 1;
      let top = l;
      if (r < size && outranks(keys[r]!, ids[r]!, keys[l]!, ids[l]!)) top = r;
      if (outranks(keys[i]!, ids[i]!, keys[top]!, ids[top]!)) return;
      const ki = keys[i]!;
      const ii = ids[i]!;
      keys[i] = keys[top]!;
      ids[i] = ids[top]!;
      keys[top] = ki;
      ids[top] = ii;
      i = top;
    }
  };
  for (let i = (length >> 1) - 1; i >= 0; i--) siftDown(i, length);
  let size = length;
  return () => {
    if (size === 0) return -1;
    const top = ids[0]!;
    size--;
    keys[0] = keys[size]!;
    ids[0] = ids[size]!;
    siftDown(0, size);
    return top;
  };
}
