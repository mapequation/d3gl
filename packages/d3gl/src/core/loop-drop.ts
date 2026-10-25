/**
 * The self-link loop (#505, #542): the shape a loop draws, on the settled link geometry of {@link legCubic}.
 *
 * A loop on a node of centre `c` and radius `r`, pointing away along `φ`, leaves along the leg `u0 = u(φ + α)` and
 * comes back along `u1 = u(φ − α)` (`u(a) = (cos a, sin a)`, `α` half the style's `selfLinkSpread`, default {@link DROP_HALF_SPREAD}). It is given by its two
 * rim ends `S = c + r·u0` and `T = c + r·u1` (`network/self-loops.ts` `loopEnds`, which also adds any #509 node
 * offset), and like an ordinary link its centre curve starts and ends at the CENTRE, the node fill hiding the part
 * inside the node:
 *
 *   straight `c → E0`, then `legCubic(c, u0, ρ, c, u1, ρ, ℓ)` = `E0, E0 + ℓ·u0, E1 + ℓ·u1, E1`, then
 *
 * with `ρ = r + h` at both ends (`E_k = c + ρ·u_k`), `h` the straight pieces' length past the rim and the leg `ℓ = L·r`
 * (`L` the style's `selfLinkLength`, default {@link LOOP_LEG}). `h` = {@link loopPieceLength} is the same in every
 * variant, so the path never changes with the style: only the head comes and goes. The undirected loop goes on
 * straight `E1 → c`; the arrow ends in a head `headLength(arrowSize)` long and the half-arrow in its one-sided barb
 * {@link loopHalfHeadLength} long, each with its tip `T` on the rim and its base on the end piece, the piece straight
 * shaft from `E1` down to the base. Apart from the head, every variant is mirror-symmetric about `φ`, and the far end,
 * `B(½) = c + (4ρ + 3ℓ)·cos α/4 · u(φ)`, lies on the axis.
 *
 * The centre need not be stored: with the chord `D = T − S` and `n = cot α·⟂(D)/2`, `S − c = n − D/2 = r·u0` and
 * `T − c = n + D/2 = r·u1`. Every point is linear in the two ends (and `h`), so the loop on projected ends is the
 * projection of the world loop.
 *
 * The writers are scalar math into module scratch and the caller's output buffer: no allocation per loop. Perp
 * convention as `arrowhead.ts`: `perp(v) = (−v.y, v.x)`, and `+perp(travel)` is the loop's OUTSIDE.
 */
import { barbOverhang, headHalfWidth, headLength, legCubic, offsetCubic, type PointBuffer } from "./arrowhead.js";

/** The angle between the loop's two legs at the centre (degrees): the default of the network style's `selfLinkSpread`. */
export const LOOP_SPREAD = 25;
/** Half the angle between the loop's two legs at the centre (radians): the default `α`, half {@link LOOP_SPREAD}. */
export const DROP_HALF_SPREAD = (LOOP_SPREAD * Math.PI) / 360;
/** `cot α`: recovers the loop's centre from its rim ends ({@link solveLoop}); the WebGL loop lane reads it as `u_loopCot`.
 *  The default; the writers take `cot α` as an argument ({@link spreadCot}). */
export const DROP_COT = 1 / Math.tan(DROP_HALF_SPREAD);
/** The loop's leg length in node radii (`ℓ = L·r`): with {@link DROP_HALF_SPREAD}, the teardrop. The default of the
 *  network style's `selfLinkLength`: the writers take `L` as an argument, and the WebGL loop lane reads it per loop
 *  from its `bends` column. */
export const LOOP_LEG = 1;

/** The narrowest and widest leg spread a loop is drawn at (degrees): at 0° its centre is at infinity (`cot α = ∞`), so
 *  the outline would be NaN, and from 180° the legs no longer open away from the node. */
const LOOP_SPREAD_MIN = 1;
const LOOP_SPREAD_MAX = 179;

/** A style's `selfLinkSpread` (degrees) as drawn: clamped to [1°, 179°]; absent or NaN ⇒ {@link LOOP_SPREAD}. Once per
 *  style resolution. */
export function resolveLoopSpread(deg: number | undefined): number {
  if (deg === undefined || Number.isNaN(deg)) return LOOP_SPREAD;
  return Math.min(LOOP_SPREAD_MAX, Math.max(LOOP_SPREAD_MIN, deg));
}

