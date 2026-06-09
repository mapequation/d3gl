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

/** Stroke join style. "round" caps/joins are not yet tessellated (deferred). */
export type LineJoin = "miter" | "bevel";

export interface StrokeOptions {
  /** Corner style. "miter" extends to a sharp point (falling back to "bevel" past
   *  {@link StrokeOptions.miterLimit}); "bevel" always cuts the corner flat. Default "miter". */
  join?: LineJoin;
  /** Miter length / stroke width above which a miter falls back to a bevel — the same
   *  definition Canvas (`ctx.miterLimit`) and SVG (`stroke-miterlimit`) use. Default 10. */
  miterLimit?: number;
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
 * unless `join` is "bevel" or the miter exceeds `miterLimit` (then bevel). Closed subpaths
 * join every corner including the wrap-around; open subpaths use butt caps (no extra cap
 * geometry — round/square caps are deferred).
 *
 * Width/join are geometry parameters: changing them requires re-expanding. (Recoloring a
 * stroke does not — color lives in a separate side-table.)
 */
export function expandStroke(subpath: Subpath, width: number, options: StrokeOptions = {}): StrokeGeometry {
  const join = options.join ?? "miter";
  const miterLimit = options.miterLimit ?? DEFAULT_MITER_LIMIT;
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
    // inner side and, when not mitering, the outer side too.
    indices.push(base + 0, base + 1, base + 2, base + 0, base + 3, base + 4);

    if (join !== "miter" || cross === 0) continue;
    // Outer-side miter: bisector of the two outer normals, apex at half / cos(halfAngle).
    const outerLeft = cross < 0; // turning right → outer side is the left
    const o1x = outerLeft ? pnx : -pnx, o1y = outerLeft ? pny : -pny;
    const o2x = outerLeft ? nnx : -nnx, o2y = outerLeft ? nny : -nny;
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

  return { vertices, indices, anchors };
}
