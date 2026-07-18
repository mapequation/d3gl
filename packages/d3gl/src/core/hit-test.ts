import type { DrawableVector } from "./scene.js";
import type { ViewTransform } from "./backend.js";
import { groupRings, pointInRing, type RingGroup } from "./rings.js";
import type { Subpath } from "./path-context.js";

interface Entry {
  id: string | number;
  minX: number; minY: number; maxX: number; maxY: number;
  filled: boolean;          // has >=1 closed subpath with area
  rings: RingGroup[];       // for filled (outer/holes are Subpath objects)
  strokes: Subpath[];       // for stroke hit-test
  halfWidth: number;
  circles: { x: number; y: number; r: number }[];
  tolerance: number;
  /** Reference anchor in world coords, used only in screen sizeMode: the point the backend
   *  projects with the view transform while drawing the rest of the geometry at constant px
   *  offsets around it. See pick(). */
  anchor: [number, number];
}

/** Uniform spatial grid over the entries (#216), so pick() visits only a small neighbourhood
 *  instead of scanning all N entries per pointer event. Cells hold intrusive linked lists in
 *  a shared ref pool (no per-cell allocation); pushing entries in ascending index order makes
 *  every per-cell chain iterate DESCENDING — i.e. topmost-first for free.
 *
 *  Indexing space (transform-independent, so the grid never rebuilds on pan/zoom):
 *  - world mode: each entry covers the cells of its halfWidth-inflated bbox (halfWidth =
 *    lineWidth/2 + tolerance, the exact inflation test() applies, and ≥ the circles' tolerance
 *    inflation) — so a pick, after inverting the transform once, reads a SINGLE cell.
 *  - screen mode: geometry is drawn at constant px offsets around a projected anchor, so bboxes
 *    only exist per entry-frame; the anchors themselves are transform-independent. Each entry
 *    indexes its anchor point (one cell) and the query scans the cell range of
 *    [w ± maxReach/t.k], where maxReach is the largest px reach of any entry from its anchor —
 *    the exact anchor window a hit requires (see pick()).
 */
interface Grid {
  x0: number; y0: number;   // origin of cell (0,0) in the indexing space
  cell: number;             // cell size (world units)
  cols: number; rows: number;
  head: Int32Array;         // per-cell head into the ref pool, -1 = empty
  refEntry: Int32Array;     // ref pool: entry index …
  refNext: Int32Array;      // … and next ref in the cell chain (-1 = end)
  refCount: number;
  /** Entries whose inflated bbox spans more than SPAN_CAP cells (world mode only): checked on
   *  every pick, merged topmost-first with the cell chain. Keeps the per-entry insert cost
   *  bounded; a layer of few huge polygons degrades gracefully toward the old linear scan. */
  overflow: number[];
  builtCount: number;       // entries.length when the grid was (re)built — doubling-rebuild rule
  maxReach: number;         // screen mode: max px distance from any anchor to its inflated bbox
}

/** Max cells an entry may cover before it goes to the overflow list. */
const SPAN_CAP = 64;
/** Max grid dimension per axis (caps grid memory at ~1M cells / 4 MB of heads). */
const MAX_DIM = 1024;

function bounds(subpaths: Subpath[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of subpaths)
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i]!, y = s.points[i + 1]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  return [minX, minY, maxX, maxY];
}

function distToSegments(px: number, py: number, pts: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!, ay = pts[i + 1]!, bx = pts[i + 2]!, by = pts[i + 3]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best) best = d;
  }
  return best;
}

export class HitIndex {
  private entries: Entry[] = [];
  private grid: Grid | null = null;
  private scratch: number[] = []; // reused screen-mode candidate buffer (no per-pick allocation)

  /** Diagnostics: cumulative count of precise per-entry tests run by pick(). The #216
   *  regression test asserts tests-per-pick stays ≪ N (the grid's deterministic signature). */
  testedEntries = 0;

