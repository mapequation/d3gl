// ─────────────────────────────────────────────────────────────────────────────
// CPU prep of the nested layout's radius-class collision grid (#380, spec §11.1) — pure, node-tested.
// ─────────────────────────────────────────────────────────────────────────────
//
// A single-scale grid cannot bin discs of very different sizes: cells wide enough for the large discs
// hold hundreds of small ones, and every slot near such a cell took an exact loop over its segment —
// O(k²) per collision step in a large module with heavy-tailed radii (#355 D3). So each disc is binned at
// the scale of its own radius class instead:
//
// - **Classes.** In a segment whose largest radius is `rmax`, a slot of radius r is in class c, the
//   largest c ≥ 0 with `r ≤ R_c = rmax · 2^−c` (at most {@link COLLISION_CLASS_MAX} classes).
// - **Cells.** Class c is binned into square cells of side `2 · PAD · R_c / 2^ρ` — the contact distance
//   of its largest discs over 2^ρ (ρ = {@link CollisionPlan.refine}) — so the classes nest: a class-c cell
//   is 2×2 class-(c + 1) cells. Each class cell is itself 2^SUB × 2^SUB sub-cells (SUB =
//   {@link COLLISION_SUB_SHIFT}). The finest class's sub-cells have side {@link CollisionPlan.segCellSide};
//   each collision step bins every slot's position once into that finest grid,
//   `F = ⌊(p − boxMin) / segCellSide⌋`, and its class-c cell is `F >> (C − 1 − c + SUB)` and sub-cell
//   `F >> (C − 1 − c)` — integer shifts, so every class, level, scatter and gather agrees on every cell.
// - **Pairs.** A touching partner of slot i in class c lies within `(r_i + R_c) · PAD` of it, so slot i
//   visits, in every class of its segment, the class cells that padded disc overlaps
//   ({@link searchReach}): about (2^ρ + 1)² cells in a much coarser class, (2^(ρ+1) + 1)² in its own, and
//   (r_i / R_c)² in a much finer one. Each side finds each partner exactly once (a partner has one cell,
//   and the visited cells are distinct), so the Jacobi pushes stay antisymmetric.
// - **Dense cells.** Real nested layouts end deeply overlapped — on the CPU as on the GPU, two thirds of
//   a 20,000-child Zipf module's discs sit within half the padded distance of a sibling — so a class cell
//   can hold more discs than the occupant rounds list (K). Those cells are refined: the occupants of a
//   bucket with more than K are binned again by sub-cell into a second, smaller table, and a slot that
//   visits such a cell visits its 2^SUB × 2^SUB sub-cells there instead. Only a sub-cell with more than K
//   (discs piled within an eighth of their contact distance) sends the work item that visits it to an exact
//   loop over its segment.
// - **The list.** The coarsest classes, while together they hold at most {@link COLLISION_LIST_MAX}
//   slots, are not binned: every slot of the segment tests them directly (the segment's largest discs,
//   which a grid would have to search over most of its box).
// - **Exact slots.** A slot whose grid search costs more than the exact loop over its segment (a large
//   disc among very small ones, or any slot of a small segment) takes the exact loop instead — both are
//   complete; this picks the cheaper, with a cell visit weighed at {@link COLLISION_VISIT_COST} pair tests.
//   A segment whose every slot takes the exact loop gets no grid at all.
// - **Work items.** A large disc among small ones has much more to do than its siblings, whichever search
//   it takes (thousands of cells, or the whole segment), and one fragment doing it alone would hold the
//   gather for milliseconds: its fetches are a serial chain that no other work hides once the rest of the
//   pass is done. So a slot's search is cut into work items of at most {@link COLLISION_PART_VISITS} cell
//   visits (a slice of its cells, in class then row-major order) or {@link COLLISION_PART_PAIRS} pair tests
//   (a slice of its segment). The items — of every grid slot, and of the exact slots cut into more than
//   one — are gathered in parallel first; each slot's own fragment then sums its items, or runs its exact
//   loop when that is a single item (the bulk of a map of small modules), in a pass small enough to run at
//   full occupancy.
// - **Buckets.** The cells are sparse (a class's discs cover a small part of the box), so they are
//   hashed: a segment of n binned slots owns the power of two of buckets at or above
//   `BUCKETS_PER_SLOT · n` for its class cells, and of `SUB_BUCKETS_PER_SLOT · n` for its refined sub-cells.
//   Class c's cell (x, y) lands in bucket `hash(c, x | y << 16) & (B − 1)` (a sub-cell: class c + 16). The
//   gather keeps an occupant only when its class and cell match the visited one.
//
// Everything here depends on the radii only, which a layout never changes: it is computed once, with the
// rest of the solve's data (`nested-topology.ts`).

