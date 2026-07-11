import { BaseEngine, type BaseEngineOptions, type HoverHit, type InteractiveLayerOptions, type LaneInteractive, type NodeDragSession } from "../map/base-engine.js";
import { networkLayers, networkLayersFromCache, noLodStyleCache, frontierCircles, frontierHalos, superEdges, emitNodes, emitLinks, emitArrows, emitHalfLinks, traceFrontierFills, traceFrontierBorders, traceFrontierHalos, traceSuperHalfArrows, traceSuperLines, traceSuperArrows, physicalPieInstances, tracePieWedges, rgbaCss, pickNodes, regionNodes, resolveNodeRadii, resolveNodeRadiusAggregate, resolveImportance, resolveFlowBorder, resolveNodeColors, resolveLinkWidthOf, resolveLinkColorOf, resolveLinkStrokeOf, flowBorderInnerRadii, type ResolvedNetworkStyle, type NoLodStyleCache, type NodeRadiusSpec, type ImportanceSpec, type FlowBorderSpec, type ConstBorder, type LinkWidthSpec, type LinkColorSpec, type LinkStyle } from "./glyphs.js";
import { rgb } from "d3-color";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { buildLODTree, buildSpatialLODTree, computeLODGeometry, computeLODStyle, cut, declutterFrontier, pickFrontier, regionFrontier, visibleWorldRect, leavesUnder, ancestorAwareSelected, type LODTree, type SpatialLODOptions } from "./lod.js";
import { LabelLayer, placeLabels, type LabelAnchor } from "../labels/label-layer.js";
import { buildModuleLODTree, type ModuleNode } from "./modules.js";
import { moduleColors, type ModulePathNode, type ModuleColorOptions } from "./module-colors.js";
import { physicalPieWedges, type PhysicalPieWedges, type PieWedgeOptions } from "./pie.js";
import { rosettePositions } from "./rosette.js";
import type { StateNetworkGraph } from "./state-graph.js";
import { startWorkerLayout, type WorkerLayoutHandle } from "./worker-transport.js";
import { startGpuLayout } from "./gpu/gpu-transport.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";
import type { NetworkGraph } from "./graph.js";
import { fitNodes, fitBox, fitTransform, type FitBox } from "./fit.js";
import type { InstancedLayer, ViewTransform } from "../core/index.js";
import { InstancedLane, type SelectionStrategy } from "../core/instanced-lane.js";
import { resolveRingColors, ringCircles } from "../map/highlight-ring.js";
import { hoverParts } from "../map/highlight.js";

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
  /**
   * State-network `"both"` view only (#171): also label the physical **containers**, placed just OUTSIDE
   * each container disc (upper-right, ≈1:30 on a clock) so the label clears the enclosed state rosette.
   * `labelOf` maps a physical id → text (`null`/`""` to skip); `gap` is the extra px beyond the disc edge
   * (default 4). Ignored outside the `both` view. The primary {@link labelOf} still labels the state nodes.
   */
  physical?: { labelOf: (physicalId: number) => string | null | undefined; gap?: number };
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
const LAYER_NAMES = ["links", "arrows", "node-halos", "nodes"] as const;
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

