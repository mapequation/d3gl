import { network, buildGraph, type NodeRadiusSpec, type NetworkGraph } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { generateLFR } from "./data.js";

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
 * An **LFR benchmark network** (power-law degrees + power-law communities with a mixing parameter —
 * the standard community-detection benchmark) rendered with the `network()` engine: nodes as
 * GPU-instanced points, links as instanced lines, triangle arrowheads for directed edges. Node
 * positions come from d3gl's in-library **force layout** (Barnes-Hut), seeded by **multilevel
 * coarsening** — no coordinates are supplied. `layout({ backend: "worker" })` runs the whole solve in
 * a Web Worker and streams positions back, so the layout **converges progressively on screen** while
 * the UI stays responsive. The Nodes slider scales 10 → 1,000,000; the Size toggle switches a uniform
 * vs **degree-weighted** radius; **Sizing** switches world vs **screen** (constant-pixel) glyphs. The
 * **LOD** toggle enables the adaptive hierarchy cut — dense communities collapse to aggregate glyphs
 * and expand into their members as you zoom in — with **Declutter** (thin overlaps) and **Edges**
 * (super-edges between aggregates). Pair LOD with screen sizing. Drag to pan, scroll to zoom.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.002, 200]); // wide range: zoom right out to the aggregate map, in to single nodes

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
      // LFR benchmark with clear community structure (low mixing) for the layout + LOD to resolve.
      const { nodeCount, source, target } = generateLFR(count, { mu: 0.1, seed: 1 });
      const graph = buildGraph({ nodeCount, source, target, directed });

      net
        .data(graph)
        .style({
          directed,
          nodeRadius: options.size === "Degree" ? degreeRadius(graph) : 4,
          nodeFill: "#4878d0",
          linkWidth: 0.6,
          // Translucent links so overlapping edges read as density — a hierarchical depth cue, and
          // it keeps the super-edge thicket legible under the nodes.
          linkStroke: "rgba(120,140,180,0.32)",
          arrowFill: "#9aa7bd",
          // "Screen" keeps glyphs a constant pixel size while you zoom (they don't vanish when
          // zoomed out) — the natural register for navigating a large layout, and what LOD wants.
          sizeMode: options.coords === "Screen" ? "screen" : "world",
        })
        // Enable the adaptive cut: aggregates draw a touch lighter than leaves, capped at 26px so
        // big collapsed clusters stay readable in screen mode. Frontier declutter thins overlapping
        // glyphs by importance. The cut tracks the layout as it converges and re-cuts on zoom.
        // Configured *before* layout() so the worker builds + streams the LOD tree itself (#103) —
        // the main thread then never coarsens or runs the O(N) geometry pass, only the O(visible) cut.
        .lod(
          options.lod === "On"
            ? {
                expandPx: 48,
                aggregateFill: "#7f97c8",
                maxAggregateRadius: 26,
                declutter: options.declutter !== "Off",
                superEdges: options.edges !== "Off",
              }
            : false,
        )
        .layout({ backend: "worker", iterations, multilevel });
    },
  };
};
