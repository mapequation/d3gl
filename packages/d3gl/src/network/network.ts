import { BaseEngine, type BaseEngineOptions, type HoverHit, type InteractiveLayerOptions, type LaneInteractive, type NodeDragSession } from "../map/base-engine.js";
import { networkLayers, networkLayersFromCache, noLodStyleCache, drawsLinks, frontierCircles, frontierHalos, boundaryRings, traceBoundaryRings, superEdges, makeSuperEdgesScratch, emitNodes, emitLinks, emitArrows, emitHalfLinks, traceFrontierGlyphs, traceFrontierHalos, traceSuperHalfArrows, traceSuperLines, traceSuperArrows, physicalPieInstances, tracePieWedges, rgbaCss, pickNodes, regionNodes, resolveNodeRadii, resolveNodeRadiusAggregate, resolveImportance, resolveFlowBorder, resolveNodeColors, resolveLinkWidthOf, resolveLinkColorOf, resolveLinkStrokeOf, flowBorderInnerRadii, type ResolvedNetworkStyle, type ModuleBoundaryResolved, type AggregateOutlineResolved, type NoLodStyleCache, type NodeRadiusSpec, type ImportanceSpec, type FlowBorderSpec, type ConstBorder, type LinkWidthSpec, type LinkColorSpec, type LinkStyle } from "./glyphs.js";
import { rgb } from "d3-color";
import { DRAG_HEAT, ForceLayout, seedPositions, type ForceParams } from "./force.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { buildLODTree, buildSpatialLODTree, computeLODGeometry, computeLODPositions, computeLODStyle, updateLODPositionsForLeaves, cut, makeCutScratch, makeCutBoundaries, declutterFrontier, makeDeclutterFrontierScratch, pickFrontier, regionFrontier, visibleWorldRect, leavesUnder, ancestorAwareSelected, type BoundaryDiscs, type CutBoundaries, type LODTree, type SpatialLODOptions } from "./lod.js";
import { DEFAULT_LABEL_TEXT, type LabelAnchor, type LabelStyle } from "../labels/label-layer.js";
import { TextMeasurer, canvasFont } from "../labels/measure.js";
import { buildModuleLODTree, checkModuleLinks, moduleRecordIndex, type ModuleLink, type ModuleNode } from "./modules.js";
import { nestedLayout, nestedBoundaryDiscs, type NestedLayoutParams } from "./nested-layout.js";
import { positionTransition, type PositionTransition } from "./transition.js";
import { moduleColors, type ModulePathNode, type ModuleColorOptions } from "./module-colors.js";
import { physicalPieWedges, type PhysicalPieWedges, type PieWedgeOptions } from "./pie.js";
import { rosettePositions } from "./rosette.js";
import { gatherCandidates, descendingByKey, CandidateList, type CandidateSource } from "./label-candidates.js";
import type { StateNetworkGraph } from "./state-graph.js";
import { startNestedWorkerLayout, startWorkerLayout, type WorkerLayoutHandle } from "./worker-transport.js";
import { startGpuLayout } from "./gpu/gpu-transport.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";
import type { NetworkGraph } from "./graph.js";
import { fitNodes, fitBox, fitTransform, type FitBox } from "./fit.js";
import type { InstancedLayer, ViewTransform } from "../core/index.js";
import { InstancedLane, type SelectionStrategy } from "../core/instanced-lane.js";
import { resolveRingColors, ringCircles } from "../map/highlight-ring.js";
import { hoverParts } from "../map/highlight.js";

/**
 * The collapsed-module outline ring's resolved line (#329): an explicit `aggregateOutline`, else
 * `moduleBoundary`'s line (so collapsed and expanded modules share one outline), else none.
 */
function aggregateOutlineOf(opts: NetworkLODOptions): Pick<AggregateOutlineResolved, "width" | "gap" | "color" | "opacity"> | null {
  const ao = opts.aggregateOutline;
  if (ao === false) return null;
  if (ao) return { width: ao.width ?? 1.5, gap: ao.gap ?? 2.5, color: ao.color ?? "#3a3f52", opacity: ao.opacity ?? 1 };
  const mb = opts.moduleBoundary;
  if (!mb) return null;
  return { width: mb.width ?? 1, gap: 2.5, color: mb.color ?? "#3a3f52", opacity: mb.opacity ?? 0.5 };
}

/** Options for the network engine. Inherits sizing, `backend`, and `tooltipClass`. */
export interface NetworkOptions extends BaseEngineOptions {}

/**
 * What a network {@link Network.pick} resolved — carried as the `datum` of the {@link HoverHit}
 * passed to `on("hover" | "click")` handlers. The hit's `id` is the tree node id: for a leaf that's
 * the original node index; an aggregate id is `≥ leafCount`.
 */
export interface NetworkHit {
  /** True if the target is an aggregate glyph (a collapsed module/subtree), false for a single node. */
  aggregate: boolean;
  /** Leaf nodes the target covers — 1 for a leaf, the subtree size for an aggregate. */
  count: number;
  /**
   * With a module hierarchy (`data(graph, { modules })`, or `lod({ modules })`): the target's Infomap
   * path — the module's path for a module aggregate (e.g. `[1, 2]`), the node's own full path for a leaf,
   * with LOD on or off (#326). Absent without a hierarchy, and for an aggregate of structural coarsening.
   * Lets `labelOf` / click handlers name a module. Computed when read, O(tree depth). With LOD off the
   * `labelOf` / `importanceOf` info carries no path (it is one shared object, so the per-frame label
   * pass allocates nothing); read the node's path from your records by `id` there.
   */
  readonly path?: readonly number[];
}

/** {@link NetworkHit} on a provided-module tree: `path` is derived from `parent` + `branch` only when read. */
class ModuleTreeHit implements NetworkHit {
  constructor(
    private readonly parent: Int32Array,
    private readonly branch: Int32Array,
    private readonly g: number,
    readonly aggregate: boolean,
    readonly count: number,
  ) {}
  get path(): number[] {
    const out: number[] = [];
    for (let g = this.g; g >= 0 && this.parent[g]! >= 0; g = this.parent[g]!) out.push(this.branch[g]!);
    return out.reverse();
  }
}

/** {@link NetworkHit} for a leaf outside a module tree (LOD off, or structural LOD) when the engine holds
 *  a hierarchy (#326): `path` is the node's own record path, copied only when read. */
class LeafRecordHit implements NetworkHit {
  readonly aggregate = false;
  readonly count = 1;
  constructor(private readonly record: ModuleNode) {}
  get path(): number[] {
    return Array.from(this.record.path);
  }
}

/**
 * What GPU-readback link picking (#141) resolved — carried as the `datum` of the {@link HoverHit} from
 * `on("hover" | "click")` (or {@link Network.pick}) when the cursor is over a **link**, with `layer:
 * "links"`. Enabled by {@link Network.pickLinks}. The hit's `id` is the link's stable identity: the edge
 * index with LOD off, or the directed tree-node pair (`source * tree.size + target`) under LOD.
 */
export interface NetworkLinkHit {
  /** Source node id. With LOD off a leaf node index; under LOD a tree-node id (aggregate if `≥ leafCount`). */
  source: number;
  /** Target node id (same id space as {@link source}). */
  target: number;
  /** True under LOD when either endpoint is an aggregate (a super-edge between collapsed modules). */
  aggregate: boolean;
  /** Edge flow/weight — the leaf edge's weight with LOD off, the summed super-edge flow under LOD. */
  weight: number;
}

/**
 * Options for {@link Network.labels} (#105 N7b) — a handful of importance-ranked text labels on the
 * LOD frontier (leaf or aggregate centroid), in an HTML overlay that re-places on pan/zoom. Only the
 * top {@link max} by importance within the viewport are shown, so density stays readable at any zoom.
 */
export interface NetworkLabelOptions {
  /** Text for a node/aggregate id. `info` describes the glyph (`{ aggregate, count }`) — for an
   *  aggregate return e.g. a module name or `${info.count}`, for a leaf the node's name. Return `null`
   *  / `""` to give that glyph no label. Default: a leaf → its id, an aggregate → `"N nodes"`. */
  labelOf?: (id: number, info: NetworkHit) => string | null | undefined;
  /** Hard cap on labels shown — the top-`max` by importance within the viewport. **Default: no cap** —
   *  every visible labelled glyph is shown, thinned only by collision culling. Set this to surface just
   *  the most important few on a dense map (ranking, hence a sort, runs only when this caps). */
  max?: number;
  /** Importance for ranking (higher = shown first) when {@link max} caps. Default: the LOD tree `weight`
   *  (summed flow/strength) with LOD on, node strength with LOD off. */
  importanceOf?: (id: number, info: NetworkHit) => number;
  /** Class set on each label element — the **advanced** styling path for the HTML overlay (WebGL
   *  backend): providing it SKIPS the built-in default style, so your class's CSS has full control
   *  (combine with {@link style} for inline overrides). Backend-native text (SVG/Canvas) can't use
   *  CSS; style it with the {@link font}/{@link color}/{@link halo} options below. */
  className?: string;
  /** Inline CSS (camelCased property → value) for the **HTML overlay** label elements, merged over
   *  the built-in default (a dark 11px sans-serif label with a white halo — `DEFAULT_LABEL_STYLE`),
   *  so a partial override like `{ color: "#1f2937" }` keeps the rest. Applied ONCE per element at
   *  creation — never per frame. Backend-native text (SVG/Canvas, incl. export) is styled with
   *  {@link font}/{@link color}/{@link halo}, whose defaults match this look. */
  style?: LabelStyle;
  /** Constant screen-px offset `[dx, dy]` from the glyph centroid (labels are centred on it by default). */
  offset?: [number, number];
  /**
   * State-network `"both"` view only (#171): also label the physical **containers**, placed just OUTSIDE
   * each container disc (upper-right, ≈1:30 on a clock) so the label clears the enclosed state rosette.
   * `labelOf` maps a physical id → text (`null`/`""` to skip); `gap` is the extra px beyond the disc edge
   * (default 4). Ignored outside the `both` view. The primary {@link labelOf} still labels the state nodes.
   */
  physical?: { labelOf: (physicalId: number) => string | null | undefined; gap?: number };
  /** Font for **backend-native** text (SVG `<text>` / Canvas `fillText`, and `toSVG()`/`toPNG()`
   *  export on every backend incl. WebGL — #105 N7b-2, #219) — a CSS font shorthand, e.g.
   *  `"600 11px sans-serif"`. Defaults to the overlay default's font (`DEFAULT_LABEL_TEXT`), so
   *  backends match with no options set. */
  font?: string;
  /** Fill colour for backend-native text. Defaults to the overlay default's colour. */
  color?: string;
  /** A legibility halo stroked behind backend-native text — the export analogue of a CSS text-shadow.
   *  `width` is the half-stroke in px. Defaults to the overlay default's white halo. */
  halo?: { color: string; width: number };
}

/** Visual style. Link appearance accessors arrive with the link pass (#100 N2.2). */
export interface NetworkStyle {
  /** Render links with arrowheads. Defaults to the graph's `directed` flag. */
  directed?: boolean;
  /**
   * Node radius (world units). A constant `number` (default 4), a per-node `Float32Array`, a
   * `(degree, index, graph) => radius` accessor (a bare d3 scale fits — it receives the node's
   * degree), or `{ by, scale }` to size by a chosen metric (`"degree"` | `"strength"` | `"flow"` |
   * custom accessor) through any scale. Resolved once per call — no per-frame or rendering cost.
   * @see {@link NodeRadiusSpec}
   */
  nodeRadius?: NodeRadiusSpec;
  /**
   * Per-node **declutter importance** — which glyph wins when two overlap (the kept one). A
   * {@link NodeMetric}/accessor/`Float32Array`, or `"order"` (input order). Summed up the LOD tree, so a
   * module's importance is its members' total. Defaults to the {@link nodeRadius} size metric (biggest
   * wins), falling back to input order for a constant size. @see {@link ImportanceSpec}
   */
  importance?: ImportanceSpec;
  /**
   * Node fill colour. A single CSS colour (default a medium blue), or a per-node
   * `(index, graph) => cssColour` accessor — e.g. a categorical palette keyed by module, so a
   * planted hierarchy reads as colour (#104 rework). Per-node colours propagate to LOD aggregates
   * (a collapsed module keeps its colour).
   */
  nodeFill?: string | ((index: number, graph: NetworkGraph) => string);
  /**
   * Constant border ring (#104 rework): a fixed **pixel** outline on every node/module (e.g.
   * `{ width: 1, color: "#fff" }`). Independent of {@link flowBorder} (which encodes flow);
   * `flowBorder` wins if both are set.
   */
  nodeBorder?: { width: number; color?: string };
  /**
   * How directed links are drawn (#104 N6). `"line"` (default) — a stroked line (straight, or bowed
   * by {@link linkBend}) plus a separate triangle arrowhead, as in the large-scale layout example.
   * `"half-arrow"` — the **map-of-networks** glyph: one filled shape per link that pinches to the
   * source centre and ends in a barbed arrowhead on the *target* node's boundary, with reciprocal
   * A→B / B→A links nesting around a shared centre curve. (Half-arrow links are world-sized.)
   * `"none"` — **draw the network as nodes only** (#157): the links, arrowheads and LOD super-edges
   * are *not built* — no geometry, no per-edge colour/width pass, no GPU upload — so turning links off
   * on a million-edge graph costs nothing rather than uploading a buffer to hide. A **constant**
   * `linkWidth: 0` takes the same path. Purely visual: the edges still drive the layout and the LOD
   * hierarchy, so links can be toggled back on without re-laying out.
   */
  linkStyle?: LinkStyle;
  /**
   * Link width. A constant (default 1), a **d3 scale of the edge weight** — `(weight) => width`, e.g.
   * `scaleSqrt().domain([0, maxWeight]).range([1, 6])` — or `{ by, scale }` for parity with
   * {@link nodeRadius} (`by` is `"weight"`/`"flow"`, the same per-edge quantity). A **super-edge**
   * applies the same scale to the **accumulated** weight of the edges it subsumes, so link thickness
   * reads as flow at every LOD level. Keep the scale's range minimum ≥ 1 so links never vanish.
   *
   * A **constant** `0` means "no links at all" and takes the {@link linkStyle} `"none"` skip path —
   * the link geometry is never built. A width *scale* that returns 0 for some weights does not: only
   * a literal constant is read as a global opt-out.
   */
  linkWidth?: LinkWidthSpec;
  /**
   * Link colour. A single CSS colour (default a light grey), or a `(weight) => cssColour` scale so
   * colour encodes the edge weight/flow (a bare d3 colour scale fits). The arrowhead always takes the
   * link's colour — there is no separate arrow fill.
   */
  linkStroke?: LinkColorSpec;
  /** Arrowhead size (world units) for directed `linkStyle:"line"` links. Default 3 × linkWidth. */
  arrowSize?: number;
  /**
   * `"world"` (default) — glyph sizes are in world units and scale with zoom. `"screen"` — sizes are
   * constant pixels regardless of zoom: the natural register for navigating a large layout (nodes
   * stay visible when zoomed out instead of going sub-pixel), and what LOD wants. `nodeRadius` /
   * `linkWidth` are then read as pixels. (Arrowheads stay world-sized for now, #103.)
   */
  sizeMode?: "world" | "screen";
  /**
   * Flow-border ring (N6 / #104): draw each node/module as a disc with an outer ring whose width
   * encodes a per-node **enter/exit flow** (`flow`: an app `Float32Array` or a built-in metric) via
   * `scale`. Module aggregates sum their members' flow over the same LOD cut. Fill/size still come
   * from `nodeFill`/`nodeRadius` (size by total flow with `nodeRadius: { by: "flow", scale }`). Omit
   * for plain filled nodes. @see {@link FlowBorderSpec}
   */
  flowBorder?: FlowBorderSpec;
  /**
   * Bend links into curves (N6c / #104). The quadratic-bezier control offset ⟂ to the chord as a
   * **fraction of chord length**, for `linkStyle:"line"` and `"half-arrow"` alike (try ~0.15; `0`
   * (default) keeps links straight). Because it is relative, a link keeps its shape at every zoom in
   * both size modes (#296). For half-arrows the bow side is derived from the link direction so a
   * reciprocal A→B / B→A pair nests around a shared centre curve instead of colliding.
   */
  linkBend?: number;
}

/** How node positions are produced. Applies to plain graphs ({@link Network.layout}) and, since #182,
 *  state networks ({@link Network.stateNetwork}) — there every backend lays out the **physical** graph
 *  and the state/both views' rosette is derived from it. */
export interface NetworkLayoutOptions {
  /** `"positions"` uses caller-supplied coordinates; `"force"` runs the in-library force layout on the
   *  main thread; `"worker"` runs it off-thread with progressive streaming; `"gpu"` runs a WebGL2
   *  Barnes-Hut solve (falling back to `"worker"` when unavailable). */
  backend?: "positions" | "force" | "worker" | "gpu";
  /** Interleaved `[x, y, …]` world coordinates for `backend: "positions"`. */
  positions?: Float32Array;
  /**
   * Tick budget of the force layout (`"force"` / `"worker"` / `"gpu"`, default 300) — a maximum, not a
   * fixed count (#124): a seeded layout (multilevel, or the GPU's module seed) cools over it, a cold
   * disc start keeps full heat to untangle, and the CPU backends stop as soon as the layout has
   * converged (nodes moving a small fraction of the equilibrium spacing per tick), resolving
   * {@link Network.whenSettled}. The GPU backend runs the whole budget (its early stop needs a GPU
   * readback it doesn't do yet).
   */
  iterations?: number;
  /**
   * Force parameters for the force backends. The layout settles into a disc of radius
   * `√(repulsion·N/centering)` — node spacing `√(π·repulsion/centering)` — and is seeded at that scale.
   */
  force?: Partial<ForceParams>;
  /**
   * For `backend: "force"` and `backend: "worker"`, seed the layout via multilevel coarsening
   * (heavy-edge matching) for faster convergence and fewer tangles on clustered graphs. Default
   * `true`; set `false` for a plain cold-start force run. Tiny / edgeless graphs skip coarsening
   * automatically.
   */
  multilevel?: boolean;
  /**
   * For the streaming backends (`"worker"` / `"gpu"`), keep the camera framed on the layout as it
   * converges: the view is fit to the layout's live bounds each streamed frame (centroid → view
   * centre, extent → ~85% of the view) and released to normal zoom/pan once it settles or the user
   * interacts. Without it a streaming layout converges wherever the solver centres it — the GPU
   * solve centres the centroid at the origin, so it would otherwise render at the top-left corner
   * until it settles. Default `false`. Ignored for `"positions"` / `"force"` (already final on the
   * first paint). The per-frame fit reads the layout's aggregate bounds (O(top-level modules), not
   * O(nodes)) when LOD geometry exists; with LOD off it fits once from the initial extent and holds.
   */
  fit?: boolean;
  /**
   * **Nested module layout** (#324) — the "map of modules": with a module hierarchy set
   * (`data(graph, { modules })`, #326, or `lod({ modules })`), lay the module tree out top-down, each
   * module's children inside its own disc, arranged only by their sibling links (the super-edges
   * between them — for an `.ftree` exactly its `*Links` rows, #199). Every module stays a compact
   * region inside its parent, so the map opens on the top modules and expands in place; each depth is
   * final, so a streamed layout never oscillates. Works with LOD off or on any {@link NetworkLODOptions.source}.
   * Once it lands, a LOD cut of the laid-out module tree treats each module as its disc (#329): drawn at
   * the disc's centre, culled by it, and expanded once the disc's diameter on screen reaches `expandPx`.
   * Runs off-thread on `backend: "worker"` (streamed top-down, one frame per depth) and synchronously
   * on `"force"`; `"gpu"` uses the worker until a GPU path exists. Ignored without a hierarchy.
   *
   * `true` sizes discs by node flow (leaf count when the graph has none); pass `{ size: "count" }` to
   * size by leaf count, and `iterations` / `packing` to tune each module's solve. `{ warm: true }`
   * re-lays the map out from the current positions — for a re-clustering (#328).
   * @see {@link nestedLayout}
   */
  nested?: boolean | NestedLayoutConfig;
  /**
   * **Transition** (#328): ease the nodes from their current positions to the new layout over this
   * many milliseconds (cubic ease-in-out) on the main thread, instead of jumping or streaming. Default
   * `0` (no transition). Applies to every layout computed in one go — `"positions"`, `"force"`, and a
   * `nested` layout on any backend (whose worker then posts only the final layout, no depth frames);
   * the streaming `"worker"` / `"gpu"` force layouts ignore it (they already animate as they converge),
   * as does a state network's layout.
   *
   * Each transition frame is a positions-only repaint — one O(nodes) interpolation, the LOD tree's
   * O(tree size) position pass (no style pass) and the normal re-emit — no more than a streamed layout
   * frame. {@link Network.whenSettled} resolves when it ends. A new `layout()` or `data()`,
   * {@link Network.stopLayout} and `destroy()` stop it where it is; grabbing a node (`draggable`)
   * finishes it. The camera stays where it is unless `fit` is set, which frames the final layout once
   * when the transition starts.
   */
  transition?: number;
}

/** Tuning for {@link NetworkLayoutOptions.nested}. */
export interface NestedLayoutConfig {
  /** Disc area by subtree `"flow"` (default; leaf count when the graph has no flow) or leaf `"count"`. */
  size?: "flow" | "count";
  /** Force ticks per module solve (default 100). */
  iterations?: number;
  /** Fraction of a parent disc its children cover (default 0.45). */
  packing?: number;
  /**
   * **Warm start** (#328): lay the map out from the nodes' current positions — e.g. after a
   * re-clustering with the same nodes — instead of from scratch. Each module's children start at
   * their current centroids and the solve refines that arrangement, and the new map keeps the current
   * one's centroid and spread, so it stays where it is. No seed disc is placed first and no depth
   * frames stream (they would collapse the leaves onto their module centres): the layout lands in one
   * frame, or eases in over {@link NetworkLayoutOptions.transition}. On a graph never laid out (all
   * positions equal) it is the cold layout. Default `false`.
   */
  warm?: boolean;
}

/**
 * Level-of-detail (#103): an adaptive hierarchy cut so a large network draws only what's visible.
 * Each pan/zoom re-cuts a retained coarsening tree — dense regions collapse to aggregate glyphs and
 * expand into their members as you zoom in — bounding per-frame work to the visible frontier. Opt-in
 * via {@link Network.lod}; off by default (every node/link drawn). The tree's geometry updates as the
 * layout converges (so LOD helps during the solve, not only after), and the zoom-time path re-cuts
 * only the visible frontier. Best paired with `style({ sizeMode: "screen" })`.
 *
 * On the **WebGL** lane the cut re-runs live every pan/zoom frame. On the **Canvas/SVG** (retained)
 * backends the same frontier draws as Scene layers — so `toSVG()` exports a level-of-detail map (#138) —
 * but the retained Scene can't re-tessellate per frame, so there the frontier is static during a gesture
 * and re-cuts on release (the redraw-on-zoom-end model; force one with {@link Network.syncScreenGeometry}).
 */
