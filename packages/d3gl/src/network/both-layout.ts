/**
 * The both view's packing of state nodes inside their physical node (#509, decision D2): the area spiral.
 *
 * Within each physical node the state nodes are sorted by radius, largest first (ties by state id). State node i
 * sits at the golden angle `i · 2.39996` rad and at the distance `sqrt(A_before / (π · fill))`, where `A_before`
 * is the summed area of the state nodes placed before it: the spiral holds their area at a density of `fill`.
 * The physical node's radius is the largest `distance + radius` over its state nodes, plus a padding.
 *
 * The plain spiral overlaps a few pairs: near the centre (the second state node lands inside the first when their
 * radii are similar) and where the radii step down (a small state node lands on a large one placed just inside
 * its distance). Each state node is therefore pushed outward along its own ray until it clears every state node
 * placed before it. Along a ray each earlier state node blocks one interval, so a push past it is final: a state
 * node is pushed at most once per earlier state node it meets, and only its few neighbours are ever met. They are
 * found in a hash grid of radius classes: class L holds the radii in `(r₀/2^(L+1), r₀/2^L]` in cells of four times
 * its largest radius, so a query, which is never larger than an earlier state node, reads 2 × 2 cells per
 * class, each holding a bounded number of state nodes. A class the spiral has passed is retired, so most queries
 * read one or two classes. With a fixed number of classes that is O(1) per state node, so the packing is linear in
 * the state nodes after the sort, O(S log s) with the sort (s: the largest physical node's state-node count). A
 * physical node of at most {@link SMALL} state nodes is checked pairwise, which is faster there than the grid.
 *
 * It runs once per style or data change, in size units: the offsets depend on neither the zoom nor the layout.
 * Deterministic (no RNG): identical inputs → identical output.
 */
import type { PhysicalToState } from "./state-graph.js";

/** The golden angle, π(3 − √5) ≈ 2.39996 rad, as {@link rosettePositions} uses. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** The density at which the spiral holds the area of the state nodes placed before each one (D2). */
const DEFAULT_FILL = 0.62;
/** A physical node of at most this many state nodes is checked pairwise instead of through the grid. */
const SMALL = 64;
/** The last radius class: state nodes smaller than r₀/2^LAST_CLASS share its cells. Only radii that differ by more
 *  than 2^16 within one physical node reach it, where its cells may hold more state nodes than the other classes'. */
const LAST_CLASS = 16;
/** Relative clearance kept between two state nodes, in units of their distance from the centre plus their radii: it
 *  covers the float32 rounding of the offsets (≈6e-8 relative), so the stored offsets do not overlap either. A
 *  push clears twice this margin, so a state node just pushed never re-tests as overlapping. */
const EPS = 1e-6;
/** A grid cell's side in units of its class's largest radius: twice a query's reach, so a query reads 2 × 2 cells. */
const CELL = 4;

export interface BothPackingOptions {
  /** Space between the outermost state node and the physical node's edge, in size units. Default 0. */
  padding?: number;
  /** The area density of the spiral (D2). Default 0.62. */
  fill?: number;
  /** An output array to reuse for the offsets: length `2 · stateCount`. */
  offsets?: Float32Array;
  /** An output array to reuse for the physical radii: length `physicalCount`. */
  radii?: Float32Array;
}

export interface BothPacking {
  /** Each state node's offset from its physical node's centre, interleaved `[dx, dy, …]`, in size units. */
  offsets: Float32Array;
  /** Each physical node's radius in size units: it encloses its state nodes, plus the padding. */
  radii: Float32Array;
}

/** A radius as the packing takes it: a negative or NaN radius is 0. */
function radiusOf(nodeRadii: Float32Array, s: number): number {
  const r = nodeRadii[s] ?? 0;
  return r > 0 ? r : 0;
}

/** Whether state node `a` is placed before `b`: the larger radius first, ties by the smaller state id. */
function before(nodeRadii: Float32Array, a: number, b: number): boolean {
  const ra = radiusOf(nodeRadii, a);
  const rb = radiusOf(nodeRadii, b);
  return ra > rb || (ra === rb && a < b);
}

