import { BaseEngine, type BaseEngineOptions } from "../map/base-engine.js";
import { nodeCircles, linkLines, linkArrows } from "./glyphs.js";
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

/** How node positions are produced. The worker / GPU backends land in #102 / #106. */
export interface NetworkLayoutOptions {
  /** `"positions"` uses caller-supplied coordinates; `"worker"`/`"gpu"` land later. */
  backend?: "positions" | "worker" | "gpu";
  /** Interleaved `[x, y, …]` world coordinates for `backend: "positions"`. */
  positions?: Float32Array;
}

const DEFAULT_NODE_RADIUS = 4;
const DEFAULT_NODE_FILL = "#4878d0";
const DEFAULT_LINK_WIDTH = 1;
const DEFAULT_LINK_STROKE = "#999999";

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
    if (opts.backend === "positions" && opts.positions && this.graph) {
      this.graph.positions.set(opts.positions);
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
    if (!backend?.setInstancedLayer) return this;

    const nodeRadius = this.styleOpts.nodeRadius ?? DEFAULT_NODE_RADIUS;
    const linkWidth = this.styleOpts.linkWidth ?? DEFAULT_LINK_WIDTH;
    const linkStroke = this.styleOpts.linkStroke ?? DEFAULT_LINK_STROKE;
    const directed = this.styleOpts.directed ?? this.graph.directed;

    // Draw order (insertion order): links under arrows under nodes.
    if (this.graph.edgeCount > 0) {
      backend.setInstancedLayer({
        name: "links",
        primitive: "lines",
        lines: linkLines(this.graph, { width: linkWidth, stroke: linkStroke }),
        sizeMode: "world",
      });
      if (directed) {
        backend.setInstancedLayer({
          name: "arrows",
          primitive: "arrows",
          arrows: linkArrows(this.graph, {
            size: this.styleOpts.arrowSize ?? 3 * linkWidth,
            nodeRadius,
            fill: this.styleOpts.arrowFill ?? linkStroke,
          }),
          sizeMode: "world",
        });
      }
    }
    backend.setInstancedLayer({
      name: "nodes",
      primitive: "circles",
      circles: nodeCircles(this.graph, { radius: nodeRadius, fill: this.styleOpts.nodeFill ?? DEFAULT_NODE_FILL }),
      sizeMode: "world",
    });
    this.render();
    return this;
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
