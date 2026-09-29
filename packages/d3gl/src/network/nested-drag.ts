/**
 * **Nested drag reheat** — a node drag on a map laid out by the nested module layout (`nested-layout.ts`).
 *
 * A flat layout reheats the whole graph around a dragged node. A nested map re-solves, on the main
 * thread, the grabbed item's module and every module above it, up to the root — and only the grabbed item
 * is pinned (under the cursor); everything else responds, and the map stays nested:
 *
 * - **The held item follows the cursor freely.** Its siblings respond around it, and so does every level
 *   above, up to the root.
 * - **Soft forces, like a flat drag's.** Each level runs the nested layout's ORGANISE-phase many-body
 *   repulsion (a share of it), gravity (the only thing holding a module together) and two-sided springs
 *   over its links — module links and aggregated leaf links, by `√flow` — at their laid-out length, plus a
 *   soft overlap push: discs can approach and press together a little, then ease apart. The laid-out map
 *   is the rest state (each level's field forces at the grab are taken back off), so the grab moves nothing
 *   by itself and every force answers the drag. On release the rest state is re-taken where things are, so
 *   a dropped item stays where it was dropped.
 * - **The root is the map's one anchor**, as a flat layout's centering: its gravity pulls toward where its
 *   free children were. Below it, a module's gravity pulls toward its free children's own centroid, so a
 *   module travels with the member that is dragged.
 * - **Discs follow their members.** A disc is centred on its children's centroid, its radius the larger of
 *   the laid-out one and their extent. The rings (`lod({ moduleBoundary })`, #329) are the discs.
 * - **A sibling module moves as a whole**, with everything inside it — its own layout and ring unchanged.
 * - **A selection** pins its held items (the largest subtrees whose leaves are all held) and re-solves
 *   every module above any of them. A grab of the whole map (the root aggregate): the caller translates.
 *
 * The heat is the flat drag's: the same {@link Cooling} schedule, held at `DRAG_HEAT` while the pointer is
 * down and cooled from it after release over the caller's re-cool budget, stopping once converged. A
 * tick's alpha is that heat, as a cold nested solve starts at 1. It runs on the main thread for every
 * layout backend and keeps nothing resident after the drag.
 *
 * Cost, per tick: O(k + links) over the re-solved modules' k children (collision on a grid above
 * `EXACT_MAX` children), plus O(nodes under the children that moved this tick) to translate them — with
 * every level reheated, that is the whole map, as a flat drag's reheat moves it. A grab walks the re-solved modules' children once
 * (the root's are the whole map: O(tree size), click-frequency); the leaf counts are built once per layout.
 */
import type { BoundaryDiscs } from "./lod.js";
import { Cooling, DRAG_HEAT, MIN_SETTLE_TICKS } from "./force.js";
import { NESTED, Scratch, collide, moduleLinks, repel, type NestedLayoutTopology } from "./nested-layout.js";

/** The map is converged once no child moved more than this share of its parent's radius in a tick (a
 *  0.01 px step for a module drawn 100 px wide), after `MIN_SETTLE_TICKS` of the schedule. */
const STILL = 1e-4;
/** The drag's spring factor on `alpha · √(flow / max flow) · stretch`: the nested layout's own. */
const SPRING = 0.05;
/** Share of an overlap the drag resolves per tick: discs may press together a little, then ease apart. */
const SOFT_OVERLAP = 0.1;
/**
 * The ORGANISE phase's repulsion, as a share for the drag. Against gravity it sets how far a module is
 * pushed by a neighbour that moves (the displacement is the change in repulsion over the gravity, whatever
 * the heat): at the layout's full strength a moved module shoved every other ~0.3-0.7 of the root's radius.
 */