/** Sort `order[lo, hi)` by {@link before}, in place and without allocating: quicksort on the larger side's loop and
 *  the smaller side's recursion (depth O(log n)), insertion sort below 16. The order is total (state ids are
 *  distinct), so the result does not depend on the input order. */
function sortStates(order: Uint32Array, lo: number, hi: number, nodeRadii: Float32Array): void {
  while (hi - lo > 16) {
    const mid = (lo + hi) >>> 1;
    // Median of three into order[mid], as the pivot.
    if (before(nodeRadii, order[mid] ?? 0, order[lo] ?? 0)) swap(order, mid, lo);
    if (before(nodeRadii, order[hi - 1] ?? 0, order[lo] ?? 0)) swap(order, hi - 1, lo);
    if (before(nodeRadii, order[hi - 1] ?? 0, order[mid] ?? 0)) swap(order, hi - 1, mid);
    const pivot = order[mid] ?? 0;
    let i = lo;
    let j = hi - 1;
    for (;;) {
      while (before(nodeRadii, order[i] ?? 0, pivot)) i++;
      while (before(nodeRadii, pivot, order[j] ?? 0)) j--;
      if (i >= j) break;
      swap(order, i, j);
      i++;
      j--;
    }
    // order[lo, j] ≤ pivot ≤ order[j + 1, hi): recurse into the smaller part, loop on the larger.
    if (j + 1 - lo < hi - (j + 1)) {
      sortStates(order, lo, j + 1, nodeRadii);
      lo = j + 1;
    } else {
      sortStates(order, j + 1, hi, nodeRadii);
      hi = j + 1;
    }
  }
  for (let i = lo + 1; i < hi; i++) {
    const v = order[i] ?? 0;
    let j = i - 1;
    while (j >= lo && before(nodeRadii, v, order[j] ?? 0)) {
      order[j + 1] = order[j] ?? 0;
      j--;
    }
    order[j + 1] = v;
  }
}

function swap(a: Uint32Array, i: number, j: number): void {
  const t = a[i] ?? 0;
  a[i] = a[j] ?? 0;
  a[j] = t;
}

/** One float32 bit pattern, to round a radius up to the next float32 when rounding to nearest went down. */
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** The smallest float32 ≥ `v` (v ≥ 0, finite), so a stored radius never shrinks below what it encloses. */
function float32Up(v: number): number {
  F32[0] = v;
  if ((F32[0] ?? 0) < v) U32[0] = (U32[0] ?? 0) + 1;
  return F32[0] ?? 0;
}

/**
 * Pack each physical node's state nodes with the area spiral (D2), in size units. `nodeRadii` holds each state
 * node's resolved radius (length `stateCount`); `physicalToState` is the state graph's CSR. Returns each state
 * node's offset from its physical node's centre and each physical node's radius: the largest
 * `|offset| + radius` over its state nodes, plus `padding`. No two state nodes of a physical node overlap
 * (their distance is at least the sum of their radii), and every state node lies within its physical node's
 * radius minus the padding.
 *
 * Edge cases: a lone state node sits at offset 0. A physical node with no state nodes gets the padding alone as
 * its radius (today's both view instead gives it its smallest container). A state node of radius 0 (or a negative
 * or NaN one, taken as 0) is placed after every larger one, at the spiral's end, clear of every state node of a
 * positive radius; two of radius 0 never overlap, so in a physical node whose radii are all 0 every state node
 * sits at offset 0.
 *
 * O(S) time after an O(S log s) sort and O(s) scratch, where S is the number of state nodes and s the largest
 * physical node's count; no allocation per physical node. Pass `options.offsets` / `options.radii` to reuse the
 * output arrays.
 */
