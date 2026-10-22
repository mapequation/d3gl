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
import type { ModulePathNode } from "./module-colors.js";
import { flattenModuleLinks, flattenModuleRecords, type ModuleLink } from "./modules.js";
import { modulePrefixTree, resolveLinkPaths } from "./module-topology.js";

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

  const physical = mergeGroups(state, stateToPhysical, physicalCount);
  return { state, physical, stateToPhysical, physicalToState: groupMembers(stateToPhysical, physicalCount), physicalCount };
}

/**
 * Each group's members as CSR (count → prefix-sum → scatter, mirroring buildCSR): group `g`'s members are
 * `states[offsets[g] .. offsets[g + 1]]`, in id order.
 */
function groupMembers(groupOf: Uint32Array, groupCount: number): PhysicalToState {
  const n = groupOf.length;
  const counts = new Uint32Array(groupCount);
  for (let s = 0; s < n; s++) counts[groupOf[s]!] = counts[groupOf[s]!]! + 1;
  const offsets = new Uint32Array(groupCount + 1);
  for (let g = 0; g < groupCount; g++) offsets[g + 1] = offsets[g]! + counts[g]!;
  const states = new Uint32Array(n);
  const cursor = offsets.slice(0, groupCount);
  for (let s = 0; s < n; s++) {
    const g = groupOf[s]!;
    states[cursor[g]!] = s;
    cursor[g] = cursor[g]! + 1;
  }
  return { offsets, states };
}

/**
 * Merge `graph`'s nodes into their groups: the links between two groups are summed into one directed link per
 * (group, group) pair, the links inside a group collapse, and a group's flow is the sum of its members' (null
 * when `graph` has none). The physical graph merges the state nodes by physical node, the lumped graph by
 * (leaf module, physical node) (#529). `groupCount²` must be a safe integer: the callers check it.
 */
function mergeGroups(graph: NetworkGraph, groupOf: Uint32Array, groupCount: number): NetworkGraph {
  // Insertion order into the Map is deterministic, so the merged edge order is stable across runs.
  const pairFlow = new Map<number, number>(); // key = p·groupCount + q → summed flow
  for (let e = 0; e < graph.edgeCount; e++) {
    const p = groupOf[graph.source[e]!]!;
    const q = groupOf[graph.target[e]!]!;
    if (p === q) continue;
    const key = p * groupCount + q;
    pairFlow.set(key, (pairFlow.get(key) ?? 0) + graph.weight[e]!);
  }
  const edgeCount = pairFlow.size;
  const source = new Uint32Array(edgeCount);
  const target = new Uint32Array(edgeCount);
  const weight = new Float32Array(edgeCount);
  let i = 0;
  for (const [key, w] of pairFlow) {
    source[i] = Math.floor(key / groupCount);
    target[i] = key % groupCount;
    weight[i] = w;
    i++;
  }
  let flow: Float32Array | undefined;
  if (graph.flow) {
    flow = new Float32Array(groupCount);
    for (let s = 0; s < graph.nodeCount; s++) flow[groupOf[s]!] = flow[groupOf[s]!]! + graph.flow[s]!;
  }
  return buildGraph({ nodeCount: groupCount, source, target, weight, nodeFlow: flow, directed: graph.directed });
}

/**
 * A state network with each physical node's state nodes in one leaf module **lumped** into one node (#529): the
 * map equation codes them with one codeword in that module, and Infomap's physical tree merges them the same way.
 */
export interface LumpedStateNetwork {
  /**
   * The lumped network. Its state level has one node, a **lump**, per (leaf module, physical node); a physical
   * node's lumps have consecutive ids. Its physical level is the source network's `physical` graph, the same
   * object: lumping only splits the physical grouping further, so merging the lumps by physical node gives it back.
   */
  graph: StateNetworkGraph;
  /** Each lump's module record: its leaf module's path, then its rank in that module (by flow, then by id). Null
   *  when lumped without modules. */
  modules: ModulePathNode[] | null;
  /** The module links given to {@link lumpStateGraph} in the lumps' hierarchy (#533): a module endpoint keeps its
   *  path, a leaf endpoint (a state node) becomes the path of the lump that holds it. Null when none were given. */
  moduleLinks: ModuleLink[] | null;
  /** state node id → its lump id, length `stateCount`. */
  stateToLump: Uint32Array;
  /** lump id → its state node ids (CSR). */
  lumpToState: PhysicalToState;
}

