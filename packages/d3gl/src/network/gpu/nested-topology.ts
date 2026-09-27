// ─────────────────────────────────────────────────────────────────────────────
// CPU prep of the batched GPU nested layout (#355, spec §11.1) — pure, node-tested.
// ─────────────────────────────────────────────────────────────────────────────
//
// The CPU nested layout (`nested-layout.ts`) solves each module's children in its own unit disc, top-down.
// A module's solve reads only static data (its children's weights, their sibling links, the spiral or
// warm seed); the parent's disc is read only when the result is mapped into it. So every module at every
// depth can solve at once: ONE segmented solve over all tree nodes except the root, segment = parent
// module, followed by a composition that maps each local solution into its parent's world disc.
//
// This module turns a module tree into that solve's data:
//
// - **Slots.** Every non-root tree node is a child in exactly one segment. Segments are sorted by
//   (parent depth, parent id), and within a segment the slots follow the children CSR — so a slot's local
//   index `slot − segment start` is the CPU solve's local child index.
// - **Per slot:** its unit-disc radius and seed position, from the CPU's own {@link setupModule} — the
//   GPU solves exactly the problem the CPU solves.
// - **Per segment:** its parent module, the parent's slot (the composition's owner) and its starting alpha
//   (1 cold, {@link WARM_ALPHA} warm).
// - **Collision:** the radius-class grid's static data — every slot's class, each segment's list, exact
//   slots and hash buckets (`collision-plan.ts`, #380).
// - **Links:** every segment's sparsified, weighted sibling links in slot ids (a spring each way stays two
//   links, as the CPU solves it). They never cross segments, by construction.
//
// k = 1 segments are FROZEN on the GPU: no forces act on a lone child (its seed is the origin), and the
// composition places it at its parent's centre with 0.9 of its radius, as the CPU does.
//
// Everything here is typed arrays, so the result can be posted from a worker with its buffers
// transferred. Cost: O(tree size + Σ links · log links) (the per-module link sparsification sorts).
import { collisionPlan, type CollisionPlan } from "./collision-plan.js";
import {
  EXACT_MAX,
  NESTED,
  Scratch,
  WARM_ALPHA,
  placeOver,
  setupModule,
  subtreeWeights,
  warmStart,
  type NestedLayoutParams,
  type NestedLayoutResult,
  type NestedLayoutTopology,
} from "../nested-layout.js";

/** The data of one batched nested solve — see the file header. */
export interface NestedSolverTopology {
  /** Solver slots: every tree node except the root. */
  readonly slotCount: number;
  /** Segments, one per module with at least one child: first slot and slot count. */
  readonly segStart: Uint32Array;
  readonly segCount: Uint32Array;
  /** Tree id of each segment's parent module. */
  readonly segModule: Uint32Array;
  /** Slot of each segment's parent module, −1 for the root's segment (the composition walks these up). */
  readonly segOwner: Int32Array;
  /** Each segment's starting alpha: 1, or {@link WARM_ALPHA} when its children are warm-seeded. */
  readonly segAlpha0: Float32Array;
  /** The collision grid's classes, lists, exact slots and buckets (segments above {@link EXACT_MAX} children). */
  readonly collision: CollisionPlan;
  /** Tree id of each slot's node. */
  readonly slotNode: Uint32Array;
  /** Slot of each tree node, −1 for the root. */
  readonly nodeSlot: Int32Array;
  /** Each slot's disc radius in its parent's unit disc. */
  readonly radius: Float32Array;
  /** Each slot's seed position in its parent's unit disc, interleaved `[x, y, …]`. */
  readonly seed: Float32Array;
  /** Sibling links in slot ids and their spring weights. */
  readonly linkSource: Uint32Array;
  readonly linkTarget: Uint32Array;
  readonly linkWeight: Float32Array;
  /** Composition depth: the longest chain of segments from the root's down to a leaf's. */
  readonly depth: number;
  /** Leaves (tree ids `0 … leafCount − 1`) and tree nodes. */
  readonly leafCount: number;
  readonly treeSize: number;
  /** The root module's tree id. */
  readonly root: number;
  /** Ticks of the solve (every segment runs all of them, as each CPU module does). */
  readonly iterations: number;
  /** The root disc's radius, in world units. */
  readonly rootRadius: number;
  /**
   * A warm start's placement (#328): the known leaves' centroid `(tx, ty)` and RMS spread in the
   * initial positions, which the result is placed over — or `null` for a cold layout.
   */
  readonly place: { readonly tx: number; readonly ty: number; readonly spread: number } | null;
}

