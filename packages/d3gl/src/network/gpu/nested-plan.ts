// ─────────────────────────────────────────────────────────────────────────────
// The passes of the nested GPU solve's stream ticks and readbacks, with their cost model (#355, #380,
// #382) — pure data, so the per-frame budget can be checked at any N without a GPU.
// ─────────────────────────────────────────────────────────────────────────────
//
// `GpuNestedLayout` binds each step to its pass; the streaming schedule (`stream-schedule.ts`) cuts every
// step into bands sized to the frame budget. See `gpu-nested-layout.ts` for what each pass does and
// `passes/collision.ts` for the collision's.

import { buildCSR } from "../graph.js";
import { EXACT_MAX } from "../nested-layout.js";
import { buildHubChunks } from "./hub-chunks.js";
import type { NestedSolverTopology } from "./nested-topology.js";
import { COLLISION_ROUNDS, COLLISION_SUB_ROUNDS } from "./passes/collision.js";
import { TILE_MIN_SIDE, packTiles, reduceLayout, type SlotRange } from "./segments.js";
import type { StageCost } from "./stream-schedule.js";
import { atlasWidth } from "./textures.js";

/**
 * What a pass's cost grows with: the solver's slots (every tree node but the root), the springs' hub chunks,
 * the collision scatters' binned slots, the work items' or the resolve's estimated work (the collision
 * plan's pair-test units, `collision-plan.ts`), or the composition's texels (leaf pairs and modules).
 */
export type PassUnit = "slots" | "hubChunks" | "binned" | "itemWork" | "resolveWork" | "composed";

/**
 * A pass's GPU cost: `baseMs + nsPerUnit · units` that slicing divides among the bands, and `fixedMs` that
 * each band pays whatever its size (its render passes' setup, and the longest fragment it waits for).
 */
export interface PassCost {
  readonly unit: PassUnit;
  readonly fixedMs: number;
  readonly baseMs: number;
  readonly nsPerUnit: number;
}

/**
 * GPU cost of each pass of the nested solve, measured on an M1 Max (ANGLE Metal, headless Chromium) over
 * whole cold layouts of eight maps — the synthetic Infomap-like trees of 20,000, 100,000, 325,729 and
 * 1,000,000 leaves, web-NotreDame's two Infomap trees (multilevel and two-level, 325,729 leaves) and
 * one-module Zipf maps of 20,000 and 60,000 children. Each pass was timed at every eighth stream tick of
 * the layout, whole and in 4 and 8 bands, by wall clock over runs queued back to back and fenced once (a
 * pass's runs write one target, so each waits for the one before; the fence wait is spread over the
 * runs). `fixedMs` is the median over the maps of the slope of the time against the band count; the
 * divisible part is the line through the maps' whole-pass time less one `fixedMs`. Timer queries were not
 * used: on ANGLE Metal they count a pass's overlap with the pass before it, and inflate sliced passes.
 *
 * **The estimates are medians, not bounds.** A pass on one map runs up to ~2× its line (the reductions and
 * scatters at 20,000 leaves, all fixed cost); the work items' fixed cost per band — their longest item —
 * ranges 0.03-0.9 ms between the maps (0.9 on the Zipf maps, whose dense cells make the longest items). A
 * frame's real GPU time can exceed the budget by as much; a GPU that runs later than that is what the frame
 * budget's fences catch (`k` halves, the band growth rises), as for the flat layout (#382, D8). Most passes
 * are nearly all fixed cost: a render pass costs ~0.05 ms whatever it draws.
 */
