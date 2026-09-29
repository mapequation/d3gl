/**
 * **Nested drag reheat** — a node drag on a map laid out by the nested module layout (`nested-layout.ts`).
 *
 * A flat layout reheats the whole graph around a dragged node. A nested map instead re-solves only the
 * level the grab belongs to: the grabbed node's **module** — its siblings are pushed aside and settle
 * around it, inside the module's disc — and, for a collapsed module aggregate, its parent, whose other
 * modules move aside. Every other module stays where it is, and the map stays nested:
 *
 * - **The held node follows the cursor freely**, inside its module's disc or out of it.
 * - **The module's disc keeps its centre.** Its other children are kept inside its own radius, as the
 *   layout sized it; nothing is refit. While a member lies outside — the held node, or one dropped there —
 *   the disc's radius (its ring, `lod({ moduleBoundary })`, #329, and its LOD extent) grows about the same
 *   centre just enough to enclose it, and shrinks back as it returns, so a ring always encloses its
 *   members and the map reads as nested. The parent's disc and every other module stay as they are.
 * - **A sibling moves as a whole.** A sibling module's disc translates with everything inside it — its
 *   own layout and its ring are unchanged.
 * - **A selection spanning several modules** re-solves each of them: the held nodes are the largest
 *   subtrees whose leaves are all held; each of their parents is re-solved, with every child that holds a
 *   held leaf pinned (the held ones under the cursor, the others where they are).
 * - A grab that holds the whole map (the root aggregate) has no parent to re-solve: the caller translates.
 *
 * The solve is the module solve's COMPACT phase (gravity, springs over the same sibling links, collision)
 * with pinned discs, held at {@link NESTED_DRAG_ALPHA} while the pointer is down and cooled to
 * `NESTED.ALPHA_MIN` over at most {@link NESTED_DRAG_COOL_TICKS} ticks after release (the node is let go,
 * as on the flat layouts). It runs on the main thread for every layout backend: one module's children
 * cost far less than waking a GPU or worker solve, and nothing stays resident after the drag.
 *
 * Cost, per tick: O(k + links) for the re-solved modules' k children (collision on a grid above
 * `EXACT_MAX` children), plus O(nodes under the children that moved this tick) to translate them —
 * never a pass over the whole graph unless the moved siblings hold it. A grab costs one O(tree size) pass
 * the first time on a layout (leaf counts, cached), then O(nodes under the re-solved modules).
 */
import type { BoundaryDiscs } from "./lod.js";
import { NESTED, Scratch, collide, moduleLinks, type NestedLayoutTopology } from "./nested-layout.js";

/** Alpha a re-solved module is held at while the pointer is down. */
export const NESTED_DRAG_ALPHA = 0.05;
/** Most ticks a re-solved module cools for after release (it stops earlier once it is still). */
export const NESTED_DRAG_COOL_TICKS = 90;
/** Ticks of the cool-down before a still module may stop early. */
const MIN_COOL_TICKS = 10;
/** A module is still once no child moved more than this share of its parent's radius in a tick (a
 *  0.01 px step for a module drawn 100 px wide). */
const STILL = 1e-4;

/**
 * What drags on one nested layout reuse across grabs: the topology, the size metric it was laid out
 * with, each tree node's leaf count (one O(tree size) pass, on the first grab), a local-index scratch,
 * each re-solved module's child radii, and its disc radius as the layout sized it. A module's child
 * radii are recovered from the layout the first time it is grabbed ({@link childRadii}) and kept: once a
 * drag has moved its children, the layout no longer tells them. Its disc radius is kept for the same
 * reason: a drag grows a disc to enclose a member outside it.
 */
export class NestedDragCache {
  private counts: Uint32Array | null = null;
  private localScratch: Int32Array | null = null;
  private readonly radii = new Map<number, Float64Array>();
  private readonly baseR = new Map<number, number>();

  constructor(
    readonly topo: NestedLayoutTopology,
    /** The per-leaf size metric the layout sized its discs by (undefined: one per leaf). */
    readonly size: ArrayLike<number> | undefined,
  ) {}

