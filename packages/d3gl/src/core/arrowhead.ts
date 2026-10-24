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
  /** Chord-fraction bend (0 = straight), as `linkBend`. */
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
  return writeShaft(out, o, p, trim, samples, false);
}

/** Write the head's three points (left barb, tip, right barb) at `o`; returns 3 (0 for a zero-length link). */
export function arrowHead(out: PointBuffer, o: number, p: ArrowParams): number {
  const dx = p.tx - p.sx;
  const dy = p.ty - p.sy;
  const ex = 0.5 * dx + dy * p.bend;
  const ey = 0.5 * dy - dx * p.bend;
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
 * Write the whole arrow as ONE closed, non-self-overlapping outline (Canvas/SVG/`toSVG()` fill): the
 * shaft's left edge from the source, the left barb, the tip, the right barb, the right edge back.
 * Here the shaft is trimmed at the head's BASE (its end corners land on the base edge, inside the
 * barbs), so the outline is the exact union of shaft and head with no folded edge. Writes
 * `2·(2·samples + 3)` numbers at `o`; returns the number of points (`2·samples + 3`, or 0 for a
 * zero-length link).
 */
export function arrowOutline(out: PointBuffer, o: number, p: ArrowParams, samples: number): number {
  const n = writeShaft(out, o, p, headLength(p.size), samples, true);
  if (n === 0) return 0;
  arrowHead(out, o + 2 * samples, p);
  return 2 * samples + 3;
}

/**
 * Shared shaft sampler. `outline = false`: strip order (left, right per sample). `outline = true`:
 * left edge at points `0 … M−1`, right edge reversed at points `M+3 … 2M+2` (the head goes between).
 */
function writeShaft(out: PointBuffer, o: number, p: ArrowParams, trim: number, samples: number, outline: boolean): number {
  const { sx, sy, tx, ty, bend } = p;
  const dx = tx - sx;
  const dy = ty - sy;
  // The legs: from each centre towards the quadratic control C = mid + ⟂d·bend. |d + 2b·⟂d| = |−d + 2b·⟂d|.
  const b2 = 2 * bend;
  const ll = Math.hypot(dx - b2 * dy, dy + b2 * dx);
  if (ll <= 0) return 0;
  const u1x = (-dx - b2 * dy) / ll;
  const u1y = (-dy + b2 * dx) / ll;
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
  } else {
    // The head reaches back past C (a very short link): the shaft collapses to the straight E0 → E1.
    const vx = chord > 0 ? cx / chord : -u1x;
    const vy = chord > 0 ? cy / chord : -u1y;
    legCubic(CUBIC, 0, sx, sy, vx, vy, 0, e1x, e1y, -vx, -vy, 0, chord / 3);
  }
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
