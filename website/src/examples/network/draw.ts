import { network, buildGraph, type NodeRadiusSpec, type NetworkGraph, type NetworkHit } from "@mapequation/d3gl/network";
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
  if (hi <= lo) return 6; // uniform degree (e.g. a single clique) — nothing to scale
  return { by: "degree", scale: scaleSqrt().domain([lo, hi]).range([3, 13]) };
}

/**
 * An **LFR benchmark network** (power-law degrees + power-law communities with a mixing parameter —
 * the standard community-detection benchmark) rendered with the `network()` engine: nodes as
 * GPU-instanced points, links as instanced lines, triangle arrowheads for directed edges. Node
 * positions come from d3gl's in-library **force layout** (Barnes-Hut), seeded by **multilevel
 * coarsening** — no coordinates are supplied. `layout({ backend: "worker" })` runs the whole solve in
 * a Web Worker and streams positions back, so the layout **converges progressively on screen** while
 * the UI stays responsive. The Nodes slider scales 10 → 1,000,000; **Node size** switches a uniform
 * vs **degree-weighted** radius; **Edge size** switches uniform vs **weight-scaled** links (LOD
 * super-edges thicken + darken with their accumulated weight); **Sizing** switches world vs **screen**
 * (constant-pixel) glyphs. The
 * **LOD** toggle enables the adaptive hierarchy cut — dense communities collapse to aggregate glyphs
 * and expand into their members as you zoom in — with **Declutter** (thin overlaps) and **Edges**
 * (super-edges between aggregates). Pair LOD with screen sizing. Drag empty space to pan, scroll to zoom.
 * **Hover or click** a glyph to resolve the node — or the module it collapsed into — shown top-left.
 * **Drag a node or a collapsed module** to move it: it tracks the cursor with no lag while the off-thread
 * worker layout reheats around it and re-cools on release (grab a module to drag its whole subtree).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.002, 200]); // wide range: zoom right out to the aggregate map, in to single nodes
  // Node-drag (#140): grab a node or a collapsed module and drag it — it tracks the cursor with no lag
  // while the off-thread worker layout **reheats** around it and re-cools on release. Grab a selected
  // node to drag the whole selection; grab a module aggregate to drag its whole subtree. Plain drag on
  // empty space still pans. Hover/click also light a ring (selection) via the same interactive() opt-in.
  // hover ring blue (the default white ring is invisible on this light background); select ring orange.
  net.interactive({ selectable: { multi: true }, hover: { stroke: "#2563eb" }, draggable: true });

  // Picking (#105 N7a): hover/click resolve the node or aggregate under the cursor via the engine's
  // CPU hit-test over the LOD cut frontier — bounded by the visible set, so it stays cheap at 1M. The
  // same on("hover"/"click") API the GeoMap/Plot examples use; network just teaches pick() to see the
  // instanced glyphs. Shown in a small overlay so the resolution is visible (no GPU readback needed).
  const readout = document.createElement("div");
  readout.className = "absolute top-2 left-2 pointer-events-none rounded bg-white/85 px-2 py-1 font-mono text-[12px] leading-tight text-[#333]";
  const describe = (hit: { id: string | number; datum: unknown } | null): string => {
    if (!hit) return "hover a node or module";
    const d = hit.datum as NetworkHit;
    return d.aggregate ? `module · ${d.count.toLocaleString()} nodes` : `node ${hit.id}`;
  };
  readout.textContent = describe(null);
  host.appendChild(readout);
  net.on("hover", (hit) => { readout.textContent = describe(hit); });
  net.on("click", (hit) => { if (hit) readout.textContent = `clicked ${describe(hit)}`; });

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
      // Weighted so links vary and LOD super-edges thicken/darken with their accumulated weight.
      const { nodeCount, source, target, weight } = generateLFR(count, { mu: 0.1, seed: 1, weighted: true });
      const graph = buildGraph({ nodeCount, source, target, weight, directed });

      // The raw graph is unweighted (every edge weight 1); the per-edge "weight" that varies is the
      // **accumulated flow of an LOD super-edge**. Encode it in both width and colour so a heavier
      // super-edge reads as thicker AND darker (the same scale applies to each edge's weight, so a
      // super-edge uses its summed weight). Width follows the Edge-size toggle; colour always encodes it.
      const edgeWidth =
        options.edge === "Uniform"
          ? 0.8
          : { by: "weight" as const, scale: scaleSqrt().domain([1, 25]).range([0.5, 5]).clamp(true) };
      // Colour by weight via a d3 colour scale: light/translucent at weight 1 → darker/opaque with
      // accumulated super-edge weight (scaleSqrt interpolates the RGBA range, alpha included).
      const linkStroke = {
        by: "weight" as const,
        scale: scaleSqrt<string>().domain([1, 25]).range(["rgba(150,165,205,0.3)", "rgba(65,95,150,0.85)"]).clamp(true),
      };

      net
        .data(graph)
        .style({
          directed,
          nodeRadius: options.size === "Uniform" ? 5 : degreeRadius(graph),
          nodeFill: "#4878d0",
          linkWidth: edgeWidth, // Edge size: Uniform (0.8) or ∝ √weight in [0.5, 5]
          linkStroke, // darker + more opaque with accumulated weight (arrowhead shares it)
          // arrowSize left unset → defaults to a function of link width (≈ the half-arrow tip).
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
                // Opt-in #139: also link a visible leaf to a still-collapsed module across a mixed frontier.
                crossLevelEdges: options.crossLevel === "On",
                // Opt-in #133: ease aggregates ↔ children across the expand threshold (slider × 0.1 = band).
                crossFade: ((options.crossFade as number) ?? 0) * 0.1,
              }
            : false,
        )
        .layout({ backend: "worker", iterations, multilevel });
    },
  };
};
