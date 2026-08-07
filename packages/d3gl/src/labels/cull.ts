/** Where the anchor point sits along the label's own text axis — like SVG `text-anchor`. */
export type TextAnchor = "start" | "middle" | "end";

/** Where the anchor point sits vertically in a PLAIN label's box. `"top"` (default) keeps the
 *  historical top-left box; `"middle"` centres the box on the anchor. Oriented labels (`rotation`)
 *  are always centred on their axis, so they ignore it. */
export type LabelBaseline = "top" | "middle";

/** A label positioned in SCREEN pixels (after the view transform is applied). */
export interface LabelBox {
  id: string | number;
  /** Screen-space anchor. Where the box sits around it is declared by {@link textAnchor} /
   *  {@link baseline} (plain labels) or by {@link rotation} (oriented labels) — never by a
   *  hand-written CSS transform, so collision and render can't disagree. */
  x: number;
  y: number;
  /** Box size in pixels; used for collision. Defaults to a small box if omitted. */
  width?: number;
  height?: number;
  /** Higher wins collisions; defaults to 0. */
  priority?: number;
  /**
   * Reading-direction angle in radians (CSS-clockwise, i.e. `rotate(rotation·180/π deg)`).
   * Setting it switches the label to the ORIENTED model: text runs along the rotated axis,
   * vertically centred on the anchor, and both the collision box and the rendered CSS
   * transform are derived from it — so the two can never disagree. Leave undefined for an
   * axis-aligned box placed by {@link textAnchor}/{@link baseline}.
   */
  rotation?: number;
  /** Which way the text runs from the anchor — `"start"` (default) puts the anchor at the box's
   *  left edge, `"middle"` centres it, `"end"` puts it at the right edge. Honoured by BOTH models
   *  (#204: a centred label must collide on the box it actually renders in). */
  textAnchor?: TextAnchor;
  /** Plain labels: vertical placement of the box (default `"top"`). */
  baseline?: LabelBaseline;
  /** Oriented labels only: flip 180° (and the text side) when the rotation would render
   *  the text upside down — the standard radial-tree readability flip. */
  keepUpright?: boolean;
  /** Carried through untouched (e.g. text, datum). */
  [key: string]: unknown;
}

export interface CullOptions {
  viewport: { width: number; height: number };
  /** Anchors within this many pixels outside the viewport are still considered. */
  padding?: number;
  /** Reusable buffers, so a per-frame caller allocates nothing (see {@link labelCullScratch}).
   *  Omitted ⇒ a fresh one per call. */
  scratch?: LabelCullScratch;
}

type Point = [number, number];

/** The realised screen geometry of a label: its four corners, their AABB, whether it is
 *  axis-aligned (fast-path collision), and the CSS transform that reproduces the box. */
export interface LabelGeometry {
  corners: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  axisAligned: boolean;
  /** CSS transform reproducing the box; `""` when the box is the default top-left one (the
   *  caller's own `transform` then applies). */
  transform: string;
}

// ── One description of where a label's box sits ───────────────────────────────────────────────
// Everything downstream — the collision box, the CSS transform the overlay renders with, and the
// y a native-text backend draws at — is derived from `writeExtents`, so they cannot drift apart
// (the #58 lesson: two hand-written descriptions of the same orientation WILL disagree).

/** Local box extents in the label's own frame, origin at the anchor: `[lx0, lx1, ly0, ly1]`.
 *  Returns the effective rotation in radians (0 for a plain label; the upright flip folded in). */
function writeExtents(box: LabelBox, out: Float64Array): number {
  const w = box.width ?? 0;
  const h = box.height ?? 0;
  const rotation = box.rotation;
  const oriented = rotation !== undefined;
  // Upright flip: when the reading direction points left (cos < 0) the text would be upside
  // down, so add π and swap the text side so it still radiates outward.
  const flip = oriented && box.keepUpright === true && Math.cos(rotation) < 0;
  let anchor: TextAnchor = box.textAnchor ?? "start";
  if (flip) anchor = anchor === "start" ? "end" : anchor === "end" ? "start" : "middle";
  const lx0 = anchor === "start" ? 0 : anchor === "end" ? -w : -w / 2;
  // Oriented labels sit centred on their axis; plain labels honour `baseline` (default "top").
  const ly0 = oriented || box.baseline === "middle" ? -h / 2 : 0;
  out[0] = lx0;
  out[1] = lx0 + w;
  out[2] = ly0;
  out[3] = ly0 + h;
  return oriented ? (flip ? rotation + Math.PI : rotation) : 0;
}

