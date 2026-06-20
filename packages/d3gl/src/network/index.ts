/**
 * `@mapequation/d3gl/network` — large-scale network & map-of-networks rendering
 * with level-of-detail (epic #98).
 */
export { network, Network } from "./network.js";
export type { NetworkOptions, NetworkStyle, NetworkLayoutOptions } from "./network.js";

export { buildGraph, buildCSR } from "./graph.js";
export type { NetworkGraph, CSR, BuildGraphInput } from "./graph.js";

export { parseEdgeList } from "./parse.js";
export type { ParsedEdges } from "./parse.js";

export { ForceLayout, DEFAULT_FORCE } from "./force.js";
export type { ForceParams } from "./force.js";
