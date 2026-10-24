/**
 * The self-link drop (#505): the shape a self-link loop draws, as a pure function of its two rim ends.
 *
 * A loop on a node of centre `c` and radius `r`, pointing away along `φ`, is given by its two rim points
 * `P0 = c + r·u(φ + α)` and `P3 = c + r·u(φ − α)` (`u(a) = (cos a, sin a)`, `α` = {@link DROP_HALF_SPREAD}). Like an
 * ordinary link, which runs centre to centre with the node fill hiding the part inside the node, it starts and
 * ends at the CENTRE: it is the cubic `c, P1, P2, c` with `P1 = c + L·u(φ + α)` and `P2 = c + L·u(φ − α)`. Both
 * legs are radial by construction, the loop is symmetric about `φ`, and its far end, `B(½) = c + ¾·L·cos α·u(φ)`,
 * lies `¾·L·cos α ≈ 2.3` radii out. The arrowhead's tip is `P3`, one radius back from the centre along the end
 * tangent, as an ordinary link's.
 *
 * The centre need not be stored: with the chord `D = P3 − P0` and `n = ⟂(D)/2 = (−D.y, D.x)/2`,
 * `P0 − c = cot α·n − D/2` and `P3 − c = cot α·n + D/2`, so `c = P0 − (P0 − c)`, `P1 = P0 + reach·(P0 − c)` and
 * `P2 = P3 + reach·(P3 − c)` with `reach = L/r − 1`. Every point is linear in the two ends, so the drop on projected
 * ends is the projection of the world drop (a similarity), and the WebGL lanes ({@link DROP_LINE_GLSL}) read nothing
 * more than an ordinary link: its two ends and one per-instance number (`reach`, in the `bends` column).
 */

/** Half the angle between the drop's two legs at the centre (radians). */
export const DROP_HALF_SPREAD = (35 * Math.PI) / 180;
/** How far the cubic's control points sit from the centre, in node radii (`L / r`): the far end at `¾·L·cos α ≈ 2.3`
 *  radii, the loop as wide as the rim it leaves. */
export const DROP_LENGTH = 3.75;
/** The control reach beyond the rim, in node radii: the value the drop lanes read from `bends`. */
export const DROP_REACH = DROP_LENGTH - 1;
/** `cot α`, as the shaders bake it. */
export const DROP_COT = 1 / Math.tan(DROP_HALF_SPREAD);

/**
 * The half-arrow band's outer control offsets, per unit width, in each leg's own frame (`u` along the leg, `o` its
 * outward normal): the outer edge's control points are `P1 + width·(ALONG·u0 + ACROSS·o0)` and
 * `P2 + width·(ALONG·u3 + ACROSS·o3)`, its ends `width·o` from the inner edge's. The drop is the same shape for every
 * loop (a similarity of the {@link DROP_LENGTH} / {@link DROP_HALF_SPREAD} cubic), so one fitted pair keeps the
 * band's width within 9% of `width` (2.5% across the far end) along the whole curve, from the centre round the far end to the head, for widths
 * from 0.05 to 5 node radii (moving the controls straight out by `width·o` crosses the edges at the far end). Refit
 * both if the drop's constants change: the unit test pins the width.
 */
export const DROP_OUTER_ALONG = 2.35;
/** See {@link DROP_OUTER_ALONG}. */
export const DROP_OUTER_ACROSS = 0.74;

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

/** Trace the drop's centre line, from the node centre back to it, given its rim ends `(sx, sy)` and `(tx, ty)`. */
export function traceDrop(ctx: Pick<DropContext, "moveTo" | "bezierCurveTo">, sx: number, sy: number, tx: number, ty: number, reach: number): void {
  const hx = 0.5 * (tx - sx);
  const hy = 0.5 * (ty - sy);
  const a0x = -hy * DROP_COT - hx; // P0 − c
  const a0y = hx * DROP_COT - hy;
  const cx = sx - a0x, cy = sy - a0y;
  const [c1x, c1y, c2x, c2y] = dropControls(sx, sy, tx, ty, reach);
  ctx.moveTo(cx, cy);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, cx, cy);
}

/**
 * Trace the drop as one filled half-arrow glyph (the `half-arrow` link style): its inner edge is the drop from
 * the node centre to the head's base, its outer edge the same drop moved `width` OUTSIDE the loop (each leg
 * along its own normal, so the legs stay parallel, with the controls offset by {@link DROP_OUTER_ALONG} so the band keeps
 * the same width round the far end), and its barbed head lands its tip on the rim at `(tx, ty)`,
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
  const cx = sx - a0x, cy = sy - a0y; // the centre, where both legs start
  const s = scale;
  ctx.moveTo(cx * s, cy * s);
  ctx.bezierCurveTo(c1x * s, c1y * s, c2x * s, c2y * s, bx * s, by * s);
  ctx.lineTo(tx * s, ty * s);
  ctx.lineTo((bx + (width + barb) * o3x) * s, (by + (width + barb) * o3y) * s);
  ctx.lineTo((bx + width * o3x) * s, (by + width * o3y) * s);
  const ka = DROP_OUTER_ALONG * width;
  const kc = DROP_OUTER_ACROSS * width;
  const d1x = c1x + ka * u0x + kc * o0x, d1y = c1y + ka * u0y + kc * o0y;
  const d2x = c2x + ka * u3x + kc * o3x, d2y = c2y + ka * u3y + kc * o3y;
  ctx.bezierCurveTo(d2x * s, d2y * s, d1x * s, d1y * s, (cx + width * o0x) * s, (cy + width * o0y) * s);
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
