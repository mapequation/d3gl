import { network, buildGraph } from "@mapequation/d3gl/network";
import type { ImperativeSetup } from "../types.js";
import { makeNetwork } from "./data.js";

/**
 * A raw directed network rendered with the `network()` engine: nodes as GPU-instanced points,
 * links as instanced lines, and triangle arrowheads for directed edges. The node positions come
 * from d3gl's in-library **force layout** (`layout({ backend: "force" })`) — no coordinates are
 * supplied. Rendering is WebGL-instanced — drag to pan, scroll to zoom.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.3, 8]);

  return {
    engine: net,
    render: (options) => {
      const count = (options.nodes as number) ?? 24;
      const directed = options.mode !== "Undirected";
      const { nodeCount, source, target } = makeNetwork(count);

      net
        .data(buildGraph({ nodeCount, source, target, directed }))
        .style({
          directed,
          nodeRadius: 6,
          nodeFill: "#4878d0",
          linkWidth: 1.5,
          linkStroke: "#c9c9c9",
          arrowFill: "#8a8a8a",
        })
        .layout({ backend: "force", iterations: 250 });
    },
  };
};
