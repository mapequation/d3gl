// ─────────────────────────────────────────────────────────────────────────────
// CPU prep for the segmented GPU force solver (#333) — pure, node-tested.
// ─────────────────────────────────────────────────────────────────────────────
//
// Nodes live in *slots* (indices into the solver's per-node textures, mapped to texels by
// `slotTexel`). Slots are grouped into *segments* — contiguous slot intervals that forces never
// cross — and the reductions answer queries over contiguous slot *ranges* (every segment is one).
// The flat layout is the case with exactly one segment covering every slot.
//
// This module owns the parts both sides must agree on: the reduction tree's packed layout (the GPU
// passes write and read it; the tests check it) and the range query's canonical cover (the shader's
// loop has this exact TS twin, which the CPU references and error bounds are built from).

/** Fan-out of the reduction tree: a level-ℓ texel covers 16^ℓ consecutive slots. */
export const REDUCE_FANOUT = 16;

/**
 * Deepest tree level the range-query shader addresses. 16^7 ≈ 268M slots — beyond any position
 * atlas a WebGL2 device can hold — so a capacity that would need more is a caller bug.
 */
export const REDUCE_MAX_LEVELS = 7;

/** A contiguous slot interval `[start, start + count)`. Every segment is one; ranges may also nest. */
export interface SlotRange {
  readonly start: number;
  readonly count: number;
}

/** The flat layout's segment table: one segment over every slot. */
export function flatSegments(count: number): SlotRange[] {
  return [{ start: 0, count }];
}

/** One level of the reduction tree, packed into rows of its texture. */
export interface ReduceLevel {
  /** Texels in the level: ⌈size(ℓ−1) / 16⌉, where level 0 is the slots. */
  readonly size: number;
  /** The texture holding the level: odd levels live in A (0), even levels in B (1). */
  readonly texture: 0 | 1;
  /** First row of the level inside its texture. */
  readonly rowOffset: number;
  /** Rows the level spans: ⌈size / width⌉. */
  readonly rows: number;
}

/**
 * The reduction tree's storage. Each level is a 1D array packed row-major into rows of `width`
 * texels; odd levels stack in texture A and even levels in texture B, so a level pass (which reads
 * level ℓ−1) never samples the texture it renders into — no WebGL feedback loop, pure luma.
 */
export interface ReduceLayout {
  /** Slot capacity the tree covers. */
  readonly capacity: number;
  /** Row width shared by both textures. */
  readonly width: number;
  /** Levels 1…L, with `levels[ℓ − 1]` = level ℓ. */
  readonly levels: readonly ReduceLevel[];
  /** Height of texture A (≥ 1). */
  readonly heightA: number;
  /** Height of texture B (≥ 1). */
  readonly heightB: number;
}

/**
 * Lay out the tree over `capacity` slots: levels 1…L with 16^L ≤ capacity. Those are exactly the
 * levels a canonical cover of a range inside `[0, capacity)` can touch — at level ℓ the cover's upper
 * bound is at most ⌊capacity / 16^ℓ⌋, which is 0 once 16^ℓ > capacity — so the 1-texel top level a
 * full tree would end with is never built. At 325,729 slots: 20,359 → 1,273 → 80 → 5 texels.
 */
export function reduceLayout(capacity: number): ReduceLayout {
  const sizes: number[] = [];
  let n = capacity;
  for (let span = REDUCE_FANOUT; span <= capacity; span *= REDUCE_FANOUT) {
    n = Math.ceil(n / REDUCE_FANOUT);
    sizes.push(n);
  }
  if (sizes.length > REDUCE_MAX_LEVELS) {
    throw new Error(`reduceLayout: ${capacity} slots need ${sizes.length} tree levels (max ${REDUCE_MAX_LEVELS})`);
  }
  const width = Math.max(1, Math.ceil(Math.sqrt(sizes[0] ?? 1)));
  const height: [number, number] = [0, 0];
  const levels = sizes.map((size, k): ReduceLevel => {
    const texture = k % 2 === 0 ? 0 : 1; // level k + 1: odd → A, even → B
    const rows = Math.ceil(size / width);
    const level: ReduceLevel = { size, texture, rowOffset: height[texture], rows };
    height[texture] += rows;
    return level;
  });
  return { capacity, width, levels, heightA: Math.max(1, height[0]), heightB: Math.max(1, height[1]) };
}

/** One term of a range query: tree texel `index` of `level` (level 0 = a single slot). */
export interface CoverTerm {
  readonly level: number;
  readonly index: number;
}

/**
 * The canonical cover of `[start, start + count)` by aligned tree blocks, in the order the range
 * query adds them — the shader's loop, verbatim:
 *
 * ```
 * a = start; b = start + count; level = 0
 * while (a < b) {
 *   while (a < b && a % 16 != 0) take(level, a++)      // unaligned head, ascending
 *   while (a < b && b % 16 != 0) take(level, --b)      // unaligned tail, descending
 *   a /= 16; b /= 16; level++
 * }
 * ```
 *
 * At most 15 + 15 terms per level; `count = 0` gives no terms (the identity).
 */
export function canonicalCover(start: number, count: number): CoverTerm[] {
  const terms: CoverTerm[] = [];
  let a = start;
  let b = start + count;
  for (let level = 0; a < b; level++) {
    while (a < b && a % REDUCE_FANOUT !== 0) terms.push({ level, index: a++ });
    while (a < b && b % REDUCE_FANOUT !== 0) terms.push({ level, index: --b });
    a = Math.floor(a / REDUCE_FANOUT);
    b = Math.floor(b / REDUCE_FANOUT);
  }
  return terms;
}

/**
 * An upper bound on the float32 add depth of any slot's contribution to a range sum: a level-ℓ
 * texel is a 4-deep pairwise add tree per level (4ℓ), and the query adds its terms one after
 * another (at most one add per term). The rounding error of the sum is then bounded by
 * `D · ε · Σ|term|` (spec §6.1) — it scales with the terms' magnitude, not with the result.
 */
export function coverDepth(terms: readonly CoverTerm[]): number {
  let maxLevel = 0;
  for (const t of terms) if (t.level > maxLevel) maxLevel = t.level;
  return terms.length === 0 ? 0 : 4 * maxLevel + terms.length;
}
