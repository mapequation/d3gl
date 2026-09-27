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
// passes write and read it; the tests check it), the range query's canonical cover (the shader's
// loop has this exact TS twin, which the CPU references and error bounds are built from), and the
// tile atlas of the grid pyramid — where each segment's tile sits and where each pyramid level is
// packed (spec §6.2).

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

/**
 * Rows `[r0, r1)` of band `band` when a per-slot pass over an atlas of `rows` rows is cut into `bands`
 * row bands (#352): the bands tile the rows in order, each exactly once, and their heights differ by at
 * most one row. The streaming transport encodes the force pass one band at a time (a scissor over those
 * rows), so one tick's GPU work can be spread over frames that each stay within the frame budget.
 */
export function bandRows(band: number, bands: number, rows: number): [number, number] {
  return [Math.floor((band * rows) / bands), Math.floor(((band + 1) * rows) / bands)];
}

/**
 * Check that `segments` tile the slots `[0, count)` in order: each starts where the previous one ends
 * (empty segments allowed), and together they cover every slot once. Throws otherwise — the passes
 * find a slot's segment by its position, so a gap or an overlap would silently mix segments.
 */
export function validateSegments(segments: readonly SlotRange[], count: number): void {
  if (segments.length === 0) throw new Error("segments: at least one segment is required");
  let next = 0;
  segments.forEach((seg, s) => {
    if (seg.start !== next) {
      throw new Error(`segments: segment ${s} starts at slot ${seg.start}, but slot ${next} is next`);
    }
    next += seg.count;
  });
  if (next !== count) throw new Error(`segments: the segments cover ${next} slots, not the layout's ${count} slots`);
}

/** The segment id of every slot in `[0, count)` (the `slotSeg` texture's data; §5.3). O(count). */
export function slotSegments(segments: readonly SlotRange[], count: number): Uint32Array {
  const out = new Uint32Array(count);
  segments.forEach((seg, s) => out.fill(s, seg.start, seg.start + seg.count));
  return out;
}

/**
 * Throw on the first edge whose endpoints lie in different segments. Forces never cross segments, so
 * such a spring would break isolation (spec §5.4); nested sibling links only ever join children of one
 * parent, so a consumer that produces one has a bug. O(edges).
 */
