/**
 * `@mapequation/d3gl/network` — large-scale network & map-of-networks rendering
 * with level-of-detail (epic #98).
 */
export { network, Network } from "./network.js";
export type { NetworkOptions, NetworkStyle, NetworkLayoutOptions, NetworkLODOptions, NetworkHit } from "./network.js";
export type { NodeRadiusSpec, NodeMetric, ImportanceSpec, FlowBorderSpec, LinkWidthSpec, LinkColorSpec, LinkStyle } from "./glyphs.js";

export { halfLinkGeometry, traceHalfLink, halfLinkPathString, scaleHalfLink } from "./half-link.js";
export type { HalfLinkParams, HalfLinkGeometry, PathSink } from "./half-link.js";

export { randomWalkFlow } from "./flow.js";
export type { FlowGraph, FlowOptions, FlowResult } from "./flow.js";

export { buildLODTree, computeLODGeometry, cut, declutterFrontier } from "./lod.js";
export type { LODTree, LODTransform, CutOptions, DeclutterOptions } from "./lod.js";

export { buildModuleLODTree } from "./modules.js";
export type { ModuleNode } from "./modules.js";

export { moduleColors } from "./module-colors.js";
export type { ModulePathNode, ModuleColorOptions } from "./module-colors.js";

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
