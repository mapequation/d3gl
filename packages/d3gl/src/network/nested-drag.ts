/**
 * **Nested drag reheat** — a node drag on a map laid out by the nested module layout (`nested-layout.ts`).
 *
 * A flat layout reheats the whole graph around a dragged node. A nested map re-solves, on the main
 * thread, the grabbed item's module and every module above it, up to the root — and only the grabbed item
 * is pinned (under the cursor); everything else responds, and the map stays nested:
 *
 * - **The held item follows the cursor freely.** Its siblings respond around it inside their module's
 *   disc, under the nested layout's own forces at that level.
 * - **Every level reheats.** Each module above the held item runs the same forces over its children —
 *   gravity, the springs over their links (module links and aggregated leaf links, as the layout placed
 *   the level) and collision — so sibling modules follow a moving module by their real flows, all the way
 *   up to the root. Some drift of the modules on a grab is expected, as in a flat reheat.
 * - **Discs follow their members.** Each disc is centred on its children's centroid, as the layout centred
 *   it, and moved on just enough to hold the dragged item past its edge; its radius stays as laid out. The
 *   rings (`lod({ moduleBoundary })`, #329) are the discs, so they move with them; nothing is stretched.
 * - **A sibling module moves as a whole**, with everything inside it — its own layout and ring unchanged.
 * - **A selection** pins its held items (the largest subtrees whose leaves are all held) and re-solves
 *   every module above any of them. A grab of the whole map (the root aggregate): the caller translates.
 *
 * The physics is the nested layout's own, at every level: its compact phase (gravity, the springs over the
 * sibling links it placed the level by — module links and aggregated leaf links — and collision). The heat
 * is the flat drag's: the same {@link Cooling} schedule, held at `DRAG_HEAT` while the pointer is down and
 * cooled from it after release over the caller's re-cool budget, stopping once converged (the item is let
 * go, as on the flat layouts). A tick's alpha is that heat, as a cold nested solve starts at 1. It runs on
 * the main thread for every layout backend and keeps nothing resident after the drag.
 *
 * Cost, per tick: O(k + links) over the re-solved modules' k children (collision on a grid above
 * `EXACT_MAX` children), plus O(nodes under the children that moved this tick) to translate them — with
 * every level reheated, that is the whole map, as a flat drag's reheat moves it. A grab walks the re-solved modules' children once
 * (the root's are the whole map: O(tree size), click-frequency); the leaf counts are built once per layout.
 */
import type { BoundaryDiscs } from "./lod.js";
import { Cooling, DRAG_HEAT, MIN_SETTLE_TICKS } from "./force.js";
import { NESTED, Scratch, collide, moduleLinks, type NestedLayoutTopology } from "./nested-layout.js";

/** The map is converged once no child moved more than this share of its parent's radius in a tick (a
 *  0.01 px step for a module drawn 100 px wide), after `MIN_SETTLE_TICKS` of the schedule. */
const STILL = 1e-4;

/**
 * What drags on one nested layout reuse across grabs: the topology, the size metric it was laid out
 * with, each tree node's leaf count (one O(tree size) pass, on the first grab), a local-index scratch,
 * and each re-solved module's child radii. A module's child radii are recovered from the layout the
 * first time it is grabbed ({@link childRadii}) and kept: once a drag has moved its children, the
 * layout no longer tells them.
 */
