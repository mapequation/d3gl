import { schemeCategory10 } from "d3-scale-chromatic";
import { link as d3link, curveStepBefore } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";
import { makeTree, type TreeNode } from "../shared/tree.js";
import { layoutRectangular, nodeXY } from "../shared/layout.js";

type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

/**
 * The smallest tree example: a 64-tip rectangular phylogram laid out with
 * `d3-hierarchy`'s cluster, with `d3.link(curveStepBefore)` branches and
 * `schemeCategory10` tip nodes. The `coords` option (`"world"` | `"screen"`)
 * selects the size mode — world units scale with zoom, screen pixels stay
 * constant. Pure d3gl; the harness owns backend, export, and the coords toggle.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const sizeMode = (options.coords as "world" | "screen") ?? "world";
  const root = layoutRectangular(makeTree(64), width, height, "linear");
  const links = root.links();
  const tips = root.leaves();

  // Rectangular step links: a d3-shape link generator drawing straight into the d3gl context.
  const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);

  const chart = plot(host, { width, height, backend });
  chart.layer("links", links, {
    draw: (ctx, l) => {
      gen.context(ctx);
      gen(l);
    },
    stroke: "#555",
    lineWidth: 0.8,
    sizeMode,
  });
  chart.points("nodes", tips, {
    x: (n) => nodeXY(n, "rectangular")[0],
    y: (n) => nodeXY(n, "rectangular")[1],
    radius: 2.6,
    fill: (n) => schemeCategory10[n.data.group % 10] ?? "#888",
    sizeMode,
  });
  chart.enableZoom([0.5, 40]);
  chart.render();

  return chart;
};