  /** Leaves under each tree node. Children have lower ids than their parents: one ascending pass. */
  leafCounts(): Uint32Array {
    if (this.counts) return this.counts;
    const { size, leafCount, parent } = this.topo;
    const counts = new Uint32Array(size);
    counts.fill(1, 0, leafCount);
    for (let g = 0; g < size; g++) {
      const p = parent[g]!;
      if (p >= 0) counts[p] = counts[p]! + counts[g]!;
    }
    this.counts = counts;
    return counts;
  }

  local(): Int32Array {
    this.localScratch ??= new Int32Array(this.topo.size).fill(-1);
    return this.localScratch;
  }

  /** Module `g`'s child radii in world units, if recorded. */
  radiiOf(g: number): Float64Array | undefined {
    return this.radii.get(g);
  }

  keepRadii(g: number, r: Float64Array): void {
    this.radii.set(g, r);
  }

  /**
   * Module `g`'s disc radius as the layout sized it: `current` (its disc's radius now) until a drag
   * re-solves it, then the radius recorded then — a drag may since have grown the disc.
   */
  radiusOf(g: number, current: number): number {
    return this.baseR.get(g) ?? current;
  }

  /** Record module `g`'s disc radius before a drag re-solves it (the first time only). */
  keepRadius(g: number, r: number): void {
    if (!this.baseR.has(g)) this.baseR.set(g, r);
  }
}

/**
 * A module's child radii (world units) as the nested layout sized them, recovered from where it placed
 * them. The layout gives child `i` the radius `aᵢ·S`, `aᵢ = √max(wᵢ, floor)` from its size metric `wᵢ`
 * (the floor `Σw / 50k`), with one scale `S` per module, and fits the children's enclosing circle to
 * `FILL · R`: `max(dᵢ + aᵢ·S) = FILL · R` for the children's distances `dᵢ` from the disc centre, so
 * `S = minᵢ (FILL · R − dᵢ) / aᵢ`. A module child's radius is known exactly (`moduleR`, NaN for a leaf).
 * A lone child has {@link NESTED.ONLY_CHILD} of its parent's radius. Exported for the tests.
 */
export function childRadii(R: number, weight: Float64Array, dist: Float64Array, moduleR: Float64Array): Float64Array {
  const k = weight.length;
  const out = new Float64Array(k);
  if (k === 1) {
    out[0] = Number.isFinite(moduleR[0]!) ? moduleR[0]! : NESTED.ONLY_CHILD * R;
    return out;
  }
  let total = 0;
  for (let i = 0; i < k; i++) total += weight[i]!;
  const floor = total > 0 ? total / (k * 50) : 1;
  let S = Infinity;
  let exact = NaN; // a module child's r / a: the scale where the fit is not needed
  for (let i = 0; i < k; i++) {
    const a = Math.sqrt(Math.max(weight[i]!, floor));
    S = Math.min(S, (NESTED.FILL * R - dist[i]!) / a);
    if (Number.isFinite(moduleR[i]!) && !Number.isFinite(exact)) exact = moduleR[i]! / a;
  }
  // A module child gives the scale exactly; the fit is the fallback (all children leaves).
  const scale = Number.isFinite(exact) && exact > 0 ? exact : S > 0 ? S : (0.01 * R) / Math.sqrt(Math.max(total, 1));
  for (let i = 0; i < k; i++) {
    out[i] = Number.isFinite(moduleR[i]!) ? moduleR[i]! : Math.sqrt(Math.max(weight[i]!, floor)) * scale;
  }
  return out;
}

/** Work counters of a drag, for the tests. */
export interface NestedDragStats {
  ticks: number;
  /** Leaf positions written, over every tick. */
  leafWrites: number;
  /** LOD tree nodes translated, over every tick. */
  nodeWrites: number;
}

/**
 * The LOD geometry a tick keeps up with the positions: the module tree's `cx` / `cy` (translated with
 * the moved subtrees) and `extent` (a re-solved module's grown disc, and its ancestors').
 */
export interface NestedDragGeometry {
  cx: Float32Array;
  cy: Float32Array;
  extent: Float32Array;
}

const FREE = 0;
const HELD = 1;
const FIXED = 2;

