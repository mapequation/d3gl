/**
 * The self-link drop (#505): the shape a self-link loop draws, as a pure function of its two rim ends.
 *
 * A loop on a node of centre `c` and radius `r`, pointing away along `φ`, leaves the rim at `P0 = c + r·u(φ + α)`
 * and comes back at `P3 = c + r·u(φ − α)` (`u(a) = (cos a, sin a)`, `α` = {@link DROP_HALF_SPREAD}). It is the
 * cubic `P0, P1, P2, P3` with `P1 = c + L·u(φ + α)` and `P2 = c + L·u(φ − α)`: both end tangents are radial, so
 * the two legs leave and re-enter along lines through the centre, and the far end is round.
 *
 * The centre need not be stored: with the chord `D = P3 − P0` and `n = ⟂(D)/2 = (−D.y, D.x)/2`,
 * `P0 − c = cot α·n − D/2` and `P3 − c = cot α·n + D/2`, so `P1 = P0 + reach·(P0 − c)` and `P2 = P3 + reach·(P3 − c)`
 * with `reach = L/r − 1`. Every point is linear in the two ends, so the drop on projected ends is the
 * projection of the world drop (a similarity), and the WebGL lanes ({@link DROP_LINE_GLSL}) read nothing more
 * than an ordinary link: its two ends and one per-instance number (`reach`, in the `bends` column).
 */

/** Half the angle between the drop's two legs at the centre (radians). */
export const DROP_HALF_SPREAD = (25 * Math.PI) / 180;
/** How far the cubic's control points sit from the centre, in node radii (`L / r`). */
export const DROP_LENGTH = 3;
/** The control reach beyond the rim, in node radii: the value the drop lanes read from `bends`. */
export const DROP_REACH = DROP_LENGTH - 1;
/** `cot α`, as the shaders bake it. */
export const DROP_COT = 1 / Math.tan(DROP_HALF_SPREAD);

/** The drop's two control points from its ends `(sx, sy)` (the `P0` rim end) and `(tx, ty)` (`P3`). */
export function dropControls(sx: number, sy: number, tx: number, ty: number, reach: number): [number, number, number, number] {
  const hx = 0.5 * (tx - sx);
  const hy = 0.5 * (ty - sy);
  // n = ⟂(D)/2; P0 − c = cot α·n − D/2, P3 − c = cot α·n + D/2.
  const nx = -hy * DROP_COT;
  const ny = hx * DROP_COT;
  return [sx + reach * (nx - hx), sy + reach * (ny - hy), tx + reach * (nx + hx), ty + reach * (ny + hy)];
}

/** The path context the drop traces into (Canvas, SVG, the export recorder). */
export interface DropContext {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Trace the drop's centre line from `(sx, sy)` to `(tx, ty)`. */
export function traceDrop(ctx: Pick<DropContext, "moveTo" | "bezierCurveTo">, sx: number, sy: number, tx: number, ty: number, reach: number): void {
  const [c1x, c1y, c2x, c2y] = dropControls(sx, sy, tx, ty, reach);
  ctx.moveTo(sx, sy);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, tx, ty);
}

/**
 * Trace the drop as one filled half-arrow glyph (the `half-arrow` link style): its inner edge is the drop from
 * the rim end `(sx, sy)` to the head's base, its outer edge the same drop moved `width` OUTSIDE the loop (each leg
 * along its own normal, so the legs stay parallel), and its barbed head lands its tip on the rim at `(tx, ty)`,
 * pointing into the node. Head size as an ordinary half-arrow's (`10·∛width` long, `2·√width` barb), capped at half a
 * leg. Points are solved in the ends' space and emitted × `scale` (the screen-sizeMode bake). The GLSL twin is
 * {@link DROP_HALF_ARROW_GLSL}.
 */
