/**
 * The GPU layout's multilevel seed plan (#353, spec §6.4 and §8) — pure, DOM-free and node-tested, so the
 * layout worker can build it.
 *
 * A plan is the seed's levels, coarsest first, each ready for the one GPU solver to run: its slot count,
 * where each slot is placed (its parent's slot in the level above and an offset from it), each slot's
 * **mass** (how many finest nodes it stands for), the level's springs as a symmetric CSR with aggregated
 * **weights**, the per-slot spring stabilizer, the hub chunk table, and the ticks to solve it for. The solver
 * (`GpuForceLayout.beginSeed` / `setLevel` / `endSeed`) uploads a level, prolongates it from the one above on
 * the GPU, solves it, and moves on; the graph's nodes are placed from the last level at the end.
 *
 * Two sources build one:
 *
 * - **A coarsening hierarchy** ({@link coarseSeedPlan}; heavy-edge matching, built in the layout worker, the
 *   same hierarchy as the LOD tree). This is the CPU {@link multilevelSeed}, level for level: the same
 *   masses, aggregated weights and normalised attraction, the same tick schedule, the same phyllotaxis
 *   placement ({@link placeChildren}) and the same top-level ring, centred on the viewport. Every level is
 *   laid out at the finest level's equilibrium scale, so the refine starts at its own scale.
 * - **A module tree** ({@link moduleSeedPlan}; #180, a provided Infomap hierarchy), traversed by **depth**
 *   from the roots down. A module tree is ragged: a leaf that ends at depth d is placed with its parent there
 *   and never subdivided, so each level lists its terminal leaves and the GPU gathers them into node order
 *   (the leaf seed) as it goes. Its levels are mass-weighted as the coarsening's are, with the super-edges'
 *   summed edge weights as spring weights.
 *
 * A top level is placed about a virtual root, {@link SeedPlan.root}: its slots all have parent slot 0, and
 * the solver writes the root's position there before the first prolongation.
 */
import { buildCSR } from "../graph.js";
import {
  coarseAttractionScale,
  coarseLevelMasses,
  DEFAULT_COARSEN_ITERATIONS,
  DEFAULT_MAX_SEED_NODES,
  placeChildren,
  seedLevelTicks,
  type CoarseLevel,
  type Hierarchy,
} from "../coarsen.js";
import { DEFAULT_FORCE, seedSpacing, springStabilizers, type ForceParams } from "../force.js";
import type { LODTopology } from "../lod.js";
import { buildHubChunks } from "./hub-chunks.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** One level of a {@link SeedPlan}, in the level's own slot ids `[0, count)`. */
export interface SeedLevel {
  /** Slots at this level. */
  readonly count: number;
  /** Per slot: its parent's slot in the level above (the top level: 0, the virtual root). */
  readonly parent: Uint32Array;
  /** Per slot: its offset from its parent, interleaved `[dx, dy, …]`. */
  readonly offset: Float32Array;
  /** Per slot: how many finest nodes it stands for. */
  readonly mass: Float32Array;
  /** The springs: a symmetric CSR over the slots (`count + 1` row offsets) … */
  readonly offsets: Uint32Array;
  /** … its entries (neighbour slots) … */
  readonly neighbors: Uint32Array;
  /** … and each entry's aggregated edge weight. */
  readonly weights: Float32Array;
  /** The CSR's hub chunk table (`buildHubChunks`, 4 uint32 per chunk) and its chunk count. */
  readonly chunks: Uint32Array;
  readonly chunkCount: number;
  /** Per slot: the spring stabilizer `1 / (1 + K̃ · weighted degree / mass)` (`springStabilizers`). */
  readonly stab: Float32Array;
  /** Ticks to solve the level for, cooled over them; 0 = placed only (and then its CSR is empty). */
  readonly ticks: number;
  /** Terminal leaves at this level (a ragged module tree), interleaved `[slot, node id, …]`: 2 per leaf. */
  readonly leaves: Uint32Array;
}

