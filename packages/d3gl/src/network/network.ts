import { BaseEngine, type BaseEngineOptions, type HoverHit, type InteractiveLayerOptions, type LaneInteractive } from "../map/base-engine.js";
import { networkLayers, frontierCircles, frontierHalos, superEdges, emitNodes, emitLinks, emitArrows, emitHalfLinks, traceFrontierFills, traceFrontierBorders, traceFrontierHalos, traceSuperHalfArrows, traceSuperLines, traceSuperArrows, rgbaCss, pickNodes, regionNodes, resolveNodeRadii, resolveNodeRadiusAggregate, resolveImportance, resolveFlowBorder, resolveNodeColors, resolveLinkWidthOf, resolveLinkColorOf, resolveLinkStrokeOf, flowBorderInnerRadii, type ResolvedNetworkStyle, type NodeRadiusSpec, type ImportanceSpec, type FlowBorderSpec, type ConstBorder, type LinkWidthSpec, type LinkColorSpec, type LinkStyle } from "./glyphs.js";
import { rgb } from "d3-color";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { buildLODTree, buildSpatialLODTree, computeLODGeometry, computeLODStyle, cut, declutterFrontier, pickFrontier, regionFrontier, visibleWorldRect, leavesUnder, type LODTree, type SpatialLODOptions } from "./lod.js";
import { LabelLayer, placeLabels, type LabelAnchor } from "../labels/label-layer.js";
import { buildModuleLODTree, type ModuleNode } from "./modules.js";
import { startWorkerLayout, type WorkerLayoutHandle } from "./worker-transport.js";
import type { NetworkGraph } from "./graph.js";
import type { InstancedLayer } from "../core/index.js";
import { InstancedLane, type SelectionStrategy } from "../core/instanced-lane.js";
import { resolveRingColors, ringCircles } from "../map/highlight-ring.js";

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
  /** Class set on each label element — styles the **HTML overlay** (WebGL backend) via CSS (font,
   *  colour, text-shadow halo). Backend-native text (SVG/Canvas) can't use CSS; style it with the
   *  {@link font}/{@link color}/{@link halo} options below (set both to match across backends). */
  className?: string;
  /** Constant screen-px offset `[dx, dy]` from the glyph centroid (labels are centred on it by default). */
  offset?: [number, number];
  /** Font for **backend-native** text (SVG `<text>` / Canvas `fillText`, incl. `toSVG()`/`toPNG()`
   *  export, #105 N7b-2) — a CSS font shorthand, e.g. `"600 11px sans-serif"`. Default `"12px sans-serif"`. */
  font?: string;
  /** Fill colour for backend-native text. Default black. */
  color?: string;
  /** A legibility halo stroked behind backend-native text — the export analogue of a CSS text-shadow.
   *  `width` is the half-stroke in px. */
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
   */
  linkStyle?: LinkStyle;
  /**
   * Link width. A constant (default 1), a **d3 scale of the edge weight** — `(weight) => width`, e.g.
   * `scaleSqrt().domain([0, maxWeight]).range([1, 6])` — or `{ by, scale }` for parity with
   * {@link nodeRadius} (`by` is `"weight"`/`"flow"`, the same per-edge quantity). A **super-edge**
   * applies the same scale to the **accumulated** weight of the edges it subsumes, so link thickness
   * reads as flow at every LOD level. Keep the scale's range minimum ≥ 1 so links never vanish.
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
   * Bend links into curves (N6c / #104). For `linkStyle:"line"` this is the quadratic-bezier control
   * offset ⟂ to the chord as a **fraction of chord length** (try ~0.15; `0` (default) keeps links
   * straight). For `linkStyle:"half-arrow"` it is an **absolute world-unit** offset (the reference's
   * `bend`, ~30); the bow side is derived from the link direction so a reciprocal A→B / B→A pair nests
   * around a shared centre curve instead of colliding.
   */
  linkBend?: number;
}

