import { BaseEngine, type BaseEngineOptions } from "../map/base-engine.js";
import type { NetworkGraph } from "./graph.js";

/** Options for the network engine. Inherits sizing, `backend`, and `tooltipClass`. */
export interface NetworkOptions extends BaseEngineOptions {}

/** Visual style. Node/link appearance accessors are filled in as rendering lands (#100). */
export interface NetworkStyle {
  /** Render links with arrowheads. Defaults to the graph's `directed` flag. */
  directed?: boolean;
}

/** How node positions are produced. The worker / GPU backends land in #102 / #106. */
export interface NetworkLayoutOptions {
  /** `"positions"` uses caller-supplied coordinates; `"worker"`/`"gpu"` land later. */
  backend?: "positions" | "worker" | "gpu";
  /** Interleaved `[x, y, …]` world coordinates for `backend: "positions"`. */
  positions?: Float32Array;
}

/**
 * The network rendering engine (epic #98). A dedicated engine — nodes, links,
 * layout, and LOD are one coupled system, not independent layers — built on the
 * shared {@link BaseEngine} host/transform/zoom/interaction shell.
 *
 * This slice (#107) is the scaffold: it mounts a backend and defines the public
 * surface. Instanced rendering (#100), the layout contract (#101), and LOD (#103)
 * fill in the behavior; today the engine holds data but draws nothing yet.
 */
export class Network extends BaseEngine {
  private graph: NetworkGraph | null = null;
  private styleOpts: NetworkStyle = {};
  private layoutOpts: NetworkLayoutOptions = {};

  constructor(host: HTMLElement, opts: NetworkOptions = {}) {
    super(host, opts);
  }

  /** Set the graph to render (built via `buildGraph` / `parseEdgeList`). */
  data(graph: NetworkGraph): this {
    this.graph = graph;
    return this;
  }

  /** Set visual style (directed arrows; node/link appearance later). */
  style(style: NetworkStyle): this {
    this.styleOpts = { ...this.styleOpts, ...style };
    return this;
  }

  /** Configure layout / supply positions (the pluggable contract proper lands in #101). */
  layout(opts: NetworkLayoutOptions): this {
    this.layoutOpts = { ...this.layoutOpts, ...opts };
    if (opts.backend === "positions" && opts.positions && this.graph) {
      this.graph.positions.set(opts.positions);
    }
    return this;
  }
}

/** Create a {@link Network} engine on `host`. */
export function network(host: HTMLElement, opts: NetworkOptions = {}): Network {
  return new Network(host, opts);
}
