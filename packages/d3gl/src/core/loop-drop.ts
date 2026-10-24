/**
 * The self-link loop (#505, #542): the shape a loop draws, on the settled link geometry of {@link legCubic}.
 *
 * A loop on a node of centre `c` and radius `r`, pointing away along `φ`, leaves along the leg `u0 = u(φ + α)` and
 * comes back along `u1 = u(φ − α)` (`u(a) = (cos a, sin a)`, `α` = {@link DROP_HALF_SPREAD}). It is given by its two
 * rim ends `S = c + r·u0` and `T = c + r·u1` (`network/self-loops.ts` `loopEnds`, which also adds any #509 node
 * offset), and like an ordinary link its centre curve starts and ends at the CENTRE, the node fill hiding the part
 * inside the node:
 *
 *   straight `c → E0`, then `legCubic(c, u0, ρ, c, u1, ρ, ℓ)` = `E0, E0 + ℓ·u0, E1 + ℓ·u1, E1`, then
 *
 * with `ρ = r + h` at both ends (`E_k = c + ρ·u_k`), `h` the head length and the leg `ℓ = L·r` ({@link LOOP_LEG}).
 * The undirected loop goes on straight `E1 → c`; the arrow ends in a head whose base is on `E1` and whose tip is `T`,
 * on the rim; the half-arrow ends in its one-sided barb. `h` is the same for the undirected loop and the arrow
 * (`headLength(arrowSize)`), so toggling `directed` only adds or removes the head; the half-arrow's is
 * {@link loopHalfHeadLength}. Apart from the head, every variant is mirror-symmetric about `φ`, and the far end,
 * `B(½) = c + (4ρ + 3ℓ)·cos α/4 · u(φ)`, lies on the axis.
 *
 * The centre need not be stored: with the chord `D = T − S` and `n = cot α·⟂(D)/2`, `S − c = n − D/2 = r·u0` and
 * `T − c = n + D/2 = r·u1`. Every point is linear in the two ends (and `h`), so the loop on projected ends is the
 * projection of the world loop.
 *
 * The writers are scalar math into module scratch and the caller's output buffer: no allocation per loop. Perp
 * convention as `arrowhead.ts`: `perp(v) = (−v.y, v.x)`, and `+perp(travel)` is the loop's OUTSIDE.
 */
import { barbOverhang, headHalfWidth, legCubic, type PointBuffer } from "./arrowhead.js";

/** Half the angle between the loop's two legs at the centre (radians). */
export const DROP_HALF_SPREAD = (20 * Math.PI) / 180;
/** `cot α`: recovers the loop's centre from its rim ends ({@link solveLoop}); the shaders bake it too. */
export const DROP_COT = 1 / Math.tan(DROP_HALF_SPREAD);
/** The loop's leg length in node radii (`ℓ = L·r`): with {@link DROP_HALF_SPREAD}, the teardrop. */
export const LOOP_LEG = 3;

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
 * cubic for head length `h` into {@link CUBIC}: `c = S − (n − D/2)`, `r = |n − D/2|`, `u0 = (S − c)/r`,
 * `u1 = (T − c)/r`, then `legCubic(c, u0, r + h, c, u1, r + h, L·r)`. Returns `r` (0 for coincident ends: no loop).
 */
function solveLoop(sx: number, sy: number, tx: number, ty: number, h: number): number {
  const hx = 0.5 * (tx - sx);
  const hy = 0.5 * (ty - sy);
  const nx = -hy * DROP_COT;
  const ny = hx * DROP_COT;
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
  legCubic(CUBIC, 0, cx, cy, u0x, u0y, r + h, cx, cy, u1x, u1y, r + h, LOOP_LEG * r);
  return r;
}

/**
 * Trace the loop's centre line (the stroked, undirected loop), given its rim ends `(sx, sy)`, `(tx, ty)` and head
 * length `h` (`headLength(arrowSize)`, so the arrow loop runs along the same path): `moveTo(c)`, `lineTo(E0)`,
 * `bezierCurveTo(E0 + ℓ·u0, E1 + ℓ·u1, E1)`, `lineTo(c)`, with `E_k = c + (r + h)·u_k` and `ℓ = L·r`.
 */