/** Module-local scratch for the extent helpers below — written and consumed synchronously inside
 *  one call, never retained, so it costs no allocation and can't be observed across calls. */
const EXTENTS = new Float64Array(4);

/**
 * The CSS transform that renders a label in the box {@link labelGeometry} culls against, applied
 * to an element whose `left`/`top` is the anchor (with `transform-origin` at that point). Derived
 * from the same extents as the box: the element's left edge must land at `x + lx0`, i.e. a
 * `translate` of `lx0/width` — 0% / −50% / −100% for `start` / `middle` / `end`, and likewise
 * 0% / −50% vertically. Returns `""` for the default top-left box, so a caller's own `transform`
 * still applies there (back-compatible).
 */
export function labelTransform(box: LabelBox): string {
  const rot = writeExtents(box, EXTENTS);
  const lx0 = EXTENTS[0] ?? 0;
  const lx1 = EXTENTS[1] ?? 0;
  const ly0 = EXTENTS[2] ?? 0;
  const ly1 = EXTENTS[3] ?? 0;
  const w = lx1 - lx0;
  const h = ly1 - ly0;
  const txPct = w > 0 ? (lx0 / w) * 100 : 0;
  const tyPct = h > 0 ? (ly0 / h) * 100 : 0;
  if (box.rotation === undefined) {
    return txPct === 0 && tyPct === 0 ? "" : `translate(${txPct}%, ${tyPct}%)`;
  }
  return `rotate(${(rot * 180) / Math.PI}deg) translate(${txPct}%, ${tyPct}%)`;
}

/**
 * The `y` a backend drawing native text with a `"middle"` baseline must use — the vertical centre
 * of the same box. Mirrors {@link labelGeometry}'s vertical placement (a unit test pins the two
 * against each other), so overlay and native text sit on the same line.
 */
export function labelTextY(box: LabelBox): number {
  writeExtents(box, EXTENTS);
  return box.y + ((EXTENTS[2] ?? 0) + (EXTENTS[3] ?? 0)) / 2;
}

/**
 * Resolve a {@link LabelBox} to its on-screen geometry. Plain labels get an axis-aligned box placed
 * by `textAnchor`/`baseline` (default: the historical top-left box); oriented labels (`rotation`)
 * place the text along the rotated axis, vertically centred on the anchor, with the optional
 * upright flip folded in. The collision corners and the CSS transform come from the same
 * computation, so render and culling stay consistent.
 */
export function labelGeometry(box: LabelBox): LabelGeometry {
  const rot = writeExtents(box, EXTENTS);
  const lx0 = EXTENTS[0] ?? 0;
  const lx1 = EXTENTS[1] ?? 0;
  const ly0 = EXTENTS[2] ?? 0;
  const ly1 = EXTENTS[3] ?? 0;
  const { x, y } = box;
  // NOTE: the extents are copied to locals above BEFORE this call, which rewrites the shared buffer.
  const transform = labelTransform(box);

  if (box.rotation === undefined) {
    return {
      corners: [
        [x + lx0, y + ly0],
        [x + lx1, y + ly0],
        [x + lx1, y + ly1],
        [x + lx0, y + ly1],
      ],
      minX: x + lx0,
      minY: y + ly0,
      maxX: x + lx1,
      maxY: y + ly1,
      axisAligned: true,
      transform,
    };
  }

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const toScreen = (lx: number, ly: number): Point => [x + lx * cos - ly * sin, y + lx * sin + ly * cos];
  const corners: Point[] = [toScreen(lx0, ly0), toScreen(lx1, ly0), toScreen(lx1, ly1), toScreen(lx0, ly1)];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  return { corners, minX, minY, maxX, maxY, axisAligned: false, transform };
}

// ── Collision ─────────────────────────────────────────────────────────────────────────────────