/**
 * Lump `sg`'s state nodes by (leaf module, physical node) (#529), with `modules` a record per state node (Infomap's
 * `nodes` shape; the leaf module is the record's path less its last entry). Without `modules` every state node is
 * in the root module, so each physical node's state nodes are one lump: the lumped network is the physical one. A
 * lump's links are the summed links of its state nodes to other lumps, its flow the sum of theirs: the same merge as
 * the physical graph's. O(state nodes + state links + lumps · log lumps).
 *
 * With `moduleLinks` (#533, addressed by path in `modules`' hierarchy) the result carries them in the lumps'
 * hierarchy ({@link LumpedStateNetwork.moduleLinks}); they require `modules`, and an endpoint outside it throws.
 * O(state nodes · depth + links · depth) more.
 */
export function lumpStateGraph(sg: StateNetworkGraph, modules?: ArrayLike<ModulePathNode> | null, moduleLinks?: ArrayLike<ModuleLink> | null): LumpedStateNetwork {
  const stateCount = sg.state.nodeCount;
  if (moduleLinks && !modules) throw new Error("lumpStateGraph: moduleLinks requires modules");
  // Each state node's leaf-module key: "" (the root) for all without modules, else from its record.
  const leafOf = new Array<string | undefined>(stateCount).fill(modules ? undefined : "");
  for (let r = 0; modules && r < modules.length; r++) {
    const { id, path } = modules[r]!;
    if (!(id >= 0 && id < stateCount)) throw new Error(`lumpStateGraph: module record id ${id} out of range`);
    let leaf = "";
    for (let k = 0; k < path.length - 1; k++) leaf += k === 0 ? `${path[k]}` : `:${path[k]}`;
    leafOf[id] = leaf;
  }
  // Lumps numbered physical node by physical node, as the pies group them (#171): a physical node's lumps are
  // consecutive, so the lumped network's physical → lump CSR is a running count.
  const { offsets, states } = sg.physicalToState;
  const physicalCount = sg.physicalCount;
  const stateToLump = new Uint32Array(stateCount);
  const lumpOffsets = new Uint32Array(physicalCount + 1);
  const lumpLeaf: string[] = [];
  const lumpPhysical: number[] = [];
  for (let p = 0; p < physicalCount; p++) {
    const lumps = new Map<string, number>();
    for (let i = offsets[p]!; i < offsets[p + 1]!; i++) {
      const s = states[i]!;
      const leaf = leafOf[s];
      if (leaf === undefined) throw new Error(`lumpStateGraph: no module record for state node ${s} (must cover every state node)`);
      let lump = lumps.get(leaf);
      if (lump === undefined) {
        lump = lumpLeaf.length;
        lumps.set(leaf, lump);
        lumpLeaf.push(leaf);
        lumpPhysical.push(p);
      }
      stateToLump[s] = lump;
    }
    lumpOffsets[p + 1] = lumpLeaf.length;
  }
  const lumpCount = lumpLeaf.length;
  if (lumpCount * lumpCount > Number.MAX_SAFE_INTEGER) {
    throw new Error(`lumpStateGraph: ${lumpCount} lumps too large for pair-keyed aggregation`);
  }
  const state = mergeGroups(sg.state, stateToLump, lumpCount);
  const lumpToState = groupMembers(stateToLump, lumpCount);

  const size = (l: number): number => state.flow ? state.flow[l]! : lumpToState.offsets[l + 1]! - lumpToState.offsets[l]!;
  const records = modules ? lumpRecords(lumpLeaf, size) : null;

  const graph: StateNetworkGraph = {
    state,
    physical: sg.physical,
    stateToPhysical: Uint32Array.from(lumpPhysical),
    physicalToState: { offsets: lumpOffsets, states: Uint32Array.from({ length: lumpCount }, (_, l) => l) },
    physicalCount,
  };
  const links = modules && records && moduleLinks ? lumpModuleLinks(stateCount, modules, moduleLinks, stateToLump, records) : null;
  return { graph, modules: records, moduleLinks: links, stateToLump, lumpToState };
}

