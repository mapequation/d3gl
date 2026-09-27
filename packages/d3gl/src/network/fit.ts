import type { ViewTransform } from "../core/index.js";

/** World-space bounding box `[minX, minY, maxX, maxY]`. */
export type FitBox = [number, number, number, number];

/** At most this many leaves per side (and axis) are dropped as stragglers by a trimming {@link layoutBox}. */
const MAX_STRAGGLERS = 64;
/** …and at most this share of the leaves — so a small layout (< 200 leaves) is framed exactly. */
const STRAGGLER_SHARE = 0.005;
/**
 * How far beyond the rest (as a share of the rest's size) dropped leaves must sit to count as stragglers:
 * a side keeps its exact bound below the first value, drops them fully past the second, and blends in
 * between — so a straggler drifting back in never makes the frame jump.
 */
const STRAGGLER_GAP_MIN = 0.1;
const STRAGGLER_GAP_FULL = 0.3;
/**
 * Share of an axis' span, at each end, that certifies a side as straggler-free: when that band holds more
 * than the trim count, the side's (trim+1)-th leaf lies within it, so even trimmed the side moves by at
 * most `BAND + 1/BINS` of the span — under {@link STRAGGLER_GAP_MIN} of the trimmed size, which is at least
 * `1 − 2·(BAND + 1/BINS)` of it (0.054 / 0.89 = 0.061 < 0.1). Keep that inequality when tuning either.
 */
const BAND = 0.05;
/** Leaves the certifying pass reads between checks for an early exit. */
const CERTIFY_BLOCK = 4096;
/** Histogram resolution {@link layoutBox} locates the trimmed sides with (per axis). */
const BINS = 256;
/** The histogram, shared by every call: a fixed 2 KB whatever the leaf count, so a fit allocates nothing. */
const binCounts = new Uint32Array(2 * BINS);

/** The histogram bin of `v` over a range starting at `min`, `scale` bins per unit (0 for an empty range). */
function binOf(v: number, min: number, scale: number): number {
  return Math.min(BINS - 1, Math.floor((v - min) * scale));
}

/** The first bin, walking from `from` in steps of `dir`, where more than `trim` leaves have been passed. */
function sideBin(counts: Uint32Array, offset: number, trim: number, from: number, dir: 1 | -1): number {
  let passed = 0;
  for (let b = from; b >= 0 && b < BINS; b += dir) {
    passed += counts[offset + b] ?? 0;
    if (passed > trim) return b;
  }
  return from;
}

/** One side's bound: `exact`, pulled toward `trimmed` by how far the dropped leaves sit beyond the rest. */
function sideBound(exact: number, trimmed: number, size: number): number {
  const gap = Math.abs(exact - trimmed) / size;
  const w = Math.min(1, Math.max(0, (gap - STRAGGLER_GAP_MIN) / (STRAGGLER_GAP_FULL - STRAGGLER_GAP_MIN)));
  return exact + w * (trimmed - exact);
}

/** Options for {@link layoutBox}. */
export interface LayoutBoxOptions {
  /**
   * Drop a handful of outlying **stragglers** from the box, for a layout that is still streaming (see
   * {@link layoutBox}). Default `false`: the exact bounding box, for a settled layout.
   */
  trimStragglers?: boolean;
}

/**
 * The box to frame a layout by: the bounding box of its **leaf positions** (`positions` is interleaved
 * `[x0, y0, x1, y1, …]`). Null when no position is finite.
 *
 * Tight by construction — it reads the leaves themselves, so it is the layout's true extent whatever the
 * LOD tree (an aggregate's `extent` compounds up the tree and would frame a coarsening tree several times
 * too loose, #327).
 *
 * By default it is the **exact** bounding box: every finite leaf is framed, so the settled view never
 * crops a small disconnected component or an isolate.
 *
 * With `trimStragglers` — the streaming fit, while a force layout is still converging — it is robust to
 * **fling-outs** (#206): a side drops its outermost leaves — at most `min(64, 0.5% of the leaves)` of them —
 * when they sit more than ~10-30% of the layout's size beyond the rest, so one leaf flung 20× away cannot
 * blow the frame up and shrink the rest to a dot. A group larger than that is part of the layout and is
 * framed; so is a sparse but contiguous edge (a disc's rim), and a clean layout gets its exact box. The
 * trade-off, only while streaming: a genuinely separate group no larger than the trim count that sits that
 * far out is dropped the same way and streams just outside the frame, until the settled fit frames it. The
 * trim is a hard count, so a far group hovering at it can switch consecutive streamed frames between tight
 * and loose. Layouts under 200 leaves are never trimmed.
 *
 * Cost: O(leaves), no allocation. The exact box is one branch-free pass. Trimming adds a count of the leaves
 * in each side's outer 5% band that certifies a layout without stragglers (and usually stops after a few
 * thousand leaves); only when a side fails that, two more passes histogram the axes (a fixed, reused 2 KB)
 * and locate its trimmed bound.
 */
