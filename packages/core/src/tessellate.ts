import earcut from "earcut";
import type { Subpath } from "./path-context.js";

export interface FillGeometry {
  /** Interleaved x,y vertex coordinates. */
  vertices: number[];
  /** Triangle indices into `vertices` (3 per triangle). */
  indices: number[];
}

/**
 * Triangulate filled (closed) subpaths into triangles via earcut.
 *
 * Each entry in `polygons` is one outer ring (a closed Subpath). The matching
 * entry in `holes` (optional) is a list of hole rings for that polygon. Open
 * subpaths are skipped — a fill requires a closed ring.
 *
 * Vertices from every polygon are concatenated into one flat buffer and indices
 * are offset accordingly, so the result is one combined mesh ready for a single
 * draw call.
 */
export function tessellateFill(
  polygons: readonly Subpath[],
  holes: ReadonlyArray<readonly Subpath[]> = [],
): FillGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let p = 0; p < polygons.length; p++) {
    const outer = polygons[p]!;
    if (!outer.closed || outer.points.length < 6) continue;

    const baseVertex = vertices.length / 2;
    const flat: number[] = [...outer.points];
    const holeIndices: number[] = [];

    const polyHoles = holes[p] ?? [];
    for (const hole of polyHoles) {
      if (!hole.closed || hole.points.length < 6) continue;
      holeIndices.push(flat.length / 2);
      flat.push(...hole.points);
    }

    const tri = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
    for (const i of tri) indices.push(baseVertex + i);
    vertices.push(...flat);
  }

  return { vertices, indices };
}
