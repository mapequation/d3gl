/**
 * State (higher-order / memory) networks (#171, shared data model with #106).
 *
 * A **state network** is a standard network over **state nodes**, plus a map from each state node to
 * the **physical node** it belongs to (the same location seen in different memory / context). Links are
 * between state nodes; the "physical network" those state links aggregate to is derived here once, so
 * both the rendering toggle (#171) and the module-aware layout (#106) share one substrate.
 *
 * `buildStateGraph` mirrors {@link buildGraph}: the **state-level** graph is a full {@link NetworkGraph}
 * (nodes = state nodes, edges = state edges), and the **physical-level** graph is derived by aggregating
 * state edges across physical boundaries (directed, flow-summed) — the same super-edge aggregation the
 * LOD path already does, applied at the physical boundary. Both are plain SoA/CSR so they cross a worker
 * boundary without copying.
 */
import { buildGraph, type NetworkGraph } from "./graph.js";

export interface BuildStateGraphInput {
  /** Number of state nodes. */
  stateCount: number;
  /**
   * Per-state-node physical id, length `stateCount`. Physical ids must be **dense** in
   * `[0, physicalCount)`; a physical node is a distinct id. (The synthetic generator and Infomap's
   * state output both produce dense ids.)
   */
  stateToPhysical: ArrayLike<number>;
  /** State-level directed edge endpoints (state-node indices), length `edgeCount`. */
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Optional per-edge weight (flow); defaults to 1. */
  weight?: ArrayLike<number>;
  /**
   * Optional per-**state-node** flow (length `stateCount`) — an Infomap visit rate the app supplies.
   * Exposed as the state graph's {@link NetworkGraph.flow}; the physical graph's flow is the per-physical
   * **sum** of its state nodes' flow.
   */
  nodeFlow?: ArrayLike<number>;
  /** Whether links render with arrowheads (applies to both views). Defaults to false. */
  directed?: boolean;
  /**
   * Number of physical nodes. Defaults to `max(stateToPhysical) + 1`. Pass it when some physical node
   * has no state node in this slice (so the physical graph still allocates a slot for it).
   */
  physicalCount?: number;
}

/**
 * Physical node → its state nodes, as CSR. Physical `p`'s state nodes are
 * `states[offsets[p] .. offsets[p + 1]]`. The inverse of {@link StateNetworkGraph.stateToPhysical}.
 */
export interface PhysicalToState {
  /** Per-physical start offset into `states`; length `physicalCount + 1`. */
  offsets: Uint32Array;
  /** Flattened state-node ids grouped by physical node; length `stateCount`. */
  states: Uint32Array;
}

/** A state network plus its engine-derived physical network and the maps between the two levels. */
export interface StateNetworkGraph {
  /** State-level graph: nodes = state nodes, edges = state edges. A full {@link NetworkGraph}. */
  state: NetworkGraph;
  /**
   * Derived physical-level graph: nodes = distinct physical ids; edges = state edges aggregated across
   * physical boundaries (directed, flow-summed). Intra-physical state edges collapse (they are not
   * physical links). `physical.flow` is the per-physical sum of state flow (or null if none supplied).
   */
  physical: NetworkGraph;
  /** state node id → physical node id (dense), length `state.nodeCount`. */
  stateToPhysical: Uint32Array;
  /** physical node id → its state node ids (CSR). */
  physicalToState: PhysicalToState;
  physicalCount: number;
}

/**
 * Assemble a {@link StateNetworkGraph} from a state-level edge list + a per-state-node physical id.
 * The physical network is derived once (its links are the directed, flow-summed aggregation of state
 * edges that cross a physical boundary). Positions in both graphs are left zeroed for layout to fill.
 */
