import { BaseEngine, type BaseEngineOptions } from "../map/base-engine.js";
import { networkLayers, frontierCircles, superEdgeLines, emitNodes, emitLinks, emitArrows, resolveNodeRadii, type ResolvedNetworkStyle, type NodeRadiusSpec } from "./glyphs.js";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier, type LODTree } from "./lod.js";
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
  /** Node fill colour (any CSS color). Default a medium blue. */
  nodeFill?: string;
  /** Link width in world units. Default 1. */
  linkWidth?: number;
  /** Link stroke colour (any CSS color). Default a light grey. */
  linkStroke?: string;
  /** Arrowhead size (world units) for directed links. Default 3 × linkWidth. */
  arrowSize?: number;
  /** Arrowhead colour. Default matches linkStroke. */
  arrowFill?: string;
  /**
   * `"world"` (default) — glyph sizes are in world units and scale with zoom. `"screen"` — sizes are
   * constant pixels regardless of zoom: the natural register for navigating a large layout (nodes
   * stay visible when zoomed out instead of going sub-pixel), and what LOD wants. `nodeRadius` /
   * `linkWidth` are then read as pixels. (Arrowheads stay world-sized for now, #103.)
   */
  sizeMode?: "world" | "screen";
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
   * Draw **super-edges**: links between visible frontier nodes (leaf↔leaf via the graph, aggregate↔
   * aggregate via the coarse adjacency), summarising connectivity at the current LOD. Uses
   * `linkWidth`/`linkStroke`. Default `true`. (Same-level pairs only for now; see {@link superEdgeLines}.)
   */
  superEdges?: boolean;
  /** Coarsening granularity for the LOD tree (depth / minimum aggregate size). */
  coarsen?: CoarsenOptions;
}

