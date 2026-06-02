import { hierarchy, cluster, type HierarchyPointNode } from "d3-hierarchy";
import { pointRadial } from "d3-shape";
import { scaleLinear, scaleSymlog } from "d3-scale";
import type { TreeNode } from "./tree.js";

export type LayoutMode = "rectangular" | "radial";
export type TimeScaleKind = "linear" | "log";

/**
 * Map a node's age (time before present; tips = 0, root = maxAge) to a position.
 * `present` is the coordinate for age 0, `root` the coordinate for the oldest node.
 * `scaleSymlog` is used for "log" because it is defined at 0 (unlike scaleLog).
 */
function timePosition(kind: TimeScaleKind, maxAge: number, present: number, root: number): (age: number) => number {
  if (kind === "log") {
    const s = scaleSymlog().domain([0, maxAge]).range([present, root]);
    return (age) => s(age);
  }
  const s = scaleLinear().domain([0, maxAge]).range([present, root]);
  return (age) => s(age);
}

/**
 * Rectangular dated phylogram. Uses d3's HierarchyPointNode coordinates directly:
 * `x` = vertical leaf-spacing axis, `y` = horizontal time axis. Tips (age 0) align at
 * the right (the present); the root (oldest) sits at the left.
 */
export function layoutRectangular(
  root: TreeNode,
  width: number,
  height: number,
  time: TimeScaleKind,
  pad = 40,
): HierarchyPointNode<TreeNode> {
  const h = cluster<TreeNode>().size([height - 2 * pad, 1])(hierarchy(root, (d) => d.children));
  const maxAge = h.data.time || 1;
  const pos = timePosition(time, maxAge, width - pad, pad); // age 0 → right, age max → left
  h.each((n) => {
    n.x += pad;
    n.y = pos(n.data.time);
  });
  return h;
}

/**
 * Radial dated phylogram. d3 convention: `x` = angle (0..2π), `y` = radius (= time).
 * Tips (age 0) sit on the outer rim, the root at the centre. Cartesian positions come
 * from `d3.pointRadial(x, y)` and are origin-centred — the caller centres the view with
 * a `translate(CX, CY)` transform (which also lets `d3.linkRadial()` work unmodified).
 */
export function layoutRadial(
  root: TreeNode,
  width: number,
  height: number,
  time: TimeScaleKind,
  pad = 30,
  angleExtent = 2 * Math.PI,
  angleStart = 0,
): HierarchyPointNode<TreeNode> {
  const h = cluster<TreeNode>().size([angleExtent, 1])(hierarchy(root, (d) => d.children));
  const maxAge = h.data.time || 1;
  // A partial fan (e.g. a half-circle "sunset") can use a larger radius: the leaves span only
  // part of the disc, so it is bounded by half the width and the full height rather than the
  // inscribed circle.
  const half = angleExtent < 2 * Math.PI - 1e-9;
  const R = (half ? Math.min(width / 2, height) : Math.min(width, height) / 2) - pad;
  const pos = timePosition(time, maxAge, R, 0); // age 0 → R (rim), age max → 0 (centre)
  h.each((n) => {
    n.x += angleStart; // shift the fan's angular origin (e.g. centre a half-fan on "north")
    n.y = pos(n.data.time);
  });
  return h;
}

/** Cartesian world coordinates for a node, for points / labels / hit-testing. */
export function nodeXY(n: HierarchyPointNode<TreeNode>, mode: LayoutMode): [number, number] {
  return mode === "radial" ? pointRadial(n.x, n.y) : [n.y, n.x];
}