/** How the graph's nodes are placed from the last level: a prolongation, one parent slot and offset per node. */
export interface SeedFinest {
  readonly parent: Uint32Array;
  readonly offset: Float32Array;
}

/** A multilevel seed for the GPU solver (see the file header). */
export interface SeedPlan {
  /** Nodes of the graph the seed places. */
  readonly nodeCount: number;
  /** The virtual root the top level rings: the viewport centre, less the top level's centre of mass. */
  readonly root: readonly [number, number];
  /** The levels, coarsest first. */
  readonly levels: readonly SeedLevel[];
  /**
   * The graph's nodes from the last level: a prolongation, or `null` when every node is a terminal leaf of
   * some level (a module tree), gathered from the leaf seed.
   */
  readonly finest: SeedFinest | null;
  /** Spring strength on every level: `attraction · edges / Σ weight`, so an aggregated weight counts edges. */
  readonly attraction: number;
}

/** What a plan is built for: the viewport, the force model, and the CPU seed's schedule knobs. */
export interface SeedPlanOptions {
  width: number;
  height: number;
  force?: Partial<ForceParams>;
  /** Ticks per solved level (default 30, as the CPU seed). */
  coarsenIterations?: number;
  /** Largest level solved for the full `coarsenIterations` (default 16384, as the CPU seed). */
  maxSeedNodes?: number;
}

/** The largest of each per-level size a solver must hold to run `plan` (its seed textures are sized to them). */
export interface SeedPlanCapacity {
  /** Most slots of any level. */
  readonly slots: number;
  /** Most CSR entries of any level. */
  readonly entries: number;
  /** Most hub chunks of any level. */
  readonly chunks: number;
  /** Most terminal leaves of any level (0 when the finest level is prolongated). */
  readonly leaves: number;
}

/** The capacity `plan` needs. O(levels). */
export function seedPlanCapacity(plan: SeedPlan): SeedPlanCapacity {
  let slots = 0;
  let entries = 0;
  let chunks = 0;
  let leaves = 0;
  for (const level of plan.levels) {
    slots = Math.max(slots, level.count);
    entries = Math.max(entries, level.neighbors.length);
    chunks = Math.max(chunks, level.chunkCount);
    leaves = Math.max(leaves, level.leaves.length / 2);
  }
  return { slots, entries, chunks, leaves };
}

/** Every buffer behind `plan`'s typed arrays, each once: the transfer list that moves it out of the worker. */
export function seedPlanTransferables(plan: SeedPlan): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView): void => {
    if (a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  };
  for (const level of plan.levels) {
    for (const a of [level.parent, level.offset, level.mass, level.offsets, level.neighbors, level.weights, level.chunks, level.stab, level.leaves]) add(a);
  }
  if (plan.finest) {
    add(plan.finest.parent);
    add(plan.finest.offset);
  }
  return [...buffers];
}

/**
 * The GPU seed of a coarsening hierarchy: the CPU {@link multilevelSeed} as a plan (see the file header).
 * `null` when the graph cannot be coarsened (a tiny or edge-less graph): the caller seeds a disc, as the CPU
 * seed does. O(hierarchy size + Σ level edges); allocates only the plan (the hierarchy is left intact).
 */