/** Classes a segment's radii are split into (a 4-bit field on the GPU); smaller discs share the finest. */
export const COLLISION_CLASS_MAX = 16;
/** Slots in a segment's list: its coarsest classes while they hold at most this many slots. */
export const COLLISION_LIST_MAX = 8;
/** Largest finest-cell coordinate: positions farther from the box minimum clamp to it (16 bits per axis). */
export const COLLISION_F_MAX = 0xffff;
/** Class-cell buckets per binned slot, before rounding up to a power of two: the hash table's inverse load. */
export const COLLISION_BUCKETS_PER_SLOT = 1;
/**
 * Sub-cell buckets per binned slot (only the occupants of dense class cells are binned there). Measured
 * over every compact tick of the real maps (web-NotreDame's Infomap trees, one-module Zipf maps to 60,000
 * children), the fullest sub-cell bucket held 8 occupants at 0.5 and 9 — an overflow — at 0.25.
 */
export const COLLISION_SUB_BUCKETS_PER_SLOT = 0.5;
/** Cell refinement ρ: class cells are their largest discs' contact distance over 2^ρ. */
export const COLLISION_REFINE = 1;
/** log2 of the sub-cells per class cell and axis (a dense cell is refined into 4 × 4). */
export const COLLISION_SUB_SHIFT = 2;
/**
 * What one grid cell visit costs against one pair test of the exact loop, in the exact rule — measured on
 * an M1 Max (ANGLE Metal): the exact loop streams its segment's slots (every lane of a SIMD group reads the
 * same one), ~46 ps per pair test; a cell visit is a hash and a chain of dependent random fetches, ~1.3 ns.
 */
export const COLLISION_VISIT_COST = 16;
/** Cell visits of one work item of a grid slot. */
export const COLLISION_PART_VISITS = 32;
/** Pair tests of one work item of an exact slot. */
export const COLLISION_PART_PAIRS = 256;
/** `slotCollide` bit: the slot takes the exact loop over its segment. */
export const COLLISION_EXACT = 16;
/** `slotCollide` bit: the slot's search runs in work items (every grid slot, and the exact slots cut into more than one). */
export const COLLISION_ITEMIZED = 32;
/** `slotCollide` shift of the work items of the slots before it (a slot's first item, when it has any). */
export const COLLISION_ITEM_SHIFT = 6;

/**
 * The collision data of a batched nested solve, per slot and per segment. A segment of at most
 * `exactMax` children (every slot exact) has no classes, list or buckets.
 */
