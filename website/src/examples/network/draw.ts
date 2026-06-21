import { network, buildGraph, type NodeRadiusSpec, type NetworkGraph } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { makeNetwork } from "./data.js";

const SIZES = [10, 100, 1_000, 10_000, 100_000, 1_000_000];

/**
 * Degree-weighted node radius: a d3 `scaleSqrt` (area-proportional) over the graph's degree range,
 * handed to `nodeRadius` as `{ by: "degree", scale }`. Resolved once per style() — varying per-node
 * radius is a per-instance GPU attribute, so this costs nothing at draw time, even at 1M nodes.
 */
function degreeRadius(graph: NetworkGraph): NodeRadiusSpec {
  let lo = Infinity;
  let hi = 0;
  for (const d of graph.csr.degree) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  if (hi <= lo) return 5; // uniform degree (e.g. a single clique) — nothing to scale
  return { by: "degree", scale: scaleSqrt().domain([lo, hi]).range([2.5, 11]) };
}

/**
 * A ring-of-cliques network rendered with the `network()` engine: nodes as GPU-instanced points,
 * links as instanced lines, triangle arrowheads for directed edges. Node positions come from
 * d3gl's in-library **force layout** (Barnes-Hut), seeded by **multilevel coarsening** — no
 * coordinates are supplied. `layout({ backend: "worker" })` runs the whole solve in a Web Worker
 * and streams positions back, so the layout **converges progressively on screen** while the UI
 * stays responsive (drag/zoom mid-solve). The Nodes slider scales 10 → 1,000,000 to stress the
 * layout + renderer; the Size toggle switches between a uniform radius and **degree-weighted** node
 * size (a d3 `scaleSqrt` over the degree range), which is free even at 1M nodes. Drag to pan, scroll
 * to zoom.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.05, 20]);

  return {
    engine: net,
    render: (options) => {
      const count = SIZES[(options.nodes as number) ?? 1] ?? 100;
      const directed = options.mode !== "Undirected";
      // "Cold" disables multilevel seeding so you can watch the difference: multilevel snaps to a
      // good global arrangement then settles; cold starts from a disc and untangles slowly.
      const multilevel = options.seeding !== "Cold";
      // Scale per-tick work down as the graph grows so the off-thread solve stays responsive; the
      // worker keeps the main thread free regardless, streaming frames as it converges.
      const iterations = Math.min(250, Math.max(10, Math.round(2.5e6 / count)));
      const { nodeCount, source, target } = makeNetwork(count);
      const graph = buildGraph({ nodeCount, source, target, directed });

      net
        .data(graph)
        .style({
          directed,
          nodeRadius: options.size === "Degree" ? degreeRadius(graph) : 4,
          nodeFill: "#4878d0",
          linkWidth: 0.6,
          linkStroke: "#cfd8e6",
          arrowFill: "#9aa7bd",
        })
        .layout({ backend: "worker", iterations, multilevel });
    },
  };
};
