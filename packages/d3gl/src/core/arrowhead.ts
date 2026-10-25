/**
 * Arrow geometry (#542): a directed link and its head as ONE shape — the shaft, then the head.
 *
 * The head is an isosceles triangle on the link's end tangent: the tip sits on the target node's
 * boundary (`tip = target − dir·radius`, `dir` = the curve's unit end tangent), the base is
 * {@link headLength} back from the tip, and the head sticks out beyond the line by the same amount
 * on BOTH sides as the half-arrow style's barb sticks out on its one side ({@link barbOverhang}). So
 * the head is always wider than the line, and the shaft can end inside it where the head is exactly
 * as wide as the line ({@link shaftSetback}) — no line edge shows beside the tip, and no gap opens
 * between shaft and head, at any width.
 *
 * A link's centre curve is the settled cubic of {@link legCubic}: it leaves the source centre along the leg
 * `u0` and runs into the head's base centre along the head's axis `−u1`, where `u0`, `u1` are the directions
 * from each centre to today's quadratic control `C` = chord midpoint + ⟂(chord)·bend (as `bezierControl` in
 * `half-link.ts`). So the shaft meets the head with no sideways step and no corner, and the head's axis is
 * the bent link's end tangent. With no head (`E1 = c1`) the cubic is exactly the quadratic `P0 → C → P1`,
 * degree-elevated; a straight link is the same segment as before.
 *
 * Everything here is scalar math with no allocation beyond the caller's output buffer (and one module
 * scratch for the cubic's controls), so the
 * WebGL strip shader can mirror it line for line. Perp convention: `perp(v) = (−v.y, v.x)`; "left"
 * is `+perp`.
 */

/** A caller-owned flat `x, y, x, y, …` output buffer. */
export type PointBuffer = number[] | Float32Array | Float64Array;

/**
 * How far the half-arrow style's barb sticks out beyond its strip, for strip width `width`
 * (`half-link.ts` `tipWidth`; the GLSL twin is `2.0 * sqrt(width)` in `INSTANCED_HALF_ARROW_VS`).
 * Uses `Math.pow(w, 1/2)`, not `Math.sqrt`, so the half-arrow golden test stays bit-identical.
 */
export function barbOverhang(width: number): number {
  return 2 * Math.pow(width, 1 / 2);
}

/** Half-width of the arrowhead's base: half the line plus the barb overhang on each side. */
export function headHalfWidth(width: number): number {
  return width / 2 + barbOverhang(width);
}

/** Length of the arrowhead, tip to base, for arrow size `size` (as today's heads: 2·size). */
export function headLength(size: number): number {
  return 2 * size;
}

/**
 * Distance back from the tip where the head is exactly as wide as the line: the shaft ends there.
 * The head tapers linearly, so `s = length · (width/2) / halfWidth`; it is always `< length` for a
 * positive size (the head is wider than the line), and 0 for a zero-width line. No renderer trims here
 * (all end the shaft at the head's base, #542 step 2); kept as the reference for the tests' geometry.
 */
export function shaftSetback(width: number, size: number): number {
  const h = headHalfWidth(width);
  return h > 0 ? (headLength(size) * (width / 2)) / h : 0;
}

/** Shared inputs of the shaft/head/outline writers (world or px units, per the caller's sizeMode). */
export interface ArrowParams {
  /** Source point (the shaft starts here). */
  sx: number;
  sy: number;
  /** Target node centre. */
  tx: number;
  ty: number;
  /** Target node radius: the tip sits this far back from the centre along the end tangent. */
  radius: number;
  /** Line width. */
  width: number;
  /** Arrow size (head length = 2·size). */
  size: number;
  /** Chord-fraction bend (0 = straight), as `linkBend`; a short link draws it faded ({@link fadedBend}). */
  bend: number;
}