export function traceLoop(ctx: Pick<DropContext, "moveTo" | "lineTo" | "bezierCurveTo">, sx: number, sy: number, tx: number, ty: number, h: number): void {
  if (solveLoop(sx, sy, tx, ty, h) === 0) return;
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
 * Write the directed (`line` style) loop as ONE closed outline (Canvas/SVG/`toSVG()` fill), as `arrowOutline` does
 * for a link: the shaft's left edge (`+width/2` along `perp(travel)`, the loop's outside) from `c` through the straight
 * leg and `samples` points on the cubic to `E1`; the left barb `E1 + hw·n`, the tip `T = c + r·u1` on the rim, the
 * right barb `E1 − hw·n` (`n = perp(−u1)`, `hw` = `headHalfWidth(width)`); the right edge (`−width/2`) back to `c`. The
 * head's base is on `E1 = c + (r + h)·u1`, so the shaft's end corners land on it. `h` = `headLength(arrowSize)`.
 * Writes `2·(2·samples + 5)` numbers at `o`; returns the point count `2·samples + 5` (0 for coincident ends).
 */
export function loopArrowOutline(out: PointBuffer, o: number, sx: number, sy: number, tx: number, ty: number, width: number, h: number, samples: number): number {
  const r = solveLoop(sx, sy, tx, ty, h);
  if (r === 0) return 0;
  const m = Math.max(2, samples | 0);
  writeLoopEdges(out, o, m, width / 2, -width / 2, 2 * m + 4);
  const u1x = FRAME[5] ?? 0, u1y = FRAME[6] ?? 0;
  const ex = CUBIC[6] ?? 0, ey = CUBIC[7] ?? 0;
  const hw = headHalfWidth(width);
  const b = o + 2 * (m + 1);
  out[b] = ex + u1y * hw;
  out[b + 1] = ey - u1x * hw;
  out[b + 2] = (FRAME[0] ?? 0) + r * u1x;
  out[b + 3] = (FRAME[1] ?? 0) + r * u1y;
  out[b + 4] = ex - u1y * hw;
  out[b + 5] = ey + u1x * hw;
  return 2 * m + 5;
}

/**
 * Write the `half-arrow` loop as ONE closed outline: the band between offsets 0 (the inner edge, the centre path
 * itself) and `+width` (the outer edge, on the loop's outside). The inner edge runs `c → E0 → (cubic) → E1` (points
 * `0 … samples`), then the tip `T = c + r·u1` on the rim, the barb `E1 + (width + 2√width)·n` (`n = perp(−u1)`), and
 * the outer edge back from `E1 + width·n` to `c + width·perp(u0)`. Head length `h` = {@link loopHalfHeadLength}.
 * Writes `2·(2·samples + 4)` numbers at `o`; returns the point count `2·samples + 4` (0 for coincident ends).
 */
export function loopHalfArrowOutline(out: PointBuffer, o: number, sx: number, sy: number, tx: number, ty: number, width: number, samples: number): number {
  const r = solveLoop(sx, sy, tx, ty, loopHalfHeadLength(width));
  if (r === 0) return 0;
  const m = Math.max(2, samples | 0);
  writeLoopEdges(out, o, m, 0, width, 2 * m + 3);
  const u1x = FRAME[5] ?? 0, u1y = FRAME[6] ?? 0;
  const reach = width + barbOverhang(width);
  const b = o + 2 * (m + 1);
  out[b] = (FRAME[0] ?? 0) + r * u1x;
  out[b + 1] = (FRAME[1] ?? 0) + r * u1y;
  out[b + 2] = (CUBIC[6] ?? 0) + u1y * reach;
  out[b + 3] = (CUBIC[7] ?? 0) - u1x * reach;
  return 2 * m + 4;
}

