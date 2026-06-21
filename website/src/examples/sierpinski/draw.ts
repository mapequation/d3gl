import { network, buildGraph } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { generateSierpinskiMap } from "./data.js";

const DEPTHS = [2, 3, 4, 5, 6]; // 27 → 2187 nodes

const max = (a: Float32Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
};

/**
 * A **directed map of networks**: a Sierpinski gasket whose recursive subdivision *is* an Infomap-style
 * module hierarchy, rendered with the `network()` map register. Module/node discs are sized by **total
 * flow** with a **flow-border** ring ∝ enter/exit flow; inter-module links are **bent half-arrows**
 * weighted by flow. With **LOD** on, the provided hierarchy drives the adaptive cut — modules collapse
 * to single glyphs zoomed out and expand → sub-modules → leaf triangles as you zoom in (scroll to zoom,
 * drag to pan); the bent super-edges summarise connectivity at each level. The **Depth** slider grows
 * the gasket from 27 to 2,187 nodes.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  // Frame the fixed gasket span (~[0,1000]×[0,866]) once; render() never touches the transform.
  const k = Math.min(width / 1000, height / 900) * 0.86;
  net.setTransform({ k, x: width / 2 - 500 * k, y: height / 2 - 430 * k });
  net.enableZoom([k * 0.5, k * 60]);

  return {
    engine: net,
    render: (options) => {
      const depth = DEPTHS[(options.depth as number) ?? 2] ?? 4;
      const lod = options.lod !== "Off";
      const { nodeCount, source, target, weight, positions, flow, enterExit, modules } = generateSierpinskiMap(depth);
      const graph = buildGraph({ nodeCount, source, target, weight, directed: true, nodeFlow: flow });

      net
        .data(graph)
        .style({
          directed: true,
          sizeMode: "screen",
          // Disc size ∝ total flow; the border ring ∝ enter/exit (boundary) flow — the map-equation cues.
          nodeRadius: { by: "flow", scale: scaleSqrt().domain([0, max(flow)]).range([2.5, 16]) },
          nodeFill: "#cdd7ec",
          flowBorder: { flow: enterExit, scale: scaleSqrt().domain([0, max(enterExit)]).range([0, 7]), color: "#3b5b9b" },
          // Bent half-arrow links (curves bow reciprocal links apart); width ∝ √flow.
          linkBend: 0.18,
          linkStroke: "rgba(90,110,150,0.55)",
          linkWidth: 3,
          arrowFill: "#5a6e96",
        })
        .lod(lod ? { modules, expandPx: 44, maxAggregateRadius: 30, aggregateFill: "#aebede" } : false)
        .layout({ backend: "positions", positions });
    },
  };
};
