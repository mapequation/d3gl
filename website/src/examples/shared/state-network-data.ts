/**
 * Synthetic **state (memory) network** generator for the state-network example (#171).
 *
 * There is no bundled Infomap in the browser, so we synthesise a state network whose structure mirrors
 * what a higher-order community detection would find, in two stages:
 *
 * 1. **Physical network** — an LFR-inspired benchmark: planted communities, a power-law degree
 *    distribution, and a mixing parameter `mu` (the fraction of a node's edges that leave its
 *    community). Enough community structure that a partition is meaningful, without the full
 *    Lancichinetti–Fortunato–Radicchi degree/community-size realisation.
 *
 * 2. **State network via node2vec trigrams** — a state node is a directed physical edge `(i→j)`
 *    ("at `j`, came from `i`"), so its physical node is the head `j`. For every consecutive pair of
 *    edges `i→j→k` (a trigram) we add a state edge `(i,j) → (j,k)`, weighted by the node2vec 2nd-order
 *    transition bias from `j` given we came from `i`: `1/p` to return (`k = i`), `1` to a neighbour of
 *    `i` (a **triangle-closing** step), `1/q` otherwise. With `p = 2, q = 3` the walk stays local and
 *    favours closing triangles, giving realistic memory structure.
 *
 * The **module of a state node `(i,j)` is the community of its *previous* node `i`** — memory separates
 * flow through a node by where it came from. So an interior physical node (all predecessors in one
 * community) is single-module (a solid disc), while a **bridge** node (predecessors in several
 * communities) spans multiple modules — exactly the overlapping membership the physical view draws as a
 * pie chart.
 *
 * Fully deterministic (seeded PRNG, no `Math.random`) so the example and its tests are reproducible.
 */
import { buildStateGraph, type StateNetworkGraph } from "@mapequation/d3gl/network";
import type { ModulePathNode } from "@mapequation/d3gl/network";

/** Deterministic PRNG (mulberry32): a seed → a `() => float in [0,1)` stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LFROptions {
  /** Number of physical nodes. Default 240. */
  nodeCount?: number;
  /** Number of planted communities. Default 6. */
  communityCount?: number;
  /** Mixing parameter: fraction of a node's edges that cross its community. Default 0.15. */
  mu?: number;
  /** Mean target degree (power-law mean-ish). Default 8. */
  avgDegree?: number;
  /** Power-law degree exponent. Default 2.5. */
  gamma?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
}

export interface PhysicalNetwork {
  nodeCount: number;
  /** Undirected edges, each listed once (i < j). */
  edges: Array<[number, number]>;
  /** Per-node community id in `[0, communityCount)`. */
  community: Int32Array;
  /** Neighbour set per node (undirected), for adjacency tests. */
  neighbors: Set<number>[];
}

/** Sample an integer degree from a truncated power law `p(k) ∝ k^-γ` on `[kmin, kmax]`. */
function powerLawDegree(rand: () => number, kmin: number, kmax: number, gamma: number): number {
  const g1 = 1 - gamma;
  const lo = Math.pow(kmin, g1);
  const hi = Math.pow(kmax, g1);
  const k = Math.pow(lo + rand() * (hi - lo), 1 / g1);
  return Math.max(kmin, Math.min(kmax, Math.round(k)));
}

/** Generate an LFR-inspired physical network with planted communities and a mixing parameter. */
export function generateLFR(opts: LFROptions = {}): PhysicalNetwork {
  const nodeCount = opts.nodeCount ?? 240;
  const communityCount = opts.communityCount ?? 6;
  const mu = opts.mu ?? 0.15;
  const avgDegree = opts.avgDegree ?? 8;
  const gamma = opts.gamma ?? 2.5;
  const rand = mulberry32(opts.seed ?? 1);

  // Assign nodes to communities in contiguous, roughly equal blocks, and index the members per community.
  const community = new Int32Array(nodeCount);
  const members: number[][] = Array.from({ length: communityCount }, () => []);
  for (let i = 0; i < nodeCount; i++) {
    const c = Math.floor((i / nodeCount) * communityCount);
    community[i] = c;
    members[c]!.push(i);
  }

  const neighbors: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  const kmin = Math.max(2, Math.round(avgDegree / 2));
  const kmax = Math.max(kmin + 1, Math.round(Math.sqrt(nodeCount) * 2));
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    neighbors[a]!.add(b);
    neighbors[b]!.add(a);
  };
  const pick = (pool: number[], not: number): number => {
    // A few tries to avoid self; pools are large enough that this rarely loops.
    for (let t = 0; t < 8; t++) {
      const x = pool[Math.floor(rand() * pool.length)]!;
      if (x !== not) return x;
    }
    return pool[0]!;
  };

  for (let i = 0; i < nodeCount; i++) {
    const target = powerLawDegree(rand, kmin, kmax, gamma);
    const own = members[community[i]!]!;
    while (neighbors[i]!.size < target) {
      if (rand() < mu && communityCount > 1) {
        // Cross-community edge: pick from a different community.
        let c = Math.floor(rand() * communityCount);
        if (c === community[i]!) c = (c + 1) % communityCount;
        addEdge(i, pick(members[c]!, i));
      } else {
        addEdge(i, pick(own, i));
      }
      if (own.length <= 1 && communityCount === 1) break; // degenerate guard
    }
  }

  const edges: Array<[number, number]> = [];
  for (let i = 0; i < nodeCount; i++) for (const j of neighbors[i]!) if (i < j) edges.push([i, j]);
  return { nodeCount, edges, community, neighbors };
}