export function buildStateGraph(input: BuildStateGraphInput): StateNetworkGraph {
  const { stateCount } = input;
  const stateToPhysical = Uint32Array.from(input.stateToPhysical);
  if (stateToPhysical.length !== stateCount) {
    throw new Error(
      `buildStateGraph: stateToPhysical length ${stateToPhysical.length} !== stateCount ${stateCount}`,
    );
  }

  // Physical node count: caller-supplied (validated) or one past the largest physical id seen.
  let physicalCount = input.physicalCount ?? 0;
  if (input.physicalCount === undefined) {
    for (let s = 0; s < stateCount; s++) if (stateToPhysical[s]! + 1 > physicalCount) physicalCount = stateToPhysical[s]! + 1;
  } else {
    for (let s = 0; s < stateCount; s++) {
      if (stateToPhysical[s]! >= physicalCount) {
        throw new Error(`buildStateGraph: physical id ${stateToPhysical[s]} out of range [0, ${physicalCount})`);
      }
    }
  }
  // The pair key p·physicalCount + q must stay a safe integer for the aggregation Map to be collision-free.
  if (physicalCount * physicalCount > Number.MAX_SAFE_INTEGER) {
    throw new Error(`buildStateGraph: physicalCount ${physicalCount} too large for pair-keyed aggregation`);
  }

  // State-level graph — a full NetworkGraph over the state nodes.
  const state = buildGraph({
    nodeCount: stateCount,
    source: input.source,
    target: input.target,
    weight: input.weight,
    nodeFlow: input.nodeFlow,
    directed: input.directed,
  });

  // physical → state CSR (count → prefix-sum → scatter), mirroring buildCSR.
  const counts = new Uint32Array(physicalCount);
  for (let s = 0; s < stateCount; s++) counts[stateToPhysical[s]!] = counts[stateToPhysical[s]!]! + 1;
  const offsets = new Uint32Array(physicalCount + 1);
  for (let p = 0; p < physicalCount; p++) offsets[p + 1] = offsets[p]! + counts[p]!;
  const states = new Uint32Array(stateCount);
  const cursor = offsets.slice(0, physicalCount);
  for (let s = 0; s < stateCount; s++) {
    const p = stateToPhysical[s]!;
    states[cursor[p]!] = s;
    cursor[p] = cursor[p]! + 1;
  }

  // Aggregate cross-physical state edges into directed, flow-summed physical links. Intra-physical
  // edges (both endpoints in the same physical node) collapse — they are not physical links. Insertion
  // order into the Map is deterministic, so the physical edge order is stable across runs.
  const edgeCount = state.edgeCount;
  const pairFlow = new Map<number, number>(); // key = p·physicalCount + q → summed flow
  for (let e = 0; e < edgeCount; e++) {
    const p = stateToPhysical[state.source[e]!]!;
    const q = stateToPhysical[state.target[e]!]!;
    if (p === q) continue;
    const key = p * physicalCount + q;
    pairFlow.set(key, (pairFlow.get(key) ?? 0) + state.weight[e]!);
  }
  const physEdgeCount = pairFlow.size;
  const pSource = new Uint32Array(physEdgeCount);
  const pTarget = new Uint32Array(physEdgeCount);
  const pWeight = new Float32Array(physEdgeCount);
  let i = 0;
  for (const [key, w] of pairFlow) {
    pSource[i] = Math.floor(key / physicalCount);
    pTarget[i] = key % physicalCount;
    pWeight[i] = w;
    i++;
  }

  // Physical node flow = the per-physical sum of state-node flow (only when state flow was supplied).
  let physFlow: Float32Array | undefined;
  if (state.flow) {
    physFlow = new Float32Array(physicalCount);
    for (let s = 0; s < stateCount; s++) physFlow[stateToPhysical[s]!] = physFlow[stateToPhysical[s]!]! + state.flow[s]!;
  }

  const physical = buildGraph({
    nodeCount: physicalCount,
    source: pSource,
    target: pTarget,
    weight: pWeight,
    nodeFlow: physFlow,
    directed: input.directed,
  });

  return { state, physical, stateToPhysical, physicalToState: { offsets, states }, physicalCount };
}