/**
 * Build the batched GPU solve of `topo` under `params` (the worker's {@link NestedLayoutParams}): the
 * slots, segments, per-slot radii and seeds, links and composition data — see the file header. Throws
 * when the topology has no root module (as `nestedLayout` does).
 */
export function nestedSolverTopology(topo: NestedLayoutTopology, params: NestedLayoutParams = {}): NestedSolverTopology {
  const { size, leafCount, childOffset, children, parent } = topo;
  const iterations = Math.max(1, params.iterations ?? 100);
  const packing = params.packing ?? 0.45;
  const { weight, root } = subtreeWeights(topo, params.size);
  const warm = params.initial ? warmStart(topo, params.initial, root) : null;

  // Depth of every tree node, top-down: a parent has a higher id than its children.
  const depth = new Uint32Array(size);
  for (let g = size - 1; g >= 0; g--) {
    const p = parent[g] ?? -1;
    if (p >= 0) depth[g] = (depth[p] ?? 0) + 1;
  }

  // Segments: every module with a child, sorted by (depth, id) — each depth's slots are contiguous.
  const modules: number[] = [];
  for (let g = leafCount; g < size; g++) if ((childOffset[g + 1] ?? 0) > (childOffset[g] ?? 0)) modules.push(g);
  modules.sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0) || a - b);
  const segments = modules.length;
  const segStart = new Uint32Array(segments);
  const segCount = new Uint32Array(segments);
  const segModule = new Uint32Array(segments);
  const segOwner = new Int32Array(segments);
  const segAlpha0 = new Float32Array(segments);
  const slotCount = size - 1;
  const slotNode = new Uint32Array(slotCount);
  const nodeSlot = new Int32Array(size).fill(-1);
  const radius = new Float32Array(slotCount);
  const seed = new Float32Array(2 * slotCount);

  let slot = 0;
  let maxDepth = 0;
  modules.forEach((g, s) => {
    const start = childOffset[g] ?? 0;
    const end = childOffset[g + 1] ?? 0;
    segStart[s] = slot;
    segCount[s] = end - start;
    segModule[s] = g;
    maxDepth = Math.max(maxDepth, (depth[g] ?? 0) + 1);
    for (let c = start; c < end; c++) {
      const node = children[c] ?? 0;
      slotNode[slot] = node;
      nodeSlot[node] = slot;
      slot++;
    }
  });
  if (slot !== slotCount) {
    throw new Error(`nestedSolverTopology: the tree's segments hold ${slot} children, not its ${slotCount} non-root nodes`);
  }
  modules.forEach((g, s) => {
    segOwner[s] = nodeSlot[g] ?? -1;
  });

  // Per segment: the CPU's own module setup (radii, seed, links), copied into slot order.
  const scratch = new Scratch();
  const linkSource: number[] = [];
  const linkTarget: number[] = [];
  const linkWeight: number[] = [];
  modules.forEach((g, s) => {
    const start = childOffset[g] ?? 0;
    const end = childOffset[g + 1] ?? 0;
    const k = end - start;
    const base = segStart[s] ?? 0;
    segAlpha0[s] = 1;
    if (k === 1) return; // FROZEN: radius and seed stay 0, no links
    const setup = setupModule(topo, g, start, end, weight, packing, scratch, warm);
    segAlpha0[s] = setup.seeded ? WARM_ALPHA : 1;
    for (let i = 0; i < k; i++) {
      radius[base + i] = scratch.rad[i] ?? 0;
      seed[2 * (base + i)] = scratch.x[i] ?? 0;
      seed[2 * (base + i) + 1] = scratch.y[i] ?? 0;
    }
    for (let l = 0; l < setup.la.length; l++) {
      linkSource.push(base + (setup.la[l] ?? 0));
      linkTarget.push(base + (setup.lb[l] ?? 0));
      linkWeight.push(setup.lw[l] ?? 0);
    }
  });

  const rootRadius = params.radius ?? 10 * Math.sqrt(leafCount);
  return {
    slotCount,
    segStart,
    segCount,
    segModule,
    segOwner,
    segAlpha0,
    collision: collisionPlan(radius, segStart, segCount, EXACT_MAX, NESTED.PAD),
    slotNode,
    nodeSlot,
    radius,
    seed,
    linkSource: Uint32Array.from(linkSource),
    linkTarget: Uint32Array.from(linkTarget),
    linkWeight: Float32Array.from(linkWeight),
    depth: maxDepth,
    leafCount,
    treeSize: size,
    root,
    iterations,
    rootRadius,
    place: warm ? { tx: warm.ox[root] ?? 0, ty: warm.oy[root] ?? 0, spread: warm.spread } : null,
  };
}