/** One re-solved module: its children in its unit disc (the disc's radius is 1, its centre the origin). */
class ModuleReheat {
  readonly k: number;
  readonly s = new Scratch();
  /** FREE, HELD or FIXED per child. */
  readonly mode: Uint8Array;
  /** Non-zero where a child does not move this tick (held while the pointer is down, or fixed). */
  readonly pinned: Uint8Array;
  /** Non-zero where a child is kept inside the disc (see the constructor). */
  readonly contain: Uint8Array;
  /** A held child's local position at grab. */
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  /** Each child's local position as last written to the world. */
  readonly px: Float64Array;
  readonly py: Float64Array;
  /** Leaves under each child. */
  readonly cnt: Float64Array;
  /** Tree nodes under each child (the child included): `nodes[nodeOff[i] … nodeOff[i + 1])`. */
  readonly nodeOff: Uint32Array;
  readonly nodes: Uint32Array;
  readonly la: readonly number[];
  readonly lb: readonly number[];
  readonly lw: readonly number[];
  /** This module and its ancestors, with their leaf counts: their disc offsets follow the moved leaves. */
  readonly chain: Int32Array;
  readonly chainCount: Float64Array;

  constructor(
    cache: NestedDragCache,
    readonly g: number,
    readonly R: number,
    held: ReadonlySet<number>,
    touched: ReadonlyMap<number, number>,
    positions: ArrayLike<number>,
    discs: BoundaryDiscs,
  ) {
    const { topo } = cache;
    const { childOffset, children, leafCount, parent } = topo;
    const counts = cache.leafCounts();
    const start = childOffset[g]!;
    const end = childOffset[g + 1]!;
    const k = end - start;
    this.k = k;
    this.s.ensure(k, 0);
    this.mode = new Uint8Array(k);
    this.pinned = new Uint8Array(k);
    this.contain = new Uint8Array(k);
    this.hx = new Float64Array(k);
    this.hy = new Float64Array(k);
    this.px = new Float64Array(k);
    this.py = new Float64Array(k);
    this.cnt = new Float64Array(k);
    this.nodeOff = new Uint32Array(k + 1);
    let total = 0;
    for (let i = 0; i < k; i++) total += subtreeSize(topo, children[start + i]!);
    this.nodes = new Uint32Array(total);

    // Each child's subtree (its nodes, leaf sums and size metric), and the module's leaf centroid.
    const size = cache.size;
    const weight = new Float64Array(k);
    const wx = new Float64Array(k); // each child's world centre
    const wy = new Float64Array(k);
    const moduleR = new Float64Array(k).fill(NaN);
    let sx = 0;
    let sy = 0;
    let at = 0;
    const stack: number[] = [];
    for (let i = 0; i < k; i++) {
      const c = children[start + i]!;
      this.nodeOff[i] = at;
      let lx = 0;
      let ly = 0;
      let w = 0;
      stack.push(c);
      while (stack.length) {
        const n = stack.pop()!;
        this.nodes[at++] = n;
        if (n < leafCount) {
          lx += positions[2 * n]!;
          ly += positions[2 * n + 1]!;
          const m = size ? size[n]! : 1;
          w += Number.isFinite(m) && m > 0 ? m : 0;
        } else {
          for (let p = childOffset[n]!; p < childOffset[n + 1]!; p++) stack.push(children[p]!);
        }
      }
      const n = counts[c]!;
      this.cnt[i] = n;
      weight[i] = w;
      sx += lx;
      sy += ly;
      if (c < leafCount) {
        wx[i] = lx;
        wy[i] = ly;
      } else {
        const o = c - leafCount;
        wx[i] = lx / n + discs.dx[o]!;
        wy[i] = ly / n + discs.dy[o]!;
        moduleR[i] = cache.radiusOf(c, discs.r[o]!); // as laid out: a drag may have grown its ring since
      }
      const t = touched.get(c) ?? 0;
      this.mode[i] = held.has(c) ? HELD : t > 0 ? FIXED : FREE;
    }
    this.nodeOff[k] = at;
    const o = g - leafCount;
    const Cx = sx / counts[g]! + discs.dx[o]!;
    const Cy = sy / counts[g]! + discs.dy[o]!;

    let radii = cache.radiiOf(g);
    if (!radii) {
      const dist = new Float64Array(k);
      for (let i = 0; i < k; i++) dist[i] = Math.hypot(wx[i]! - Cx, wy[i]! - Cy);
      radii = childRadii(R, weight, dist, moduleR);
      cache.keepRadii(g, radii);
    }
    const { x, y, vx, vy, rad } = this.s;
    for (let i = 0; i < k; i++) {
      x[i] = (wx[i]! - Cx) / R;
      y[i] = (wy[i]! - Cy) / R;
      vx[i] = 0;
      vy[i] = 0;
      rad[i] = radii[i]! / R;
      this.px[i] = x[i]!;
      this.py[i] = y[i]!;
      this.hx[i] = x[i]!;
      this.hy[i] = y[i]!;
      this.pinned[i] = this.mode[i] === FREE ? 0 : 1;
      // Kept inside the disc: a free child that is inside it now. One an earlier drag left outside is
      // not snapped back; neither is the held one, anywhere the cursor takes it.
      this.contain[i] = this.mode[i] === FREE && Math.hypot(x[i]!, y[i]!) + rad[i]! <= 1 + 1e-6 ? 1 : 0;
    }
    const links = k >= 2 ? moduleLinks(topo, g, start, end, cache.local()) : { la: [], lb: [], lw: [] };
    this.la = links.la;
    this.lb = links.lb;
    this.lw = links.lw;

    const chain: number[] = [];
    for (let a = g; a >= 0; a = parent[a]!) chain.push(a);
    this.chain = Int32Array.from(chain);
    this.chainCount = Float64Array.from(chain, (a) => counts[a]!);
  }

