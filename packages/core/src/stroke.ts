import type { Subpath } from "./path-context.js";

export interface StrokeGeometry {
  /** Interleaved x,y vertex coordinates. */
  vertices: number[];
  /** Triangle indices into `vertices` (3 per triangle). */
  indices: number[];
}

/**
 * Expand a polyline into fill triangles for a stroke of the given width.
 *
 * Each straight segment becomes a quad (2 triangles); each interior vertex gets a
 * bevel join (filled on both sides — robust, no cracks, harmless overlap on the
 * inner side for opaque fills). Closed subpaths join every corner including the
 * wrap-around; open subpaths use butt caps (no extra cap geometry). Round/square
 * caps and miter joins are deferred.
 *
 * Width is a geometry parameter: changing it requires re-expanding. (Recoloring a
 * stroke does not — color lives in a separate side-table.)
 */
export function expandStroke(subpath: Subpath, width: number): StrokeGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  const pts = subpath.points;
  const n = pts.length / 2;
  const half = width / 2;
  if (n < 2 || width <= 0) return { vertices, indices };

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
    indices.push(base + 0, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  // Bevel joins. Open: interior vertices 1..n-2. Closed: every vertex 0..n-1.
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
    const pnx = -pdy * half;
    const pny = pdx * half;
    const nnx = -ndy * half;
    const nny = ndx * half;
    const base = vertices.length / 2;
    // center, prevLeft, nextLeft, prevRight, nextRight
    vertices.push(cx, cy, cx + pnx, cy + pny, cx + nnx, cy + nny, cx - pnx, cy - pny, cx - nnx, cy - nny);
    indices.push(base + 0, base + 1, base + 2, base + 0, base + 3, base + 4);
  }

  return { vertices, indices };
}