export const NESTED_COST = {
  /** Reduction tree level 1 (the map over 16 slots per texel): 0.14-0.40 ms whole. */
  tree: { unit: "slots", fixedMs: 0.065, baseMs: 0.13, nsPerUnit: 0.14 },
  /** Reduction levels 2…L (in the first band) and the range query per segment: 0.17-0.42 ms. */
  query: { unit: "slots", fixedMs: 0.07, baseMs: 0.18, nsPerUnit: 0.15 },
  /** Grid pyramid: the scatter of every tiled slot (the first band clears level 0): 0.10-0.25 ms. */
  scatter: { unit: "slots", fixedMs: 0.045, baseMs: 0.05, nsPerUnit: 0.16 },
  /** Grid pyramid: the 2×2 reduces of every level, one render pass per level in each band: 0.30-0.44 ms. */
  levels: { unit: "slots", fixedMs: 0.29, baseMs: 0.15, nsPerUnit: 0 },
  /** Repulsion — tile walks and exact loops (the first band clears the force accumulator): 0.9-6.2 ms. */
  repulsion: { unit: "slots", fixedMs: 0.34, baseMs: 0.8, nsPerUnit: 5.0 },
  /** Predict v*: 0.08-0.18 ms. */
  predict: { unit: "slots", fixedMs: 0.045, baseMs: 0.056, nsPerUnit: 0.026 },
  /** The springs' hub chunk partials, only with hub rows: 0.53-0.74 ms (web-NotreDame's trees). */
  hubs: { unit: "hubChunks", fixedMs: 0.07, baseMs: 0.38, nsPerUnit: 83 },
  /** The springs' row gather + integrate (the first band clears the accumulator): 0.16-2.7 ms. */
  springs: { unit: "slots", fixedMs: 0.13, baseMs: 0, nsPerUnit: 2.3 },
  /** Collision cells and discs: 0.09-0.18 ms. */
  cells: { unit: "slots", fixedMs: 0.046, baseMs: 0.033, nsPerUnit: 0.09 },
  /** A class-cell table scatter — its count or one of its 8 rounds — over the binned slots: 0.09-0.12 ms. */
  cellScatter: { unit: "binned", fixedMs: 0.046, baseMs: 0.055, nsPerUnit: 0 },
  /** A sub-cell table scatter — its count or one of its 12 rounds (every binned slot, most culled): 0.09-0.12 ms. */
  subScatter: { unit: "binned", fixedMs: 0.047, baseMs: 0.052, nsPerUnit: 0 },
  /** Collision work items: 1.7-8.6 ms. Each band waits for its longest item (0.03-0.9 ms). */
  items: { unit: "itemWork", fixedMs: 0.42, baseMs: 1.7, nsPerUnit: 0.0456 },
  /** Collision resolve: 0.22-1.8 ms. */
  resolve: { unit: "resolveWork", fixedMs: 0.17, baseMs: 0.133, nsPerUnit: 0.0228 },
  /** Composition of every leaf and module (each walks ≤ D ancestors): 0.15-0.42 ms. */
  compose: { unit: "composed", fixedMs: 0.046, baseMs: 0.084, nsPerUnit: 0.53 },
} as const satisfies Record<string, PassCost>;

/** A pass of the nested solve. */
export type NestedPass = keyof typeof NESTED_COST;

/** The sizes the nested solve's passes are cut over, and the cost model's units. */
export interface NestedPlanSizes {
  /** Solver slots (every tree node but the root). */
  readonly slots: number;
  /** Rows of the slot atlas (every per-slot pass). */
  readonly slotRows: number;
  /** Rows of the reduction tree's level 1. */
  readonly treeRows: number;
  /** Rows of the segment table (the range queries). */
  readonly tableRows: number;
  /** Rows of the grid pyramid's level 1; 0 without a pyramid (no segment above the exact threshold). */
  readonly levelRows: number;
  /** The springs' hub chunks and the rows of their atlas; 0 without hub rows. */
  readonly hubChunks: number;
  readonly hubRows: number;
  /** The collision scatters' binned slots (0: no grid, no scatter) and the rows of their atlas. */
  readonly binned: number;
  readonly scatterRows: number;
  /** Rows of the collision's work-item atlas (0 without work items) and the items' estimated work. */
  readonly itemRows: number;
  readonly itemWork: number;
  /** The collision resolve's estimated work. */
  readonly resolveWork: number;
  /** The composition's staging texels (leaf pairs and modules) and their rows. */
  readonly composed: number;
  readonly composeRows: number;
}

/** One pass of a nested stream tick or readback, as data: which pass, its cost and rows, and what it needs. */
export interface NestedStep extends StageCost {
  readonly pass: NestedPass;
  /** Of the readback (the composition's own reduction and sums) rather than the solve. */
  readonly readback: boolean;
  /** predict, hubs, springs: of the organise phase (repulsion added, zero-rest springs, the tick ends). */
  readonly organising: boolean;
  /**
   * A scatter's round (−1: its count); a readback's tree / query: the reduce mode (1: weighted centroids,
   * 2: extents); else 0.
   */
  readonly index: number;
}

/** The passes of each kind of stream tick, and of a readback, in order. */
export interface NestedPlan {
  readonly organise: readonly NestedStep[];
  /** Collision step 1 (with the solve tick's advance) and step 2. */
  readonly compact: readonly [readonly NestedStep[], readonly NestedStep[]];
  readonly readback: readonly NestedStep[];
}