export function layoutBox(positions: ArrayLike<number>, count: number, opts: LayoutBoxOptions = {}): FitBox | null {
  // Pass 1: exact bounds. Branch-free min/max runs several times faster than compare-and-assign on a
  // layout stored in radial order (a seed spiral); a non-finite position poisons it, and only then does the
  // finite-checked pass below run.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[2 * i] ?? NaN;
    const y = positions[2 * i + 1] ?? NaN;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let finite = count;
  const allFinite = Number.isFinite(maxX - minX + (maxY - minY));
  if (!allFinite) {
    minX = minY = Infinity;
    maxX = maxY = -Infinity;
    finite = 0;
    for (let i = 0; i < count; i++) {
      const x = positions[2 * i] ?? NaN;
      const y = positions[2 * i + 1] ?? NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      finite++;
    }
    if (finite === 0) return null;
  }
  const trim = opts.trimStragglers === true ? Math.min(MAX_STRAGGLERS, Math.floor(finite * STRAGGLER_SHARE)) : 0;
  if (trim === 0) return [minX, minY, maxX, maxY];

  // Pass 2: certify. A side whose outer band holds more than `trim` leaves drops nothing ({@link BAND}).
  // It stops once all four sides are certified — after a few thousand leaves on a layout without
  // stragglers, unless its storage order puts the rim last (a seed spiral), when it reads them all.
  const loXEdge = minX + BAND * (maxX - minX);
  const hiXEdge = maxX - BAND * (maxX - minX);
  const loYEdge = minY + BAND * (maxY - minY);
  const hiYEdge = maxY - BAND * (maxY - minY);
  let inLoX = 0;
  let inHiX = 0;
  let inLoY = 0;
  let inHiY = 0;
  let certified = false;
  for (let block = 0; block < count && !certified; block += CERTIFY_BLOCK) {
    const end = Math.min(count, block + CERTIFY_BLOCK);
    for (let i = block; i < end; i++) {
      const x = positions[2 * i] ?? NaN;
      const y = positions[2 * i + 1] ?? NaN;
      if (!allFinite && (!Number.isFinite(x) || !Number.isFinite(y))) continue;
      if (x <= loXEdge) inLoX++;
      if (x >= hiXEdge) inHiX++;
      if (y <= loYEdge) inLoY++;
      if (y >= hiYEdge) inHiY++;
    }
    certified = inLoX > trim && inHiX > trim && inLoY > trim && inHiY > trim;
  }
  if (certified) return [minX, minY, maxX, maxY];

  // Pass 3 (stragglers suspected): histogram both axes over their exact range, then find, per side, the bin
  // holding the (trim+1)-th leaf.
  const sx = maxX > minX ? BINS / (maxX - minX) : 0;
  const sy = maxY > minY ? BINS / (maxY - minY) : 0;
  const counts = binCounts;
  counts.fill(0);
  for (let i = 0; i < count; i++) {
    const x = positions[2 * i] ?? NaN;
    const y = positions[2 * i + 1] ?? NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const bx = binOf(x, minX, sx);
    const by = BINS + binOf(y, minY, sy);
    counts[bx] = (counts[bx] ?? 0) + 1;
    counts[by] = (counts[by] ?? 0) + 1;
  }
  const loX = sideBin(counts, 0, trim, 0, 1);
  const hiX = sideBin(counts, 0, trim, BINS - 1, -1);
  const loY = sideBin(counts, BINS, trim, 0, 1);
  const hiY = sideBin(counts, BINS, trim, BINS - 1, -1);

  // Pass 4: each side's trimmed bound is its outermost leaf inside the side bin (binned exactly as above, so
  // the two passes agree to the leaf) — the (trim+1)-th leaf's bin, never a leaf beyond it.
  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[2 * i] ?? NaN;
    const y = positions[2 * i + 1] ?? NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const bx = binOf(x, minX, sx);
    const by = binOf(y, minY, sy);
    if (bx >= loX && x < bMinX) bMinX = x;
    if (bx <= hiX && x > bMaxX) bMaxX = x;
    if (by >= loY && y < bMinY) bMinY = y;
    if (by <= hiY && y > bMaxY) bMaxY = y;
  }
  // Keep each exact bound unless the leaves it would drop are stragglers, well beyond the rest.
  const size = Math.max(bMaxX - bMinX, bMaxY - bMinY);
  if (!(size > 0)) return [minX, minY, maxX, maxY];
  return [sideBound(minX, bMinX, size), sideBound(minY, bMinY, size), sideBound(maxX, bMaxX, size), sideBound(maxY, bMaxY, size)];
}