/**
 * `links` (addressed by path in `modules`' hierarchy) in the lumps' hierarchy (#533): a module endpoint keeps its path,
 * which the lumps' records spell too; a leaf endpoint, a state node, becomes the path of its lump (`stateToLump`,
 * `lumpRecords`). Endpoints resolve as the module tree resolves them ({@link resolveLinkPaths}), so one outside the
 * hierarchy throws. O(state nodes · depth + links · depth).
 */
function lumpModuleLinks(
  stateCount: number,
  modules: ArrayLike<ModulePathNode>,
  links: ArrayLike<ModuleLink>,
  stateToLump: Uint32Array,
  lumpRecords: readonly ModulePathNode[],
): ModuleLink[] {
  if (links.length === 0) return [];
  const { moduleChild, leafModule, leafRank } = modulePrefixTree(stateCount, flattenModuleRecords(stateCount, modules, "lumpStateGraph"));
  // A module resolves to `stateCount` + its index, a leaf to its state node.
  const resolve = resolveLinkPaths(moduleChild, Uint32Array.from(moduleChild.keys(), (m) => stateCount + m), leafModule, leafRank, "lumpStateGraph");
  const flat = flattenModuleLinks(links);
  const endpoint = (path: ArrayLike<number>, entries: Int32Array, offset: Uint32Array, l: number): ArrayLike<number> => {
    const id = resolve(entries, offset[l] ?? 0, offset[l + 1] ?? 0);
    return id < stateCount ? (lumpRecords[stateToLump[id] ?? 0]?.path ?? path) : path;
  };
  const out = new Array<ModuleLink>(links.length);
  for (let l = 0; l < links.length; l++) {
    const link = links[l];
    if (!link) throw new Error(`lumpStateGraph: no module link at index ${l}`);
    out[l] = { source: endpoint(link.source, flat.source, flat.sourceOffset, l), target: endpoint(link.target, flat.target, flat.targetOffset, l), flow: link.flow };
  }
  return out;
}

/**
 * The lumps' module records (#529): the lumps of each leaf module ranked by `size` (flow, else state-node count), ties
 * by id, as Infomap ranks a module's nodes; a lump's record is its leaf module's path, then its 1-based rank, which
 * skips the branch numbers of that module's own sub-modules (#533, a ragged hierarchy) so every path is one node's.
 * `leafOf` is each lump's leaf-module key. O(lumps · log lumps + leaf modules · depth).
 */
function lumpRecords(leafOf: readonly string[], size: (lump: number) => number): ModulePathNode[] {
  const byLeaf = new Map<string, number[]>();
  for (let l = 0; l < leafOf.length; l++) {
    const leaf = leafOf[l]!;
    const lumps = byLeaf.get(leaf);
    if (lumps) lumps.push(l);
    else byLeaf.set(leaf, [l]);
  }
  // The branch numbers each module's sub-modules take (#533): a ragged module (sub-modules and leaves side by side)
  // ranks its lumps after them, so a lump's path never names a sub-module too.
  const taken = new Map<string, Set<number>>();
  for (const leaf of byLeaf.keys()) {
    const parts = leaf === "" ? [] : leaf.split(":");
    for (let d = parts.length - 1; d >= 0; d--) {
      const parent = parts.slice(0, d).join(":");
      const branches = taken.get(parent) ?? new Set<number>();
      if (branches.has(Number(parts[d]))) break; // the coarser prefixes were recorded with it
      branches.add(Number(parts[d]));
      taken.set(parent, branches);
    }
  }
  const records = new Array<ModulePathNode>(leafOf.length);
  for (const [leaf, lumps] of byLeaf) {
    const prefix = leaf === "" ? [] : leaf.split(":").map(Number);
    const skip = taken.get(leaf);
    lumps.sort((a, b) => size(b) - size(a) || a - b);
    let rank = 0;
    for (let r = 0; r < lumps.length; r++) {
      do rank++;
      while (skip?.has(rank));
      records[lumps[r]!] = { id: lumps[r]!, path: [...prefix, rank] };
    }
  }
  return records;
}
