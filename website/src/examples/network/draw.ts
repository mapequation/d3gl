import { network, buildGraph } from "@mapequation/d3gl/network";
import type { ImperativeSetup } from "../types.js";
import { makeNetwork } from "./data.js";

const SIZES = [10, 100, 1_000, 10_000, 100_000, 1_000_000];

/**
 * A ring-of-cliques network rendered with the `network()` engine: nodes as GPU-instanced points,
 * links as instanced lines, triangle arrowheads for directed edges. Node positions come from
 * d3gl's in-library **force layout** (`layout({ backend: "force" })`, Barnes-Hut), seeded by
 * **multilevel coarsening** — no coordinates are supplied. The Nodes slider scales 10 → 1,000,000
 * to stress the layout + renderer. Force layout currently runs on the main thread, so the largest
 * sizes block briefly while solving (a Web Worker with progressive convergence is the next step).
 * Drag to pan, scroll to zoom.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.05, 20]);

  return {
    engine: net,
    render: (options) => {
      const count = SIZES[(options.nodes as number) ?? 1] ?? 100;
      const directed = options.mode !== "Undirected";
      // Scale iterations down as the graph grows so the one-time main-thread layout stays
      // bounded; the off-thread worker will let large sizes converge smoothly.
      const iterations = Math.min(250, Math.max(10, Math.round(2.5e6 / count)));
      const { nodeCount, source, target } = makeNetwork(count);

      net
        .data(buildGraph({ nodeCount, source, target, directed }))
        .style({
          directed,
          nodeRadius: 4,
          nodeFill: "#4878d0",
          linkWidth: 0.6,
          linkStroke: "#cfd8e6",
          arrowFill: "#9aa7bd",
        })
        .layout({ backend: "force", iterations });
    },
  };
};