/**
 * The settled link curve (#542), shared by links and self-links: the cubic between two ends, each given by a
 * centre `c`, a unit leg `u` (pointing out of the end, along the curve) and an offset `ρ` along that leg, with
 * leg length `ℓ`. Writes its four control points as 8 numbers at `o`:
 *
 *   `E0 = c0 + ρ0·u0`,  `E0 + ℓ·u0`,  `E1 + ℓ·u1`,  `E1 = c1 + ρ1·u1`.
 *
 * The curve leaves `E0` along `u0` and arrives at `E1` along `−u1`. A link passes `ρ0 = 0`, `ρ1 = r1 + h`,
 * `u0 = norm(d + 2b·p)`, `u1 = norm(−d + 2b·p)` (`d = c1 − c0`, `p = ⟂d`, `b` the bend) and
 * `ℓ = |E1 − E0|·√(1 + 4b²)/3` ({@link arrowShaft}). Scalar math, no allocation: the GLSL twin
 * (`HEAD_LINE_BODY` in `webgl/shaders.ts`) mirrors it line for line.
 */
export function legCubic(
  out: PointBuffer,
  o: number,
  x0: number,
  y0: number,
  u0x: number,
  u0y: number,
  rho0: number,
  x1: number,
  y1: number,
  u1x: number,
  u1y: number,
  rho1: number,
  leg: number,
): void {
  const e0x = x0 + rho0 * u0x;
  const e0y = y0 + rho0 * u0y;
  const e1x = x1 + rho1 * u1x;
  const e1y = y1 + rho1 * u1y;
  out[o] = e0x;
  out[o + 1] = e0y;
  out[o + 2] = e0x + leg * u0x;
  out[o + 3] = e0y + leg * u0y;
  out[o + 4] = e1x + leg * u1x;
  out[o + 5] = e1y + leg * u1y;
  out[o + 6] = e1x;
  out[o + 7] = e1y;
}

/** Module scratch for a link's cubic controls (8 numbers), refilled per call: no per-link allocation. */
const CUBIC = new Float64Array(8);

/**
 * Write the shaft's edge pairs (left, right per sample — triangle-strip order, the WebGL twin) for a
 * shaft that ends `trim` back from the tip. `samples ≥ 2` points on the link's cubic ({@link legCubic},
 * `ρ1 = radius + trim`) at `t = i/(samples−1)`; the last pair takes the head's normal. Every backend
 * passes `trim = headLength(size)` (#542 step 2: the shaft ends on the head's base, as in
 * {@link arrowOutline} and the WebGL strip). Writes
 * `4·samples` numbers at `o`; returns the number of points written (0 for a zero-length link).
 */
export function arrowShaft(out: PointBuffer, o: number, p: ArrowParams, trim: number, samples: number): number {
  return writeShaft(out, o, p, arrowBend(p), trim, samples, false);
}

/**
 * The bend a headed link actually draws with (#542): a short bent link fades its bend `b` towards a floor, so
 * the curve never hooks into its own head and an opposite pair (A→B, B→A, bent to opposite sides) stays apart.
 * In the solve space (world units, or px in screen sizeMode), with `D = |c1 − c0|`, `ρ = radius + headLength(size)`
 * and `H = headHalfWidth(width)`:
 *
 *   `x = min(0.99, 1.2·H/ρ)`,  `b_floor = min(|b|, ½·x/√(1 − x²))`  (½·tan(asin x): the bend at which an
 *   opposite pair's heads just clear each other),
 *   `f = smoothstep(2ρ, 4ρ, D)`,  `b_eff = sign(b)·(|b| − (|b| − b_floor)·(1 − f))`.
 *
 * So `D ≤ 2ρ` draws `b_floor`, and `D ≥ 4ρ` draws `b` exactly (returned as is). The sign is kept. The GLSL twin
 * is the start of `HEAD_LINE_BODY` in `webgl/shaders.ts`. Only whole arrows use it: undirected lines,
 * half-arrows and self-link loops keep their bend.
 */
