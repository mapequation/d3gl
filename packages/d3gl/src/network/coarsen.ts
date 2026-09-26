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
import { DEFAULT_FORCE, ForceLayout, seedPositions, seedSpacing, type ForceParams, type LayoutGraph } from "./force.js";

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
  /** Maximum refinement iterations at the finest level (the solve stops earlier once converged). Default 100. */
  iterations?: number;
  /**
   * Maximum iterations run at each *coarser* level while seeding (each stops early once converged).
   * These start near-relaxed after prolongation, so they need far fewer ticks than the finest level —
   * keeping the seed phase cheap (it runs before any progressive frame). Default 30.
   */
  coarsenIterations?: number;
  /**
   * Largest level the seed solves with the full `coarsenIterations`. A larger level gets a
   * proportionally shorter solve — the same `coarsenIterations · maxSeedNodes` node-ticks, so a
   * level twice the size runs half the ticks — and one past `coarsenIterations · maxSeedNodes` nodes
   * is prolongated through unsolved. That bounds the seed at O(levels · maxSeedNodes ·
   * coarsenIterations) however large the graph (never a Barnes-Hut solve of a near-full level, #117),
   * while the meso-scale levels still get their arrangement solved rather than guessed. Default 16384.
   */
  maxSeedNodes?: number;
  coarsen?: CoarsenOptions;
}

const DEFAULT_MIN_NODES = 8;
const DEFAULT_MAX_LEVELS = 32;
const DEFAULT_ITERATIONS = 100;
const DEFAULT_COARSEN_ITERATIONS = 30;
const DEFAULT_MAX_SEED_NODES = 16384;
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
 * One coarsening step. Visit nodes in index order and pair each unmatched node with its heaviest
 * unmatched neighbour (lowest index breaks ties → deterministic). A node with no unmatched neighbour
 * is **adopted** into its heaviest already-matched neighbour's group rather than left as a singleton:
 * without this, hub/star structures (pervasive in power-law graphs) barely shrink — each pass strips
 * only a couple of nodes, the hierarchy hits its level cap, and the multilevel seed runs dozens of
 * force solves on near-full graphs (#117). Adoption keeps the per-level reduction roughly geometric.
 * Then aggregate the surviving inter-group edges (parallel edges summed, internal edges dropped).
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
    let adopt = -1;
    let adoptW = -Infinity;
    for (let p = offsets[u]!; p < offsets[u + 1]!; p++) {
      const v = neighbors[p]!;
      const wv = w[p]!;
      if (assigned[v]) {
        if (wv > adoptW) {
          adoptW = wv;
          adopt = v;
        }
      } else if (wv > bestW) {
        bestW = wv;
        best = v;
      }
    }
    if (best !== -1) {
      const cid = coarseCount++;
      projection[u] = cid;
      assigned[u] = 1;
      projection[best] = cid;
      assigned[best] = 1;
    } else if (adopt !== -1) {
      projection[u] = projection[adopt]!; // join an already-matched neighbour's group
      assigned[u] = 1;
    } else {
      projection[u] = coarseCount++; // truly isolated this pass
      assigned[u] = 1;
    }
  }

  // Aggregate inter-group edges (undirected coarse pair ca<cb, summing weights) with a flat
  // typed-array pass instead of a Map<number,number>: bucket the edges by `ca` (counting sort), then
  // sum within each bucket via a per-`ca` mark. O(edges + coarseCount), no hashing/boxing/GC, and no
  // `ca * coarseCount + cb` key (which overflowed 2⁵³ at large coarseCount).
  const m = source.length;
  const deg = new Uint32Array(coarseCount);
  let cnt = 0;
  for (let e = 0; e < m; e++) {
    const ca = projection[source[e]!]!;
    const cb = projection[target[e]!]!;
    if (ca === cb) continue;
    deg[ca < cb ? ca : cb] = deg[ca < cb ? ca : cb]! + 1;
    cnt++;
  }
  const bucketOffsets = new Uint32Array(coarseCount + 1);
  for (let c = 0; c < coarseCount; c++) bucketOffsets[c + 1] = bucketOffsets[c]! + deg[c]!;
  const bucketCb = new Uint32Array(cnt);
  const bucketW = new Float32Array(cnt);
  const cursor = bucketOffsets.slice(0, coarseCount);
  for (let e = 0; e < m; e++) {
    let ca = projection[source[e]!]!;
    let cb = projection[target[e]!]!;
    if (ca === cb) continue;
    if (ca > cb) {
      const tmp = ca;
      ca = cb;
      cb = tmp;
    }
    const p = cursor[ca]!;
    cursor[ca] = p + 1;
    bucketCb[p] = cb;
    bucketW[p] = weight[e]!;
  }

  // Sum parallel edges within each ca-bucket; `mark[cb] === ca` means "already emitted this bucket".
  const cs = new Uint32Array(cnt);
  const ct = new Uint32Array(cnt);
  const cw = new Float32Array(cnt);
  const mark = new Int32Array(coarseCount).fill(-1);
  const slot = new Uint32Array(coarseCount);
  let ce = 0;
  for (let ca = 0; ca < coarseCount; ca++) {
    for (let p = bucketOffsets[ca]!; p < bucketOffsets[ca + 1]!; p++) {
      const cb = bucketCb[p]!;
      if (mark[cb] !== ca) {
        mark[cb] = ca;
        slot[cb] = ce;
        cs[ce] = ca;
        ct[ce] = cb;
        cw[ce] = bucketW[p]!;
        ce++;
      } else {
        cw[slot[cb]!] = cw[slot[cb]!]! + bucketW[p]!;
      }
    }
  }

  return {
    coarse: {
      nodeCount: coarseCount,
      source: cs.subarray(0, ce),
      target: ct.subarray(0, ce),
      weight: cw.subarray(0, ce),
    },
    projection,
  };
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