export function assertSegmentLocalEdges(
  slotSegment: Uint32Array,
  source: Uint32Array,
  target: Uint32Array,
  edgeCount: number,
): void {
  for (let e = 0; e < edgeCount; e++) {
    const a = source[e] ?? 0;
    const b = target[e] ?? 0;
    const sa = slotSegment[a];
    const sb = slotSegment[b];
    if (sa !== sb) {
      throw new Error(`segments: edge ${e} joins slot ${a} (segment ${sa}) and slot ${b} (segment ${sb})`);
    }
  }
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

// ── Tile atlas of the grid pyramid (spec §6.2) ──────────────────────────────────────────────────

/** Smallest tile side of a segment of a many-segment layout (spec §6.2.1). */
export const TILE_MIN_SIDE = 8;
/** The flat layout's smallest grid side — `chooseGrid`'s floor, kept so the flat grid is unchanged. */
export const FLAT_TILE_MIN_SIDE = 16;
/** Largest tile side: 1024² cells (L = 10), where the finest cells average ~1 node at 1M nodes. */
export const TILE_MAX_SIDE = 1024;

/** `segInfo.w` flag: the segment is solved by the exact loop (it has no tile). */
export const SEGMENT_EXACT = 1;
/**
 * `segInfo.w` flag: a nested segment of one child (spec §11.1, #355) — no forces act on it, and the
 * composition places the child at its parent's centre with 0.9 of its radius, as the CPU does.
 */
export const SEGMENT_FROZEN = 2;
/** `segInfo.w` flag: the segment owns a pyramid tile and is solved by the tile-root traversal. */
export const SEGMENT_HAS_TILE = 4;

/**
 * The grid side of a segment of `count` slots: `clamp(nextPow2(⌈√count⌉), minSide, 1024)`. About one
 * slot per finest cell on a uniform layout, so the finest level already separates individual nodes.
 */
export function tileSide(count: number, minSide: number): number {
  const target = Math.ceil(Math.sqrt(Math.max(1, count)));
  let side = 1;
  while (side < target) side <<= 1;
  return Math.min(Math.max(side, minSide), TILE_MAX_SIDE);
}

/** Decode a Morton (Z-order) code: x from the even bits, y from the odd bits. */
export function demorton(code: number): [number, number] {
  let x = 0;
  let y = 0;
  for (let b = 0; b < 16; b++) {
    x |= ((code >>> (2 * b)) & 1) << b;
    y |= ((code >>> (2 * b + 1)) & 1) << b;
  }
  return [x, y];
}

/** A segment's square tile in the level-0 atlas, in cells. `side` is a power of two. */
export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

/** Which of the three pyramid textures holds a level: level 0, the odd levels, or the even levels. */
export type PyramidTexture = "l0" | "odd" | "even";

/** Where one pyramid level is packed: a rectangle of its texture. */
export interface PyramidLevel {
  readonly texture: PyramidTexture;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A texture's size in texels. */
export interface TextureSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The grid pyramid's tile atlas: every segment's tile and where each level is packed. Level 0 is the
 * whole `width × height` atlas (texture `l0`); level ℓ is that atlas halved ℓ times, packed into `odd`
 * or `even` (spec §6.2.3, decided in Q2). A layout whose segments are all exact has no atlas: size 0,
 * no levels.
 */
export interface TileAtlas extends TextureSize {
  /** Per segment, its tile, or `null` when it is solved by the exact loop. */
  readonly tiles: readonly (Tile | null)[];
  /** Levels 0…Lmax, Lmax = log2 of the largest tile side: `levels[ℓ]` is level ℓ. */
  readonly levels: readonly PyramidLevel[];
  /** Size of the texture holding levels 1, 3, 5, …. */
  readonly odd: TextureSize;
  /** Size of the texture holding levels 2, 4, 6, …. */
  readonly even: TextureSize;
}

/**
 * Give every segment with more than `exactMax` slots a tile of side {@link tileSide}`(count, minSide)`
 * and pack the tiles into one atlas (spec §6.2.1):
 *
 * - tiles are placed in descending side (ties by segment order) along a Morton curve, at the curve's
 *   cumulative cell offset `o`: `origin = demorton(o)`, then `o += side²`. Every earlier tile is at
 *   least as large and a power of two, so `o` is a multiple of `side²`, and an aligned Morton range of
 *   `side²` cells decodes to a `side × side` square at a multiple of `side`. So **every tile is
 *   aligned at every level** up to its root, and one 2×2 reduce pass reduces all tiles at once;
 * - the atlas is `A = nextPow2(⌈√Σ side²⌉)` wide, and `A/2` high when the tiles fit in the first
 *   half of the curve (the Morton top bit is y, so the first half is the bottom rows), else `A`.
 *
 * The flat layout is one tile at (0, 0) with side `chooseGrid(N)`: exactly the single grid it had.
 */
export function packTiles(segments: readonly SlotRange[], exactMax: number, minSide: number): TileAtlas {
  const sides = segments.map((seg) => (seg.count > exactMax ? tileSide(seg.count, minSide) : 0));
  const order = sides
    .map((side, s) => ({ side, s }))
    .filter((t) => t.side > 0)
    .sort((a, b) => b.side - a.side || a.s - b.s);
  const tiles: (Tile | null)[] = sides.map(() => null);
  let offset = 0;
  for (const { side, s } of order) {
    const [x, y] = demorton(offset);
    tiles[s] = { x, y, side };
    offset += side * side;
  }
  const maxSide = order[0]?.side ?? 0;
  if (maxSide === 0) {
    return { width: 0, height: 0, tiles, levels: [], odd: { width: 0, height: 0 }, even: { width: 0, height: 0 } };
  }
  let width = 1;
  while (width * width < offset) width <<= 1;
  const height = offset <= (width * width) / 2 ? width / 2 : width;
  return { width, height, tiles, ...packLevels(width, height, Math.log2(maxSide)) };
}

/** The largest atlas side the `segInfo` tile origin (`x | y << 16`, spec §5.2) can address. */
export const TILE_ATLAS_MAX_SIDE = 65536;

/**
 * Throw unless the tile atlas fits: its level-0 texture (`width × height`, the largest of the three)
 * within the device's `maxTextureDimension2D`, where a larger side would fail texture or framebuffer
 * creation, and within {@link TILE_ATLAS_MAX_SIDE}, where a tile origin would wrap. The flat atlas (a
 * side ≤ 1024) always fits; only many large segments can exceed it, and until the spec §11.1 degrade
 * (tile sides halve) lands they are refused here rather than corrupted.
 */
export function assertAtlasFits(atlas: TextureSize, maxTextureSide: number): void {
  const limit = Math.min(maxTextureSide, TILE_ATLAS_MAX_SIDE);
  if (atlas.width <= limit && atlas.height <= limit) return;
  throw new Error(
    `GpuForceLayout: the segments' tile atlas is ${atlas.width} × ${atlas.height} texels, beyond the ` +
      `${limit}-texel limit (device maxTextureDimension2D ${maxTextureSide}, tile origin ${TILE_ATLAS_MAX_SIDE})`,
  );
}

/**
 * Pack levels 0…`top` of a `width × height` level-0 atlas (both powers of two): level 0 alone in
 * `l0`; level 1 at (0, 0) of `odd` with levels 3, 5, … stacked in a column to its right; level 2 at
 * (0, 0) of `even` with levels 4, 6, … likewise. A column of levels ℓ + 2, ℓ + 4, … is narrower than
 * a quarter of level ℓ and shorter than a third of it, so it fits beside level ℓ.
 */
function packLevels(width: number, height: number, top: number): Pick<TileAtlas, "levels" | "odd" | "even"> {
  const levels: PyramidLevel[] = [{ texture: "l0", x: 0, y: 0, width, height }];
  const column = { odd: 0, even: 0 };
  for (let l = 1; l <= top; l++) {
    const texture = l % 2 === 1 ? "odd" : "even";
    const first = l <= 2;
    const x = first ? 0 : width >> (texture === "odd" ? 1 : 2);
    const y = first ? 0 : column[texture];
    if (!first) column[texture] += height >> l;
    levels.push({ texture, x, y, width: width >> l, height: height >> l });
  }
  const size = (first: number): TextureSize =>
    top < first
      ? { width: 1, height: 1 }
      : { width: (width >> first) + (top >= first + 2 ? width >> (first + 2) : 0), height: height >> first };
  return { levels, odd: size(1), even: size(2) };
}

/**
 * A segment's `segInfo` texel (spec §5.2): `(start, count, x | y << 16, rootLevel | flags << 8 |
 * side << 16)`. A tiled segment's root is level `rootLevel = log2 side` at cell `(x >> rootLevel,
 * y >> rootLevel)`; an exact segment has no tile (origin, root level and side 0).
 *
 * The side is stored as well as its log2 on purpose: the scatter and the traversal both turn it into
 * the grid's float `G` with a plain `float(side)`, never `float(1 << rootLevel)`. The #251 near field
 * needs the two shaders to round the cell centre `lo + (cell + 0.5) / G · boxSide` bit for bit alike,
 * and a visible power of two lets a fast-math compiler reassociate that expression differently in one
 * of them (measured on ANGLE Metal; see AGENTS.md).
 */
export function segmentInfo(seg: SlotRange, tile: Tile | null, frozen = false): [number, number, number, number] {
  const extra = frozen ? SEGMENT_FROZEN : 0;
  if (!tile) return [seg.start, seg.count, 0, ((SEGMENT_EXACT | extra) << 8) >>> 0];
  const rootLevel = 31 - Math.clz32(tile.side);
  return [
    seg.start,
    seg.count,
    (tile.x | (tile.y << 16)) >>> 0,
    (rootLevel | ((SEGMENT_HAS_TILE | extra) << 8) | (tile.side << 16)) >>> 0,
  ];
}

/**
 * The coordinate frame the segments are solved in, which sets their repulsion softening ε: `"world"`
 * for the flat layout (world units), `"unit"` for segments solved in a unit disc (the nested layout).
 */
export type SegmentFrame = "world" | "unit";

/**
 * A segment's repulsion softening ε, added to d² in the force kernel (spec §6.2.2). The world frame
 * keeps the flat layout's absolute 1e-2 on both paths (the CPU quadtree's). The unit frame follows the
 * CPU nested reference, which softens its two paths differently: its exact loop adds 1e-9 in unit
 * coordinates, and its Barnes-Hut runs in a ×1000 frame (`BH_SCALE`) with the absolute 1e-2 — 1e-8 in
 * unit coordinates.
 */
export function segmentSoftening(frame: SegmentFrame, exact: boolean): number {
  if (frame === "world") return 1e-2;
  return exact ? 1e-9 : 1e-8;
}