/** The typed arrays of a {@link NestedSolverTopology} — the buffers a worker transfers when it posts one. */
export function nestedSolverBuffers(t: NestedSolverTopology): ArrayBuffer[] {
  const c = t.collision;
  const arrays = [
    t.segStart, t.segCount, t.segModule, t.segOwner, t.segAlpha0, t.slotNode, t.nodeSlot, t.radius, t.seed,
    t.linkSource, t.linkTarget, t.linkWeight,
    c.slotCollide, c.items, c.segCellSide, c.segClasses, c.segList, c.segBucketBase, c.segBucketMask, c.segSubBase,
    c.binnedSlots, c.slotWork,
  ];
  const buffers: ArrayBuffer[] = [];
  for (const a of arrays) if (a.buffer instanceof ArrayBuffer) buffers.push(a.buffer);
  return buffers;
}

/**
 * The layout result of a GPU solve, in the CPU `nestedLayout`'s shape: `positions` (the composed leaf
 * positions, `2 · leaves` floats, adopted — not copied) and every tree node's disc from `discs` (`(cx, cy,
 * r, 0)` per module, as the composition packs them; a leaf's disc is its position with radius 0). A warm
 * start (`topo.place`) is then placed over the current map — the known leaves of `initial` (finite
 * coordinates) keep their centroid and, unless the root radius was given (`rescale` false), their RMS
 * spread — in float64 on the CPU, as the CPU layout does (#328). O(tree size + leaves).
 */
export function nestedSolverResult(
  topo: NestedSolverTopology,
  positions: Float32Array,
  discs: Float32Array,
  initial: ArrayLike<number> | undefined,
  rescale: boolean,
): NestedLayoutResult {
  const { treeSize, leafCount } = topo;
  const cx = new Float32Array(treeSize);
  const cy = new Float32Array(treeSize);
  const r = new Float32Array(treeSize);
  for (let i = 0; i < leafCount; i++) {
    cx[i] = positions[2 * i] ?? 0;
    cy[i] = positions[2 * i + 1] ?? 0;
  }
  for (let m = 0; m < treeSize - leafCount; m++) {
    cx[leafCount + m] = discs[4 * m] ?? 0;
    cy[leafCount + m] = discs[4 * m + 1] ?? 0;
    r[leafCount + m] = discs[4 * m + 2] ?? 0;
  }
  if (topo.place && initial) {
    const known = new Uint8Array(leafCount);
    for (let i = 0; i < leafCount; i++) {
      known[i] = Number.isFinite(initial[2 * i] ?? Number.NaN) && Number.isFinite(initial[2 * i + 1] ?? Number.NaN) ? 1 : 0;
    }
    placeOver({ size: treeSize, leafCount }, known, topo.place, rescale, positions, cx, cy, r);
  }
  return { positions, cx, cy, r };
}
