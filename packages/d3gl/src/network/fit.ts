import type { ViewTransform } from "../core/index.js";
import type { LODTree } from "./lod.js";

/** World-space bounding box `[minX, minY, maxX, maxY]`. */
export type FitBox = [number, number, number, number];

/**
 * The tree's **fit nodes** — the top modules to frame the layout against: the children of the tree's
 * roots (a childless root, e.g. a tiny graph, contributes itself). A provided-module tree wraps all top
 * modules under a single synthetic root, so its children ARE the top modules; a coarsening/spatial tree's
 * root children are its coarsest real aggregates.
 *
 * Framing against these (rather than the leaves or the root's bounding radius) is what makes the fit
 * **robust to force-layout fling-outs** (#206): a stray leaf flung far away barely moves its module's
 * *centroid* and doesn't change the *median* module size, whereas the root's `extent` (a max bounding
 * radius) is inflated by that one leaf — which blows the frame up and shrinks the whole layout to a dot.
 *
 * O(tree size) — call **once per tree** and cache; the per-frame {@link fitBox} then reads these nodes'
 * live geometry, O(fit nodes).
 *
 * A **spatial** tree (#343) is different: its root's children are the 2-4 quadrants of a power-of-two box,
 * so their centroids depend on where the layout falls on that grid (an off-centre, loose frame that jumps
 * when the box re-sizes), and a flung-out node sits in a quadrant of its own — its centroid IS the outlier.
 * Its fit nodes are cells instead: the root's most populous cell is split until there are
 * {@link SPATIAL_FIT_CELLS}, and cells holding under {@link SPATIAL_FIT_MIN_SHARE} of the nodes (a
 * fling-out's) are left out. Only the top of the tree is touched — O(SPATIAL_FIT_CELLS²), independent of
 * the node count — which matters because it is rebuilt every streamed frame.
 */
export function fitNodes(tree: LODTree): Uint32Array {
  const { parent, size, levelCount, levelOffset, childOffset, children } = tree;
  const isRoot = (g: number): boolean => (parent ? parent[g]! < 0 : g >= levelOffset[Math.max(0, levelCount - 1)]!);
  const out: number[] = [];
  const first = tree.morton ? levelOffset[Math.max(0, levelCount - 1)]! : 0;
  for (let g = first; g < size; g++) {
    if (!isRoot(g)) continue;
    const c0 = childOffset[g]!;
    const c1 = childOffset[g + 1]!;
    if (c1 > c0) for (let p = c0; p < c1; p++) out.push(children[p]!);
    else out.push(g); // a root with no children (tiny graph) frames against itself
  }
  return tree.morton ? spatialFitCells(tree, out) : Uint32Array.from(out);
}

/** Cells a spatial tree frames against (#343) — enough that none dominates the centroid box. */
const SPATIAL_FIT_CELLS = 32;
/** A cell holding less than this share of the nodes is left out of a spatial tree's fit (a fling-out). */
const SPATIAL_FIT_MIN_SHARE = 0.005;

/** Split the most populous of `nodes` until there are {@link SPATIAL_FIT_CELLS}, then drop the sparse ones. */
function spatialFitCells(tree: LODTree, nodes: number[]): Uint32Array {
  const { count, childOffset, children } = tree;
  const size = (g: number): number => count[g] ?? 0;
  while (nodes.length < SPATIAL_FIT_CELLS) {
    let best = -1;
    for (let i = 0; i < nodes.length; i++) {
      const g = nodes[i] ?? 0;
      if ((childOffset[g + 1] ?? 0) > (childOffset[g] ?? 0) && (best < 0 || size(g) > size(nodes[best] ?? 0))) best = i;
    }
    if (best < 0) break; // only leaves left (a tiny graph)
    const g = nodes[best] ?? 0;
    nodes[best] = nodes[nodes.length - 1] ?? g;
    nodes.pop();
    for (let p = childOffset[g] ?? 0; p < (childOffset[g + 1] ?? 0); p++) nodes.push(children[p] ?? 0);
  }
  const min = SPATIAL_FIT_MIN_SHARE * tree.leafCount;
  const kept = nodes.filter((g) => size(g) >= min);
  return Uint32Array.from(kept.length > 0 ? kept : nodes);
}

/**
 * Robust bounding box to frame the layout, from the {@link fitNodes} (top modules): the bbox of their
 * **centroids**, padded on all sides by the **median** of their `extent`s. Both statistics ignore a
 * single flung-out node — the centroids are means and the median module size discards the one module
 * whose `extent` that node inflated — so the frame tracks the bulk of the layout, not its outliers.
 * O(n log n) over the fit nodes (n = top modules ≪ node count); `scratch` (len ≥ n) is reused for the
 * median so there's no per-frame allocation. Null if there are no fit nodes.
 */
export function fitBox(tree: LODTree, nodes: Uint32Array, scratch: Float32Array): FitBox | null {
  const n = nodes.length;
  if (n === 0) return null;
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  for (let i = 0; i < n; i++) {
    const g = nodes[i]!;
    const x = tree.cx[g]!;
    const y = tree.cy[g]!;
    if (x < minCx) minCx = x;
    if (y < minCy) minCy = y;
    if (x > maxCx) maxCx = x;
    if (y > maxCy) maxCy = y;
    scratch[i] = tree.extent[g]!;
  }
  const view = scratch.subarray(0, n);
  view.sort();
  const pad = n % 2 ? view[(n - 1) / 2]! : (view[n / 2 - 1]! + view[n / 2]!) / 2; // median extent
  return [minCx - pad, minCy - pad, maxCx + pad, maxCy + pad];
}

/**
 * The view transform that frames `box` into a `width × height` viewport: centre the box's centre in the
 * view and scale its longest side to `fill` (default 0.85) of the shorter viewport dimension. Pure — the
 * per-frame fit computes this from {@link fitBox} (or a one-time position bbox) and applies it.
 */
export function fitTransform(box: FitBox, width: number, height: number, fill = 0.85): ViewTransform {
  const [minX, minY, maxX, maxY] = box;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const k = (fill * Math.min(width, height)) / span;
  return { k, x: width / 2 - k * cx, y: height / 2 - k * cy };
}
