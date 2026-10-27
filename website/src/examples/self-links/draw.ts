import { network, buildGraph } from "@mapequation/d3gl/network";
import { scaleLinear, scaleOrdinal, scaleSqrt } from "d3-scale";
import { schemeTableau10 } from "d3-scale-chromatic";
import type { ImperativeSetup } from "../types.js";
import { buildSelfLinkGraph } from "./data.js";

/**
 * **Self-links** draw as a loop at their node, placed opposite the mean direction of the node's neighbours,
 * and styled like the other links: the loop's width follows its weight. Toggle **Directed** / **Undirected**,
 * switch the link **Style** and the **Sizing** mode, and the **backend** (WebGL / Canvas / SVG). **Bend** the
 * other links (`linkBend`, with its **Bend strength**), and shape the loop: **Loop spread** is the angle between its
 * two legs (`selfLinkSpread`, degrees) and **Loop length** how far it reaches out (`selfLinkLength`, node radii).
 * **Loops: Hidden** turns them off (`selfLinks: false`): the node sizes, by degree, stay as they are.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.1, 12]);

  const g = buildSelfLinkGraph();
  const graph = buildGraph({ nodeCount: g.nodeCount, source: g.source, target: g.target, weight: g.weight, directed: true });
  const color = scaleOrdinal(schemeTableau10);
  const radius = scaleSqrt().domain([1, 12]).range([5, 12]);
  const linkWidth = scaleLinear().domain([1, 5]).range([1, 5]);
  const linkColor = scaleLinear<string>().domain([1, 5]).range(["#b8c7dc", "#3a5a8c"]);

  net
    .data(graph)
    .interactive({ hover: true })
    .layout({ backend: "worker", iterations: 300, fit: true });

  return {
    engine: net,
    render: (options) => {
      net.style({
        directed: options.links === "Directed",
        // Half-arrows show direction, so undirected links are always plain lines.
        linkStyle: options.links === "Directed" && options.style === "Half-arrow" ? "half-arrow" : "line",
        sizeMode: options.sizing === "Screen" ? "screen" : "world",
        nodeRadius: { by: "degree", scale: radius },
        nodeFill: (i) => color(String(g.module[i])),
        linkWidth, // ∝ weight, loops included
        linkStroke: linkColor,
        linkBend: options.bend === "Bent" ? Number(options.bendStrength) : 0,
        selfLinks: options.loops === "Shown",
        selfLinkSpread: Number(options.loopSpread),
        selfLinkLength: Number(options.loopLength),
      });
    },
  };
};