export interface NetworkLODOptions {
  /**
   * Which hierarchy the cut draws (#326). `"modules"` — the default whenever the engine holds a module
   * hierarchy ({@link Network.data}`(graph, { modules })`) — cuts that module tree: modules expand →
   * sub-modules → leaves on zoom. `"structure"` ignores the hierarchy and coarsens the graph
   * structurally (a spatial quadtree for an edge-less graph), exactly as without one; the hierarchy
   * still drives the nested layout, the GPU module seed and {@link NetworkHit.path}. Without a
   * hierarchy both coarsen structurally. An explicit {@link modules} here overrides both.
   */
  source?: "modules" | "structure";
  /**
   * A module hierarchy scoped to these LOD options — prefer {@link Network.data}`(graph, { modules })`,
   * which the engine keeps across `lod(false)` and every LOD source (#326). Kept as a back-compat alias:
   * when given, it takes priority over the engine hierarchy for the cut and every other module consumer
   * (nested layout, GPU seed, hit paths) while these options are set, and `lod(false)` drops it.
   *
   * Pass Infomap's JSON `nodes` array directly — each record's `id` is the dense node index (aligned
   * with `buildGraph`) and `path` its 1-based module chain. Records must cover every node.
   * @see {@link buildModuleLODTree}
   */
  modules?: ArrayLike<ModuleNode>;
  /**
   * **Module-level links** for {@link modules} (#199) — prefer `data(graph, { modules, moduleLinks })`.
   * Summed into the map's super-edges alongside those derived from the graph's edges. Requires
   * `modules`. @see {@link NetworkDataOptions.moduleLinks}
   */
  moduleLinks?: ArrayLike<ModuleLink>;
  /**
   * Expand threshold (px): an aggregate whose on-screen footprint (`2·extent·k`) reaches this
   * expands into its children; below it it draws as a single glyph. Larger → coarser (fewer, bigger
   * aggregates). After a `layout({ nested })`, a module's extent is its disc's radius (#329).
   *
   * **Omit it** to get the tree-adaptive default (#191), which scales with how many children the
   * tree's finest aggregates hold: 48 px for structural coarsening / a spatial quadtree (unchanged),
   * ~190–280 px for a provided module partition — so `lod({ modules })` opens on a map of modules
   * instead of raw nodes. Set it to pin an absolute pixel size (the meaning is unchanged).
   */
  expandPx?: number;
  /** Aggregate-glyph fill (any CSS color). Default = `nodeFill`. */
  aggregateFill?: string;
  /**
   * Cap on an aggregate glyph's draw radius (in the active `sizeMode`'s units). The tree's
   * area-additive radius grows with subtree size — fine in world units, but set this (e.g. ~24) in
   * screen mode so large aggregates stay readable rather than ballooning to hundreds of pixels.
   */
  maxAggregateRadius?: number;
  /**
   * Thin overlapping frontier glyphs in screen space, keeping the most important (by strength) and
   * dropping those covered by a kept glyph — so dense regions stay readable instead of a solid mass.
   * Zoom-dependent (more resolve as you zoom in). Default `true`.
   */
  declutter?: boolean;
  /** Spacing multiplier for {@link declutter} (>1 sparser, <1 denser). Default 1. */
  declutterSpacing?: number;
  /**
   * Mark **aggregate** glyphs (collapsed modules/subtrees, not leaves) with a thin outline **ring** set
   * a `gap` px outside the glyph, so it reads as expandable — distinguishing a collapsed module from an
   * individual node at intermediate zoom. `width`/`gap` in px (default 1.5 / 2.5), `color` any CSS
   * colour (default a dark neutral), `opacity` 0-1 (default 1).
   *
   * **Default:** with {@link moduleBoundary} set, collapsed modules get the same line as expanded ones
   * (its `width`, `color` and `opacity`, at the default gap), so a module keeps one outline whether it
   * is collapsed or open. Without it, off. Pass an object to style it separately, or `false` to turn it
   * off.
   */
  aggregateOutline?: { width?: number; gap?: number; color?: string; opacity?: number } | false;
  /**
   * Draw a thin **boundary ring** around every **expanded** module in view (#329) — the aggregates the
   * cut has opened into their members (in a {@link crossFade} band: those whose members it draws), so
   * the hierarchy stays readable as a map of nested modules while you zoom in. After a
   * `layout({ nested })` of the tree being cut, the ring is that module's disc — which is then also the
   * module's LOD geometry, so it follows its members through a drag or a transition; otherwise it is
   * centred on the module's members with their extent as its radius. `width` in the active sizeMode's units (constant px in `screen` mode, default
   * 1), `color` any CSS colour (default a dark neutral), `opacity` 0-1 (default 0.5). Rings fade with
   * the members they enclose under {@link crossFade}, and export with `toSVG()` / `toPNG()`. Omit to
   * disable.
   *
   * With {@link crossLevelEdges} on, a **module link** (`data(graph, { modules, moduleLinks })`, #199)
   * whose endpoint is an expanded module in view — one that no finer pair can carry, as in an Infomap
   * `.ftree` — is drawn to or from that module's ring, with its flow, instead of disappearing when the
   * module opens. Links between two expanded modules run ring to ring. Where the two circles overlap
   * (routine for the centroid + extent rings, or when the other end sits inside the ring) there is no gap
   * to run it across, so it runs between their centres instead. An expanded module whose centre is
   * off-screen keeps the off-screen rule (its links are drawn toward its centre, leaving the view).
   * Links derived from the graph's own edges are unchanged (their flow is drawn at the members), so
   * nothing is counted twice.
   *
   * Per frame the cost is O(1) per module in view the cut expands (it visits them anyway; the walk is
   * the same with rings on or off) plus, when anchoring, their own module links — never the whole tree.
   */
  moduleBoundary?: { width?: number; color?: string; opacity?: number };
   /**
   * Draw **super-edges**: links between *both-visible* frontier nodes (leaf↔leaf, module↔module, or
   * aggregate↔aggregate — whatever the cut exposes), sized + coloured by their accumulated flow and
   * rendered in the active `linkStyle`. In a ragged module tree, where leaves sit at different depths, a
   * leaf is also linked to a visible *deeper* node (a finer module or a deeper leaf) holding the other end
   * of one of its edges (#325). Default `true`. @see {@link superEdges}
   */
  superEdges?: boolean;
  /**
   * Also draw super-edges between **mixed-level** visible nodes — a visible leaf (or finer aggregate)
   * and a visible *coarser* aggregate at a different cut level (the collapsed↔expanded mismatch). By
   * default such an edge is dropped: when you zoom into one region, its leaves lose their links to the
   * still-collapsed regions until both sides are at the same level again. With this on, the off-frontier
   * on-screen endpoint is projected to its **nearest present ancestor** and the edge is drawn there
   * (flows deduped), so aggregates keep their context across a mixed frontier (#139).
   *
   * **Off by default and zero added cost when off** — the projection (an `O(depth)` ancestor walk per
   * off-frontier on-screen edge + a dedup map) runs only when enabled; the same-level gather is unchanged.
   * Needs the directed super-edge CSR (the cut drawing a module hierarchy); ignored otherwise.
   */
  crossLevelEdges?: boolean;
  /**
   * **Cross-fade** level transitions (#133): the half-width, as a fraction of {@link expandPx}, of the
   * zoom band around the expand threshold over which an aggregate and its children are drawn *together*
   * — the aggregate easing out (opacity 1→0) as its children ease in (0→1, smoothstep) — so a split/merge
   * reads smoothly instead of popping. e.g. `0.3` fades over `[expandPx·0.7, expandPx·1.3]`. Applies to
   * the frontier glyphs, their borders/halos, and the super-edges (which fade with their endpoints).
   *
   * **Off by default and zero added cost when off** (`0`/omitted ⇒ the hard threshold): only the
   * transitioning band of the frontier is doubled, and the per-node alpha pass runs only when set.
   */
  crossFade?: number;
  /** Coarsening granularity for the LOD tree (depth / minimum aggregate size). */
  coarsen?: CoarsenOptions;
  /**
   * Quadtree options for the **edge-less** path (#103): a graph with no edges can't be coarsened, so
   * the LOD tree is built spatially over the node positions instead. No effect on edge-bearing graphs.
   */
  spatial?: SpatialLODOptions;
}

/**
 * A **module hierarchy** for {@link Network.data} (#326) — data the engine owns alongside the graph,
 * like `stateNetwork(graph, { modules })` does for a state network. Every module consumer reads it
 * whatever the LOD state: the LOD cut (its default {@link NetworkLODOptions.source}), the nested layout
 * (`layout({ nested })`), the module-aware GPU seed, and {@link NetworkHit.path}. `lod(false)` keeps it;
 * a new `data(graph)` without it clears it.
 */
export interface NetworkDataOptions {
  /**
   * The module assignment (N6 / #104): Infomap's JSON `nodes` array directly — each record's `id` is
   * the dense node index (aligned with `buildGraph`) and `path` its 1-based module chain (`[2, 1, 3]` =
   * top module 2 → sub-module 1 → the node ranked 3). Records must cover every node exactly once;
   * `data()` checks this up front and throws on a misaligned hierarchy. The module tree (and its
   * super-edges) is built lazily, once per graph + hierarchy, the first time a consumer needs it.
   * @see {@link buildModuleLODTree}
   */
  modules?: ArrayLike<ModuleNode>;
  /**
   * **Module-level links** addressed by path (#199), summed into the map's super-edges alongside those
   * derived from the graph's edges. Use it when the input carries inter-module links only in aggregate —
   * an Infomap `.ftree` stores leaf links only inside bottom modules, and each coarser link once per
   * level in its `*Links` sections — so the map draws exactly those links, with no leaf edges invented
   * to stand in for them. Requires `modules`; `data()` checks up front that every endpoint is a module or
   * leaf of that hierarchy and throws otherwise. @see {@link ModuleLink}
   */
  moduleLinks?: ArrayLike<ModuleLink>;
}

/**
 * Options for {@link Network.stateNetwork} (#171). The engine ingests a state network + a per-**state-node**
 * module assignment, derives the physical network's overlapping-module pie wedges + module colours, and lets
 * you toggle the state ↔ physical view with {@link Network.view}.
 */
export interface StateNetworkOptions {
  /** Per-**state-node** module records (Infomap's `nodes` shape; `id` = state-node index). Drives module
   *  colours (both views) and the physical view's overlapping-module pie wedges. */
  modules: ArrayLike<ModulePathNode>;
  /** Pie-wedge derivation options (grouping level, flow vs count sizing). @see {@link physicalPieWedges} */
  pie?: PieWedgeOptions;
  /** Module colour scheme (shared by node colours and pie wedges). @see {@link moduleColors} */
  color?: ModuleColorOptions;
  /** Which view to show first. Default `"physical"` (so the overlapping-module pie glyphs are visible). */
  view?: "state" | "physical" | "both";
  /** State-view rosette radius (world units). Default: auto — bounded by the physical layout spacing.
   *  (The `"both"` view ignores this; its rosette is confined to the physical container radius.)
   *  @see {@link rosettePositions} */
  rosetteRadius?: number;
}

const DEFAULT_NODE_RADIUS = 4;
const DEFAULT_NODE_FILL = "#4878d0";
const DEFAULT_LINK_WIDTH = 1;
const DEFAULT_LINK_STROKE = "#999999";
const LAYER_NAMES = ["module-boundaries", "links", "arrows", "node-halos", "nodes"] as const;
/** Base-lane layers the shader highlight (#162) drives — nodes + links (not the aggregate halos, which
 *  carry no group/selected and so render un-dimmed). */
const HL_LAYERS = ["nodes", "links", "arrows"] as const;
/** Scale a laid-out graph's positions (in place) to fill the view at the default `k = 1` zoom — the
 *  same "scale the layout, don't fit-transform" approach the directed-map-of-modules example uses, so
 *  the network opens framed without a custom transform (which would fight d3-zoom's own transform, #171).
 *  Centres on the centroid and scales the 97th-percentile radius (robust to force-layout fling-outs) to
 *  ~0.85× half the view. */
function scaleToViewport(positions: Float32Array, count: number, width: number, height: number): void {
  if (count <= 1) return;
  let cx = 0, cy = 0;
  for (let p = 0; p < count; p++) { cx += positions[2 * p]!; cy += positions[2 * p + 1]!; }
  cx /= count;
  cy /= count;
  const dists = new Float64Array(count);
  for (let p = 0; p < count; p++) dists[p] = Math.hypot(positions[2 * p]! - cx, positions[2 * p + 1]! - cy);
  dists.sort();
  const r = dists[Math.floor(count * 0.97)] || dists[count - 1] || 1;
  const s = ((Math.min(width, height) / 2) * 0.85) / r;
  for (let p = 0; p < count; p++) {
    positions[2 * p] = width / 2 + (positions[2 * p]! - cx) * s;
    positions[2 * p + 1] = height / 2 + (positions[2 * p + 1]! - cy) * s;
  }
}

/** Characteristic node spacing of a laid-out graph (bounding-box diagonal ÷ √count) — the scale the
 *  state-network container / rosette radii are sized against (#171). */
