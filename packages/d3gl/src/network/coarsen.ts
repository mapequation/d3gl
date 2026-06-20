/**
 * Multilevel coarsening for force layout (sub-issue #102, epic #98).
 *
 * Clean-room **heavy-edge matching** (sfdp-style, our own implementation — no copied code):
 * repeatedly pair each node with its heaviest unmatched neighbour, collapsing each pair into one
 * coarser node, until the graph is small. Laying out the tiny coarsest graph and then
 * *prolongating* (projecting positions down) + refining at each finer level seeds the full layout
 * from a good global arrangement — far faster convergence, and it sidesteps the local minima a
 * cold random start falls into.
 *
 * This is the layout coarsener, distinct from any provided Infomap module hierarchy (N6): it is a
 * topological structure built once, feeding both layout seeding here and structural LOD later (N5).
 */
import { ForceLayout, seedPositions, type ForceParams, type LayoutGraph } from "./force.js";

/**
 * The graph fields coarsening + multilevel seeding read: node count, a weighted edge list, and the
 * positions buffer they fill. `NetworkGraph` satisfies this structurally, and so does the plain
 * object the layout worker reconstructs from transferred buffers — so neither needs a cast.
 */
export interface CoarsenableGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  positions: Float32Array;
}

/** One coarsening level as a weighted, undirected edge list (parallel edges already collapsed). */
export interface CoarseLevel {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge aggregated weight, parallel to `source`/`target`. */
  weight: Float32Array;
}

/** A coarsening hierarchy: progressively smaller graphs plus the maps that connect them. */
export interface Hierarchy {
  /** `levels[0]` is the finest (original) graph; each subsequent level is strictly coarser. */
  levels: CoarseLevel[];
  /** `projections[k]` maps a level-`k` node id to its level-`k+1` node id; length `levels.length - 1`. */
  projections: Uint32Array[];
}

export interface CoarsenOptions {
  /** Stop coarsening once a level has ≤ this many nodes. Default 8. */
  minNodes?: number;
  /** Safety cap on hierarchy depth. Default 32. */
  maxLevels?: number;
}

export interface MultilevelLayoutOptions {
  width: number;
  height: number;
  /** Force parameters passed to every level's {@link ForceLayout}. */
  force?: Partial<ForceParams>;
  /** Refinement iterations run at each level. Default 100. */
  iterations?: number;
  coarsen?: CoarsenOptions;
}

const DEFAULT_MIN_NODES = 8;
const DEFAULT_MAX_LEVELS = 32;
const DEFAULT_ITERATIONS = 100;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Symmetric (undirected) adjacency with per-incidence weights; self-loops dropped. */
function symmetricAdjacency(level: CoarseLevel): {
  offsets: Uint32Array;
  neighbors: Uint32Array;
  weight: Float32Array;
} {
  const { nodeCount, source, target, weight } = level;
  const m = source.length;
  const degree = new Uint32Array(nodeCount);
  for (let e = 0; e < m; e++) {
    const s = source[e]!;
    const t = target[e]!;
    if (s === t) continue;
    degree[s] = degree[s]! + 1;
    degree[t] = degree[t]! + 1;
  }
  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i]! + degree[i]!;
  const neighbors = new Uint32Array(offsets[nodeCount]!);
  const w = new Float32Array(offsets[nodeCount]!);
  const cursor = offsets.slice(0, nodeCount);
  for (let e = 0; e < m; e++) {
    const s = source[e]!;
    const t = target[e]!;
    if (s === t) continue;
    const ww = weight[e]!;
    const ps = cursor[s]!;
    neighbors[ps] = t;
    w[ps] = ww;
    cursor[s] = ps + 1;
    const pt = cursor[t]!;
    neighbors[pt] = s;
    w[pt] = ww;
    cursor[t] = pt + 1;
  }
  return { offsets, neighbors, weight: w };
}

/**
 * One heavy-edge-matching coarsening step: visit nodes in index order, pair each unmatched node
 * with its heaviest unmatched neighbour (lowest index breaks ties → deterministic), and aggregate
 * the surviving inter-group edges (parallel edges summed, internal edges dropped).
 */
export function coarsenLevel(level: CoarseLevel): { coarse: CoarseLevel; projection: Uint32Array } {
  const { nodeCount, source, target, weight } = level;
  const { offsets, neighbors, weight: w } = symmetricAdjacency(level);

  const projection = new Uint32Array(nodeCount);
  const assigned = new Uint8Array(nodeCount);
  let coarseCount = 0;
  for (let u = 0; u < nodeCount; u++) {
    if (assigned[u]) continue;
    let best = -1;
    let bestW = -Infinity;
    for (let p = offsets[u]!; p < offsets[u + 1]!; p++) {
      const v = neighbors[p]!;
      if (assigned[v]) continue;
      if (w[p]! > bestW) {
        bestW = w[p]!;
        best = v;
      }
    }
    const cid = coarseCount++;
    projection[u] = cid;
    assigned[u] = 1;
    if (best !== -1) {
      projection[best] = cid;
      assigned[best] = 1;
    }
  }

  // Aggregate inter-group edges: key each undirected coarse pair (ca<cb), summing weights.
  const edgeMap = new Map<number, number>();
  for (let e = 0; e < source.length; e++) {
    let ca = projection[source[e]!]!;
    let cb = projection[target[e]!]!;
    if (ca === cb) continue;
    if (ca > cb) {
      const tmp = ca;
      ca = cb;
      cb = tmp;
    }
    const key = ca * coarseCount + cb;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + weight[e]!);
  }

  const ce = edgeMap.size;
  const cs = new Uint32Array(ce);
  const ct = new Uint32Array(ce);
  const cw = new Float32Array(ce);
  let i = 0;
  for (const [key, ww] of edgeMap) {
    cs[i] = Math.floor(key / coarseCount);
    ct[i] = key % coarseCount;
    cw[i] = ww;
    i++;
  }

  return { coarse: { nodeCount: coarseCount, source: cs, target: ct, weight: cw }, projection };
}

