import { useEffect, useRef } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { link as d3link, curveStepBefore } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type BackendType } from "@mapequation/d3gl/map";
import { makeTree, type TreeNode } from "../shared/tree.js";
import { layoutRectangular, nodeXY } from "../shared/layout.js";

type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

export interface PhyloTreeReactProps {
  backend: BackendType;
  width: number;
  height: number;
  onEngine: (engine: Plot) => void;
}

/**
 * A pure renderer for the 64-tip rectangular phylogram (`d3.link(curveStepBefore)`
 * branches, `schemeCategory10` tip nodes), mirroring the vanilla simple-tree example.
 * The shared Astro control bar drives `backend`/size via props — no status bar here.
 *
 * Rather than the `<GeoMap>` wrapper, this drives the imperative `plot` engine directly.
 * The engine is created ONCE in a mount effect (and torn down on unmount); backend changes
 * are handled in a SEPARATE effect that calls `chart.setBackend()` (preserving zoom/pan) —
 * so we never recreate the chart on a backend swap.
 */
export default function PhyloTreeReact({ backend, width, height, onEngine }: PhyloTreeReactProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Plot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const root = layoutRectangular(makeTree(64), width, height, "linear");
    const links = root.links();
    const tips = root.leaves();

    // Rectangular step links via a d3-shape link generator drawing into the d3gl context.
    const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);

    const chart = plot(host, { width, height, backend });
    chartRef.current = chart;
    chart.layer("links", links, {
      draw: (ctx, l) => { gen.context(ctx); gen(l); },
      stroke: "#555",
      lineWidth: 0.8,
    });
    chart.points("nodes", tips, {
      x: (n) => nodeXY(n, "rectangular")[0],
      y: (n) => nodeXY(n, "rectangular")[1],
      radius: 2.6,
      fill: (n) => schemeCategory10[n.data.group % 10] ?? "#888",
    });
    chart.enableZoom([0.5, 40]);
    chart.render();
    onEngine(chart);

    return () => { chart.destroy(); chartRef.current = null; };
    // Build once on mount; backend is handled in a separate effect (preserves zoom).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap backend in place so the current zoom/pan is preserved (no recreate).
  useEffect(() => { chartRef.current?.setBackend(backend); }, [backend]);

  return <div ref={hostRef} style={{ position: "relative", width, height }} />;
}