/** Trace `n` points of a written outline as one closed subpath, each × `scale` (the screen-sizeMode bake's `1/k`). */
export function traceOutline(ctx: Pick<DropContext, "moveTo" | "lineTo" | "closePath">, pts: PointBuffer, n: number, scale = 1): void {
  if (n === 0) return;
  ctx.moveTo((pts[0] ?? 0) * scale, (pts[1] ?? 0) * scale);
  for (let i = 1; i < n; i++) ctx.lineTo((pts[2 * i] ?? 0) * scale, (pts[2 * i + 1] ?? 0) * scale);
  ctx.closePath();
}

// ---------------------------------------------------------------------------------------------------------------
// WebGL (#505 drop, pending the #542 WebGL step): the loop lanes still draw the old centre-to-centre drop cubic from
// the GLSL below and these constants. The WebGL step replaces this whole block with the {@link legCubic} loop above.
// ---------------------------------------------------------------------------------------------------------------

/** The old drop's control distance from the centre, in node radii (WebGL lanes only, see the block note). */
export const DROP_LENGTH = 3.75;
/** The old drop's control reach beyond the rim, in node radii: the value the drop lanes read from `bends`. */
export const DROP_REACH = DROP_LENGTH - 1;
/** The old half-arrow drop's fitted outer control offsets, per unit width (WebGL lane only, see the block note). */
export const DROP_OUTER_ALONG = 2.35;
/** See {@link DROP_OUTER_ALONG}. */
export const DROP_OUTER_ACROSS = 0.74;

const f = (x: number): string => x.toPrecision(9);

/**
 * GLSL for the drop line lane: from `src` / `tgt` (the projected or world rim ends), the chord `d` taken from the end
 * offsets (exact: both centres are one point) and `a_bend` = reach, the sample `p` and tangent `tang` at `t` of the
 * cubic from the centre `cc` back to it.
 * Replaces the quadratic of the ordinary line lane; the ordinary lane's program is untouched.
 */
export const DROP_LINE_GLSL = `
  vec2 h = 0.5 * (a_targetOffset - a_sourceOffset);
  vec2 n = vec2(-h.y, h.x) * ${f(DROP_COT)};
  vec2 c1 = src + a_bend * (n - h);
  vec2 c2 = tgt + a_bend * (n + h);
  vec2 cc = src - (n - h);
  float u = 1.0 - t;
  vec2 p = (u * u * u + t * t * t) * cc + 3.0 * u * u * t * c1 + 3.0 * u * t * t * c2;
  vec2 tang = 3.0 * u * u * (c1 - cc) + 6.0 * u * t * (c2 - c1) + 3.0 * t * t * (cc - c2);`;

/**
 * GLSL for the drop half-arrow lane: from `p0` / `p1` (the two rim ends; `p0` is moved to the centre, where the
 * glyph starts), `width` and `a_bend` = reach, the named
 * anchors of the half-arrow template and the two edge cubics (the old drop, see the block note).
 */
export const DROP_HALF_ARROW_GLSL = `
  vec2 h = 0.5 * (a_targetOffset - a_sourceOffset);
  vec2 n = vec2(-h.y, h.x) * ${f(DROP_COT)};
  vec2 a0 = n - h;
  vec2 a3 = n + h;
  float r = length(a3);
  vec2 u0 = a0 / r;
  vec2 u3 = a3 / r;
  vec2 o0 = vec2(-u0.y, u0.x);
  vec2 o3 = vec2(u3.y, -u3.x);
  float tipLength = min(a_bend * r * 0.5, 10.0 * pow(width, 1.0 / 3.0));
  float tipWidth = 2.0 * sqrt(width);
  vec2 c1 = p0 + a_bend * a0;
  vec2 c2 = p1 + a_bend * a3;
  p0 -= a0;
  vec2 x02 = p0;
  vec2 x03 = p0 + width * o0;
  vec2 x04 = x03;
  vec2 x11 = p1;
  vec2 x12 = p1 + tipLength * u3;
  vec2 x13 = x12 + width * o3;
  vec2 x14 = x13 + tipWidth * o3;
  vec2 cp1 = c1 + width * (${f(DROP_OUTER_ALONG)} * u0 + ${f(DROP_OUTER_ACROSS)} * o0);
  vec2 cp2 = c2 + width * (${f(DROP_OUTER_ALONG)} * u3 + ${f(DROP_OUTER_ACROSS)} * o3);`;
