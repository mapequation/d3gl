import type { Subpath } from "./path-context.js";

export interface StrokeGeometry {
  /** Interleaved x,y vertex coordinates. */
  vertices: number[];
  /** Triangle indices into `vertices` (3 per triangle). */
  indices: number[];
  /**
   * Per-vertex centerline anchor (interleaved x,y, one pair per vertex). The point on the
   * polyline that each stroke vertex was offset from by the half-width normal. Backends use
   * it for "screen" sizeMode: keep the anchor in world space but render the (vertex − anchor)
   * offset at a constant pixel size, giving a constant-width stroke independent of zoom.
   */
  anchors: number[];
}

/** Stroke join style. */
export type LineJoin = "miter" | "bevel" | "round";
/** Open-subpath end-cap style. */
export type LineCap = "butt" | "square" | "round";

export interface StrokeOptions {
  /** Corner style. "bevel" (default) cuts the corner flat; "miter" extends to a sharp point
   *  (falling back to "bevel" past {@link StrokeOptions.miterLimit}); "round" arcs the corner. */
  join?: LineJoin;
  /** Miter length / stroke width above which a miter falls back to a bevel — the same
   *  definition Canvas (`ctx.miterLimit`) and SVG (`stroke-miterlimit`) use. Default 10. */
  miterLimit?: number;
  /** End-cap style for OPEN subpaths: "butt" (default, flush), "square" (extends half the
   *  width past the end), or "round" (a semicircle). Closed subpaths have no ends. */
  cap?: LineCap;
}

/** Defaults match the Canvas 2D defaults and are pinned identically on Canvas/SVG so the
 *  three backends agree. (SVG's own default miter limit is 4, so it must be set explicitly.) */
export const DEFAULT_MITER_LIMIT = 10;

/**
 * Expand a polyline into fill triangles for a stroke of the given width.
 *
 * Each straight segment becomes a quad (2 triangles). Each join is filled per side: the
 * INNER side is a bevel (harmless overlap with the segment quads for opaque fills); the
 * OUTER side is a **miter** to a sharp apex — reproducing the Canvas/SVG painter look —
 * unless `join` is "bevel" (flat) or "round" (an arc fan), or the miter exceeds
 * `miterLimit` (then bevel). Closed subpaths
 * join every corner including the wrap-around; open subpaths use butt caps (no extra cap
 * geometry — round/square caps are deferred).
 *
 * Width/join are geometry parameters: changing them requires re-expanding. (Recoloring a
 * stroke does not — color lives in a separate side-table.)
 */