export function fadedBend(bend: number, dist: number, radius: number, size: number, width: number): number {
  const rho = radius + headLength(size);
  if (bend === 0 || !(rho > 0) || dist >= 4 * rho) return bend;
  const ab = Math.abs(bend);
  const x = Math.min(0.99, (1.2 * headHalfWidth(width)) / rho);
  const floor = Math.min(ab, (0.5 * x) / Math.sqrt(1 - x * x));
  const t = Math.min(1, Math.max(0, (dist - 2 * rho) / (2 * rho)));
  const f = t * t * (3 - 2 * t);
  return Math.sign(bend) * (ab - (ab - floor) * (1 - f));
}

/** {@link fadedBend} for an arrow's parameters. */
function arrowBend(p: ArrowParams): number {
  return fadedBend(p.bend, Math.hypot(p.tx - p.sx, p.ty - p.sy), p.radius, p.size, p.width);
}

/** Write the head's three points (left barb, tip, right barb) at `o`; returns 3 (0 for a zero-length link). */
export function arrowHead(out: PointBuffer, o: number, p: ArrowParams): number {
  return writeHead(out, o, p, arrowBend(p));
}

/** {@link arrowHead} with the faded bend `bend` already resolved. */
function writeHead(out: PointBuffer, o: number, p: ArrowParams, bend: number): number {
  const dx = p.tx - p.sx;
  const dy = p.ty - p.sy;
  const ex = 0.5 * dx + dy * bend;
  const ey = 0.5 * dy - dx * bend;
  const el = Math.hypot(ex, ey);
  if (el <= 0) return 0;
  const ux = ex / el;
  const uy = ey / el;
  const tipX = p.tx - ux * p.radius;
  const tipY = p.ty - uy * p.radius;
  const len = headLength(p.size);
  const hw = headHalfWidth(p.width);
  const baseX = tipX - ux * len;
  const baseY = tipY - uy * len;
  out[o] = baseX - uy * hw;
  out[o + 1] = baseY + ux * hw;
  out[o + 2] = tipX;
  out[o + 3] = tipY;
  out[o + 4] = baseX + uy * hw;
  out[o + 5] = baseY - ux * hw;
  return 3;
}

/**
 * Write the whole arrow as ONE closed, non-self-overlapping outline of sampled points — the exact offset at each
 * sample, the reference {@link traceArrowOutline} (what Canvas/SVG/`toSVG()` fill, each edge ONE cubic) approximates:
 * the shaft's left edge from the source, the left barb, the tip, the right barb, the right edge back.
 * Here the shaft is trimmed at the head's BASE (its end corners land on the base edge, inside the
 * barbs), so the outline is the exact union of shaft and head with no folded edge. Writes
 * `2·(2·samples + 3)` numbers at `o`; returns the number of points (`2·samples + 3`, or 0 for a
 * zero-length link).
 */
export function arrowOutline(out: PointBuffer, o: number, p: ArrowParams, samples: number): number {
  const bend = arrowBend(p);
  const n = writeShaft(out, o, p, bend, headLength(p.size), samples, true);
  if (n === 0) return 0;
  writeHead(out, o + 2 * samples, p, bend);
  return 2 * samples + 3;
}

