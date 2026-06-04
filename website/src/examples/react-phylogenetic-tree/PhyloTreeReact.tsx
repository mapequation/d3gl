import { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { link as d3link, curveStepBefore } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type BackendType } from "@mapequation/d3gl/map";
import { makeTree, type TreeNode } from "../shared/tree.js";
import { layoutRectangular, nodeXY } from "../shared/layout.js";

type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

export interface PhyloTreeReactProps {
  /** Fixed render size; the ExampleFrame canvas slot sizes the frame to match. */
  width?: number;
  height?: number;
}

/**
 * The 64-tip rectangular phylogram (`d3.link(curveStepBefore)` branches, `schemeCategory10`
 * tip nodes), mirroring the vanilla simple-tree example, rendered as a genuine Astro island.
 * There is NO control bar here — the shared ExampleFrame status bar drives it via scoped DOM
 * events. Rather than the `<GeoMap>` wrapper this drives the imperative `plot` engine directly:
 * a mount effect creates `plot(host, …)` once (and tears it down on unmount); a separate
 * `[backend]` effect calls `chart.setBackend()` so switching backend preserves zoom/pan.
 */
export default function PhyloTreeReact({ width = 720, height = 460 }: PhyloTreeReactProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Plot | null>(null);
  const [backend, setBackend] = useState<BackendType>("webgl");

  // Connect to the surrounding ExampleFrame control bar (read initial backend + subscribe).
  useEffect(() => {
    const frame = ref.current?.closest<HTMLElement>(".d3gl-example");
    if (!frame) return;
    setBackend((frame.dataset.backend as BackendType) ?? "webgl");
    const onSetBackend = (e: Event): void => setBackend((e as CustomEvent<BackendType>).detail);
    frame.addEventListener("d3gl:setbackend", onSetBackend);
    return () => frame.removeEventListener("d3gl:setbackend", onSetBackend);
  }, []);

  // Build the chart once; backend is handled in a separate effect (preserves zoom).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const root = layoutRectangular(makeTree(64), width, height, "linear");
    const links = root.links();
    const tips = root.leaves();

    // Rectangular step links via a d3-shape link generator drawing into the d3gl context.
    const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);

    // Create with the frame's current backend so the first paint matches the control bar.
    const frame = ref.current?.closest<HTMLElement>(".d3gl-example");
    const initial = (frame?.dataset.backend as BackendType) ?? "webgl";
    const chart = plot(host, { width, height, backend: initial });
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

    // Publish an export handle to the shared control bar.
    frame?.dispatchEvent(
      new CustomEvent("d3gl:ready", {
        detail: {
          exportImage: () =>
            frame.dataset.backend === "svg"
              ? { format: "svg" as const, data: chart.toSVG() }
              : { format: "png" as const, data: chart.toPNG() },
        },
      }),
    );

    return () => { chart.destroy(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap backend in place so the current zoom/pan is preserved (no recreate).
  useEffect(() => { chartRef.current?.setBackend(backend); }, [backend]);

  return (
    <div ref={ref}>
      <div ref={hostRef} style={{ position: "relative", width, height }} />
    </div>
  );
}