export function expandStroke(subpath: Subpath, width: number, options: StrokeOptions = {}): StrokeGeometry {
  const join = options.join ?? "bevel";
  const miterLimit = options.miterLimit ?? DEFAULT_MITER_LIMIT;
  const cap = options.cap ?? "butt";
  const vertices: number[] = [];
  const indices: number[] = [];
  const anchors: number[] = [];
  const pts = subpath.points;
  const n = pts.length / 2;
  const half = width / 2;
  if (n < 2 || width <= 0) return { vertices, indices, anchors };

  const px = (i: number) => pts[2 * i]!;
  const py = (i: number) => pts[2 * i + 1]!;

  // Segment quads.
  const segCount = subpath.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const ax = px(i);
    const ay = py(i);
    const bx = px((i + 1) % n);
    const by = py((i + 1) % n);
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    dx /= len;
    dy /= len;
    const nx = -dy * half;
    const ny = dx * half;
    const base = vertices.length / 2;
    vertices.push(ax + nx, ay + ny, ax - nx, ay - ny, bx + nx, by + ny, bx - nx, by - ny);
    anchors.push(ax, ay, ax, ay, bx, by, bx, by);
    indices.push(base + 0, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  // Joins. Open: interior vertices 1..n-2. Closed: every vertex 0..n-1.
  const jointStart = subpath.closed ? 0 : 1;
  const jointEnd = subpath.closed ? n : n - 1;
  for (let j = jointStart; j < jointEnd; j++) {
    const cx = px(j);
    const cy = py(j);
    const ax = px((j - 1 + n) % n);
    const ay = py((j - 1 + n) % n);
    const bx = px((j + 1) % n);
    const by = py((j + 1) % n);
    let pdx = cx - ax;
    let pdy = cy - ay;
    const pl = Math.hypot(pdx, pdy);
    let ndx = bx - cx;
    let ndy = by - cy;
    const nl = Math.hypot(ndx, ndy);
    if (pl === 0 || nl === 0) continue;
    pdx /= pl;
    pdy /= pl;
    ndx /= nl;
    ndy /= nl;
    // Left-side unit normals of the incoming and outgoing segments.
    const pnx = -pdy, pny = pdx;
    const nnx = -ndy, nny = ndx;
    // Turn direction: cross(prevDir, nextDir). > 0 turns left (outer side = right),
    // < 0 turns right (outer side = left). The outer side is where the miter forms.
    const cross = pdx * ndy - pdy * ndx;
    const base = vertices.length / 2;
    // The corner-fan center plus the four offset corners (left/right of each segment).
    // pL/nL on the left, pR/nR on the right; all anchored at the corner (cx, cy).
    vertices.push(
      cx, cy,
      cx + pnx * half, cy + pny * half, // 1 prevLeft
      cx + nnx * half, cy + nny * half, // 2 nextLeft
      cx - pnx * half, cy - pny * half, // 3 prevRight
      cx - nnx * half, cy - nny * half, // 4 nextRight
    );
    anchors.push(cx, cy, cx, cy, cx, cy, cx, cy, cx, cy);
    // Always fill both bevel triangles (center→prev→next on each side). This covers the
    // inner side and, when not extending the outer side, the outer side too.
    indices.push(base + 0, base + 1, base + 2, base + 0, base + 3, base + 4);

    if (join === "bevel" || cross === 0) continue;
    // Outer-side unit normals (the side the corner opens toward).
    const outerLeft = cross < 0; // turning right → outer side is the left
    const o1x = outerLeft ? pnx : -pnx, o1y = outerLeft ? pny : -pny;
    const o2x = outerLeft ? nnx : -nnx, o2y = outerLeft ? nny : -nny;

    if (join === "round") {
      // Outer-side arc fan from the corner center, sweeping the turn angle (replaces the
      // outer bevel chord with the rounded arc; overlap with the bevel is harmless).
      const a1 = Math.atan2(o1y, o1x);
      let delta = Math.atan2(o2y, o2x) - a1;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      const segs = Math.max(1, Math.ceil(Math.abs(delta) / Math.acos(Math.max(-1, 1 - 0.25 / half))));
      const c0 = vertices.length / 2;
      for (let s = 0; s <= segs; s++) {
        const a = a1 + delta * (s / segs);
        vertices.push(cx + Math.cos(a) * half, cy + Math.sin(a) * half);
        anchors.push(cx, cy);
      }
      for (let s = 0; s < segs; s++) indices.push(base + 0, c0 + s, c0 + s + 1);
      continue;
    }

    // Outer-side miter: bisector of the two outer normals, apex at half / cos(halfAngle).
    let bx2 = o1x + o2x, by2 = o1y + o2y;
    const bl = Math.hypot(bx2, by2);
    if (bl === 0) continue; // ~180° fold: nothing to miter
    bx2 /= bl; by2 /= bl;
    const cosHalf = bx2 * o1x + by2 * o1y; // = cos(angle between bisector and an outer normal)
    if (cosHalf <= 1e-4) continue;
    if (1 / cosHalf > miterLimit) continue; // miter too long → keep the bevel already emitted
    const apexLen = half / cosHalf;
    const apx = cx + bx2 * apexLen, apy = cy + by2 * apexLen;
    const ai = vertices.length / 2;
    vertices.push(apx, apy);
    anchors.push(cx, cy);
    // Two triangles fill the gap between the (already-emitted) outer bevel edge and the apex:
    // (center, outer1, apex) and (center, apex, outer2). Outer corners are verts 1/2 (left)
    // or 3/4 (right) of this fan.
    const out1 = base + (outerLeft ? 1 : 3);
    const out2 = base + (outerLeft ? 2 : 4);
    indices.push(base + 0, out1, ai, base + 0, ai, out2);
  }

  // End caps (open subpaths only; closed paths have no ends). `ox,oy` is the unit
  // OUTWARD direction (away from the path) at the endpoint; the cap extends from the
  // end edge into that side. Built once per end — geometry only, no per-frame cost.
  if (!subpath.closed && cap !== "butt") {
    const addCap = (ex: number, ey: number, ox: number, oy: number): void => {
      const nx = -oy, ny = ox; // unit normal (outward rotated +90°)
      if (cap === "square") {
        const b = vertices.length / 2;
        vertices.push(
          ex + nx * half, ey + ny * half,                       // 0 left edge
          ex - nx * half, ey - ny * half,                       // 1 right edge
          ex - nx * half + ox * half, ey - ny * half + oy * half, // 2 right far
          ex + nx * half + ox * half, ey + ny * half + oy * half, // 3 left far
        );
        anchors.push(ex, ey, ex, ey, ex, ey, ex, ey);
        indices.push(b + 0, b + 1, b + 2, b + 0, b + 2, b + 3);
      } else {
        // round: a semicircle fan from +normal through outward to -normal.
        const segs = Math.max(4, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.25 / half))));
        const center = vertices.length / 2;
        vertices.push(ex, ey);
        anchors.push(ex, ey);
        const a0 = Math.atan2(ny, nx);
        for (let s = 0; s <= segs; s++) {
          const a = a0 - Math.PI * (s / segs);
          vertices.push(ex + Math.cos(a) * half, ey + Math.sin(a) * half);
          anchors.push(ex, ey);
        }
        for (let s = 0; s < segs; s++) indices.push(center, center + 1 + s, center + 2 + s);
      }
    };
    // Start: outward is opposite segment 0's direction. End: along the last segment's.
    let sdx = px(1) - px(0), sdy = py(1) - py(0);
    const sl = Math.hypot(sdx, sdy);
    if (sl > 0) { sdx /= sl; sdy /= sl; addCap(px(0), py(0), -sdx, -sdy); }
    let edx = px(n - 1) - px(n - 2), edy = py(n - 1) - py(n - 2);
    const el = Math.hypot(edx, edy);
    if (el > 0) { edx /= el; edy /= el; addCap(px(n - 1), py(n - 1), edx, edy); }
  }

  return { vertices, indices, anchors };
}
