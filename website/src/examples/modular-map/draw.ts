import { network, buildGraph, moduleColors, type NetworkLODOptions } from "@mapequation/d3gl/network";
import { scaleSequentialLog, scaleSqrt, type ScaleContinuousNumeric } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import type { ImperativeSetup } from "../types.js";
import { asFtree, makeModularMap } from "./data.js";

/** Nodes slider → generated network size. Capped where the runtime random-walk flow stays snappy. */
const SIZES = [500, 1_000, 2_000, 5_000, 10_000, 20_000];

/**
 * A **directed map of modules** from a runtime LFR planted partition (#104 N6). Nodes are coloured by
 * their **module** (a categorical hue per community), sized by their random-walk **flow**, and ringed
 * by their **enter/exit flow**; directed links are **half-arrows** whose width + colour encode link
 * flow. In **screen** sizeMode the glyphs stay a constant pixel size as you zoom.
 *
 * A collapsed module's ring draws **its own** enter/exit flow — `flowBorder.moduleFlow(path)`, read from
 * the per-module flows in `data.ts` (#445) — not its members' sum, which would also count the flow between
 * its submodules. The **Fill** control switches the categorical module colours for colour ∝ flow,
 * `nodeFill: { by: "flow", scale }`: a collapsed module is then filled by its members' total flow.
 *
 * The module hierarchy is **data**: `net.data(graph, { modules })` hands it to the engine with the
 * graph (#326), so every module feature reads it whatever the LOD mode. The layout is the
 * **module-aware GPU seed** (#180 N8.2): the WebGL2 Barnes-Hut solve is seeded **top-down over the
 * module tree** — modules (including the ragged, deeper-nested **super-modules** in `data.ts`) lay out
 * as coherent regions rather than an untangling disc. `fit: true` (#206) keeps the camera framed on the
 * layout as it converges — it opens centred and view-filling and settles in place, with no jump. (Falls
 * back to the CPU worker where float render targets are unavailable.)
 *
 * The **Layout** control switches to the **nested** module layout (#324): each module's children laid out
 * inside its own disc — and with **Boundaries** on (`lod({ moduleBoundary })`, #329) every module the cut
 * has opened is ringed, on its disc under the nested layout. It runs on the GPU (`backend: "gpu"`, #355):
 * every module at every depth solves at once, and a fresh map streams in as one animation of all depths.
 * Switching goes on **warm**, from where the nodes are (#454): `layout({ backend: "gpu", nested: true, warm:
 * true, fit: true })` streams the map from the force layout on screen — the nodes glide into their modules'
 * discs as it forms, with no disc restart and no hidden solve first — and switching back,
 * `layout({ backend: "gpu", warm: true, fit: true })`, runs the force layout from the map: it spreads out to
 * the force model's own scale as it converges, the camera framing it as it grows. (Both fall back to the CPU
 * worker where the GPU layout cannot run.)
 *
 * **Boundaries: Module** (#471) styles each opened module's ring by its module: `color: "fill"` rings it
 * in the fill it had when collapsed, and `width: (path) => …` makes it as wide as the flow *into* the
 * module (its enter flow, through the same scale as the flow-border ring, which shows enter + exit flow).
 * **Line** is one thin ring for every module. Either way the rings sit above the links and below the nodes.
 *
 * The **Input** control hands the same map over as an Infomap **`.ftree`** would (#199): the graph keeps
 * only the links inside each bottom module, and the links between modules arrive as **module links**,
 * `data(graph, { modules, moduleLinks })`. Then no leaf edge carries a module's connectivity once it opens
 * — with **Boundaries** and **Cross-level edges** on, its links stay drawn, anchored at its ring (#329) —
 * and the **Force** layout pulls along the module links instead (#455): each is a spring between its two
 * modules' members, so linked modules gather and a dragged module pulls the ones it is linked to. An
 * `.ftree` has each module's enter/exit flow but none per node, so the flow border is given `moduleFlow`
 * alone (#471): the modules are ringed by their flow, the nodes not at all.
 *
 * The **Nodes** slider resizes the generated network (500 → 20,000): the map is regenerated — flow and
 * all — and re-laid-out, framing itself each time. The **LOD** control switches the cut:
 * **Off** draws every node + half-arrow; **Standard** is plain structural coarsening
 * (`source: "structure"` ignores the planted partition — aggregates joined by simple super-edge
 * lines); **Modules** (the default source once a hierarchy is set) uses the partition, so
 * modules collapse to a single glyph and their connectivity shows as **half-arrow super-edges that
 * thicken with the accumulated flow** between modules. Scroll to zoom: modules expand → sub-modules →
 * leaves (the ragged branches nest to different depths).
 *
 * `net.labels({ max: 12, labelOf })` badges the **12 highest-flow glyphs in view** (#105 N7b) with their
 * size — re-ranked + re-placed as you pan/zoom. Unlike the symmetric gasket, flow varies here, so a
 * `max` cap meaningfully surfaces the dominant modules/hubs.
 *
 * `net.interactive({ selectable, hover, draggable, tooltip })` adds the selection/hover rings, a tooltip and
 * node-drag (#140): hover/click rings a node or module, ⇧+drag box-selects (⌥ subtracts), and dragging a glyph — or a whole
 * selection, or a collapsed module — moves it: the GPU seed reheats around it, and under the **nested**
 * layout the node follows the cursor while only its module is re-laid out around it (a collapsed
 * module's sibling modules move aside in their parent); dragged to its module's edge, the node takes the
 * module's disc and ring along, pushing the modules around it aside, up the levels. Hold ⌘ (Ctrl on
 * Windows/Linux) to pan instead, even over a glyph (#178). It shows the selection/hover ring living
 * alongside the per-node **flowBorder** ring and a module's **outline**. With **Boundaries** on, a module
 * the cut has opened is hovered and selected by its **ring** (#476): the tooltip names the module, and the
 * highlight is drawn on its ring, exactly as for the module collapsed.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.1, 40]); // default view; zoom out to the module map, in to single nodes
  // Selection + hover rings and node-drag (#140): hover/click rings a node or module (red), ⇧+drag
  // box-selects (⌥ subtracts, yellow preview), and dragging a glyph — or a whole selected set, or a collapsed
  // module — moves it (⌘/Ctrl-drag pans instead). Note how the selection/hover ring sits alongside the
  // per-node flowBorder ring and a collapsed module's outline. An open module is hovered by its boundary
  // ring (#476): the same module datum, with `open: true`.
  net.interactive({
    selectable: { multi: true },
    draggable: true,
    hover: true,
    tooltip: (d, id) =>
      d.aggregate ? `${d.path ? `Module ${d.path.join(":")}` : "Aggregate"} · ${d.count} nodes${d.open ? " (open)" : ""}` : `Node n${id}`,
  });

  // Labels slider → max cap; the last position is "All" (no limit).
  const LABEL_CAPS = [6, 12, 20, 30, 50, 100, Infinity];

  // Regenerated + re-laid-out whenever the Nodes slider changes; flow-derived scales are rebuilt with it.
  let count = -1;
  let input = ""; // the Input control's last value
  let layoutMode = ""; // the Layout control's last value ("" = a fresh graph, nothing on screen yet)
  let colors: string[] = [];
  let enterExit: Float32Array<ArrayBufferLike> = new Float32Array();
  let moduleEnterExit = new Map<string, number>();
  let moduleEnter = new Map<string, number>();
  let flowColor: (flow: number) => string;
  let maxNodeFlow = 1;
  let ringW: ScaleContinuousNumeric<number, number>;
  let linkW: ScaleContinuousNumeric<number, number>;
  let linkStroke: (w: number) => string;

  return {
    engine: net,
    render: (options) => {
      const n = SIZES[(options.nodes as number) ?? 1] ?? 1_000;
      if (n !== count || options.input !== input) {
        count = n;
        input = options.input as string;
        const d = makeModularMap(n);
        enterExit = d.enterExit;
        moduleEnterExit = d.moduleEnterExit;
        moduleEnter = d.moduleEnter;
        // Categorical colour per planted module; aggregates inherit their module's colour under LOD.
        colors = moduleColors(d.modulePaths, { lightness: 62, chroma: 58 });
        maxNodeFlow = d.nodeFlow.reduce((a, b) => Math.max(a, b), 0);
        const maxEnter = d.enterExit.reduce((a, b) => Math.max(a, b), 0);
        const maxLink = d.linkFlow.reduce((a, b) => Math.max(a, b), 0);
        // Range minimums keep glyphs/links from vanishing (the ring may be 0 for interior nodes).
        ringW = scaleSqrt().domain([0, maxEnter]).range([0, 6]);
        // Fill "Flow": a log colour scale from the smallest node's flow to the whole map's, so a node and a
        // collapsed module — filled by its members' total flow — share one legend.
        const minNodeFlow = d.nodeFlow.reduce((a, b) => (b > 0 ? Math.min(a, b) : a), Infinity);
        flowColor = scaleSequentialLog(interpolateViridis).domain([minNodeFlow, 1]).clamp(true);
        linkW = scaleSqrt().domain([0, maxLink]).range([0.75, 6]); // thin half-arrows
        // Link colour encodes flow (light → dark blue) and is semi-transparent (alpha ∝ flow) so overlaps
        // read as density, not black — a reciprocal pair shows its asymmetry in both width AND colour.
        // (The scale interpolates the RGBA range, alpha included.)
        linkStroke = scaleSqrt<string>().domain([0, maxLink]).range(["rgba(150, 186, 221, 0.4)", "rgba(40, 90, 161, 0.9)"]).clamp(true);
        // ".ftree": only the links inside bottom modules are graph edges; the rest arrive as module links.
        const ftree = input === ".ftree" ? asFtree(d) : null;
        const graph = buildGraph({
          nodeCount: d.nodeCount,
          source: ftree?.source ?? d.source,
          target: ftree?.target ?? d.target,
          weight: ftree?.linkFlow ?? d.linkFlow, // edge weight = flow, so LOD super-edges accumulate flow
          directed: true,
          nodeFlow: d.nodeFlow,
        });
        // The (ragged) module hierarchy — and an .ftree's module links — travel with the graph (#326), so
        // both layouts read them in every LOD mode.
        net.data(graph, { modules: d.modulePaths, moduleLinks: ftree?.moduleLinks });
        layoutMode = "";
      }
      const layout = (options.layout as string) ?? "Force";
      if (layout !== layoutMode) {
        const fresh = layoutMode === "";
        layoutMode = layout;
        // The GPU force layout seeds MODULE-AWARE (#180 N8.2): it lays the map out top-down over the module
        // tree, so modules — including the deeper super-modules — form coherent regions. `fit: true` keeps
        // the camera framed on the layout as it converges (#206), so the map opens framed and settles in
        // place, no jump.
        // A switch goes on from where the nodes are (`warm`, #454): streamed from the map on screen.
        if (layout === "Force") net.layout({ backend: "gpu", fit: true, iterations: 300, warm: !fresh });
        // The nested map solves on the GPU (#355). A fresh graph opens framed on it, streaming all depths
        // together; a switch streams it from the force layout on screen, the nodes gliding into their
        // modules' discs as it forms (#454).
        else net.layout({ backend: "gpu", nested: true, fit: true, warm: !fresh });
      }

      // Frontier labels come pre-styled (dark 11px sans-serif + white halo) — no CSS needed.
      net.labels({ max: LABEL_CAPS[(options.maxLabels as number) ?? 1] ?? 12, labelOf: (id, info) => (info.aggregate ? `${info.count}` : `n${id}`) });
      const sizeMode = options.sizing === "World" ? "world" : "screen";
      // Expand slider; "Auto" (0) passes no expandPx, so the cut uses the tree-adaptive default —
      // ~48px for the structural tree, a module-sized threshold for the partition.
      const expandPx = (options.expand as number) || undefined;
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
        // Fill: a categorical module colour (a collapsed module keeps its hue), or colour ∝ flow — a collapsed
        // module is then filled by its members' total flow.
        nodeFill: options.fill === "Flow" ? { by: "flow", scale: flowColor } : (i) => colors[i]!,
        // Ring ∝ enter/exit flow; colour omitted ⇒ a darker shade of each glyph's own fill. A collapsed
        // module rings by its OWN enter/exit flow (by Infomap path), not its members' sum. An .ftree has
        // no per-node enter/exit flow: then only `moduleFlow` is given, and only the modules are ringed.
        flowBorder: {
          flow: input === ".ftree" ? undefined : enterExit,
          scale: ringW,
          moduleFlow: (path) => moduleEnterExit.get(path.join(":")),
        },
        linkBend: 0.15, // fraction of the link's length — keeps its shape at every zoom
        linkWidth: linkW, // half-arrow width ∝ link flow; super-edges use accumulated flow
        linkStroke, // semi-transparent blue, alpha ∝ flow
      });
      const mode = (options.lod as string) ?? "Modules";
      // #329: one outline per module — a ring a few px outside a collapsed module's glyph (marking it as
      // expandable) and, once the cut opens it, around its nested disc — so the map of modules stays
      // readable as you zoom into it. (Style the collapsed ring separately with `aggregateOutline`.)
      // #471 "Module": an open module's ring in its collapsed fill, as wide as the flow into it (its enter
      // flow through the ring scale; `undefined` → the default width). Read once per module, not per frame.
      const enterWidth = (path: readonly number[]): number | undefined => {
        const flow = moduleEnter.get(path.join(":"));
        return flow === undefined ? undefined : ringW(flow);
      };
      const moduleBoundary: NetworkLODOptions["moduleBoundary"] =
        options.boundaries === "Off"
          ? undefined
          : options.boundaries === "Line"
            ? { width: 1, opacity: 0.45 }
            : { color: "fill", width: enterWidth, opacity: 0.85 };
      // Opt-in #139: keep a visible leaf's links to a still-collapsed module across a mixed frontier.
      // Opt-in #133: ease modules ↔ sub-members across the expand threshold (slider × 0.1 = fade band).
      const crossLevelEdges = options.crossLevel === "On";
      const crossFade = ((options.crossFade as number) ?? 0) * 0.1;
      if (mode === "Off") {
        net.lod(false);
      } else if (mode === "Standard") {
        // Structural coarsening — ignores the partition; aggregates joined by plain super-edge lines.
        net.lod({ source: "structure", expandPx, declutter, moduleBoundary, crossLevelEdges, crossFade });
      } else {
        // The planted partition (the default source) drives the cut → directed half-arrow super-edges
        // ∝ accumulated flow. No aggregate-radius cap: a module is sized by `nodeRadius` applied to its
        // members' summed flow (the scale extrapolates above the leaf domain), so a module reads as its
        // total flow.
        net.lod({ expandPx, declutter, superEdges: true, moduleBoundary, crossLevelEdges, crossFade });
      }
    },
  };
};
