/**
 * Curve flattening: convert beziers and arcs into line segments so they can be
 * tessellated. Each function APPENDS interleaved x,y coordinates to `out`,
 * EXCLUDING the start point (the caller already has the current point) and
 * INCLUDING the end point.
 *
 * `tolerance` is the maximum allowed deviation (in coordinate units) between the
 * true curve and the polyline. Smaller => more segments.
 */

const MAX_DEPTH = 32;

/** Cubic bezier from (x0,y0) to (x3,y3) with control points (x1,y1),(x2,y2). */
export function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolerance: number,
  out: number[],
): void {
  const tolSq = tolerance * tolerance;
  recurseCubic(x0, y0, x1, y1, x2, y2, x3, y3, tolSq, 0, out);
  out.push(x3, y3);
}

function recurseCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolSq: number,
  depth: number,
  out: number[],
): void {
  // Distance of control points from the chord (x0,y0)->(x3,y3).
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const chordSq = dx * dx + dy * dy;
  if (depth >= MAX_DEPTH || (d1 + d2) * (d1 + d2) <= tolSq * chordSq) {
    return; // flat enough; caller pushes the endpoint
  }
  // de Casteljau subdivision at t=0.5
  const x01 = (x0 + x1) / 2;
  const y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2;
  const y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2;
  const y23 = (y2 + y3) / 2;
  const x012 = (x01 + x12) / 2;
  const y012 = (y01 + y12) / 2;
  const x123 = (x12 + x23) / 2;
  const y123 = (y12 + y23) / 2;
  const xm = (x012 + x123) / 2;
  const ym = (y012 + y123) / 2;
  recurseCubic(x0, y0, x01, y01, x012, y012, xm, ym, tolSq, depth + 1, out);
  out.push(xm, ym);
  recurseCubic(xm, ym, x123, y123, x23, y23, x3, y3, tolSq, depth + 1, out);
}

/** Quadratic bezier: elevate to cubic and reuse the cubic flattener. */
export function flattenQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  tolerance: number,
  out: number[],
): void {
  // Degree elevation: cubic control points from a quadratic.
  const c1x = x0 + (2 / 3) * (cx - x0);
  const c1y = y0 + (2 / 3) * (cy - y0);
  const c2x = x1 + (2 / 3) * (cx - x1);
  const c2y = y1 + (2 / 3) * (cy - y1);
  flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, tolerance, out);
}

/** Circular arc, matching CanvasRenderingContext2D.arc semantics. */
export function flattenArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  counterclockwise: boolean,
  tolerance: number,
  out: number[],
): void {
  let delta = endAngle - startAngle;
  if (!counterclockwise && delta < 0) {
    delta += Math.PI * 2;
  } else if (counterclockwise && delta > 0) {
    delta -= Math.PI * 2;
  }
  // Max angular step that keeps sagitta within tolerance: 2*acos(1 - tol/r).
  const ratio = r > 0 ? Math.max(0, 1 - tolerance / r) : 0;
  const maxStep = 2 * Math.acos(Math.min(1, ratio)) || Math.PI / 8;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / maxStep));
  for (let i = 1; i <= steps; i++) {
    const a = startAngle + (delta * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}