  /** Let the held children go (the pointer is up): they settle with the rest. */
  release(): void {
    for (let i = 0; i < this.k; i++) if (this.mode[i] === HELD) this.pinned[i] = 0;
  }

  /**
   * One tick: the held children to the cursor (a world delta `dx`, `dy` since the grab, anywhere), then
   * gravity, the sibling springs (a pinned end takes none of the correction), the velocity step, collision
   * against every disc, and containment in the disc for the children never held (a released one settles
   * where it was dropped, pulled in only by gravity and its springs).
   */
  step(alpha: number, dx: number, dy: number, holding: boolean): void {
    const { k, s, pinned, mode } = this;
    const { x, y, vx, vy, rad } = s;
    const { PAD, GRAVITY, DECAY } = NESTED;
    if (holding) {
      for (let i = 0; i < k; i++) {
        if (mode[i] !== HELD) continue;
        x[i] = this.hx[i]! + dx / this.R;
        y[i] = this.hy[i]! + dy / this.R;
        vx[i] = 0;
        vy[i] = 0;
      }
    }
    for (let i = 0; i < k; i++) {
      if (pinned[i]) continue;
      vx[i] = vx[i]! - x[i]! * GRAVITY * alpha;
      vy[i] = vy[i]! - y[i]! * GRAVITY * alpha;
    }
    const { la, lb, lw } = this;
    for (let l = 0; l < la.length; l++) {
      const a = la[l]!;
      const b = lb[l]!;
      const pa = pinned[a]!;
      const pb = pinned[b]!;
      if (pa && pb) continue;
      let ex = x[b]! + vx[b]! - x[a]! - vx[a]!;
      let ey = y[b]! + vy[b]! - y[a]! - vy[a]!;
      const d = Math.hypot(ex, ey) || 1e-9;
      const rest = (rad[a]! + rad[b]!) * PAD;
      const f = (Math.max(0, d - rest) / d) * alpha * lw[l]! * 0.5;
      ex *= f;
      ey *= f;
      const ma = rad[a]! * rad[a]!;
      const mb = rad[b]! * rad[b]!;
      const sb = pa ? 1 : pb ? 0 : ma / (ma + mb);
      vx[b] = vx[b]! - ex * sb;
      vy[b] = vy[b]! - ey * sb;
      vx[a] = vx[a]! + ex * (1 - sb);
      vy[a] = vy[a]! + ey * (1 - sb);
    }
    for (let i = 0; i < k; i++) {
      if (pinned[i]) continue;
      vx[i] = vx[i]! * (1 - DECAY);
      vy[i] = vy[i]! * (1 - DECAY);
      x[i] = x[i]! + vx[i]!;
      y[i] = y[i]! + vy[i]!;
    }
    collide(s, k, PAD, pinned);
    for (let i = 0; i < k; i++) {
      if (!this.contain[i]) continue;
      const [cx, cy] = inside(x[i]!, y[i]!, rad[i]!);
      x[i] = cx;
      y[i] = cy;
    }
  }