export function packStateNodes(
  nodeRadii: Float32Array,
  physicalToState: PhysicalToState,
  options: BothPackingOptions = {},
): BothPacking {
  const { offsets: starts, states } = physicalToState;
  const physicalCount = starts.length - 1;
  const stateCount = states.length;
  if (nodeRadii.length !== stateCount) {
    throw new Error(`packStateNodes: nodeRadii length ${nodeRadii.length} !== stateCount ${stateCount}`);
  }
  const padding = Math.max(0, options.padding ?? 0);
  const fill = options.fill ?? DEFAULT_FILL;
  const offsets = options.offsets ?? new Float32Array(2 * stateCount);
  const radii = options.radii ?? new Float32Array(physicalCount);
  if (offsets.length !== 2 * stateCount) {
    throw new Error(`packStateNodes: offsets length ${offsets.length} !== 2 · stateCount ${2 * stateCount}`);
  }
  if (radii.length !== physicalCount) {
    throw new Error(`packStateNodes: radii length ${radii.length} !== physicalCount ${physicalCount}`);
  }

  let maxCount = 0;
  for (let p = 0; p < physicalCount; p++) {
    const count = (starts[p + 1] ?? 0) - (starts[p] ?? 0);
    if (count > maxCount) maxCount = count;
  }
  // One scratch for every physical node, indexed by the place in the sorted order. `placed` holds each placed
  // state node's x, y, radius and the next place in its grid cell side by side, so a pair check reads one cache line.
  const order = new Uint32Array(maxCount);
  const placed = new Float64Array(PLACED * maxCount);
  const grid = maxCount > SMALL ? new RadiusClassGrid(maxCount) : null;
  const cos = Math.cos(GOLDEN_ANGLE);
  const sin = Math.sin(GOLDEN_ANGLE);

  for (let p = 0; p < physicalCount; p++) {
    const start = starts[p] ?? 0;
    const count = (starts[p + 1] ?? 0) - start;
    if (count === 0) {
      radii[p] = float32Up(padding);
      continue;
    }
    for (let k = 0; k < count; k++) order[k] = states[start + k] ?? 0;
    sortStates(order, 0, count, nodeRadii);
    const r0 = radiusOf(nodeRadii, order[0] ?? 0);
    const useGrid = grid !== null && count > SMALL && r0 > 0;
    if (useGrid) grid.reset(count, r0);
    let area = 0; // Σ r² of the state nodes placed so far (the π cancels against the spiral's)
    let ux = 1; // the ray of state node i: the golden angle times i, turned one step per state node
    let uy = 0;
    let enclosing = 0;
    for (let i = 0; i < count; i++) {
      const s = order[i] ?? 0;
      const r = radiusOf(nodeRadii, s);
      let t = Math.sqrt(area / fill);
      if (r0 > 0) t = useGrid ? grid.clear(t, ux, uy, r, placed) : clearPairwise(i, t, ux, uy, r, placed);
      const x = t > 0 ? t * ux : 0; // not -0 at the centre
      const y = t > 0 ? t * uy : 0;
      placed[PLACED * i] = x;
      placed[PLACED * i + 1] = y;
      placed[PLACED * i + 2] = r;
      if (useGrid && r > 0) grid.insert(i, x, y, r, placed);
      const fx = Math.fround(x);
      const fy = Math.fround(y);
      offsets[2 * s] = fx;
      offsets[2 * s + 1] = fy;
      const reach = Math.sqrt(fx * fx + fy * fy) + r;
      if (reach > enclosing) enclosing = reach;
      area += r * r;
      const nx = ux * cos - uy * sin;
      uy = ux * sin + uy * cos;
      ux = nx;
    }
    radii[p] = float32Up(enclosing + padding);
  }
  return { offsets, radii };
}

/** Doubles per placed state node in the scratch: x, y, radius, and the next place in the same grid cell (-1: none). */
const PLACED = 4;

/** The distance along the ray `u` past `t` at which a state node of radius `r` clears the earlier state node at
 *  (`cx`, `cy`) of radius `rj`, or `t` itself when it already does. The push clears twice the margin it tests. */