export function coarseSeedPlan(graph: CoarseLevel, hierarchy: Hierarchy, opts: SeedPlanOptions): SeedPlan | null {
  const { levels, projections } = hierarchy;
  const masses = coarseLevelMasses(hierarchy);
  const top = masses.length; // the coarsest level's index in `levels`
  if (top === 0) return null;
  const params: ForceParams = { ...DEFAULT_FORCE, ...opts.force };
  const coarseParams: ForceParams = { ...params, attraction: params.attraction * coarseAttractionScale(graph) };
  const spacing = seedSpacing(graph.nodeCount, opts.width, opts.height, params);
  const coarsenIterations = opts.coarsenIterations ?? DEFAULT_COARSEN_ITERATIONS;
  const maxSeedNodes = opts.maxSeedNodes ?? DEFAULT_MAX_SEED_NODES;

  const planLevels: SeedLevel[] = [];
  let root: [number, number] = [opts.width / 2, opts.height / 2];
  for (let k = top; k >= 1; k--) {
    const level = levels[k];
    const mass = masses[k - 1];
    if (!level || !mass) return null; // buildHierarchy pairs every level with its masses
    const count = level.nodeCount;
    const parent = new Uint32Array(count);
    const offset = new Float32Array(count * 2);
    if (k === top) {
      // The coarsest level rings the virtual root (one parent for all), which sits so that the level's
      // centre of mass is the viewport centre — as the CPU seed shifts its ring (the forces conserve it).
      placeChildren(parent, mass, 1, count, spacing, (i, _c, dx, dy) => {
        offset[i * 2] = dx;
        offset[i * 2 + 1] = dy;
      });
      let mx = 0;
      let my = 0;
      mass.forEach((m, i) => {
        mx += m * (offset[i * 2] ?? 0);
        my += m * (offset[i * 2 + 1] ?? 0);
      });
      root = [opts.width / 2 - mx / graph.nodeCount, opts.height / 2 - my / graph.nodeCount];
    } else {
      const up = projections[k]; // level k → level k + 1, the level above
      const above = levels[k + 1];
      if (!up || !above) return null;
      placeChildren(up, mass, above.nodeCount, count, spacing, (i, c, dx, dy) => {
        parent[i] = c;
        offset[i * 2] = dx;
        offset[i * 2 + 1] = dy;
      });
    }
    const ticks = seedLevelTicks(count, coarsenIterations, maxSeedNodes);
    planLevels.push(seedLevel(count, parent, offset, mass, level, coarseParams, ticks, new Uint32Array(0)));
  }

  // The graph's nodes (unit mass) about their level-1 parents.
  const up = projections[0];
  const first = levels[1];
  if (!up || !first) return null;
  const finestParent = new Uint32Array(graph.nodeCount);
  const finestOffset = new Float32Array(graph.nodeCount * 2);
  placeChildren(up, undefined, first.nodeCount, graph.nodeCount, spacing, (i, c, dx, dy) => {
    finestParent[i] = c;
    finestOffset[i * 2] = dx;
    finestOffset[i * 2 + 1] = dy;
  });
  return {
    nodeCount: graph.nodeCount,
    root,
    levels: planLevels,
    finest: { parent: finestParent, offset: finestOffset },
    attraction: coarseParams.attraction,
  };
}

/**
 * Whether {@link moduleSeedPlan} can seed from this topology: it needs the parent map and the directed
 * super-edge CSR (the modules' adjacency) with at least one super-edge, and its leaves must be the graph's
 * nodes. Module trees built with the graph's edges satisfy this; module-less or edge-less graphs do not.
 */
export function canModuleSeed(topo: LODTopology, nodeCount: number): boolean {
  return (
    !!topo.parent &&
    !!topo.superEdgeOffset &&
    !!topo.superEdgeTarget &&
    topo.superEdgeTarget.length > 0 &&
    topo.leafCount === nodeCount &&
    topo.size > nodeCount
  );
}

/**
 * The GPU seed of a module tree (#180): one level per depth, from the roots (depth 0) down, each slot
 * ringing its parent module at the cumulative mass of its earlier siblings and weighing the leaves under
 * it; a leaf ends at its own depth (listed in that level's leaves) and is never subdivided. Springs are the
 * super-edges between two nodes of one depth, weighted by their summed edge weights (lift pairs between
 * depths, #325, are left out: a slot means something only within its depth). `graph` is the graph the tree
 * was built over (its edge weights normalise the attraction). `null` unless {@link canModuleSeed}, or when
 * the tree has no depth below its roots. O(tree size + super-edges).
 */