  /**
   * Write what moved to the world: each child that moved translates every leaf position (and, with
   * `geometry`, every LOD tree node) under it; the module's and its ancestors' disc offsets take back
   * their leaf centroids' shift, so their discs stay where they are. Returns the largest local step.
   */
  apply(positions: Float32Array, geometry: NestedDragGeometry | null, discs: BoundaryDiscs, leafCount: number, stats: NestedDragStats): number {
    const { k, s, R, nodes, nodeOff } = this;
    let shiftX = 0;
    let shiftY = 0;
    let most = 0;
    for (let i = 0; i < k; i++) {
      const lx = s.x[i]! - this.px[i]!;
      const ly = s.y[i]! - this.py[i]!;
      if (lx === 0 && ly === 0) continue;
      most = Math.max(most, Math.hypot(lx, ly));
      this.px[i] = s.x[i]!;
      this.py[i] = s.y[i]!;
      const ux = lx * R;
      const uy = ly * R;
      for (let p = nodeOff[i]!; p < nodeOff[i + 1]!; p++) {
        const n = nodes[p]!;
        if (n < leafCount) {
          positions[2 * n] = positions[2 * n]! + ux;
          positions[2 * n + 1] = positions[2 * n + 1]! + uy;
          stats.leafWrites++;
        }
        if (geometry) {
          geometry.cx[n] = geometry.cx[n]! + ux;
          geometry.cy[n] = geometry.cy[n]! + uy;
          stats.nodeWrites++;
        }
      }
      shiftX += this.cnt[i]! * ux;
      shiftY += this.cnt[i]! * uy;
    }
    if (shiftX !== 0 || shiftY !== 0) {
      for (let c = 0; c < this.chain.length; c++) {
        const o = this.chain[c]! - leafCount;
        const n = this.chainCount[c]!;
        discs.dx[o] = discs.dx[o]! - shiftX / n;
        discs.dy[o] = discs.dy[o]! - shiftY / n;
      }
    }
    // The disc grows about its fixed centre to enclose a member outside it (the held node, or one dropped
    // there), and shrinks back to its laid-out radius as the member returns: O(k), plus O(depth) to widen
    // the ancestors' LOD extents (grow-only — the exact pass after the drag makes them tight again).
    let reach = 1;
    for (let i = 0; i < k; i++) reach = Math.max(reach, Math.hypot(s.x[i]!, s.y[i]!) + s.rad[i]!);
    const r = Math.fround(R * reach);
    const o = this.g - leafCount;
    if (r !== discs.r[o]) {
      discs.r[o] = r;
      if (geometry) {
        const { cx, cy, extent } = geometry;
        extent[this.g] = r;
        for (let c = 1; c < this.chain.length; c++) {
          const a = this.chain[c]!;
          const need = Math.hypot(cx[a]! - cx[this.g]!, cy[a]! - cy[this.g]!) + r;
          if (need > extent[a]!) extent[a] = need;
        }
      }
    }
    return most;
  }
}

/** A local position clamped so a disc of radius `r` stays inside the unit disc. */
function inside(x: number, y: number, r: number): [number, number] {
  const lim = Math.max(0, 1 - r);
  const d = Math.hypot(x, y);
  if (d <= lim) return [x, y];
  if (!(d > 0)) return [0, 0];
  return [(x * lim) / d, (y * lim) / d];
}

/** Tree nodes under `g`, `g` included. */
function subtreeSize(topo: NestedLayoutTopology, g: number): number {
  const { childOffset, children, leafCount } = topo;
  let n = 0;
  const stack = [g];
  while (stack.length) {
    const v = stack.pop()!;
    n++;
    if (v >= leafCount) for (let p = childOffset[v]!; p < childOffset[v + 1]!; p++) stack.push(children[p]!);
  }
  return n;
}

/**
 * One drag's re-solve (see the file header): {@link start} it at the grab, {@link setDelta} on every
 * pointer move, {@link tick} once per animation frame, {@link release} on pointer-up; `tick` returns
 * false once the module has cooled after release.
 */
export class NestedDrag {
  readonly stats: NestedDragStats = { ticks: 0, leafWrites: 0, nodeWrites: 0 };
  private dx = 0;
  private dy = 0;
  private holding = true;
  private cool = 0;
  private alpha = NESTED_DRAG_ALPHA;
  private readonly coolDecay = 1 - Math.pow(NESTED.ALPHA_MIN / NESTED_DRAG_ALPHA, 1 / NESTED_DRAG_COOL_TICKS);
  private leafList: Uint32Array | null = null;