/**
 * Reusable buffers for {@link cullLabels}. Placement runs on the per-frame path (every
 * `setTransform` re-places every label), so the caller holds ONE of these and passes it back in:
 * the steady-state cull then allocates nothing but the survivor array. Same shape of contract as
 * `core/declutter`'s {@link core!DeclutterScratch}.
 *
 * `lastTests` / `lastPlaced` / `lastCandidates` describe the last call — the deterministic
 * signature the per-frame guard asserts on (tests must stay O(candidates), never O(candidates²)).
 */
export interface LabelCullScratch {
  /** Candidate indices, in placement (priority-descending) order. */
  order: Int32Array;
  /** Candidate priorities, indexed BY CANDIDATE INDEX, so the placement-order sort compares two
   *  typed reads instead of two property loads through the candidate array (6.5× faster at 200k). */
  keys: Float64Array;
  /** Per-cell head of the intrusive list of placed labels (−1 = empty). */
  head: Int32Array;
  /** Next placed label in the same cell (−1 = end). */
  next: Int32Array;
  /** Placed AABBs, stride 4: `minX, minY, maxX, maxY`. */
  boxes: Float64Array;
  /** Placed corners, stride 8: `x0,y0, x1,y1, x2,y2, x3,y3` (for the oriented SAT test). */
  corners: Float64Array;
  /** 1 when the placed label is rotated (needs SAT rather than the AABB verdict). */
  oriented: Uint8Array;
  /** Radix scratch (large candidate sets only, see {@link RADIX_MIN}): the sortable high/low words
   *  of each candidate's priority, the ping-pong target, and the 16-bit digit histogram. */
  keyHi: Uint32Array;
  keyLo: Uint32Array;
  aux: Int32Array;
  hist: Uint32Array;
  /** Pairwise overlap tests performed by the last call. */
  lastTests: number;
  /** Labels placed by the last call. */
  lastPlaced: number;
  /** In-viewport candidates considered by the last call. */
  lastCandidates: number;
}

/** A fresh, empty scratch (buffers grow lazily on first use). Hold one per label layer. */
export function labelCullScratch(): LabelCullScratch {
  return {
    order: new Int32Array(0),
    keys: new Float64Array(0),
    head: new Int32Array(0),
    next: new Int32Array(0),
    boxes: new Float64Array(0),
    corners: new Float64Array(0),
    oriented: new Uint8Array(0),
    keyHi: new Uint32Array(0),
    keyLo: new Uint32Array(0),
    aux: new Int32Array(0),
    hist: new Uint32Array(0),
    lastTests: 0,
    lastPlaced: 0,
    lastCandidates: 0,
  };
}

/** Corners of the candidate under test (8 floats), reused across candidates within a call. */
const CAND_CORNERS = new Float64Array(8);

// ── Placement order ───────────────────────────────────────────────────────────────────────────
// Placement is greedy in priority-descending order, so every frame needs a total order over the
// in-view candidates. A JS-comparator sort is the obvious way and the wrong one at scale: it costs
// ~n·log n *callbacks* — measured 113 ms for 200k candidates (86% of the whole pass), and this path
// runs on every zoom frame. Above `RADIX_MIN` we sort the double bit patterns with a stable 4×16-bit
// LSD radix instead: O(n) passes over typed arrays, no callback, and — because LSD radix is stable
// and `order` starts in ascending candidate index — equal priorities keep input order, exactly the
// tie-break the comparator spells out. Both paths therefore produce the SAME order (a unit test
// pins them against a quadratic reference).

/** Below this, the comparator sort wins: the radix pays 4 × 65536 prefix-sum steps regardless of n. */
const RADIX_MIN = 8192;
const RADIX_BUCKETS = 0x10000; // 16-bit digits, 4 LSD passes cover a double's 64 bits

/** Endianness probe: which Uint32 half of a Float64 holds the sign/exponent word. */
const KEY_F64 = new Float64Array(1);
const KEY_U32 = new Uint32Array(KEY_F64.buffer);
const KEY_HI = ((): number => {
  KEY_F64[0] = 1;
  return KEY_U32[1] === 0x3ff00000 ? 1 : 0;
})();
const KEY_LO = 1 - KEY_HI;

/**
 * Map a double to a 64-bit unsigned key (as two 32-bit words) whose ASCENDING order is the double's
 * DESCENDING numeric order. The standard IEEE-754 order-preserving map is `sign ? ~bits : bits |
 * signMask` (ascending); this is its complement, so no reversal pass is needed — and reversing
 * would have flipped the index tie-break too. Writes into `hi[i]` / `lo[i]`.
 */
