import { BaseEngine, type BaseEngineOptions } from "../map/base-engine.js";
import { networkLayers, frontierCircles, frontierHalos, superEdges, emitNodes, emitLinks, emitArrows, emitHalfLinks, resolveNodeRadii, resolveNodeRadiusAggregate, resolveFlowBorder, resolveNodeColors, resolveLinkWidthOf, resolveLinkColorOf, flowBorderInnerRadii, type ResolvedNetworkStyle, type NodeRadiusSpec, type FlowBorderSpec, type ConstBorder, type LinkWidthSpec, type LinkColorSpec, type LinkStyle } from "./glyphs.js";
import { rgb } from "d3-color";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { buildLODTree, buildSpatialLODTree, computeLODGeometry, computeLODStyle, cut, declutterFrontier, visibleWorldRect, type LODTree, type SpatialLODOptions } from "./lod.js";
import { buildModuleLODTree, type ModuleNode } from "./modules.js";
import { startWorkerLayout, type WorkerLayoutHandle } from "./worker-transport.js";
import type { NetworkGraph } from "./graph.js";
import type { Backend, InstancedLayer, ViewTransform } from "../core/index.js";

/** Options for the network engine. Inherits sizing, `backend`, and `tooltipClass`. */
export interface NetworkOptions extends BaseEngineOptions {}

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
 * only the visible frontier. Best paired with `style({ sizeMode: "screen" })`. Requires the WebGL
 * (instanced) backend.
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
  /** Cached resolved style; invalidated on style()/data() to avoid per-zoom O(n) radii recompute. */
  private resolvedCache: ResolvedNetworkStyle | null = null;

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
        if (this.lodSpatial) this.lodTree = null;
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
      // WebGL: the instanced lane. Clear any Scene geometry left from a previous
      // non-WebGL backend so a backend switch doesn't double-draw.
      if (this.sceneActive) {
        this.registerNetworkScene(this.graph, style, false);
        this.sceneActive = false;
      }
      let layers: InstancedLayer[];
      if (this.lodReady()) {
        layers = this.lodLayers(this.lodTree!, style); // cut frontier (cost ∝ visible)
      } else if (this.lodOptions && this.layoutOpts.backend === "worker") {
        // LOD is on, worker backend, no tree yet — draw nothing rather than the full graph (the very
        // O(N) draw LOD exists to avoid at scale). A streaming run will populate the tree shortly; if
        // none is in flight (LOD toggled on after a run settled), build one on the main thread,
        // deferred a microtask so an imminent layout() in the same chain takes the streaming path.
        layers = [];
        this.scheduleLODFallback();
      } else {
        layers = networkLayers(this.graph, style); // no LOD: the full graph
      }
      this.emitInstancedLayers(backend, layers);
    } else {
      // SVG/Canvas: emit the glyphs through the PathContext seam as Scene layers, so the
      // existing pipeline renders them and toSVG() produces publication output. (LOD is a
      // WebGL-scale feature; vector backends always draw the full graph.)
      this.registerNetworkScene(this.graph, style, true);
      this.sceneActive = true;
    }
    this.render();
    return this;
  }

  /**
   * Push the instanced layers in canonical draw order. The backend draws them in Map-insertion
   * order, and updating an existing layer keeps its slot — so to guarantee links/arrows stay *under*
   * nodes regardless of the order layers first appeared, clear the known layers and re-add in
   * `layers` order (built bottom-to-top). No extra cost: `setInstancedLayer` recreates each layer's
   * buffers either way; this just also frees the slots of any now-absent layer.
   */
  private emitInstancedLayers(backend: Backend, layers: InstancedLayer[]): void {
    for (const name of LAYER_NAMES) backend.removeInstancedLayer?.(name);
    for (const layer of layers) backend.setInstancedLayer!(layer);
  }

  /** Whether the LOD cut can run (enabled, tree built, geometry computed at least once). */
  private lodReady(): boolean {
    return !!(this.lodOptions && this.lodHasGeometry && this.lodTree);
  }

  /**
   * Build the instanced layers for the current LOD cut frontier at the live transform. Cost ∝ the
   * visible frontier, not the graph size. (Nodes now; super-edges + frontier declutter follow.)
   */
  private lodLayers(tree: LODTree, style: ResolvedNetworkStyle): InstancedLayer[] {
    const opts = this.lodOptions!;
    let frontier = cut(tree, this.transform, this.width, this.height, {
      expandPx: opts.expandPx,
      screenSized: style.sizeMode === "screen",
      maxAggregateRadius: opts.maxAggregateRadius,
    });
    if (opts.declutter !== false) {
      frontier = declutterFrontier(tree, frontier, this.transform, this.width, this.height, {
        screenSized: style.sizeMode === "screen",
        k: this.transform.k,
        maxAggregateRadius: opts.maxAggregateRadius,
        spacing: opts.declutterSpacing,
      });
    }
    const layers: InstancedLayer[] = [];
    // Super-edges first (drawn under the nodes), among the visible frontier only.
    if (opts.superEdges !== false && this.graph!.edgeCount > 0) {
      // One super-edge path for both structural and module trees: gathered from the flow-weighted
      // super-edge CSR and rendered per linkStyle — fused half-arrows, or bent/straight lines +
      // (directed) arrowheads, the same glyph the non-LOD path uses. A node keeps edges to on-frontier
      // or off-screen neighbours (the same visible rect the cut uses); both half-arrow and line
      // arrowheads honour sizeMode in-shader (the tip sets back to the node boundary in either space).
      const { halfArrows, lines, arrows } = superEdges(
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
        },
        visibleWorldRect(this.transform, this.width, this.height),
      );
      if (halfArrows && halfArrows.count > 0) layers.push({ name: "links", primitive: "half-arrows", halfArrows, sizeMode: style.sizeMode });
      if (lines && lines.count > 0) layers.push({ name: "links", primitive: "lines", lines, sizeMode: style.sizeMode });
      if (arrows && arrows.count > 0) layers.push({ name: "arrows", primitive: "arrows", arrows, sizeMode: style.sizeMode });
    }
    // Aggregate-outline affordance: a halo ring behind collapsed-module glyphs (not leaves), under the
    // nodes, so a module reads as expandable. WebGL/LOD-only (the vector full-graph draw has no aggregates).
    if (opts.aggregateOutline) {
      const halos = frontierHalos(tree, frontier, {
        width: opts.aggregateOutline.width ?? 1.5,
        gap: opts.aggregateOutline.gap ?? 2.5,
        color: opts.aggregateOutline.color ?? "#3a3f52",
        maxAggregateRadius: opts.maxAggregateRadius,
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
    if (this.lodWorkerTree) {
      computeLODStyle(this.lodWorkerTree, nodeRadii, this.graph.strength, leafBorder, leafColors, radiusAggregate);
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
    computeLODGeometry(this.lodTree, this.graph, nodeRadii, undefined, leafBorder, leafColors, radiusAggregate);
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
   * Re-cut the LOD frontier for the new view, then let the base engine push the transform and
   * repaint. The cut is the only per-frame work LOD adds, and it's bounded by the visible set.
   */
  override setTransform(t: ViewTransform): this {
    const backend = this.backend();
    if (backend?.setInstancedLayer && this.lodReady() && this.graph) {
      this.transform = t; // the cut reads the live transform to compute the visible world rect
      this.emitInstancedLayers(backend, this.lodLayers(this.lodTree!, this.resolvedStyleCached(this.graph)));
    }
    return super.setTransform(t);
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
      sizeMode: style.sizeMode,
      fill: (e) => linkColorAt(e as number),
      build: (g) => {
        if (emit && style.directed && !halfArrow) emitArrows(g, graph, style.arrowSize, style.nodeRadii, style.linkBend, style.linkBend !== 0);
      },
    });
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

  /** Resolved style, memoised until style()/data() invalidates it (radii resolution is O(n)). */
  private resolvedStyleCached(graph: NetworkGraph): ResolvedNetworkStyle {
    return (this.resolvedCache ??= this.resolvedStyle(graph));
  }

  /** Apply style defaults (drawn order is decided by {@link networkLayers}). */
  private resolvedStyle(graph: NetworkGraph): ResolvedNetworkStyle {
    // linkWidth: a constant, a (weight)=>width scale, or {by,scale}. `linkWidthOf` is the per-edge
    // function; `linkWidth` is a representative scalar, used only for the arrow-size default now (the
    // super-edges size per-edge by accumulated flow, so there's no uniform-width path to mis-scale).
    const lwSpec = this.styleOpts.linkWidth ?? DEFAULT_LINK_WIDTH;
    const linkWidthOf = resolveLinkWidthOf(lwSpec);
    const linkWidth = typeof lwSpec === "number" ? lwSpec : linkWidthOf(1) || DEFAULT_LINK_WIDTH;
    // linkStroke: a single colour, or a (weight)=>colour scale. `linkColorOf` packs RGBA bytes for
    // the WebGL lane; `linkStrokeOf` gives the CSS for the Scene path; `linkStroke` is representative.
    const lsSpec: LinkColorSpec = this.styleOpts.linkStroke ?? DEFAULT_LINK_STROKE;
    const linkColorOf = resolveLinkColorOf(lsSpec);
    const linkStrokeOf = typeof lsSpec === "function" ? lsSpec : () => lsSpec;
    const linkStroke = typeof lsSpec === "function" ? linkStrokeOf(1) : lsSpec;
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
      nodeFill,
      nodeColors,
      linkWidth,
      linkWidthOf,
      linkStroke,
      linkColorOf,
      linkStrokeOf,
      linkStyle: this.styleOpts.linkStyle ?? "line",
      arrowSize: this.styleOpts.arrowSize ?? 3 * linkWidth,
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
