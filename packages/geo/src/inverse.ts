import type { GeoProjection } from "d3-geo";
import { clipFromView } from "@d3gl/webgl";
import type { ViewTransform } from "@d3gl/webgl";

export type { ViewTransform };

/**
 * Turn a d3-zoom transform {k,x,y} into the column-major clip-space mat3 the
 * renderer's setTransform expects (re-export of the GPU view matrix builder).
 */
export function viewTransform(t: ViewTransform, width: number, height: number): Float32Array {
  return clipFromView(t, width, height);
}

/**
 * Invert the d3-zoom pixel transform: screen pixel -> reference (projected) pixel.
 * screen = k*reference + (x,y)  =>  reference = (screen - (x,y)) / k.
 */
export function referenceFromScreen(t: ViewTransform, screenX: number, screenY: number): [number, number] {
  return [(screenX - t.x) / t.k, (screenY - t.y) / t.k];
}

/**
 * Screen pixel -> lon/lat: undo the zoom transform, then the projection. Returns
 * null if the projection cannot invert the point (e.g. outside the globe).
 */
export function lonLatFromScreen(
  projection: GeoProjection,
  t: ViewTransform,
  screenX: number,
  screenY: number,
): [number, number] | null {
  if (!projection.invert) return null;
  const ref = referenceFromScreen(t, screenX, screenY);
  return projection.invert(ref) ?? null;
}
