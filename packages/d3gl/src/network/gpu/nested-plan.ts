// ─────────────────────────────────────────────────────────────────────────────
// The passes of the nested GPU solve's stream ticks and readbacks, with their cost model (#355, #382) —
// pure data, so the per-frame budget can be checked at any N without a GPU.
// ─────────────────────────────────────────────────────────────────────────────
//
// `GpuNestedLayout` binds each step to its pass; the streaming schedule (`stream-schedule.ts`) cuts every
// step into row bands of at most half the frame budget. See `gpu-nested-layout.ts` for what each pass does.

import { buildCSR } from "../graph.js";
import { EXACT_MAX } from "../nested-layout.js";
import { buildHubChunks } from "./hub-chunks.js";
import type { NestedSolverTopology } from "./nested-topology.js";
import { COLLISION_ROUNDS } from "./passes/collision.js";
import { TILE_MIN_SIDE, packTiles, reduceLayout, type SlotRange } from "./segments.js";
import type { StageCost } from "./stream-schedule.js";
import { atlasWidth } from "./textures.js";

/** A pass's GPU cost: `fixedMs` that each band pays whatever its size, and the per-leaf part that slicing divides. */
export interface PassCost {
  readonly fixedMs: number;
  readonly nsPerLeaf: number;
  /**
   * µs per child of the largest module that each band may wait for, on top of `fixedMs`: the pass's
   * longest single fragment loops over its whole segment, and a band ends only when it does.
   */
  readonly tailUsPerChild?: number;
}

/**
 * GPU cost of each pass of the nested solve, measured on an M1 Max (ANGLE Metal) on the synthetic
 * Infomap-like maps (325,729 and 1,000,000 leaves; largest module 4,592 and 6,643 children), each pass
 * timed alone, whole and in 4 bands, over the states of a whole layout (the early compact ticks are the
 * collision's heaviest). `fixedMs` comes from the band difference; the two terms together cover both maps'
 * measured cost with a margin of ~15-25%, so that the estimate neither overruns a frame nor leaves most of
 * it idle. Most small passes are all setup (a render pass costs ~0.05-0.3 ms whatever it draws); the springs,
 * the repulsion and the collision gather scale. A slower GPU is caught by the frame budget's fences, as for
 * the flat layout. Measured whole, 325k / 1M, in the comments.
 */
export const NESTED_COST = {
  /** Reduction tree level 1 (the map over 16 slots per texel): 0.18-0.30 / 0.32-0.46 ms. */
  tree: { fixedMs: 0.12, nsPerLeaf: 0.3 },
  /** Reduction levels 2…L (the first band) and the range query per segment: 0.27-0.40 / 0.34-0.52 ms. */
  query: { fixedMs: 0.3, nsPerLeaf: 0.2 },
  /** Grid pyramid: the scatter of every tiled slot: 0.12 / 0.24 ms. */
  scatter: { fixedMs: 0.07, nsPerLeaf: 0.17 },
  /** Grid pyramid: the 2×2 reduces of every level, one render pass per level in each band: 0.36 / 0.36 ms. */
  levels: { fixedMs: 0.3, nsPerLeaf: 0.06 },
  /** Repulsion — tile walks and exact loops (the first band clears the force accumulator): 2.2 / 5.7-5.9 ms. */
  repulsion: { fixedMs: 0.2, nsPerLeaf: 6.2 },
  /** Predict v*: 0.04-0.10 ms. */
  predict: { fixedMs: 0.06, nsPerLeaf: 0.05 },
  /** The springs' hub chunk partials (only with hub rows; none on the measured maps). */
  hubs: { fixedMs: 0.1, nsPerLeaf: 0.5 },
  /** The springs' row gather + integrate (the first band clears the accumulator): 0.8-0.98 / 2.1-2.5 ms. */
  springs: { fixedMs: 0.12, nsPerLeaf: 2.6 },
  /** Collision cells and discs: 0.04-0.06 / 0.06-0.11 ms. */
  cells: { fixedMs: 0.06, nsPerLeaf: 0.04 },
  /** Collision occupancy count (a scatter of every slot): 0.06-0.22 / 0.16-0.26 ms. */
  count: { fixedMs: 0.08, nsPerLeaf: 0.2 },
  /** One collision round (a scatter of every slot; later rounds contend more): 0.15-0.20 / 0.18-0.40 ms. */
  round: { fixedMs: 0.1, nsPerLeaf: 0.3 },
  /**
   * Collision gather: 4.1-4.7 / 8.2-11.3 ms whole. A large slot, or one next to an overflowing cell, loops
   * over its whole segment, ~0.3 µs per sibling: each band waits for its longest such fragment (measured
   * 1.2 / 2.0 ms per extra band; 9.5 ms in 2 bands, 12.5 in 4, 15.3 in 8, 17.1 in 16 at 1M).
   */
  gather: { fixedMs: 0.1, nsPerLeaf: 9, tailUsPerChild: 0.3 },
  /** Composition of every leaf and module (each walks ≤ D ancestors): 0.14 / 0.32-0.34 ms. */
  compose: { fixedMs: 0.08, nsPerLeaf: 0.25 },
} as const satisfies Record<string, PassCost>;

/** A pass of the nested solve. */
export type NestedPass = keyof typeof NESTED_COST;

/** The sizes the nested solve's passes are cut over, and the cost model's N. */
export interface NestedPlanSizes {
  /** Leaves: the cost model's N. */
  readonly leaves: number;
  /** Rows of the slot atlas (every per-slot pass, the scatters' slot ranges). */
  readonly slotRows: number;
  /** Rows of the reduction tree's level 1. */
  readonly treeRows: number;
  /** Rows of the segment table (the range queries). */
  readonly tableRows: number;
  /** Rows of the grid pyramid's level 1; 0 without a pyramid (no segment above the exact threshold). */
  readonly levelRows: number;
  /** Rows of the springs' hub chunk atlas; 0 without hub rows. */
  readonly hubRows: number;
  /** Rows of the composition's staging atlas. */
  readonly composeRows: number;
  /** Children of the largest module: the longest loop of a pass that tests a whole segment. */
  readonly largestModule: number;
}