export class NestedDragCache {
  private counts: Uint32Array | null = null;
  private localScratch: Int32Array | null = null;
  private readonly radii = new Map<number, Float64Array>();

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
 * The LOD geometry a tick keeps up with the positions: the module tree's `cx` / `cy`, translated with the
 * moved subtrees and the travelling discs. Every disc keeps its radius and holds its children, so no
 * extent changes.
 */
export interface NestedDragGeometry {
  cx: Float32Array;
  cy: Float32Array;
}

const FREE = 0;
const HELD = 1;
/** A child that is itself re-solved one level down: it goes where its own disc goes. */
const DRIVEN = 2;

/** The leaves a tick wrote, for a caller that refits another LOD tree along them. */
interface MovedLeaves {
  buf: Uint32Array;
  n: number;
}

/**
 * One re-solved module: its children in a local frame of the disc as laid out (its radius is 1, its
 * centre the origin, anchored in the world where the disc was at the grab). The disc itself travels: its
 * centre is (`ox`, `oy`) in that frame.
 */
class ModuleReheat {
  readonly k: number;
  readonly s = new Scratch();
  /** The disc's centre in the local frame, now and as last written to the world. */
  ox = 0;
  oy = 0;
  private wox = 0;
  private woy = 0;
  /** FREE, HELD or DRIVEN per child. */
  readonly mode: Uint8Array;
  /** Non-zero where the solve does not move a child this tick (held under the cursor, or driven). */
  readonly pinned: Uint8Array;
  /** Each child's local position at grab. */
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  /** Each child's local position as last written to the world. */
  readonly px: Float64Array;
  readonly py: Float64Array;
  /** Leaves under each child. */
  readonly cnt: Float64Array;
  /** Tree nodes under each child (the child included), listed the first time the child moves. */
  private readonly nodeLists: (Uint32Array | null)[];
  readonly la: readonly number[];
  readonly lb: readonly number[];
  readonly lw: readonly number[];
  /** This module and its ancestors, with their leaf counts: their disc offsets follow the moved leaves. */
  readonly chain: Int32Array;
  readonly chainCount: Float64Array;
  /** The re-solve one level up (null at the root), and this module's index among its children. */
  up: ModuleReheat | null = null;
  indexUp = -1;
  /** Each DRIVEN child's own re-solve, by child index. */
  readonly down: (ModuleReheat | null)[];

  constructor(
    private readonly cache: NestedDragCache,
    readonly g: number,
    readonly R: number,
    held: ReadonlySet<number>,
    affected: ReadonlySet<number>,
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
    this.hx = new Float64Array(k);
    this.hy = new Float64Array(k);
    this.px = new Float64Array(k);
    this.py = new Float64Array(k);
    this.cnt = new Float64Array(k);
    this.nodeLists = new Array<Uint32Array | null>(k).fill(null);
    this.down = new Array<ModuleReheat | null>(k).fill(null);

    // Each child's leaf sums and size metric (one walk of its subtree), and the module's leaf centroid.
    const size = cache.size;
    const weight = new Float64Array(k);
    const wx = new Float64Array(k); // each child's world centre
    const wy = new Float64Array(k);
    const moduleR = new Float64Array(k).fill(NaN);
    let sx = 0;
    let sy = 0;
    const stack: number[] = [];
    for (let i = 0; i < k; i++) {
      const c = children[start + i]!;
      let lx = 0;
      let ly = 0;
      let w = 0;
      stack.push(c);
      while (stack.length) {
        const n = stack.pop()!;
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
        moduleR[i] = discs.r[o]!;
      }
      this.mode[i] = held.has(c) ? HELD : affected.has(c) ? DRIVEN : FREE;
    }
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

  /** Child `i`'s subtree, listed on first use: O(its nodes), once per drag. */
  private nodesOf(i: number): Uint32Array {
    const cached = this.nodeLists[i];
    if (cached) return cached;
    const { childOffset, children, leafCount } = this.cache.topo;
    const c = children[childOffset[this.g]! + i]!;
    const out: number[] = [];
    const stack = [c];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      if (n >= leafCount) for (let p = childOffset[n]!; p < childOffset[n + 1]!; p++) stack.push(children[p]!);
    }
    const list = Uint32Array.from(out);
    this.nodeLists[i] = list;
    return list;
  }

  /** Let the held children go (the pointer is up): they settle with the rest. */
  release(): void {
    for (let i = 0; i < this.k; i++) if (this.mode[i] === HELD) this.pinned[i] = 0;
  }

  /** The children's centroid weighted by disc area — where the layout centred the disc on them. O(k). */
  private centroid(): [number, number] {
    const { x, y, rad } = this.s;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let i = 0; i < this.k; i++) {
      const w = rad[i]! * rad[i]!;
      sx += x[i]! * w;
      sy += y[i]! * w;
      sw += w;
    }
    return sw > 0 ? [sx / sw, sy / sw] : [this.ox, this.oy];
  }

  /** A pinned child at local (x, y) past the disc's edge carries the disc's centre along until it is inside. */
  private carry(x: number, y: number, r: number): void {
    const ex = x - this.ox;
    const ey = y - this.oy;
    const d = Math.hypot(ex, ey);
    const lim = Math.max(0, 1 - r);
    if (d > lim) {
      const t = (d - lim) / d;
      this.ox += ex * t;
      this.oy += ey * t;
    }
  }

