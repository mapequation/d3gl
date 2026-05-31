import { hierarchy, cluster, type HierarchyNode } from "d3-hierarchy";
import type { TreeNode } from "./tree.js";

/**
 * Extended node with final canvas coordinates (px, py).
 * px = horizontal axis (depth / branch length direction)
 * py = vertical axis (leaf spacing direction)
 * For radial: px, py are the Cartesian canvas coordinates.
 */
export interface PositionedNode {
  px: number;
  py: number;
  dist: number;
  angle?: number;
  radius?: number;
}

export type PNode = HierarchyNode<TreeNode> & PositionedNode;

/**
 * Rectangular phylogram.
 * px = pad + cumulative branch length * sx  (horizontal = depth axis)
 * py = pad + clusterX                        (vertical = leaf spacing axis)
 */
export function layoutRectangular(root: TreeNode, width: number, height: number, pad = 40): HierarchyNode<TreeNode> {
  const h = hierarchy(root, (d) => d.children);
  // cluster().size([cross-axis, main-axis]) — we set cross = height, main = 1 (we override with branch lengths)
  cluster<TreeNode>().size([height - 2 * pad, 1])(h);
  // cumulative distance from root
  let maxDist = 0;
  h.eachBefore((n: any) => {
    n.dist = (n.parent ? n.parent.dist : 0) + n.data.length;
    maxDist = Math.max(maxDist, n.dist);
  });
  const sx = (width - 2 * pad) / (maxDist || 1);
  // n.x from cluster() is the cross-axis position (vertical), n.dist is the depth (horizontal)
  h.each((n: any) => {
    n.px = pad + n.dist * sx;  // horizontal = depth
    n.py = pad + n.x;          // vertical = cluster cross-axis
  });
  return h;
}

/**
 * Radial phylogram.
 * px, py = Cartesian canvas coordinates from angle + radius.
 */
export function layoutRadial(root: TreeNode, width: number, height: number, pad = 30): HierarchyNode<TreeNode> {
  const h = hierarchy(root, (d) => d.children);
  cluster<TreeNode>().size([2 * Math.PI, 1])(h);
  let maxDist = 0;
  h.eachBefore((n: any) => {
    n.dist = (n.parent ? n.parent.dist : 0) + n.data.length;
    maxDist = Math.max(maxDist, n.dist);
  });
  const R = Math.min(width, height) / 2 - pad;
  const cx = width / 2, cy = height / 2;
  h.each((n: any) => {
    const a = n.x;  // angle from cluster (0..2π)
    const r = (n.dist / (maxDist || 1)) * R;
    n.angle = a;
    n.radius = r;
    n.px = cx + r * Math.cos(a);
    n.py = cy + r * Math.sin(a);
  });
  return h;
}