/** How node positions are produced. The worker / GPU backends land in later slices. */
export interface NetworkLayoutOptions {
  /** `"positions"` uses caller-supplied coordinates; `"force"` runs the in-library force
   *  layout on the main thread; `"worker"`/`"gpu"` land later. */
  backend?: "positions" | "force" | "worker" | "gpu";
  /** Interleaved `[x, y, …]` world coordinates for `backend: "positions"`. */
  positions?: Float32Array;
  /** Iterations for `backend: "force"` (default 300, per level when multilevel). */
  iterations?: number;
  /** Force parameters for `backend: "force"`. */
  force?: Partial<ForceParams>;
  /**
   * For `backend: "force"` and `backend: "worker"`, seed the layout via multilevel coarsening
   * (heavy-edge matching) for faster convergence and fewer tangles on clustered graphs. Default
   * `true`; set `false` for a plain cold-start force run. Tiny / edgeless graphs skip coarsening
   * automatically.
   */
  multilevel?: boolean;
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
   * A **provided module hierarchy** (N6 / #104): the LOD tree's source, taking priority over
   * structural coarsening. Pass Infomap's JSON `nodes` array directly — each record's `id` is the
   * dense node index (aligned with `buildGraph`) and `path` its 1-based module chain. Modules then
   * expand → sub-modules → leaves on zoom through the same adaptive cut as coarsening. Records must
   * cover every node. @see {@link buildModuleLODTree}
   *
   * On the `worker` backend the tree is built on the main thread (the worker supplies only positions);
   * the off-thread module-tree path is a later refinement.
   */
  modules?: ArrayLike<ModuleNode>;
  /**
   * Expand threshold (px): an aggregate whose on-screen footprint (`2·extent·k`) reaches this
   * expands into its children; below it it draws as a single glyph. Larger → coarser (fewer, bigger
   * aggregates). Default 48.
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
   * colour (default a dark neutral). Omit to disable.
   */
  aggregateOutline?: { width?: number; gap?: number; color?: string };
   /**
   * Draw **super-edges**: links between *both-visible* frontier nodes (leaf↔leaf, module↔module, or
   * aggregate↔aggregate — whatever the cut exposes), sized + coloured by their accumulated flow and
   * rendered in the active `linkStyle`. Default `true`. @see {@link superEdges}
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
   * Needs the directed super-edge CSR (a provided {@link modules} hierarchy); ignored otherwise.
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

const DEFAULT_NODE_RADIUS = 4;
const DEFAULT_NODE_FILL = "#4878d0";
const DEFAULT_LINK_WIDTH = 1;
const DEFAULT_LINK_STROKE = "#999999";
const LAYER_NAMES = ["links", "arrows", "node-halos", "nodes"] as const;
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
  /** Pending coalesced repaint rAF id (0 = none) for progressive worker frames. */
  private layoutRepaintRaf = 0;
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
  /** Dedup guard for the one-shot deferred main-thread LOD-tree fallback (see {@link scheduleLODFallback}). */
  private lodFallbackScheduled = false;
  /** Whether `lodTree` has had its geometry computed at least once, so the cut may run. */
  private lodHasGeometry = false;
  /** Reusable cross-fade scratch (#133), indexed by tree-node id; grown as the tree grows, reused per cut to avoid GC. */
  private fadeScratch: Float32Array | null = null;
  /** The fade alpha the last {@link computeFrontier} produced (the live `fadeScratch`), or null when cross-fade is off. */
  private fadeAlpha: Float32Array | null = null;
  /** Cached resolved style; invalidated on style()/data() to avoid per-zoom O(n) radii recompute. */
  private resolvedCache: ResolvedNetworkStyle | null = null;
  /** Registry key for the single network instanced lane (#108-B). */
  private readonly NET_LANE = "network";
  /** Registry key for the companion selection/hover ring overlay lane (#105 N7c-2), drawn on top. */
  private readonly NET_HL_LANE = "network-highlight";
  /** The dispatch layer name node picks resolve to (selection/hover are keyed under it). */
  private readonly NODE_LAYER = "nodes";
  /** The `hit.layer` value link picks resolve to (#141), distinguishing a link hit from a node hit. */
  private readonly LINK_LAYER = "links";
  /** Node interaction opts set via {@link interactive} (selection/hover/tooltip). Null = pick-only. */
  private interactiveOpts: InteractiveLayerOptions | null = null;
  /** GPU-readback link picking opt-in (#141). Off ⇒ links carry no pick model and the lane has no
   *  `gpuPick`, so hover/click never resolves a link (zero added GPU cost). Toggled by {@link pickLinks}. */
  private pickLinksEnabled = false;
  /** Maps a picked link instance index (gl_InstanceID) → a {@link NetworkLinkHit} HoverHit, captured per
   *  emit so it matches the link set currently in the pick FBO. Null when no links are drawn. */
  private linkResolve: ((index: number) => HoverHit | null) | null = null;
  /** Frontier label overlay (#105 N7b) + its options; null until {@link labels} is enabled. */
  private labelLayer: LabelLayer | null = null;
  private labelOpts: NetworkLabelOptions | null = null;

  constructor(host: HTMLElement, opts: NetworkOptions = {}) {
    super(host, opts);
    // Push whatever data exists once the initial backend is ready: data() may be called
    // before whenReady, and a *first* backend install does not fire onBackendSwapped.
    void this.whenReady().then(() => this.rebuild());
  }

  /** Set the graph to render (built via `buildGraph` / `parseEdgeList`). */
  data(graph: NetworkGraph): this {
    this.stopLayout(); // any worker layout is tied to the previous graph's buffers
    this.graph = graph;
    // New topology + position buffer: drop the retained LOD tree and resolved-style cache.
    this.lodTree = null;
    this.lodWorkerTree = null;
    this.lodSpatial = false;
    this.lodModules = false;
    this.lodHasGeometry = false;
    this.resolvedCache = null;
    return this.rebuild();
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
    // Switching the tree SOURCE (provided modules ↔ structural coarsening) must rebuild the tree — the
    // retained one is from the old source. Drop the main-thread tree so recomputeLODGeometry rebuilds
    // (keep a worker-streamed tree; the worker owns it).
    if (!!options.modules !== this.lodModules && this.lodTree && this.lodTree !== this.lodWorkerTree) {
      this.lodTree = null;
      this.lodHasGeometry = false;
    }
    this.lodOptions = options;
    // Keep any worker-streamed tree from a still-current run: reconfiguring LOD options reuses it
    // (cut-time options apply immediately; the style geometry refreshes). data()/layout() drop it on
    // a graph or layout change. recomputeLODGeometry builds a main-thread tree only off the worker
    // backend — on the worker backend the tree comes from the worker (or the settle fallback).
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
   * - `selection: { selected, others }` — `selected.stroke` overrides the **select** ring colour
   *   (default `#ff6a00`); the hover ring defaults to `#fff` (override via a `hover` HighlightStyle's
   *   `stroke`). `others` (Scene dimming) is ignored on instanced glyphs — selected glyphs get a ring.
   *
   * The hit's `datum` is a {@link NetworkHit} (`{ aggregate, count }`); its `members()` lists the leaf
   * node ids the target covers (1 for a leaf, the whole subtree for an aggregate). Observe selection
   * via `on("select", (hits) => …)` or read it back with `selection()`; both carry `members()`.
   * Pass `false` to disable (clears any current selection).
   */
  interactive(opts: InteractiveLayerOptions<NetworkHit> | false): this {
    this.interactiveOpts = opts || null;
    if (!this.interactiveOpts) this.clearLayerSelection(this.NODE_LAYER); // disabling clears managed selection
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
   * Rendered by the **active backend**: WebGL → an HTML overlay (crisp + accessible; style via
   * `className`); SVG/Canvas → native `<text>`/`fillText` so labels appear in `toSVG()`/`toPNG()`
   * (style via `font`/`color`/`halo`). Pass `false` to remove.
   */
  labels(opts: NetworkLabelOptions | false): this {
    if (!opts) {
      this.labelLayer?.destroy();
      this.labelLayer = null;
      this.labelOpts = null;
      this.backend()?.setTextLayer?.([]); // clear any backend-native labels too
      this.render(); // repaint so a backend that bakes labels in (Canvas) drops them now
      return this;
    }
    this.labelOpts = opts;
    if (!this.labelLayer) {
      // The overlay is absolutely positioned over the canvas — anchor it to a positioned host.
      if (getComputedStyle(this.host).position === "static") this.host.style.position = "relative";
      this.labelLayer = new LabelLayer(this.host, (a) => a.text, opts.className);
    }
    this.refreshLabels();
    this.render(); // bake just-set labels into the frame (Canvas); no-op-ish for the live-DOM backends
    return this;
  }

  /** Re-place the frontier labels at the current transform: pick the top-`max` visible glyphs by
   *  importance and feed their centroids + text to the overlay. Cheap no-op when labels are off.
   *  Called on every {@link afterTransform} (zoom/pan) and after a rebuild (frontier changed). */
  private refreshLabels(): void {
    const layer = this.labelLayer, opts = this.labelOpts;
    if (!layer || !opts || !this.graph) return;
    // Default: NO cap — show every visible glyph that has a label (collision culling thins them where
    // they'd overlap). A finite `max` keeps only the top-k by importance; ranking (the sort below) is
    // therefore done ONLY when capping AND there are more candidates than the cap.
    const max = opts.max ?? Infinity;
    const rect = visibleWorldRect(this.transform, this.width, this.height);
    const inView = (x: number, y: number) => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
    const anchors: LabelAnchor[] = [];

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
        anchors.push({ id: g, refX: tree.cx[g]!, refY: tree.cy[g]!, text, offset: opts.offset, transform: "translate(-50%, -50%)", opacity: fade ? fade[g] : undefined });
        if (anchors.length >= max) break;
      }
    } else {
      // No-LOD: rank the nodes in view by strength (weighted degree). The full graph is drawn.
      const graph = this.graph, pos = graph.positions, strength = graph.strength;
      const cand: number[] = [];
      for (let i = 0; i < graph.nodeCount; i++) if (inView(pos[2 * i]!, pos[2 * i + 1]!)) cand.push(i);
      const impOf = opts.importanceOf;
      if (cand.length > max) cand.sort((a, b) => (impOf ? impOf(b, NO_LOD_INFO) - impOf(a, NO_LOD_INFO) : strength[b]! - strength[a]!));
      for (const id of cand) {
        const text = labelText(opts, id, NO_LOD_INFO);
        if (!text) continue;
        anchors.push({ id, refX: pos[2 * id]!, refY: pos[2 * id + 1]!, text, offset: opts.offset, transform: "translate(-50%, -50%)" });
        if (anchors.length >= max) break;
      }
    }

    // Route by backend (#105 N7b-2): a backend that draws text natively (SVG `<text>` / Canvas
    // `fillText`) renders the labels so they survive toSVG()/toPNG(); otherwise (WebGL) the HTML
    // overlay does. Project + cull is shared (placeLabels), so both paths place labels identically.
    const viewport = { width: this.width, height: this.height };
    const backend = this.backend();
    if (backend?.setTextLayer) {
      const survivors = placeLabels(anchors, this.transform, viewport);
      backend.setTextLayer(survivors.map((b) => ({
        x: b.x, y: b.y, text: String(b.text), align: "middle" as const,
        font: opts.font, color: opts.color, halo: opts.halo, opacity: b.opacity as number | undefined,
      })));
      layer.update([], this.transform, viewport); // keep the overlay empty on a native-text backend
    } else {
      layer.update(anchors, this.transform, viewport);
    }
  }

  protected override afterTransform(): void {
    this.refreshLabels();
  }

  /** Configure layout / supply positions (the pluggable contract proper lands in #101). */
  layout(opts: NetworkLayoutOptions): this {
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    if (this.graph) {
      // Any backend change cancels a running worker layout before re-seeding positions. A prior
      // worker-streamed LOD tree belongs to that superseded run, so drop it: the new layout either
      // re-streams one (worker backend) or builds one on the main thread (force/positions).
      this.stopLayout();
      this.lodWorkerTree = null;
      if (opts.backend === "positions" && opts.positions) {
        this.graph.positions.set(opts.positions);
        // The edge-less spatial tree's topology depends on the positions, so drop it to rebuild from
        // the new coordinates (the coarsening tree is position-independent and is kept).
        if (this.lodSpatial) { this.lodTree = null; }
        this.recomputeLODGeometry(); // caller-supplied coordinates are final immediately
      } else if (opts.backend === "worker") {
        // Off-thread force layout with progressive convergence. The worker can post a frame per
        // tick, so coalesce repaints to one per animation frame (always painting the freshest
        // positions) to bound main-thread work at large N.
        //
        // The worker streams a *coarsening* LOD tree; a provided module hierarchy (N6 / #104) is a
        // different source the worker doesn't build, so with modules the worker supplies positions
        // only and the main thread builds the module tree (recomputeLODGeometry, off the worker guard).
        const useLod = !!this.lodOptions && !this.lodOptions.modules;
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
                // Adopt the worker's tree: its geometry streams live, so the main thread only fills
                // the style geometry once. The first frame (which follows this message) renders it.
                this.lodTree = tree;
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
          this.rebuild();
        });
      } else if (opts.backend === "force") {
        // Main-thread force layout. (Off-thread + progressive convergence via a Web Worker is the
        // next slice.) Multilevel coarsening seeds it by default; opt out for a plain cold start.
        const iterations = opts.iterations ?? DEFAULT_FORCE_ITERATIONS;
        if (opts.multilevel === false) {
          seedPositions(this.graph, this.width, this.height);
          new ForceLayout(this.graph, opts.force).run(iterations);
        } else {
          multilevelLayout(this.graph, {
            width: this.width,
            height: this.height,
            iterations,
            force: opts.force,
          });
        }
        this.recomputeLODGeometry(); // synchronous solve is done
      }
    }
    return this.rebuild();
  }

  /**
   * Coalesce progressive worker frames into at most one repaint per animation frame. With a
   * worker-streamed LOD tree the geometry is already fresh (the worker wrote it before posting the
   * frame), so the main thread only re-cuts; otherwise the positions changed and the LOD geometry is
   * recomputed here before the cut — LOD tracks the layout *as it converges*, not only once settled.
   */
  private scheduleLayoutRepaint(): void {
    if (this.layoutRepaintRaf) return;
    const raf: (cb: FrameRequestCallback) => number =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 16);
    this.layoutRepaintRaf = raf(() => {
      this.layoutRepaintRaf = 0;
      if (!this.lodWorkerTree) this.recomputeLODGeometry(); // worker streams geometry; main only re-cuts
      this.rebuild();
    });
  }

  /** Stop a running worker layout (no-op if none). The last computed positions are kept. */
  stopLayout(): this {
    this.layoutHandle?.stop();
    this.layoutHandle = null;
    this.lodStreaming = false; // no worker run is in flight to stream the LOD tree any more
    if (this.layoutRepaintRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.layoutRepaintRaf);
    this.layoutRepaintRaf = 0;
    return this;
  }

  /** Resolves when the current worker layout converges or is stopped (immediately if none runs). */
  whenSettled(): Promise<void> {
    return this.layoutHandle?.settled ?? Promise.resolve();
  }

  /** Tear down the engine, cancelling any worker layout first. */
  override destroy(): void {
    this.stopLayout();
    this.labelLayer?.destroy();
    this.labelLayer = null;
    super.destroy();
  }

  /**
   * Which tree currently drives LOD rendering: `"worker"` when the active tree is the one the layout
   * worker built and streams (so the main thread does no coarsening or O(N) geometry pass),
   * `"modules"` when it's a provided module hierarchy (N6 / #104), `"spatial"` when it's the edge-less
   * quadtree built over the node positions, `"main"` when it's the coarsening tree built on the main
   * thread (`force`/`positions` backends, the worker fallback, or LOD enabled after a worker run), or
   * `"none"` when LOD is off or no geometry exists yet. Introspection for debugging and tests.
   */
  get lodSource(): "worker" | "modules" | "spatial" | "main" | "none" {
    if (!this.lodOptions || !this.lodTree || !this.lodHasGeometry) return "none";
    if (this.lodWorkerTree && this.lodTree === this.lodWorkerTree) return "worker";
    if (this.lodModules) return "modules";
    return this.lodSpatial ? "spatial" : "main";
  }

  /**
   * Re-emit the instanced layers to the backend and repaint. A no-op until a graph is set and a
   * backend exposing the instanced lane is live — on non-WebGL backends this draws through the
   * PathContext seam instead (small-N / export, #100 N2.3). When LOD is active and settled, the
   * emitted layers are the cut frontier rather than the full graph.
   */
  private rebuild(): this {
    if (!this.graph) return this;
    const backend = this.backend();
    if (!backend) return this;
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
      const lane = new InstancedLane(strategy, () => this.flagPickableLinks(networkLayers(graph, this.resolvedStyleCached(graph))));
      this.registerInstancedLane(this.NET_LANE, {
        lane, layerNames: LAYER_NAMES, dynamic: false,
        resolve: (i) => ({ layer: this.NODE_LAYER, id: i, datum: { aggregate: false, count: 1 } satisfies NetworkHit }),
        interactive: this.laneInteractive(() => ({ aggregate: false, count: 1 }), (i) => [i]),
        gpuPick: this.pickLinksEnabled ? (id) => this.linkResolve?.(id) ?? null : undefined,
      });
      // No-LOD: the whole graph is drawn, so every selected/hovered node index is "visible" (source=null).
      this.syncHighlightLane(null, (i) => [graph.positions[2 * i]!, graph.positions[2 * i + 1]!], (i) => this.resolvedStyleCached(graph).nodeRadii[i]!, false);
    } else {
      // LOD on but no tree yet (worker streaming) — draw nothing, not pickable.
      this.unregisterLanes();
    }
  }

  /** Unregister both the node lane and its companion ring overlay (backend switch / no graph). */
  private unregisterLanes(): void {
    this.unregisterInstancedLane(this.NET_HL_LANE);
    this.unregisterInstancedLane(this.NET_LANE);
  }

  private lodDatum(tree: LODTree, g: number): NetworkHit {
    return { aggregate: g >= tree.leafCount, count: tree.count[g]! };
  }

  /** Flag every link layer (lines/arrows/half-arrows; not node circles) into the GPU pick pass (#141)
   *  when link picking is on. Mutates the freshly-built layers in place (they're per-emit, never shared). */
  private flagPickableLinks(layers: InstancedLayer[]): InstancedLayer[] {
    if (this.pickLinksEnabled) for (const l of layers) if (l.primitive !== "circles") l.pickable = true;
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
  private laneInteractive(datumOf: (id: number) => NetworkHit, members: (id: number) => number[]): LaneInteractive | undefined {
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
        return [{ name: ringName, primitive: "circles", sizeMode, circles: ringCircles(visible, centerOf, radiusOf, (g) => !!selected?.has(g), colors) }];
      }),
      layerNames: [ringName], dynamic: true,
      resolve: () => null,
    });
  }

  /** Highlighted node ids currently on screen: (selection ∪ hover) ∩ frontier (LOD) or taken directly
   *  (no-LOD). Returns the shared empty sentinel when nothing is highlighted, so the per-frame ring
   *  re-emit costs O(1) until the user selects/hovers something. */
  private highlightVisible(source: InstancedLane | null, lod: boolean): Uint32Array {
    if (!this.hasHighlight(this.NODE_LAYER)) return EMPTY_VISIBLE;
    const ids = new Set<number>();
    const sel = this.selectedIds(this.NODE_LAYER); if (sel) for (const id of sel) ids.add(id as number);
    const hov = this.hoveredIds(this.NODE_LAYER); if (hov) for (const id of hov) ids.add(id as number);
    if (ids.size === 0) return EMPTY_VISIBLE;
    if (lod && source) {
      const vis = source.visible;
      const out: number[] = [];
      for (let i = 0; i < vis.length; i++) if (ids.has(vis[i]!)) out.push(vis[i]!);
      return Uint32Array.from(out);
    }
    const n = this.graph!.nodeCount;
    const out: number[] = [];
    for (const id of ids) if (id >= 0 && id < n) out.push(id);
    return Uint32Array.from(out);
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
    let frontier = cut(tree, this.transform, this.width, this.height, {
      expandPx: opts.expandPx,
      screenSized: style.sizeMode === "screen",
      maxAggregateRadius: opts.maxAggregateRadius,
      fadeBand,
      fadeAlpha: this.fadeAlpha ?? undefined,
    });
    if (opts.declutter !== false) {
      frontier = declutterFrontier(tree, frontier, this.transform, this.width, this.height, {
        screenSized: style.sizeMode === "screen",
        k: this.transform.k,
        maxAggregateRadius: opts.maxAggregateRadius,
        spacing: opts.declutterSpacing,
        // Cross-fade (#133): transitioning glyphs are exempt, so a fading parent never culls its fading-in children.
        fadeAlpha: this.fadeAlpha ?? undefined,
      });
    }
    return frontier;
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
    // Super-edges first (drawn under the nodes), among the visible frontier only.
    if (opts.superEdges !== false && this.graph!.edgeCount > 0) {
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
          fadeAlpha: this.fadeAlpha ?? undefined,
        },
        visibleWorldRect(this.transform, this.width, this.height),
      );
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
    if (opts.aggregateOutline) {
      const halos = frontierHalos(tree, frontier, {
        width: opts.aggregateOutline.width ?? 1.5,
        gap: opts.aggregateOutline.gap ?? 2.5,
        color: opts.aggregateOutline.color ?? "#3a3f52",
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
   *   fell back to a synchronous main-thread solve and never streamed a tree.
   * - **Main-thread tree** (`force`/`positions` backends, or the worker fallback): build the tree
   *   lazily, then the full geometry from the current positions + style; tracks convergence.
   *
   * O(tree size); the zoom-time cut does not call this (it reuses the geometry).
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
    if (this.lodWorkerTree) {
      computeLODStyle(this.lodWorkerTree, nodeRadii, leafWeight, leafBorder, leafColors, radiusAggregate);
      this.lodTree = this.lodWorkerTree;
      this.lodHasGeometry = true;
      return;
    }
    // The worker streams a *coarsening* tree on this backend; don't build one on the main thread (the
    // whole point of worker-LOD). A provided module hierarchy is the exception — the worker doesn't
    // build it, so the main thread must (it falls through to the module branch below). The settle
    // handler / deferred fallback force a build when no worker streamed one.
    if (this.layoutOpts.backend === "worker" && !this.lodOptions.modules && !forceMain) return;
    if (!this.lodTree) {
      // Priority chain (epic #98): provided module hierarchy → structural coarsening → spatial
      // quadtree fallback. A provided tree (N6 / #104) is position-independent, like coarsening.
      if (this.lodOptions.modules) {
        // Pass the graph's directed edges so the tree also carries flow-weighted super-edges (the sum
        // of subsumed edge weights per module pair) for the bent half-arrow map links (#104 N6c).
        this.lodTree = buildModuleLODTree(this.graph.nodeCount, this.lodOptions.modules, this.graph);
        this.lodModules = true;
        this.lodSpatial = false;
      } else if (this.graph.edgeCount === 0) {
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
    computeLODGeometry(this.lodTree, this.graph, nodeRadii, leafWeight, leafBorder, leafColors, radiusAggregate);
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

  /** Re-bake the vector-backend screen-mode geometry when a pan/zoom gesture ends (cheap, O(edges)). */
  protected override setInteracting(v: boolean): void {
    const ending = this.interacting && !v;
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
    const edgeIds = Array.from({ length: graph.edgeCount }, (_, e) => e);
    const nodeIds = Array.from({ length: graph.nodeCount }, (_, i) => i);
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
        if (!emit) return;
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
        if (emit && style.directed && !halfArrow) emitArrows(g, graph, style.arrowSize, style.nodeRadii, style.linkBend, style.linkBend !== 0, arrowBake);
      },
    });
    // Aggregate-outline halo ring: only the LOD Scene path ({@link registerLODScene}) draws into it,
    // but it's registered empty here too so the layer slot exists in canonical order (links < arrows <
    // node-halos < node-borders < nodes) — so a backend switch / LOD toggle re-registers into the same
    // slot and the ring never lingers above the nodes nor draws on a full-graph view.
    this.registerLayer({ name: "node-halos", data: [], ids: [], sizeMode: style.sizeMode, build: () => {} });
    // Per-node fill: a single colour, or the per-node accessor (categorical module colours, #104 rework).
    const fillSpec = this.styleOpts.nodeFill;
    const fillOf = typeof fillSpec === "function" ? (i: number) => fillSpec(i, graph) : () => style.nodeFill;

    // Border (#104 N6/rework): the instanced lane draws the ring in-shader, but the Scene path has no
    // per-element ring primitive — so render it as two stacked discs, a border-colour disc under a
    // smaller fill disc (inner radius = radius − ring width). Handles both the flow border (per-node
    // width) and the constant border (fixed px). Always registered (empty when off) so toggling clears it.
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
    const hasBorder = !!(flow || cb);
    this.registerLayer({
      name: "node-borders",
      data: nodeIds,
      ids: nodeIds,
      sizeMode: style.sizeMode,
      fill: (i) => borderColorAt(i as number),
      build: (g) => {
        if (emit && hasBorder) emitNodes(g, graph, style.nodeRadii);
      },
    });
    this.registerLayer({
      name: "nodes",
      data: nodeIds,
      ids: nodeIds,
      sizeMode: style.sizeMode,
      fill: (i) => fillOf(i as number),
      build: (g) => {
        if (emit) emitNodes(g, graph, innerRadii);
      },
    });
  }

  /**
   * Register the LOD cut frontier as retained Scene layers (#138) — the vector-backend twin of the
   * WebGL {@link frontierLayers} emit. Computes the same {@link computeFrontier} and traces the *same* SoA
   * ({@link superEdges}/{@link frontierHalos}/{@link frontierCircles}) into Scene drawables, keyed by
   * **stable tree-node id** (frontier node, or directed super-edge pair) so the retained-scene diff is
   * stable across re-cuts. Layers are registered in canonical draw order (links < arrows < node-halos <
   * node-borders < nodes), each into the same slot the full-graph path uses, so toggling LOD or swapping
   * backends never reorders or leaves stale geometry. With `emit: false` every layer registers empty (the
   * frontier clear). Re-run at each interaction-end via {@link syncScreenGeometry} — the retained Scene
   * can't re-tessellate per frame, so the frontier is static during a gesture and snaps on release (the
   * agreed redraw-on-zoom-end model).
   */
  private registerLODScene(tree: LODTree, style: ResolvedNetworkStyle, emit: boolean): void {
    const opts = this.lodOptions!;
    const screen = style.sizeMode === "screen";
    const frontier = emit ? this.computeFrontier(tree, style) : new Uint32Array(0);

    // --- Super-edges (drawn under the nodes), among the visible frontier only. ---
    const se =
      emit && opts.superEdges !== false && this.graph!.edgeCount > 0
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
              fadeAlpha: this.fadeAlpha ?? undefined,
            },
            visibleWorldRect(this.transform, this.width, this.height),
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
    const halos =
      emit && opts.aggregateOutline
        ? frontierHalos(tree, frontier, {
            width: opts.aggregateOutline.width ?? 1.5,
            gap: opts.aggregateOutline.gap ?? 2.5,
            color: opts.aggregateOutline.color ?? "#3a3f52",
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
      stroke: (_d, i) => (halos?.borderColors ? rgbaCss(halos.borderColors, i) : ""),
      build: (g) => {
        if (halos) traceFrontierHalos(g, halos, screen);
      },
    });

    // --- Frontier glyphs: a border-colour disc (when bordered) under the smaller fill disc. ---
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
      name: "node-borders",
      data: circleIds,
      ids: circleIds,
      sizeMode: style.sizeMode,
      fill: (_d, i) => (circles?.borderColors ? rgbaCss(circles.borderColors, i) : ""),
      build: (g) => {
        if (circles) traceFrontierBorders(g, circles, frontier);
      },
    });
    this.registerLayer({
      name: "nodes",
      data: circleIds,
      ids: circleIds,
      sizeMode: style.sizeMode,
      fill: (_d, i) => (circles ? rgbaCss(circles.colors, i) : ""),
      build: (g) => {
        if (circles) traceFrontierFills(g, circles, frontier);
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
