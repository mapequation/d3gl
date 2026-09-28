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
// - **Per segment:** its parent module, the parent's slot (the composition's owner), its starting alpha
//   (1 cold, {@link WARM_ALPHA} warm), and for collision the 9th-largest radius and the at most 8 larger
//   ("large") slots.
// - **Links:** every segment's sparsified, weighted sibling links in slot ids (a spring each way stays two
//   links, as the CPU solves it). They never cross segments, by construction.
//
// k = 1 segments are FROZEN on the GPU: no forces act on a lone child (its seed is the origin), and the
// composition places it at its parent's centre with 0.9 of its radius, as the CPU does.
//
// Everything here is typed arrays, so the result can be posted from a worker with its buffers
// transferred. Cost: O(tree size + Σ links · log links) (the per-module link sparsification sorts).
import {
  EXACT_MAX,
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

/** Most "large" slots a segment has: every other slot's radius is at most the 9th-largest (spec §11.1). */
export const NESTED_LARGE_MAX = 8;

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
  /**
   * Each segment's 9th-largest child radius (0 when it has at most 9 children): its collision grid's
   * cells are at least `2 · r₉ · PAD` wide, so two discs no larger than r₉ that touch are at most one
   * cell apart. Only read for segments above {@link EXACT_MAX} children.
   */
  readonly segR9: Float32Array;
  /**
   * Each segment's slots with a radius above its r₉ (at most {@link NESTED_LARGE_MAX}; −1 pads),
   * {@link NESTED_LARGE_MAX} entries per segment. Collision tests them exactly, never through the grid.
   * Filled only for segments above {@link EXACT_MAX} children.
   */
  readonly segLarge: Int32Array;
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
  const segR9 = new Float32Array(segments);
  const segLarge = new Int32Array(segments * NESTED_LARGE_MAX).fill(-1);
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
  const order: number[] = [];
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
    if (k <= EXACT_MAX) return;
    // Collision: r₉ and the slots above it (at most 8, since only 8 radii exceed the 9th-largest) —
    // compared in float32, as the cell pass compares them: a slot it bins must not also be large.
    order.length = 0;
    for (let i = 0; i < k; i++) order.push(i);
    order.sort((a, b) => (scratch.rad[b] ?? 0) - (scratch.rad[a] ?? 0) || a - b);
    const r9 = Math.fround(scratch.rad[order[NESTED_LARGE_MAX] ?? 0] ?? 0);
    segR9[s] = r9;
    let large = 0;
    for (let rank = 0; rank < NESTED_LARGE_MAX; rank++) {
      const i = order[rank] ?? 0;
      if (Math.fround(scratch.rad[i] ?? 0) > r9) segLarge[s * NESTED_LARGE_MAX + large++] = base + i;
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
    segR9,
    segLarge,
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
  const arrays = [
    t.segStart, t.segCount, t.segModule, t.segOwner, t.segAlpha0, t.segR9, t.segLarge,
    t.slotNode, t.nodeSlot, t.radius, t.seed, t.linkSource, t.linkTarget, t.linkWeight,
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
