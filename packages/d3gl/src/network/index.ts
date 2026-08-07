/**
 * Large-scale network and map-of-networks rendering. The {@link network} engine draws
 * node–link graphs as GPU-instanced glyphs — toward millions of nodes and links — with an
 * in-library force layout ({@link ForceLayout}; main-thread, worker, or GPU backend), an
 * adaptive level-of-detail cut over a coarsening or provided module hierarchy
 * ({@link Network.lod}), and state (memory) networks ({@link buildStateGraph}).
 * {@link buildGraph} assembles the graph from an edge list.
 *
 * ```ts
 * import { network, buildGraph } from "@mapequation/d3gl/network";
 *
 * const graph = buildGraph({ nodeCount, source, target });
 * network(el, { width, height }).data(graph).layout({ backend: "worker" });
 * ```
 *
 * @packageDocumentation
 */
export { network, Network } from "./network.js";
export type { NetworkOptions, NetworkStyle, NetworkLayoutOptions, NetworkLODOptions, NetworkHit, NetworkLinkHit, StateNetworkOptions } from "./network.js";
export type { NodeRadiusSpec, NodeMetric, ImportanceSpec, FlowBorderSpec, LinkWidthSpec, LinkColorSpec, LinkStyle } from "./glyphs.js";

export { halfLinkGeometry, traceHalfLink, halfLinkPathString, scaleHalfLink } from "./half-link.js";
export type { HalfLinkParams, HalfLinkGeometry, PathSink } from "./half-link.js";

export { randomWalkFlow } from "./flow.js";
export type { FlowGraph, FlowOptions, FlowResult } from "./flow.js";

export { buildLODTree, computeLODGeometry, cut, defaultExpandPx, makeCutScratch, declutterFrontier, makeDeclutterFrontierScratch } from "./lod.js";
export type { LODTree, LODTransform, CutOptions, CutScratch, DeclutterOptions, DeclutterFrontierScratch } from "./lod.js";

export { buildModuleLODTree } from "./modules.js";
export type { ModuleNode } from "./modules.js";

export { moduleColors } from "./module-colors.js";
export type { ModulePathNode, ModuleColorOptions } from "./module-colors.js";

export { buildGraph, buildCSR } from "./graph.js";
export type { NetworkGraph, CSR, BuildGraphInput } from "./graph.js";

export { buildStateGraph } from "./state-graph.js";
export type { BuildStateGraphInput, StateNetworkGraph, PhysicalToState } from "./state-graph.js";

export { rosettePositions } from "./rosette.js";
export type { RosetteOptions } from "./rosette.js";

export { physicalPieWedges } from "./pie.js";
export type { PieWedgeOptions, PhysicalPieWedges } from "./pie.js";

export { parseEdgeList } from "./parse.js";
export type { ParsedEdges } from "./parse.js";

export { parsePajek, parseNetwork, detectFormat } from "./pajek.js";
export type { ParsedPajek, NetworkFormat } from "./pajek.js";

export { ForceLayout, DEFAULT_FORCE, seedPositions } from "./force.js";
export type { ForceParams, LayoutGraph } from "./force.js";

export { coarsenLevel, buildHierarchy, multilevelLayout } from "./coarsen.js";
export type { CoarseLevel, Hierarchy, CoarsenOptions, MultilevelLayoutOptions } from "./coarsen.js";

export { sharedMemoryAvailable } from "./worker-transport.js";
