import { network, buildGraph, moduleColors } from "@mapequation/d3gl/network";
import { scaleSqrt, scaleLinear } from "d3-scale";
import { rgb } from "d3-color";
import type { ImperativeSetup } from "../types.js";
import { loadModularMap } from "./data.js";

/**
 * A **directed map of modules** from a baked LFR planted partition (#104 N6). Nodes are coloured by
 * their **module** (a categorical hue per community), sized by their random-walk **flow**, and ringed
 * by their **enter/exit flow**; directed links are **half-arrows** whose width + colour encode link
 * flow. In **screen** sizeMode the glyphs stay a constant pixel size as you zoom.
 *
 * The **LOD** control switches the cut: **Off** draws every node + half-arrow; **Standard** is plain
 * structural coarsening (it ignores the planted partition — aggregates joined by simple super-edge
 * lines); **Modules** uses the partition, so modules collapse to a single glyph and their connectivity
 * shows as **half-arrow super-edges that thicken with the accumulated flow** between modules. Scroll to
 * zoom: modules expand → sub-members → leaves.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });

  const d = loadModularMap();
  const graph = buildGraph({
    nodeCount: d.nodeCount,
    source: d.source,
    target: d.target,
    weight: d.linkFlow, // edge weight = flow, so LOD super-edges accumulate flow
    directed: true,
    nodeFlow: d.nodeFlow,
  });
  // Categorical colour per planted module; aggregates inherit their module's colour under LOD.
  const colors = moduleColors(d.modulePaths, { lightness: 62, chroma: 58 });

  const maxNodeFlow = d.nodeFlow.reduce((a, b) => Math.max(a, b), 0);
  const maxEnter = d.enterExit.reduce((a, b) => Math.max(a, b), 0);
  const maxLink = d.linkFlow.reduce((a, b) => Math.max(a, b), 0);
  // Range minimums ≥ 1 so nodes/links never vanish (the ring may be 0 for interior nodes).
  const nodeR = scaleSqrt().domain([0, maxNodeFlow]).range([3, 26]);
  const ringW = scaleSqrt().domain([0, maxEnter]).range([0, 6]);
  const linkW = scaleSqrt().domain([0, maxLink]).range([1, 10]);
  const linkC = scaleLinear<string>().domain([0, maxLink]).range(["#aebfdd", "#21386e"]);

  net.data(graph).layout({ backend: "force", iterations: 320 });

  // Frame the laid-out map: centre on the centroid, size from the 97th-percentile radius (so a
  // force-layout fling-out doesn't shrink everything). Zoom out → modules collapse into the map of
  // modules; zoom in → they expand to sub-members and leaves. (setTransform before enableZoom so the
  // first gesture doesn't jump.)
  const p = graph.positions;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < graph.nodeCount; i++) {
    cx += p[i * 2]!;
    cy += p[i * 2 + 1]!;
  }
  cx /= graph.nodeCount;
  cy /= graph.nodeCount;
  const dists = Array.from({ length: graph.nodeCount }, (_, i) => Math.hypot(p[i * 2]! - cx, p[i * 2 + 1]! - cy)).sort((a, b) => a - b);
  const R = dists[Math.floor(graph.nodeCount * 0.97)] || 1;
  const k = (Math.min(width, height) / (2 * R)) * 0.85;
  net.setTransform({ k, x: width / 2 - k * cx, y: height / 2 - k * cy });
  net.enableZoom([k * 0.2, k * 30]); // out to the module map, in to single nodes

  return {
    engine: net,
    render: (options) => {
      net.style({
        directed: true,
        linkStyle: "half-arrow",
        sizeMode: "screen", // constant-pixel glyphs — the navigation register LOD wants
        nodeRadius: { by: "flow", scale: nodeR }, // radius ∝ visit rate
        nodeFill: (i) => colors[i]!, // categorical module colour
        // Ring ∝ enter/exit flow, in a darker shade of the node's module colour.
        flowBorder: { flow: d.enterExit, scale: ringW, color: (_v, i) => rgb(colors[i]!).darker(1).formatHex() },
        linkBend: 14, // px (screen mode)
        linkWidth: linkW, // half-arrow width ∝ link flow; super-edges use accumulated flow
        linkStroke: linkC, // half-arrow colour ∝ link flow
      });
      const mode = (options.lod as string) ?? "Modules";
      if (mode === "Off") {
        net.lod(false);
      } else if (mode === "Standard") {
        // Structural coarsening — no module info; aggregates joined by plain super-edge lines.
        net.lod({ expandPx: 44, maxAggregateRadius: 28, declutter: true });
      } else {
        // The planted partition drives the cut → directed half-arrow super-edges ∝ accumulated flow.
        net.lod({ modules: d.modulePaths, expandPx: 44, maxAggregateRadius: 28, declutter: true, superEdges: true });
      }
    },
  };
};