/** The units of `sizes` a pass's cost counts. */
function units(sizes: NestedPlanSizes, unit: PassUnit): number {
  switch (unit) {
    case "slots":
      return sizes.slots;
    case "hubChunks":
      return sizes.hubChunks;
    case "binned":
      return sizes.binned;
    case "itemWork":
      return sizes.itemWork;
    case "resolveWork":
      return sizes.resolveWork;
    case "composed":
      return sizes.composed;
  }
}

/**
 * The nested solve's plan (see `gpu-nested-layout.ts`):
 *
 * - organise: reduction (tree, query) → [pyramid (scatter, levels)] → repulsion → predict → [hubs] →
 *   springs + integrate;
 * - compact step 1: predict → [hubs] → springs + integrate → reduction → collision cells → [class-cell
 *   count, rounds 0…7 → sub-cell count, rounds 0…11] → [items] → resolve;
 * - compact step 2: reduction → cells → [the scatters] → [items] → resolve;
 * - readback: reduction (mode 1) → reduction (mode 2) → composition.
 *
 * A pass the map does not need is left out: the pyramid without a tiled segment, the hubs without hub
 * rows, the scatters without binned slots, the items without work items.
 */
export function nestedPlan(sizes: NestedPlanSizes): NestedPlan {
  const step = (pass: NestedPass, rows: number, flags: { readback?: boolean; organising?: boolean; index?: number } = {}): NestedStep => {
    const cost: PassCost = NESTED_COST[pass];
    return {
      pass,
      costMs: cost.baseMs + (cost.nsPerUnit * units(sizes, cost.unit)) / 1e6,
      fixedMs: cost.fixedMs,
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
  const scatters = (pass: "cellScatter" | "subScatter", rounds: number): NestedStep[] =>
    Array.from({ length: rounds + 1 }, (_, r) => step(pass, sizes.scatterRows, { index: r - 1 }));
  const collision = [
    ...reduction,
    step("cells", sizes.slotRows),
    ...(sizes.binned > 0 ? [...scatters("cellScatter", COLLISION_ROUNDS), ...scatters("subScatter", COLLISION_SUB_ROUNDS)] : []),
    ...(sizes.itemRows > 0 ? [step("items", sizes.itemRows)] : []),
    step("resolve", sizes.slotRows),
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

/** Rows of a row-major atlas of `texels` texels, `atlasWidth(texels)` wide. */
function atlasRows(texels: number): number {
  const n = Math.max(1, texels);
  return Math.ceil(n / atlasWidth(n));
}

/**
 * The sizes a solve of `topo` cuts its passes over, from the topology alone — what `GpuNestedLayout` reads
 * off the textures it builds (the slot atlas, the reduction tree, the segment table plus its whole-slot
 * range, the tile atlas, the springs' CSR hub chunks, the collision grid's binned slots and work items,
 * the staging atlas). For checking the budget at a scale without building the solve; the layout itself cuts
 * over its own textures (a browser test pins that the two agree).
 */
export function nestedPlanSizes(topo: NestedSolverTopology): NestedPlanSizes {
  const slots = topo.slotCount;
  const segments: SlotRange[] = [];
  for (let s = 0; s < topo.segStart.length; s++) segments.push({ start: topo.segStart[s] ?? 0, count: topo.segCount[s] ?? 0 });
  const tiles = packTiles(segments, EXACT_MAX, TILE_MIN_SIDE);
  const hubs = buildHubChunks(buildCSR(slots, topo.linkSource, topo.linkTarget).offsets).count;
  const plan = topo.collision;
  const binned = plan.binnedSlots.length;
  const slotWidth = atlasWidth(slots);
  const composed = Math.ceil(topo.leafCount / 2) + topo.treeSize - topo.leafCount;
  return {
    slots,
    slotRows: Math.ceil(slots / slotWidth),
    treeRows: reduceLayout(slots).levels[0]?.rows ?? 0,
    tableRows: atlasRows(segments.length + 1),
    levelRows: tiles.levels.length > 0 ? (tiles.levels[1]?.height ?? 1) : 0,
    hubChunks: hubs,
    hubRows: hubs > 0 ? atlasRows(hubs) : 0,
    binned,
    scatterRows: binned > 0 ? atlasRows(binned) : 0,
    itemRows: plan.itemCount > 0 ? Math.ceil(plan.itemCount / slotWidth) : 0,
    itemWork: plan.itemWork,
    resolveWork: plan.resolveWork,
    composed,
    composeRows: atlasRows(composed),
  };
}