function pushPast(t: number, ux: number, uy: number, r: number, cx: number, cy: number, rj: number): number {
  const reach = r + rj;
  const margin = EPS * (t + reach);
  const dx = t * ux - cx;
  const dy = t * uy - cy;
  const near = reach + margin;
  if (dx * dx + dy * dy >= near * near) return t;
  // Leave the circle of radius reach + 2·margin round (cx, cy) where the ray exits it.
  const along = cx * ux + cy * uy;
  const off2 = cx * cx + cy * cy - along * along;
  const far = reach + 2 * margin;
  const exit = along + Math.sqrt(Math.max(0, far * far - off2));
  return Math.max(exit, t + margin);
}

/** Push state node `i` outward from `t` until it clears every earlier one, checking each pair: a small physical
 *  node. A push past an earlier state node is final along the ray, so the scan restarts only after a push, at most
 *  once per earlier state node. */
function clearPairwise(i: number, t: number, ux: number, uy: number, r: number, placed: Float64Array): number {
  let pushed = true;
  while (pushed) {
    pushed = false;
    for (let j = 0; j < i; j++) {
      const rj = placed[PLACED * j + 2] ?? 0;
      if (rj === 0) break; // sorted: every later one is 0 too, and two of radius 0 never overlap
      const next = pushPast(t, ux, uy, r, placed[PLACED * j] ?? 0, placed[PLACED * j + 1] ?? 0, rj);
      if (next !== t) {
        t = next;
        pushed = true;
      }
    }
  }
  return t;
}

/** Doubles per slot of the grid's hash table: the cell's class + 1 (0: an empty slot), its column, its row, and the
 *  first place in it, side by side so a probe reads one cache line. */
const SLOT = 4;

/**
 * A hash grid of the state nodes placed so far in one physical node, one cell lattice per radius class. Class L
 * holds radii in `(r₀/2^(L+1), r₀/2^L]` (r₀ the physical node's largest radius; the last class everything smaller)
 * in cells of side `CELL·r₀/2^L`, keyed `(L, column, row)` in an open-addressing table, each state node in its
 * centre's cell. A query of radius r ≤ every earlier radius reaches at most `r + r₀/2^L ≤ 2·r₀/2^L` from its
 * centre in class L, so it reads 2 × 2 cells per non-empty class (cells twice that reach wide), each with a
 * bounded number of state nodes: those of class L are at least r₀/2^(L+1) in radius and do not overlap. Sized
 * once for the largest physical node, reset per physical node in O(its state nodes).
 */
class RadiusClassGrid {
  private readonly capacity: number;
  private mask = 0;
  private readonly slots: Float64Array;
  /** Each non-empty class, in the order they filled (ascending: the radii arrive largest first). */
  private readonly classes = new Int32Array(LAST_CLASS + 1);
  private classCount = 0;
  /** Each class's largest radius, r₀/2^L. */
  private readonly classRadius = new Float64Array(LAST_CLASS + 1);
  /** Each class's largest distance of a state node from the centre. */
  private readonly classReach = new Float64Array(LAST_CLASS + 1);
  /** The class the latest insert went to: the radii arrive in descending order, so it only moves up. */
  private current = 0;

  constructor(maxCount: number) {
    let capacity = 2;
    while (capacity < 2 * maxCount) capacity *= 2;
    this.capacity = capacity;
    this.slots = new Float64Array(SLOT * capacity);
  }

  /** Empty the grid for a physical node of `count` state nodes whose largest radius is `r0` > 0. O(count). */
  reset(count: number, r0: number): void {
    let size = 2;
    while (size < 2 * count) size *= 2;
    this.mask = Math.min(size, this.capacity) - 1;
    for (let slot = 0; slot <= this.mask; slot++) this.slots[SLOT * slot] = 0;
    this.classCount = 0;
    this.current = 0;
    let s = r0;
    for (let L = 0; L <= LAST_CLASS; L++) {
      this.classRadius[L] = s;
      this.classReach[L] = 0;
      s /= 2;
    }
  }

