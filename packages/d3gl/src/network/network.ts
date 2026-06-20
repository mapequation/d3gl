import { BaseEngine, type BaseEngineOptions } from "../map/base-engine.js";
import { networkLayers, emitNodes, emitLinks, emitArrows, type ResolvedNetworkStyle } from "./glyphs.js";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import type { NetworkGraph } from "./graph.js";

/** Options for the network engine. Inherits sizing, `backend`, and `tooltipClass`. */
export interface NetworkOptions extends BaseEngineOptions {}

/** Visual style. Link appearance accessors arrive with the link pass (#100 N2.2). */
export interface NetworkStyle {
  /** Render links with arrowheads. Defaults to the graph's `directed` flag. */
  directed?: boolean;
  /** Node radius in world units. Default 4. */
  nodeRadius?: number;
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
}

/** How node positions are produced. The worker / GPU backends land in later slices. */
export interface NetworkLayoutOptions {
  /** `"positions"` uses caller-supplied coordinates; `"force"` runs the in-library force
   *  layout on the main thread; `"worker"`/`"gpu"` land later. */
  backend?: "positions" | "force" | "worker" | "gpu";
  /** Interleaved `[x, y, …]` world coordinates for `backend: "positions"`. */
  positions?: Float32Array;
  /** Iterations for `backend: "force"` (default 300). */
  iterations?: number;
  /** Force parameters for `backend: "force"`. */
  force?: Partial<ForceParams>;
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

  constructor(host: HTMLElement, opts: NetworkOptions = {}) {
    super(host, opts);
    // Push whatever data exists once the initial backend is ready: data() may be called
    // before whenReady, and a *first* backend install does not fire onBackendSwapped.
    void this.whenReady().then(() => this.rebuild());
  }

  /** Set the graph to render (built via `buildGraph` / `parseEdgeList`). */
  data(graph: NetworkGraph): this {
    this.graph = graph;
    return this.rebuild();
  }

  /** Set visual style (node radius/fill now; link/arrow appearance later). */
  style(style: NetworkStyle): this {
    this.styleOpts = { ...this.styleOpts, ...style };
    return this.rebuild();
  }

  /** Configure layout / supply positions (the pluggable contract proper lands in #101). */
  layout(opts: NetworkLayoutOptions): this {
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    if (this.graph) {
      if (opts.backend === "positions" && opts.positions) {
        this.graph.positions.set(opts.positions);
      } else if (opts.backend === "force") {
        // Main-thread force layout: seed a reproducible disc, then run a fixed schedule.
        // (Off-thread + progressive convergence via a Web Worker is the next slice.)
        seedPositions(this.graph, this.width, this.height);
        new ForceLayout(this.graph, opts.force).run(opts.iterations ?? DEFAULT_FORCE_ITERATIONS);
      }
    }
    return this.rebuild();
  }

  /**
   * Re-emit the instanced node layer to the backend and repaint. A no-op until a graph is
   * set and a backend exposing the instanced lane is live — on non-WebGL backends this
   * simply does nothing (small-N / export go through the PathContext emitter, #100 N2.3).
   */
  private rebuild(): this {
    if (!this.graph) return this;
    const backend = this.backend();
    if (!backend) return this;
    const style = this.resolvedStyle(this.graph);

    if (backend.setInstancedLayer) {
      // WebGL: the instanced lane. Clear any Scene geometry left from a previous
      // non-WebGL backend so a backend switch doesn't double-draw.
      if (this.sceneActive) {
        this.registerNetworkScene(this.graph, style, false);
        this.sceneActive = false;
      }
      const layers = networkLayers(this.graph, style);
      const present = new Set(layers.map((l) => l.name));
      for (const name of LAYER_NAMES) if (!present.has(name)) backend.removeInstancedLayer?.(name);
      for (const layer of layers) backend.setInstancedLayer(layer);
    } else {
      // SVG/Canvas: emit the glyphs through the PathContext seam as Scene layers, so the
      // existing pipeline renders them and toSVG() produces publication output.
      this.registerNetworkScene(this.graph, style, true);
      this.sceneActive = true;
    }
    this.render();
    return this;
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
        if (emit && style.directed) emitArrows(g, graph, style.arrowSize, style.nodeRadius);
      },
    });
    this.registerLayer({
      name: "nodes",
      data: nodeIds,
      ids: nodeIds,
      fill: () => style.nodeFill,
      build: (g) => {
        if (emit) emitNodes(g, graph, style.nodeRadius);
      },
    });
  }

  /** Apply style defaults (drawn order is decided by {@link networkLayers}). */
  private resolvedStyle(graph: NetworkGraph): ResolvedNetworkStyle {
    const linkWidth = this.styleOpts.linkWidth ?? DEFAULT_LINK_WIDTH;
    const linkStroke = this.styleOpts.linkStroke ?? DEFAULT_LINK_STROKE;
    return {
      nodeRadius: this.styleOpts.nodeRadius ?? DEFAULT_NODE_RADIUS,
      nodeFill: this.styleOpts.nodeFill ?? DEFAULT_NODE_FILL,
      linkWidth,
      linkStroke,
      arrowSize: this.styleOpts.arrowSize ?? 3 * linkWidth,
      arrowFill: this.styleOpts.arrowFill ?? linkStroke,
      directed: this.styleOpts.directed ?? graph.directed,
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