export function traceDropHalfArrow(ctx: DropContext, sx: number, sy: number, tx: number, ty: number, width: number, reach: number, scale = 1): void {
  const hx = 0.5 * (tx - sx);
  const hy = 0.5 * (ty - sy);
  const nx = -hy * DROP_COT;
  const ny = hx * DROP_COT;
  const a0x = nx - hx, a0y = ny - hy; // P0 − c
  const a3x = nx + hx, a3y = ny + hy; // P3 − c
  const r = Math.hypot(a3x, a3y);
  if (!(r > 0)) return;
  const u0x = a0x / r, u0y = a0y / r;
  const u3x = a3x / r, u3y = a3y / r;
  // Outside the loop: leg 0 (at φ + α) turns +90°, leg 3 (at φ − α) turns −90°.
  const o0x = -u0y, o0y = u0x;
  const o3x = u3y, o3y = -u3x;
  const tip = Math.min((reach * r) / 2, 10 * Math.cbrt(width));
  const barb = 2 * Math.sqrt(width);
  const c1x = sx + reach * a0x, c1y = sy + reach * a0y;
  const c2x = tx + reach * a3x, c2y = ty + reach * a3y;
  const bx = tx + tip * u3x, by = ty + tip * u3y; // the head's base on the inner edge
  const s = scale;
  ctx.moveTo(sx * s, sy * s);
  ctx.bezierCurveTo(c1x * s, c1y * s, c2x * s, c2y * s, bx * s, by * s);
  ctx.lineTo(tx * s, ty * s);
  ctx.lineTo((bx + (width + barb) * o3x) * s, (by + (width + barb) * o3y) * s);
  ctx.lineTo((bx + width * o3x) * s, (by + width * o3y) * s);
  ctx.bezierCurveTo((c2x + width * o3x) * s, (c2y + width * o3y) * s, (c1x + width * o0x) * s, (c1y + width * o0y) * s, (sx + width * o0x) * s, (sy + width * o0y) * s);
  ctx.closePath();
}

/** The drop's end tangent at `(tx, ty)` as a unit vector (radially into the node): the arrowhead's direction. */
export function dropEndTangent(sx: number, sy: number, tx: number, ty: number): [number, number] {
  const hx = 0.5 * (tx - sx);
  const hy = 0.5 * (ty - sy);
  const ax = -hy * DROP_COT + hx;
  const ay = hx * DROP_COT + hy;
  const l = Math.hypot(ax, ay) || 1;
  return [-ax / l, -ay / l];
}

const f = (x: number): string => x.toPrecision(9);

/**
 * GLSL for the drop line lane: from `src` / `tgt` (the projected or world ends), the chord `d` taken from the end
 * offsets (exact: both centres are one point) and `a_bend` = reach, the sample `p` and tangent `tang` at `t`.
 * Replaces the quadratic of the ordinary line lane; the ordinary lane's program is untouched.
 */
export const DROP_LINE_GLSL = `
  vec2 h = 0.5 * (a_targetOffset - a_sourceOffset);
  vec2 n = vec2(-h.y, h.x) * ${f(DROP_COT)};
  vec2 c1 = src + a_bend * (n - h);
  vec2 c2 = tgt + a_bend * (n + h);
  float u = 1.0 - t;
  vec2 p = u * u * u * src + 3.0 * u * u * t * c1 + 3.0 * u * t * t * c2 + t * t * t * tgt;
  vec2 tang = 3.0 * u * u * (c1 - src) + 6.0 * u * t * (c2 - c1) + 3.0 * t * t * (tgt - c2);`;

/**
 * GLSL for the drop half-arrow lane: from `p0` / `p1` (the two rim ends), `width` and `a_bend` = reach, the named
 * anchors of the half-arrow template and the two edge cubics, as {@link traceDropHalfArrow}.
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
  vec2 x02 = p0;
  vec2 x03 = p0 + width * o0;
  vec2 x04 = x03;
  vec2 x11 = p1;
  vec2 x12 = p1 + tipLength * u3;
  vec2 x13 = x12 + width * o3;
  vec2 x14 = x13 + tipWidth * o3;
  vec2 cp1 = c1 + width * o0;
  vec2 cp2 = c2 + width * o3;`;
