import type { ViewTransform } from "../core/index.js";

/** World-space bounding box `[minX, minY, maxX, maxY]`. */
export type FitBox = [number, number, number, number];

/** At most this many leaves per side (and axis) are dropped as stragglers by {@link layoutBox}. */
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

/**
 * The box to frame a layout by: the bounding box of its **leaf positions** (`positions` is interleaved
 * `[x0, y0, x1, y1, …]`), less a handful of **stragglers**. Null when no position is finite.
 *
 * Tight by construction — it reads the leaves themselves, so it is the layout's true extent whatever the
 * LOD tree (an aggregate's `extent` compounds up the tree and would frame a coarsening tree several times
 * too loose, #327). A clean layout gets its exact bounding box.
 *
 * Robust to force-layout **fling-outs** (#206): a side drops its outermost leaves — at most
 * `min(64, 0.5% of the leaves)` of them — when they sit more than ~10-30% of the layout's size beyond the
 * rest, so one leaf flung 20× away cannot blow the frame up and shrink the rest to a dot. A group larger
 * than that is part of the layout and is framed; so is a sparse but contiguous edge (a disc's rim). The
 * trade-off: a genuinely separate group no larger than the trim count — a small disconnected component, an
 * isolate — that sits that far out is dropped the same way and opens outside the framed view (zoom out to
 * see it). Layouts under 200 leaves are never trimmed.
 *
 * Cost: O(leaves), no allocation. One branch-free pass for the exact bounds, then a count of the leaves in
 * each side's outer 5% band that certifies a layout without stragglers (and usually stops after a few
 * thousand leaves); only when a side fails that, two more passes histogram the axes (a fixed, reused 2 KB)
 * and locate its trimmed bound.
 */
export function layoutBox(positions: ArrayLike<number>, count: number): FitBox | null {
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
  const trim = Math.min(MAX_STRAGGLERS, Math.floor(finite * STRAGGLER_SHARE));
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
