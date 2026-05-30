/** A d3-zoom-style transform: uniform scale `k` then pixel translation (x, y). */
export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

/**
 * Build a column-major 3x3 matrix mapping *reference pixel* coordinates
 * (origin top-left, y down, the space d3 projections / geoPath produce) through a
 * d3-zoom transform and into WebGL clip space [-1, 1] (origin center, y up).
 *
 * Pixel -> zoomed pixel:   px' = k*px + x,  py' = k*py + y
 * Zoomed pixel -> clip:    cx  = px'/W*2 - 1,  cy = 1 - py'/H*2   (y flipped)
 *
 * Composed (cx,cy,1) = M (px,py,1), so pan/zoom is a single uniform update and
 * the GPU never re-projects geometry.
 */
export function clipFromView(t: ViewTransform, width: number, height: number): Float64Array {
  const sx = (2 * t.k) / width;
  const sy = (-2 * t.k) / height;
  const tx = (2 * t.x) / width - 1;
  const ty = 1 - (2 * t.y) / height;
  // column-major layout: [col0row0, col0row1, col0row2, col1row0, ...]
  // Float64 preserves exact arithmetic (e.g. 2/width * width = 2) so callers
  // can use strict equality on boundary values. luma.gl accepts both typed
  // array flavours for mat3 uniforms.
  return new Float64Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
}