  /** The slot of cell (`cx`, `cy`) of class `L`, or the empty slot where it would go. */
  private slotOf(L: number, cx: number, cy: number): number {
    // Combine, then the murmur3 finaliser, so that neighbouring cells spread over the low bits the mask keeps.
    let h = Math.imul(cx | 0, 0x9e3779b1) ^ Math.imul(cy | 0, 0x85ebca77) ^ Math.imul(L + 1, 0xc2b2ae3d);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    const key = L + 1;
    let slot = h & this.mask;
    for (;;) {
      const at = SLOT * slot;
      const c = this.slots[at] ?? 0;
      if (c === 0 || (c === key && this.slots[at + 1] === cx && this.slots[at + 2] === cy)) return slot;
      slot = (slot + 1) & this.mask;
    }
  }

  /** Add the placed state node at sorted place `i`, at (`x`, `y`) with radius `r` > 0, linking it into its cell. */
  insert(i: number, x: number, y: number, r: number, placed: Float64Array): void {
    let L = this.current;
    while (L < LAST_CLASS && r <= (this.classRadius[L + 1] ?? 0)) L++;
    if (this.classCount === 0 || this.classes[this.classCount - 1] !== L) this.classes[this.classCount++] = L;
    this.current = L;
    const d = Math.sqrt(x * x + y * y);
    if (d > (this.classReach[L] ?? 0)) this.classReach[L] = d;
    const side = CELL * (this.classRadius[L] ?? 0);
    const cx = Math.floor(x / side);
    const cy = Math.floor(y / side);
    const at = SLOT * this.slotOf(L, cx, cy);
    if (this.slots[at] === 0) {
      this.slots[at] = L + 1;
      this.slots[at + 1] = cx;
      this.slots[at + 2] = cy;
      this.slots[at + 3] = -1;
    }
    placed[PLACED * i + 3] = this.slots[at + 3] ?? -1;
    this.slots[at + 3] = i;
  }

  /** Push a state node of radius `r` outward from its spiral distance `t` along (`ux`, `uy`) until it clears every
   *  state node in the grid; the scan restarts after a push, which is final along the ray (see {@link clearPairwise}).
   *
   *  First it retires each class the spiral has passed: one whose state nodes all lie closer to the centre than
   *  `t − r − classR` cannot reach this state node, nor any later one, whose spiral distance minus its radius is no
   *  smaller (the spiral distance grows, the radii shrink). The large state nodes come first and fill the middle, so
   *  most queries read one or two classes. A retired class comes back when a state node joins it. */
  clear(t: number, ux: number, uy: number, r: number, placed: Float64Array): number {
    let live = 0;
    for (let k = 0; k < this.classCount; k++) {
      const L = this.classes[k] ?? 0;
      const classR = this.classRadius[L] ?? 0;
      if (t - r - classR - 2 * EPS * (t + r + classR) <= (this.classReach[L] ?? 0)) this.classes[live++] = L;
    }
    this.classCount = live;
    let pushed = true;
    while (pushed) {
      pushed = false;
      const x = t * ux;
      const y = t * uy;
      for (let k = 0; k < this.classCount; k++) {
        const L = this.classes[k] ?? 0;
        const classR = this.classRadius[L] ?? 0;
        const side = CELL * classR;
        const reach = r + classR + 2 * EPS * (t + r + classR);
        const x0 = Math.floor((x - reach) / side);
        const x1 = Math.floor((x + reach) / side);
        const y0 = Math.floor((y - reach) / side);
        const y1 = Math.floor((y + reach) / side);
        for (let cy = y0; cy <= y1; cy++) {
          for (let cx = x0; cx <= x1; cx++) {
            const at = SLOT * this.slotOf(L, cx, cy);
            if (this.slots[at] === 0) continue;
            for (let j = this.slots[at + 3] ?? -1; j !== -1; j = placed[PLACED * j + 3] ?? -1) {
              const o = PLACED * j;
              const next = pushPast(t, ux, uy, r, placed[o] ?? 0, placed[o + 1] ?? 0, placed[o + 2] ?? 0);
              if (next !== t) {
                t = next;
                pushed = true;
              }
            }
          }
        }
      }
    }
    return t;
  }
}