const DRAG_REPULSION = 0.05;

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
  extent: Float32Array;
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
  /** The disc's radius over its laid-out one: ≥ 1, the members' extent from the centre when larger. */
  reach = 1;
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
  /** Each link's rest length: its length at the grab. */
  readonly rest: Float64Array;
  /**
   * Each child's repulsion + gravity at the grab, at unit heat. The laid-out map is the drag's rest state:
   * each tick takes this back off (times the heat), so the grab moves nothing on its own and every force
   * answers the drag — as a flat drag's layout, already at its equilibrium, does.
   */
  private readonly biasX: Float64Array;
  /**
   * The root's gravity pulls toward where its free children's centroid was at the grab, as a flat layout's
   * centering holds the map in place: the one anchor the map has. Below the root, gravity pulls toward the
   * free children's own centroid, so a module travels with the member that is dragged. Without the anchor,
   * the whole map follows a dragged top module as one rigid piece and no link ever stretches.
   */
  anchor: [number, number] | null = null;

  /** Anchor this module's gravity where its free children are now (the root's; see {@link anchor}). */
  anchorHere(): void {
    this.anchor = this.centroid(true);
  }
  private readonly biasY: Float64Array;
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
    // The springs: this level's links weighted by √(flow / max flow) alone — the strongest the stiffest,
    // none stiffened or softened by degree — at their laid-out length, the level's equilibrium spacing.
    const links = k >= 2 ? moduleLinks(topo, g, start, end, cache.local(), false) : { la: [], lb: [], lw: [] };
    this.rest = new Float64Array(links.la.length);
    this.la = links.la;
    this.lb = links.lb;
    this.lw = links.lw;
    this.biasX = new Float64Array(k);
    this.biasY = new Float64Array(k);
    this.restHere();

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
    this.restHere();
  }

  /**
   * Make where the children are now the rest state (at the grab, and again on release): each link's rest
   * length its length now, and the field forces now the bias taken back off. On release that keeps a
   * dropped item where it was dropped — the map eases to rest from there instead of springing back.
   */
  private restHere(): void {
    const { k, s, la, lb, rest } = this;
    const { x, y, vx, vy } = s;
    for (let l = 0; l < la.length; l++) rest[l] = Math.hypot(x[lb[l]!]! - x[la[l]!]!, y[lb[l]!]! - y[la[l]!]!);
    const keepX = Float64Array.from(vx.subarray(0, k));
    const keepY = Float64Array.from(vy.subarray(0, k));
    vx.fill(0, 0, k);
    vy.fill(0, 0, k);
    this.fieldForces(1);
    for (let i = 0; i < k; i++) {
      this.biasX[i] = vx[i]!;
      this.biasY[i] = vy[i]!;
      vx[i] = keepX[i]!;
      vy[i] = keepY[i]!;
    }
  }

  /**
   * The children's centroid weighted by disc area — where the layout centred the disc on them — or, with
   * `free`, the unpinned children's only. O(k).
   */
  private centroid(free = false): [number, number] {
    const { x, y, rad } = this.s;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let i = 0; i < this.k; i++) {
      if (free && this.pinned[i]) continue;
      const w = rad[i]! * rad[i]!;
      sx += x[i]! * w;
      sy += y[i]! * w;
      sw += w;
    }
    return sw > 0 ? [sx / sw, sy / sw] : [this.ox, this.oy];
  }

  /**
   * Add the ORGANISE phase's many-body repulsion and gravity toward the free children's centroid, at
   * `alpha`. Gravity leaves the dragged child out of its centre: toward the centroid of every child, a
   * dragged heavy module would draw the whole level after it as one rigid piece.
   */
  private fieldForces(alpha: number): void {
    const { k, s } = this;
    const { x, y, vx, vy } = s;
    if (k > 1) repel(s, k, ((NESTED.REPULSION_K * DRAG_REPULSION) / k) * alpha);
    const [gx, gy] = this.anchor ?? this.centroid(true);
    for (let i = 0; i < k; i++) {
      vx[i] = vx[i]! - (x[i]! - gx) * NESTED.GRAVITY * alpha;
      vy[i] = vy[i]! - (y[i]! - gy) * NESTED.GRAVITY * alpha;
    }
  }

  /**
   * One tick, after every re-solve below it has stepped: the held children to the cursor (a world delta
   * `dx`, `dy` since the grab, anywhere) and each driven child to where its own disc went; then soft forces
   * on every other child, as a flat drag's are — the nested layout's ORGANISE-phase many-body repulsion
   * (`REPULSION_K / k`), gravity toward the children's centroid (all that holds a module together), and
   * two-sided springs over the level's links at their laid-out length — the velocity step, and a soft
   * overlap push that lets discs approach and ease apart instead of stopping dead. The disc then follows
   * its members: centred on their centroid, its radius the larger of the laid-out one and their extent.
   */
  step(alpha: number, dx: number, dy: number, holding: boolean): void {
    const { k, s, pinned, mode } = this;
    const { x, y, vx, vy, rad } = s;
    const { PAD, DECAY } = NESTED;
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
    }
    this.fieldForces(alpha);
    for (let i = 0; i < k; i++) {
      if (pinned[i]) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      vx[i] = vx[i]! - this.biasX[i]! * alpha;
      vy[i] = vy[i]! - this.biasY[i]! * alpha;
    }
    const { la, lb, lw, rest } = this;
    for (let l = 0; l < la.length; l++) {
      const a = la[l]!;
      const b = lb[l]!;
      const pa = pinned[a]!;
      const pb = pinned[b]!;
      if (pa && pb) continue;
      let ex = x[b]! + vx[b]! - x[a]! - vx[a]!;
      let ey = y[b]! + vy[b]! - y[a]! - vy[a]!;
      const d = Math.hypot(ex, ey) || 1e-9;
      const f = ((d - rest[l]!) / d) * alpha * lw[l]! * SPRING;
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
    collide(s, k, PAD, pinned, SOFT_OVERLAP);
    [this.ox, this.oy] = this.centroid();
    let reach = 1;
    for (let i = 0; i < k; i++) {
      // A driven child's disc may itself have grown to its members' extent.
      const d = mode[i] === DRIVEN ? this.down[i]! : null;
      const r = d ? (d.R * d.reach) / this.R : rad[i]!;
      reach = Math.max(reach, Math.hypot(x[i]! - this.ox, y[i]! - this.oy) + r);
    }
    this.reach = reach;
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
    // The disc (and its ring) encloses its members: the laid-out radius, or their extent when larger.
    const r = Math.fround(R * this.reach);
    const o = this.g - leafCount;
    if (discs.r[o] !== r) {
      discs.r[o] = r;
      if (geometry) geometry.extent[this.g] = r;
    }
    return most;
  }
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
    for (const m of byId.values()) if (!m.up && parent[m.g]! < 0) m.anchorHere();
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
