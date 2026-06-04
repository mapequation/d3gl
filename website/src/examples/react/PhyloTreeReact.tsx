import { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { link as d3link, curveStepBefore } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type BackendType } from "@mapequation/d3gl/map";
import { makeTree, type TreeNode } from "../shared/tree.js";
import { layoutRectangular, nodeXY } from "../shared/layout.js";
import { download } from "../../components/controls.ts";
import StatusBar from "./StatusBar.tsx";

type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

const WIDTH = 720;
const HEIGHT = 380;

/**
 * The same 64-tip rectangular phylogram as the vanilla simple-tree example,
 * rendered from React. This demonstrates the other valid React pattern: instead of
 * a wrapper component we drive the imperative `plot` engine directly inside a
 * `useEffect`, mounting it on a ref'd host and tearing it down with `chart.destroy()`
 * on cleanup. The effect re-runs on backend change to rebuild for the new backend.
 */
export default function PhyloTreeReact() {
  const [backend, setBackend] = useState<BackendType>("webgl");
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Plot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const root = layoutRectangular(makeTree(64), WIDTH, HEIGHT, "linear");
    const links = root.links();
    const tips = root.leaves();

    // Rectangular step links via a d3-shape link generator drawing into the d3gl context.
    const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);

    const chart = plot(host, { width: WIDTH, height: HEIGHT, backend });
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

    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, [backend]);

  const onExport = () => {
    const chart = chartRef.current;
    if (!chart) return;
    if (backend === "svg") download(URL.createObjectURL(new Blob([chart.toSVG()], { type: "image/svg+xml" })), "phylo-tree.svg");
    else download(chart.toPNG(), "phylo-tree.png");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <StatusBar
        backend={backend}
        onBackendChange={setBackend}
        onExport={onExport}
        exportLabel={backend === "svg" ? "Export SVG" : "Export PNG"}
      />
      <div ref={hostRef} style={{ position: "relative", width: WIDTH, height: HEIGHT }} />
    </div>
  );
}
