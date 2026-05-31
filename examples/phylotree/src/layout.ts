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
  angle?: number;
  radius?: number;
}

export type PNode = HierarchyNode<TreeNode> & PositionedNode;

/**
 * Rectangular dated phylogram. The main axis is TIME: tips (time 0, the present)
 * align at the right edge; the root (oldest) is at the left. py is leaf spacing.
 */
export function layoutRectangular(root: TreeNode, width: number, height: number, pad = 40): HierarchyNode<TreeNode> {
  const h = hierarchy(root, (d) => d.children);
  cluster<TreeNode>().size([height - 2 * pad, 1])(h);
  const maxTime = h.data.time || 1;            // the root's age
  const sw = width - 2 * pad;
  h.each((n: any) => {
    // (maxTime - time)/maxTime: root -> 0 (left), tips (time 0) -> 1 (right, aligned).
    n.px = pad + ((maxTime - n.data.time) / maxTime) * sw;
    n.py = pad + n.x;                          // cluster cross-axis = leaf spacing
  });
  return h;
}

/**
 * Radial dated phylogram: radius is TIME, so all tips (time 0) sit on the outer
 * rim (aligned at the present) and the root is at the centre.
 */
export function layoutRadial(root: TreeNode, width: number, height: number, pad = 30): HierarchyNode<TreeNode> {
  const h = hierarchy(root, (d) => d.children);
  cluster<TreeNode>().size([2 * Math.PI, 1])(h);
  const maxTime = h.data.time || 1;
  const R = Math.min(width, height) / 2 - pad;
  const cx = width / 2, cy = height / 2;
  h.each((n: any) => {
    const a = n.x;                             // angle from cluster (0..2π)
    const r = ((maxTime - n.data.time) / maxTime) * R;   // tips (time 0) -> R
    n.angle = a;
    n.radius = r;
    n.px = cx + r * Math.cos(a);
    n.py = cy + r * Math.sin(a);
  });
  return h;
}