/** A style's `selfLinkLength` (node radii) as drawn: at least 0 (a negative leg has no loop); absent or NaN ⇒
 *  {@link LOOP_LEG}. Once per style resolution. */
export function resolveLoopLength(length: number | undefined): number {
  if (length === undefined || Number.isNaN(length)) return LOOP_LEG;
  return Math.max(0, length);
}

/** `cot α` for half-spread `α` (radians): what the writers and the WebGL loop lane solve the centre with. */
export function spreadCot(halfSpread: number): number {
  return 1 / Math.tan(halfSpread);
}

/** `cot α` of a `loops` layer's `spread` (radians, the full angle; absent ⇒ {@link DROP_COT}). */
export function loopsSpreadCot(spread: number | undefined): number {
  return spread === undefined ? DROP_COT : spreadCot(spread / 2);
}

/** The length `h` a loop's straight pieces run past the rim, in every variant: `max(2·arrowSize, 10·∛width)`, long
 *  enough for either head ({@link headLength}, {@link loopHalfHeadLength}), so the path is the same with or without
 *  one. Per loop (its `width`); the loop lane's twin is `INSTANCED_LOOP_VS`. */
export function loopPieceLength(arrowSize: number, width: number): number {
  return Math.max(headLength(arrowSize), loopHalfHeadLength(width));
}