function writeSortKey(value: number, i: number, hi: Uint32Array, lo: Uint32Array): void {
  KEY_F64[0] = value;
  const h = KEY_U32[KEY_HI] ?? 0;
  const l = KEY_U32[KEY_LO] ?? 0;
  if (h & 0x80000000) {
    hi[i] = h; // negative: already above every non-negative key ⇒ sorts last
    lo[i] = l;
  } else {
    hi[i] = ~h >>> 0; // non-negative: complement (clears the sign bit the ascending map would set)
    lo[i] = ~l >>> 0;
  }
}

/** Stable LSD radix over `order[0..n)` by the (hi, lo) keys. Four 16-bit passes ping-pong between
 *  `order` and `aux`, so the result lands back in `order`. */
function radixSortByKey(order: Int32Array, n: number, hi: Uint32Array, lo: Uint32Array, aux: Int32Array, hist: Uint32Array): void {
  for (let pass = 0; pass < 4; pass++) {
    const src = pass % 2 === 0 ? order : aux;
    const dst = pass % 2 === 0 ? aux : order;
    const words = pass < 2 ? lo : hi;
    const shift = pass % 2 === 0 ? 0 : 16;
    hist.fill(0, 0, RADIX_BUCKETS);
    for (let i = 0; i < n; i++) {
      const b = ((words[src[i] ?? 0] ?? 0) >>> shift) & 0xffff;
      hist[b] = (hist[b] ?? 0) + 1;
    }
    let sum = 0;
    for (let b = 0; b < RADIX_BUCKETS; b++) {
      const c = hist[b] ?? 0;
      hist[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const id = src[i] ?? 0;
      const b = ((words[id] ?? 0) >>> shift) & 0xffff;
      const at = hist[b] ?? 0;
      dst[at] = id;
      hist[b] = at + 1;
    }
  }
}

/** Separating-axis test between two convex quads held in flat corner buffers. Touching edges count
 *  as non-overlapping (matching the AABB test's `<=`). */
function satOverlap(a: Float64Array, ao: number, b: Float64Array, bo: number): boolean {
  for (let poly = 0; poly < 2; poly++) {
    const src = poly === 0 ? a : b;
    const so = poly === 0 ? ao : bo;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const x1 = src[so + 2 * i] ?? 0;
      const y1 = src[so + 2 * i + 1] ?? 0;
      const nx = -((src[so + 2 * j + 1] ?? 0) - y1);
      const ny = (src[so + 2 * j] ?? 0) - x1;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (let p = 0; p < 4; p++) {
        const d = (a[ao + 2 * p] ?? 0) * nx + (a[ao + 2 * p + 1] ?? 0) * ny;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
        const e = (b[bo + 2 * p] ?? 0) * nx + (b[bo + 2 * p + 1] ?? 0) * ny;
        if (e < bMin) bMin = e;
        if (e > bMax) bMax = e;
      }
      if (aMax <= bMin || bMax <= aMin) return false;
    }
  }
  return true;
}

/** Grow a scratch buffer (doubling) to hold at least `need` entries of `stride` elements. */
function growF64(buf: Float64Array, need: number, stride: number): Float64Array {
  if (buf.length >= need * stride) return buf;
  const grown = new Float64Array(Math.max(need, 64) * 2 * stride);
  grown.set(buf);
  return grown;
}

/**
 * Reduce label candidates to a renderable subset: drop anchors outside the viewport (+padding),
 * then place highest-priority first, skipping any whose box collides with an already-placed one.
 * Collision uses each label's true screen footprint (see {@link labelGeometry}) — the box it
 * renders in, oriented labels included — so dense regions thin down to a readable set instead of
 * overprinting (#204), and the survivor of each cluster is the most important label.
 *
 * Placed boxes are binned into a uniform screen grid whose cell is the largest candidate extent,
 * so a colliding pair always lands within the 3×3 cell neighbourhood: the pass is O(candidates)
 * overlap tests, not the O(candidates²) `placed.some(…)` scan it replaces, and with a caller-owned
 * {@link CullOptions.scratch} it allocates only the survivor array. The same structure
 * `core/declutter` uses for glyphs — but rectangles, not discs: a text box's bounding circle is
 * ~10× its area, which would cull nearly everything.
 */
