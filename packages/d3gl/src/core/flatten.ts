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

/**
 * Default flattening tolerance, in **world units** — the max deviation between a curve and
 * the polyline it is baked to. Every curve is baked ONCE, at build time, and the view
 * transform only scales the result, so a facet of `t` world units is `t·k` screen px at zoom
 * `k` (#45). Engines expose this as `curveTolerance`; set it to `0.25 / kMax` for a chart that
 * needs sub-pixel curves at zoom `kMax`.
 */
export const DEFAULT_CURVE_TOLERANCE = 0.25;

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
  if (depth >= MAX_DEPTH) {
    return; // flat enough; caller pushes the endpoint
  }
  const dx = x3 - x0;
  const dy = y3 - y0;
  const chordSq = dx * dx + dy * dy;
  const DEGENERATE = 1e-12;
  if (chordSq > DEGENERATE) {
    // Non-degenerate chord: deviation of control points from the chord line.
    const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
    const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
    if ((d1 + d2) * (d1 + d2) <= tolSq * chordSq) {
      return; // flat enough; caller pushes the endpoint
    }
  } else {
    // Degenerate chord (coincident endpoints, e.g. a loop): the chord-line test
    // is meaningless, so measure how far the control points stray from the start.
    const e1x = x1 - x0;
    const e1y = y1 - y0;
    const e2x = x2 - x0;
    const e2y = y2 - y0;
    const spreadSq = Math.max(e1x * e1x + e1y * e1y, e2x * e2x + e2y * e2y);
    if (spreadSq <= tolSq) {
      return; // control points hug the start point; treat as flat
    }
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
  // Largest angular step whose chord stays within `tolerance` of the arc:
  // step = 2*acos(1 - tolerance/r). Handle the degenerate ends explicitly.
  const ratio = r > 0 ? 1 - tolerance / r : -1;
  const maxStep =
    ratio <= 0
      ? Math.PI / 2 // tolerance >= r (or r<=0): coarse but valid
      : ratio >= 1
        ? Math.PI / 32 // tolerance ~0: maximum (finite) refinement
        : 2 * Math.acos(ratio);
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / maxStep));
  for (let i = 1; i <= steps; i++) {
    const a = startAngle + (delta * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/**
 * Below this the cross product of the two unit segment directions counts as zero,
 * i.e. the three points are collinear and the tangent arc degenerates to a corner.
 */
const COLLINEAR_EPS = 1e-12;

/**
 * Tangent arc, matching `CanvasRenderingContext2D.arcTo(x1, y1, x2, y2, radius)` — the
 * rounded-corner primitive (rounded rects/bars, CSS-style shapes). `(x0, y0)` is the
 * current point; `(x1, y1)` the corner; `(x2, y2)` the point the outgoing segment heads
 * towards. The arc is tangent to BOTH half-infinite lines `(x1,y1)→(x0,y0)` and
 * `(x1,y1)→(x2,y2)`, so the tangent points may lie beyond `(x0,y0)`/`(x2,y2)` — that is
 * the spec, not a bug.
 *
 * Appends, like the flatteners above, EXCLUDING the start point and INCLUDING the end:
 * first the start tangent point (the straight join from the current point), then the
 * flattened arc. Degenerate inputs — zero radius, coincident points, collinear points —
 * collapse to a single point at the corner, exactly as Canvas does.
 *
 * This is the ONE source of truth for the seam: `PathRecorder` (WebGL/Canvas/SVG all
 * render the Scene it records) and `SvgPathContext` both call it, so the same `arcTo`
 * produces the same polyline everywhere. Flattened rather than kept as an analytic arc
 * for the same reason `flattenArc` is — see #284 for the symbolic-curve alternative.
 */
export function flattenArcTo(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius: number,
  tolerance: number,
  out: number[],
): void {
  // Canvas ignores a call with any non-finite argument rather than corrupting the path.
  if (
    !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) ||
    !Number.isFinite(x2) || !Number.isFinite(y2) || !Number.isFinite(radius)
  ) {
    return;
  }
  if (radius < 0) throw new Error(`arcTo: radius must be non-negative (got ${radius})`);

  // Unit directions from the corner back to the current point and on to the next point.
  let v1x = x0 - x1;
  let v1y = y0 - y1;
  let v2x = x2 - x1;
  let v2y = y2 - y1;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (radius === 0 || l1 === 0 || l2 === 0) {
    out.push(x1, y1); // no arc to build: straight line to the corner
    return;
  }
  v1x /= l1;
  v1y /= l1;
  v2x /= l2;
  v2y /= l2;
  const sin = v1x * v2y - v1y * v2x; // sin θ (signed): 0 when the three points are collinear
  const cos = v1x * v2x + v1y * v2y; // cos θ
  if (Math.abs(sin) < COLLINEAR_EPS) {
    out.push(x1, y1);
    return;
  }
  // Distance from the corner to each tangent point: r / tan(θ/2), with the half-angle
  // identity tan(θ/2) = sin θ / (1 + cos θ) (stable for θ → π, where the arc vanishes).
  const d = (radius * (1 + cos)) / Math.abs(sin);
  const t1x = x1 + v1x * d;
  const t1y = y1 + v1y * d;
  const t2x = x1 + v2x * d;
  const t2y = y1 + v2y * d;
  // Centre: r along the normal of the incoming segment, on the side the outgoing one lies.
  const s = sin > 0 ? 1 : -1;
  const cx = t1x - s * v1y * radius;
  const cy = t1y + s * v1x * radius;
  // Skip a zero-length join (the tangent point already IS the current point) so the
  // polyline never carries a duplicate vertex into the stroke tessellator.
  if (Math.abs(t1x - x0) > COLLINEAR_EPS || Math.abs(t1y - y0) > COLLINEAR_EPS) out.push(t1x, t1y);
  // Sweep direction: travelling into the corner along -v1 and out along +v2 turns with
  // angles DEcreasing when the cross product is positive. |sweep| = π - θ < π, so
  // flattenArc's normalization picks the short way round.
  flattenArc(
    cx, cy, radius,
    Math.atan2(t1y - cy, t1x - cx),
    Math.atan2(t2y - cy, t2x - cx),
    sin > 0,
    tolerance,
    out,
  );
}