/** The path context a loop traces into (Canvas, SVG, the export recorder). */
export interface DropContext {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** The half-arrow loop's head length for band width `width`: an ordinary half-arrow's `10·∛width`
 *  (`half-link.ts` `tipLength`, uncapped: a loop's legs are always long enough). */
export function loopHalfHeadLength(width: number): number {
  return 10 * Math.pow(width, 1 / 3);
}

/** Module scratch: the loop's frame (`c`, `r`, `u0`, `u1`), then its cubic's four controls. Refilled per call. */
const FRAME = new Float64Array(7);
const CUBIC = new Float64Array(8);

/**
 * Solve the loop's frame from its rim ends `(sx, sy)` = `S` and `(tx, ty)` = `T` into {@link FRAME}, and its centre
 * cubic for head length `h` and leg `L` into {@link CUBIC}: `c = S − (n − D/2)`, `r = |n − D/2|`, `u0 = (S − c)/r`,
 * `u1 = (T − c)/r`, then `legCubic(c, u0, r + h, c, u1, r + h, L·r)`, with `n = cot·⟂(D)/2`. Returns `r` (0 for
 * coincident ends: no loop).
 */
function solveLoop(sx: number, sy: number, tx: number, ty: number, h: number, leg: number, cot: number): number {
  const hx = 0.5 * (tx - sx);
  const hy = 0.5 * (ty - sy);
  const nx = -hy * cot;
  const ny = hx * cot;
  const a0x = nx - hx, a0y = ny - hy; // S − c = r·u0
  const r = Math.hypot(a0x, a0y);
  if (!(r > 0)) return 0;
  const cx = sx - a0x, cy = sy - a0y;
  const u0x = a0x / r, u0y = a0y / r;
  const u1x = (nx + hx) / r, u1y = (ny + hy) / r; // (T − c)/r
  FRAME[0] = cx;
  FRAME[1] = cy;
  FRAME[2] = r;
  FRAME[3] = u0x;
  FRAME[4] = u0y;
  FRAME[5] = u1x;
  FRAME[6] = u1y;
  legCubic(CUBIC, 0, cx, cy, u0x, u0y, r + h, cx, cy, u1x, u1y, r + h, leg * r);
  return r;
}

/**
 * Trace the loop's centre line (the stroked, undirected loop), given its rim ends `(sx, sy)`, `(tx, ty)` and
 * piece length `h` ({@link loopPieceLength}, so every variant runs along the same path): `moveTo(c)`, `lineTo(E0)`,
 * `bezierCurveTo(E0 + ℓ·u0, E1 + ℓ·u1, E1)`, `lineTo(c)`, with `E_k = c + (r + h)·u_k` and `ℓ = leg·r`. `cot` = `cot α`
 * of the ends' half-spread ({@link spreadCot}).
 */
export function traceLoop(ctx: Pick<DropContext, "moveTo" | "lineTo" | "bezierCurveTo">, sx: number, sy: number, tx: number, ty: number, h: number, leg = LOOP_LEG, cot = DROP_COT): void {
  if (solveLoop(sx, sy, tx, ty, h, leg, cot) === 0) return;
  const cx = FRAME[0] ?? 0, cy = FRAME[1] ?? 0;
  ctx.moveTo(cx, cy);
  ctx.lineTo(CUBIC[0] ?? 0, CUBIC[1] ?? 0);
  ctx.bezierCurveTo(CUBIC[2] ?? 0, CUBIC[3] ?? 0, CUBIC[4] ?? 0, CUBIC[5] ?? 0, CUBIC[6] ?? 0, CUBIC[7] ?? 0);
  ctx.lineTo(cx, cy);
}

/**
 * Write the loop's two edges, offset `first` and `second` along `+perp(travel)` from its centre path `c → E0 → (cubic)
 * → E1` (the {@link solveLoop} scratch): the first edge forwards at points `0 … M` (point 0 off `c`, with the straight
 * leg's normal `perp(u0)`; point `1 + i` off the cubic at `t = i/(M−1)`), the second backwards at points
 * `last − 0 … last − M`. The cubic's end normal is exactly `perp(−u1)`, the head's.
 */
function writeLoopEdges(out: PointBuffer, o: number, m: number, first: number, second: number, last: number): void {
  const p0x = CUBIC[0] ?? 0, p0y = CUBIC[1] ?? 0, p1x = CUBIC[2] ?? 0, p1y = CUBIC[3] ?? 0;
  const p2x = CUBIC[4] ?? 0, p2y = CUBIC[5] ?? 0, p3x = CUBIC[6] ?? 0, p3y = CUBIC[7] ?? 0;
  const u0x = FRAME[3] ?? 0, u0y = FRAME[4] ?? 0, u1x = FRAME[5] ?? 0, u1y = FRAME[6] ?? 0;
  for (let k = 0; k <= m; k++) {
    let px: number;
    let py: number;
    let nx: number;
    let ny: number;
    if (k === 0) {
      px = FRAME[0] ?? 0;
      py = FRAME[1] ?? 0;
      nx = -u0y;
      ny = u0x;
    } else if (k === 1) {
      px = p0x;
      py = p0y;
      nx = -u0y;
      ny = u0x;
    } else if (k === m) {
      px = p3x;
      py = p3y;
      nx = u1y; // perp(−u1)
      ny = -u1x;
    } else {
      const t = (k - 1) / (m - 1);
      const a = 1 - t;
      px = a * a * a * p0x + 3 * a * a * t * p1x + 3 * a * t * t * p2x + t * t * t * p3x;
      py = a * a * a * p0y + 3 * a * a * t * p1y + 3 * a * t * t * p2y + t * t * t * p3y;
      // B'(t)/3 = (1−t)²(P1 − P0) + 2(1−t)t(P2 − P1) + t²(P3 − P2)
      const gx = a * a * (p1x - p0x) + 2 * a * t * (p2x - p1x) + t * t * (p3x - p2x);
      const gy = a * a * (p1y - p0y) + 2 * a * t * (p2y - p1y) + t * t * (p3y - p2y);
      const gl = Math.hypot(gx, gy) || 1;
      nx = -gy / gl;
      ny = gx / gl;
    }
    const fi = o + 2 * k;
    const si = o + 2 * (last - k);
    out[fi] = px + nx * first;
    out[fi + 1] = py + ny * first;
    out[si] = px + nx * second;
    out[si + 1] = py + ny * second;
  }
}

/**
 * Write the arrow loop's head into `out` at `o` (the {@link solveLoop} scratch, piece length `h`): the head of length
 * `hl` ≤ `h` on the end piece, its base `B = c + (r + hl)·u1` and its tip `T = c + r·u1` on the rim. With `shaft`, the
 * shaft's end corners `B ± (width/2)·n` frame it (the straight shaft from `E1` down to the base): `B + (width/2)·n`,
 * the left barb `B + hw·n`, `T`, the right barb `B − hw·n`, `B − (width/2)·n` (`n = perp(−u1)`, `hw` =
 * `headHalfWidth(width)`); without, the middle three. Returns the point count (5 or 3).
 */
function writeArrowHead(out: PointBuffer, o: number, r: number, width: number, hl: number, shaft: boolean): number {
  const cx = FRAME[0] ?? 0, cy = FRAME[1] ?? 0, u1x = FRAME[5] ?? 0, u1y = FRAME[6] ?? 0;
  const bx = cx + (r + hl) * u1x, by = cy + (r + hl) * u1y;
  const hw = headHalfWidth(width);
  const half = width / 2;
  let i = o;
  if (shaft) {
    out[i++] = bx + u1y * half;
    out[i++] = by - u1x * half;
  }
  out[i++] = bx + u1y * hw;
  out[i++] = by - u1x * hw;
  out[i++] = cx + r * u1x;
  out[i++] = cy + r * u1y;
  out[i++] = bx - u1y * hw;
  out[i++] = by + u1x * hw;
  if (shaft) {
    out[i++] = bx - u1y * half;
    out[i++] = by + u1x * half;
  }
  return (i - o) / 2;
}

/**
 * Write the half-arrow loop's head into `out` at `o`, as {@link writeArrowHead}: the tip `T = c + r·u1` on the rim
 * (on the inner edge, the centre path, which runs on straight from `E1`), the barb `B + (width + 2√width)·n` and, with
 * `shaft`, the outer edge's corner `B + width·n` at the base `B = c + (r + hl)·u1`. Returns the point count (3 or 2).
 */
function writeHalfArrowHead(out: PointBuffer, o: number, r: number, width: number, hl: number, shaft: boolean): number {
  const cx = FRAME[0] ?? 0, cy = FRAME[1] ?? 0, u1x = FRAME[5] ?? 0, u1y = FRAME[6] ?? 0;
  const bx = cx + (r + hl) * u1x, by = cy + (r + hl) * u1y;
  const reach = width + barbOverhang(width);
  out[o] = cx + r * u1x;
  out[o + 1] = cy + r * u1y;
  out[o + 2] = bx + u1y * reach;
  out[o + 3] = by - u1x * reach;
  if (!shaft) return 2;
  out[o + 4] = bx + u1y * width;
  out[o + 5] = by - u1x * width;
  return 3;
}

/**
 * Test-only reference outline: no renderer calls it (Canvas/SVG/`toSVG()` draw {@link traceLoopArrowOutline}, WebGL its
 * shader twin); the tests pin both against it.
 *
 * Write the directed (`line` style) loop as ONE closed outline of sampled points (the reference that
 * {@link traceLoopArrowOutline}, what Canvas/SVG/`toSVG()` fill, approximates with cubic edges), as `arrowOutline` does
 * for a link: the shaft's left edge (`+width/2` along `perp(travel)`, the loop's outside) from `c` through the straight
 * leg and `samples` points on the cubic to `E1`, on down the end piece to the head's base `B`; the left barb, the tip
 * `T = c + r·u1` on the rim, the right barb; the right edge (`−width/2`) back to `c` ({@link writeArrowHead}). The
 * pieces are `h` = {@link loopPieceLength} long and the head `headLength(arrowSize)`; where the two are equal, the
 * shaft's corners at `B` repeat those at `E1`. Writes `2·(2·samples + 7)` numbers at `o`; returns the point count
 * `2·samples + 7` (0 for coincident ends). `leg` = L, `cot` = `cot α`.
 */
export function loopArrowOutline(out: PointBuffer, o: number, sx: number, sy: number, tx: number, ty: number, width: number, arrowSize: number, samples: number, leg = LOOP_LEG, cot = DROP_COT): number {
  const r = solveLoop(sx, sy, tx, ty, loopPieceLength(arrowSize, width), leg, cot);
  if (r === 0) return 0;
  const m = Math.max(2, samples | 0);
  writeLoopEdges(out, o, m, width / 2, -width / 2, 2 * m + 6);
  writeArrowHead(out, o + 2 * (m + 1), r, width, headLength(arrowSize), true);
  return 2 * m + 7;
}

/**
 * Test-only reference outline: no renderer calls it (Canvas/SVG/`toSVG()` draw {@link traceLoopHalfArrowOutline}, WebGL
 * its shader twin); the tests pin both against it.
 *
 * Write the `half-arrow` loop as ONE closed outline of sampled points ({@link traceLoopHalfArrowOutline}'s reference): the band between offsets 0 (the inner edge, the centre path
 * itself) and `+width` (the outer edge, on the loop's outside). The inner edge runs `c → E0 → (cubic) → E1` (points
 * `0 … samples`), then the tip `T = c + r·u1` on the rim, the barb `B + (width + 2√width)·n` (`n = perp(−u1)`) at the
 * head's base `B`, and the outer edge back from `B + width·n` through `E1 + width·n` to `c + width·perp(u0)`
 * ({@link writeHalfArrowHead}). The pieces are `h` = {@link loopPieceLength} long and the head
 * {@link loopHalfHeadLength}; where the two are equal, `B + width·n` repeats `E1 + width·n`. Writes
 * `2·(2·samples + 5)` numbers at `o`; returns the point count `2·samples + 5` (0 for coincident ends). `leg` = L,
 * `cot` = `cot α`.
 */
export function loopHalfArrowOutline(out: PointBuffer, o: number, sx: number, sy: number, tx: number, ty: number, width: number, arrowSize: number, samples: number, leg = LOOP_LEG, cot = DROP_COT): number {
  const r = solveLoop(sx, sy, tx, ty, loopPieceLength(arrowSize, width), leg, cot);
  if (r === 0) return 0;
  const m = Math.max(2, samples | 0);
  writeLoopEdges(out, o, m, 0, width, 2 * m + 4);
  writeHalfArrowHead(out, o + 2 * (m + 1), r, width, loopHalfHeadLength(width), true);
  return 2 * m + 5;
}

/** Module scratch for the traced loop outlines: the centre cubic's two halves, then each edge's two offset halves
 *  ({@link offsetCubic}): 48 numbers. */
const HALVES = new Float64Array(16);
const EDGE = new Float64Array(32);

/**
 * Trace one loop edge pair as ONE closed outline, `first` and `second` along `+perp(travel)` off the centre path
 * `c → E0 → (cubic) → E1` (the {@link solveLoop} scratch), as {@link writeLoopEdges} samples it but with each cubic
 * edge as TWO cubics: the centre cubic splits at `t = ½` (the loop turns ~155°, and one offset cubic per half keeps
 * within 0.05·w of the exact offset where one for the whole stays within only ~0.1·w), each half offset by
 * {@link offsetCubic}. The first edge runs forwards from `c`, then the `count` points of `head`, then the second edge
 * back to `c`. Every point × `scale`.
 */
function traceLoopEdges(ctx: DropContext, first: number, second: number, head: ArrayLike<number>, count: number, scale: number): void {
  const s = scale;
  const cx = FRAME[0] ?? 0, cy = FRAME[1] ?? 0;
  // The straight leg's normal perp(u0) is the cubic's start normal: the edge runs on with no corner.
  const nx = -(FRAME[4] ?? 0), ny = FRAME[3] ?? 0;
  // de Casteljau at ½: the halves P0, a, ab, m and m, bc, c, P3.
  for (let k = 0; k < 2; k++) {
    const p0 = CUBIC[k] ?? 0, p1 = CUBIC[2 + k] ?? 0, p2 = CUBIC[4 + k] ?? 0, p3 = CUBIC[6 + k] ?? 0;
    const a = (p0 + p1) / 2, b = (p1 + p2) / 2, c = (p2 + p3) / 2;
    const ab = (a + b) / 2, bc = (b + c) / 2;
    HALVES[k] = p0;
    HALVES[2 + k] = a;
    HALVES[4 + k] = ab;
    HALVES[6 + k] = HALVES[8 + k] = (ab + bc) / 2;
    HALVES[10 + k] = bc;
    HALVES[12 + k] = c;
    HALVES[14 + k] = p3;
  }
  offsetCubic(HALVES, 0, first, EDGE, 0);
  offsetCubic(HALVES, 8, first, EDGE, 8);
  offsetCubic(HALVES, 0, second, EDGE, 16);
  offsetCubic(HALVES, 8, second, EDGE, 24);
  const e = EDGE;
  ctx.moveTo((cx + nx * first) * s, (cy + ny * first) * s);
  ctx.lineTo((e[0] ?? 0) * s, (e[1] ?? 0) * s);
  ctx.bezierCurveTo((e[2] ?? 0) * s, (e[3] ?? 0) * s, (e[4] ?? 0) * s, (e[5] ?? 0) * s, (e[6] ?? 0) * s, (e[7] ?? 0) * s);
  ctx.bezierCurveTo((e[10] ?? 0) * s, (e[11] ?? 0) * s, (e[12] ?? 0) * s, (e[13] ?? 0) * s, (e[14] ?? 0) * s, (e[15] ?? 0) * s);
  for (let i = 0; i < count; i++) ctx.lineTo((head[2 * i] ?? 0) * s, (head[2 * i + 1] ?? 0) * s);
  ctx.lineTo((e[30] ?? 0) * s, (e[31] ?? 0) * s);
  ctx.bezierCurveTo((e[28] ?? 0) * s, (e[29] ?? 0) * s, (e[26] ?? 0) * s, (e[27] ?? 0) * s, (e[24] ?? 0) * s, (e[25] ?? 0) * s);
  ctx.bezierCurveTo((e[20] ?? 0) * s, (e[21] ?? 0) * s, (e[18] ?? 0) * s, (e[19] ?? 0) * s, (e[16] ?? 0) * s, (e[17] ?? 0) * s);
  ctx.lineTo((cx + nx * second) * s, (cy + ny * second) * s);
  ctx.closePath();
}

/** Module scratch for a traced loop's head points (at most 5), refilled per call. */
const HEAD = new Float64Array(10);

/**
 * Trace the directed (`line` style) loop as ONE closed outline — the shape {@link loopArrowOutline} samples, with each
 * cubic edge (`±width/2` off the centre cubic) as ONE cubic ({@link offsetCubic}), so the recorder flattens it by its
 * own tolerance; the straight legs, the shaft down the end piece and the head stay straight (the shaft's corners at
 * the head's base only where the piece is longer than the head). Every point × `scale` (the screen bake's `1/k`).
 * Returns false (traces nothing) for coincident ends. `leg` = L, `cot` = `cot α`.
 */
export function traceLoopArrowOutline(ctx: DropContext, sx: number, sy: number, tx: number, ty: number, width: number, arrowSize: number, leg = LOOP_LEG, cot = DROP_COT, scale = 1): boolean {
  const h = loopPieceLength(arrowSize, width);
  const r = solveLoop(sx, sy, tx, ty, h, leg, cot);
  if (r === 0) return false;
  const hl = headLength(arrowSize);
  const n = writeArrowHead(HEAD, 0, r, width, hl, h > hl);
  traceLoopEdges(ctx, width / 2, -width / 2, HEAD, n, scale);
  return true;
}

/**
 * Trace the `half-arrow` loop as ONE closed outline — the shape {@link loopHalfArrowOutline} samples: the inner edge
 * (offset 0, the centre cubic itself), the tip and the barb, then the outer edge (`+width`, ONE cubic by
 * {@link offsetCubic}) back. Every point × `scale`. Returns false for coincident ends. `leg` = L, `cot` = `cot α`.
 */
export function traceLoopHalfArrowOutline(ctx: DropContext, sx: number, sy: number, tx: number, ty: number, width: number, arrowSize: number, leg = LOOP_LEG, cot = DROP_COT, scale = 1): boolean {
  const h = loopPieceLength(arrowSize, width);
  const r = solveLoop(sx, sy, tx, ty, h, leg, cot);
  if (r === 0) return false;
  const hl = loopHalfHeadLength(width);
  const n = writeHalfArrowHead(HEAD, 0, r, width, hl, h > hl);
  traceLoopEdges(ctx, 0, width, HEAD, n, scale);
  return true;
}

/** Trace `n` points of a written outline as one closed subpath, each × `scale` (the screen-sizeMode bake's `1/k`). */
export function traceOutline(ctx: Pick<DropContext, "moveTo" | "lineTo" | "closePath">, pts: PointBuffer, n: number, scale = 1): void {
  if (n === 0) return;
  ctx.moveTo((pts[0] ?? 0) * scale, (pts[1] ?? 0) * scale);
  for (let i = 1; i < n; i++) ctx.lineTo((pts[2 * i] ?? 0) * scale, (pts[2 * i + 1] ?? 0) * scale);
  ctx.closePath();
}