export function moduleSeedPlan(topo: LODTopology, graph: CoarseLevel, opts: SeedPlanOptions): SeedPlan | null {
  const { size, leafCount, parent, superEdgeOffset, superEdgeTarget, superEdgeFlow } = topo;
  if (!canModuleSeed(topo, graph.nodeCount) || !parent || !superEdgeOffset || !superEdgeTarget) return null;
  const params: ForceParams = { ...DEFAULT_FORCE, ...opts.force };
  const coarseParams: ForceParams = { ...params, attraction: params.attraction * coarseAttractionScale(graph) };
  const spacing = seedSpacing(leafCount, opts.width, opts.height, params);
  const coarsenIterations = opts.coarsenIterations ?? DEFAULT_COARSEN_ITERATIONS;
  const maxSeedNodes = opts.maxSeedNodes ?? DEFAULT_MAX_SEED_NODES;

  // Depth of every tree node (root = 0). A module tree numbers a parent above all its children, so one
  // descending pass finalises each parent before its children.
  const depth = new Int32Array(size);
  let maxDepth = 0;
  for (let g = size - 1; g >= 0; g--) {
    const p = parent[g] ?? -1;
    const d = p < 0 ? 0 : (depth[p] ?? 0) + 1;
    depth[g] = d;
    if (d > maxDepth) maxDepth = d;
  }
  if (maxDepth < 1) return null;

  // Each node's slot within its depth, by ascending id (deterministic), and the depth-ordered ids.
  const depthCount = new Uint32Array(maxDepth + 1);
  for (let g = 0; g < size; g++) {
    const d = depth[g] ?? 0;
    depthCount[d] = (depthCount[d] ?? 0) + 1;
  }
  const depthOffset = new Uint32Array(maxDepth + 2);
  for (let d = 0; d <= maxDepth; d++) depthOffset[d + 1] = (depthOffset[d] ?? 0) + (depthCount[d] ?? 0);
  const slot = new Uint32Array(size);
  const byDepth = new Uint32Array(size);
  const cursor = depthOffset.slice(0, maxDepth + 1);
  for (let g = 0; g < size; g++) {
    const d = depth[g] ?? 0;
    const at = cursor[d] ?? 0;
    slot[g] = at - (depthOffset[d] ?? 0);
    byDepth[at] = g;
    cursor[d] = at + 1;
  }

  // Leaves under every node: its mass. Children number below their parent, so one ascending pass finishes
  // each node before adding it upward.
  const mass = new Float32Array(size);
  mass.fill(1, 0, leafCount);
  for (let g = 0; g < size; g++) {
    const p = parent[g] ?? -1;
    if (p >= 0) mass[p] = (mass[p] ?? 0) + (mass[g] ?? 0);
  }

  // Per node (depth order): parent slot and offset — a phyllotaxis disc about the parent at the cumulative
  // mass of the earlier siblings, one equilibrium spacing² of area per leaf; roots ring the virtual root.
  const k = spacing / Math.sqrt(Math.PI);
  const parentSlot = new Uint32Array(size);
  const offset = new Float32Array(size * 2);
  const filled = new Float32Array(size);
  const rank = new Uint32Array(size);
  let rootFilled = 0;
  let rootRank = 0;
  for (let i = 0; i < size; i++) {
    const g = byDepth[i] ?? 0;
    const p = parent[g] ?? -1;
    const m = mass[g] ?? 0;
    let before: number;
    let turn: number;
    if (p < 0) {
      before = rootFilled;
      rootFilled += m;
      turn = rootRank++;
    } else {
      parentSlot[i] = slot[p] ?? 0;
      before = filled[p] ?? 0;
      filled[p] = before + m;
      turn = (rank[p] ?? 0) + (slot[p] ?? 0);
      rank[p] = (rank[p] ?? 0) + 1;
    }
    const r = k * Math.sqrt(before + m / 2);
    const a = turn * GOLDEN;
    offset[2 * i] = r * Math.cos(a);
    offset[2 * i + 1] = r * Math.sin(a);
  }
  // The virtual root: the viewport centre, shifted so the roots' centre of mass lands on it.
  let mx = 0;
  let my = 0;
  let mt = 0;
  for (let q = 0; q < (depthCount[0] ?? 0); q++) {
    const m = mass[byDepth[q] ?? 0] ?? 0;
    mx += m * (offset[2 * q] ?? 0);
    my += m * (offset[2 * q + 1] ?? 0);
    mt += m;
  }
  const root: [number, number] = [opts.width / 2 - mx / mt, opts.height / 2 - my / mt];

  // Per depth: its same-depth super-edges in slot ids, with their summed edge weights.
  const levels: SeedLevel[] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const o0 = depthOffset[d] ?? 0;
    const count = depthCount[d] ?? 0;
    let edges = 0;
    let leaves = 0;
    for (let i = o0; i < o0 + count; i++) {
      const g = byDepth[i] ?? 0;
      if (g < leafCount) leaves++;
      for (let e = superEdgeOffset[g] ?? 0; e < (superEdgeOffset[g + 1] ?? 0); e++) {
        if (depth[superEdgeTarget[e] ?? 0] === d) edges++;
      }
    }
    const source = new Uint32Array(edges);
    const target = new Uint32Array(edges);
    const weight = new Float32Array(edges);
    const leafPairs = new Uint32Array(leaves * 2);
    let e2 = 0;
    let l2 = 0;
    for (let i = o0; i < o0 + count; i++) {
      const g = byDepth[i] ?? 0;
      if (g < leafCount) {
        leafPairs[l2++] = i - o0;
        leafPairs[l2++] = g;
      }
      for (let e = superEdgeOffset[g] ?? 0; e < (superEdgeOffset[g + 1] ?? 0); e++) {
        const t = superEdgeTarget[e] ?? 0;
        if (depth[t] !== d) continue; // a lift pair (#325)
        source[e2] = i - o0;
        target[e2] = slot[t] ?? 0;
        weight[e2] = superEdgeFlow?.[e] ?? 1;
        e2++;
      }
    }
    const levelMass = new Float32Array(count);
    for (let s = 0; s < count; s++) levelMass[s] = mass[byDepth[o0 + s] ?? 0] ?? 0;
    // A depth of terminal leaves only (a non-ragged tree's deepest) is the graph's own nodes: they are
    // placed, and the refine solves them — as the coarsening seed never solves the finest level.
    const ticks = leaves === count ? 0 : seedLevelTicks(count, coarsenIterations, maxSeedNodes);
    levels.push(
      seedLevel(
        count,
        parentSlot.slice(o0, o0 + count),
        offset.slice(2 * o0, 2 * (o0 + count)),
        levelMass,
        { nodeCount: count, source, target, weight },
        coarseParams,
        ticks,
        leafPairs,
      ),
    );
  }
  return { nodeCount: graph.nodeCount, root, levels, finest: null, attraction: coarseParams.attraction };
}