  /** screenMode mirrors the layer's "screen" sizeMode: geometry is rendered at constant pixel
   *  size around a projected anchor rather than scaled by the view transform, so pick() must
   *  account for the anchor per entry instead of inverting the transform globally. */
  constructor(drawables: readonly DrawableVector[], private readonly tolerance = 1, private readonly screenMode = false) {
    this.append(drawables);
  }

  /** Add more drawables to the index (used by incremental layer append). */
  append(drawables: readonly DrawableVector[]): void {
    const from = this.entries.length;
    for (const d of drawables) {
      if ((d.flags & 1) === 0) continue; // hidden never hits
      const closed = d.subpaths.filter((s) => s.closed && s.points.length >= 6);
      const circles = d.circles;

      // Compute bounding box from subpaths and/or circle extents.
      let [minX, minY, maxX, maxY] = bounds(d.subpaths);
      for (const c of circles) {
        if (c.x - c.r < minX) minX = c.x - c.r;
        if (c.x + c.r > maxX) maxX = c.x + c.r;
        if (c.y - c.r < minY) minY = c.y - c.r;
        if (c.y + c.r > maxY) maxY = c.y + c.r;
      }

      // Reference anchor for screen sizeMode: an explicit glyph anchor, else a lone point's
      // own center, else the bbox center (only reached by synthetic multi-shape screen entries
      // the library doesn't currently emit). Ignored entirely in world mode.
      const anchor: [number, number] = d.anchor
        ?? (circles.length === 1 ? [circles[0]!.x, circles[0]!.y] : [(minX + maxX) / 2, (minY + maxY) / 2]);

      this.entries.push({
        id: d.id, minX, minY, maxX, maxY,
        filled: closed.length > 0,
        rings: closed.length > 0 ? groupRings(closed) : [],
        strokes: d.lineWidth > 0 ? d.subpaths : [],
        halfWidth: d.lineWidth / 2 + this.tolerance,
        circles,
        tolerance: this.tolerance,
        anchor,
      });
    }
    // Index the new entries. Any O(N) rebuild happens HERE (the data path), never in pick()
    // (the pointer path): once entries outgrow the built grid 2×, rebuild to re-fit cell size
    // and extent — amortized O(1) per appended entry.
    const g = this.grid;
    if (!g || this.entries.length > 2 * g.builtCount) this.buildGrid();
    else for (let i = from; i < this.entries.length; i++) this.insert(g, i);
  }

  /** (Re)build the grid over all current entries: extent + cell size from the data, then
   *  insert every entry in ascending index order (keeps per-cell chains topmost-first). */
  private buildGrid(): void {
    const n = this.entries.length;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let sizeSum = 0, sized = 0;
    for (const e of this.entries) {
      if (!(e.minX <= e.maxX && e.minY <= e.maxY)) continue; // degenerate: never hits
      if (this.screenMode) {
        const [ax, ay] = e.anchor;
        if (ax < x0) x0 = ax; if (ax > x1) x1 = ax;
        if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
      } else {
        if (e.minX - e.halfWidth < x0) x0 = e.minX - e.halfWidth;
        if (e.maxX + e.halfWidth > x1) x1 = e.maxX + e.halfWidth;
        if (e.minY - e.halfWidth < y0) y0 = e.minY - e.halfWidth;
        if (e.maxY + e.halfWidth > y1) y1 = e.maxY + e.halfWidth;
        sizeSum += Math.max(e.maxX - e.minX, e.maxY - e.minY) + 2 * e.halfWidth;
        sized++;
      }
    }
    if (!(x0 <= x1 && y0 <= y1)) { x0 = y0 = 0; x1 = y1 = 0; } // empty index / all degenerate
    // Cell size: extent/√N for ~1 entry per cell, floored at the mean inflated entry size so
    // typical entries span ≤ ~2×2 cells (large-on-average layers get coarser cells instead of
    // spilling everything to overflow). MAX_DIM caps memory; degenerate extents get one cell.
    const dim = Math.min(MAX_DIM, Math.max(1, Math.ceil(Math.sqrt(n))));
    const avgSize = sized > 0 ? sizeSum / sized : 0;
    const cell = Math.max(Math.max(x1 - x0, y1 - y0, 1e-9) / dim, avgSize);
    const cols = Math.max(1, Math.min(MAX_DIM, Math.ceil((x1 - x0) / cell) + 1));
    const rows = Math.max(1, Math.min(MAX_DIM, Math.ceil((y1 - y0) / cell) + 1));
    const old = this.grid;
    const g: Grid = {
      x0, y0, cell, cols, rows,
      head: new Int32Array(cols * rows).fill(-1),
      // Reuse the old ref pool's capacity across rebuilds (its contents are re-derived).
      refEntry: old && old.refEntry.length >= n ? old.refEntry : new Int32Array(Math.max(n, 64)),
      refNext: old && old.refNext.length >= n ? old.refNext : new Int32Array(Math.max(n, 64)),
      refCount: 0,
      overflow: [],
      builtCount: n,
      maxReach: 0,
    };
    this.grid = g;
    for (let i = 0; i < n; i++) this.insert(g, i);
  }