/** Build the full coarsening hierarchy, stopping at `minNodes` or when a pass stops reducing. */
export function buildHierarchy(graph: CoarsenableGraph, opts: CoarsenOptions = {}): Hierarchy {
  const minNodes = opts.minNodes ?? DEFAULT_MIN_NODES;
  const maxLevels = opts.maxLevels ?? DEFAULT_MAX_LEVELS;
  const levels: CoarseLevel[] = [
    { nodeCount: graph.nodeCount, source: graph.source, target: graph.target, weight: graph.weight },
  ];
  const projections: Uint32Array[] = [];
  while (levels.length < maxLevels) {
    const top = levels[levels.length - 1]!;
    if (top.nodeCount <= minNodes) break;
    const { coarse, projection } = coarsenLevel(top);
    // Edgeless / fully-matched graphs can't shrink further — stop rather than loop.
    if (coarse.nodeCount >= top.nodeCount) break;
    levels.push(coarse);
    projections.push(projection);
  }
  return { levels, projections };
}

/** A level's edge list + a positions buffer, as the minimal view {@link ForceLayout} consumes. */
function asView(level: CoarseLevel, positions: Float32Array): LayoutGraph {
  return {
    nodeCount: level.nodeCount,
    edgeCount: level.source.length,
    source: level.source,
    target: level.target,
    positions,
  };
}

/**
 * Project a coarse level's positions down to the finer level: each fine node starts at its coarse
 * parent's position, nudged by a deterministic golden-angle offset so siblings that share a parent
 * separate without an RNG (and never start exactly coincident).
 */
function prolongate(
  fine: Float32Array,
  coarse: Float32Array,
  projection: Uint32Array,
  n: number,
  width: number,
  height: number,
): void {
  const jitter = (0.5 * Math.min(width, height)) / Math.sqrt(Math.max(n, 1));
  for (let i = 0; i < n; i++) {
    const c = projection[i]!;
    const a = i * GOLDEN;
    fine[i * 2] = coarse[c * 2]! + jitter * Math.cos(a);
    fine[i * 2 + 1] = coarse[c * 2 + 1]! + jitter * Math.sin(a);
  }
}

/** A {@link CoarsenableGraph}'s own edge list + positions, as the {@link ForceLayout} view. */
function graphView(graph: CoarsenableGraph): LayoutGraph {
  return {
    nodeCount: graph.nodeCount,
    edgeCount: graph.source.length,
    source: graph.source,
    target: graph.target,
    positions: graph.positions,
  };
}

/**
 * Build the coarsening hierarchy, lay out the coarsest level from a seeded disc, then prolongate +
 * refine *every level except the finest*, leaving `graph.positions` holding the seed projected onto
 * the original graph — ready for a final refinement the caller drives (the layout worker streams
 * that refinement tick-by-tick for progressive rendering). With no possible coarsening (tiny or
 * edgeless graph) this is just a reproducible disc seed.
 */
export function multilevelSeed(graph: CoarsenableGraph, opts: MultilevelLayoutOptions): void {
  const { width, height } = opts;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const { levels, projections } = buildHierarchy(graph, opts.coarsen);
  const last = levels.length - 1;

  if (last === 0) {
    seedPositions(graphView(graph), width, height);
    return;
  }

  // Positions per level; level 0 aliases graph.positions so the seed lands there.
  const pos: Float32Array[] = levels.map((lvl, k) =>
    k === 0 ? graph.positions : new Float32Array(lvl.nodeCount * 2),
  );

  // Seed + solve the coarsest level, then prolongate + refine down to (but not including) level 0.
  const coarsestView = asView(levels[last]!, pos[last]!);
  seedPositions(coarsestView, width, height);
  new ForceLayout(coarsestView, opts.force).run(iterations);
  for (let k = last - 1; k >= 1; k--) {
    const lvl = levels[k]!;
    prolongate(pos[k]!, pos[k + 1]!, projections[k]!, lvl.nodeCount, width, height);
    new ForceLayout(asView(lvl, pos[k]!), opts.force).run(iterations);
  }
  // Project the seed onto the finest level; the caller refines from here.
  prolongate(graph.positions, pos[1]!, projections[0]!, levels[0]!.nodeCount, width, height);
}

/**
 * Multilevel force layout: {@link multilevelSeed} then refine the finest level in place. Writes
 * `graph.positions`. This is the synchronous main-thread path; the worker reuses `multilevelSeed`
 * and streams the finest-level refinement instead.
 */
export function multilevelLayout(graph: CoarsenableGraph, opts: MultilevelLayoutOptions): void {
  multilevelSeed(graph, opts);
  new ForceLayout(graphView(graph), opts.force).run(opts.iterations ?? DEFAULT_ITERATIONS);
}
