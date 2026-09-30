/**
 * Network graph data structures (sub-issue #99 / epic #98).
 *
 * The renderer consumes columnar SoA typed arrays; layout and the LOD
 * hierarchy-cut traverse a CSR adjacency. Both are plain typed arrays so they
 * cross a worker boundary without copying.
 */

/** Compressed-sparse-row adjacency. */
export interface CSR {
  /** Per-node start offset into `neighbors`; length `nodeCount + 1`. */
  offsets: Uint32Array;
  /** Flattened neighbor ids; node `i`'s neighbors are `neighbors[offsets[i]..offsets[i+1]]`. */
  neighbors: Uint32Array;
  /** Per-node neighbor count; length `nodeCount`. */
  degree: Uint32Array;
  /**
   * Per-entry weight parallel to `neighbors` (the weight of the edge each entry came from), present
   * only when {@link buildCSR} was given edge weights — the GPU layout's weighted springs read it.
   */
  weights?: Float32Array;
}

/**
 * Build undirected (symmetric) CSR adjacency from a directed edge list.
 * Each edge contributes to both endpoints, so layout/traversal see the graph
 * as undirected while the directed edges remain available for arrow rendering.
 * With `weight` (parallel to `source`/`target`), each entry also carries its edge's weight in
 * `weights`, scattered in the same order as `neighbors`.
 */
export function buildCSR(
  nodeCount: number,
  source: ArrayLike<number>,
  target: ArrayLike<number>,
  weight?: ArrayLike<number>,
): CSR {
  const edgeCount = source.length;
  const degree = new Uint32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const s = source[e]!;
    const t = target[e]!;
    degree[s] = degree[s]! + 1;
    degree[t] = degree[t]! + 1;
  }

  // Prefix-sum the degrees into start offsets (offsets[i+1] = sum of degrees ≤ i).
  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i]! + degree[i]!;

  // Scatter each edge into both endpoints' slices, advancing a per-node cursor.
  const neighbors = new Uint32Array(offsets[nodeCount]!);
  const weights = weight ? new Float32Array(neighbors.length) : undefined;
  const cursor = offsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const s = source[e]!;
    const t = target[e]!;
    const ps = cursor[s]!;
    neighbors[ps] = t;
    cursor[s] = ps + 1;
    const pt = cursor[t]!;
    neighbors[pt] = s;
    cursor[t] = pt + 1;
    if (weights && weight) {
      const w = weight[e] ?? 1;
      weights[ps] = w;
      weights[pt] = w;
    }
  }

  return weights ? { offsets, neighbors, degree, weights } : { offsets, neighbors, degree };
}

/**
 * For each directed edge `s → t`, the id of an edge `t → s` — the last one in edge order when there are
 * parallel ones, as a `Map` keyed by the pair would keep — or −1 when there is none. The half-arrow glyph
 * reads it to leave room for its reciprocal's arrowhead (`oppositeWidth`).
 *
 * Two stable counting sorts put the edges in rows by source, each row ordered by target (ties in edge
 * order), and each edge binary-searches its target's row for its source: O(nodes + edges) for the sorts,
 * O(edges · log(max out-degree)) for the searches. 4 B per edge returned; 4 B per edge + 8 B per node
 * transient. It replaces a `Map` keyed by `s · nodeCount + t`, whose keys pass 2³¹ at road-network scale
 * and are boxed: 3.5 s at 2M nodes and 5.5M edges, against about 0.2 s here.
 */
