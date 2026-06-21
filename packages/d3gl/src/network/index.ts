/**
 * `@mapequation/d3gl/network` — large-scale network & map-of-networks rendering
 * with level-of-detail (epic #98).
 */
export { network, Network } from "./network.js";
export type { NetworkOptions, NetworkStyle, NetworkLayoutOptions, NetworkLODOptions } from "./network.js";
export type { NodeRadiusSpec, NodeMetric } from "./glyphs.js";

export { buildLODTree, computeLODGeometry, cut } from "./lod.js";
export type { LODTree, LODTransform, CutOptions } from "./lod.js";

export { buildGraph, buildCSR } from "./graph.js";
export type { NetworkGraph, CSR, BuildGraphInput } from "./graph.js";

export { parseEdgeList } from "./parse.js";
export type { ParsedEdges } from "./parse.js";

export { parsePajek, parseNetwork, detectFormat } from "./pajek.js";
export type { ParsedPajek, NetworkFormat } from "./pajek.js";

export { ForceLayout, DEFAULT_FORCE, seedPositions } from "./force.js";
export type { ForceParams, LayoutGraph } from "./force.js";

export { coarsenLevel, buildHierarchy, multilevelLayout } from "./coarsen.js";
export type { CoarseLevel, Hierarchy, CoarsenOptions, MultilevelLayoutOptions } from "./coarsen.js";