  /**
   * One tick, after every re-solve below it has stepped: the held children to the cursor (a world delta
   * `dx`, `dy` since the grab, anywhere) and each driven child to where its own disc went; then the nested
   * layout's own compact forces on every other child — gravity toward the children's centroid, the springs over
   * its sibling links (the module links and aggregated leaf links it placed this level by; a pinned end
   * takes none of the correction), the velocity step and collision. The disc is then centred on its
   * children's centroid (as the layout centred it), moved on just enough to hold a pinned child past its
   * edge, and the free children are kept inside it.
   */
  step(alpha: number, dx: number, dy: number, holding: boolean): void {
    const { k, s, pinned, mode } = this;
    const { x, y, vx, vy, rad } = s;
    const { PAD, GRAVITY, DECAY } = NESTED;
    for (let i = 0; i < k; i++) {
      const m = mode[i];
      if (m === HELD && holding) {
        x[i] = this.hx[i]! + dx / this.R;
        y[i] = this.hy[i]! + dy / this.R;
      } else if (m === DRIVEN) {
        const d = this.down[i]!;
        x[i] = this.hx[i]! + (d.ox * d.R) / this.R;
        y[i] = this.hy[i]! + (d.oy * d.R) / this.R;
      } else continue;
      vx[i] = 0;
      vy[i] = 0;
    }
    // Gravity toward the children's own centroid: it holds the module together without dragging it anywhere.
    const [gx, gy] = this.centroid();
    for (let i = 0; i < k; i++) {
      if (pinned[i]) continue;
      vx[i] = vx[i]! - (x[i]! - gx) * GRAVITY * alpha;
      vy[i] = vy[i]! - (y[i]! - gy) * GRAVITY * alpha;
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
    // The disc follows its members: centred on their centroid, as the layout centred it, and moved on from
    // there just enough to hold a pinned child that is past its edge.
    [this.ox, this.oy] = this.centroid();
    // A held child still carries the disc once released, so nothing snaps: gravity draws it back in.
    for (let i = 0; i < k; i++) if (pinned[i] || mode[i] === HELD) this.carry(x[i]!, y[i]!, rad[i]!);
    const cox = this.ox;
    const coy = this.oy;
    for (let i = 0; i < k; i++) {
      if (pinned[i] || mode[i] === HELD) continue;
      const [cx, cy] = inside(x[i]! - cox, y[i]! - coy, rad[i]!);
      x[i] = cox + cx;
      y[i] = coy + cy;
    }
  }

  /**
   * Write what moved to the world: each held or free child that moved translates every leaf position (and,
   * with `geometry`, every LOD tree node) under it — a driven child's own re-solve writes its subtree; the
   * module's disc offset and LOD centre follow its travelling centre, and every ancestor's disc offset
   * takes back its leaf centroid's shift (each ancestor's own re-solve moves its disc). Returns the largest
   * local step.
   */
  apply(positions: Float32Array, geometry: NestedDragGeometry | null, discs: BoundaryDiscs, moved: MovedLeaves, stats: NestedDragStats): number {
    const { k, s, R } = this;
    const { leafCount } = this.cache.topo;
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
      if (this.mode[i] === DRIVEN) continue;
      const ux = lx * R;
      const uy = ly * R;
      const nodes = this.nodesOf(i);
      for (let p = 0; p < nodes.length; p++) {
        const n = nodes[p]!;
        if (n < leafCount) {
          positions[2 * n] = positions[2 * n]! + ux;
          positions[2 * n + 1] = positions[2 * n + 1]! + uy;
          if (moved.n === moved.buf.length) {
            const grown = new Uint32Array(Math.max(1024, 2 * moved.buf.length));
            grown.set(moved.buf);
            moved.buf = grown;
          }
          moved.buf[moved.n++] = n;
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
    const mx = (this.ox - this.wox) * R;
    const my = (this.oy - this.woy) * R;
    this.wox = this.ox;
    this.woy = this.oy;
    if (shiftX !== 0 || shiftY !== 0 || mx !== 0 || my !== 0) {
      for (let c = 0; c < this.chain.length; c++) {
        const o = this.chain[c]! - leafCount;
        const n = this.chainCount[c]!;
        discs.dx[o] = discs.dx[o]! - shiftX / n + (c === 0 ? mx : 0);
        discs.dy[o] = discs.dy[o]! - shiftY / n + (c === 0 ? my : 0);
      }
    }
    if (geometry && (mx !== 0 || my !== 0)) {
      geometry.cx[this.g] = geometry.cx[this.g]! + mx;
      geometry.cy[this.g] = geometry.cy[this.g]! + my;
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

/**
 * One drag's re-solve (see the file header): {@link start} it at the grab, {@link setDelta} on every
 * pointer move, {@link tick} once per animation frame, {@link release} on pointer-up — the same protocol as
 * the flat drag's {@link ForceLayout} (`tick`, `converged`), so the engine runs both in one drag loop.
 */
export class NestedDrag {
  readonly stats: NestedDragStats = { ticks: 0, leafWrites: 0, nodeWrites: 0 };
  private dx = 0;
  private dy = 0;
  private holding = true;
  /** The flat drag's heat schedule: held at `DRAG_HEAT` while dragging, cooled from it after release. */
  private readonly cooling = new Cooling();
  private settleTicks = 0;
  private still = false;
  private readonly moved: MovedLeaves = { buf: new Uint32Array(0), n: 0 };

  private constructor(
    private readonly discs: BoundaryDiscs,
    /** The re-solved modules, deepest first (each after every re-solve below it). */
    readonly modules: readonly ModuleReheat[],
  ) {
    this.cooling.hold(DRAG_HEAT);
  }

  /**
   * Start a drag of `heldLeaves` (leaf ids) on the nested map `discs` describes, at `positions`. Null
   * when the held leaves cover the whole map (nothing around it to re-solve: translate instead) or none.
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
    // The held nodes: the largest subtrees whose leaves are all held — the only things pinned. Every
    // module above one of them is re-solved around it, up to the root.
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
      if (parent[g]! < 0) return null; // the whole map is held
      for (let a = parent[g]!; a >= 0 && !affected.has(a); a = parent[a]!) affected.add(a);
    }
    const byId = new Map<number, ModuleReheat>();
    for (const g of affected) {
      const R = discs.r[g - leafCount]!;
      if (!(R > 0)) return null;
      byId.set(g, new ModuleReheat(cache, g, R, held, affected, positions, discs));
    }
    const { childOffset } = cache.topo;
    for (const m of byId.values()) {
      const up = byId.get(parent[m.g]!) ?? null;
      if (!up) continue;
      m.up = up;
      m.indexUp = cache.topo.children.subarray(childOffset[up.g]!, childOffset[up.g + 1]!).indexOf(m.g);
      up.down[m.indexUp] = m;
    }
    const modules = [...byId.values()].sort((a, b) => b.chain.length - a.chain.length);
    return new NestedDrag(discs, modules);
  }

  /** The leaves the last tick moved, for a caller that refits another LOD tree along them. */
  get movedLeaves(): Uint32Array {
    return this.moved.buf.subarray(0, this.moved.n);
  }

  /** The cursor's world delta since the grab. */
  setDelta(dx: number, dy: number): void {
    this.dx = dx;
    this.dy = dy;
  }

  /** The pointer is up: let the held nodes go and cool from the drag heat over `ticks` (the flat drag's). */
  release(ticks: number): void {
    if (!this.holding) return;
    this.holding = false;
    for (const m of this.modules) m.release();
    this.cooling.cool(ticks, DRAG_HEAT);
    this.settleTicks = 0;
  }

  /** Whether the map has come to rest after release: nothing moved more than {@link STILL} in a tick. */
  get converged(): boolean {
    return !this.holding && this.still;
  }

  /** Whether the pointer is still down. */
  get held(): boolean {
    return this.holding;
  }

  /**
   * One tick of every re-solved module, deepest first, at the schedule's heat, written into `positions`
   * (and `geometry`, the module tree's LOD centres, when it is drawn).
   */
  tick(positions: Float32Array, geometry: NestedDragGeometry | null = null): void {
    this.moved.n = 0;
    const alpha = this.cooling.heat;
    for (const m of this.modules) m.step(alpha, this.dx, this.dy, this.holding);
    let most = 0;
    for (const m of this.modules) most = Math.max(most, m.apply(positions, geometry, this.discs, this.moved, this.stats));
    this.stats.ticks++;
    this.cooling.next();
    this.settleTicks++;
    this.still = this.settleTicks >= MIN_SETTLE_TICKS && most < STILL;
  }
}