const DEFAULT_NODE_RADIUS = 4;
const DEFAULT_NODE_FILL = "#4878d0";
const DEFAULT_LINK_WIDTH = 1;
const DEFAULT_LINK_STROKE = "#999999";
const LAYER_NAMES = ["links", "arrows", "nodes"] as const;
const DEFAULT_FORCE_ITERATIONS = 300;

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
    this.lodHasGeometry = false;
    this.resolvedCache = null;
    return this.rebuild();
  }

  /** Set visual style (node radius/fill/sizeMode; link & arrow appearance). */
  style(style: NetworkStyle): this {
    this.styleOpts = { ...this.styleOpts, ...style };
    this.resolvedCache = null; // radii/colours/sizeMode changed
    if (this.lodOptions) this.recomputeLODGeometry(); // node radii feed the LOD tree's draw radii
    return this.rebuild();
  }

  /**
   * Enable (or, with `false`, disable) level-of-detail rendering (#103) — an adaptive hierarchy cut
   * that draws dense regions as aggregate glyphs and expands them into members as you zoom, so
   * per-frame work tracks the visible frontier rather than the whole graph. Requires the WebGL
   * backend. The tree's geometry follows the layout as it converges (re-cut cheaply on zoom).
   */
  lod(options: NetworkLODOptions | false): this {
    if (!options) {
      this.lodOptions = null;
      this.lodTree = null;
      this.lodHasGeometry = false;
      return this.rebuild();
    }
    this.lodOptions = options;
    this.recomputeLODGeometry(); // builds the tree + geometry from whatever positions exist now
    return this.rebuild();
  }

  /** Configure layout / supply positions (the pluggable contract proper lands in #101). */
  layout(opts: NetworkLayoutOptions): this {
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    if (this.graph) {
      // Any backend change cancels a running worker layout before re-seeding positions.
      this.stopLayout();
      if (opts.backend === "positions" && opts.positions) {
        this.graph.positions.set(opts.positions);
        this.recomputeLODGeometry(); // caller-supplied coordinates are final immediately
      } else if (opts.backend === "worker") {
        // Off-thread force layout with progressive convergence. The worker can post a frame per
        // tick, so coalesce repaints to one per animation frame (always painting the freshest
        // positions) to bound main-thread work at large N.
        this.layoutHandle = startWorkerLayout(
          this.graph,
          {
            width: this.width,
            height: this.height,
            iterations: opts.iterations ?? DEFAULT_FORCE_ITERATIONS,
            force: opts.force,
            multilevel: opts.multilevel,
          },
          () => this.scheduleLayoutRepaint(),
        );
        // Final refresh on settle (the last streamed frame may land before the resolve).
        const handle = this.layoutHandle;
        void handle.settled.then(() => {
          if (this.layoutHandle !== handle) return; // a newer layout superseded this one
          this.recomputeLODGeometry();
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
   * Coalesce progressive worker frames into at most one repaint per animation frame. Each frame the
   * positions changed, so the LOD geometry is refreshed before the cut — LOD tracks the layout *as
   * it converges*, not only once settled.
   */
  private scheduleLayoutRepaint(): void {
    if (this.layoutRepaintRaf) return;
    const raf: (cb: FrameRequestCallback) => number =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 16);
    this.layoutRepaintRaf = raf(() => {
      this.layoutRepaintRaf = 0;
      this.recomputeLODGeometry();
      this.rebuild();
    });
  }

  /** Stop a running worker layout (no-op if none). The last computed positions are kept. */
  stopLayout(): this {
    this.layoutHandle?.stop();
    this.layoutHandle = null;
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
      this.emitInstancedLayers(
        backend,
        this.lodReady() ? this.lodLayers(this.lodTree!, style) : networkLayers(this.graph, style),
      );
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

  /** Push a set of instanced layers, removing any of the known layers no longer present. */
  private emitInstancedLayers(backend: Backend, layers: InstancedLayer[]): void {
    const present = new Set(layers.map((l) => l.name));
    for (const name of LAYER_NAMES) if (!present.has(name)) backend.removeInstancedLayer?.(name);
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
    let frontier = cut(tree, this.transform, this.width, this.height, { expandPx: opts.expandPx });
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
      const lines = superEdgeLines(this.graph!, tree, frontier, { width: style.linkWidth, stroke: style.linkStroke });
      if (lines.count > 0) layers.push({ name: "links", primitive: "lines", lines, sizeMode: style.sizeMode });
    }
    const circles = frontierCircles(tree, frontier, {
      nodeFill: style.nodeFill,
      aggregateFill: opts.aggregateFill ?? style.nodeFill,
      maxAggregateRadius: opts.maxAggregateRadius,
    });
    layers.push({ name: "nodes", primitive: "circles", circles, sizeMode: style.sizeMode });
    return layers;
  }

  /**
   * (Re)compute the LOD tree's geometry from the *current* positions + style. Called whenever
   * positions move (every streamed worker frame, a sync solve) or the style's radii change — so LOD
   * tracks the layout as it converges. No-op when LOD is off. O(tree size); the zoom-time cut does
   * not call this (it reuses the geometry).
   */
  private recomputeLODGeometry(): void {
    if (!this.lodOptions || !this.graph) return;
    if (!this.lodTree) this.lodTree = buildLODTree(this.graph, this.lodOptions.coarsen);
    computeLODGeometry(this.lodTree, this.graph, this.resolvedStyleCached(this.graph).nodeRadii);
    this.lodHasGeometry = true;
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
   * Register the network as retained Scene layers (links under arrows under nodes) via the
   * PathContext glyph emitters. With `emit: false` the layers are registered empty — used to
   * clear tessellated geometry when switching to the WebGL instanced lane.
   */
  private registerNetworkScene(graph: NetworkGraph, style: ResolvedNetworkStyle, emit: boolean): void {
    const edgeIds = Array.from({ length: graph.edgeCount }, (_, e) => e);
    const nodeIds = Array.from({ length: graph.nodeCount }, (_, i) => i);
    this.registerLayer({
      name: "links",
      data: edgeIds,
      ids: edgeIds,
      stroke: () => style.linkStroke,
      build: (g) => {
        if (emit) emitLinks(g, graph, style.linkWidth);
      },
    });
    this.registerLayer({
      name: "arrows",
      data: edgeIds,
      ids: edgeIds,
      fill: () => style.arrowFill,
      build: (g) => {
        if (emit && style.directed) emitArrows(g, graph, style.arrowSize, style.nodeRadii);
      },
    });
    this.registerLayer({
      name: "nodes",
      data: nodeIds,
      ids: nodeIds,
      fill: () => style.nodeFill,
      build: (g) => {
        if (emit) emitNodes(g, graph, style.nodeRadii);
      },
    });
  }

  /** Resolved style, memoised until style()/data() invalidates it (radii resolution is O(n)). */
  private resolvedStyleCached(graph: NetworkGraph): ResolvedNetworkStyle {
    return (this.resolvedCache ??= this.resolvedStyle(graph));
  }

  /** Apply style defaults (drawn order is decided by {@link networkLayers}). */
  private resolvedStyle(graph: NetworkGraph): ResolvedNetworkStyle {
    const linkWidth = this.styleOpts.linkWidth ?? DEFAULT_LINK_WIDTH;
    const linkStroke = this.styleOpts.linkStroke ?? DEFAULT_LINK_STROKE;
    return {
      nodeRadii: resolveNodeRadii(graph, this.styleOpts.nodeRadius ?? DEFAULT_NODE_RADIUS),
      nodeFill: this.styleOpts.nodeFill ?? DEFAULT_NODE_FILL,
      linkWidth,
      linkStroke,
      arrowSize: this.styleOpts.arrowSize ?? 3 * linkWidth,
      arrowFill: this.styleOpts.arrowFill ?? linkStroke,
      directed: this.styleOpts.directed ?? graph.directed,
      sizeMode: this.styleOpts.sizeMode ?? "world",
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
