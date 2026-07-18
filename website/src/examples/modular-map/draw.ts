import { network, buildGraph, moduleColors } from "@mapequation/d3gl/network";
import { scaleSqrt, type ScaleContinuousNumeric } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { makeModularMap } from "./data.js";

/** Nodes slider → generated network size. Capped where the runtime random-walk flow stays snappy. */
const SIZES = [500, 1_000, 2_000, 5_000, 10_000, 20_000];

/**
 * A **directed map of modules** from a runtime LFR planted partition (#104 N6). Nodes are coloured by
 * their **module** (a categorical hue per community), sized by their random-walk **flow**, and ringed
 * by their **enter/exit flow**; directed links are **half-arrows** whose width + colour encode link
 * flow. In **screen** sizeMode the glyphs stay a constant pixel size as you zoom.
 *
 * The layout is the **module-aware GPU seed** (#180 N8.2): the provided module hierarchy is supplied
 * *before* `layout({ backend: "gpu" })`, so the WebGL2 Barnes-Hut solve is seeded **top-down over the
 * module tree** — modules (including the ragged, deeper-nested **super-modules** in `data.ts`) lay out
 * as coherent regions rather than an untangling disc. `fit: true` (#206) keeps the camera framed on the
 * layout as it converges — it opens centred and view-filling and settles in place, with no jump. (Falls
 * back to the CPU worker where float render targets are unavailable.)
 *
 * The **Nodes** slider resizes the generated network (500 → 20,000): the map is regenerated — flow and
 * all — and re-laid-out on the GPU, framing itself each time. The **LOD** control switches the cut:
 * **Off** draws every node + half-arrow; **Standard** is plain structural coarsening (it ignores the
 * planted partition — aggregates joined by simple super-edge lines); **Modules** uses the partition, so
 * modules collapse to a single glyph and their connectivity shows as **half-arrow super-edges that
 * thicken with the accumulated flow** between modules. Scroll to zoom: modules expand → sub-modules →
 * leaves (the ragged branches nest to different depths).
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
  net.enableZoom([0.1, 40]); // default view; zoom out to the module map, in to single nodes
  // Selection + hover rings and node-drag (#140): hover/click rings a node or module (green hover, blue
  // selection), ⇧+drag box-selects (⌥ subtracts, red preview), and dragging a glyph — or a whole selected
  // set, or a collapsed module — moves it. Note how the selection/hover ring sits alongside the per-node
  // flowBorder ring and a collapsed module's aggregateOutline.
  net.interactive({ selectable: { multi: true }, draggable: true, hover: true });

  // Labels slider → max cap; the last position is "All" (no limit).
  const LABEL_CAPS = [6, 12, 20, 30, 50, 100, Infinity];

  // Regenerated + re-laid-out whenever the Nodes slider changes; flow-derived scales are rebuilt with it.
  let count = -1;
  let colors: string[] = [];
  let enterExit: Float32Array<ArrayBufferLike> = new Float32Array();
  let maxNodeFlow = 1;
  let modulePaths: { id: number; path: number[] }[] = [];
  let ringW: ScaleContinuousNumeric<number, number>;
  let linkW: ScaleContinuousNumeric<number, number>;
  let linkStroke: (w: number) => string;

  return {
    engine: net,
    render: (options) => {
      const n = SIZES[(options.nodes as number) ?? 1] ?? 1_000;
      if (n !== count) {
        count = n;
        const d = makeModularMap(n);
        modulePaths = d.modulePaths;
        enterExit = d.enterExit;
        // Categorical colour per planted module; aggregates inherit their module's colour under LOD.
        colors = moduleColors(d.modulePaths, { lightness: 62, chroma: 58 });
        maxNodeFlow = d.nodeFlow.reduce((a, b) => Math.max(a, b), 0);
        const maxEnter = d.enterExit.reduce((a, b) => Math.max(a, b), 0);
        const maxLink = d.linkFlow.reduce((a, b) => Math.max(a, b), 0);
        // Range minimums keep glyphs/links from vanishing (the ring may be 0 for interior nodes).
        ringW = scaleSqrt().domain([0, maxEnter]).range([0, 6]);
        linkW = scaleSqrt().domain([0, maxLink]).range([0.75, 6]); // thin half-arrows
        // Link colour encodes flow (light → dark blue) and is semi-transparent (alpha ∝ flow) so overlaps
        // read as density, not black — a reciprocal pair shows its asymmetry in both width AND colour.
        // (The scale interpolates the RGBA range, alpha included.)
        linkStroke = scaleSqrt<string>().domain([0, maxLink]).range(["rgba(150, 186, 221, 0.4)", "rgba(40, 90, 161, 0.9)"]).clamp(true);
        const graph = buildGraph({
          nodeCount: d.nodeCount,
          source: d.source,
          target: d.target,
          weight: d.linkFlow, // edge weight = flow, so LOD super-edges accumulate flow
          directed: true,
          nodeFlow: d.nodeFlow,
        });
        // Supply the (ragged) module hierarchy BEFORE laying out, so the GPU force layout seeds
        // MODULE-AWARE (#180 N8.2): it lays the map out top-down over the module tree, so modules —
        // including the deeper super-modules — form coherent regions. `fit: true` keeps the camera framed
        // on the layout as it converges (#206), so the map opens framed and settles in place, no jump.
        net.data(graph);
        net.lod({ modules: modulePaths });
        net.layout({ backend: "gpu", fit: true, iterations: 300 });
      }

      // Frontier labels come pre-styled (dark 11px sans-serif + white halo) — no CSS needed.
      net.labels({ max: LABEL_CAPS[(options.maxLabels as number) ?? 1] ?? 12, labelOf: (id, info) => (info.aggregate ? `${info.count}` : `n${id}`) });
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
        flowBorder: { flow: enterExit, scale: ringW },
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
        net.lod({ modules: modulePaths, expandPx, declutter, superEdges: true, aggregateOutline, crossLevelEdges, crossFade });
      }
    },
  };
};