export interface CollisionPlan {
  /**
   * Per slot: its class (bits 0-3), {@link COLLISION_EXACT} when it takes the exact loop,
   * {@link COLLISION_ITEMIZED} when its search runs in work items, and the work items of the slots before
   * it (bits {@link COLLISION_ITEM_SHIFT}-31: its first item, when it has any).
   */
  readonly slotCollide: Uint32Array;
  /**
   * Per work item `(slot, part | parts << 16)`: slot `slot`'s part `part` of `parts` — of the itemized
   * slots only, in slot order.
   */
  readonly items: Uint32Array;
  /** Work items in all. */
  readonly itemCount: number;
  /** Per segment: the finest class's sub-cell side in local units (0 without a grid). */
  readonly segCellSide: Float32Array;
  /**
   * Per segment: its class count C (bits 0-4), its first binned class L (bits 5-9), log2 of its sub-cell
   * bucket count (bits 10-14), and one bit per binned class that has slots (bits 16-31: bit 16 + c for
   * class c). 0 without a grid.
   */
  readonly segClasses: Uint32Array;
  /** Per segment its list: at most {@link COLLISION_LIST_MAX} slots, −1 pads, {@link COLLISION_LIST_MAX} entries each. */
  readonly segList: Int32Array;
  /** Per segment its first class-cell bucket, and its class-cell bucket count − 1 (a power of two − 1: the hash mask). */
  readonly segBucketBase: Uint32Array;
  readonly segBucketMask: Uint32Array;
  /** Per segment its first sub-cell bucket (its count is a power of two, in {@link segClasses}). */
  readonly segSubBase: Uint32Array;
  /** Class-cell and sub-cell buckets in all. */
  readonly bucketCount: number;
  readonly subBucketCount: number;
  /** Every binned slot (the scatters' points), in slot order. */
  readonly binnedSlots: Uint32Array;
  /**
   * Each slot's estimated gather work per collision step, in exact-loop pair tests: an exact slot's k − 1,
   * a grid slot's list plus its mean cell visits weighed at {@link COLLISION_VISIT_COST}. It grows with the
   * contacts, not with the leaves: what the gather's bands are cut and costed by.
   */
  readonly slotWork: Float32Array;
  /** The sum of {@link slotWork}. */
  readonly gatherWork: number;
  /** The cell refinement ρ the cell sides were computed for (the gather's search needs it too). */
  readonly refine: number;
}

/** Class count C of a {@link CollisionPlan.segClasses} word. */
export function planClassCount(word: number): number {
  return word & 31;
}
/** First binned class L of a {@link CollisionPlan.segClasses} word. */
export function planFirstBinned(word: number): number {
  return (word >>> 5) & 31;
}
/** Sub-cell buckets of a {@link CollisionPlan.segClasses} word. */
export function planSubBuckets(word: number): number {
  return 2 ** ((word >>> 10) & 31);
}
/** Whether binned class `c` has slots, in a {@link CollisionPlan.segClasses} word. */
export function planHasClass(word: number, c: number): boolean {
  return ((word >>> (16 + c)) & 1) === 1;
}

/**
 * Half-width, in finest sub-cells, of slot i's search of the class whose cells are `2^s` finest
 * sub-cells (s = C − 1 − c + SUB): a partner there lies within `(r_i + R_c) · PAD` of it, which is
 * `r_i · PAD / side + 2^(s + ρ − 1)` finest sub-cells, widened by a relative 2⁻¹⁰ and 1/16 cell for float32
 * rounding (of the reach, and of the binned positions: at most ~0.008 cells at {@link COLLISION_F_MAX}).
 * The GPU gather computes the same expression ({@link COLLISION_GLSL}'s `searchReach`, with e = s + ρ); a
 * slightly different rounding there only changes how many extra cells it visits, never which partners it
 * finds.
 */
export function searchReach(radius: number, padOverSide: number, e: number): number {
  return (radius * padOverSide + 2 ** (e - 1)) * (1 + 1 / 1024) + 1 / 16;
}

/**
 * Class cells per axis that a search of half-width `reach` finest sub-cells visits at most, in a class
 * whose cells are `2^s` finest sub-cells: the finest cells `[F − ⌈reach⌉, F + 1 + ⌊reach⌋]` shifted by s.
 */
export function searchCellsPerAxis(reach: number, s: number): number {
  return Math.floor((2 * reach + 2) / 2 ** s) + 2;
}

/** Most work items of one slot (a 16-bit field). */
const PARTS_MAX = 0xffff;

