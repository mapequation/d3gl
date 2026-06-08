import type { ViewTransform } from "../core/index.js";
export type { ViewTransform };

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
export function clipFromView(t: ViewTransform, width: number, height: number): Float32Array {
  const sx = (2 * t.k) / width;
  const sy = (-2 * t.k) / height;
  const tx = (2 * t.x) / width - 1;
  const ty = 1 - (2 * t.y) / height;
  // column-major: [col0, col1, col2]. Float32 is the GPU's mat3 type and matches
  // the renderer's transform signature; callers should compare with tolerance.
  return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
}

/**
 * Build a column-major 3x3 matrix for blitting a pass-through FBO (captured at
 * view transform `from`) onto the screen at the current view transform `to`.
 *
 * A world point w maps to screen pixel `v.k*w + (v.x, v.y)` at transform v.
 * Let `a = to.k / from.k` (scale ratio), `bx = to.x - a*from.x`, `by = to.y - a*from.y`
 * (residual pixel translation). The full-screen quad is in clip space [-1,1],
 * so the screen-affine `(a, b)` must be mapped into the same clip-space units:
 *   sx = sy = a
 *   tx = a - 1 + 2*bx / width   (a-1 shifts the quad centre; 2*bx/W normalises b)
 *   ty = 1 - a - 2*by / height  (y axis flipped in clip space)
 * When `from === to` all terms reduce to identity.
 */
export function blitMatrix(
  from: ViewTransform,
  to: ViewTransform,
  width: number,
  height: number,
): Float32Array {
  const a = to.k / from.k;
  const bx = to.x - a * from.x;
  const by = to.y - a * from.y;
  const sx = a;
  const sy = a;
  const tx = a - 1 + (2 * bx) / width;
  const ty = 1 - a - (2 * by) / height;
  return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
}
