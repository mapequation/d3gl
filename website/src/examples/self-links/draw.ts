import { network, buildGraph } from "@mapequation/d3gl/network";
import { scaleLinear } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { buildSelfLinkGraph, BOUNDS } from "./data.js";

/**
 * **Self-links** draw as a loop at their node, placed opposite the mean direction of the node's neighbours.
 * Several self-link edges on one node are summed into one loop, sized and coloured by the summed weight.
 * Switch the link **Style** and the **Sizing** mode, and the **backend** (WebGL / Canvas / SVG).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  const { minX, maxX, minY, maxY } = BOUNDS;
  const k = Math.min(width / (maxX - minX), height / (maxY - minY)) * 0.95;
  net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  net.enableZoom([k * 0.3, k * 12]);

  const g = buildSelfLinkGraph();
  const graph = buildGraph({ nodeCount: g.nodeCount, source: g.source, target: g.target, weight: g.weight, directed: true });
  net.data(graph).layout({ backend: "positions", positions: g.positions });

  const linkWidth = scaleLinear().domain([1, 4]).range([2, 7]);
  const linkColor = scaleLinear<string>().domain([1, 4]).range(["#9ecae1", "#2171b5"]);

  return {
    engine: net,
    render: (options) => {
      net.style({
        directed: true,
        linkStyle: options.style === "Arrow" ? "line" : "half-arrow",
        sizeMode: options.sizing === "Screen" ? "screen" : "world",
        nodeRadius: 18,
        nodeFill: "#f28e2b",
        linkWidth, // ∝ weight; a loop takes its node's summed self-link weight
        linkStroke: linkColor,
      });
    },
  };
};