/** The smallest power of two at or above `n` (n ≥ 1). */
function pow2Above(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Build the collision plan of `segments` (slot ranges in slot order) over the float32 `radius` of every
 * slot: classes, lists, exact slots, work items and buckets — see the file header. Segments of at most
 * `exactMax` slots get no grid; `pad` is the collision spacing factor (NESTED.PAD). O(slots · classes).
 */
export function collisionPlan(
  radius: Float32Array,
  segStart: Uint32Array,
  segCount: Uint32Array,
  exactMax: number,
  pad: number,
  refine = COLLISION_REFINE,
  visitCost = COLLISION_VISIT_COST,
  subBucketsPerSlot = COLLISION_SUB_BUCKETS_PER_SLOT,
  bucketsPerSlot = COLLISION_BUCKETS_PER_SLOT,
): CollisionPlan {
  const S = segStart.length;
  const slots = radius.length;
  const slotCollide = new Uint32Array(slots).fill(COLLISION_EXACT);
  const segCellSide = new Float32Array(S);
  const segClasses = new Uint32Array(S);
  const segList = new Int32Array(S * COLLISION_LIST_MAX).fill(-1);
  const segBucketBase = new Uint32Array(S);
  const segBucketMask = new Uint32Array(S);
  const segSubBase = new Uint32Array(S);
  const perClass = new Uint32Array(COLLISION_CLASS_MAX);
  const binned: number[] = [];
  const slotWork = new Float32Array(slots);
  // Work items per slot: an exact slot's k − 1 pair tests in parts of COLLISION_PART_PAIRS (set here, for
  // every segment); a grid slot's cells in parts of COLLISION_PART_VISITS visits (set below).
  const parts = new Uint32Array(slots);
  for (let s = 0; s < S; s++) {
    const k = segCount[s] ?? 0;
    const start = segStart[s] ?? 0;
    parts.fill(Math.min(PARTS_MAX, Math.max(1, Math.ceil((k - 1) / COLLISION_PART_PAIRS))), start, start + k);
    slotWork.fill(Math.max(0, k - 1), start, start + k);
  }
  let buckets = 0;
  let subBuckets = 0;
  for (let s = 0; s < S; s++) {
    const start = segStart[s] ?? 0;
    const k = segCount[s] ?? 0;
    segBucketBase[s] = buckets;
    segSubBase[s] = subBuckets;
    if (k <= exactMax) continue;
    // Classes, compared in float32 as the GPU sees the radii (halving is exact).
    let rmax = 0;
    for (let i = start; i < start + k; i++) rmax = Math.max(rmax, radius[i] ?? 0);
    perClass.fill(0);
    let classes = 1;
    for (let i = start; i < start + k; i++) {
      const r = radius[i] ?? 0;
      let c = 0;
      let limit = rmax;
      while (c < COLLISION_CLASS_MAX - 1 && r <= Math.fround(limit * 0.5)) {
        limit = Math.fround(limit * 0.5);
        c++;
      }
      slotCollide[i] = c;
      perClass[c] = (perClass[c] ?? 0) + 1;
      classes = Math.max(classes, c + 1);
    }
    // The list: the coarsest classes while together they hold at most COLLISION_LIST_MAX slots.
    let first = 0;
    let listed = 0;
    while (first < classes && listed + (perClass[first] ?? 0) <= COLLISION_LIST_MAX) listed += perClass[first++] ?? 0;
    let n = 0;
    for (let c = 0; c < first; c++) {
      for (let i = start; i < start + k; i++) if (slotCollide[i] === c) segList[s * COLLISION_LIST_MAX + n++] = i;
    }
    let mask = 0;
    for (let c = first; c < classes; c++) if ((perClass[c] ?? 0) > 0) mask |= 1 << c;
    const side = Math.fround((2 * pad * rmax) / 2 ** (classes - 1 + refine + COLLISION_SUB_SHIFT));
    segCellSide[s] = side;
    // Exact slots: a grid search that costs more than the exact loop's k pair tests takes the exact loop.
    // Its cells per class are estimated at the mean of the window's width, (2 · reach + 1) / 2^s + 1; a
    // grid slot's parts cover the most cells its windows can span.
    const padOverSide = pad / side;
    for (let i = start; i < start + k; i++) {
      const ci = slotCollide[i] ?? 0;
      let visits = 0;
      let most = 0;
      for (let c = first; c < classes; c++) {
        if (((mask >>> c) & 1) === 0) continue;
        const shift = classes - 1 - c + COLLISION_SUB_SHIFT;
        const reach = searchReach(radius[i] ?? 0, padOverSide, shift + refine);
        const mean = (2 * reach + 1) / 2 ** shift + 1;
        visits += mean * mean;
        most += searchCellsPerAxis(reach, shift) ** 2;
      }
      if (listed + visitCost * visits >= k) {
        slotCollide[i] = ci | COLLISION_EXACT;
      } else {
        parts[i] = Math.min(PARTS_MAX, Math.max(1, Math.ceil(most / COLLISION_PART_VISITS)));
        slotWork[i] = listed + visitCost * visits;
      }
    }
    // A segment whose every slot takes the exact loop needs no grid: nobody would visit its cells.
    let searching = false;
    for (let i = start; i < start + k && !searching; i++) searching = ((slotCollide[i] ?? 0) & COLLISION_EXACT) === 0;
    if (!searching) {
      segCellSide[s] = 0;
      segList.fill(-1, s * COLLISION_LIST_MAX, (s + 1) * COLLISION_LIST_MAX);
      continue;
    }
    for (let i = start; i < start + k; i++) if (((slotCollide[i] ?? 0) & 15) >= first) binned.push(i);
    const count = k - listed;
    const size = count > 0 ? pow2Above(Math.ceil(bucketsPerSlot * count)) : 0;
    const subSize = count > 0 ? pow2Above(Math.ceil(subBucketsPerSlot * count)) : 1;
    segBucketMask[s] = Math.max(0, size - 1);
    segClasses[s] = (classes | (first << 5) | (Math.log2(subSize) << 10) | (mask << 16)) >>> 0;
    buckets += size;
    subBuckets += count > 0 ? subSize : 0;
  }
  let gatherWork = 0;
  for (let i = 0; i < slots; i++) gatherWork += slotWork[i] ?? 0;
  const itemized = (i: number): boolean => ((slotCollide[i] ?? 0) & COLLISION_EXACT) === 0 || (parts[i] ?? 1) > 1;
  let itemCount = 0;
  for (let i = 0; i < slots; i++) if (itemized(i)) itemCount += parts[i] ?? 1;
  if (itemCount >= 2 ** (32 - COLLISION_ITEM_SHIFT)) throw new Error(`collisionPlan: ${itemCount} work items, beyond the slot word's field`);
  const items = new Uint32Array(2 * itemCount);
  let item = 0;
  for (let i = 0; i < slots; i++) {
    const count = parts[i] ?? 1;
    const own = itemized(i);
    slotCollide[i] = ((slotCollide[i] ?? 0) | (own ? COLLISION_ITEMIZED : 0) | (item << COLLISION_ITEM_SHIFT)) >>> 0;
    if (!own) continue;
    for (let p = 0; p < count; p++) {
      items[2 * item] = i;
      items[2 * item + 1] = (p | (count << 16)) >>> 0;
      item++;
    }
  }
  return {
    slotCollide,
    items,
    itemCount,
    segCellSide,
    segClasses,
    segList,
    segBucketBase,
    segBucketMask,
    segSubBase,
    bucketCount: buckets,
    subBucketCount: subBuckets,
    binnedSlots: Uint32Array.from(binned),
    slotWork,
    gatherWork,
    refine,
  };
}

/**
 * The bucket hash of class `c`'s cell `(x, y)` (a sub-cell: `c + 16`): a murmur3 finalizer of
 * `x | y << 16` plus c times the golden ratio, as uint32 — {@link COLLISION_GLSL}'s `cellHash` computes
 * it bit for bit alike.
 */
export function cellHash(c: number, x: number, y: number): number {
  let h = ((x | (y << 16)) + Math.imul(c, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** GLSL twins of {@link cellHash} and {@link searchReach} (the constants are this module's). */
export const COLLISION_GLSL = /* glsl */ `\
const int F_MAX = ${COLLISION_F_MAX};
const int SUB = ${COLLISION_SUB_SHIFT};
const uint COLLIDE_EXACT = ${COLLISION_EXACT}u;
uint cellHash(int c, int x, int y) {
  uint h = (uint(x) | (uint(y) << 16)) + uint(c) * 0x9e3779b9u;
  h ^= h >> 16;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  h *= 0xc2b2ae35u;
  h ^= h >> 16;
  return h;
}
float searchReach(float radius, float padOverSide, int e) {
  return (radius * padOverSide + 0.5 * float(1 << e)) * (1.0 + 1.0 / 1024.0) + 1.0 / 16.0;
}
`;