export function cullLabels(candidates: readonly LabelBox[], options: CullOptions): LabelBox[] {
  const pad = options.padding ?? 0;
  const { width, height } = options.viewport;
  const scratch = options.scratch ?? labelCullScratch();
  scratch.lastTests = 0;
  scratch.lastPlaced = 0;
  scratch.lastCandidates = 0;

  // ── Pass 1: viewport filter + the extents the grid is sized from. O(candidates), no allocation.
  if (scratch.order.length < candidates.length) {
    scratch.order = new Int32Array(Math.max(candidates.length, 64) * 2);
    scratch.keys = new Float64Array(scratch.order.length);
  }
  const order = scratch.order;
  const keys = scratch.keys;
  let n = 0;
  let maxW = 1;
  let maxH = 1;
  let ranked = false;
  let firstPriority = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    if (!(c.x >= -pad && c.x <= width + pad && c.y >= -pad && c.y <= height + pad)) continue;
    const w = c.width ?? 0;
    const h = c.height ?? 0;
    // A rotated w×h box spans at most (w + h) on either axis — a conservative bound, so the cell
    // stays big enough without computing the rotation here.
    const extent = c.rotation === undefined ? 0 : w + h;
    const ex = extent || w;
    const ey = extent || h;
    if (ex > maxW) maxW = ex;
    if (ey > maxH) maxH = ey;
    const p = c.priority ?? 0;
    if (n === 0) firstPriority = p;
    else if (p !== firstPriority) ranked = true;
    keys[i] = p;
    order[n++] = i;
  }
  scratch.lastCandidates = n;
  if (n === 0) return [];

  // ── Pass 2: placement order. Priority descending, ties by input order (the index IS the input
  // order, so no stability assumption is needed). Skipped entirely when every priority ties.
  if (ranked && n < RADIX_MIN) {
    order.subarray(0, n).sort((a, b) => (keys[b] ?? 0) - (keys[a] ?? 0) || a - b);
  } else if (ranked) {
    if (scratch.keyHi.length < order.length) {
      scratch.keyHi = new Uint32Array(order.length);
      scratch.keyLo = new Uint32Array(order.length);
      scratch.aux = new Int32Array(order.length);
    }
    if (scratch.hist.length < RADIX_BUCKETS) scratch.hist = new Uint32Array(RADIX_BUCKETS);
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi] ?? 0;
      writeSortKey(keys[i] ?? 0, i, scratch.keyHi, scratch.keyLo);
    }
    radixSortByKey(order, n, scratch.keyHi, scratch.keyLo, scratch.aux, scratch.hist);
  }

  // ── Grid. Cell ≥ the largest candidate extent ⇒ two overlapping boxes' centres are at most one
  // cell apart on each axis, so the 3×3 neighbourhood is an exact broad phase. Cell count is also
  // bounded to ≈ the candidate count, so clearing it stays O(candidates) even for tiny labels.
  const gw = Math.max(width + 2 * pad, 1);
  const gh = Math.max(height + 2 * pad, 1);
  const target = Math.max(16, n);
  const colsMax = Math.max(1, Math.ceil(Math.sqrt((target * gw) / gh)));
  const rowsMax = Math.max(1, Math.ceil(target / colsMax));
  const cellW = Math.max(maxW, gw / colsMax);
  const cellH = Math.max(maxH, gh / rowsMax);
  const cols = Math.floor(gw / cellW) + 3;
  const rows = Math.floor(gh / cellH) + 3;
  const nCells = cols * rows;
  if (scratch.head.length < nCells) scratch.head = new Int32Array(nCells);
  const head = scratch.head;
  head.fill(-1, 0, nCells);

  // ── Pass 3: greedy placement against the grid.
  let placed = 0;
  let boxes = scratch.boxes;
  let corners = scratch.corners;
  let oriented = scratch.oriented;
  let next = scratch.next;
  const result: LabelBox[] = [];
  let tests = 0;

  for (let oi = 0; oi < n; oi++) {
    const ci = order[oi] ?? 0;
    const cand = candidates[ci];
    if (!cand) continue;

    // Candidate geometry (no allocation): corners for the SAT path, AABB for the broad phase.
    const rot = writeExtents(cand, EXTENTS);
    const lx0 = EXTENTS[0] ?? 0;
    const lx1 = EXTENTS[1] ?? 0;
    const ly0 = EXTENTS[2] ?? 0;
    const ly1 = EXTENTS[3] ?? 0;
    const isOriented = cand.rotation !== undefined;
    let minX: number;
    let minY: number;
    let maxX: number;
    let maxY: number;
    if (isOriented) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      minX = Infinity;
      minY = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
      for (let k = 0; k < 4; k++) {
        const lx = k === 0 || k === 3 ? lx0 : lx1;
        const ly = k < 2 ? ly0 : ly1;
        const px = cand.x + lx * cos - ly * sin;
        const py = cand.y + lx * sin + ly * cos;
        CAND_CORNERS[2 * k] = px;
        CAND_CORNERS[2 * k + 1] = py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    } else {
      minX = cand.x + lx0;
      maxX = cand.x + lx1;
      minY = cand.y + ly0;
      maxY = cand.y + ly1;
      CAND_CORNERS[0] = minX; CAND_CORNERS[1] = minY;
      CAND_CORNERS[2] = maxX; CAND_CORNERS[3] = minY;
      CAND_CORNERS[4] = maxX; CAND_CORNERS[5] = maxY;
      CAND_CORNERS[6] = minX; CAND_CORNERS[7] = maxY;
    }

    // Cell of the box CENTRE (what the ≥ max-extent cell size is derived for). Clamping is
    // monotone, so a box pushed outside the grid keeps the ≤ 1 cell-distance invariant.
    const cxRaw = Math.floor((((minX + maxX) / 2) + pad) / cellW) + 1;
    const cyRaw = Math.floor((((minY + maxY) / 2) + pad) / cellH) + 1;
    const cx = cxRaw < 0 ? 0 : cxRaw >= cols ? cols - 1 : cxRaw;
    const cy = cyRaw < 0 ? 0 : cyRaw >= rows ? rows - 1 : cyRaw;

    let blocked = false;
    for (let gx = cx - 1; gx <= cx + 1 && !blocked; gx++) {
      if (gx < 0 || gx >= cols) continue;
      for (let gy = cy - 1; gy <= cy + 1 && !blocked; gy++) {
        if (gy < 0 || gy >= rows) continue;
        for (let p = head[gy * cols + gx] ?? -1; p !== -1; p = next[p] ?? -1) {
          tests++;
          const b = 4 * p;
          if (maxX <= (boxes[b] ?? 0) || (boxes[b + 2] ?? 0) <= minX) continue; // AABB reject (x)
          if (maxY <= (boxes[b + 1] ?? 0) || (boxes[b + 3] ?? 0) <= minY) continue; // AABB reject (y)
          if (!isOriented && oriented[p] === 0) { blocked = true; break; } // both axis-aligned: exact
          if (satOverlap(CAND_CORNERS, 0, corners, 8 * p)) { blocked = true; break; }
        }
      }
    }
    if (blocked) continue;

    // Place it: retain the footprint and link it into its cell.
    boxes = growF64(boxes, placed + 1, 4);
    corners = growF64(corners, placed + 1, 8);
    if (oriented.length <= placed) {
      const grown = new Uint8Array(Math.max(placed + 1, 64) * 2);
      grown.set(oriented);
      oriented = grown;
    }
    if (next.length <= placed) {
      const grown = new Int32Array(Math.max(placed + 1, 64) * 2);
      grown.set(next);
      next = grown;
    }
    const b = 4 * placed;
    boxes[b] = minX;
    boxes[b + 1] = minY;
    boxes[b + 2] = maxX;
    boxes[b + 3] = maxY;
    corners.set(CAND_CORNERS, 8 * placed);
    oriented[placed] = isOriented ? 1 : 0;
    const cell = cy * cols + cx;
    next[placed] = head[cell] ?? -1;
    head[cell] = placed;
    placed++;
    result.push(cand);
  }

  scratch.boxes = boxes;
  scratch.corners = corners;
  scratch.oriented = oriented;
  scratch.next = next;
  scratch.lastTests = tests;
  scratch.lastPlaced = placed;
  return result;
}