/** The path context an outline traces into (Canvas, SVG, the Scene's and the export's `PathRecorder`). */
export interface OutlineContext {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Module scratch for {@link offsetCubic}'s three leg normals (6 numbers), refilled per call. */
const LEG_N = new Float64Array(6);

/** Below this `|sin|` of the angle between a cubic's end tangents, {@link offsetCubic} keeps the miter controls: the
 *  midpoint fit's 2×2 solve is ill-conditioned there, and the miter is already within 0.003·|d| (bend ≲ 0.05). */
const FIT_MIN_SIN = 0.1;

/**
 * Offset the cubic `c` (8 numbers at `ci`: `P0 … P3`) by `d` along `+perp(travel)` as ONE cubic `Q0 … Q3`, written as
 * 8 numbers at `o` (#542). A cubic's offset is not a cubic, so this approximates it:
 *
 * - the ends: each control leg (`P0P1`, `P1P2`, `P2P3`) shifts along its own unit normal by `d`, and `Q0`, `Q3` are
 *   the shifted `P0`, `P3` — exactly `d` off the curve along its end normals, with its end tangents;
 * - the inner controls lie on the shifted end legs, `Q1 = Q0 + a·T0`, `Q2 = Q3 − b·T3` (`T0`, `T3` the unit end
 *   tangents). `a`, `b` put `Q(½)` on the exact offset point `B(½) + d·N(½)`: `a·T0 − b·T3 = 8/3·(M − (Q0 + Q3)/2)`,
 *   a 2×2 solve. Where that is ill-conditioned (end tangents within {@link FIT_MIN_SIN}) or not positive, they are
 *   where the adjacent shifted legs meet instead, `P_k + d·(n_a + n_b)/(1 + n_a·n_b)` (the miter of the two normals).
 *
 * A zero-length leg borrows its neighbour's normal; a leg reversing onto its neighbour (`n_a·n_b → −1`) falls back to
 * the shifted `P_k`. Against the exact offset (`arrowhead.test.ts`), a link's edges keep within 0.03·w (0.1 px) for
 * bends up to 0.5, widths 1–10 and links of 40–400 px, several times closer than the miter alone (0.036·w). Scalar
 * math, no allocation.
 */
export function offsetCubic(c: ArrayLike<number>, ci: number, d: number, out: PointBuffer, o: number): void {
  for (let k = 0; k < 3; k++) {
    const gx = (c[ci + 2 * k + 2] ?? 0) - (c[ci + 2 * k] ?? 0);
    const gy = (c[ci + 2 * k + 3] ?? 0) - (c[ci + 2 * k + 1] ?? 0);
    const gl = Math.hypot(gx, gy);
    LEG_N[2 * k] = gl > 0 ? -gy / gl : Number.NaN;
    LEG_N[2 * k + 1] = gl > 0 ? gx / gl : Number.NaN;
  }
  // Borrow across zero-length legs: the middle from either end, then the ends from the middle.
  if (Number.isNaN(LEG_N[2] ?? 0)) {
    const from = Number.isNaN(LEG_N[0] ?? 0) ? 4 : 0;
    LEG_N[2] = LEG_N[from] ?? 0;
    LEG_N[3] = LEG_N[from + 1] ?? 0;
  }
  for (let k = 0; k <= 4; k += 4) {
    if (Number.isNaN(LEG_N[k] ?? 0)) {
      LEG_N[k] = LEG_N[2] ?? 0;
      LEG_N[k + 1] = LEG_N[3] ?? 0;
    }
  }
  for (let k = 0; k < 4; k++) {
    // Point k's normal: the end legs' own at P0/P3, the two adjacent legs' miter at P1/P2.
    const a = k === 0 ? 0 : 2 * (k - 1);
    const b = k === 3 ? 4 : 2 * k;
    const ax = LEG_N[a] ?? 0, ay = LEG_N[a + 1] ?? 0, bx = LEG_N[b] ?? 0, by = LEG_N[b + 1] ?? 0;
    const den = 1 + ax * bx + ay * by;
    let mx = ax;
    let my = ay;
    if (a !== b && den > 1e-6) {
      mx = (ax + bx) / den;
      my = (ay + by) / den;
    }
    out[o + 2 * k] = (c[ci + 2 * k] ?? 0) + d * mx;
    out[o + 2 * k + 1] = (c[ci + 2 * k + 1] ?? 0) + d * my;
  }
  // The midpoint fit. T0 = −perp(n0) and T3 = −perp(n2) are the end legs' unit tangents (perp(v) = (−v.y, v.x)).
  const t0x = LEG_N[1] ?? 0, t0y = -(LEG_N[0] ?? 0), t3x = LEG_N[5] ?? 0, t3y = -(LEG_N[4] ?? 0);
  const det = t3x * t0y - t0x * t3y; // cross(T0, −T3)
  if (!(Math.abs(det) >= FIT_MIN_SIN)) return;
  const p0x = c[ci] ?? 0, p0y = c[ci + 1] ?? 0, p1x = c[ci + 2] ?? 0, p1y = c[ci + 3] ?? 0;
  const p2x = c[ci + 4] ?? 0, p2y = c[ci + 5] ?? 0, p3x = c[ci + 6] ?? 0, p3y = c[ci + 7] ?? 0;
  // B'(½) ∝ P2 + P3 − P0 − P1; M = B(½) + d·perp(B'(½))/|B'(½)|.
  const gx = p2x + p3x - p0x - p1x, gy = p2y + p3y - p0y - p1y;
  const gl = Math.hypot(gx, gy);
  if (!(gl > 0)) return;
  const q0x = out[o] ?? 0, q0y = out[o + 1] ?? 0, q3x = out[o + 6] ?? 0, q3y = out[o + 7] ?? 0;
  const vx = (8 / 3) * ((p0x + 3 * p1x + 3 * p2x + p3x) / 8 - (d * gy) / gl - (q0x + q3x) / 2);
  const vy = (8 / 3) * ((p0y + 3 * p1y + 3 * p2y + p3y) / 8 + (d * gx) / gl - (q0y + q3y) / 2);
  const fa = (t3x * vy - vx * t3y) / det; // cross(V, −T3) / det
  const fb = (t0x * vy - t0y * vx) / det; // cross(T0, V) / det
  if (!(fa > 0) || !(fb > 0)) return;
  out[o + 2] = q0x + fa * t0x;
  out[o + 3] = q0y + fa * t0y;
  out[o + 4] = q3x - fb * t3x;
  out[o + 5] = q3y - fb * t3y;
}

/** Module scratch for {@link traceArrowOutline}: the left edge's cubic, the right edge's, then the head (22 numbers). */
const EDGES = new Float64Array(22);

/**
 * Trace the whole arrow as ONE closed outline (Canvas/SVG/`toSVG()` fill) — the shape {@link arrowOutline} samples,
 * with each long edge as ONE cubic ({@link offsetCubic} of the centre cubic by `±width/2`) instead of points, so the
 * recorder flattens it by its own tolerance: the left edge from the source, the left barb, the tip, the right barb,
 * the right edge back. Its end corners are the centre end `± width/2` along the head's normal, on the head's base, as
 * {@link arrowOutline}'s. A straight shaft traces its edges as lines; a short bent link's collapsed shaft (whose
 * direction is not the head's axis) runs its edges on the shaft's own normal to `E1`, then steps onto the base corner,
 * as {@link arrowOutline}'s samples do. Every point × `scale` (the screen-sizeMode bake's `1/k`). Returns false
 * (traces nothing) for a zero-length link.
 */
export function traceArrowOutline(ctx: OutlineContext, p: ArrowParams, scale = 1): boolean {
  const bend = arrowBend(p);
  const kind = shaftCubic(p, bend, headLength(p.size));
  if (kind === SHAFT_NONE) return false;
  writeHead(EDGES, 16, p, bend);
  const hw = p.width / 2;
  const s = scale;
  const e = EDGES;
  if (kind === SHAFT_CURVED) {
    offsetCubic(CUBIC, 0, hw, e, 0);
    offsetCubic(CUBIC, 0, -hw, e, 8);
  } else {
    // Straight: the edges on the shaft's normal (start, and E1 for the collapsed step), the end corners on the head's.
    const p0x = CUBIC[0] ?? 0, p0y = CUBIC[1] ?? 0, p3x = CUBIC[6] ?? 0, p3y = CUBIC[7] ?? 0;
    const gx = (CUBIC[2] ?? 0) - p0x, gy = (CUBIC[3] ?? 0) - p0y;
    const gl = Math.hypot(gx, gy);
    const hnx = U1[1] ?? 0, hny = -(U1[0] ?? 0);
    const nx = gl > 0 ? -gy / gl : hnx, ny = gl > 0 ? gx / gl : hny;
    e[0] = p0x + nx * hw;
    e[1] = p0y + ny * hw;
    e[2] = p3x + nx * hw;
    e[3] = p3y + ny * hw;
    e[6] = p3x + hnx * hw;
    e[7] = p3y + hny * hw;
    e[8] = p0x - nx * hw;
    e[9] = p0y - ny * hw;
    e[10] = p3x - nx * hw;
    e[11] = p3y - ny * hw;
    e[14] = p3x - hnx * hw;
    e[15] = p3y - hny * hw;
  }
  ctx.moveTo((e[0] ?? 0) * s, (e[1] ?? 0) * s);
  if (kind === SHAFT_CURVED) ctx.bezierCurveTo((e[2] ?? 0) * s, (e[3] ?? 0) * s, (e[4] ?? 0) * s, (e[5] ?? 0) * s, (e[6] ?? 0) * s, (e[7] ?? 0) * s);
  else {
    if (kind === SHAFT_COLLAPSED) ctx.lineTo((e[2] ?? 0) * s, (e[3] ?? 0) * s);
    ctx.lineTo((e[6] ?? 0) * s, (e[7] ?? 0) * s);
  }
  ctx.lineTo((e[16] ?? 0) * s, (e[17] ?? 0) * s);
  ctx.lineTo((e[18] ?? 0) * s, (e[19] ?? 0) * s);
  ctx.lineTo((e[20] ?? 0) * s, (e[21] ?? 0) * s);
  ctx.lineTo((e[14] ?? 0) * s, (e[15] ?? 0) * s);
  if (kind === SHAFT_CURVED) ctx.bezierCurveTo((e[12] ?? 0) * s, (e[13] ?? 0) * s, (e[10] ?? 0) * s, (e[11] ?? 0) * s, (e[8] ?? 0) * s, (e[9] ?? 0) * s);
  else {
    if (kind === SHAFT_COLLAPSED) ctx.lineTo((e[10] ?? 0) * s, (e[11] ?? 0) * s);
    ctx.lineTo((e[8] ?? 0) * s, (e[9] ?? 0) * s);
  }
  ctx.closePath();
  return true;
}

/** {@link shaftCubic}'s result: a zero-length link, a straight shaft (no bend), a short bent link's collapsed straight
 *  shaft `E0 → E1` (not on the head's axis), or the settled cubic. */
const SHAFT_NONE = 0;
const SHAFT_STRAIGHT = 1;
const SHAFT_COLLAPSED = 2;
const SHAFT_CURVED = 3;

/** Module scratch for the shaft's end leg `u1` (2 numbers), refilled by {@link shaftCubic}. */
const U1 = new Float64Array(2);

/**
 * Solve the shaft's centre cubic on the faded bend `bend` ({@link fadedBend}) for a shaft ending `trim` back from the
 * tip, into {@link CUBIC}, and its end leg `u1` into {@link U1} (the head's axis is `−u1`). Returns {@link SHAFT_NONE}
 * for a zero-length link, {@link SHAFT_STRAIGHT} with no bend, {@link SHAFT_COLLAPSED} when the head reaches back past
 * the quadratic control and the shaft collapses to the straight `E0 → E1`, else {@link SHAFT_CURVED}.
 */
function shaftCubic(p: ArrowParams, bend: number, trim: number): number {
  const { sx, sy, tx, ty } = p;
  const dx = tx - sx;
  const dy = ty - sy;
  // The legs: from each centre towards the quadratic control C = mid + ⟂d·bend. |d + 2b·⟂d| = |−d + 2b·⟂d|.
  const b2 = 2 * bend;
  const ll = Math.hypot(dx - b2 * dy, dy + b2 * dx);
  if (ll <= 0) return SHAFT_NONE;
  const u1x = (-dx - b2 * dy) / ll;
  const u1y = (-dy + b2 * dx) / ll;
  U1[0] = u1x;
  U1[1] = u1y;
  // The headed end E1 on the head's axis, `back` out of the target centre.
  const back = p.radius + trim;
  const e1x = tx + back * u1x;
  const e1y = ty + back * u1y;
  const cx = e1x - sx;
  const cy = e1y - sy;
  const chord = Math.hypot(cx, cy);
  if (back < ll / 2) {
    // E1 before C (|C − c1| = ll/2): the settled cubic.
    legCubic(CUBIC, 0, sx, sy, (dx - b2 * dy) / ll, (dy + b2 * dx) / ll, 0, tx, ty, u1x, u1y, back, (chord * Math.sqrt(1 + b2 * b2)) / 3);
    return bend === 0 ? SHAFT_STRAIGHT : SHAFT_CURVED;
  }
  // The head reaches back past C (a very short link): the shaft collapses to the straight E0 → E1.
  const vx = chord > 0 ? cx / chord : -u1x;
  const vy = chord > 0 ? cy / chord : -u1y;
  legCubic(CUBIC, 0, sx, sy, vx, vy, 0, e1x, e1y, -vx, -vy, 0, chord / 3);
  return bend === 0 ? SHAFT_STRAIGHT : SHAFT_COLLAPSED;
}

/**
 * Shared shaft sampler, on the faded bend `bend` ({@link fadedBend}). `outline = false`: strip order (left, right
 * per sample). `outline = true`: left edge at points `0 … M−1`, right edge reversed at points `M+3 … 2M+2` (the
 * head goes between).
 */
function writeShaft(out: PointBuffer, o: number, p: ArrowParams, bend: number, trim: number, samples: number, outline: boolean): number {
  if (shaftCubic(p, bend, trim) === SHAFT_NONE) return 0;
  const u1x = U1[0] ?? 0;
  const u1y = U1[1] ?? 0;
  const [p0x = 0, p0y = 0, p1x = 0, p1y = 0, p2x = 0, p2y = 0, p3x = 0, p3y = 0] = CUBIC;
  // The head's normal ⟂(−u1): the shaft's end pair lies on the base, and the cubic's end tangent is −u1.
  const hnx = u1y;
  const hny = -u1x;
  const m = Math.max(2, samples | 0);
  const hw = p.width / 2;
  const last = 2 * m + 2; // index of the outline's final point
  for (let i = 0; i < m; i++) {
    let px: number;
    let py: number;
    let nx = hnx;
    let ny = hny;
    if (i === m - 1) {
      // The end, with the head's normal: the corners land on its base.
      px = p3x;
      py = p3y;
    } else {
      const t = i / (m - 1);
      const a = 1 - t;
      px = a * a * a * p0x + 3 * a * a * t * p1x + 3 * a * t * t * p2x + t * t * t * p3x;
      py = a * a * a * p0y + 3 * a * a * t * p1y + 3 * a * t * t * p2y + t * t * t * p3y;
      // B'(t)/3 = (1−t)²(P1 − P0) + 2(1−t)t(P2 − P1) + t²(P3 − P2)
      const gx = a * a * (p1x - p0x) + 2 * a * t * (p2x - p1x) + t * t * (p3x - p2x);
      const gy = a * a * (p1y - p0y) + 2 * a * t * (p2y - p1y) + t * t * (p3y - p2y);
      const gl = Math.hypot(gx, gy);
      if (gl > 0) {
        nx = -gy / gl;
        ny = gx / gl;
      }
    }
    const lx = px + nx * hw;
    const ly = py + ny * hw;
    const rx = px - nx * hw;
    const ry = py - ny * hw;
    const li = outline ? o + 2 * i : o + 4 * i;
    const ri = outline ? o + 2 * (last - i) : o + 4 * i + 2;
    out[li] = lx;
    out[li + 1] = ly;
    out[ri] = rx;
    out[ri + 1] = ry;
  }
  return 2 * m;
}