function physicalSpacing(positions: Float32Array, count: number): number {
  if (count <= 1) return 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let p = 0; p < count; p++) {
    const x = positions[2 * p]!, y = positions[2 * p + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(Math.hypot(maxX - minX, maxY - minY) / Math.sqrt(count), 1);
}

/** Shared empty visible-set for selection strategies whose emit draws the whole source directly (no
 *  per-instance gather) — e.g. the no-LOD full-graph lane — so they never allocate an all-indices array. */
const EMPTY_VISIBLE = new Uint32Array(0);

/** Shared {@link NetworkHit} for no-LOD label ranking (every node is a single leaf). */
const NO_LOD_INFO: NetworkHit = { aggregate: false, count: 1 };

/** Resolve a frontier label's text: the user's `labelOf` (may return null/"" to skip a glyph), else a
 *  default (leaf → id, aggregate → "N nodes"). */
function labelText(opts: NetworkLabelOptions, id: number, info: NetworkHit): string | null | undefined {
  if (opts.labelOf) return opts.labelOf(id, info);
  return info.aggregate ? `${info.count} nodes` : String(id);
}
const DEFAULT_FORCE_ITERATIONS = 300;

/** A layout's transition length in ms (#328): `transition` when a positive finite number, else 0. */
function transitionDuration(transition: number | undefined): number {
  return transition !== undefined && Number.isFinite(transition) && transition > 0 ? transition : 0;
}

/** The bounding box `[minX, minY, maxX, maxY]` of the first `n` interleaved positions — O(n). Null
 *  when there are none (or none finite). */
function positionsBox(p: ArrayLike<number>, n: number): FitBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p[2 * i]!;
    const y = p[2 * i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}

/** A CSS colour as an `rgba(r,g,b,a)` string at the given 0–255 alpha (for the faint `both`-view container fill). */
function withAlpha(css: string, alpha255: number): string {
  const c = rgb(css);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${(alpha255 / 255).toFixed(3)})`;
}

/** Any CSS colour → RGBA bytes (for the constant-border colour). */
function rgbaBytes(css: string): [number, number, number, number] {
  const c = rgb(css);
  return [
    Math.round(c.r) & 255,
    Math.round(c.g) & 255,
    Math.round(c.b) & 255,
    Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255,
  ];
}

/**
 * The network rendering engine (epic #98). A dedicated engine — nodes, links,
 * layout, and LOD are one coupled system — built on the shared {@link BaseEngine}
 * host/transform/zoom/interaction shell, rendering through the instanced lane (#100)
 * rather than the retained `Scene` path.
 *
 * N2.1 draws nodes as instanced circles. Links (#100 N2.2), the layout contract
 * proper (#101), and LOD (#103) build on this.
 */
export class Network extends BaseEngine {
  private graph: NetworkGraph | null = null;
  private styleOpts: NetworkStyle = {};
  private layoutOpts: NetworkLayoutOptions = {};
  /** Whether retained Scene layers are currently populated (SVG/Canvas path). */
  private sceneActive = false;
  /** Live handle to a running worker layout, if any. */
  private layoutHandle: WorkerLayoutHandle | null = null;
  /** While true (a streaming `layout({ fit: true })` before it settles), each streamed frame reframes
   *  the camera to the layout's live bounds ({@link fitViewToLayout}). Cleared on settle or first gesture. */
  private fitOnLayout = false;
  /** One-shot layout bbox `[minX, minY, maxX, maxY]` for the LOD-off fit fallback: computed once from
   *  positions (no per-frame O(nodes) scan) and held for the run. Null while a LOD tree supplies bounds. */
  private fitFallbackBox: FitBox | null = null;
  /**
   * A layout whose final extent is known up front (the nested layout's root disc, #324) frames on it
   * for the whole stream: its early frames collapse unplaced leaves onto their module centres, so the
   * live bounds would under-frame the map and then zoom out as depths land.
   */
  private fitKnownBox: FitBox | null = null;
  /** Cached top-module ids (the fit nodes, {@link fitNodes}) for the per-frame fit, plus the median scratch
   *  ({@link fitBox}). Recomputed only when the tree identity changes; the scratch is reused across frames. */
  private fitNodesArr: Uint32Array | null = null;
  private fitNodesFor: LODTree | null = null;
  private fitScratch: Float32Array | null = null;
  /** Pending coalesced repaint rAF id (0 = none) for progressive worker frames. */
  private layoutRepaintRaf = 0;
  /** The running position transition (#328), if any — owned by {@link layoutHandle}, kept here so a
   *  node grab can finish it. */
  private transition: PositionTransition | null = null;
  /**
   * The engine-owned module hierarchy (#326) from `data(graph, { modules, moduleLinks })`, with each
   * node's record index (`recordOf[id]`, from the one-time alignment check). Independent of
   * {@link lodOptions}, so `lod(false)` keeps it; a new `data()` replaces it. Null without one.
   */
  private hierarchy: { modules: ArrayLike<ModuleNode>; moduleLinks: ArrayLike<ModuleLink> | undefined; recordOf: Int32Array } | null = null;
  /**
   * The module tree last built from a hierarchy (#326), keyed by (graph, modules, moduleLinks) identity,
   * so LOD toggles, source switches and re-layouts reuse it instead of rebuilding. Part of the engine's
   * hierarchy data, so it stays resident once any consumer has built it (the cut, the nested layout, the
   * GPU seed, a hit path) — also after `lod(false)` and under `source: "structure"`, next to the
   * structural tree that cut draws — until `data()` replaces the hierarchy. Memory: ≈ 64 B per tree node
   * (nodes + modules) for its per-node arrays, plus 16 B per super-edge pair (out + in rows; a graph edge
   * adds one pair per level its endpoints' depths differ, #325) and 16 B per module link — measured
   * 119 MB for 1M nodes, 1,050 modules and 3M edges (3.4M pairs), against 564 MB for the structural
   * coarsening tree of the same graph.
   */
  private moduleTreeCache: {
    graph: NetworkGraph;
    modules: ArrayLike<ModuleNode>;
    moduleLinks: ArrayLike<ModuleLink> | undefined;
    tree: LODTree;
  } | null = null;
  /** LOD config when enabled (#103), else null (draw every element). */
  private lodOptions: NetworkLODOptions | null = null;
  /** Retained coarsening tree for the current graph (topology built lazily). */
  private lodTree: LODTree | null = null;
  /**
   * The LOD tree streamed by the layout worker (#103), when running the worker backend with LOD on.
   * Its `cx`/`cy`/`extent` are written by the worker each frame (live), so the main thread skips the
   * O(N) build + geometry pass and only fills the style geometry once + runs the O(visible) cut.
   * Null on the `force`/`positions` backends, the worker fallback, or LOD enabled after a worker run.
   */
  private lodWorkerTree: LODTree | null = null;
  /** Whether the current main-thread `lodTree` was built spatially (edge-less quadtree, #103) vs by coarsening. */
  private lodSpatial = false;
  /** Whether the current `lodTree` was built from a provided module hierarchy (N6 / #104). */
  private lodModules = false;
  /** True while a worker-LOD run is in flight (launched, not yet settled/stopped) — it will stream the tree. */
  private lodStreaming = false;
  /** True while a nested layout (#324) solves on the worker/gpu. It streams positions only — never a LOD
   *  tree — so the main thread keeps even a structural tree's geometry up to date meanwhile. */
  private nestedSolving = false;
  /** Dedup guard for the one-shot deferred main-thread LOD-tree fallback (see {@link scheduleLODFallback}). */
  private lodFallbackScheduled = false;
  /** Whether `lodTree` has had its geometry computed at least once, so the cut may run. */
  private lodHasGeometry = false;
  /** Reusable cross-fade scratch (#133), indexed by tree-node id; grown as the tree grows, reused per cut to avoid GC. */
  private fadeScratch: Float32Array | null = null;
  /** Engine-owned {@link cut} scratch (#213): reused by every {@link computeFrontier} so the per-frame
   *  visible-set walk allocates nothing steady-state. The returned frontier is a view of it, valid until
   *  the next cut — safe because every consumer (lane select, Scene registration, label refresh) re-selects
   *  before reading and none retains the previous frontier past its own re-select. */
  private readonly cutScratch = makeCutScratch();
  /** Engine-owned {@link declutterFrontier} scratch (#213), same reuse contract as {@link cutScratch}. */
  private readonly declutterFrontierScratch = makeDeclutterFrontierScratch();
  /** The expanded modules in view the last {@link computeFrontier} collected for the module-boundary
   *  rings (#329) — `count` 0 when `moduleBoundary` is off. Reused per cut, like {@link cutScratch}. */
  private readonly cutBoundaries: CutBoundaries = makeCutBoundaries();
  /**
   * The module discs of the nested layout that placed the current positions (#329), for the tree it laid
   * out — that tree's module geometry while it is cut: every position pass places its modules on them
   * ({@link lodDiscs}), so the cut culls and expands a module by its disc and rings it there. O(modules)
   * (three floats each). Dropped by `data()` and by any other `layout()` (and a reheating drag), whose
   * positions no longer come from the nested layout.
   */
  private nestedDiscs: { tree: LODTree; discs: BoundaryDiscs } | null = null;
  /** The fade alpha the last {@link computeFrontier} produced (the live `fadeScratch`), or null when cross-fade is off. */
  private fadeAlpha: Float32Array | null = null;
  /** Cached resolved style; invalidated on style()/data() to avoid per-zoom O(n) radii recompute. */
  private resolvedCache: ResolvedNetworkStyle | null = null;
  /** No-LOD style-derived link/arrow attributes cache (#179), keyed by `resolvedCache` identity + graph:
   *  reused on a position-only layout frame so the colour/width scale accessors run O(edges) ONCE per
   *  style version, not per frame. Invalidated implicitly when `resolvedStyleCached` returns a fresh object. */
  private noLodStyleCacheFor: { style: ResolvedNetworkStyle; graph: NetworkGraph } | null = null;
  private noLodStyleCacheVal: NoLodStyleCache | null = null;
  /** No-LOD per-instance `selected` flag columns cache (#240), keyed like the style cache PLUS the
   *  selection version: reference-stable across position-only frames (so the renderer's identity check
   *  skips their O(nodes)+O(edges)-per-layer conversion + re-upload), rebuilt FRESH on any selection
   *  change ({@link onLaneSelectionChanged} / {@link interactive} disable call
   *  {@link invalidateNoLodSelected}) so the changed flags DO upload. Never mutated in place. */
  private noLodSelectedCacheFor: { style: ResolvedNetworkStyle; graph: NetworkGraph } | null = null;
  private noLodSelectedNodes: Uint8Array | null = null;
  private noLodSelectedLinks: Uint8Array | null = null;
  /** Registry key for the single network instanced lane (#108-B). */
  private readonly NET_LANE = "network";
  /** Registry key for the companion selection/hover ring overlay lane (#105 N7c-2), drawn on top. */
  private readonly NET_HL_LANE = "network-highlight";
  /** The dispatch layer name node picks resolve to (selection/hover are keyed under it). */
  private readonly NODE_LAYER = "nodes";
  /** The `hit.layer` value link picks resolve to (#141), distinguishing a link hit from a node hit. */
  private readonly LINK_LAYER = "links";
  /** Re-cool tail (ticks) the main-thread `force` drag runs after release before the sim stops (#140). */
  private static readonly DRAG_COOL_FRAMES = 90;
  /** Node interaction opts set via {@link interactive} (selection/hover/tooltip). Null = pick-only.
   *  Datum-typed as {@link NetworkHit} — the node/aggregate a pick resolves to. */
  private interactiveOpts: InteractiveLayerOptions<NetworkHit> | null = null;
  /** GPU-readback link picking opt-in (#141). Off ⇒ links carry no pick model and the lane has no
   *  `gpuPick`, so hover/click never resolves a link (zero added GPU cost). Toggled by {@link pickLinks}. */
  private pickLinksEnabled = false;
  /** Maps a picked link instance index (gl_InstanceID) → a {@link NetworkLinkHit} HoverHit, captured per
   *  emit so it matches the link set currently in the pick FBO. Null when no links are drawn. */
  private linkResolve: ((index: number) => HoverHit | null) | null = null;
  /** No-LOD label candidate source (#212): the lazily-built position grid + its staleness flag.
   *  `stale` is raised by {@link rebuild} and {@link scheduleLayoutRepaint} — the funnels every
   *  position-mutating repaint goes through (layout streaming, drag, settle, data/layout change) —
   *  so a pan/zoom {@link refreshLabels} on settled positions queries the grid in O(visible) while
   *  a refresh over moving positions falls back to the plain scan (see label-candidates.ts). */
  private readonly labelSource: CandidateSource = { grid: null, stale: true };
  /** Reusable candidate-id scratch for {@link refreshLabels} (retained typed buffers — the gather
   *  allocates nothing per frame in the steady state). */
  private readonly labelCand = new CandidateList();
  /** Engine-owned {@link superEdges} scratch (#210): reused every LOD emit so the per-frame gather is
   *  O(frontier + drawn super-edges) — no O(tree.size) allocation per zoom frame. Shared by the WebGL
   *  lane emit and the retained-Scene registration (they never run concurrently; outputs never alias it). */
  private readonly superEdgesScratch = makeSuperEdgesScratch();
  /** Derived parent-pointer cache for the ancestor-aware selection highlight (#162), used only when the
   *  LOD tree carries no `parent` (coarsening/spatial). Keyed by tree identity; see {@link treeParent}. */
  private derivedParentFor: LODTree | null = null;
  private derivedParent: Int32Array | null = null;
  /** Frontier label options (#105 N7b); null until {@link labels} is enabled. The overlay itself
   *  ({@link BaseEngine.labelLayer}), its placement/routing, and the export-anchor retention for the
   *  WebGL export-only text stash (#219) all live in the base (shared with plot/geo labels, #223). */
  private labelOpts: NetworkLabelOptions | null = null;
  /** Memoizing text measurer for the current label set (#204): label text is derived per frame from
   *  the frontier, so each distinct string is measured once here and reused on every later frame —
   *  the collision box is real without putting `measureText` on the per-frame path. */
  private labelMeasure: TextMeasurer | null = null;
  /** While a node-drag is active (#140), re-pins the held positions over each worker frame before it
   *  paints — in copy mode the worker's streamed snapshot would otherwise clobber the held nodes the
   *  main thread is holding under the cursor. Null when no drag is in flight. */
  private dragReapply: (() => void) | null = null;
  /** State-network mode (#171): the ingested state network, or null for a plain graph. When set, the
   *  engine renders one of its two views ({@link activeView}) and {@link layout} lays out the physical
   *  graph + derives rosette state positions. */
  private stateData: StateNetworkGraph | null = null;
  /** The active view of the state network (#171). `physical` = aggregated links + overlapping-module
   *  pie glyphs; `state` = state nodes on spread rosette rings (+ optional module LOD); `both` = state
   *  nodes confined inside their physical node's container disc, with state-level links. Ignored unless
   *  {@link stateData} is set. */
  private activeView: "state" | "physical" | "both" = "physical";
  /** Per-physical-node overlapping-module pie wedges (#171); the physical view draws these as pies. */
  private pieWedges: PhysicalPieWedges | null = null;
  /** Per-state-node CSS colours (module hue), for the state/both views' node fill. */
  private stateColors: string[] | null = null;
  /** Per-physical-node CSS colours (its dominant module's hue), for the physical view's disc fill + the
   *  `both` view's faint container fill. */
  private physicalColors: string[] | null = null;
  /** `both`-view physical **container** radii (world units), sized so a physical node's confined state
   *  rosette fits inside it. Computed post-layout, relative to {@link stateSpacing}; null until then. */
  private containerRadii: Float32Array | null = null;
  /** Characteristic physical-node spacing of the (viewport-scaled) layout — the scale container/rosette
   *  radii are sized against, so they track the layout instead of a fixed constant (#171). 0 until laid out. */
  private stateSpacing = 0;
  /** `both`-view state-node dot radius (world units), sized to fit inside the containers. 0 until laid out. */
  private bothDotRadius = 0;
  /** State-view rosette radius override (world units); null = auto from the physical layout scale. */
  private rosetteRadius: number | null = null;
  /** Registry key + layer name for the physical-view pie glyphs (drawn on top of the node discs). */
  private readonly PIE_LAYER = "pie";
  /** Registry key + layer name for the `both`-view physical container discs (drawn under the state nodes). */
  private readonly CONTAINER_LAYER = "phys-container";

  constructor(host: HTMLElement, opts: NetworkOptions = {}) {
    super(host, opts);
    // Push whatever data exists once the initial backend is ready: data() may be called
    // before whenReady, and a *first* backend install does not fire onBackendSwapped.
    void this.whenReady().then(() => this.rebuild());
  }

  /**
   * Set the graph to render (built via `buildGraph` / `parseEdgeList`), optionally with its **module
   * hierarchy** (#326): `data(graph, { modules, moduleLinks })`. The engine owns the hierarchy as data,
   * like the graph — the LOD cut draws it by default, `layout({ nested })` and the GPU module seed lay it
   * out, and picks report each target's {@link NetworkHit.path} — whether LOD is on, off, or cutting
   * the graph structurally (`lod({ source: "structure" })`). `lod(false)` keeps it. `data(graph)`
   * without it clears any previous hierarchy (it belongs to the previous data).
   *
   * The records are checked against the graph here, once (every node exactly once), and so are the
   * module links' endpoints (each a module or leaf of that hierarchy) — a bad hierarchy throws here,
   * leaving the engine unchanged; the module tree is built lazily, once, when first needed.
   * Leaves any state-network mode ({@link stateNetwork}) — a plain graph replaces it.
   */
  data(graph: NetworkGraph, opts: NetworkDataOptions = {}): this {
    const { modules, moduleLinks } = opts;
    if (moduleLinks && !modules) throw new Error("network.data: moduleLinks requires modules");
    const recordOf = modules ? moduleRecordIndex(graph.nodeCount, modules) : null;
    if (modules && moduleLinks) checkModuleLinks(graph.nodeCount, modules, moduleLinks);
    this.hierarchy = modules && recordOf ? { modules, moduleLinks, recordOf } : null;
    this.stateData = null;
    this.pieWedges = null;
    this.stateColors = null;
    this.physicalColors = null;
    return this.setActiveGraph(graph);
  }

  /** Point the engine at `graph` and drop the per-graph caches (LOD tree, resolved style, parent cache).
   *  Shared by {@link data} (plain graph) and {@link applyView} (state-network view switch); unlike
   *  `data` it does NOT clear the state-network mode. */
  private setActiveGraph(graph: NetworkGraph): this {
    this.haltLayout(); // any worker layout is tied to the previous graph's buffers
    this.graph = graph;
    // Drop per-node style arrays sized to the PREVIOUS graph — the idiomatic re-render on a graph swap is
    // `net.data(g).style(s)`, but data() rebuilds first, and resolving a stale-length `flowBorder.flow` /
    // `nodeRadius` array against the new graph would throw (e.g. "flowBorder.flow length 1000 !== nodeCount
    // 2000" when a node-count slider changes). They must be re-supplied for the new graph anyway; the next
    // style() call does that. Accessors / `{ by }` specs are graph-relative and kept.
    const n = graph.nodeCount;
    const fb = this.styleOpts.flowBorder;
    if (fb && fb.flow instanceof Float32Array && fb.flow.length !== n) {
      this.styleOpts = { ...this.styleOpts, flowBorder: undefined };
    }
    if (this.styleOpts.nodeRadius instanceof Float32Array && this.styleOpts.nodeRadius.length !== n) {
      this.styleOpts = { ...this.styleOpts, nodeRadius: undefined };
    }
    // New topology + position buffer: drop the retained LOD tree, the module tree and resolved-style cache.
    this.moduleTreeCache = null;
    this.nestedDiscs = null;
    this.lodTree = null;
    this.lodWorkerTree = null;
    this.lodSpatial = false;
    this.lodModules = false;
    this.lodHasGeometry = false;
    this.resolvedCache = null;
    this.derivedParentFor = null; this.derivedParent = null; // drop the ancestor-aware parent cache (#162)
    this.fitFallbackBox = null; this.fitKnownBox = null; this.fitNodesArr = null; this.fitNodesFor = null; // fit caches are tied to the old graph/tree
    return this.rebuild();
  }

  /**
   * Render a **state (higher-order / memory) network** (#171). The engine ingests the state network
   * (state graph + its engine-derived physical graph, from {@link buildStateGraph}) and a per-**state-node**
   * module assignment, then lets you toggle between:
   *  - the **state view** — every state node on a golden-angle rosette around its physical node, coloured
   *    by module, and
   *  - the **physical view** — the aggregated physical network, where a physical node whose state nodes span
   *    ≥2 modules renders as a **pie chart** (wedges ∝ per-module flow/count, module-coloured) and a
   *    single-module node as a solid disc.
   *
   * Call {@link layout} next: in state-network mode it lays out the physical graph (force backend) and
   * derives the rosette state positions, so every view has coordinates (the module-aware GPU layout of
   * #106 will supply these directly once it lands). Switch views with {@link view}: `"physical"` (pies),
   * `"state"` (spread rosette, module LOD via {@link lod}), or `"both"` (state nodes confined inside their
   * physical container, state-level links). Colours + pie wedges + container radii are derived once here.
   */
  stateNetwork(graph: StateNetworkGraph, opts: StateNetworkOptions): this {
    this.stateData = graph;
    this.activeView = opts.view ?? "physical";
    this.rosetteRadius = opts.rosetteRadius ?? null;
    // A new state network invalidates any prior LOD config: its `modules` were keyed to the OLD state
    // graph, so a stale `lod({ modules })` would fail `buildModuleLODTree`'s "record for every node" check
    // when `layout()` rebuilds the tree below. Callers re-apply `lod()` after `layout()` with fresh modules.
    this.lodOptions = null;
    this.hierarchy = null; // a plain graph's hierarchy (#326) doesn't describe the state network
    this.pieWedges = physicalPieWedges(graph, opts.modules, opts.pie);
    // Per-state-node module colours (state/both views); per-physical disc = its dominant (first) wedge's colour.
    this.stateColors = moduleColors(opts.modules, opts.color);
    const wedges = this.pieWedges;
    const pc = new Array<string>(graph.physicalCount);
    for (let p = 0; p < graph.physicalCount; p++) {
      pc[p] = wedges.wedgeCount[p]! > 0 ? wedges.color[wedges.offset[p]!]! : DEFAULT_NODE_FILL;
    }
    this.physicalColors = pc;
    // Container / rosette radii are sized against the layout scale, so they're (re)computed post-layout
    // ({@link computeStateSizing}); zeroed here until then.
    this.containerRadii = null;
    this.stateSpacing = 0;
    this.bothDotRadius = 0;
    this.applyView();
    return this;
  }

  /** Toggle the active view of the ingested state network (#171): `"physical"` (aggregated network with
   *  overlapping-module pie glyphs), `"state"` (spread rosette of state nodes), or `"both"` (state nodes
   *  confined inside their physical container disc, state-level links). No-op without {@link stateNetwork}. */
  view(view: "state" | "physical" | "both"): this {
    if (!this.stateData || view === this.activeView) return this;
    this.activeView = view;
    this.applyView();
    return this;
  }

  /** Whether a state network is loaded, and which of its three views is active (#171). */
  get stateView(): "state" | "physical" | "both" | null {
    return this.stateData ? this.activeView : null;
  }

  /** Point the engine at the active view's graph + per-view node colours, preserving state-network mode.
   *  Positions live in each view's graph buffer (filled by {@link layout}); a view switch re-derives the
   *  view-appropriate rosette from the (already laid-out) physical positions. */
  private applyView(): void {
    const sg = this.stateData;
    if (!sg) return;
    const physical = this.activeView === "physical";
    const colors = (physical ? this.physicalColors : this.stateColors)!;
    // Set the per-view node fill BEFORE setActiveGraph's rebuild so the first paint is correctly coloured.
    // In the `both` view the engine also owns the state-node dot radius (sized to fit the containers), so
    // the example never has to know the layout scale.
    const fill = (i: number) => colors[i] ?? DEFAULT_NODE_FILL;
    this.styleOpts =
      this.activeView === "both" && this.bothDotRadius > 0
        ? { ...this.styleOpts, nodeFill: fill, nodeRadius: this.bothDotRadius }
        : { ...this.styleOpts, nodeFill: fill };
    // LOD is only defined for the state view (its nodes carry the module tree); physical/both draw full.
    if (this.activeView !== "state" && this.lodOptions) this.lodOptions = null;
    this.deriveStatePositions(); // view-dependent rosette (spread vs. container-confined)
    this.setActiveGraph(physical ? sg.physical : sg.state);
  }

  /** Size the container / rosette radii against the (just-laid-out, viewport-scaled) physical layout, so
   *  they track the layout scale instead of a fixed constant. Called post-layout. */
  private computeStateSizing(): void {
    const sg = this.stateData;
    if (!sg) return;
    const spacing = physicalSpacing(sg.physical.positions, sg.physicalCount);
    this.stateSpacing = spacing;
    this.bothDotRadius = spacing * 0.03;
    const off = sg.physicalToState.offsets;
    const container = new Float32Array(sg.physicalCount);
    for (let p = 0; p < sg.physicalCount; p++) {
      const count = off[p + 1]! - off[p]!;
      // Grows with the state-node count but capped so neighbouring containers (≈`spacing` apart) don't overlap.
      container[p] = Math.min(0.46 * spacing, spacing * (0.12 + 0.045 * Math.sqrt(count)));
    }
    this.containerRadii = container;
  }

  /** Write the state-node positions for the active view into `state.positions`: a **spread** rosette for
   *  the `state` view (bounded by the layout spacing) and a **container-confined** rosette for the `both`
   *  view (inside each physical container disc). Reads the current physical positions; a no-op-ish zero
   *  placement until {@link layout} has run. */
  private deriveStatePositions(): void {
    const sg = this.stateData;
    if (!sg || this.activeView === "physical") return;
    const container = this.containerRadii;
    const spread = this.rosetteRadius ?? (this.stateSpacing > 0 ? this.stateSpacing * 0.33 : 12);
    const radius =
      this.activeView === "both" && container ? (p: number) => 0.72 * container[p]! : () => spread;
    sg.state.positions.set(rosettePositions(sg, { radius }));
  }

  /** Set visual style (node radius/fill/sizeMode; link & arrow appearance). */
  style(style: NetworkStyle): this {
    this.styleOpts = { ...this.styleOpts, ...style };
    this.resolvedCache = null; // radii/colours/sizeMode changed
    // Refresh the LOD tree's style geometry (radii/colours) only if a tree already exists. Don't
    // *build* one here: after a data() change the tree is null and the provided modules may not yet
    // match the new graph (lod() supplies fresh ones next) — building now would mismatch and throw.
    if (this.lodOptions && (this.lodTree || this.lodWorkerTree)) this.recomputeLODGeometry();
    return this.rebuild();
  }

  /**
   * Enable (or, with `false`, disable) level-of-detail rendering (#103) — an adaptive hierarchy cut
   * that draws dense regions as aggregate glyphs and expands them into members as you zoom, so
   * per-frame work tracks the visible frontier rather than the whole graph. Requires the WebGL
   * backend. The tree's geometry follows the layout as it converges (re-cut cheaply on zoom).
   *
   * **Call this before `layout({ backend: "worker" })`** to get the full win: the worker then builds
   * and streams the LOD tree itself (#103), so the main thread never coarsens or runs the O(N)
   * geometry pass. Enabling it *after* a worker run (or on the `force`/`positions` backends) falls
   * back to building the tree on the main thread from the current positions.
   *
   * With a module hierarchy (`data(graph, { modules })`, #326) the cut draws the module tree by
   * default; `{ source: "structure" }` coarsens the graph structurally instead. `lod(false)` turns LOD
   * off but keeps the hierarchy, so re-enabling reuses its tree.
   */
  lod(options: NetworkLODOptions | false): this {
    if (!options) {
      this.lodOptions = null;
      this.lodTree = null;
      this.lodWorkerTree = null;
      this.lodSpatial = false;
      this.lodModules = false;
      this.lodHasGeometry = false;
      return this.rebuild();
    }
    this.lodOptions = options;
    // recomputeLODGeometry picks the tree for the (possibly new) source — the cached module tree, or a
    // structural one — dropping a retained tree from the other source. It keeps any worker-streamed
    // coarsening tree from a still-current run for the structural source: reconfiguring LOD options
    // reuses it (cut-time options apply immediately; the style geometry refreshes). data()/layout()
    // drop it on a graph or layout change. It builds a structural tree on the main thread only off the
    // worker backend — on the worker backend that tree comes from the worker (or the settle fallback).
    this.recomputeLODGeometry();
    return this.rebuild();
  }

  /**
   * Opt nodes/aggregates into the **visual** hover ring + click-selection (#105 N7c-2). This is
   * separate from `on("hover" | "click")`: those callbacks fire on every pick regardless of this call
   * (use them for your own readout/side-effects); `interactive()` is what draws the hover/selection
   * **ring overlay** on the glyphs and manages the selection set (`selection()`, `on("select")`).
   *
   * Options (each **off by default** — `interactive()` is itself opt-in; omit it entirely and nodes are
   * pick-only, with no ring and no managed selection):
   * - `selectable` — click to select: `true`/`{}` = single (click replaces), `{ multi: true }` =
   *   shift/cmd/ctrl-click toggles add/remove.
   * - `hover` — draw a ring on the hovered node/aggregate.
   * - `tooltip: (datum, id) => content` — shown for the hovered node/aggregate.
   * - `draggable` — grab a node/aggregate and drag it (#140): the held set tracks the cursor with no
   *   lag while the layout reheats around it and re-cools on release. Grab a **selected** node to drag
   *   the **whole selection** together; grab a collapsed module to drag its **whole subtree**. Works on
   *   the `force` and `worker` layout backends (reheat) and `positions` (translate-only). Pair with
   *   `enableZoom()` and the drag takes precedence over panning when it starts on a glyph.
   * - `selection: { selected, others }` — `selected.stroke` overrides the **select** ring colour
   *   (default `#2563eb` blue); the hover ring defaults to `#16a34a` green (override via a `hover`
   *   HighlightStyle's `stroke`). A subtract-marquee preview rings the to-be-removed glyphs `#dc2626`
   *   red. `others` (Scene dimming) is ignored on instanced glyphs — selected glyphs get a ring.
   *
   * The hit's `datum` is a {@link NetworkHit} (`{ aggregate, count }`); its `members()` lists the leaf
   * node ids the target covers (1 for a leaf, the whole subtree for an aggregate). Observe selection
   * via `on("select", (hits) => …)` or read it back with `selection()`; both carry `members()`.
   * Pass `false` to disable (clears any current selection).
   */
  interactive(opts: InteractiveLayerOptions<NetworkHit> | false): this {
    this.interactiveOpts = opts || null;
    if (!this.interactiveOpts) {
      this.clearLayerSelection(this.NODE_LAYER); // disabling clears managed selection
      this.invalidateNoLodSelected(); // #240: bypasses onLaneSelectionChanged, so drop the flag cache here
    }
    this.syncLane(); // re-register the lane with the interactive block + companion highlight lane
    this.render();
    return this;
  }

  /**
   * Enable (or, with `false`, disable) **pixel-exact link picking** (#141) — WebGL only. Nodes are always
   * pickable (CPU, exact on circles); links are thin strips / half-arrows, so resolving "the link you see"
   * needs a GPU pass: the link instances are drawn id-encoded into an offscreen FBO and the pixel under the
   * cursor is read back. Off by default because it adds a per-link-layer pick model + an offscreen readback
   * — opt in only when you handle link hits.
   *
   * Once enabled, `on("hover" | "click")` and {@link Network.pick} resolve a link as a {@link HoverHit}
   * with `layer: "links"` and a {@link NetworkLinkHit} `datum` (when the cursor is over a link and not over
   * a node — nodes are drawn on top and win). Hover uses a stall-free async readback (the result can lag the
   * cursor by one pointer event); clicks read synchronously. There is no per-frame readback stall.
   */
  pickLinks(enabled = true): this {
    this.pickLinksEnabled = enabled;
    this.syncLane(); // re-register so link layers gain/lose their pick model and the lane its gpuPick
    this.render();
    return this;
  }

  /**
   * Show text labels on the LOD frontier (#105 N7b) — leaf/aggregate centroids, re-placed on pan/zoom.
   * **No cap by default** (every visible labelled glyph, thinned by collision); set
   * {@link NetworkLabelOptions.max} to keep only the top-k by importance. The engine owns the
   * frontier→rank→placement wiring; you supply `labelOf` (return `null` to skip a glyph) + styling.
   *
   * Rendered by the **active backend**: WebGL → an HTML overlay (crisp + accessible; styled by a
   * built-in default — dark 11px sans-serif + white halo — with `style` for inline overrides and
   * `className` as the full-CSS path); SVG/Canvas → native `<text>`/`fillText` (styled via
   * `font`/`color`/`halo`, defaulted to the same look). Labels appear in `toSVG()`/`toPNG()` on
   * **every** backend — WebGL composites the placed set into the export at export time (#219).
   * Pass `false` to remove.
   */
  labels(opts: NetworkLabelOptions | false): this {
    if (!opts) {
      this.labelOpts = null;
      this.labelMeasure = null;
      this.clearLabelOverlay(); // destroy overlay + clear backend-native labels (incl. the WebGL export stash)
      this.render(); // repaint so a backend that bakes labels in (Canvas) drops them now
      return this;
    }
    // One default look across backends (#224): backend-native text (SVG/Canvas, incl. export)
    // defaults to the overlay default's equivalent; explicit font/color/halo win. Normalized once
    // here, so refreshLabels() reads plain opts with no per-frame defaulting.
    this.labelOpts = { ...DEFAULT_LABEL_TEXT, ...opts };
    // Measure label boxes in the font the labels actually render in (explicit `font`, else the
    // overlay's `style.font`, else the shared default) — one memoizing measurer per label set (#204).
    this.labelMeasure = new TextMeasurer(canvasFont(opts.font ?? opts.style?.font ?? DEFAULT_LABEL_TEXT.font));
    // (Re)create the shared overlay on every call: className/style land once per element at creation
    // (never on the per-transform path), so a styling change must rebuild the elements. Cheap and
    // flash-free — labels() is a call-path, and the synchronous refreshLabels() below repopulates
    // in the same task at O(visible labels), the same order one overlay update already costs.
    this.createLabelOverlay(opts.className, opts.style, { font: this.labelOpts.font, color: this.labelOpts.color, halo: this.labelOpts.halo });
    this.refreshLabels();
    this.render(); // bake just-set labels into the frame (Canvas); no-op-ish for the live-DOM backends
    return this;
  }

  /** Re-place the frontier labels at the current transform: pick the top-`max` visible glyphs by
   *  importance and feed their centroids + text to the overlay. Cheap no-op when labels are off.
   *  Called on every {@link afterTransform} (zoom/pan) and after a rebuild (frontier changed). */
  private refreshLabels(): void {
    const opts = this.labelOpts;
    if (!this.labelLayer || !opts || !this.graph) return;
    // Default: NO cap — show every visible glyph that has a label (collision culling thins them where
    // they'd overlap). A finite `max` keeps only the top-k by importance; ranking (the sort below) is
    // therefore done ONLY when capping AND there are more candidates than the cap.
    const max = opts.max ?? Infinity;
    const rect = visibleWorldRect(this.transform, this.width, this.height);
    const inView = (x: number, y: number) => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
    const anchors: LabelAnchor[] = [];
    // Label text is derived per frame here (the frontier/viewport decides it), so the box comes from
    // the memoizing measurer: each distinct string is measured ONCE, every later frame is a lookup —
    // no `measureText` on the per-frame path (#204). Without a real box every label had a zero-area
    // collision box, which is why dense regions rendered as overprinted stacks.
    const measure = this.labelMeasure ?? (this.labelMeasure = new TextMeasurer(canvasFont(opts.font ?? DEFAULT_LABEL_TEXT.font)));
    /** One glyph label: measured box + the centred placement the overlay CSS, the collision box and
     *  native text are all derived from (never a hand-written transform — #58's lesson). */
    const anchorFor = (
      id: string | number,
      refX: number,
      refY: number,
      text: string,
      priority: number,
      offset: [number, number] | undefined,
      opacity?: number,
    ): LabelAnchor => ({
      id, refX, refY, text,
      width: measure.width(text),
      height: measure.height,
      priority,
      offset,
      textAnchor: "middle",
      baseline: "middle",
      opacity,
    });

    if (this.lodReady() && this.lodTree) {
      const tree = this.lodTree;
      // Frontier source: the WebGL lane's retained cut when present, else compute it directly — on a
      // vector backend (SVG/Canvas) the lane isn't registered (#138 draws the cut via the Scene path),
      // so reading a missing lane's `visible` would leave labels empty.
      const lane = this.instancedLanes.get(this.NET_LANE);
      const frontier = lane ? lane.lane.visible : this.computeFrontier(tree, this.resolvedStyleCached(this.graph));
      const fade = this.fadeAlpha; // set by the cut above (lane emit, or the computeFrontier just run)
      const cand: number[] = [];
      for (let i = 0; i < frontier.length; i++) { const g = frontier[i]!; if (inView(tree.cx[g]!, tree.cy[g]!)) cand.push(g); }
      const impOf = opts.importanceOf;
      if (cand.length > max) cand.sort((a, b) => (impOf ? impOf(b, this.lodDatum(tree, b)) - impOf(a, this.lodDatum(tree, a)) : tree.weight[b]! - tree.weight[a]!));
      for (const g of cand) {
        const info = this.lodDatum(tree, g);
        const text = labelText(opts, g, info);
        if (!text) continue; // labelOf returned null/"" — this glyph has no label
        // Importance also decides who WINS a collision, not just who makes a `max` cap — so it is
        // resolved for every candidate (the frontier's own weight when no accessor is given).
        const priority = impOf ? impOf(g, info) : tree.weight[g] ?? 0;
        anchors.push(anchorFor(g, tree.cx[g] ?? 0, tree.cy[g] ?? 0, text, priority, opts.offset, fade ? fade[g] : undefined));
        if (anchors.length >= max) break;
      }
    } else {
      // No-LOD: rank the nodes in view by strength (weighted degree). The full graph is drawn.
      // Candidate gathering (#212) is O(visible) per pan/zoom frame in the steady state: on settled
      // positions a coarse uniform grid — built at most once per position change, never per frame —
      // answers the in-view query in O(covered cells + their nodes). While positions are moving
      // (layout streaming, drag — `labelSource.stale`), it falls back to the plain O(N) scan those
      // frames already pay elsewhere. Output is identical to the scan (see label-candidates.ts).
      const graph = this.graph, pos = graph.positions, strength = graph.strength;
      const cand = this.labelCand;
      const ascending = gatherCandidates(this.labelSource, pos, graph.nodeCount, rect, cand);
      const impOf = opts.importanceOf;
      if (cand.length > max) {
        // Exact top-`max` without a full O(V log V) comparator sort: keys are computed once per
        // candidate (the old comparator re-invoked `importanceOf` on every comparison) and a lazy
        // heap pops key-descending, ties id-ascending — the order the old stable sort produced.
        const ids = cand.ids;
        const keys = cand.keysFor(cand.length);
        if (impOf) for (let i = 0; i < cand.length; i++) keys[i] = impOf(ids[i]!, NO_LOD_INFO);
        else for (let i = 0; i < cand.length; i++) keys[i] = strength[ids[i]!]!;
        const next = descendingByKey(ids, keys, cand.length);
        for (let id = next(); id >= 0; id = next()) {
          const text = labelText(opts, id, NO_LOD_INFO);
          if (!text) continue;
          const priority = impOf ? impOf(id, NO_LOD_INFO) : strength[id] ?? 0;
          anchors.push(anchorFor(id, pos[2 * id] ?? 0, pos[2 * id + 1] ?? 0, text, priority, opts.offset));
          if (anchors.length >= max) break;
        }
      } else {
        // Under the cap (or uncapped): anchors go out ascending by id, as the scan always yielded.
        if (!ascending) cand.sortAscending();
        const ids = cand.ids;
        for (let i = 0; i < cand.length; i++) {
          const id = ids[i] ?? 0;
          const text = labelText(opts, id, NO_LOD_INFO);
          if (!text) continue;
          // Uncapped: no ranking sort runs, but each label still needs its collision priority —
          // one accessor read per in-view candidate (a typed `strength` read when none is given).
          const priority = impOf ? impOf(id, NO_LOD_INFO) : strength[id] ?? 0;
          anchors.push(anchorFor(id, pos[2 * id] ?? 0, pos[2 * id + 1] ?? 0, text, priority, opts.offset));
        }
      }
    }

    // State-network `both` view (#171): also label the physical containers, placed just outside each disc
    // (upper-right ≈1:30) so the label clears the enclosed state rosette. Per-container screen offset =
    // (container world-radius × k + gap) along the 1:30 direction, recomputed here so it tracks zoom.
    if (this.stateData && this.activeView === "both" && opts.physical && this.containerRadii) {
      const { labelOf: nameOf, gap = 4 } = opts.physical;
      const k = this.transform.k;
      const pos = this.stateData.physical.positions;
      const DX = 0.70710678, DY = -0.70710678; // 1:30 in screen px (x → right, −y → up)
      for (let p = 0; p < this.stateData.physicalCount; p++) {
        const x = pos[2 * p]!, y = pos[2 * p + 1]!;
        if (!inView(x, y)) continue;
        const text = nameOf(p);
        if (!text) continue;
        const dist = this.containerRadii[p]! * k + gap;
        anchors.push(anchorFor(`phys:${p}`, x, y, text, 0, [DX * dist, DY * dist]));
      }
    }

    // Route to the active backend (#105 N7b-2, #219): shared placement, live-vs-export-only text
    // routing, and the export-anchor retention for WebGL toPNG()/toSVG() all live in the base
    // (also used by plot/geo data labels, #223). Each anchor declares its own centred placement
    // (`textAnchor`/`baseline` "middle"), which the overlay CSS, the collision box and native text
    // all derive from.
    this.routeLabels(anchors);
  }

  protected override afterTransform(): void {
    this.refreshLabels();
  }

  /** Configure layout / supply positions (the pluggable contract proper lands in #101). */
  layout(opts: NetworkLayoutOptions): this {
    if (this.stateData) return this.layoutStateNetwork(opts);
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    if (this.graph) {
      // Any backend change cancels a running worker layout before re-seeding positions. A prior
      // worker-streamed LOD tree belongs to that superseded run, so drop it: the new layout either
      // re-streams one (worker backend) or builds one on the main thread (force/positions).
      this.haltLayout();
      this.lodWorkerTree = null;
      this.nestedDiscs = null; // the new layout places the nodes; a nested one records its discs as it lands (#329)
      // Fit-on-layout (streaming backends): keep the camera framed on the layout as it converges.
      // Seed a box-centred disc up front so the FIRST paint is framed — until the first frame streams
      // back, `graph.positions` would be all-zeros (the GPU solve seeds on-device, so the CPU copy is
      // untouched), which renders as one glyph piled at the origin (top-left). The seed is overwritten
      // by the first streamed frame; each frame then reframes via {@link fitViewToLayout}.
      const fit = opts.fit === true && (opts.backend === "worker" || opts.backend === "gpu");
      this.fitOnLayout = fit;
      this.fitFallbackBox = null;
      this.fitKnownBox = null;
      const nestedTree = opts.nested && opts.backend !== "positions" ? this.moduleTree() : undefined;
      // A transition (#328) eases from the current positions, and a warm nested start refines them —
      // so neither gets the seed disc. Only layouts computed in one go transition.
      const duration = nestedTree || opts.backend === "positions" || opts.backend === "force" ? transitionDuration(opts.transition) : 0;
      const warm = !!nestedTree && typeof opts.nested === "object" && opts.nested.warm === true;
      // A flat force layout's first paint sits at the scale it converges to (the force equilibrium). A
      // nested layout ignores `force` — its root disc is 10·√N, the box the camera frames — so it keeps
      // the viewport disc rather than one ~3× wider than that box.
      if (fit && !warm && duration === 0) seedPositions(this.graph, this.width, this.height, nestedTree ? undefined : { force: opts.force });
      if (nestedTree) {
        this.startNestedLayout(nestedTree, opts, duration);
      } else if (opts.backend === "positions" && opts.positions) {
        const graph = this.graph;
        if (duration > 0) {
          const target = graph.positions.slice();
          target.set(opts.positions); // a copy: the caller may reuse its buffer while the transition runs
          this.transitionTo(graph, target, duration, () => {
            if (this.lodSpatial) this.lodTree = null; // position-built topology: rebuild it from the final coordinates
          });
        } else {
          graph.positions.set(opts.positions);
          // The edge-less spatial tree's topology depends on the positions, so drop it to rebuild from
          // the new coordinates (the coarsening tree is position-independent and is kept).
          if (this.lodSpatial) { this.lodTree = null; }
          this.recomputeLODGeometry(); // caller-supplied coordinates are final immediately
        }
      } else if (opts.backend === "worker") {
        // Off-thread force layout with progressive convergence. The worker can post a frame per
        // tick, so coalesce repaints to one per animation frame (always painting the freshest
        // positions) to bound main-thread work at large N.
        //
        // The worker streams a *coarsening* LOD tree; a module hierarchy (N6 / #104) is a different
        // source the worker doesn't build, so while the cut draws modules the worker supplies positions
        // only and the main thread builds the module tree (recomputeLODGeometry, off the worker guard).
        const useLod = !!this.lodOptions && !this.lodUsesModules();
        this.lodStreaming = useLod; // the worker will stream the tree; main builds none meanwhile
        const handle: WorkerLayoutHandle = startWorkerLayout(
          this.graph,
          {
            width: this.width,
            height: this.height,
            iterations: opts.iterations ?? DEFAULT_FORCE_ITERATIONS,
            force: opts.force,
            multilevel: opts.multilevel,
            // When LOD is on, the worker builds + streams the tree; its coarsening is shared with the
            // multilevel seed so the graph is coarsened once and the main thread never coarsens.
            lod: useLod,
            coarsen: this.lodOptions?.coarsen,
          },
          () => this.scheduleLayoutRepaint(),
          useLod
            ? (tree) => {
                if (this.layoutHandle !== handle) return; // a newer layout superseded this one
                // Record the worker's tree; recomputeLODGeometry adopts it while the cut is structural
                // (a switch to modules since launch keeps the module tree). Its geometry streams live,
                // so the main thread only fills the style geometry once. The first frame (which
                // follows this message) renders it.
                this.lodWorkerTree = tree;
                this.recomputeLODGeometry();
              }
            : undefined,
        );
        this.layoutHandle = handle;
        // Final refresh on settle (the last streamed frame may land before the resolve). `forceMain`
        // covers the worker-unavailable fallback: it solved synchronously and never streamed a tree,
        // so build one on the main thread here (a no-op when the worker did stream — that takes the
        // worker-tree branch and only refreshes the style geometry).
        void handle.settled.then(() => {
          if (this.layoutHandle !== handle) return; // a newer layout superseded this one
          this.lodStreaming = false;
          this.recomputeLODGeometry(true);
          this.releaseFit(); // final reframe on the settled bounds, then hand the view to zoom/pan
          this.rebuild();
        });
      } else if (opts.backend === "gpu") {
        // GPU force layout — uses the WebGL backend's luma.gl Device. Pass a device *promise* that
        // waits for the backend to fully settle (including the "auto" → WebGL background upgrade)
        // before resolving, so `startGpuLayout` sees the real WebGL device and doesn't silently fall
        // back to the worker because it was called before the upgrade finished.
        //
        // N8.2 module-aware seed: with a module hierarchy (`data(graph, { modules })`, #326, or
        // `lod({ modules })`) — whatever the LOD state — hand its tree to the GPU seed so the layout is
        // laid out top-down over the modules. The tree is cached, so when the cut draws the same
        // hierarchy the settle handler's recomputeLODGeometry only fills its geometry (no rebuild).
        const moduleTopology = this.moduleTree();
        const devicePromise = this.whenBackendSettled().then(() => this.gpuDevice());
        const handle = startGpuLayout(devicePromise, this.graph, {
          width: this.width,
          height: this.height,
          iterations: opts.iterations ?? DEFAULT_FORCE_ITERATIONS,
          force: opts.force,
          moduleTopology,
        }, () => this.scheduleLayoutRepaint());
        this.layoutHandle = handle;
        void handle.settled.then(() => {
          if (this.layoutHandle !== handle) return; // a newer layout superseded this one
          this.recomputeLODGeometry(true);
          this.releaseFit(); // final reframe on the settled bounds, then hand the view to zoom/pan
          this.rebuild();
        });
      } else if (opts.backend === "force") {
        // Main-thread force layout. (Off-thread + progressive convergence via a Web Worker is the
        // next slice.) Multilevel coarsening seeds it by default; opt out for a plain cold start.
        const iterations = opts.iterations ?? DEFAULT_FORCE_ITERATIONS;
        const graph = this.graph;
        const from = duration > 0 ? graph.positions.slice() : null; // where a transition eases from
        if (opts.multilevel === false) {
          seedPositions(graph, this.width, this.height, { force: opts.force });
          new ForceLayout(graph, opts.force).run(iterations, "hot"); // a cold start untangles at full heat
        } else {
          multilevelLayout(graph, {
            width: this.width,
            height: this.height,
            iterations,
            force: opts.force,
          });
        }
        if (from) {
          const target = graph.positions.slice();
          graph.positions.set(from); // the solve wrote in place: show the old layout until the transition moves it
          this.transitionTo(graph, target, duration);
        } else {
          this.recomputeLODGeometry(); // synchronous solve is done
        }
      }
      // Frame the first paint against the seeded (box-centred) layout so a streaming fit opens framed
      // rather than piled at the origin; each subsequent streamed frame reframes in scheduleLayoutRepaint.
      // Recompute the LOD geometry from the just-seeded positions first: a preceding `lod({ modules })`
      // may have computed the tree geometry from the graph's initial (zero) positions, and the streaming
      // branches don't refresh it before this first fit — using it stale collapses the frame to the origin.
      if (this.fitOnLayout) {
        this.recomputeLODGeometry();
        this.fitViewToLayout();
      }
    }
    return this.rebuild();
  }

  /**
   * The module tree built from `modules` + `moduleLinks` for the current graph — once, then cached per
   * (graph, modules, moduleLinks) identity (#326), so turning LOD off and on, switching its source, or
   * re-running a layout never rebuilds it. O(nodes + edges) on a miss (the super-edge build dominates).
   */
  private moduleTreeOf(modules: ArrayLike<ModuleNode>, moduleLinks: ArrayLike<ModuleLink> | undefined): LODTree | undefined {
    const graph = this.graph;
    if (!graph) return undefined;
    const cached = this.moduleTreeCache;
    if (cached && cached.graph === graph && cached.modules === modules && cached.moduleLinks === moduleLinks) return cached.tree;
    const tree = buildModuleLODTree(graph.nodeCount, modules, graph, moduleLinks);
    this.moduleTreeCache = { graph, modules, moduleLinks, tree };
    return tree;
  }

  /**
   * The module tree every module consumer reads (#326) — the nested layout (#324), the GPU module seed
   * (N8.2), and the cut when it draws modules: an explicit `lod({ modules })`'s (the back-compat alias),
   * else the engine hierarchy's from `data(graph, { modules })`, whatever the LOD state. `undefined`
   * without either. Built on first use, then cached ({@link moduleTreeOf}).
   */
  private moduleTree(): LODTree | undefined {
    const o = this.lodOptions;
    if (o?.modules) return this.moduleTreeOf(o.modules, o.moduleLinks);
    const h = this.hierarchy;
    return h ? this.moduleTreeOf(h.modules, h.moduleLinks) : undefined;
  }

  /** Whether the LOD cut draws a module hierarchy (#326): an explicit `lod({ modules })`, or the engine
   *  hierarchy unless `source: "structure"`. False with LOD off. */
  private lodUsesModules(): boolean {
    const o = this.lodOptions;
    return !!o && (!!o.modules || (o.source !== "structure" && !!this.hierarchy));
  }

  /** Whether the cut draws the worker-streamed coarsening tree, whose position geometry the worker owns
   *  (#103) — so the main thread skips its own geometry pass. */
  private drawsWorkerTree(): boolean {
    return this.lodWorkerTree !== null && this.lodTree === this.lodWorkerTree;
  }

  /**
   * Nested module layout (#324): off-thread + streamed per depth on worker/gpu, synchronous on force.
   * A warm start (#328) seeds from the current positions and lands in one piece, with no depth frames;
   * with a `duration` the result is eased to ({@link positionTween}) instead of jumped to.
   */
  private startNestedLayout(tree: LODTree, opts: NetworkLayoutOptions, duration: number): void {
    const graph = this.graph;
    const { parent } = tree;
    if (!graph || !parent) return; // provided module trees always carry their parent map
    const topology = { ...tree, parent };
    const cfg = typeof opts.nested === "object" ? opts.nested : {};
    const warm = cfg.warm === true;
    const radius = 10 * Math.sqrt(graph.nodeCount); // a cold root disc, centred on the origin
    // A warm map is placed over the current one (same leaf centroid + spread), so its extent is known
    // only once solved ({@link landNested}).
    this.fitKnownBox = warm ? null : [-radius, -radius, radius, radius];
    // Created before the solve starts: it snapshots the positions it eases from.
    const tween = duration > 0 ? this.positionTween(graph, duration) : null;
    const params: NestedLayoutParams = {
      radius: warm ? undefined : radius,
      // A snapshot (the transition's, when there is one), not the live buffer: after a shared-memory
      // worker run that buffer is SAB-backed, and posting it would share it with the worker, not copy it.
      initial: warm ? (tween?.from ?? graph.positions.slice()) : undefined,
      iterations: cfg.iterations,
      packing: cfg.packing,
      size: (cfg.size ?? "flow") === "flow" ? (graph.flow ?? undefined) : undefined,
    };
    if (opts.backend === "worker" || opts.backend === "gpu") {
      const oneFrame = warm || tween !== null;
      this.nestedSolving = true;
      const solve = startNestedWorkerLayout(graph, topology, params, () => this.scheduleLayoutRepaint(), {
        stream: !oneFrame,
        onResult: oneFrame ? (positions) => this.landNested(graph, positions, tween) : undefined,
        onBoundaries: (discs) => {
          if (this.graph === graph) this.nestedDiscs = { tree, discs }; // the modules' geometry, and their rings' (#329)
        },
      });
      this.onLayoutSettled(tween ? this.transitionHandle(tween, solve) : solve);
    } else {
      const result = nestedLayout(topology, params);
      const positions = result.positions;
      this.nestedDiscs = { tree, discs: nestedBoundaryDiscs(topology, result) }; // the modules' geometry, and their rings' (#329)
      if (tween) {
        this.onLayoutSettled(this.transitionHandle(tween));
        tween.to(positions);
      } else {
        graph.positions.set(positions);
        this.recomputeLODGeometry(); // synchronous solve is done
      }
    }
  }

  /**
   * A worker nested layout's final positions, when it posts only those (a warm start or a transition,
   * #328). With `fit`, a warm map's extent is known only now: frame it. Then ease to it, or jump.
   */
  private landNested(graph: NetworkGraph, positions: Float32Array, tween: PositionTransition | null): void {
    if (this.fitOnLayout && !this.fitKnownBox) this.fitKnownBox = positionsBox(positions, graph.nodeCount);
    if (tween) {
      if (this.fitOnLayout) this.fitViewToLayout(); // frame the final layout once, as the transition starts
      tween.to(positions);
    } else {
      graph.positions.set(positions);
      this.scheduleLayoutRepaint();
    }
  }

  /**
   * A position transition of `graph` over `duration` ms (#328), snapshotting its positions now. Each
   * frame is the positions-only repaint the drag path uses ({@link repaintDuringDrag}): the O(nodes)
   * interpolation, the LOD tree's O(tree size) position pass (no style pass), then the re-emit. A node
   * grabbed before the transition started (a worker nested solve still computing its target) is held
   * under the cursor over each frame ({@link dragReapply}), and kept where it is dropped.
   */
  private positionTween(graph: NetworkGraph, duration: number): PositionTransition {
    return positionTransition(graph.positions, {
      duration,
      onFrame: () => {
        if (this.graph !== graph) return;
        this.dragReapply?.();
        this.repaintDuringDrag();
      },
    });
  }

  /** A layout handle for a transition (#328): it settles when the transition ends, and `stop()` also
   *  stops `solve` — the worker computing the transition's target, if any. */
  private transitionHandle(tween: PositionTransition, solve?: WorkerLayoutHandle): WorkerLayoutHandle {
    this.transition = tween;
    return {
      shared: false,
      mainThread: !solve,
      settled: tween.settled,
      stop: () => {
        solve?.stop();
        tween.stop();
      },
      pin() {},
      unpin() {},
    };
  }

  /** Ease `graph`'s positions to an already-computed `target` over `duration` ms (#328). `prepare`
   *  runs on settle, before the final geometry pass. */
  private transitionTo(graph: NetworkGraph, target: Float32Array, duration: number, prepare?: () => void): void {
    const tween = this.positionTween(graph, duration);
    this.onLayoutSettled(this.transitionHandle(tween), prepare);
    tween.to(target);
  }

  /** Make `handle` the running layout, and refresh once it settles (unless superseded): exact LOD
   *  geometry, the final reframe + release of a streaming fit, one rebuild. */
  private onLayoutSettled(handle: WorkerLayoutHandle, prepare?: () => void): void {
    this.layoutHandle = handle;
    void handle.settled.then(() => {
      if (this.layoutHandle !== handle) return; // a newer layout superseded this one
      this.transition = null;
      this.nestedSolving = false;
      prepare?.();
      this.recomputeLODGeometry(true);
      this.releaseFit(); // final reframe on the settled bounds, then hand the view to zoom/pan
      this.rebuild();
    });
  }

  /** Post-layout bookkeeping for state-network mode (#171/#182), shared by every backend and every
   *  streamed frame: size the container/rosette radii against the (current) physical layout scale, apply
   *  the `both`-view dot radius, and re-derive the active view's rosette positions from the physical
   *  positions. O(physicalCount) sizing + O(stateCount) rosette placement — cheap enough to call once per
   *  streamed physical frame (worker/gpu backends) as well as once after a synchronous solve. */
  private applyStateDerivedPositions(): void {
    this.computeStateSizing();
    if (this.activeView === "both" && this.bothDotRadius > 0) {
      this.styleOpts = { ...this.styleOpts, nodeRadius: this.bothDotRadius };
      this.resolvedCache = null;
    }
    this.deriveStatePositions();
  }

  /**
   * Layout for state-network mode (#171/#182): lay out the **physical** graph (the coarser structure) with
   * the requested backend, then derive the **rosette** state positions from it. Both view graphs share
   * their own position buffer, so after this the active view renders immediately.
   *
   * - `backend: "positions"` supplies the **physical** positions directly.
   * - `backend: "force"` runs the in-library multilevel/force layout on the physical graph, synchronously.
   * - `backend: "worker"` / `"gpu"` mirror {@link layout}'s async branches, but drive the **physical**
   *   graph: positions stream progressively into `sg.physical.positions`, and each coalesced frame
   *   ({@link scheduleLayoutRepaint}) re-derives the rosette from them, so the state/both views converge
   *   live alongside the physical layout. No worker-built LOD tree is requested here (`lod` stays unset) —
   *   the state-network LOD tree is over the state/module hierarchy, a different structure from the
   *   worker's physical-graph coarsening; module-aware GPU layout (#106 N8.2-4) is a later milestone.
   */
  private layoutStateNetwork(opts: NetworkLayoutOptions): this {
    const sg = this.stateData!;
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    const phys = sg.physical;
    this.haltLayout(); // cancel a running physical-layout worker/GPU stream before re-seeding

    if (opts.backend === "positions" && opts.positions) {
      phys.positions.set(opts.positions);
      this.applyStateDerivedPositions();
      this.recomputeLODGeometry();
      return this.rebuild();
    }

    if (opts.backend === "worker" || opts.backend === "gpu") {
      // fit: true (#238) frames the streaming physical layout via the CAMERA (like the main layout path)
      // instead of the `scaleToViewport` position-remap — so state networks open framed and converge in
      // place (no top-left flash + settle snap on the GPU backend). The state sizing is scale-relative
      // (computeStateSizing sizes against physicalSpacing), so leaving positions in force scale is fine.
      // Pre-seed so the first paint is framed (the GPU device resolves async → phys is zero until then);
      // each streamed frame reframes in scheduleLayoutRepaint, released on settle/interaction.
      const fit = opts.fit === true;
      this.fitOnLayout = fit;
      this.fitFallbackBox = null;
      this.fitNodesArr = null;
      this.fitNodesFor = null;
      if (fit) seedPositions(phys, this.width, this.height, { force: opts.force });
      const onPhysFrame = () => this.scheduleLayoutRepaint();
      const workerOpts = {
        width: this.width,
        height: this.height,
        iterations: opts.iterations ?? DEFAULT_FORCE_ITERATIONS,
        force: opts.force,
      };
      const handle: WorkerLayoutHandle =
        opts.backend === "worker"
          ? startWorkerLayout(phys, { ...workerOpts, multilevel: opts.multilevel }, onPhysFrame)
          : startGpuLayout(this.whenBackendSettled().then(() => this.gpuDevice()), phys, workerOpts, onPhysFrame);
      this.layoutHandle = handle;
      void handle.settled.then(() => {
        if (this.layoutHandle !== handle) return; // a newer layout superseded this one
        // Without fit, scaleToViewport remaps the physical positions to fill the view at k=1 now that the
        // stream has stopped writing them. With fit, the camera already tracks the layout — derive + refresh
        // geometry from the final positions first, then do the final reframe + release (release needs fresh
        // geometry to frame the settled layout, not the last streamed frame's).
        if (!fit) scaleToViewport(phys.positions, sg.physicalCount, this.width, this.height);
        this.applyStateDerivedPositions();
        this.recomputeLODGeometry(true);
        if (fit) this.releaseFit();
        this.rebuild();
      });
      // `worker` seeds `phys.positions` synchronously before returning; the async `gpu` device promise
      // seeds once it resolves. Either way, deriving now (rather than leaving a stale prior rosette on
      // screen) is cheap and self-corrects on the first streamed frame regardless.
      this.applyStateDerivedPositions();
      this.recomputeLODGeometry();
      if (fit) this.fitViewToLayout(); // frame the first paint against the seeded layout
      return this.rebuild();
    }

    // Main-thread force (backend: "force", the synchronous default).
    const iterations = opts.iterations ?? DEFAULT_FORCE_ITERATIONS;
    if (opts.multilevel === false) {
      seedPositions(phys, this.width, this.height, { force: opts.force });
      new ForceLayout(phys, opts.force).run(iterations, "hot"); // a cold start untangles at full heat
    } else {
      multilevelLayout(phys, { width: this.width, height: this.height, iterations, force: opts.force });
    }
    // Scale the layout to fill the view at k=1 (the map-of-modules approach) so it opens framed without
    // a fit-transform. Caller-supplied positions are taken as-is (already placed).
    scaleToViewport(phys.positions, sg.physicalCount, this.width, this.height);
    this.applyStateDerivedPositions();
    this.recomputeLODGeometry();
    return this.rebuild();
  }

  /** The physical-view pie layer (#171): overlapping (≥2-module) physical nodes as instanced pie wedges,
   *  drawn on top of the node discs. Null off the physical view, without pie wedges, or when none overlap. */
  private pieInstancedLayer(graph: NetworkGraph, resolved: ResolvedNetworkStyle): InstancedLayer | null {
    if (this.activeView !== "physical" || !this.pieWedges) return null;
    // Draw the pie at the node's INNER radius (inside any constant border), so the "nodes" circle's
    // border ring shows around the pie exactly as it does around a single-module disc (#171 review).
    const cb = resolved.constBorder;
    const radii = cb ? Float32Array.from(resolved.nodeRadii, (r) => Math.max(0, r - Math.min(r, cb.width))) : resolved.nodeRadii;
    const pie = physicalPieInstances(this.pieWedges, graph.positions, radii);
    if (pie.count === 0) return null;
    return { name: this.PIE_LAYER, primitive: "pie", pie, sizeMode: resolved.sizeMode };
  }

  /** The `both`-view container layer (#171): faint world-sized discs at each physical node, sized to hold
   *  its confined state rosette — drawn UNDER the state nodes/links so state nodes read as "inside" their
   *  physical node. Null outside the `both` view. */
  private containerLayer(): InstancedLayer | null {
    if (this.activeView !== "both" || !this.stateData || !this.containerRadii || !this.physicalColors) return null;
    const sg = this.stateData;
    const n = sg.physicalCount;
    const colors = new Uint8Array(n * 4);
    // A thin black border ring makes the faint container disc clearly visible (#171 review).
    const borders = new Float32Array(n);
    const borderColors = new Uint8Array(n * 4);
    for (let p = 0; p < n; p++) {
      const [r, g, b] = rgbaBytes(this.physicalColors[p]!);
      colors[4 * p] = r;
      colors[4 * p + 1] = g;
      colors[4 * p + 2] = b;
      colors[4 * p + 3] = 42; // faint — a context backdrop, not a solid glyph
      borders[p] = Math.min(0.25, 1.5 / this.containerRadii[p]!); // ≈1.5 world-unit ring
      borderColors[4 * p + 3] = 255; // opaque black (rgb = 0)
    }
    return {
      name: this.CONTAINER_LAYER,
      primitive: "circles",
      sizeMode: "world", // world-sized so state nodes stay inside their container at every zoom
      circles: { centers: sg.physical.positions, radii: this.containerRadii, colors, borders, borderColors, count: n },
    };
  }

  /**
   * Coalesce progressive worker frames into at most one repaint per animation frame. With a
   * worker-streamed LOD tree the geometry is already fresh (the worker wrote it before posting the
   * frame), so the main thread only re-cuts; otherwise the positions changed and the LOD geometry is
   * recomputed here before the cut — LOD tracks the layout *as it converges*, not only once settled.
   *
   * State-network mode (#182) is also driven through here when the physical layout streams: the
   * callback re-derives the rosette from the just-streamed physical positions (O(physicalCount) sizing +
   * O(stateCount) placement) before the LOD/render step, so the state/both views track the physical
   * layout live instead of only once it settles.
   */
  private scheduleLayoutRepaint(): void {
    // Raised at message time (not in the rAF): a pan between a streamed frame and its coalesced
    // repaint must not label from a grid indexing the pre-stream positions (#212).
    this.labelSource.stale = true;
    if (this.layoutRepaintRaf) return;
    const raf: (cb: FrameRequestCallback) => number =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 16);
    this.layoutRepaintRaf = raf(() => {
      this.layoutRepaintRaf = 0;
      this.dragReapply?.(); // hold the dragged nodes under the cursor over the worker's snapshot (#140, copy mode)
      if (this.stateData) this.applyStateDerivedPositions(); // physical positions just streamed a frame
      if (!this.drawsWorkerTree()) this.recomputeLODGeometry(); // worker streams geometry; main only re-cuts
      // Fit-on-layout: reframe the camera to the layout's freshly-updated bounds BEFORE the rebuild, so
      // the LOD cut + render run once at the framed transform (no extra emit). Cleared on settle/gesture.
      if (this.fitOnLayout) this.fitViewToLayout();
      this.rebuild();
    });
  }

  /**
   * Reframe the camera on the streaming layout's live bounds (centroid → view centre, longest extent →
   * ~85% of the view) and re-seed the zoom gesture to match. Called for a `layout({ fit: true })` run on
   * the first paint and each streamed frame until it settles or the user interacts. Sets the transform
   * *state* only (no render) — the caller's `rebuild()` renders once at the framed transform. Bounds come
   * from {@link layoutFitBox} (O(top-level modules), not O(nodes)).
   */
  private fitViewToLayout(): void {
    const backend = this.backend();
    if (!backend || !this.graph) return;
    const box = this.layoutFitBox(this.graph);
    if (!box) return;
    const t = fitTransform(box, this.width, this.height);
    this.transform = t;
    backend.setTransform(t); // state only (no render); rebuild() emits the cut + renders once at `t`
    this.syncZoomToView(); // keep the gesture seeded to the framed view so an interaction never jumps
  }

  /**
   * The layout's world-space bounding box `[minX, minY, maxX, maxY]` for {@link fitViewToLayout}. When LOD
   * geometry exists it's the union of the tree's **top-level (root) nodes'** `cx/cy ± extent` — O(number of
   * top-level modules), independent of node count, and the whole graph is bounded because a root's extent
   * bounds all its descendant leaves. With LOD off (no tree) it falls back to a **one-time** full-position
   * bbox, computed once and held in {@link fitFallbackBox} so the fallback never costs O(nodes) per frame
   * (the layout stays roughly framed as it refines; use LOD for continuous reframing). Null if unavailable.
   */
  private layoutFitBox(graph: NetworkGraph): FitBox | null {
    if (this.fitKnownBox) return this.fitKnownBox;
    // Preferred: a fling-out-robust box over the top modules ({@link fitBox}) — O(top modules), refreshed
    // each frame from the live geometry. The fit nodes are cached per tree identity (the scratch too), so
    // the per-frame work is O(top modules), not O(tree size).
    if (this.lodTree && this.lodHasGeometry) {
      let nodes = this.fitNodesArr;
      if (this.fitNodesFor !== this.lodTree || !nodes) {
        nodes = fitNodes(this.lodTree);
        this.fitNodesArr = nodes;
        this.fitNodesFor = this.lodTree;
      }
      if (!this.fitScratch || this.fitScratch.length < nodes.length) this.fitScratch = new Float32Array(nodes.length);
      const box = fitBox(this.lodTree, nodes, this.fitScratch);
      if (box) return box;
    }
    // LOD off (no tree): one-time full-position bbox, held so the fallback never costs O(nodes) per frame.
    return (this.fitFallbackBox ??= positionsBox(graph.positions, graph.nodeCount));
  }

  /** Final reframe + release of a streaming fit (on settle): fit once more to the settled bounds, then
   *  stop per-frame fitting so the view is the user's to pan/zoom (the gesture is already seeded to it).
   *  (A gesture *before* settle releases the fit via {@link setInteracting}.) */
  private releaseFit(): void {
    if (!this.fitOnLayout) return;
    this.fitViewToLayout();
    this.fitOnLayout = false;
  }

  /**
   * The luma.gl Device from the live WebGL backend, or null on Canvas/SVG/SSR backends.
   * Used by `startGpuLayout` to decide whether the GPU path is available.
   */
  private gpuDevice(): import("@luma.gl/core").Device | null {
    const b = this.handle?.backend;
    return b instanceof WebGLBackend ? b.gpuDevice : null;
  }

  /** Stop a running worker layout or position transition (no-op if none). The last computed — or
   *  eased — positions are kept. A nested layout's transition stopped mid-ease leaves the nodes between
   *  two layouts, so its discs no longer hold: the modules (and their rings) fall back to their members'
   *  centroid + extent (#329). */
  stopLayout(): this {
    const interrupted = this.transition?.running === true && this.nestedDiscs !== null;
    this.haltLayout();
    if (interrupted) {
      this.nestedDiscs = null;
      this.settleLODPositions(); // the modules and rings redraw around where the members stopped
    }
    return this;
  }

  /** {@link stopLayout} without its repaint, for the callers that go on to set new state and rebuild. */
  private haltLayout(): void {
    this.layoutHandle?.stop();
    this.layoutHandle = null;
    this.transition = null;
    this.lodStreaming = false; // no worker run is in flight to stream the LOD tree any more
    this.nestedSolving = false;
    if (this.layoutRepaintRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.layoutRepaintRaf);
    this.layoutRepaintRaf = 0;
  }

  /** Resolves when the current worker layout converges — or its position transition ends (#328) — or
   *  is stopped (immediately if none runs). */
  whenSettled(): Promise<void> {
    return this.layoutHandle?.settled ?? Promise.resolve();
  }

  /** Tear down the engine, cancelling any worker layout first. */
  override destroy(): void {
    this.haltLayout();
    super.destroy(); // base tears down the shared label overlay (#105 N7b, #223)
  }

  /**
   * Which tree currently drives LOD rendering: `"worker"` when the active tree is the one the layout
   * worker built and streams (so the main thread does no coarsening or O(N) geometry pass),
   * `"modules"` when it's a module hierarchy (N6 / #104 — `data(graph, { modules })` or
   * `lod({ modules })`, #326), `"spatial"` when it's the edge-less
   * quadtree built over the node positions, `"main"` when it's the coarsening tree built on the main
   * thread (`force`/`positions` backends, the worker fallback, or LOD enabled after a worker run), or
   * `"none"` when LOD is off or no geometry exists yet. Introspection for debugging and tests.
   */
  get lodSource(): "worker" | "modules" | "spatial" | "main" | "none" {
    if (!this.lodOptions || !this.lodTree || !this.lodHasGeometry) return "none";
    if (this.drawsWorkerTree()) return "worker";
    if (this.lodModules) return "modules";
    return this.lodSpatial ? "spatial" : "main";
  }

  /**
   * Which position transport the active layout uses:
   * - `"gpu"` — running on the WebGL GPU path (the handle's `transport` field is `"gpu"`).
   * - `"shared"` — CPU worker, positions stream zero-copy via a `SharedArrayBuffer` (cross-origin isolated page).
   * - `"copy"` — CPU worker, positions are posted as per-frame snapshots (no COOP/COEP isolation, or
   *   the worker fell back to a synchronous solve).
   * - `"none"` — no layout active (`force`/`positions` backends, or before `layout()`).
   *
   * For a `backend: "gpu"` layout this resolves **asynchronously**: it is `"copy"` (the async
   * wrapper's initial state) until the device promise settles and the GPU path is confirmed, then
   * flips to `"gpu"`. Read it after `await net.whenSettled()` or on a subsequent animation frame
   * for the final resolved value. The environment's *capability* (independent of any run) is
   * {@link sharedMemoryAvailable}.
   */
  get layoutTransport(): "gpu" | "shared" | "copy" | "none" {
    if (!this.layoutHandle || this.layoutHandle.mainThread) return "none";
    if (this.layoutHandle.transport === "gpu") return "gpu";
    return this.layoutHandle.shared ? "shared" : "copy";
  }

  /**
   * Re-emit the instanced layers to the backend and repaint. A no-op until a graph is set and a
   * backend exposing the instanced lane is live — on non-WebGL backends this draws through the
   * PathContext seam instead (small-N / export, #100 N2.3). When LOD is active and settled, the
   * emitted layers are the cut frontier rather than the full graph.
   */
  private rebuild(): this {
    if (!this.graph) return this;
    // Every position-mutating repaint funnels through here (drag, settle, data/layout/view change;
    // streamed frames additionally mark at message time in scheduleLayoutRepaint) — so the no-LOD
    // label grid must not be trusted until rebuilt from the new coordinates (#212). Conservative
    // for style-only rebuilds (those are click-frequency, not per-frame): the next settled label
    // refresh rebuilds the grid once, O(nodeCount), never per frame.
    this.labelSource.stale = true;
    const backend = this.backend();
    if (!backend) return this;
    // "auto" mode's placeholder canvas (#201). The Scene branch below exists only because a vector
    // backend has no instanced lane, so at scale it tessellates + paints a full graph that the
    // WebGL backend landing moments later throws away — a 611k-edge graph blocked the main thread
    // for ~9.5 s per rebuild before showing anything. Withhold it and let the upgrade paint the
    // first frame; if WebGL never arrives, BaseEngine re-installs canvas and this rebuilds for real.
    if (!backend.setInstancedLayer && this.skipPlaceholderEmit(this.graph.nodeCount + this.graph.edgeCount)) {
      this.unregisterLanes();
      this.clearNetworkScene();
      // Nothing is drawn, so nothing is labelled — and `refreshLabels` would scan every node to
      // place labels over an empty canvas. `routeLabels` no-ops when labels are off (#223 seam).
      this.routeLabels([]);
      this.render();
      return this;
    }
    const style = this.resolvedStyleCached(this.graph);

    if (backend.setInstancedLayer) {
      // WebGL: register the active instanced lane via BaseEngine's registry. Clear any Scene geometry
      // left from a previous non-WebGL backend so a backend switch doesn't double-draw.
      if (this.sceneActive) {
        this.registerNetworkScene(this.graph, style, false);
        this.sceneActive = false;
      }
      this.syncLane();
      // LOD on, worker backend, no tree yet — schedule the main-thread fallback build.
      if (this.lodOptions && this.layoutOpts.backend === "worker" && !this.lodReady()) {
        this.scheduleLODFallback();
      }
    } else {
      // SVG/Canvas: emit the glyphs through the PathContext seam as Scene layers, so the
      // existing pipeline renders them and toSVG() produces publication output. (LOD is a
      // WebGL-scale feature; vector backends always draw the full graph.)
      this.unregisterLanes();
      this.registerNetworkScene(this.graph, style, true);
      this.sceneActive = true;
    }
    // Set labels BEFORE the render so a backend that bakes them into the frame (Canvas) draws the
    // current labels in this render rather than one rebuild behind.
    this.refreshLabels(); // the frontier just changed (data/layout/lod/backend) — re-place labels
    this.render();
    return this;
  }

  /**
   * Register the active instanced lane for the current backend/LOD state (LOD = dynamic, no-LOD =
   * static), or unregister on a vector backend. Replaces the old `this.lane` field + the
   * `setTransform`/`pick` overrides — BaseEngine now drives re-emit and pick-resolution. (#108-B)
   */
  private syncLane(): void {
    const backend = this.backend();
    if (!backend?.setInstancedLayer || !this.graph) { this.unregisterLanes(); return; }
    if (this.lodReady() && this.lodTree) {
      const tree = this.lodTree;
      const maxAgg = this.lodOptions!.maxAggregateRadius ?? Infinity;
      const strategy: SelectionStrategy = {
        select: () => this.computeFrontier(tree, this.resolvedStyleCached(this.graph!)),
        pick: (x, y, t, visible) => pickFrontier(tree, visible, x, y, t, { screenSized: this.resolvedStyleCached(this.graph!).sizeMode === "screen", maxAggregateRadius: this.lodOptions!.maxAggregateRadius }),
        pickRegion: (rect, t, visible) => regionFrontier(tree, visible, rect, t), // marquee (#159): frontier centres in rect
      };
      const lane = new InstancedLane(strategy, (visible) => this.frontierLayers(tree, this.resolvedStyleCached(this.graph!), visible));
      this.registerInstancedLane(this.NET_LANE, {
        lane, layerNames: LAYER_NAMES, dynamic: true,
        resolve: (g) => ({ layer: this.NODE_LAYER, id: g, datum: this.lodDatum(tree, g) }),
        interactive: this.laneInteractive((g) => this.lodDatum(tree, g), (g) => leavesUnder(tree, g)),
        // Link picking (#141): frontierLayers sets `linkResolve` per emit (it has the super-edge ids/flows).
        gpuPick: this.pickLinksEnabled ? (id) => this.linkResolve?.(id) ?? null : undefined,
      });
      // Ring overlay reads the same radius the glyph draws at (frontierCircles): leaves/1-child uncapped,
      // aggregates capped at maxAggregateRadius — so the ring hugs the glyph exactly at any zoom.
      this.syncHighlightLane(lane, (g) => [tree.cx[g]!, tree.cy[g]!], (g) => (g < tree.leafCount || tree.count[g] === 1 ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg)), true);
    } else if (!this.lodOptions) {
      const graph = this.graph;
      const strategy: SelectionStrategy = {
        // No-LOD: the full graph is drawn directly by networkLayers and picked by pickNodes — both scan
        // the graph and ignore `visible` — so select returns the shared empty sentinel rather than
        // building (and retaining in lane.visible) an N-length all-indices array per register.
        select: () => EMPTY_VISIBLE,
        pick: (x, y, t) => pickNodes(graph.positions, this.resolvedStyleCached(graph).nodeRadii, graph.nodeCount, x, y, t, this.resolvedStyleCached(graph).sizeMode === "screen"),
        pickRegion: (rect, t) => regionNodes(graph.positions, graph.nodeCount, rect, t), // marquee (#159): node centres in rect
      };
      // No-LOD: instance i of every link layer is edge i (parallel emit), so the resolve is static.
      this.linkResolve = (i) => this.noLodLinkHit(graph, i);
      const leafDatum = this.leafDatumOf();
      const lane = new InstancedLane(strategy, () => {
        const resolved = this.resolvedStyleCached(graph);
        const base = this.attachNoLodHighlight(this.flagPickableLinks(this.noLodLayers(graph, resolved)), this.noLodCache(graph, resolved));
        // State-network overlays (#171), build-once per emit: the `both`-view physical **container** discs
        // draw UNDER the nodes/links (backdrop), the physical-view **pie** wedges draw ON TOP (cover the disc).
        const container = this.containerLayer();
        const pie = this.pieInstancedLayer(graph, resolved);
        return [...(container ? [container] : []), ...base, ...(pie ? [pie] : [])];
      });
      this.registerInstancedLane(this.NET_LANE, {
        // Overlay layer names must be in layerNames so a view switch removes them (emit-set-change re-adds).
        lane, layerNames: this.stateData ? [this.CONTAINER_LAYER, ...LAYER_NAMES, this.PIE_LAYER] : LAYER_NAMES, dynamic: false,
        resolve: (i) => ({ layer: this.NODE_LAYER, id: i, datum: leafDatum(i) }),
        interactive: this.laneInteractive(leafDatum, (i) => [i]),
        gpuPick: this.pickLinksEnabled ? (id) => this.linkResolve?.(id) ?? null : undefined,
      });
      // No-LOD: the whole graph is drawn, so every selected/hovered node index is "visible" (source=null).
      this.syncHighlightLane(null, (i) => [graph.positions[2 * i]!, graph.positions[2 * i + 1]!], (i) => this.resolvedStyleCached(graph).nodeRadii[i]!, false);
    } else {
      // LOD on but no tree yet (worker streaming) — draw nothing, not pickable.
      this.unregisterLanes();
    }
  }

  /** Drop every retained Scene layer the vector path registers, in one pass. Unlike
   *  `registerNetworkScene(graph, style, false)` — which registers the same slots *empty* and
   *  therefore still pays O(nodeCount + edgeCount) for the id arrays and id→index maps — this is
   *  O(layers): the right clear when the Scene must not cost anything at all (#201). */
  private clearNetworkScene(): void {
    for (const name of [this.CONTAINER_LAYER, "module-boundaries", "links", "arrows", "node-halos", this.NODE_LAYER, this.PIE_LAYER]) {
      this.removeLayer(name);
    }
    this.sceneActive = false;
  }

  /** Unregister both the node lane and its companion ring overlay (backend switch / no graph). */
  private unregisterLanes(): void {
    this.unregisterInstancedLane(this.NET_HL_LANE);
    this.unregisterInstancedLane(this.NET_LANE);
  }

  private lodDatum(tree: LODTree, g: number): NetworkHit {
    const aggregate = g >= tree.leafCount;
    const count = tree.count[g]!;
    if (tree.branch && tree.parent) return new ModuleTreeHit(tree.parent, tree.branch, g, aggregate, count);
    // A structural cut over a graph with a hierarchy (#326): a leaf still reports its own path.
    const h = this.hierarchy;
    return h && !aggregate ? new LeafRecordHit(h.modules[h.recordOf[g]!]!) : { aggregate, count };
  }

  /** The hit datum of leaf node `i` outside a module tree (the no-LOD lane): its own record path when
   *  the engine holds a hierarchy (#326), else a plain leaf. O(1) per hit — no tree is built. */
  private leafDatumOf(): (i: number) => NetworkHit {
    const h = this.hierarchy;
    if (!h) return () => ({ aggregate: false, count: 1 });
    const { modules, recordOf } = h;
    return (i) => new LeafRecordHit(modules[recordOf[i]!]!);
  }

  /**
   * Assemble the no-LOD full-graph layers (#179). On a **position-only** layout frame — the resolved
   * style object is identity-unchanged from the last full emit — rebuild ONLY the position-derived
   * endpoints/node-centres and reuse the cached style-derived attributes (colours/widths/radii/sizes),
   * so the colour/width scale accessors run O(edges) ONCE per style version, not per frame. On a full
   * change (`data`/`style`/`lod`) `resolvedStyleCached` hands back a fresh object, invalidating the
   * cache, and we run the full derivation (populating the cache for the next position frame).
   */
  private noLodLayers(graph: NetworkGraph, resolved: ResolvedNetworkStyle): InstancedLayer[] {
    return networkLayersFromCache(graph, resolved, this.noLodCache(graph, resolved));
  }

  /** Get-or-create the no-LOD cache (#179 style attrs + #214 highlight group columns) for the current
   *  (graph, resolved-style) version. First emit for a version computes it ONCE; position-only frames
   *  hit the valid branch (O(1)). A `data`/`style` change hands back a fresh `resolved` object,
   *  invalidating the cache — so the cached arrays are reference-stable exactly while they are valid. */
  private noLodCache(graph: NetworkGraph, resolved: ResolvedNetworkStyle): NoLodStyleCache {
    const cached = this.noLodStyleCacheVal;
    if (cached != null && this.noLodStyleCacheFor?.style === resolved && this.noLodStyleCacheFor?.graph === graph) return cached;
    const cache = noLodStyleCache(graph, resolved);
    this.noLodStyleCacheVal = cache;
    this.noLodStyleCacheFor = { style: resolved, graph };
    return cache;
  }

  /** Flag every link layer (lines/arrows/half-arrows; not node circles) into the GPU pick pass (#141)
   *  when link picking is on. Mutates the freshly-built layers in place (they're per-emit, never shared). */
  private flagPickableLinks(layers: InstancedLayer[]): InstancedLayer[] {
    if (this.pickLinksEnabled)
      for (const l of layers)
        if (l.primitive === "lines" || l.primitive === "arrows" || l.primitive === "half-arrows") l.pickable = true;
    return layers;
  }

  /** Attach the shader-highlight columns (#162) to the **no-LOD** full-graph layers, in place — so a
   *  hover/selection restyle is a uniform / flag-buffer update, never a geometry rebuild. Instance order
   *  is the parallel emit: the `nodes` circles layer's instance `i` is node `i`; every link layer
   *  (`lines`/`half-arrows`/`arrows`) instance `e` is graph edge `e`. The group columns (`groups` =
   *  node id / link source id; `groups2` = the link target, undirected incident hover) are
   *  position-independent, so they come from the {@link noLodCache} (#214) — the SAME array instances
   *  across position-only frames, letting the renderer skip their per-frame upload. `selected` follows
   *  the *selection* version instead: {@link noLodSelectedFor} caches it until the selection changes
   *  (#240), so position-only frames also skip its upload, while a selection change refreshes the GPU
   *  flags in place (via writeSelected) AND hands later emits the fresh arrays. */
  private attachNoLodHighlight(layers: InstancedLayer[], cache: NoLodStyleCache): InstancedLayer[] {
    let linkSelected: Uint8Array | undefined; // one build shared by all link layers (lines + arrows)
    for (const l of layers) {
      if (l.primitive === "circles") {
        // The only circles layer in the no-LOD path is `nodes` (no aggregate halos). Instance i = node i.
        l.circles.groups = cache.nodeGroups;
        l.circles.selected = this.noLodSelectedFor(this.NODE_LAYER);
      } else if (l.primitive === "lines" || l.primitive === "half-arrows" || l.primitive === "arrows") {
        const link = l.primitive === "lines" ? l.lines : l.primitive === "half-arrows" ? l.halfArrows : l.arrows;
        link.groups = cache.groupSource;
        if (cache.groupTarget) link.groups2 = cache.groupTarget;
        link.selected = linkSelected ??= this.noLodSelectedFor("links"); // links/arrows share the per-edge flag
      }
      // A "pie" layer (#171 physical view) is not part of the standard node/link set; it carries its own
      // per-wedge groups (physical node id) from physicalPieInstances, so no attachment is needed here.
    }
    return layers;
  }

  /** Resolve a picked link instance (#141) under LOD: instance i → super-edge `ids[i]` (the directed
   *  tree-node pair) + summed `flows[i]`. Returns a HoverHit with `layer: "links"`, or null if out of range. */
  private lodLinkHit(tree: LODTree, ids: number[], flows: number[] | undefined, index: number): HoverHit | null {
    if (index < 0 || index >= ids.length) return null;
    const pair = ids[index]!;
    const source = Math.floor(pair / tree.size);
    const target = pair - source * tree.size;
    const datum: NetworkLinkHit = {
      source,
      target,
      aggregate: source >= tree.leafCount || target >= tree.leafCount,
      weight: flows?.[index] ?? 0,
    };
    return { layer: this.LINK_LAYER, id: pair, datum };
  }

  /** Resolve a picked link instance (#141) with LOD off: instance i is graph edge i directly. */
  private noLodLinkHit(graph: NetworkGraph, index: number): HoverHit | null {
    if (index < 0 || index >= graph.edgeCount) return null;
    const datum: NetworkLinkHit = {
      source: graph.source[index]!,
      target: graph.target[index]!,
      aggregate: false,
      weight: graph.weight[index]!,
    };
    return { layer: this.LINK_LAYER, id: index, datum };
  }

  /** Build the lane interaction block for the node layer (#105 N7c-2), or undefined when no
   *  `interactive()` opts are set (pick-only). `datumOf`/`members` are keyed by the node/aggregate id. */
  private laneInteractive(datumOf: (id: number) => NetworkHit, members: (id: number) => number[]): LaneInteractive<NetworkHit> | undefined {
    const opts = this.interactiveOpts;
    if (!opts) return undefined;
    return {
      layer: this.NODE_LAYER,
      options: opts,
      highlightLane: this.NET_HL_LANE,
      datumOf: (id) => datumOf(id as number),
      members: (id) => members(id as number),
    };
  }

  /**
   * Register (or drop) the companion ring overlay lane. Its `select` returns the highlighted node ids
   * currently visible — intersected with the source lane's frontier (LOD) or taken directly (no-LOD,
   * full graph drawn) — and short-circuits to empty when nothing is highlighted (O(1) per frame). Its
   * `emit` builds one transparent-fill ring circle per highlighted glyph; never itself pickable.
   */
  private syncHighlightLane(source: InstancedLane | null, centerOf: (g: number) => [number, number], radiusOf: (g: number) => number, lod: boolean): void {
    if (!this.interactiveOpts) { this.unregisterInstancedLane(this.NET_HL_LANE); return; }
    const colors = resolveRingColors(this.interactiveOpts);
    const ringName = `${this.NET_HL_LANE}:ring`;
    const sizeMode = this.resolvedStyleCached(this.graph!).sizeMode;
    const strategy: SelectionStrategy = { select: () => this.highlightVisible(source, lod), pick: () => -1 };
    this.registerInstancedLane(this.NET_HL_LANE, {
      lane: new InstancedLane(strategy, (visible) => {
        if (visible.length === 0) return [];
        const selected = this.selectedIds(this.NODE_LAYER);
        const remove = this.removeIds(this.NODE_LAYER); // subtract-marquee preview (#140) — ring these red
        // Blue (selected) vs green (hover-only) ring: ancestor-aware under LOD, so an expanded selected
        // aggregate's children ring blue too (#162) — matching the kept-link/dim highlight.
        const isSel = lod && this.lodTree && selected?.size ? this.makeSelectedPredicate(this.lodTree, selected) : null;
        const selColored = (g: number): boolean => (isSel ? isSel(g) : !!selected?.has(g));
        return [{ name: ringName, primitive: "circles", sizeMode, circles: ringCircles(visible, centerOf, radiusOf, selColored, colors, remove ? (g) => remove.has(g) : undefined) }];
      }),
      layerNames: [ringName], dynamic: true,
      resolve: () => null,
    });
  }

  /** Highlighted node ids currently on screen: (selection ∪ hover) ∩ frontier (LOD, **ancestor-aware** —
   *  an expanded selected aggregate's children count, #162) or taken directly (no-LOD). Returns the
   *  shared empty sentinel when nothing is highlighted, so the per-frame ring re-emit costs O(1) until
   *  the user selects/hovers something. */
  private highlightVisible(source: InstancedLane | null, lod: boolean): Uint32Array {
    if (!this.hasHighlight(this.NODE_LAYER)) return EMPTY_VISIBLE;
    const sel = this.selectedIds(this.NODE_LAYER);
    const hov = this.hoveredIds(this.NODE_LAYER);
    if (lod && source && this.lodTree) {
      const isSel = sel && sel.size ? this.makeSelectedPredicate(this.lodTree, sel) : null;
      const vis = source.visible;
      const out: number[] = [];
      for (let i = 0; i < vis.length; i++) { const g = vis[i]!; if ((isSel && isSel(g)) || hov?.has(g)) out.push(g); }
      return out.length ? Uint32Array.from(out) : EMPTY_VISIBLE;
    }
    const ids = new Set<number>();
    if (sel) for (const id of sel) ids.add(id as number);
    if (hov) for (const id of hov) ids.add(id as number);
    if (ids.size === 0) return EMPTY_VISIBLE;
    const n = this.graph!.nodeCount;
    const out: number[] = [];
    for (const id of ids) if (id >= 0 && id < n) out.push(id);
    return Uint32Array.from(out);
  }

  /** The single hovered node id, or null — used to recolour that node's links (#162). Null during a
   *  multi-node marquee preview (which also writes `laneHilite`) and when the layer isn't hover-enabled. */
  private singleHoveredId(): number | null {
    if (!this.interactiveOpts?.hover) return null;
    const hov = this.hoveredIds(this.NODE_LAYER);
    if (!hov || hov.size !== 1) return null;
    return hov.values().next().value as number;
  }

  /** Opacity to fade non-highlighted glyphs to while hovering (#162), from `hover.others` — the hover
   *  analogue of `selection.others`, opt-in. Null when off or nothing is hovered. */
  private hoverDimOpacity(): number | null {
    if (this.singleHoveredId() == null) return null;
    const others = hoverParts(this.interactiveOpts?.hover).others;
    const op = others?.opacity;
    return op != null && op < 1 ? op : null;
  }

  /** The base lane's live shader-highlight uniforms (#162): the hovered group id, and the dim state from
   *  `selection.others` (a selection is active) OR `hoverDimOthers` (fade-on-hover). No geometry — these
   *  drive the vertex shader, so a hover is just a uniform change even on a full (LOD-off) draw. */
  private laneHighlightUniforms(): { hoverGroup: number; dimActive: boolean; dimOpacity: number } {
    const op = this.othersDim(this.NODE_LAYER) ?? this.hoverDimOpacity();
    return { hoverGroup: this.singleHoveredId() ?? -1, dimActive: op != null, dimOpacity: op ?? 1 };
  }

  /** Push the current highlight uniforms (and, when `selectedFor` is given, the refreshed per-instance
   *  `selected` flags) to the base lane's shader layers — no geometry rebuild. Does NOT render (callers do). */
  private pushLaneHighlight(selectedFor?: (layer: string) => Uint8Array | undefined): void {
    const backend = this.backend();
    if (!backend?.styleInstancedLayer) return;
    const u = this.laneHighlightUniforms();
    for (const layer of HL_LAYERS) {
      backend.styleInstancedLayer(layer, { hoverGroup: u.hoverGroup, dimActive: u.dimActive, dimOpacity: u.dimOpacity, selected: selectedFor?.(layer) });
    }
  }

  /** Per-instance `selected` flags for a no-LOD base layer from the current selection (#162) — refreshed
   *  in place on a selection change instead of rebuilding geometry. `nodes`: node i selected; link layers:
   *  edge e's source (directed) / either endpoint (undirected) selected. Cached per (graph, style,
   *  selection) version (#240): position-only frames get the SAME array instances back (the renderer
   *  skips their re-upload by reference identity); a selection change invalidates
   *  ({@link invalidateNoLodSelected}), so the next call builds FRESH arrays that do upload. */
  private noLodSelectedFor(layer: string): Uint8Array | undefined {
    const graph = this.graph;
    if (!graph) return undefined;
    const style = this.resolvedStyleCached(graph);
    const key = this.noLodSelectedCacheFor;
    if (!key || key.graph !== graph || key.style !== style) {
      this.invalidateNoLodSelected(); // data/style version changed — flag lengths/semantics may differ
      this.noLodSelectedCacheFor = { style, graph };
    }
    const sel = this.selectedIds(this.NODE_LAYER);
    if (layer === this.NODE_LAYER) {
      if (this.noLodSelectedNodes) return this.noLodSelectedNodes;
      const out = new Uint8Array(graph.nodeCount);
      if (sel) for (let i = 0; i < graph.nodeCount; i++) out[i] = sel.has(i) ? 1 : 0;
      this.noLodSelectedNodes = out;
      return out;
    }
    if (this.noLodSelectedLinks) return this.noLodSelectedLinks;
    const out = new Uint8Array(graph.edgeCount);
    if (sel) for (let e = 0; e < graph.edgeCount; e++) out[e] = sel.has(graph.source[e]!) || (!style.directed && sel.has(graph.target[e]!)) ? 1 : 0;
    this.noLodSelectedLinks = out;
    return out;
  }

  /** Drop the cached no-LOD `selected` flag columns (#240) — the selection they encode changed, so the
   *  next {@link noLodSelectedFor} builds fresh arrays (new references ⇒ the renderer uploads them). */
  private invalidateNoLodSelected(): void {
    this.noLodSelectedNodes = null;
    this.noLodSelectedLinks = null;
  }

  /** Shader-highlight columns for the emitted LOD super-edges (#162): `groups` = source tree-node,
   *  `groups2` = target (undirected incident hover only), `selected` = outgoing-from-a-selected-(sub)tree
   *  (ancestor-aware). Parallel to `ids` (shared by all link layers). */
  private linkHighlightColumns(ids: number[], size: number, isSel: ((g: number) => boolean) | null, directed: boolean): { groups: Float32Array; groups2?: Float32Array; selected: Uint8Array } {
    const n = ids.length;
    const groups = new Float32Array(n);
    const groups2 = directed ? undefined : new Float32Array(n);
    const selected = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const pair = ids[k]!;
      const s = Math.floor(pair / size);
      const t = pair - s * size;
      groups[k] = s;
      if (groups2) groups2[k] = t;
      if (isSel) selected[k] = isSel(s) || (!directed && isSel(t)) ? 1 : 0;
    }
    return groups2 ? { groups, groups2, selected } : { groups, selected };
  }

  // ── Shader-highlight lane hooks (#162) — hover/selection restyle without a geometry rebuild ─────────
  /** Hover changed: the ring overlay (cheap) + the base-lane hover uniform. No base re-emit. */
  protected override onLaneHoverChanged(_layer: string): void {
    this.emitInstancedLane(this.NET_HL_LANE);
    this.pushLaneHighlight();
    this.render();
  }
  /** Selection changed: LOD re-emits the base (rebuilds the ancestor-aware `selected` flags for the
   *  current frontier, O(visible); {@link onInstancedLaneEmitted} re-applies uniforms); no-LOD refreshes
   *  the `selected` flag buffers in place — neither rebuilds the full geometry on a click. */
  protected override onLaneSelectionChanged(_layer: string): void {
    this.invalidateNoLodSelected(); // #240: the cached flag columns encode the OLD selection
    if (this.lodReady() && this.lodTree) this.emitInstancedLane(this.NET_LANE);
    else this.pushLaneHighlight((layer) => this.noLodSelectedFor(layer));
    this.emitInstancedLane(this.NET_HL_LANE);
    this.render();
  }
  /** A fresh `setInstancedLayer` resets the highlight uniforms to their defaults — re-apply the live ones
   *  after any base-lane emit (per-frame LOD cut, selection re-emit, layout frame). Uniform-only, no render. */
  protected override onInstancedLaneEmitted(name: string): void {
    if (name === this.NET_LANE) this.pushLaneHighlight();
  }

  /** Ancestor-aware "is this frontier node selected" predicate over the LOD tree (#162) — a node counts
   *  if it OR any ancestor is in `sel`, so a selected module's expanding children stay highlighted while
   *  the selection set stays literal. Delegates to the pure {@link ancestorAwareSelected} (tested for the
   *  O(frontier·depth) bound), with parent pointers from {@link treeParent}. */
  private makeSelectedPredicate(tree: LODTree, sel: ReadonlySet<string | number>): (g: number) => boolean {
    return ancestorAwareSelected(this.treeParent(tree), (g) => sel.has(g));
  }

  /** Parent-pointer array for the LOD tree: the tree's own `parent` (provided-module trees) or one
   *  derived once from the children CSR (coarsening/spatial trees), cached by tree identity. O(tree size)
   *  on first need under a selection; not per frame. */
  private treeParent(tree: LODTree): Int32Array {
    if (tree.parent) return tree.parent;
    if (this.derivedParentFor === tree && this.derivedParent) return this.derivedParent;
    const parent = new Int32Array(tree.size).fill(-1);
    for (let g = 0; g < tree.size; g++) {
      for (let p = tree.childOffset[g]!; p < tree.childOffset[g + 1]!; p++) parent[tree.children[p]!] = g;
    }
    this.derivedParentFor = tree;
    this.derivedParent = parent;
    return parent;
  }

  // ── Node-drag (#140) ──────────────────────────────────────────────────────────────────────────
  /** The node/aggregate under host CSS px (x,y) when `interactive({ draggable })` is set — gates the
   *  d3-zoom pan filter and the pointerdown grab (#140). Only node hits are draggable; a link hit
   *  (#141) returns null so a drag starting on a link still pans. */
  protected override pickDraggable(x: number, y: number): HoverHit | null {
    if (!this.interactiveOpts?.draggable || !this.graph) return null;
    const hit = this.pick(x, y);
    return hit && hit.layer === this.NODE_LAYER ? hit : null;
  }

  /**
   * Begin dragging the grabbed node/aggregate (#140). Resolves the **held leaf set** — the whole
   * current selection if the grabbed glyph is part of it, else the grabbed glyph alone (an aggregate
   * expands to its subtree leaves; an unselected grab also *becomes* the single selection) — snapshots
   * their start positions, then holds them under the cursor while the layout reheats around them:
   *
   * - **force**: a main-thread {@link ForceLayout} pinned to the held set ticks in an rAF loop,
   *   reflowing neighbours; on release it re-cools for a short tail of ticks, then stops.
   * - **worker / gpu**: the backend pins + reflows the rest (worker off-thread, gpu on the GPU) via
   *   {@link WorkerLayoutHandle.pin}; the main thread writes the held positions every move (zero-lag)
   *   and re-pins them over each streamed frame ({@link dragReapply}, copy mode). Released via
   *   {@link WorkerLayoutHandle.unpin}. On the gpu backend the physical-view state layout reheats too.
   * - **positions** (or a worker fallback with no live handle): no sim — the held set just translates.
   */
  protected override beginNodeDrag(hit: HoverHit, sx: number, sy: number): NodeDragSession | null {
    const graph = this.graph;
    if (!graph || !this.interactiveOpts?.draggable) return null;
    const held = this.heldLeavesFor(hit);
    if (held.length === 0) return null;
    // A running position transition (#328) would overwrite the held nodes every frame: finish it, so the
    // drag starts from the final layout. One still waiting for its target (a worker nested solve) instead
    // holds the grabbed nodes over its frames once it starts, and keeps them where they are dropped.
    if (this.transition?.running) this.transition.finish();
    const pending = this.transition;

    const pos = graph.positions;
    const start = new Float32Array(held.length * 2); // world positions at grab time
    for (let k = 0; k < held.length; k++) { const id = held[k]!; start[k * 2] = pos[id * 2]!; start[k * 2 + 1] = pos[id * 2 + 1]!; }
    const t0 = this.transform;
    const worldStartX = (sx - t0.x) / t0.k, worldStartY = (sy - t0.y) / t0.k;
    let dx = 0, dy = 0; // world-space cursor delta since grab

    const heldIds = Uint32Array.from(held);
    const heldPos = new Float32Array(held.length * 2); // interleaved held positions, for the worker pin message
    // Hold every grabbed leaf at (start + cursor delta), mirrored into `heldPos` for the worker pin.
    const applyHeld = (): void => {
      for (let k = 0; k < held.length; k++) {
        const id = held[k]!;
        const px = start[k * 2]! + dx, py = start[k * 2 + 1]! + dy;
        pos[id * 2] = px; pos[id * 2 + 1] = py;
        heldPos[k * 2] = px; heldPos[k * 2 + 1] = py;
      }
    };
    const setDelta = (mx: number, my: number): void => {
      const t = this.transform; // read live so a pinch/scroll mid-drag still maps screen → world
      dx = (mx - t.x) / t.k - worldStartX;
      dy = (my - t.y) / t.k - worldStartY;
    };

    // State-network state/both views (#171) render a DERIVED rosette, not a live sim over this.graph,
    // so a drag there TRANSLATES the grabbed node rather than reheating a fresh sim that would fight
    // the derived placement. The PHYSICAL view, however, IS the live physical layout (this.graph ===
    // sg.physical, laid out by layoutHandle) — so it reheats like a normal network (#183): the pinned
    // physical node holds while the rest reflows, and scheduleLayoutRepaint re-derives the rosette
    // (state/both) around it. State-view reheat over the deterministic rosette is out of scope (#189).
    const backend = this.stateData && this.activeView !== "physical" ? "positions" : this.layoutOpts.backend;
    const handle = this.layoutHandle;

    // force: own rAF loop ticks the pinned sim + repaints, so neighbours follow; re-cools on release.
    if (backend === "force") {
      this.nestedDiscs = null; // the reheat re-lays every node out: a nested layout's discs no longer hold (#329)
      const sim = new ForceLayout(graph, this.layoutOpts.force);
      sim.setPinned(held);
      sim.hold(DRAG_HEAT); // reflow at the drag heat the worker / gpu backends use
      const rafFn: (cb: FrameRequestCallback) => number =
        typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 16);
      let raf = 0;
      let cool = -1; // -1 while held; ≥0 counts down the re-cool tail after release
      const frame = (): void => {
        raf = 0;
        if (!this.graph || !this.backend()) return; // engine destroyed / backend gone — stop the loop
        if (cool < 0) applyHeld(); // hold under the cursor; once released, let the held set settle freely
        sim.tick();
        this.repaintDuringDrag();
        if (cool >= 0 && (--cool < 0 || sim.converged)) return; // re-cooled (or tail spent) — stop the loop
        raf = rafFn(frame);
      };
      raf = rafFn(frame);
      return {
        move: setDelta,
        end: () => { sim.setPinned(null); cool = Network.DRAG_COOL_FRAMES; sim.cool(cool, DRAG_HEAT); if (!raf) raf = rafFn(frame); },
      };
    }

    // worker / gpu: the layout backend reflows the rest (worker off-thread, gpu on the GPU) while the
    // main thread holds the grabbed set crisply. Both expose the same pin/unpin handle (#140, #183).
    if ((backend === "worker" || backend === "gpu") && handle) {
      applyHeld();
      handle.pin(heldIds, heldPos);
      this.dragReapply = applyHeld;
      this.repaintDuringDrag(heldIds); // only the held set moved; streamed frames repaint in full (#211)
      return {
        move: (mx, my) => { setDelta(mx, my); applyHeld(); handle.pin(heldIds, heldPos); this.repaintDuringDrag(heldIds); },
        end: () => { handle.unpin(); this.dragReapply = null; if (pending === this.transition) pending?.keep(heldIds); this.settleLODPositions(); },
      };
    }

    // positions / no live worker: translate the held set under the cursor, no reheat.
    return {
      move: (mx, my) => { setDelta(mx, my); applyHeld(); this.repaintDuringDrag(heldIds); },
      end: () => this.settleLODPositions(),
    };
  }

  /** The leaf node ids a grabbed hit drags (#140): the whole selection if the grab is part of it,
   *  else the grabbed glyph's own leaves (an aggregate → its subtree; an unselected grab also becomes
   *  the single selection, so a subsequent drag of it moves it alone). */
  private heldLeavesFor(hit: HoverHit): number[] {
    const id = hit.id as number;
    const selected = this.selectedIds(this.NODE_LAYER);
    if (selected?.has(id)) {
      const leaves = new Set<number>(); // union of every selected entry's leaves
      for (const h of this.selection()) if (h.layer === this.NODE_LAYER) for (const m of h.members?.() ?? [h.id]) leaves.add(m as number);
      return [...leaves];
    }
    if (this.interactiveOpts?.selectable) this.select(this.NODE_LAYER, [id]); // unselected grab → single selection
    return (hit.members?.() ?? [id]) as number[];
  }

  /**
   * Update the LOD geometry from the moved positions and re-emit + repaint. The per-frame paint
   * shared by every drag backend (#140); a drag move is a continuous pointer interaction, so this
   * must never run O(tree size) work (#211):
   *
   * - **Worker-streamed tree**: skipped entirely — the worker owns the geometry.
   * - **`held` given** (positions / worker / gpu drag moves — only the held leaves moved since the
   *   last pass): incremental {@link updateLODPositionsForLeaves} along the held leaves' ancestor
   *   chains, O(held · depth). Extents widen conservatively; {@link settleLODPositions} makes them
   *   exact on release.
   * - **No `held`** (the `force` drag's rAF tick moved *every* free node): one full
   *   {@link computeLODPositions} pass — O(tree size), matching the tick's own O(nodes + edges).
   *
   * Style-derived geometry (`radius`/`weight`/`border`/`color`) is position-independent, so no
   * drag frame recomputes it (the old full `recomputeLODGeometry` re-ran it — with its O(tree)
   * HCL colour aggregation — on every move). The tree-build fallback stays for a drag that starts
   * before any geometry pass ran.
   */
  private repaintDuringDrag(held?: Uint32Array): void {
    const graph = this.graph;
    if (!this.drawsWorkerTree() && graph) {
      const tree = this.lodReady() ? this.lodTree : null;
      if (!tree) this.recomputeLODGeometry(); // no tree/geometry yet — build once (no-op when LOD is off)
      else if (held) updateLODPositionsForLeaves(tree, graph.positions, held, this.treeParent(tree));
      else computeLODPositions(tree, graph.positions, this.lodDiscs(tree));
    }
    this.rebuild();
  }

  /** One exact position-geometry pass when a drag releases (#211), replacing the drag's grow-only
   *  conservative extents with exact ones (a full {@link computeLODPositions} — O(tree size), once
   *  per release, click-frequency), and when a stopped transition drops the nested discs (#329).
   *  Skipped on a worker-streamed tree (the worker owns it — its next frame is exact) and when LOD has
   *  no main-thread geometry. */
  private settleLODPositions(): void {
    if (this.drawsWorkerTree() || !this.lodReady() || !this.lodTree || !this.graph) return;
    computeLODPositions(this.lodTree, this.graph.positions, this.lodDiscs(this.lodTree));
    this.rebuild();
  }

  /** The nested layout's discs when they laid out `tree` (#329): its position passes place the modules on them. */
  private lodDiscs(tree: LODTree): BoundaryDiscs | undefined {
    return this.nestedDiscs?.tree === tree ? this.nestedDiscs.discs : undefined;
  }

  /** Whether the LOD cut can run (enabled, tree built, geometry computed at least once). */
  private lodReady(): boolean {
    return !!(this.lodOptions && this.lodHasGeometry && this.lodTree);
  }

  /**
   * Cut the LOD frontier at the live transform, then declutter it. The single per-frame visible-set
   * computation shared by the WebGL instanced lane (the {@link InstancedLane}'s select; see
   * {@link syncLane}) and the vector retained-Scene path ({@link registerLODScene}, #138) — so the
   * two backends draw the byte-identical aggregate map and can't drift. Cost ∝ the visible frontier,
   * not the graph size.
   */
  private computeFrontier(tree: LODTree, style: ResolvedNetworkStyle): Uint32Array {
    const opts = this.lodOptions!;
    // Cross-fade (#133): when a band is set, give the cut a reusable scratch (indexed by tree-node id) to
    // write per-node alpha into. The cut only writes frontier nodes; downstream readers only read those,
    // so no per-frame reset is needed. Off ⇒ null, and the cut takes its zero-cost hard-threshold path.
    const fadeBand = opts.crossFade && opts.crossFade > 0 ? opts.crossFade : 0;
    if (fadeBand > 0) {
      if (!this.fadeScratch || this.fadeScratch.length < tree.size) this.fadeScratch = new Float32Array(tree.size);
      this.fadeAlpha = this.fadeScratch;
    } else {
      this.fadeAlpha = null;
    }
    // Module boundaries (#329): the cut also collects the expanded modules in view. After a nested layout
    // their geometry is their discs already ({@link lodDiscs}); the rings are drawn at the discs' radii.
    const bnd = this.cutBoundaries;
    bnd.count = 0;
    bnd.radius = this.lodDiscs(tree)?.r;
    let frontier = cut(tree, this.transform, this.width, this.height, {
      expandPx: opts.expandPx,
      screenSized: style.sizeMode === "screen",
      maxAggregateRadius: opts.maxAggregateRadius,
      fadeBand,
      fadeAlpha: this.fadeAlpha ?? undefined,
      boundaries: opts.moduleBoundary ? bnd : undefined,
    }, this.cutScratch); // #213: reused per frame — the walk allocates nothing steady-state
    if (opts.declutter !== false) {
      frontier = declutterFrontier(tree, frontier, this.transform, this.width, this.height, {
        screenSized: style.sizeMode === "screen",
        k: this.transform.k,
        maxAggregateRadius: opts.maxAggregateRadius,
        spacing: opts.declutterSpacing,
        // Cross-fade (#133): transitioning glyphs are exempt, so a fading parent never culls its fading-in children.
        fadeAlpha: this.fadeAlpha ?? undefined,
      }, this.declutterFrontierScratch); // #213: reused per frame, distinct from the cut's buffers
    }
    return frontier;
  }

  /** The resolved module-boundary ring style (#329) at the live zoom, or null when `moduleBoundary` is off. */
  private boundaryStyle(style: ResolvedNetworkStyle): ModuleBoundaryResolved | null {
    const mb = this.lodOptions?.moduleBoundary;
    if (!mb) return null;
    return {
      width: mb.width ?? 1,
      color: mb.color ?? "#3a3f52",
      opacity: mb.opacity ?? 0.5,
      screen: style.sizeMode === "screen",
      k: this.transform.k,
    };
  }

  /** The expanded modules module links anchor at (#329) — the cut's collection when both
   *  `moduleBoundary` and `crossLevelEdges` are on (superEdges ignores it without module links). */
  private anchorBoundaries(): CutBoundaries | undefined {
    const opts = this.lodOptions;
    return opts?.moduleBoundary && opts.crossLevelEdges ? this.cutBoundaries : undefined;
  }

  /**
   * Build the instanced layers for a given LOD frontier (the index-compacted visible set). The emit
   * body the {@link InstancedLane} (see {@link syncLane}) feeds the cut's visible set into, shared
   * with the vector retained-Scene path ({@link registerLODScene}). Cost ∝ the visible frontier, not
   * the graph size.
   */
  private frontierLayers(tree: LODTree, style: ResolvedNetworkStyle, frontier: Uint32Array): InstancedLayer[] {
    const opts = this.lodOptions!;
    const layers: InstancedLayer[] = [];
    this.linkResolve = null; // no super-edges drawn this emit ⇒ nothing to link-pick (until set below)
    // Module-boundary rings (#329) first, under everything: one per expanded module the cut collected.
    // World-sized circles (the boundary is a world region); a screen-mode ring width is px at this zoom.
    const boundaryStyle = this.boundaryStyle(style);
    if (boundaryStyle) {
      const rings = boundaryRings(tree, this.cutBoundaries, boundaryStyle, visibleWorldRect(this.transform, this.width, this.height));
      if (rings.count > 0) layers.push({ name: "module-boundaries", primitive: "circles", circles: rings, sizeMode: "world" });
    }
    // Selection/hover highlight (#162) is applied in the SHADER from per-instance columns (below) + lane
    // uniforms (see onInstancedLaneEmitted) — NO per-instance CPU colour pass here, so a hover/selection
    // restyle never rebuilds this geometry. Bake only the `selected` flag (ancestor-aware, so an expanded
    // selected aggregate's children count) + the group ids the shader matches against the hovered id.
    const sel = this.selectedIds(this.NODE_LAYER);
    const isSel = sel && sel.size ? this.makeSelectedPredicate(tree, sel) : null;
    // Super-edges first (drawn under the nodes), among the visible frontier only. Skipped whole when
    // the style draws no links (#157: linkStyle "none" / a constant linkWidth 0 / an edgeless graph) —
    // the gather, the highlight columns and the GPU upload are all avoided, not hidden.
    const graph = this.graph;
    if (opts.superEdges !== false && graph && drawsLinks(graph, style)) {
      // One super-edge path for both structural and module trees: gathered from the flow-weighted
      // super-edge CSR and rendered per linkStyle — fused half-arrows, or bent/straight lines +
      // (directed) arrowheads, the same glyph the non-LOD path uses. A node keeps edges to on-frontier
      // or off-screen neighbours (the same visible rect the cut uses); both half-arrow and line
      // arrowheads honour sizeMode in-shader (the tip sets back to the node boundary in either space).
      const { halfArrows, lines, arrows, ids, flows } = superEdges(
        tree,
        frontier,
        {
          linkStyle: style.linkStyle,
          directed: style.directed,
          widthOf: style.linkWidthOf,
          colorOf: style.linkColorOf,
          bend: style.linkBend,
          arrowSize: style.arrowSize,
          maxAggregateRadius: opts.maxAggregateRadius,
          crossLevelEdges: opts.crossLevelEdges,
          anchor: this.anchorBoundaries(),
          fadeAlpha: this.fadeAlpha ?? undefined,
        },
        visibleWorldRect(this.transform, this.width, this.height),
        this.superEdgesScratch, // #210: reused per emit — zero O(tree.size) work per zoom frame
      );
      // #162: attach the shader-highlight columns — group = link source id (matched against the hovered
      // id → recolour that node's outgoing links), group2 = target for undirected incident hover, selected
      // = outgoing-from-a-selected-(sub)tree flag. The shader recolours/dims from these; no CPU colour
      // pass. Half-arrows OR lines is present (linkStyle picks one); arrows shares the edge order.
      const lh = this.linkHighlightColumns(ids, tree.size, isSel, style.directed);
      for (const d of [halfArrows, lines, arrows]) {
        if (!d) continue;
        d.groups = lh.groups;
        d.selected = lh.selected;
        if (lh.groups2) d.groups2 = lh.groups2;
      }
      const pick = this.pickLinksEnabled || undefined; // flag link layers into the GPU pick pass (#141)
      if (halfArrows && halfArrows.count > 0) layers.push({ name: "links", primitive: "half-arrows", pickable: pick, halfArrows, sizeMode: style.sizeMode });
      if (lines && lines.count > 0) layers.push({ name: "links", primitive: "lines", pickable: pick, lines, sizeMode: style.sizeMode });
      if (arrows && arrows.count > 0) layers.push({ name: "arrows", primitive: "arrows", pickable: pick, arrows, sizeMode: style.sizeMode });
      // Link picking (#141): instance i (gl_InstanceID) of every emitted link layer is super-edge i, so
      // one resolve maps the decoded id → its directed tree-node pair (ids[i]) + summed flow (flows[i]).
      if (this.pickLinksEnabled) this.linkResolve = (i) => this.lodLinkHit(tree, ids, flows, i);
    }
    // Aggregate-outline affordance: a halo ring behind collapsed-module glyphs (not leaves), under the
    // nodes, so a module reads as expandable. WebGL/LOD-only (the vector full-graph draw has no aggregates).
    const outline = aggregateOutlineOf(opts);
    if (outline) {
      const halos = frontierHalos(tree, frontier, {
        ...outline,
        maxAggregateRadius: opts.maxAggregateRadius,
        fadeAlpha: this.fadeAlpha ?? undefined,
      });
      if (halos.count > 0) layers.push({ name: "node-halos", primitive: "circles", circles: halos, sizeMode: style.sizeMode });
    }
    const circles = frontierCircles(tree, frontier, {
      nodeFill: style.nodeFill,
      aggregateFill: opts.aggregateFill ?? style.nodeFill,
      maxAggregateRadius: opts.maxAggregateRadius,
      border: style.flowBorder,
      constBorder: style.constBorder,
      useTreeColor: !!style.nodeColors, // categorical module colours, propagated to aggregates
      fadeAlpha: this.fadeAlpha ?? undefined,
    });
    // #162: attach the shader-highlight columns for the frontier nodes — group = tree-node id (the hovered
    // id matches its own node); selected = ancestor-aware. The shader dims non-highlighted + keeps
    // selected/hovered from these + the lane uniforms, so a hover/selection never rebuilds these buffers.
    circles.groups = Float32Array.from(frontier);
    if (isSel) {
      const s = new Uint8Array(frontier.length);
      for (let i = 0; i < frontier.length; i++) s[i] = isSel(frontier[i]!) ? 1 : 0;
      circles.selected = s;
    }
    layers.push({ name: "nodes", primitive: "circles", circles, sizeMode: style.sizeMode });
    return layers;
  }

  /**
   * (Re)compute the LOD tree's geometry from the *current* positions + style. No-op when LOD is off.
   *
   * Three modes:
   * - **Worker-streamed tree** (`lodWorkerTree`): the worker owns the position-derived geometry
   *   (`cx`/`cy`/`extent`, written live each frame), so the main thread only (re)derives the
   *   style-derived geometry (`radius`/`weight`) — once on adoption, and again when the radii change.
   *   Never per frame (see {@link scheduleLayoutRepaint}).
   * - **Awaiting a worker tree** (`backend: "worker"`, no tree yet): the worker is about to stream the
   *   tree, so the main thread builds *nothing* — it would only duplicate the worker's O(N)/O(E) work
   *   and be discarded. Pass `forceMain` (from the settle handler) to build anyway when the worker
   *   fell back to a synchronous main-thread solve and never streamed a tree. **Exempt in state-network
   *   mode** (#182): there `layoutOpts.backend` names the *physical* graph's layout transport, but
   *   `this.graph` (whose tree this method builds) is the state/both view's own graph — no worker ever
   *   streams a tree for it, so the skip would otherwise starve state-view LOD of a tree forever.
   * - **Main-thread tree** (`force`/`positions` backends, the worker fallback, or a module hierarchy on
   *   any backend): build the tree lazily (a module tree comes from the per-hierarchy cache, #326), then
   *   the full geometry from the current positions + style; tracks convergence.
   *
   * It also picks the tree for the current source ({@link NetworkLODOptions.source}), so a source switch
   * or LOD toggle lands here. O(tree size); the zoom-time cut does not call this (it reuses the geometry).
   */
  private recomputeLODGeometry(forceMain = false): void {
    if (!this.lodOptions || !this.graph) return;
    const resolved = this.resolvedStyleCached(this.graph);
    const nodeRadii = resolved.nodeRadii;
    const leafBorder = resolved.flowBorder?.metric; // per-leaf flow metric; sum-aggregated onto the tree
    const leafColors = resolved.nodeColors; // per-leaf RGBA; averaged onto aggregates
    // When sizing by an additive metric, aggregates size by the leaf scale on their summed value
    // (flow-sized modules); else null ⇒ the area-additive √Σr² fallback.
    const radiusAggregate = resolved.nodeRadiusAggregate ?? undefined;
    // Declutter importance (per-leaf, summed up the tree): defaults to the size metric — see resolveImportance.
    const leafWeight = resolved.importance;
    // Tree choice — the priority chain (epic #98): a module hierarchy (an explicit `lod({ modules })`,
    // else the engine's unless `source: "structure"`, #326) → structural coarsening → the spatial
    // quadtree fallback. A module tree (N6 / #104) is position-independent, like coarsening, and cached
    // per hierarchy, so a source switch or LOD toggle re-adopts it without a rebuild.
    const moduleTree = this.lodUsesModules() ? this.moduleTree() : undefined;
    if (!moduleTree && this.lodWorkerTree) {
      computeLODStyle(this.lodWorkerTree, nodeRadii, leafWeight, leafBorder, leafColors, radiusAggregate);
      this.lodTree = this.lodWorkerTree;
      this.lodModules = false;
      this.lodSpatial = false;
      this.lodHasGeometry = true;
      return;
    }
    // A module tree retained from before a switch to the structural source is the wrong tree.
    if (!moduleTree && this.lodModules) {
      this.lodTree = null;
      this.lodModules = false;
      this.lodHasGeometry = false;
    }
    // The worker streams a *coarsening* tree on this backend; don't build one on the main thread (the
    // whole point of worker-LOD). A module hierarchy is the exception — the worker doesn't build it, so
    // the main thread must (it takes the module branch below), and so is a nested layout's run, which
    // streams positions only (#324). The settle handler / deferred fallback force a build when no worker
    // streamed one.
    if (!moduleTree && !this.stateData && this.layoutOpts.backend === "worker" && !forceMain && !this.nestedSolving) return;
    if (moduleTree) {
      // Carries flow-weighted super-edges from the graph's directed edges (the sum of subsumed edge
      // weights per module pair, #104 N6c) plus any module links (#199), for the half-arrow map links.
      if (this.lodTree !== moduleTree) {
        this.lodTree = moduleTree;
        this.lodModules = true;
        this.lodSpatial = false;
      }
    } else if (!this.lodTree) {
      if (this.graph.edgeCount === 0) {
        // Edge-less graphs can't be coarsened (heavy-edge matching needs edges) — build the LOD tree
        // spatially over the positions instead (#103), so the cut still aggregates + prunes in O(visible)
        // rather than degenerating to a single flat level. (Its topology depends on the positions, so
        // it's rebuilt when those change — see the positions backend below + data().)
        this.lodTree = buildSpatialLODTree(this.graph.positions, this.graph.nodeCount, this.lodOptions.spatial);
        this.lodSpatial = true;
        this.lodModules = false;
      } else {
        this.lodTree = buildLODTree(this.graph, this.lodOptions.coarsen);
        this.lodSpatial = false;
        this.lodModules = false;
      }
    }
    computeLODGeometry(this.lodTree, this.graph, nodeRadii, leafWeight, leafBorder, leafColors, radiusAggregate, this.lodDiscs(this.lodTree));
    this.lodHasGeometry = true;
  }

  /**
   * Defer one main-thread LOD-tree build by a microtask. Scheduled when LOD is on, the backend is
   * `worker`, and no tree exists yet — but only fires if, after the current synchronous call chain,
   * no worker run has taken over the streaming path (i.e. LOD was toggled on after a run settled).
   * The microtask delay lets an imminent `layout({ backend: "worker" })` in the same chain win first,
   * so the common path never builds a tree the worker would replace.
   */
  private scheduleLODFallback(): void {
    if (this.lodFallbackScheduled) return;
    this.lodFallbackScheduled = true;
    const defer: (cb: () => void) => void =
      typeof queueMicrotask === "function" ? queueMicrotask : (cb) => void Promise.resolve().then(cb);
    defer(() => {
      this.lodFallbackScheduled = false;
      // A worker is now streaming, LOD was turned off, the graph/backend changed, or a tree already
      // landed — nothing to do; the normal path renders it.
      if (!this.lodOptions || this.lodStreaming || this.lodReady() || this.layoutOpts.backend !== "worker") return;
      this.recomputeLODGeometry(true); // no live worker: build the tree on the main thread
      this.rebuild();
    });
  }

  /**
   * Re-bake the SVG/Canvas **screen-sizeMode half-arrow** geometry to the *current* zoom, so a vector
   * backend reproduces the WebGL screen look at any zoom (the retained Scene can't recompute a
   * screen-space shape per frame, so it's baked into world coords at the active transform; see
   * {@link registerNetworkScene}). **No-op on WebGL** (the shader does it live) and when not drawing
   * screen-mode half-arrows. Called automatically on backend switch and at interaction-end; call it
   * explicitly for a "refit" button or before a programmatic export at a chosen transform.
   */
  syncScreenGeometry(): this {
    const backend = this.backend();
    // Only the retained (vector) backends need re-baking; the WebGL instanced lane is live.
    if (backend && !backend.setInstancedLayer && this.sceneActive) this.rebuild();
    return this;
  }

  /** Re-bake the vector-backend screen-mode geometry when a pan/zoom gesture ends (cheap, O(edges)).
   *  A gesture START also takes over a streaming fit-on-layout (stop auto-framing so it doesn't fight
   *  the pan/zoom; the gesture is already seeded to the framed view — each fit frame calls syncZoomToView). */
  protected override setInteracting(v: boolean): void {
    const ending = this.interacting && !v;
    if (v) this.fitOnLayout = false;
    super.setInteracting(v);
    if (ending) this.syncScreenGeometry();
  }

  /**
   * Register the network as retained Scene layers (links under arrows under nodes) via the
   * PathContext glyph emitters. With `emit: false` the layers are registered empty — used to
   * clear tessellated geometry when switching to the WebGL instanced lane.
   */
  private registerNetworkScene(graph: NetworkGraph, style: ResolvedNetworkStyle, emit: boolean): void {
    // LOD on a vector backend (#138): draw the cut frontier as retained Scene layers instead of the full
    // graph, so Canvas/SVG show the same aggregate map as the WebGL lane and toSVG() exports an LOD
    // network. Same branch for emit:false (clears the frontier on a backend switch / LOD toggle).
    if (this.lodReady()) {
      this.registerLODScene(this.lodTree!, style, emit);
      return;
    }
    // With no links to draw (#157: linkStyle "none", a constant linkWidth 0, or an edgeless graph) the
    // links/arrows slots register EMPTY — no per-edge id array, no id→index map, no tessellation — while
    // still existing in canonical order so switching back to `"line"` re-fills the same slots.
    const drawLinks = drawsLinks(graph, style);
    const edgeIds = drawLinks ? Array.from({ length: graph.edgeCount }, (_, e) => e) : [];
    const nodeIds = Array.from({ length: graph.nodeCount }, (_, i) => i);
    // `both`-view physical container backdrop (#171): faint discs at the physical nodes, drawn FIRST so
    // the state nodes/links (registered below) sit on top. Always registered (empty off the `both` view)
    // so a view switch clears it. Keyed by physical id → faint dominant-module colour.
    const containers = this.activeView === "both" && this.stateData && this.containerRadii ? this.stateData : null;
    const containerIds = containers ? Array.from({ length: containers.physicalCount }, (_, p) => p) : [];
    this.registerLayer({
      name: this.CONTAINER_LAYER,
      data: containerIds,
      ids: containerIds,
      sizeMode: "world",
      fill: (p) => withAlpha(this.physicalColors?.[p as number] ?? DEFAULT_NODE_FILL, 42),
      stroke: () => "#000000", // thin black ring so the faint container disc reads (#171 review)
      build: (g) => {
        if (emit && containers)
          for (let p = 0; p < containers.physicalCount; p++) {
            const cx = containers.physical.positions[2 * p]!, cy = containers.physical.positions[2 * p + 1]!, r = this.containerRadii![p]!;
            g.drawable(p, (ctx) => { ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); }, { lineWidth: 1.5 });
          }
      },
    });
    // Module-boundary rings (#329): only the LOD Scene path draws into it; registered empty here so the
    // slot exists in canonical order (under the links) whichever path registers first.
    this.registerLayer({ name: "module-boundaries", data: [], ids: [], sizeMode: "world", build: () => {} });
    // Per-edge link colour (encodes weight/flow); the arrowhead shares it.
    const linkColorAt = (e: number): string => style.linkStrokeOf(graph.weight[e]!);
    // The map glyph (`half-arrow`, directed) is one *filled* shape per link — the head is part of it,
    // so the "links" layer fills and the "arrows" layer stays empty. Plain `line` style strokes + a
    // separate filled arrowhead, as before.
    const halfArrow = style.linkStyle === "half-arrow" && style.directed;
    // SVG/Canvas half-arrows are always world-sized: a screen-mode shape that spans two
    // independently-projected node anchors can't be expressed by the retained Scene's per-drawable
    // anchor (only the WebGL lane recomputes it per frame). To still match the WebGL *screen* look for
    // export, we BAKE the shape at the current zoom: emitHalfLinks solves it in pixel space (positions ×
    // k, px sizes) and scales the result by 1/k, so the Scene's ×k view transform reproduces the exact
    // constant-px render — including the non-linear tip/bend terms a naive per-size ÷k would distort
    // (the gap would grow with zoom). Refreshed on backend switch (here), at interaction-end
    // (setInteracting) and on demand (syncScreenGeometry).
    const bake = halfArrow && style.sizeMode === "screen" ? this.transform.k || 1 : 1;
    // The plain line-style arrowhead bakes the same way (its tip + node-boundary setback are px in
    // screen mode); baked geometry is world-coord, so the layer renders "world" and re-bakes on zoom-end.
    const arrowBake = !halfArrow && style.directed && style.sizeMode === "screen" ? this.transform.k || 1 : 1;
    this.registerLayer({
      name: "links",
      data: edgeIds,
      ids: edgeIds,
      sizeMode: halfArrow ? "world" : style.sizeMode,
      ...(halfArrow ? { fill: (e) => linkColorAt(e as number) } : { stroke: (e) => linkColorAt(e as number) }),
      build: (g) => {
        if (!emit || !drawLinks) return;
        if (halfArrow) emitHalfLinks(g, graph, style.nodeRadii, style.linkWidthOf, style.linkBend, bake);
        else emitLinks(g, graph, style.linkWidthOf, style.linkBend);
      },
    });
    this.registerLayer({
      name: "arrows",
      data: edgeIds,
      ids: edgeIds,
      // Baked screen-mode arrows live in world coords (like the half-arrow); world mode passes through.
      sizeMode: arrowBake !== 1 ? "world" : style.sizeMode,
      fill: (e) => linkColorAt(e as number),
      build: (g) => {
        if (emit && drawLinks && style.directed && !halfArrow) emitArrows(g, graph, style.arrowSize, style.nodeRadii, style.linkBend, style.linkBend !== 0, arrowBake);
      },
    });
    // Aggregate-outline halo ring: only the LOD Scene path ({@link registerLODScene}) draws into it,
    // but it's registered empty here too so the layer slot exists in canonical order (links < arrows <
    // node-halos < nodes) — so a backend switch / LOD toggle re-registers into the same
    // slot and the ring never lingers above the nodes nor draws on a full-graph view.
    this.registerLayer({ name: "node-halos", data: [], ids: [], sizeMode: style.sizeMode, build: () => {} });
    // Per-node fill: a single colour, or the per-node accessor (categorical module colours, #104 rework).
    const fillSpec = this.styleOpts.nodeFill;
    const fillOf = typeof fillSpec === "function" ? (i: number) => fillSpec(i, graph) : () => style.nodeFill;

    // Border (#104 N6/rework, #269): the instanced lane draws the ring in-shader; the Scene path draws
    // the SAME ring encoding — one circle per node, filled with the node colour and stroked
    // `radius − inner` wide on the ring centreline. Handles both the flow border (per-node width) and
    // the constant border (fixed px); with no border `innerRadii === style.nodeRadii`, so the stroke
    // width is 0 and the glyph is a plain filled disc — no separate layer to toggle or clear.
    const flow = style.flowBorder;
    const cb = style.constBorder;
    const borderColorCss = flow
      ? flow.colorCss
      : cb
        ? `rgba(${cb.color[0]},${cb.color[1]},${cb.color[2]},${cb.color[3] / 255})`
        : style.nodeFill;
    // Per-node ring colour: a darker shade of each node's own fill (no explicit colour given), an
    // accessor's per-node colours (ring ∝ a metric), else the single representative colour.
    const flowColors = flow?.colors;
    const darken = flow?.darken;
    const borderColorAt =
      darken !== undefined
        ? (i: number) => {
            const c = rgb(fillOf(i));
            return `rgb(${Math.round(c.r * darken)},${Math.round(c.g * darken)},${Math.round(c.b * darken)})`;
          }
        : flowColors
          ? (i: number) => `rgba(${flowColors[i * 4]},${flowColors[i * 4 + 1]},${flowColors[i * 4 + 2]},${flowColors[i * 4 + 3]! / 255})`
          : () => borderColorCss;
    const innerRadii = flow
      ? flowBorderInnerRadii(style.nodeRadii, flow.metric, flow.scale)
      : cb
        ? Float32Array.from(style.nodeRadii, (r) => Math.max(0, r - Math.min(r, cb.width)))
        : style.nodeRadii;
    this.registerLayer({
      name: "nodes",
      data: nodeIds,
      ids: nodeIds,
      sizeMode: style.sizeMode,
      fill: (i) => fillOf(i as number),
      stroke: (i) => borderColorAt(i as number),
      build: (g) => {
        if (emit) emitNodes(g, graph, style.nodeRadii, innerRadii);
      },
    });
    // Physical view of a state network (#171): overlapping-module physical nodes as filled arc-wedge pies,
    // drawn (and exported by toSVG) on top of the node discs. Keyed by flat wedge index → wedges.color.
    // Always registered (empty in the state view / when no pie wedges) so a view switch clears it.
    const wedges = this.activeView === "physical" ? this.pieWedges : null;
    const pieIds: number[] = [];
    if (wedges) {
      for (let p = 0; p < wedges.wedgeCount.length; p++) {
        if (wedges.wedgeCount[p]! >= 2) for (let k = wedges.offset[p]!; k < wedges.offset[p + 1]!; k++) pieIds.push(k);
      }
    }
    this.registerLayer({
      name: this.PIE_LAYER,
      data: pieIds,
      ids: pieIds,
      sizeMode: style.sizeMode,
      fill: (k) => (wedges ? wedges.color[k as number]! : DEFAULT_NODE_FILL),
      build: (g) => {
        // Trace at the INNER radius (inside the border), so each node's black border ring shows around
        // the pie exactly as around a single-module disc (matches the WebGL pie lane).
        if (emit && wedges) tracePieWedges(g, wedges, graph.positions, innerRadii, style.sizeMode === "screen");
      },
    });
  }

  /**
   * Register the LOD cut frontier as retained Scene layers (#138) — the vector-backend twin of the
   * WebGL {@link frontierLayers} emit. Computes the same {@link computeFrontier} and traces the *same* SoA
   * ({@link superEdges}/{@link frontierHalos}/{@link frontierCircles}/{@link boundaryRings}) into Scene
   * drawables, keyed by **stable tree-node id** (frontier node, module, or directed super-edge pair) so the
   * retained-scene diff is stable across re-cuts. Layers are registered in canonical draw order
   * (module-boundaries < links < arrows < node-halos < nodes), each into the same slot the full-graph path uses, so toggling LOD or swapping
   * backends never reorders or leaves stale geometry. With `emit: false` every layer registers empty (the
   * frontier clear). Re-run at each interaction-end via {@link syncScreenGeometry} — the retained Scene
   * can't re-tessellate per frame, so the frontier is static during a gesture and snaps on release (the
   * agreed redraw-on-zoom-end model).
   */
  private registerLODScene(tree: LODTree, style: ResolvedNetworkStyle, emit: boolean): void {
    const opts = this.lodOptions!;
    const screen = style.sizeMode === "screen";
    const frontier = emit ? this.computeFrontier(tree, style) : new Uint32Array(0);

    // --- Module-boundary rings (#329), under everything: the same ring-encoded world circles as the
    // WebGL lane (a screen-mode width baked at this zoom, re-baked at interaction end). ---
    const boundaryStyle = emit ? this.boundaryStyle(style) : null;
    const rings = boundaryStyle ? boundaryRings(tree, this.cutBoundaries, boundaryStyle, visibleWorldRect(this.transform, this.width, this.height)) : null;
    const ringIds = rings ? Array.from(rings.ids) : [];
    this.registerLayer({
      name: "module-boundaries",
      data: ringIds,
      ids: ringIds,
      sizeMode: "world",
      // Decorative, like its WebGL twin (an instanced circles layer no pick resolves): a ring's hit disc
      // would cover the module's whole interior and shadow the background there on Canvas/SVG only.
      pickable: false,
      fill: () => "rgba(0, 0, 0, 0)",
      stroke: (_d, i) => (rings ? rgbaCss(rings.borderColors, i) : ""),
      build: (g) => {
        if (rings) traceBoundaryRings(g, rings);
      },
    });

    // --- Super-edges (drawn under the nodes), among the visible frontier only. ---
    // Same skip as the WebGL frontier emit (#157): with no links to draw the gather never runs and both
    // layers register empty (so a style change back to `"line"` re-fills the same slots).
    const graph = this.graph;
    const se =
      emit && opts.superEdges !== false && graph && drawsLinks(graph, style)
        ? superEdges(
            tree,
            frontier,
            {
              linkStyle: style.linkStyle,
              directed: style.directed,
              widthOf: style.linkWidthOf,
              colorOf: style.linkColorOf,
              bend: style.linkBend,
              arrowSize: style.arrowSize,
              maxAggregateRadius: opts.maxAggregateRadius,
              crossLevelEdges: opts.crossLevelEdges,
              anchor: this.anchorBoundaries(),
              fadeAlpha: this.fadeAlpha ?? undefined,
            },
            visibleWorldRect(this.transform, this.width, this.height),
            this.superEdgesScratch, // #210: shared with the lane emit — they never run concurrently
          )
        : { ids: [] as number[] };
    // Screen-mode super-edge shapes BAKE at the current zoom (constant-px tip/setback/bend terms), the
    // same trick the full-graph path uses; lines need no bake (world endpoints + per-line px width).
    const seBake = screen ? this.transform.k || 1 : 1;
    const isHalf = !!se.halfArrows;
    this.registerLayer({
      name: "links",
      data: se.ids,
      ids: se.ids,
      // A half-arrow is one filled shape (baked to world in screen mode); a line keeps the sizeMode.
      sizeMode: isHalf ? "world" : style.sizeMode,
      ...(isHalf
        ? { fill: (_d, i) => (se.halfArrows ? rgbaCss(se.halfArrows.colors, i) : "") }
        : { stroke: (_d, i) => (se.lines ? rgbaCss(se.lines.colors, i) : "") }),
      build: (g) => {
        if (se.halfArrows) traceSuperHalfArrows(g, se.halfArrows, se.ids, seBake);
        else if (se.lines) traceSuperLines(g, se.lines, se.ids);
      },
    });
    // Line-style directed arrowheads (the half-arrow's head is fused into its own filled shape, so this
    // layer is empty for half-arrows). Baked screen-mode heads live in world coords, like the line.
    const arrowBake = !isHalf && style.directed && screen ? this.transform.k || 1 : 1;
    this.registerLayer({
      name: "arrows",
      data: se.ids,
      ids: se.ids,
      sizeMode: arrowBake !== 1 ? "world" : style.sizeMode,
      fill: (_d, i) => (se.arrows ? rgbaCss(se.arrows.colors, i) : ""),
      build: (g) => {
        if (se.arrows) traceSuperArrows(g, se.arrows, se.ids, arrowBake);
      },
    });

    // --- Aggregate-outline halo rings, behind collapsed-module glyphs only (under the nodes). ---
    const outline = emit ? aggregateOutlineOf(opts) : null;
    const halos = outline
      ? frontierHalos(tree, frontier, {
          ...outline,
          maxAggregateRadius: opts.maxAggregateRadius,
          fadeAlpha: this.fadeAlpha ?? undefined,
        })
      : null;
    const haloIds = halos ? Array.from(halos.ids) : [];
    this.registerLayer({
      name: "node-halos",
      data: haloIds,
      ids: haloIds,
      sizeMode: style.sizeMode,
      // Decoration, like its WebGL twin: an instanced circles layer no pick resolves.
      pickable: false,
      fill: () => "rgba(0, 0, 0, 0)",
      stroke: (_d, i) => (halos?.borderColors ? rgbaCss(halos.borderColors, i) : ""),
      build: (g) => {
        if (halos) traceFrontierHalos(g, halos);
      },
    });

    // --- Frontier glyphs: one ring-encoded circle each (fill disc + the border as its stroke, #269). ---
    const circles = emit
      ? frontierCircles(tree, frontier, {
          nodeFill: style.nodeFill,
          aggregateFill: opts.aggregateFill ?? style.nodeFill,
          maxAggregateRadius: opts.maxAggregateRadius,
          border: style.flowBorder,
          constBorder: style.constBorder,
          useTreeColor: !!style.nodeColors, // categorical module colours, propagated to aggregates
          fadeAlpha: this.fadeAlpha ?? undefined,
        })
      : null;
    const circleIds = circles ? Array.from(frontier) : [];
    this.registerLayer({
      name: "nodes",
      data: circleIds,
      ids: circleIds,
      sizeMode: style.sizeMode,
      fill: (_d, i) => (circles ? rgbaCss(circles.colors, i) : ""),
      stroke: (_d, i) => (circles?.borderColors ? rgbaCss(circles.borderColors, i) : ""),
      build: (g) => {
        if (circles) traceFrontierGlyphs(g, circles, frontier);
      },
    });
  }

  /** Resolved style, memoised until style()/data() invalidates it (radii resolution is O(n)). */
  private resolvedStyleCached(graph: NetworkGraph): ResolvedNetworkStyle {
    return (this.resolvedCache ??= this.resolvedStyle(graph));
  }

  /** Apply style defaults (drawn order is decided by {@link networkLayers}). */
  private resolvedStyle(graph: NetworkGraph): ResolvedNetworkStyle {
    // linkWidth: a constant, a (weight)=>width scale, or {by,scale}. `linkWidthOf` is the per-edge
    // function; `linkWidth` is a representative scalar (the weight-1 width), used only for the
    // arrow-size default below.
    const lwSpec = this.styleOpts.linkWidth ?? DEFAULT_LINK_WIDTH;
    const linkWidthOf = resolveLinkWidthOf(lwSpec);
    const linkWidth = typeof lwSpec === "number" ? lwSpec : linkWidthOf(1) || DEFAULT_LINK_WIDTH;
    // linkStroke: a single colour, or a (weight)=>colour scale. `linkColorOf` packs RGBA bytes for
    // the WebGL lane; `linkStrokeOf` gives the CSS for the Scene path; `linkStroke` is representative.
    const lsSpec: LinkColorSpec = this.styleOpts.linkStroke ?? DEFAULT_LINK_STROKE;
    const linkColorOf = resolveLinkColorOf(lsSpec);
    const linkStrokeOf = resolveLinkStrokeOf(lsSpec);
    const linkStroke = typeof lsSpec === "string" ? lsSpec : linkStrokeOf(1);
    // nodeFill: a single colour, or a per-node accessor → packed RGBA (categorical module colours).
    const fillSpec = this.styleOpts.nodeFill;
    const nodeFill = typeof fillSpec === "function" ? DEFAULT_NODE_FILL : (fillSpec ?? DEFAULT_NODE_FILL);
    const nodeColors = typeof fillSpec === "function" ? resolveNodeColors(graph, fillSpec) : undefined;
    // Constant border (px). flowBorder wins if both are set.
    const nb = this.styleOpts.nodeBorder;
    const constBorder: ConstBorder | null =
      nb && !this.styleOpts.flowBorder ? { width: nb.width, color: rgbaBytes(nb.color ?? "#ffffff") } : null;
    const nodeRadiusSpec = this.styleOpts.nodeRadius ?? DEFAULT_NODE_RADIUS;
    return {
      nodeRadii: resolveNodeRadii(graph, nodeRadiusSpec),
      nodeRadiusAggregate: resolveNodeRadiusAggregate(graph, nodeRadiusSpec),
      importance: resolveImportance(graph, this.styleOpts.importance, nodeRadiusSpec),
      nodeFill,
      nodeColors,
      linkWidth,
      linkWidthOf,
      linkStroke,
      linkColorOf,
      linkStrokeOf,
      linkStyle: this.styleOpts.linkStyle ?? "line",
      // Default arrow size derived from link width like the half-arrow tip (10·width^⅓): the triangle
      // is 2·size long, so size = 5·width^⅓ gives a head comparable to the half-arrow's and stays
      // visible for thin links (sublinear) without ballooning for thick ones.
      arrowSize: this.styleOpts.arrowSize ?? 5 * Math.cbrt(linkWidth),
      directed: this.styleOpts.directed ?? graph.directed,
      sizeMode: this.styleOpts.sizeMode ?? "world",
      flowBorder: this.styleOpts.flowBorder ? resolveFlowBorder(graph, this.styleOpts.flowBorder, nodeFill) : null,
      constBorder,
      linkBend: this.styleOpts.linkBend ?? 0,
    };
  }

  /** Re-push instanced layers after a backend swap (the first install doesn't fire this). */
  protected onBackendSwapped(): void {
    this.rebuild();
  }
}

/** Create a {@link Network} engine on `host`. */
export function network(host: HTMLElement, opts: NetworkOptions = {}): Network {
  return new Network(host, opts);
}
