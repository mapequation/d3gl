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
//   is 2×2 class-(c + 1) cells. The finest class of the segment, C − 1, has cells of side
//   {@link CollisionPlan.segCellSide}; each collision step bins every slot's position once into that
//   finest grid, `F = ⌊(p − boxMin) / segCellSide⌋`, and its class-c cell is `F >> (C − 1 − c)` — integer
//   shifts, so every class, scatter and gather agrees on every cell.
// - **Pairs.** A touching partner of slot i in class c lies within `(r_i + R_c) · PAD` of it, so slot i
//   visits, in every class of its segment, the class cells that padded disc overlaps
//   ({@link searchReach}): about (2^ρ + 1)² cells in a much coarser class, (2^(ρ+1) + 1)² in its own, and
//   (r_i / R_c)² in a much finer one. Each side finds each partner exactly once (a partner has one cell,
//   and the visited cells are distinct), so the Jacobi pushes stay antisymmetric.
// - **Why ρ.** Real nested layouts end deeply overlapped — on the CPU as on the GPU, two thirds of a
//   20,000-child Zipf module's discs sit within half the padded distance of a sibling — so a class cell as
//   wide as its discs' contact distance holds dozens of them. Halving the cells (ρ = 1) quarters that.
// - **The list.** The coarsest classes, while together they hold at most {@link COLLISION_LIST_MAX}
//   slots, are not binned: every slot of the segment tests them directly (the segment's largest discs,
//   which a grid would have to search over most of its box).
// - **Exact slots.** A slot whose grid search costs more than the exact loop over its segment (a large
//   disc among very small ones, or any slot of a small segment) takes the exact loop instead — both are
//   complete; this picks the cheaper, with a cell visit weighed at {@link COLLISION_VISIT_COST} pair tests.
// - **Buckets.** The cells are sparse (a class's discs cover a small part of the box), so they are
//   hashed: a segment of n binned slots owns the power of two of buckets at or above
//   `BUCKETS_PER_SLOT · n`, and class c's cell (x, y) lands in bucket `hash(c, x | y << 16) & (B − 1)`. A
//   bucket lists its occupants through the K-occupant rounds (`passes/collision.ts`); the gather keeps
//   an occupant only when its class and cell match the visited one. A bucket with more than K occupants
//   sends every slot that visits it to the exact loop.
//
// Everything here depends on the radii only, which a layout never changes: it is computed once, with the
// rest of the solve's data (`nested-topology.ts`).

/** Classes a segment's radii are split into (a 4-bit field on the GPU); smaller discs share the finest. */
export const COLLISION_CLASS_MAX = 16;
/** Slots in a segment's list: its coarsest classes while they hold at most this many slots. */
export const COLLISION_LIST_MAX = 8;
/** Largest finest-cell coordinate: positions farther from the box minimum clamp to it (16 bits per axis). */
export const COLLISION_F_MAX = 0xffff;
/** Buckets per binned slot, before rounding up to a power of two: the hash table's inverse load. */
export const COLLISION_BUCKETS_PER_SLOT = 1.5;
/** Cell refinement ρ: class cells are their largest discs' contact distance over 2^ρ. */
export const COLLISION_REFINE = 1;
/**
 * What one grid cell visit costs against one pair test of the exact loop, in the exact rule. The exact
 * loop streams its segment's slots (every lane of a SIMD group reads the same one); a cell visit is a hash
 * and a chain of dependent random fetches.
 */
export const COLLISION_VISIT_COST = 8;
/** `slotCollide` bit: the slot takes the exact loop over its segment. */
export const COLLISION_EXACT = 16;

/**
 * The collision data of a batched nested solve, per slot and per segment. A segment of at most
 * `exactMax` children (every slot exact) has no classes, list or buckets.
 */