/** `[0, 1, …, n-1]` as float32 — the no-LOD node layer's `a_group` (instance i is node i). */
function identityFloats(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
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
  /** Cached top-module ids (the fit nodes, {@link fitNodes}) for the per-frame fit, plus the median scratch
   *  ({@link fitBox}). Recomputed only when the tree identity changes; the scratch is reused across frames. */
  private fitNodesArr: Uint32Array | null = null;
  private fitNodesFor: LODTree | null = null;
  private fitScratch: Float32Array | null = null;
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
  /** No-LOD style-derived link/arrow attributes cache (#179), keyed by `resolvedCache` identity + graph:
   *  reused on a position-only layout frame so the colour/width scale accessors run O(edges) ONCE per
   *  style version, not per frame. Invalidated implicitly when `resolvedStyleCached` returns a fresh object. */
  private noLodStyleCacheFor: { style: ResolvedNetworkStyle; graph: NetworkGraph } | null = null;
  private noLodStyleCacheVal: NoLodStyleCache | null = null;
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
  /** Node interaction opts set via {@link interactive} (selection/hover/tooltip). Null = pick-only. */
  private interactiveOpts: InteractiveLayerOptions | null = null;
  /** GPU-readback link picking opt-in (#141). Off ⇒ links carry no pick model and the lane has no
   *  `gpuPick`, so hover/click never resolves a link (zero added GPU cost). Toggled by {@link pickLinks}. */
  private pickLinksEnabled = false;
  /** Maps a picked link instance index (gl_InstanceID) → a {@link NetworkLinkHit} HoverHit, captured per
   *  emit so it matches the link set currently in the pick FBO. Null when no links are drawn. */
  private linkResolve: ((index: number) => HoverHit | null) | null = null;
  /** Derived parent-pointer cache for the ancestor-aware selection highlight (#162), used only when the
   *  LOD tree carries no `parent` (coarsening/spatial). Keyed by tree identity; see {@link treeParent}. */
  private derivedParentFor: LODTree | null = null;
  private derivedParent: Int32Array | null = null;
  /** Frontier label overlay (#105 N7b) + its options; null until {@link labels} is enabled. */
  private labelLayer: LabelLayer | null = null;
  private labelOpts: NetworkLabelOptions | null = null;
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

  /** Set the graph to render (built via `buildGraph` / `parseEdgeList`). Leaves any state-network mode
   *  ({@link stateNetwork}) — a plain graph replaces it. */
  data(graph: NetworkGraph): this {
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
    this.stopLayout(); // any worker layout is tied to the previous graph's buffers
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
    // New topology + position buffer: drop the retained LOD tree and resolved-style cache.
    this.lodTree = null;
    this.lodWorkerTree = null;
    this.lodSpatial = false;
    this.lodModules = false;
    this.lodHasGeometry = false;
    this.resolvedCache = null;
    this.derivedParentFor = null; this.derivedParent = null; // drop the ancestor-aware parent cache (#162)
    this.fitFallbackBox = null; this.fitNodesArr = null; this.fitNodesFor = null; // fit caches are tied to the old graph/tree
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
        anchors.push({ id: `phys:${p}`, refX: x, refY: y, text, offset: [DX * dist, DY * dist], transform: "translate(-50%, -50%)" });
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
    if (this.stateData) return this.layoutStateNetwork(opts);
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    if (this.graph) {
      // Any backend change cancels a running worker layout before re-seeding positions. A prior
      // worker-streamed LOD tree belongs to that superseded run, so drop it: the new layout either
      // re-streams one (worker backend) or builds one on the main thread (force/positions).
      this.stopLayout();
      this.lodWorkerTree = null;
      // Fit-on-layout (streaming backends): keep the camera framed on the layout as it converges.
      // Seed a box-centred disc up front so the FIRST paint is framed — until the first frame streams
      // back, `graph.positions` would be all-zeros (the GPU solve seeds on-device, so the CPU copy is
      // untouched), which renders as one glyph piled at the origin (top-left). The seed is overwritten
      // by the first streamed frame; each frame then reframes via {@link fitViewToLayout}.
      const fit = opts.fit === true && (opts.backend === "worker" || opts.backend === "gpu");
      this.fitOnLayout = fit;
      this.fitFallbackBox = null;
      if (fit) seedPositions(this.graph, this.width, this.height);
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
          this.releaseFit(); // final reframe on the settled bounds, then hand the view to zoom/pan
          this.rebuild();
        });
      } else if (opts.backend === "gpu") {
        // GPU force layout — uses the WebGL backend's luma.gl Device. Pass a device *promise* that
        // waits for the backend to fully settle (including the "auto" → WebGL background upgrade)
        // before resolving, so `startGpuLayout` sees the real WebGL device and doesn't silently fall
        // back to the worker because it was called before the upgrade finished.
        //
        // N8.2 module-aware seed: when a module hierarchy is provided (`lod({ modules })` set before
        // `layout`), build the module tree up front and hand it to the GPU seed so the layout is laid
        // out top-down over the modules. Build it once here and adopt it as the LOD tree — the settle
        // handler's recomputeLODGeometry then only fills its geometry (it skips the rebuild).
        let moduleTopology: LODTree | undefined;
        if (this.lodOptions?.modules) {
          if (!this.lodTree || !this.lodModules) {
            this.lodTree = buildModuleLODTree(this.graph.nodeCount, this.lodOptions.modules, this.graph);
            this.lodModules = true;
            this.lodSpatial = false;
            this.lodHasGeometry = false;
          }
          moduleTopology = this.lodTree;
        }
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
    this.stopLayout(); // cancel a running physical-layout worker/GPU stream before re-seeding

    if (opts.backend === "positions" && opts.positions) {
      phys.positions.set(opts.positions);
      this.applyStateDerivedPositions();
      this.recomputeLODGeometry();
      return this.rebuild();
    }

    if (opts.backend === "worker" || opts.backend === "gpu") {
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
        // Frame the physical layout to fill the view at k=1 now that it's at rest — scaleToViewport
        // mutates the shared position buffer in place, so it's only safe once the worker/GPU stream has
        // stopped writing it (during the run the force's own centering keeps it roughly framed).
        scaleToViewport(phys.positions, sg.physicalCount, this.width, this.height);
        this.applyStateDerivedPositions();
        this.recomputeLODGeometry(true);
        this.rebuild();
      });
      // `worker` seeds `phys.positions` synchronously before returning; the async `gpu` device promise
      // seeds once it resolves. Either way, deriving now (rather than leaving a stale prior rosette on
      // screen) is cheap and self-corrects on the first streamed frame regardless.
      this.applyStateDerivedPositions();
      this.recomputeLODGeometry();
      return this.rebuild();
    }

    // Main-thread force (backend: "force", the synchronous default).
    const iterations = opts.iterations ?? DEFAULT_FORCE_ITERATIONS;
    if (opts.multilevel === false) {
      seedPositions(phys, this.width, this.height);
      new ForceLayout(phys, opts.force).run(iterations);
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
    if (this.layoutRepaintRaf) return;
    const raf: (cb: FrameRequestCallback) => number =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 16);
    this.layoutRepaintRaf = raf(() => {
      this.layoutRepaintRaf = 0;
      this.dragReapply?.(); // hold the dragged nodes under the cursor over the worker's snapshot (#140, copy mode)
      if (this.stateData) this.applyStateDerivedPositions(); // physical positions just streamed a frame
      if (!this.lodWorkerTree) this.recomputeLODGeometry(); // worker streams geometry; main only re-cuts
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
    if (this.fitFallbackBox) return this.fitFallbackBox;
    const p = graph.positions;
    const n = graph.nodeCount;
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
    if (!(minX <= maxX)) return null;
    return (this.fitFallbackBox = [minX, minY, maxX, maxY]);
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
    if (!this.layoutHandle) return "none";
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
      const lane = new InstancedLane(strategy, () => {
        const resolved = this.resolvedStyleCached(graph);
        const base = this.attachNoLodHighlight(this.flagPickableLinks(this.noLodLayers(graph, resolved)), graph, resolved.directed);
        // State-network overlays (#171), build-once per emit: the `both`-view physical **container** discs
        // draw UNDER the nodes/links (backdrop), the physical-view **pie** wedges draw ON TOP (cover the disc).
        const container = this.containerLayer();
        const pie = this.pieInstancedLayer(graph, resolved);
        return [...(container ? [container] : []), ...base, ...(pie ? [pie] : [])];
      });
      this.registerInstancedLane(this.NET_LANE, {
        // Overlay layer names must be in layerNames so a view switch removes them (emit-set-change re-adds).
        lane, layerNames: this.stateData ? [this.CONTAINER_LAYER, ...LAYER_NAMES, this.PIE_LAYER] : LAYER_NAMES, dynamic: false,
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

  /**
   * Assemble the no-LOD full-graph layers (#179). On a **position-only** layout frame — the resolved
   * style object is identity-unchanged from the last full emit — rebuild ONLY the position-derived
   * endpoints/node-centres and reuse the cached style-derived attributes (colours/widths/radii/sizes),
   * so the colour/width scale accessors run O(edges) ONCE per style version, not per frame. On a full
   * change (`data`/`style`/`lod`) `resolvedStyleCached` hands back a fresh object, invalidating the
   * cache, and we run the full derivation (populating the cache for the next position frame).
   */
  private noLodLayers(graph: NetworkGraph, resolved: ResolvedNetworkStyle): InstancedLayer[] {
    const cached = this.noLodStyleCacheVal;
    const valid = cached != null && this.noLodStyleCacheFor?.style === resolved && this.noLodStyleCacheFor?.graph === graph;
    // First emit for this style version runs the scale accessors ONCE and caches the style-derived attrs;
    // subsequent (position-only) frames reuse the cache, rebuilding only the position-derived endpoints/centres.
    const cache = valid && cached ? cached : noLodStyleCache(graph, resolved);
    if (!valid) {
      this.noLodStyleCacheVal = cache;
      this.noLodStyleCacheFor = { style: resolved, graph };
    }
    return networkLayersFromCache(graph, resolved, cache);
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
   *  (`lines`/`half-arrows`/`arrows`) instance `e` is graph edge `e`. `group` = node id / link source id;
   *  `group2` = the link target (undirected incident hover); `selected` = the initial flag from the
   *  current selection ({@link noLodSelectedFor} refreshes it in place on later selection changes). */
  private attachNoLodHighlight(layers: InstancedLayer[], graph: NetworkGraph, directed: boolean): InstancedLayer[] {
    const source = Float32Array.from(graph.source);
    const target = directed ? undefined : Float32Array.from(graph.target);
    for (const l of layers) {
      if (l.primitive === "circles") {
        // The only circles layer in the no-LOD path is `nodes` (no aggregate halos). Instance i = node i.
        l.circles.groups = identityFloats(graph.nodeCount);
        l.circles.selected = this.noLodSelectedFor(this.NODE_LAYER);
      } else if (l.primitive === "lines" || l.primitive === "half-arrows" || l.primitive === "arrows") {
        const link = l.primitive === "lines" ? l.lines : l.primitive === "half-arrows" ? l.halfArrows : l.arrows;
        link.groups = source;
        if (target) link.groups2 = target;
        link.selected = this.noLodSelectedFor("links"); // links/arrows share the per-edge flag
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
   *  edge e's source (directed) / either endpoint (undirected) selected. */
  private noLodSelectedFor(layer: string): Uint8Array | undefined {
    const graph = this.graph;
    if (!graph) return undefined;
    const sel = this.selectedIds(this.NODE_LAYER);
    if (layer === this.NODE_LAYER) {
      const out = new Uint8Array(graph.nodeCount);
      if (sel) for (let i = 0; i < graph.nodeCount; i++) out[i] = sel.has(i) ? 1 : 0;
      return out;
    }
    const directed = this.resolvedStyleCached(graph).directed;
    const out = new Uint8Array(graph.edgeCount);
    if (sel) for (let e = 0; e < graph.edgeCount; e++) out[e] = sel.has(graph.source[e]!) || (!directed && sel.has(graph.target[e]!)) ? 1 : 0;
    return out;
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
      const sim = new ForceLayout(graph, this.layoutOpts.force);
      sim.setPinned(held);
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
        if (cool >= 0 && --cool < 0) return; // tail finished — stop the loop
        raf = rafFn(frame);
      };
      raf = rafFn(frame);
      return {
        move: setDelta,
        end: () => { sim.setPinned(null); cool = Network.DRAG_COOL_FRAMES; if (!raf) raf = rafFn(frame); },
      };
    }

    // worker / gpu: the layout backend reflows the rest (worker off-thread, gpu on the GPU) while the
    // main thread holds the grabbed set crisply. Both expose the same pin/unpin handle (#140, #183).
    if ((backend === "worker" || backend === "gpu") && handle) {
      applyHeld();
      handle.pin(heldIds, heldPos);
      this.dragReapply = applyHeld;
      this.repaintDuringDrag();
      return {
        move: (mx, my) => { setDelta(mx, my); applyHeld(); handle.pin(heldIds, heldPos); this.repaintDuringDrag(); },
        end: () => { handle.unpin(); this.dragReapply = null; },
      };
    }

    // positions / no live worker: translate the held set under the cursor, no reheat.
    return {
      move: (mx, my) => { setDelta(mx, my); applyHeld(); this.repaintDuringDrag(); },
      end: () => {},
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

  /** Recompute the LOD geometry from the moved positions (skipped on a worker-streamed tree — the
   *  worker owns it) and re-emit + repaint. The per-frame paint shared by every drag backend (#140). */
  private repaintDuringDrag(): void {
    if (!this.lodWorkerTree) this.recomputeLODGeometry();
    this.rebuild();
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
    // Selection/hover highlight (#162) is applied in the SHADER from per-instance columns (below) + lane
    // uniforms (see onInstancedLaneEmitted) — NO per-instance CPU colour pass here, so a hover/selection
    // restyle never rebuilds this geometry. Bake only the `selected` flag (ancestor-aware, so an expanded
    // selected aggregate's children count) + the group ids the shader matches against the hovered id.
    const sel = this.selectedIds(this.NODE_LAYER);
    const isSel = sel && sel.size ? this.makeSelectedPredicate(tree, sel) : null;
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
    if (!this.stateData && this.layoutOpts.backend === "worker" && !this.lodOptions.modules && !forceMain) return;
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
    const edgeIds = Array.from({ length: graph.edgeCount }, (_, e) => e);
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
