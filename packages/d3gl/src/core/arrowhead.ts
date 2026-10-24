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
 * A bent (`linkBend`) link is the quadratic bezier `P0 → C → P1`, `C` = chord midpoint + ⟂(chord)·bend
 * (as `bezierControl` in `half-link.ts` and the strip shader). The head's axis is the end tangent, the
 * line through `C` and `P1`, so the shaft is the quadratic `P0 → C → B` with `B` the head's base centre
 * on that axis: the same curve with its end pulled back along its own tangent. It leaves the source as
 * the link does and runs into the head along the head's axis, with no sideways step and no corner. When
 * the head reaches back past `C` (a very short link), the shaft is the straight `P0 → B`.
 *
 * Everything here is scalar math with no allocation beyond the caller's output buffer, so the
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
 * Write the shaft's edge pairs (left, right per sample — triangle-strip order, the WebGL twin) for a
 * shaft that ends `trim` back from the tip. `samples ≥ 2` points on the quadratic `P0 → C → B` at
 * `t = i/(samples−1)`, `B = tip − dir·trim`; the last pair takes the head's normal. Every backend
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
  // Control point C and the end tangent P1 − C (half of B'(1)).
  const cx = (sx + tx) / 2 - dy * bend;
  const cy = (sy + ty) / 2 + dx * bend;
  const ex = tx - cx;
  const ey = ty - cy;
  const el = Math.hypot(ex, ey);
  if (el <= 0) return 0;
  const ux = ex / el;
  const uy = ey / el;
  const m = Math.max(2, samples | 0);
  // The shaft's end B on the head's axis, and its control: C (on that axis too), or the midpoint of P0 → B
  // when B lies back past C.
  const back = p.radius + trim;
  const bx = tx - ux * back;
  const by = ty - uy * back;
  const qx = back < el ? cx : (sx + bx) / 2;
  const qy = back < el ? cy : (sy + by) / 2;
  const hw = p.width / 2;
  const last = 2 * m + 2; // index of the outline's final point
  for (let i = 0; i < m; i++) {
    let px: number;
    let py: number;
    let nx: number;
    let ny: number;
    if (i === m - 1) {
      // The end, with the head's normal: the corners land on its edges.
      px = bx;
      py = by;
      nx = -uy;
      ny = ux;
    } else {
      const t = i / (m - 1);
      const a = 1 - t;
      px = a * a * sx + 2 * a * t * qx + t * t * bx;
      py = a * a * sy + 2 * a * t * qy + t * t * by;
      // Q'(t)/2 = (1−t)(Q − P0) + t(B − Q)
      const gx = a * (qx - sx) + t * (bx - qx);
      const gy = a * (qy - sy) + t * (by - qy);
      const gl = Math.hypot(gx, gy) || 1;
      nx = -gy / gl;
      ny = gx / gl;
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
