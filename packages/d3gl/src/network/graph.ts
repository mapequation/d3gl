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
}

/**
 * Build undirected (symmetric) CSR adjacency from a directed edge list.
 * Each edge contributes to both endpoints, so layout/traversal see the graph
 * as undirected while the directed edges remain available for arrow rendering.
 */
export function buildCSR(
  nodeCount: number,
  source: ArrayLike<number>,
  target: ArrayLike<number>,
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
  }

  return { offsets, neighbors, degree };
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
  /** Whether links render with arrowheads. */
  directed: boolean;
}

export interface BuildGraphInput {
  nodeCount: number;
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Optional per-edge weight; defaults to 1. */
  weight?: ArrayLike<number>;
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

  return {
    nodeCount,
    edgeCount,
    source,
    target,
    weight,
    positions,
    csr,
    directed: input.directed ?? false,
  };
}