  /** Register entry i in the grid (world: inflated-bbox cell range or overflow; screen: anchor cell). */
  private insert(g: Grid, i: number): void {
    const e = this.entries[i]!;
    if (!(e.minX <= e.maxX && e.minY <= e.maxY)) return; // degenerate: test() always misses
    if (this.screenMode) {
      const [ax, ay] = e.anchor;
      // Largest |query−anchor| offset (px) at which test() could still pass — pick() widens
      // its anchor window by the max over all entries (constant px, so ÷t.k in world units).
      const reach = Math.max(
        Math.abs(e.maxX + e.halfWidth - ax), Math.abs(ax - e.minX + e.halfWidth),
        Math.abs(e.maxY + e.halfWidth - ay), Math.abs(ay - e.minY + e.halfWidth),
      );
      if (reach > g.maxReach) g.maxReach = reach;
      this.pushRef(g, this.cellOf(g, ax, ay), i);
      return;
    }
    const cx0 = this.colOf(g, e.minX - e.halfWidth), cx1 = this.colOf(g, e.maxX + e.halfWidth);
    const cy0 = this.rowOf(g, e.minY - e.halfWidth), cy1 = this.rowOf(g, e.maxY + e.halfWidth);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > SPAN_CAP) { g.overflow.push(i); return; }
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) this.pushRef(g, cy * g.cols + cx, i);
  }

  private pushRef(g: Grid, cell: number, i: number): void {
    if (g.refCount === g.refEntry.length) {
      const refEntry = new Int32Array(g.refEntry.length * 2);
      const refNext = new Int32Array(g.refNext.length * 2);
      refEntry.set(g.refEntry); refNext.set(g.refNext);
      g.refEntry = refEntry; g.refNext = refNext;
    }
    g.refEntry[g.refCount] = i;
    g.refNext[g.refCount] = g.head[cell]!;
    g.head[cell] = g.refCount++;
  }

  /** Clamped column/row: out-of-extent positions land in edge cells — both insertion and query
   *  clamp the same way, so a hit can never be missed (only tested and precisely rejected). */
  private colOf(g: Grid, x: number): number {
    const c = Math.floor((x - g.x0) / g.cell);
    return c < 0 ? 0 : c >= g.cols ? g.cols - 1 : c;
  }
  private rowOf(g: Grid, y: number): number {
    const r = Math.floor((y - g.y0) / g.cell);
    return r < 0 ? 0 : r >= g.rows ? g.rows - 1 : r;
  }
  private cellOf(g: Grid, x: number, y: number): number {
    return this.rowOf(g, y) * g.cols + this.colOf(g, x);
  }

  /** True when (x, y) — already in the entry's world-geometry frame — lands on its geometry. */
  private test(e: Entry, x: number, y: number): boolean {
    this.testedEntries++;
    if (x < e.minX - e.halfWidth || x > e.maxX + e.halfWidth || y < e.minY - e.halfWidth || y > e.maxY + e.halfWidth) return false;
    if (e.filled) {
      for (const r of e.rings)
        if (pointInRing(x, y, r.outer.points) && !r.holes.some((h) => pointInRing(x, y, h.points))) return true;
    }
    if (e.strokes.length > 0) {
      for (const s of e.strokes) if (distToSegments(x, y, s.points) <= e.halfWidth) return true;
    }
    for (const c of e.circles) {
      if (Math.hypot(x - c.x, y - c.y) <= c.r + e.tolerance) return true;
    }
    return false;
  }

  /** Shift the screen query point into entry e's geometry frame and test it — reproduces the
   *  render `screen = project(anchor) + (vertex - anchor)`. */
  private testScreen(e: Entry, x: number, y: number, t: ViewTransform): boolean {
    const [ax, ay] = e.anchor;
    return this.test(e, x - t.k * ax - t.x + ax, y - t.k * ay - t.y + ay);
  }

  /** Pick the topmost drawable under the pointer, given a SCREEN-space (CSS px) point and the
   *  current view transform. World layers invert the transform once; screen layers (constant
   *  pixel size) instead shift the query into each entry's geometry frame about its projected
   *  anchor, reproducing the render `screen = project(anchor) + (vertex - anchor)`.
   *  O(candidates in the pointer's grid neighbourhood), not O(entries) — see Grid. */
  pick(x: number, y: number, t: ViewTransform): string | number | null {
    const g = this.grid;
    if (this.screenMode) {
      if (!g) return null; // no entries appended yet
      // A hit at screen x requires the entry's anchor within ±maxReach px of the pointer —
      // i.e. within ±maxReach/t.k of the inverted point in anchor space (see insert()).
      const wx = (x - t.x) / t.k, wy = (y - t.y) / t.k;
      const pad = g.maxReach / t.k;
      const cx0 = this.colOf(g, wx - pad), cx1 = this.colOf(g, wx + pad);
      const cy0 = this.rowOf(g, wy - pad), cy1 = this.rowOf(g, wy + pad);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) * 2 >= g.cols * g.rows) {
        // Zoomed out so far the window covers most of the grid — nearly all entries are
        // candidates, so the plain topmost-first scan is cheaper than collect + sort.
        for (let i = this.entries.length - 1; i >= 0; i--) {
          const e = this.entries[i]!;
          if (this.testScreen(e, x, y, t)) return e.id;
        }
        return null;
      }
      const cand = this.scratch;
      cand.length = 0;
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++)
          for (let ref = g.head[cy * g.cols + cx]!; ref !== -1; ref = g.refNext[ref]!)
            cand.push(g.refEntry[ref]!);
      cand.sort((a, b) => b - a); // topmost first (each anchor lives in exactly one cell)
      for (const i of cand) {
        const e = this.entries[i]!;
        if (this.testScreen(e, x, y, t)) return e.id;
      }
      return null;
    }
    const px = (x - t.x) / t.k, py = (y - t.y) / t.k;
    if (!g) return null; // no entries appended yet
    // Entries were inserted over their halfWidth-inflated bboxes, so every possible hit is
    // registered in the query point's own cell: read ONE chain, merged topmost-first with the
    // overflow list (both iterate in descending entry order).
    let ref = g.head[this.cellOf(g, px, py)]!;
    let oi = g.overflow.length - 1;
    while (ref !== -1 || oi >= 0) {
      const ce = ref !== -1 ? g.refEntry[ref]! : -1;
      const oe = oi >= 0 ? g.overflow[oi]! : -1;
      let i: number;
      if (ce >= oe) { i = ce; ref = g.refNext[ref]!; }
      else { i = oe; oi--; }
      const e = this.entries[i]!;
      if (this.test(e, px, py)) return e.id;
    }
    return null;
  }
}