export interface SyntheticStateNetwork {
  /** The assembled state graph (state + derived physical views), ready to render. */
  graph: StateNetworkGraph;
  /** Per-**state-node** module records ({id, path:[community+1, rank]}) for colours / pie wedges. */
  stateModules: ModulePathNode[];
  /** The underlying physical network (communities, edges) for reference / physical-view colouring. */
  physical: PhysicalNetwork;
}

export interface StateNetworkOptions extends LFROptions {
  /** node2vec return parameter (higher ⇒ less backtracking). Default 2. */
  p?: number;
  /** node2vec in-out parameter (higher ⇒ more triangle-closing, less exploration). Default 3. */
  q?: number;
}

/**
 * Build a synthetic {@link StateNetworkGraph} from an LFR-inspired physical network via node2vec
 * trigrams. State nodes are the directed physical edges; state edges are node2vec-weighted trigrams;
 * state-node modules are the previous node's community (so bridge physical nodes overlap modules).
 */
export function generateStateNetwork(opts: StateNetworkOptions = {}): SyntheticStateNetwork {
  const p = opts.p ?? 2;
  const q = opts.q ?? 3;
  const physical = generateLFR(opts);
  const { nodeCount: physicalCount, neighbors, community } = physical;

  // State nodes = directed physical edges (i→j); physical of (i,j) is the head j. Index them densely.
  const stateId = new Map<number, number>(); // key = i*physicalCount + j → state-node id
  const prev: number[] = []; // state id → i (previous physical node)
  const curr: number[] = []; // state id → j (current physical node = its physical id)
  const idOf = (i: number, j: number): number => {
    const key = i * physicalCount + j;
    let s = stateId.get(key);
    if (s === undefined) {
      s = prev.length;
      stateId.set(key, s);
      prev.push(i);
      curr.push(j);
    }
    return s;
  };
  for (let i = 0; i < physicalCount; i++) for (const j of neighbors[i]!) { idOf(i, j); idOf(j, i); }
  const stateCount = prev.length;

  // State edges = trigrams (i,j)→(j,k), weighted by node2vec's 2nd-order transition bias from j given i.
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let s = 0; s < stateCount; s++) {
    const i = prev[s]!;
    const j = curr[s]!;
    const iNbrs = neighbors[i]!;
    for (const k of neighbors[j]!) {
      const alpha = k === i ? 1 / p : iNbrs.has(k) ? 1 : 1 / q; // return / triangle / explore
      source.push(s);
      target.push(idOf(j, k));
      weight.push(alpha);
    }
  }

  // A cheap visit-rate proxy: each state node's normalised in-strength (sum of incoming trigram weights).
  const inStrength = new Float32Array(stateCount);
  for (let e = 0; e < target.length; e++) inStrength[target[e]!] = inStrength[target[e]!]! + weight[e]!;
  let total = 0;
  for (let s = 0; s < stateCount; s++) total += inStrength[s]!;
  const nodeFlow = new Float32Array(stateCount);
  for (let s = 0; s < stateCount; s++) nodeFlow[s] = total > 0 ? inStrength[s]! / total : 1 / stateCount;

  const stateToPhysical = Uint32Array.from(curr);
  const graph = buildStateGraph({
    stateCount,
    stateToPhysical,
    source,
    target,
    weight,
    nodeFlow,
    physicalCount,
    directed: true,
  });

  // Module of state node (i,j) = previous node i's community (memory separates flow by origin). Two-level
  // path [community+1, rank] so top-level module = community (moduleColors splits the hue circle by it).
  const rankOf = new Map<number, number>(); // community → next rank
  const stateModules: ModulePathNode[] = new Array(stateCount);
  for (let s = 0; s < stateCount; s++) {
    const c = community[prev[s]!]!;
    const rank = (rankOf.get(c) ?? 0) + 1;
    rankOf.set(c, rank);
    stateModules[s] = { id: s, path: [c + 1, rank] };
  }

  return { graph, stateModules, physical };
}