export interface CollisionPlan {
  /** Per slot: its class (bits 0-3), plus {@link COLLISION_EXACT} when it takes the exact loop. */
  readonly slotCollide: Uint32Array;
  /** Per segment: the finest class's cell side in local units (0 without a grid). */
  readonly segCellSide: Float32Array;
  /**
   * Per segment: its class count C (bits 0-4), its first binned class L (bits 5-9), and one bit per binned
   * class that has slots (bits 16-31: bit 16 + c for class c). 0 without a grid.
   */
  readonly segClasses: Uint32Array;
  /** Per segment its list: at most {@link COLLISION_LIST_MAX} slots, −1 pads, {@link COLLISION_LIST_MAX} entries each. */
  readonly segList: Int32Array;
  /** Per segment its first bucket, and its bucket count − 1 (a power of two − 1: the hash mask). */
  readonly segBucketBase: Uint32Array;
  readonly segBucketMask: Uint32Array;
  /** Buckets in all. */
  readonly bucketCount: number;
  /** Every binned slot (the scatters' points), in slot order. */
  readonly binnedSlots: Uint32Array;
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
/** Whether binned class `c` has slots, in a {@link CollisionPlan.segClasses} word. */
export function planHasClass(word: number, c: number): boolean {
  return ((word >>> (16 + c)) & 1) === 1;
}

/**
 * Half-width, in finest cells, of slot i's search of the class whose cells are `2^(e − ρ)` finest cells
 * (e = C − 1 − c + ρ): a partner there lies within `(r_i + R_c) · PAD` of it, which is
 * `r_i · PAD / side + 2^(e−1)` finest cells, widened by a relative 2⁻¹⁰ and 1/16 cell for float32
 * rounding (of the reach, and of the binned positions: at most ~0.008 cells at {@link COLLISION_F_MAX}).
 * The GPU gather computes the same expression ({@link COLLISION_GLSL}'s `searchReach`); a slightly
 * different rounding there only changes how many extra cells it visits, never which partners it finds.
 */
export function searchReach(radius: number, padOverSide: number, e: number): number {
  return (radius * padOverSide + 2 ** (e - 1)) * (1 + 1 / 1024) + 1 / 16;
}

/**
 * Class cells per axis that a search of half-width `reach` finest cells visits at most, in a class `d`
 * shifts coarser than the finest: the finest cells `[F − ⌈reach⌉, F + 1 + ⌊reach⌋]` shifted by d.
 */
export function searchCellsPerAxis(reach: number, d: number): number {
  return Math.floor((2 * reach + 2) / 2 ** d) + 2;
}

/** The smallest power of two at or above `n` (n ≥ 1). */
function pow2Above(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Build the collision plan of `segments` (slot ranges in slot order) over the float32 `radius` of every
 * slot: classes, lists, exact slots and buckets — see the file header. Segments of at most `exactMax`
 * slots get no grid; `pad` is the collision spacing factor (NESTED.PAD). O(slots · classes).
 */
export function collisionPlan(
  radius: Float32Array,
  segStart: Uint32Array,
  segCount: Uint32Array,
  exactMax: number,
  pad: number,
  refine = COLLISION_REFINE,
  bucketsPerSlot = COLLISION_BUCKETS_PER_SLOT,
  visitCost = COLLISION_VISIT_COST,
): CollisionPlan {
  const S = segStart.length;
  const slots = radius.length;
  const slotCollide = new Uint32Array(slots).fill(COLLISION_EXACT);
  const segCellSide = new Float32Array(S);
  const segClasses = new Uint32Array(S);
  const segList = new Int32Array(S * COLLISION_LIST_MAX).fill(-1);
  const segBucketBase = new Uint32Array(S);
  const segBucketMask = new Uint32Array(S);
  const perClass = new Uint32Array(COLLISION_CLASS_MAX);
  const binned: number[] = [];
  let buckets = 0;
  for (let s = 0; s < S; s++) {
    const start = segStart[s] ?? 0;
    const k = segCount[s] ?? 0;
    segBucketBase[s] = buckets;
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
    segClasses[s] = (classes | (first << 5) | (mask << 16)) >>> 0;
    const side = Math.fround((2 * pad * rmax) / 2 ** (classes - 1 + refine));
    segCellSide[s] = side;
    // Exact slots: a grid search that costs more than the exact loop's k pair tests takes the exact loop.
    // Its cells per class are estimated at the mean of the window's width, (2 · reach + 1) / 2^d + 1.
    const padOverSide = pad / side;
    for (let i = start; i < start + k; i++) {
      const ci = slotCollide[i] ?? 0;
      let visits = 0;
      for (let c = first; c < classes && listed + visitCost * visits < k; c++) {
        if (((mask >>> c) & 1) === 0) continue;
        const d = classes - 1 - c;
        const per = (2 * searchReach(radius[i] ?? 0, padOverSide, d + refine) + 1) / 2 ** d + 1;
        visits += per * per;
      }
      if (listed + visitCost * visits >= k) slotCollide[i] = ci | COLLISION_EXACT;
    }
    for (let i = start; i < start + k; i++) if (((slotCollide[i] ?? 0) & 15) >= first) binned.push(i);
    const count = k - listed;
    const size = count > 0 ? pow2Above(Math.ceil(bucketsPerSlot * count)) : 0;
    segBucketMask[s] = Math.max(0, size - 1);
    buckets += size;
  }
  return {
    slotCollide,
    segCellSide,
    segClasses,
    segList,
    segBucketBase,
    segBucketMask,
    bucketCount: buckets,
    binnedSlots: Uint32Array.from(binned),
    refine,
  };
}

/**
 * The bucket hash of class `c`'s cell `(x, y)`: a murmur3 finalizer of `x | y << 16` plus c times the
 * golden ratio, as uint32 — {@link COLLISION_GLSL}'s `cellHash` computes it bit for bit alike.
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