/**
 * A level's edge list + a positions buffer, as the minimal view {@link ForceLayout} consumes. A coarse
 * level passes its supernodes' masses and its aggregated edge weights as spring weights, so it lays
 * out at the finest level's equilibrium scale (see {@link multilevelSeed}).
 */
function asView(level: CoarseLevel, positions: Float32Array, mass: Float32Array): LayoutGraph {
  return {
    nodeCount: level.nodeCount,
    edgeCount: level.source.length,
    source: level.source,
    target: level.target,
    positions,
    mass,
    springWeight: level.weight,
  };
}

/** A coarse level (k ≥ 1) as {@link multilevelSeed} solves it. */
interface SeedLevel {
  /** Solver view: the level's edges (aggregated weights as springs), positions and masses. */
  view: LayoutGraph;
  /** How many finest nodes each of the level's nodes stands for (`view.mass`, typed). */
  mass: Float32Array;
  /** Projection from the next finer level (k − 1) into this one. */
  up: Uint32Array;
}

/**
 * Place a level's nodes around their parents (the next coarser level's positions): each node lands in
 * a phyllotaxis disc about its parent at the cumulative mass of its earlier siblings, so a parent
 * standing for `m` finest nodes spreads them over `m` nodes' worth of equilibrium area (`spacing²`
 * each) — the level keeps the finest equilibrium density however unevenly the coarsening grouped it.
 * Deterministic golden-angle turns, no RNG, never coincident. `mass` is the level's own (omitted =
 * 1 each, the finest level).
 */
