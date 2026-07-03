import { network, buildGraph, moduleColors } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { loadModularMap } from "./data.js";

/**
 * A **directed map of modules** from a baked LFR planted partition (#104 N6). Nodes are coloured by
 * their **module** (a categorical hue per community), sized by their random-walk **flow**, and ringed
 * by their **enter/exit flow**; directed links are **half-arrows** whose width + colour encode link
 * flow. In **screen** sizeMode the glyphs stay a constant pixel size as you zoom.
 *
 * The layout is the **module-aware GPU seed** (#180 N8.2): the provided module hierarchy is supplied
 * *before* `layout({ backend: "gpu" })`, so the WebGL2 Barnes-Hut solve is seeded **top-down over the
 * module tree** — modules (including the ragged, deeper-nested **super-modules** in `data.ts`) lay out
 * as coherent regions rather than an untangling disc. It streams frames, so the map converges live, then
 * frames itself to fill the view once settled. (Falls back to the CPU worker where float render targets
 * are unavailable.)
 *
 * The **LOD** control switches the cut: **Off** draws every node + half-arrow; **Standard** is plain
 * structural coarsening (it ignores the planted partition — aggregates joined by simple super-edge
 * lines); **Modules** uses the partition, so modules collapse to a single glyph and their connectivity
 * shows as **half-arrow super-edges that thicken with the accumulated flow** between modules. Scroll to
 * zoom: modules expand → sub-modules → leaves (the ragged branches nest to different depths).
 *
 * `net.labels({ max: 12, labelOf })` badges the **12 highest-flow glyphs in view** (#105 N7b) with their
 * size — re-ranked + re-placed as you pan/zoom. Unlike the symmetric gasket, flow varies here, so a
 * `max` cap meaningfully surfaces the dominant modules/hubs.
 *
 * `net.interactive({ selectable, hover, draggable })` adds the selection/hover rings + node-drag (#140):
 * hover/click rings a node or module, ⇧+drag box-selects (⌥ subtracts), and dragging a glyph — or a whole
 * selection, or a collapsed module — moves it (translate-only here, on the `positions` backend). It shows
 * the selection/hover ring living alongside the per-node **flowBorder** ring and a module's **aggregateOutline**.
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
  // Range minimums ≥ 1 so nodes/links never vanish (the ring may be 0 for interior nodes). The node
  // radius range top is slider-driven (see render) — smaller ⇒ less declutter ⇒ more nodes + edges show.
  const ringW = scaleSqrt().domain([0, maxEnter]).range([0, 6]);
  const linkW = scaleSqrt().domain([0, maxLink]).range([0.75, 6]); // thinner half-arrows
  // Link colour encodes flow like the half-arrow example — light → dark blue with flow — and is
  // semi-transparent (alpha also ∝ flow) so overlaps read as density, not black. So a reciprocal pair
  // shows its asymmetry in both width AND colour. (Manual lerp keeps the alpha a colour scale drops.)
  const linkStroke = (w: number) => {
    const t = Math.sqrt(Math.min(1, w / maxLink));
    const r = Math.round(150 - 110 * t);
    const g = Math.round(186 - 96 * t);
    const b = Math.round(221 - 60 * t);
    return `rgba(${r}, ${g}, ${b}, ${(0.4 + 0.5 * t).toFixed(3)})`;
  };

  // Supply the (ragged) module hierarchy BEFORE laying out, so the GPU force layout seeds MODULE-AWARE
  // (#180 N8.2): it lays the map out top-down over the module tree, so modules — including the deeper
  // super-modules — form coherent regions. `backend: "gpu"` streams frames, so the map converges live.
  net.data(graph);
  net.lod({ modules: d.modulePaths });
  net.layout({ backend: "gpu", iterations: 300 });

  // Once the module-aware layout settles, **scale it to fill the view** at the default zoom — so the map
  // opens framed and World/Screen sizing don't change the apparent scale (transform stays k=1). Centre on
  // the centroid and size from the 97th-percentile radius (robust to fling-outs). The GPU stream writes
  // graph.positions; scaling + committing them via the positions backend after settle is safe (the stream
  // has stopped) and leaves the map on the positions backend (drag translates, no sim to reheat).
  void net.whenSettled().then(() => {
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
    const s = (Math.min(width, height) / 2) * 0.85 / R; // scale the 97th-pct extent to ~0.85 of half the view
    for (let i = 0; i < graph.nodeCount; i++) {
      p[i * 2] = width / 2 + (p[i * 2]! - cx) * s;
      p[i * 2 + 1] = height / 2 + (p[i * 2 + 1]! - cy) * s;
    }
    net.layout({ backend: "positions", positions: p }); // commit the scaled layout at the default k=1 view
  });
  net.enableZoom([0.1, 40]); // default view; zoom out to the module map, in to single nodes
  // Selection + hover rings and node-drag (#140): hover/click rings a node or module (green hover, blue
  // selection), ⇧+drag box-selects (⌥ subtracts, red preview), and dragging a glyph — or a whole selected
  // set, or a collapsed module — moves it. The final layout is the `positions` backend, so a drag here
  // *translates* the grabbed set (no sim to reheat). Note how the selection/hover ring sits alongside the
  // per-node flowBorder ring and a collapsed module's aggregateOutline.
  net.interactive({ selectable: { multi: true }, draggable: true, hover: true });

  // Frontier labels (#105 N7b): here flow VARIES across modules, so capping with `max` surfaces the
  // highest-flow glyphs in view (badged with their size). The Labels slider sets the cap (top end =
  // "All", no limit); re-ranked + re-placed as you pan/zoom.
  const labelStyle = document.createElement("style");
  labelStyle.textContent = ".map-label{font:600 11px/1 system-ui,sans-serif;color:#111827;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff}";
  host.appendChild(labelStyle);
  // Labels slider → max cap; the last position is "All" (no limit).
  const LABEL_CAPS = [6, 12, 20, 30, 50, 100, Infinity];

  return {
    engine: net,
    dispose: () => labelStyle.remove(),
    render: (options) => {
      net.labels({ max: LABEL_CAPS[(options.maxLabels as number) ?? 1] ?? 12, className: "map-label", labelOf: (id, info) => (info.aggregate ? `${info.count}` : `n${id}`) });
      const sizeMode = options.sizing === "World" ? "world" : "screen";
      const expandPx = (options.expand as number) ?? 120;
      const declutter = options.declutter !== "Off";
      // Node-radius range top (leaf max; modules extrapolate above it via the same scale). Smaller →
      // smaller glyphs → declutter keeps more → more nodes + inter-module edges visible.
      const maxRadius = (options.maxRadius as number) ?? 21;
      const nodeR = scaleSqrt().domain([0, maxNodeFlow]).range([3, maxRadius]);
      net.style({
        directed: true,
        linkStyle: "half-arrow",
        sizeMode, // "screen" = constant-pixel glyphs (the navigation register LOD wants); "world" scales with zoom
        nodeRadius: { by: "flow", scale: nodeR }, // radius ∝ visit rate
        nodeFill: (i) => colors[i]!, // categorical module colour
        // Ring ∝ enter/exit flow; colour omitted ⇒ a darker shade of each glyph's own module colour.
        flowBorder: { flow: d.enterExit, scale: ringW },
        linkBend: 14, // px (screen mode)
        linkWidth: linkW, // half-arrow width ∝ link flow; super-edges use accumulated flow
        linkStroke, // semi-transparent blue, alpha ∝ flow
      });
      const mode = (options.lod as string) ?? "Modules";
      // A thin outline ring, set a few px outside the glyph, marks collapsed aggregates as expandable.
      const aggregateOutline = { width: 1.5, gap: 3 };
      // Opt-in #139: keep a visible leaf's links to a still-collapsed module across a mixed frontier.
      // Opt-in #133: ease modules ↔ sub-members across the expand threshold (slider × 0.1 = fade band).
      const crossLevelEdges = options.crossLevel === "On";
      const crossFade = ((options.crossFade as number) ?? 0) * 0.1;
      if (mode === "Off") {
        net.lod(false);
      } else if (mode === "Standard") {
        // Structural coarsening — no module info; aggregates joined by plain super-edge lines.
        net.lod({ expandPx, declutter, aggregateOutline, crossLevelEdges, crossFade });
      } else {
        // The planted partition drives the cut → directed half-arrow super-edges ∝ accumulated flow.
        // No aggregate-radius cap: a module is sized by `nodeRadius` applied to its members' summed
        // flow (the scale extrapolates above the leaf domain), so a module reads as its total flow.
        net.lod({ modules: d.modulePaths, expandPx, declutter, superEdges: true, aggregateOutline, crossLevelEdges, crossFade });
      }
    },
  };
};
