import type { ViewTransform } from "../core/index.js";
import type { LODTree } from "./lod.js";

/** World-space bounding box `[minX, minY, maxX, maxY]`. */
export type FitBox = [number, number, number, number];

/**
 * Bounding box of an LOD tree's **top-level (root) nodes**: the union of each root's `cx/cy ± extent`.
 * This is O(number of top-level nodes) — **independent of the leaf/node count** — and it bounds the
 * whole graph, because a node's `extent` is an upper bound on the distance from its centroid to any
 * descendant leaf (so a root's box contains all of its leaves). Used by fit-on-layout to reframe the
 * camera each streamed frame without an O(nodes) per-frame scan. Null for a tree with no levels/roots.
 */
export function topLevelBounds(tree: LODTree): FitBox | null {
  if (tree.levelCount <= 0) return null;
  const top = tree.levelCount - 1;
  const start = tree.levelOffset[top]!;
  const end = tree.levelOffset[top + 1]!;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let g = start; g < end; g++) {
    const x = tree.cx[g]!;
    const y = tree.cy[g]!;
    const e = tree.extent[g]!;
    if (x - e < minX) minX = x - e;
    if (y - e < minY) minY = y - e;
    if (x + e > maxX) maxX = x + e;
    if (y + e > maxY) maxY = y + e;
  }
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}

/**
 * The view transform that frames `box` into a `width × height` viewport: centre the box's centre in the
 * view and scale its longest side to `fill` (default 0.85) of the shorter viewport dimension. Pure — the
 * per-frame fit computes this from {@link topLevelBounds} (or a one-time position bbox) and applies it.
 */
export function fitTransform(box: FitBox, width: number, height: number, fill = 0.85): ViewTransform {
  const [minX, minY, maxX, maxY] = box;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const k = (fill * Math.min(width, height)) / span;
  return { k, x: width / 2 - k * cx, y: height / 2 - k * cy };
}