export function reciprocalEdges(graph: Pick<NetworkGraph, "nodeCount" | "edgeCount" | "source" | "target">): Int32Array {
  const { nodeCount: n, edgeCount: m, source, target } = graph;
  const start = new Int32Array(n + 1);
  // Sort 1: the edges by target, in edge order within a target.
  for (let e = 0; e < m; e++) {
    const t = (target[e] ?? 0) + 1;
    start[t] = (start[t] ?? 0) + 1;
  }
  for (let v = 0; v < n; v++) start[v + 1] = (start[v + 1] ?? 0) + (start[v] ?? 0);
  const byTarget = new Int32Array(m);
  for (let e = 0; e < m; e++) {
    const t = target[e] ?? 0;
    const at = start[t] ?? 0;
    byTarget[at] = e;
    start[t] = at + 1;
  }
  // Sort 2, stable: those into rows by source, so each row is ordered by (target, edge id).
  start.fill(0);
  for (let e = 0; e < m; e++) {
    const s = (source[e] ?? 0) + 1;
    start[s] = (start[s] ?? 0) + 1;
  }
  for (let v = 0; v < n; v++) start[v + 1] = (start[v + 1] ?? 0) + (start[v] ?? 0);
  const cursor = start.slice(0, n);
  const row = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const e = byTarget[i] ?? 0;
    const s = source[e] ?? 0;
    const at = cursor[s] ?? 0;
    row[at] = e;
    cursor[s] = at + 1;
  }
  // byTarget is spent: it takes the answer. Edge s → t looks for the last entry of row t with target s.
  const opposite = byTarget;
  for (let e = 0; e < m; e++) {
    const s = source[e] ?? 0;
    const t = target[e] ?? 0;
    const first = start[t] ?? 0;
    let lo = first;
    let hi = start[t + 1] ?? 0;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((target[row[mid] ?? 0] ?? 0) <= s) lo = mid + 1;
      else hi = mid;
    }
    const last = row[lo - 1] ?? 0;
    opposite[e] = lo > first && target[last] === s ? last : -1;
  }
  return opposite;
}

/** Network graph: directed-edge SoA for rendering + CSR for traversal. */
export interface NetworkGraph {
  nodeCount: number;
  edgeCount: number;
  /** Directed edge endpoints (node indices), length `edgeCount`. */
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge weight (flow), length `edgeCount`. */
  weight: Float32Array;
  /** Interleaved node positions `[x, y, ...]`, length `2 * nodeCount`; filled by layout. */
  positions: Float32Array;
  /** Undirected adjacency for layout/traversal. */
  csr: CSR;
  /**
   * Per-node strength: the sum of incident edge weights (weighted degree), length `nodeCount`.
   * A purely structural metric derived from the edge list — a sizing input alongside
   * {@link CSR.degree}. (Not flow in the map-equation sense; that is {@link NetworkGraph.flow}.)
   */
  strength: Float32Array;
  /**
   * Per-node flow (e.g. an Infomap visit rate), length `nodeCount`, or `null` when the caller
   * supplied none. A model quantity the app provides via {@link BuildGraphInput.nodeFlow} — d3gl
   * does not derive it. Available to `nodeRadius` sizing as the `"flow"` metric.
   */
  flow: Float32Array | null;
  /** Whether links render with arrowheads. */
  directed: boolean;
}

export interface BuildGraphInput {
  nodeCount: number;
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Optional per-edge weight; defaults to 1. */
  weight?: ArrayLike<number>;
  /**
   * Optional per-node flow (length must equal `nodeCount`) — a model quantity (e.g. Infomap visit
   * rates) the app computes. Exposed as {@link NetworkGraph.flow} and usable for `nodeRadius` sizing.
   */
  nodeFlow?: ArrayLike<number>;
  /** Defaults to false (undirected). */
  directed?: boolean;
}

/** Assemble a {@link NetworkGraph} from a directed edge list. */
export function buildGraph(input: BuildGraphInput): NetworkGraph {
  const { nodeCount } = input;
  const source = Uint32Array.from(input.source);
  const target = Uint32Array.from(input.target);
  const edgeCount = source.length;
  const weight = input.weight
    ? Float32Array.from(input.weight)
    : new Float32Array(edgeCount).fill(1);
  const positions = new Float32Array(nodeCount * 2);
  const csr = buildCSR(nodeCount, source, target);

  // Weighted degree: each edge adds its weight to both endpoints (undirected, mirroring CSR.degree).
  const strength = new Float32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const w = weight[e]!;
    const s = source[e]!;
    const t = target[e]!;
    strength[s] = strength[s]! + w;
    strength[t] = strength[t]! + w;
  }

  let flow: Float32Array | null = null;
  if (input.nodeFlow) {
    if (input.nodeFlow.length !== nodeCount) {
      throw new Error(`buildGraph: nodeFlow length ${input.nodeFlow.length} !== nodeCount ${nodeCount}`);
    }
    flow = Float32Array.from(input.nodeFlow);
  }

  return {
    nodeCount,
    edgeCount,
    source,
    target,
    weight,
    positions,
    csr,
    strength,
    flow,
    directed: input.directed ?? false,
  };
}