function prolongate(
  fine: Float32Array,
  coarse: Float32Array,
  projection: Uint32Array,
  mass: Float32Array | undefined,
  coarseCount: number,
  n: number,
  spacing: number,
): void {
  const filled = new Float32Array(coarseCount); // per parent: mass already placed around it
  const rank = new Uint32Array(coarseCount); // per parent: children placed so far
  const k = spacing / Math.sqrt(Math.PI); // a disc of area A·spacing² has radius k·√A
  for (let i = 0; i < n; i++) {
    const c = projection[i] ?? 0;
    const m = mass?.[i] ?? 1;
    const before = filled[c] ?? 0;
    filled[c] = before + m;
    const r = k * Math.sqrt(before + m / 2);
    const turn = rank[c] ?? 0;
    rank[c] = turn + 1;
    const a = (turn + c) * GOLDEN; // + c: neighbouring parents don't all start their ring at 0°
    fine[i * 2] = (coarse[c * 2] ?? 0) + r * Math.cos(a);
    fine[i * 2 + 1] = (coarse[c * 2 + 1] ?? 0) + r * Math.sin(a);
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
 * Build the coarsening hierarchy, lay out the coarsest level, then prolongate + refine *every level
 * except the finest*, leaving `graph.positions` holding the seed projected onto the original graph —
 * ready for a final refinement the caller drives (the layout worker streams that refinement
 * tick-by-tick for progressive rendering). With no possible coarsening (tiny or edgeless graph) this
 * is just a reproducible disc seed ({@link seedPositions} at the force model's equilibrium).
 *
 * **Scale-consistent with the force equilibrium.** The finest layout converges to a uniform disc of
 * radius `√(repulsion·N/centering)` (spacing `√(π·repulsion/centering)`, {@link equilibriumSpacing}),
 * so every level is laid out at that same scale: a coarse node carries a **mass** — the number of
 * finest nodes it stands for — and repels, is centred and accelerates as that many nodes (its springs
 * are the aggregated edge weights), so each coarse level's own equilibrium already *is* the finest
 * one; prolongation spreads each node's children over their share of that area. The finest refine
 * therefore starts at its own scale — no overshoot ("explosion") and no collapse — instead of from a
 * viewport-sized seed. Centred on the viewport centre.
 *
 * Pass a pre-built `hierarchy` to reuse a coarsening already computed by the caller — the worker
 * builds it once and feeds the *same* tree to both this seed and the structural LOD (#103), so the
 * graph is never coarsened twice.
 */
export function multilevelSeed(graph: CoarsenableGraph, opts: MultilevelLayoutOptions, hierarchy?: Hierarchy): void {
  const { width, height } = opts;
  const params: ForceParams = { ...DEFAULT_FORCE, ...opts.force };
  const coarsenIterations = opts.coarsenIterations ?? DEFAULT_COARSEN_ITERATIONS;
  const maxSeedNodes = opts.maxSeedNodes ?? DEFAULT_MAX_SEED_NODES;
  const { levels, projections } = hierarchy ?? buildHierarchy(graph, opts.coarsen);
  const spacing = seedSpacing(graph.nodeCount, width, height, params);

  // One record per coarse level k ≥ 1, finest first: its solver view (aggregated edges as spring
  // weights, its own positions buffer), its masses — how many finest nodes each node stands for,
  // accumulated finest-up through the projections (level 0 is 1 each, implicit) — and the projection
  // from the next finer level into it.
  const coarse: SeedLevel[] = [];
  let fineMass: Float32Array | undefined;
  for (const [k, level] of levels.slice(1).entries()) {
    const up = projections[k]; // level k → level k + 1 (this record's level)
    if (!up) break; // buildHierarchy pairs every coarse level with its projection
    const mass = new Float32Array(level.nodeCount);
    up.forEach((c, i) => {
      mass[c] = (mass[c] ?? 0) + (fineMass?.[i] ?? 1);
    });
    coarse.push({ view: asView(level, new Float32Array(level.nodeCount * 2), mass), mass, up });
    fineMass = mass;
  }
  const top = coarse[coarse.length - 1];
  if (!top) {
    // No possible coarsening (tiny or edgeless graph): a reproducible disc seed at the equilibrium.
    seedPositions(graphView(graph), width, height, { force: opts.force });
    return;
  }

  // Coarse springs are the aggregated edge weights. Normalise them to the finest level's unit springs
  // (the finest layout ignores weights): for an unweighted graph a coarse weight is exactly the number
  // of finest edges it stands for; for a weighted one, that count on average.
  let edges = 0;
  let weightSum = 0;
  for (let e = 0; e < graph.source.length; e++) {
    if (graph.source[e] === graph.target[e]) continue;
    edges++;
    weightSum += graph.weight[e] ?? 0;
  }
  const coarseForce: Partial<ForceParams> = { ...opts.force, attraction: params.attraction * (weightSum > 0 ? edges / weightSum : 1) };

  /** Solve a coarse level, cooled: the full budget up to maxSeedNodes, a proportional share above it. */
  const solve = ({ view }: SeedLevel): void => {
    const n = view.nodeCount;
    const ticks = Math.min(coarsenIterations, Math.floor((coarsenIterations * maxSeedNodes) / n));
    if (n > 1 && ticks > 0) new ForceLayout(view, coarseForce).run(ticks, "cool");
  };

  // The coarsest level rings a virtual root, shifted so its centre of mass is the viewport centre (the
  // forces conserve it, so the layout stays centred there); then every level down to (but not
  // including) level 0 is prolongated and solved. The caller refines level 0 (streamed, in the worker).
  const coarsest = top.view.nodeCount;
  const topPos = top.view.positions;
  prolongate(topPos, new Float32Array(2), new Uint32Array(coarsest), top.mass, 1, coarsest, spacing);
  let mx = 0;
  let my = 0;
  top.mass.forEach((m, i) => {
    mx += m * (topPos[i * 2] ?? 0);
    my += m * (topPos[i * 2 + 1] ?? 0);
  });
  const dx = width / 2 - mx / graph.nodeCount;
  const dy = height / 2 - my / graph.nodeCount;
  for (let i = 0; i < coarsest; i++) {
    topPos[i * 2] = (topPos[i * 2] ?? 0) + dx;
    topPos[i * 2 + 1] = (topPos[i * 2 + 1] ?? 0) + dy;
  }
  solve(top);
  let coarser = top;
  for (const level of coarse.slice(0, -1).reverse()) {
    prolongate(level.view.positions, coarser.view.positions, coarser.up, level.mass, coarser.view.nodeCount, level.view.nodeCount, spacing);
    solve(level);
    coarser = level;
  }
  // `coarser` is level 1 now; its projection comes from level 0, the graph itself.
  prolongate(graph.positions, coarser.view.positions, coarser.up, undefined, coarser.view.nodeCount, coarser.up.length, spacing);
}

/**
 * Multilevel force layout: {@link multilevelSeed} then refine the finest level in place. Writes
 * `graph.positions`. This is the synchronous main-thread path; the worker reuses `multilevelSeed`
 * and streams the finest-level refinement instead.
 */
export function multilevelLayout(graph: CoarsenableGraph, opts: MultilevelLayoutOptions): void {
  multilevelSeed(graph, opts);
  new ForceLayout(graphView(graph), opts.force).run(opts.iterations ?? DEFAULT_ITERATIONS, "cool"); // seeded: cool over the budget
}