/**
 * One plan level from its placement, masses and weighted edge list: builds the CSR, hub chunks and stabilizers
 * — or, for a level placed without a solve (no ticks), none: its springs would never be drawn.
 */
function seedLevel(
  count: number,
  parent: Uint32Array,
  offset: Float32Array,
  mass: Float32Array,
  edges: CoarseLevel,
  params: ForceParams,
  ticks: number,
  leaves: Uint32Array,
): SeedLevel {
  if (ticks === 0) {
    return {
      count,
      parent,
      offset,
      mass,
      offsets: new Uint32Array(count + 1),
      neighbors: new Uint32Array(0),
      weights: new Float32Array(0),
      chunks: new Uint32Array(0),
      chunkCount: 0,
      stab: new Float32Array(count).fill(1),
      ticks,
      leaves,
    };
  }
  const { source, target, weight } = edges;
  const csr = buildCSR(count, source, target, weight);
  const hubs = buildHubChunks(csr.offsets);
  return {
    count,
    parent,
    offset,
    mass,
    offsets: csr.offsets,
    neighbors: csr.neighbors,
    weights: csr.weights ?? new Float32Array(csr.neighbors.length).fill(1),
    chunks: hubs.table,
    chunkCount: hubs.count,
    stab: springStabilizers(count, source, target, source.length, params, mass, weight),
    ticks,
    leaves,
  };
}