/** Options for {@link fitTransform}. */
export interface FitTransformOptions {
  /** Share of the shorter viewport side the box's longest side fills. Default 0.85. */
  fill?: number;
  /** Screen pixels kept free around the box inside that fill — the drawn radius of screen-sized glyphs.
   *  Default 0. Never shrinks the fill below half its size, however large. */
  padPx?: number;
}

/**
 * The view transform that frames `box` into a `width × height` viewport: centre the box's centre in the
 * view and scale its longest side to `fill` (default 0.85) of the shorter viewport dimension, less
 * `padPx` on each side. Pure — the per-frame fit computes this from {@link layoutBox} and applies it.
 */
export function fitTransform(box: FitBox, width: number, height: number, opts: FitTransformOptions = {}): ViewTransform {
  const [minX, minY, maxX, maxY] = box;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const room = (opts.fill ?? 0.85) * Math.min(width, height);
  const k = Math.max(room - 2 * (opts.padPx ?? 0), room / 2) / span;
  return { k, x: width / 2 - k * cx, y: height / 2 - k * cy };
}

/**
 * The transform a `layout({ fit: true })` frames `box` at (#369): padded by the drawn leaf radius `pad` —
 * grown into the box for world-sized glyphs, kept free as `pad` screen pixels for screen-sized ones — so the
 * outermost glyphs stay inside the frame, then {@link fitTransform}ed into the viewport. The engine reframes
 * every streamed frame with it; a spatial LOD stream computes the same from the positions it rebuilt its
 * tree for (#433), to cut that tree the way the engine will.
 */
export function layoutFitTransform(box: FitBox, width: number, height: number, pad: number, screenSized: boolean): ViewTransform {
  const padded: FitBox = screenSized ? box : [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  return fitTransform(padded, width, height, { padPx: screenSized ? pad : 0 });
}

/**
 * The camera of a fitted transition (#427): the view at eased progress `e` on the way from `a` to `b`
 * (clamped to `[0, 1]`, exactly `a` at 0 and `b` at 1). It moves the **world rectangle** the view shows in
 * a straight line — `1/k`, `x/k` and `y/k` are linear in `e` — as a transition moves the node positions.
 * So the zoom is monotonic, and a node on screen at both ends, eased on the same progress, stays on screen
 * at every step between (both the node and each edge of the view move linearly, so the node stays between
 * the edges). Pure and O(1) per call.
 */
export function interpolateView(a: ViewTransform, b: ViewTransform): (e: number) => ViewTransform {
  const s0 = 1 / a.k;
  const s1 = 1 / b.k;
  const u0 = a.x * s0;
  const u1 = b.x * s1;
  const v0 = a.y * s0;
  const v1 = b.y * s1;
  return (e) => {
    if (!(e > 0)) return a;
    if (e >= 1) return b;
    const k = 1 / (s0 + (s1 - s0) * e);
    return { k, x: (u0 + (u1 - u0) * e) * k, y: (v0 + (v1 - v0) * e) * k };
  };
}

/**
 * The camera of a fitted transition (#427) as a path whose destination may move on the way: called once per
 * frame with the transition's eased progress `e` and the view framing its target **as of that frame**
 * (re-derived from the viewport and the glyph pad, so a resize or a restyle mid-ease moves it). While the
 * destination holds still this is {@link interpolateView} from `start`. When it moves, the path re-aims
 * from the view it last returned, over the progress left — `(e − e₀) / (1 − e₀)` from the progress `e₀`
 * of that view — so the camera never jumps, zooms monotonically on each leg, keeps a node on screen at
 * both ends of a leg on screen through it, and still lands exactly on the destination at `e = 1`, with the
 * nodes. O(1) per call, and per re-aim.
 */
export function fitCameraPath(start: ViewTransform): (e: number, end: ViewTransform) => ViewTransform {
  let from = start;
  let e0 = 0;
  let to: ViewTransform | null = null;
  let leg: (u: number) => ViewTransform = () => start;
  let last = start;
  let eLast = 0;
  return (e, end) => {
    if (!to || end.k !== to.k || end.x !== to.x || end.y !== to.y) {
      if (to) [from, e0] = [last, eLast]; // re-aim from where the camera is
      to = end;
      leg = interpolateView(from, end);
    }
    last = e >= 1 ? end : leg(e0 < 1 ? (e - e0) / (1 - e0) : 1);
    eLast = e;
    return last;
  };
}