/** One pass of a nested stream tick or readback, as data: which pass, its cost and rows, and what it needs. */
export interface NestedStep extends StageCost {
  readonly pass: NestedPass;
  /** Of the readback (the composition's own reduction and sums) rather than the solve. */
  readonly readback: boolean;
  /** predict, hubs, springs: of the organise phase (repulsion added, zero-rest springs, the tick ends). */
  readonly organising: boolean;
  /** round: its index r; a readback's tree / query: the reduce mode (1: weighted centroids, 2: extents); else 0. */
  readonly index: number;
}

/** The passes of each kind of stream tick, and of a readback, in order. */
export interface NestedPlan {
  readonly organise: readonly NestedStep[];
  /** Collision step 1 (with the solve tick's advance) and step 2. */
  readonly compact: readonly [readonly NestedStep[], readonly NestedStep[]];
  readonly readback: readonly NestedStep[];
}

/**
 * The nested solve's plan (see `gpu-nested-layout.ts`):
 *
 * - organise: reduction (tree, query) → pyramid (scatter, levels) → repulsion → predict → [hubs] → springs + integrate;
 * - compact step 1: predict → [hubs] → springs + integrate → reduction → cells → count → rounds 0…7 → gather;
 * - compact step 2: reduction → cells → count → rounds 0…7 → gather;
 * - readback: reduction (mode 1) → reduction (mode 2) → composition.
 */
export function nestedPlan(sizes: NestedPlanSizes): NestedPlan {
  const step = (pass: NestedPass, rows: number, flags: { readback?: boolean; organising?: boolean; index?: number } = {}): NestedStep => {
    const cost: PassCost = NESTED_COST[pass];
    return {
      pass,
      costMs: (cost.nsPerLeaf * sizes.leaves) / 1e6,
      fixedMs: cost.fixedMs + ((cost.tailUsPerChild ?? 0) * sizes.largestModule) / 1e3,
      rows: Math.max(1, rows),
      readback: flags.readback ?? false,
      organising: flags.organising ?? false,
      index: flags.index ?? 0,
    };
  };
  const reduction = [step("tree", sizes.treeRows), step("query", sizes.tableRows)];
  const pyramid = sizes.levelRows > 0 ? [step("scatter", sizes.slotRows), step("levels", sizes.levelRows)] : [];
  const advance = (organising: boolean): NestedStep[] => [
    step("predict", sizes.slotRows, { organising }),
    ...(sizes.hubRows > 0 ? [step("hubs", sizes.hubRows, { organising })] : []),
    step("springs", sizes.slotRows, { organising }),
  ];
  const collision = [
    ...reduction,
    step("cells", sizes.slotRows),
    step("count", sizes.slotRows),
    ...Array.from({ length: COLLISION_ROUNDS }, (_, r) => step("round", sizes.slotRows, { index: r })),
    step("gather", sizes.slotRows),
  ];
  return {
    organise: [...reduction, ...pyramid, step("repulsion", sizes.slotRows), ...advance(true)],
    compact: [[...advance(false), ...collision], collision],
    readback: [
      step("tree", sizes.treeRows, { readback: true, index: 1 }),
      step("query", sizes.tableRows, { readback: true, index: 1 }),
      step("tree", sizes.treeRows, { readback: true, index: 2 }),
      step("query", sizes.tableRows, { readback: true, index: 2 }),
      step("compose", sizes.composeRows, { readback: true }),
    ],
  };
}

/** Children of `topo`'s largest module (its largest segment). */
export function largestModule(topo: Pick<NestedSolverTopology, "segCount">): number {
  let k = 0;
  for (const count of topo.segCount) k = Math.max(k, count);
  return k;
}

/** Rows of a row-major atlas of `texels` texels, `atlasWidth(texels)` wide. */
function atlasRows(texels: number): number {
  const n = Math.max(1, texels);
  return Math.ceil(n / atlasWidth(n));
}

/**
 * The sizes a solve of `topo` cuts its passes over, from the topology alone — what `GpuNestedLayout` reads
 * off the textures it builds (the slot atlas, the reduction tree, the segment table plus its whole-slot
 * range, the tile atlas, the springs' CSR hub chunks, the staging atlas). For checking the budget at a
 * scale without building the solve; the layout itself cuts over its own textures.
 */
export function nestedPlanSizes(topo: NestedSolverTopology): NestedPlanSizes {
  const slots = topo.slotCount;
  const segments: SlotRange[] = [];
  for (let s = 0; s < topo.segStart.length; s++) segments.push({ start: topo.segStart[s] ?? 0, count: topo.segCount[s] ?? 0 });
  const tiles = packTiles(segments, EXACT_MAX, TILE_MIN_SIDE);
  const hubs = buildHubChunks(buildCSR(slots, topo.linkSource, topo.linkTarget).offsets).count;
  return {
    leaves: topo.leafCount,
    slotRows: atlasRows(slots),
    treeRows: reduceLayout(slots).levels[0]?.rows ?? 0,
    tableRows: atlasRows(segments.length + 1),
    levelRows: tiles.levels[1]?.height ?? (tiles.levels.length > 0 ? 1 : 0),
    hubRows: hubs > 0 ? atlasRows(hubs) : 0,
    composeRows: atlasRows(Math.ceil(topo.leafCount / 2) + topo.treeSize - topo.leafCount),
    largestModule: largestModule(topo),
  };
}