  private constructor(
    private readonly cache: NestedDragCache,
    private readonly discs: BoundaryDiscs,
    /** The re-solved modules. */
    readonly modules: readonly ModuleReheat[],
  ) {}

  /**
   * Start a drag of `heldLeaves` (leaf ids) on the nested map `discs` describes, at `positions`. Null
   * when the held leaves cover the whole map (no parent to re-solve: translate instead) or none.
   */
  static start(cache: NestedDragCache, discs: BoundaryDiscs, positions: ArrayLike<number>, heldLeaves: ArrayLike<number>): NestedDrag | null {
    const { parent, leafCount } = cache.topo;
    const counts = cache.leafCounts();
    // Held leaves under each tree node, along the held leaves' ancestor chains: O(held · depth).
    const touched = new Map<number, number>();
    for (let h = 0; h < heldLeaves.length; h++) {
      const leaf = heldLeaves[h]!;
      if (!(leaf >= 0 && leaf < leafCount)) continue;
      for (let a = leaf; a >= 0; a = parent[a]!) touched.set(a, (touched.get(a) ?? 0) + 1);
    }
    // The held nodes: the largest subtrees whose leaves are all held. Their parents are re-solved.
    const held = new Set<number>();
    for (let h = 0; h < heldLeaves.length; h++) {
      let g = heldLeaves[h]!;
      if (!(g >= 0 && g < leafCount)) continue;
      for (let p = parent[g]!; p >= 0 && touched.get(p) === counts[p]; p = parent[g]!) g = p;
      held.add(g);
    }
    if (held.size === 0) return null;
    const affected = new Set<number>();
    for (const g of held) {
      const p = parent[g]!;
      if (p < 0) return null; // the whole map is held
      affected.add(p);
    }
    const modules: ModuleReheat[] = [];
    for (const g of affected) {
      const R = cache.radiusOf(g, discs.r[g - leafCount]!); // as laid out, not as a drag grew it
      if (!(R > 0)) return null;
      cache.keepRadius(g, R);
      modules.push(new ModuleReheat(cache, g, R, held, touched, positions, discs));
    }
    return new NestedDrag(cache, discs, modules);
  }

  /** Every leaf a tick can move (the leaves under the re-solved modules), built once. */
  get leaves(): Uint32Array {
    if (this.leafList) return this.leafList;
    const { leafCount } = this.cache.topo;
    let n = 0;
    for (const m of this.modules) for (const v of m.nodes) if (v < leafCount) n++;
    const out = new Uint32Array(n);
    let at = 0;
    for (const m of this.modules) for (const v of m.nodes) if (v < leafCount) out[at++] = v;
    this.leafList = out;
    return out;
  }

  /** The cursor's world delta since the grab. */
  setDelta(dx: number, dy: number): void {
    this.dx = dx;
    this.dy = dy;
  }

  /** The pointer is up: let the held nodes go and cool. */
  release(): void {
    if (!this.holding) return;
    this.holding = false;
    for (const m of this.modules) m.release();
  }

  /** Whether the pointer is still down. */
  get held(): boolean {
    return this.holding;
  }

  /**
   * One tick of every re-solved module, written into `positions` (and `geometry`, the module tree's LOD
   * centres, when it is drawn). Returns false once cooled after release (nothing more will move).
   */
  tick(positions: Float32Array, geometry: NestedDragGeometry | null = null): boolean {
    if (!this.holding && this.cool >= NESTED_DRAG_COOL_TICKS) return false;
    const { leafCount } = this.cache.topo;
    let most = 0;
    for (const m of this.modules) {
      m.step(this.alpha, this.dx, this.dy, this.holding);
      most = Math.max(most, m.apply(positions, geometry, this.discs, leafCount, this.stats));
    }
    this.stats.ticks++;
    if (this.holding) return true;
    this.cool++;
    this.alpha -= this.alpha * this.coolDecay;
    if (this.cool >= NESTED_DRAG_COOL_TICKS || (this.cool >= MIN_COOL_TICKS && most < STILL)) {
      this.cool = NESTED_DRAG_COOL_TICKS;
      return false;
    }
    return true;
  }
}
