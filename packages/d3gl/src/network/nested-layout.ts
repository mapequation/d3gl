/**
 * **Nested module layout** — the "map of modules" placement of the old Network Navigator.
 *
 * A provided module hierarchy (an {@link LODTopology} from {@link buildModuleLODTree}) is laid out
 * **top-down**: each module's children are placed inside the module's own disc, arranged by a small
 * force solve over **only their sibling links** (the super-edges between them — for an Infomap `.ftree`
 * exactly the rows of that module's `*Links` section, #199). Children are discs whose area is their
 * share of the parent's size metric (flow, or leaf count), kept apart by collision and pulled together
 * by their links; the result is scaled into the parent's disc and the recursion continues inside each
 * child. Leaves take their disc centre as their position.
 *
 * Compared with one global force layout over the leaves, this (a) uses exactly the links the hierarchy
 * has at each level — no leaf links need to exist between modules, (b) keeps every module a compact
 * region inside its parent at every zoom level, so the LOD cut opens on the top modules and expands
 * in place, and (c) is final per depth — deeper levels only move within their parent's disc — so a
 * streamed layout never oscillates.
 *
 * A **warm start** (`initial`, #328) re-lays a map out from where its nodes already are — e.g. after
 * a re-clustering: each module's children are seeded at their current leaf centroids instead of the
 * spiral, the solve starts cooler so it refines that arrangement, and the result is placed over the
 * current map (same leaf centroid and spread), so the new map lands where the old one was. Placed by
 * its **seed** instead (`placeBy: "seed"`, #454), the placement is known before any module is solved, so
 * a warm start streams too: a first frame of the whole seed, then one per depth, each with the modules
 * not solved yet kept at their seeded arrangement inside their placed parent's disc.
 *
 * Cost: each module solves its `k` children for `iterations` ticks at O(k + sibling links) per tick
 * (exact O(k²) repulsion/collision up to 32 children, Barnes-Hut / a uniform grid above), so the whole layout is O(Σ_modules
 * (k + links) · iterations) ≈ O((leaves + modules + super-edges) · iterations) — one-shot, never
 * per frame. Memory is O(tree size) for disc centres/radii plus per-module scratch of O(max k); a warm
 * start adds O(tree size) for the current centroids and one O(leaves) pass to place the result.
 */
import type { FitBox } from "./fit.js";
import type { BoundaryDiscs, LODTopology } from "./lod.js";
import { BarnesHutTree } from "./quadtree.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/**
 * Starting alpha of a warm-seeded module solve (#328); a cold solve starts at 1. At 0.1 a warm start
 * from a map's own nested layout moves leaves ~2-4% of the root radius and repeated warm starts
 * converge (each moves less than the last); at 0.3 they moved twice as far and kept drifting.
 */
export const WARM_ALPHA = 0.1;
/** Share of the cold spiral kept in a warm seed — splits coincident children deterministically. */
const WARM_SPIRAL = 0.01;

/**
 * The module solve's constants — shared with the batched GPU port (`gpu/gpu-nested-layout.ts`, #355), so
 * both run the same physics. Local coordinates are the unit disc (the parent's radius is 1).
 */
export const NESTED = {
  /** Collision spacing, as a factor on the radius sum. */
  PAD: 1.15,
  /** Pull toward the local origin, per unit of distance and alpha. */
  GRAVITY: 0.08,
  /** Many-body repulsion is `REPULSION_K / k` for k siblings: unlinked siblings spread to ≈ the unit disc. */
  REPULSION_K: 0.04,
  /** Velocity decay per tick: the velocity is multiplied by `1 − DECAY`. */
  DECAY: 0.4,
  /** Share of the ticks in the ORGANISE phase (repulsion); the rest COMPACT (collision). */
  ORGANISE: 0.6,
  /** Alpha at the last tick; alpha decays geometrically from its start (1, or {@link WARM_ALPHA}) to it. */
  ALPHA_MIN: 0.001,
  /** A module's children fill `0.92` of its disc after the solve (the enclosing circle is scaled to it). */
  FILL: 0.92,
  /** A lone child takes `0.9` of its parent's disc, at its centre. */
  ONLY_CHILD: 0.9,
} as const;

/**
 * The per-tick alpha decay of a `ticks`-tick module solve starting at `alpha0`: `alpha -= alpha · decay`
 * after every tick takes it from `alpha0` to {@link NESTED.ALPHA_MIN} (the CPU solve's float64 recurrence,
 * which the GPU port replays on the CPU and passes as a uniform).
 */
export function nestedAlphaDecay(alpha0: number, ticks: number): number {
  return 1 - Math.pow(NESTED.ALPHA_MIN / alpha0, 1 / ticks);
}

/** The topology fields the nested layout reads — a module tree with (optional) super-edges. */
export type NestedLayoutTopology = Pick<LODTopology, "size" | "leafCount" | "childOffset" | "children"> & {
  /** Parent global id per tree node (root: -1) — always present on a provided module tree. */
  parent: Int32Array;
} & Partial<Pick<LODTopology, "superEdgeOffset" | "superEdgeTarget" | "superEdgeFlow">>;

export interface NestedLayoutOptions {
  /**
   * Per-leaf size metric (length `leafCount`, e.g. node flow). A disc's area is its subtree's summed
   * metric relative to its siblings'. Default: 1 per leaf (discs sized by leaf count).
   */
  size?: ArrayLike<number>;
  /** Radius of the root disc, in world units. Default `10·√leafCount`. */
  radius?: number;
  /** Force ticks per module solve. Default 100. */
  iterations?: number;
  /**
   * Fraction of a parent disc's area its children's discs cover (before collision padding). Lower
   * leaves more room between siblings for their links. Default 0.45.
   */
  packing?: number;
  /**
   * Called after every depth is final, with the leaf positions so far — leaves below the finished
   * depth sit at their deepest placed ancestor's centre. Lets a caller stream the layout top-down.
   * Not called on a warm start (`initial`) placed by its result (the default {@link placeBy}): its
   * placement is final only once every depth is, and collapsing leaves onto their module centres is what
   * a warm start exists to avoid. A warm start placed by its seed streams instead (#454): first depth 0,
   * the whole seed, then each depth, with the leaves below it where their seeded modules put them.
   *
   * `bounds` is a box the **final** layout lies in, known already (#427): the placed leaves, and the
   * disc of each unplaced leaf's deepest placed ancestor. Every child disc lies inside its parent's, so
   * it only shrinks depth by depth — the first depth's lies inside the root disc
   * ({@link nestedRootBounds}), the bound known before any depth — and once every leaf is placed it is
   * their exact box: what a streaming fit frames a cold nested layout by.
   */
  onDepth?: (depth: number, positions: Float32Array, bounds: FitBox) => void;
  /**
   * **Warm start** (#328): the current leaf positions, interleaved `[x, y, …]` (length `2 · leafCount`),
   * e.g. the layout before a re-clustering. Each module's children are seeded at their current leaf
   * centroids — relative to the module's own, scaled into its disc — instead of the golden spiral, and
   * the solve starts cooler, so it refines the current arrangement rather than replacing it. The result
   * keeps the map where it is: its leaves get the same centroid as `initial` and, unless `radius` is
   * given, the same RMS spread around it (so a warm start from a nested layout neither drifts nor
   * shrinks over repeated re-clusters). Non-finite entries count as unknown. A module whose children's
   * offsets are unknown or all coincide is seeded cold, so an all-coincident `initial` (e.g. the zeros
   * of a graph never laid out) gives exactly the cold layout.
   */
  initial?: ArrayLike<number>;
  /**
   * How a warm start keeps the map where it is (#454): `"result"` (default) places the solved layout
   * over `initial` — exactly its centroid and spread, known only once every depth is solved; `"seed"`
   * places the root disc so that the **seed** — every module's children at their warm seed, mapped into
   * their discs as the solve maps its result — has `initial`'s centroid and spread (the spread unless
   * `radius` is given). Known before any module is solved, so every depth's frame is placed alike and a
   * warm start can stream ({@link onDepth}). The solve then keeps the root disc, so the result's centroid
   * and spread are the seed's moved by the solve (from a nested map of the same modules the seed is that
   * map, and they barely move). Costs one extra O(tree size) seed pass. Ignored on a cold start.
   */
  placeBy?: "result" | "seed";
}

/** The serialisable subset of {@link NestedLayoutOptions} (no callback) — what the worker receives. */
export type NestedLayoutParams = Omit<NestedLayoutOptions, "onDepth" | "size" | "initial"> & {
  size?: Float32Array;
  initial?: Float32Array;
};

/** Leaf positions plus every tree node's disc (centre + radius), all in world units. */
export interface NestedLayoutResult {
  /** Interleaved `[x, y, …]` per leaf, length `2 · leafCount`. */
  positions: Float32Array;
  /** Disc centre x/y and radius per tree node (global id), length `size` each. */
  cx: Float32Array;
  cy: Float32Array;
  r: Float32Array;
}

/**
 * Reusable per-solve scratch, grown to the largest module's child count. Exported (with {@link collide}) for
 * the collision tests only; the package API (`network/index.ts`) does not re-export it.
 */
export class Scratch {
  x = new Float64Array(0);
  y = new Float64Array(0);
  vx = new Float64Array(0);
  vy = new Float64Array(0);
  rad = new Float64Array(0);
  local = new Int32Array(0); // global id → local index (only valid for the current module's children)
  cell = new Int32Array(0);
  next = new Int32Array(0);
  // Barnes-Hut repulsion for large modules, in a ×BH_SCALE frame (see repel()).
  bh = new BarnesHutTree();
  pos32 = new Float32Array(0);
  fx = new Float32Array(0);
  fy = new Float32Array(0);
  ensure(k: number, size: number): void {
    if (this.x.length < k) {
      const cap = Math.max(k, this.x.length * 2);
      this.x = new Float64Array(cap);
      this.y = new Float64Array(cap);
      this.vx = new Float64Array(cap);
      this.vy = new Float64Array(cap);
      this.rad = new Float64Array(cap);
      this.next = new Int32Array(cap);
      this.pos32 = new Float32Array(2 * cap);
      this.fx = new Float32Array(cap);
      this.fy = new Float32Array(cap);
    }
    if (this.local.length < size) this.local = new Int32Array(size).fill(-1);
  }
}

/**
 * The current layout a warm start refines (#328): every tree node's leaf centroid (over the leaves with
 * finite `initial` coordinates, `known` of them), plus the root's centroid and RMS leaf spread.
 */
export interface WarmStart {
  ox: Float64Array;
  oy: Float64Array;
  known: Float64Array;
  /** RMS distance of the known leaves from the root centroid (`ox[root]`, `oy[root]`); > 0. */
  spread: number;
}

/**
 * Leaf centroids bottom-up (children have lower ids than their parents, so one ascending pass sums
 * every subtree) and the root's RMS spread. O(tree size + leaves). Null when no leaf is known or they
 * all coincide — nothing to refine, so the layout runs cold.
 */
export function warmStart(topo: NestedLayoutTopology, initial: ArrayLike<number>, root: number): WarmStart | null {
  const { size, leafCount, parent } = topo;
  const ox = new Float64Array(size);
  const oy = new Float64Array(size);
  const known = new Float64Array(size);
  for (let i = 0; i < leafCount; i++) {
    const x = initial[2 * i];
    const y = initial[2 * i + 1];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    ox[i] = x;
    oy[i] = y;
    known[i] = 1;
  }
  for (let g = 0; g < size; g++) {
    const w = known[g]!;
    if (g >= leafCount && w > 0) {
      ox[g] = ox[g]! / w; // g's children are all summed in by now: turn its sums into a mean
      oy[g] = oy[g]! / w;
    }
    const p = parent[g]!;
    if (p < 0) continue;
    ox[p] = ox[p]! + ox[g]! * w;
    oy[p] = oy[p]! + oy[g]! * w;
    known[p] = known[p]! + w;
  }
  const n = known[root]!;
  if (!(n > 0)) return null;
  let ss = 0;
  for (let i = 0; i < leafCount; i++) {
    if (!known[i]) continue;
    ss += (ox[i]! - ox[root]!) ** 2 + (oy[i]! - oy[root]!) ** 2;
  }
  const spread = Math.sqrt(ss / n);
  return spread > 0 ? { ox, oy, known, spread } : null;
}

/**
 * Every tree node's subtree size metric, bottom-up (children have lower ids than their parents): a
 * leaf's `size` entry (1 each without one; non-finite or negative counts as 0), a module the sum of its
 * children's. Also finds the root module. O(tree size). Throws when the topology has no root module.
 */
export function subtreeWeights(
  topo: Pick<NestedLayoutTopology, "size" | "leafCount" | "parent">,
  size: ArrayLike<number> | undefined,
): { weight: Float64Array; root: number } {
  const { leafCount, parent } = topo;
  const weight = new Float64Array(topo.size);
  for (let i = 0; i < leafCount; i++) {
    const w = size ? size[i]! : 1;
    weight[i] = Number.isFinite(w) && w > 0 ? w : 0;
  }
  let root = -1;
  for (let g = 0; g < topo.size; g++) {
    const p = parent[g]!;
    if (p >= 0) weight[p] = weight[p]! + weight[g]!;
    else if (g >= leafCount) root = g;
  }
  if (root < 0) throw new Error("nestedLayout: the topology has no root module");
  return { weight, root };
}

/** The root disc's radius: `radius`, else the default `10·√leafCount`. */
function rootRadius(leafCount: number, radius: number | undefined): number {
  return radius ?? 10 * Math.sqrt(leafCount);
}

/**
 * The box a cold nested layout's final positions lie in before any depth is placed (#427): its root disc,
 * centred on the origin, for a `radius` as in {@link NestedLayoutOptions.radius}. A transport streaming the
 * layout posts it as the stream's first bound, so a fit frames the map from its first paint; each depth's
 * `onDepth` bound lies inside it. O(1).
 */
export function nestedRootBounds(leafCount: number, radius?: number): FitBox {
  const r = rootRadius(leafCount, radius);
  return [-r, -r, r, r];
}

/** Lay out a module tree top-down, each module's children inside its disc. @see the module docs above. */
export function nestedLayout(topo: NestedLayoutTopology, opts: NestedLayoutOptions = {}): NestedLayoutResult {
  const { size, leafCount, childOffset, children, parent } = topo;
  const iterations = Math.max(1, opts.iterations ?? 100);
  const packing = opts.packing ?? 0.45;

  const { weight, root } = subtreeWeights(topo, opts.size);
  const warm = opts.initial ? warmStart(topo, opts.initial, root) : null;

  const cx = new Float32Array(size);
  const cy = new Float32Array(size);
  const r = new Float32Array(size);
  r[root] = rootRadius(leafCount, opts.radius);

  const positions = new Float32Array(2 * leafCount);
  const scratch = new Scratch();

  // A warm start placed by its seed (#454): the seed's discs first, the root disc placed by them, and — when
  // streamed — a frame of the whole seed before any module is solved.
  const seed = warm && opts.placeBy === "seed" ? new SeededFrames(size, warmSeedDiscs(topo, weight, packing, scratch, warm)) : null;
  if (seed && warm) {
    const disc = seed.rootDisc(topo, root, r[root]!, warm, opts.radius === undefined, positions);
    cx[root] = disc.x;
    cy[root] = disc.y;
    r[root] = disc.radius;
  }
  const streams = opts.onDepth !== undefined && (!opts.initial || opts.placeBy === "seed");
  if (streams && seed) opts.onDepth?.(0, positions, seed.write(topo, cx, cy, r, positions));

  let frontier: number[] = [root];
  for (let depth = 0; frontier.length; depth++) {
    const next: number[] = [];
    for (const g of frontier) {
      const start = childOffset[g]!;
      const end = childOffset[g + 1]!;
      if (end > start) {
        solveModule(topo, g, start, end, weight, packing, iterations, scratch, cx, cy, r, warm);
        for (let c = start; c < end; c++) next.push(children[c]!);
      }
    }
    if (streams && next.length) {
      const bounds = seed ? seed.write(topo, cx, cy, r, positions) : writeLeafPositions(topo, cx, cy, r, positions);
      opts.onDepth?.(depth + 1, positions, bounds);
    }
    frontier = next;
  }
  writeLeafPositions(topo, cx, cy, r, positions);
  if (warm && !seed) {
    const place = { tx: warm.ox[root]!, ty: warm.oy[root]!, spread: warm.spread };
    placeOver(topo, warm.known, place, opts.radius === undefined, positions, cx, cy, r);
  }
  return { positions, cx, cy, r };
}

/**
 * A warm seed's discs (#454): every non-root tree node's disc in its parent's, as a fraction of the parent's
 * radius — where the solve would map its module's children if the seed were its result (the weighted centroid
 * centred, the enclosing circle scaled to {@link NESTED.FILL}; a lone child at the centre, {@link NESTED.ONLY_CHILD}).
 * Float32, `size` entries each (the root's unused).
 */
export interface SeedDiscs {
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rr: Float32Array;
}

/** Empty {@link SeedDiscs} for a tree of `size` nodes. */
export function seedDiscs(size: number): SeedDiscs {
  return { rx: new Float32Array(size), ry: new Float32Array(size), rr: new Float32Array(size) };
}

/**
 * Record module `g`'s `k = end − start` children's seed discs into `out`, from the scratch a
 * {@link setupModule} (or {@link seedModule}) of `g` left (`k ≥ 2`) — or, for a lone child, its disc at the
 * centre. The mapping is {@link solveModule}'s, applied to the seed. O(k).
 */
export function recordSeedDiscs(topo: Pick<NestedLayoutTopology, "children">, start: number, end: number, s: Scratch, out: SeedDiscs): void {
  const { children } = topo;
  const k = end - start;
  if (k === 1) {
    const c = children[start]!;
    out.rx[c] = 0;
    out.ry[c] = 0;
    out.rr[c] = NESTED.ONLY_CHILD;
    return;
  }
  const { x, y, rad } = s;
  const { mx, my, extent } = discFrame(s, k);
  const f = NESTED.FILL / (extent || 1);
  for (let i = 0; i < k; i++) {
    const c = children[start + i]!;
    out.rx[c] = (x[i]! - mx) * f;
    out.ry[c] = (y[i]! - my) * f;
    out.rr[c] = rad[i]! * f;
  }
}

/**
 * The root disc that places a warm seed over the current map (#454, {@link NestedLayoutOptions.placeBy}
 * `"seed"`): the seed composed from a root disc of radius `radius` at the origin has its known leaves'
 * centroid moved onto `warm`'s and — when `rescale` — its RMS spread scaled to `warm`'s. `positions` (2 ·
 * leaves) is scratch. O(tree size + leaves), float64 sums.
 */
export function seedRootDisc(
  topo: NestedLayoutTopology,
  seed: SeededFrames,
  root: number,
  radius: number,
  warm: WarmStart,
  rescale: boolean,
  positions: Float32Array,
): { x: number; y: number; radius: number } {
  const { size, leafCount } = topo;
  const cx = new Float32Array(size);
  const cy = new Float32Array(size);
  const r = new Float32Array(size);
  r[root] = radius;
  seed.write(topo, cx, cy, r, positions);
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < leafCount; i++) {
    if (!warm.known[i]) continue;
    mx += positions[2 * i]!;
    my += positions[2 * i + 1]!;
    n++;
  }
  if (n === 0) return { x: 0, y: 0, radius };
  mx /= n;
  my /= n;
  let ss = 0;
  for (let i = 0; i < leafCount; i++) {
    if (!warm.known[i]) continue;
    ss += (positions[2 * i]! - mx) ** 2 + (positions[2 * i + 1]! - my) ** 2;
  }
  const spread = Math.sqrt(ss / n);
  const s = rescale && spread > 0 ? warm.spread / spread : 1;
  return { x: warm.ox[root]! - mx * s, y: warm.oy[root]! - my * s, radius: radius * s };
}

/**
 * Seed every module of a warm start (#454) — each one's children by the solve's own {@link seedModule} — and
 * record their discs ({@link recordSeedDiscs}). O(Σ k log k) over the modules, no links.
 */
export function warmSeedDiscs(topo: NestedLayoutTopology, weight: Float64Array, packing: number, s: Scratch, warm: WarmStart): SeedDiscs {
  const { size, leafCount, childOffset } = topo;
  const discs = seedDiscs(size);
  for (let g = leafCount; g < size; g++) {
    const start = childOffset[g]!;
    const end = childOffset[g + 1]!;
    if (end - start >= 2) seedModule(topo, g, start, end, weight, packing, s, warm);
    if (end > start) recordSeedDiscs(topo, start, end, s, discs);
  }
  return discs;
}

/**
 * Frames of a warm start placed by its seed (#454): a composition of the layout as far as it is solved from
 * the seed's discs ({@link SeedDiscs}) — a placed node (radius > 0) at its disc, every other node where its
 * seed puts it in its parent's disc (placed or composed). A frame keeps each unsolved module's children in
 * their seeded arrangement instead of collapsing them onto the module's centre, so a stream of them moves
 * from the seed to the result depth by depth. Memory: O(tree size) Float32 scratch, for the solve's lifetime.
 */
export class SeededFrames {
  private readonly discs: SeedDiscs;
  private readonly wx: Float32Array;
  private readonly wy: Float32Array;
  private readonly wr: Float32Array;
  /** Each node's deepest placed ancestor (itself when placed): the disc its final position lies in. */
  private readonly anchor: Int32Array;

  constructor(size: number, discs: SeedDiscs) {
    this.discs = discs;
    this.wx = new Float32Array(size);
    this.wy = new Float32Array(size);
    this.wr = new Float32Array(size);
    this.anchor = new Int32Array(size);
  }

  /** {@link seedRootDisc} with this seed. */
  rootDisc(topo: NestedLayoutTopology, root: number, radius: number, warm: WarmStart, rescale: boolean, positions: Float32Array): { x: number; y: number; radius: number } {
    return seedRootDisc(topo, this, root, radius, warm, rescale, positions);
  }

  /**
   * The frame of the layout so far into `out` (2 · leaves): one top-down pass (a parent has a higher id than
   * its children). Returns the box the final layout lies in — each leaf's deepest placed ancestor's disc, or
   * the leaf itself once placed — as {@link writeLeafPositions} does. O(tree size).
   */
  write(topo: NestedLayoutTopology, cx: Float32Array, cy: Float32Array, r: Float32Array, out: Float32Array): FitBox {
    const { size, leafCount, parent } = topo;
    const { rx, ry, rr } = this.discs;
    const { wx, wy, wr, anchor } = this;
    for (let g = size - 1; g >= 0; g--) {
      const p = parent[g]!;
      if (r[g]! > 0 || p < 0) {
        wx[g] = cx[g]!;
        wy[g] = cy[g]!;
        wr[g] = r[g]!;
        anchor[g] = g;
      } else {
        const R = wr[p]!;
        wx[g] = wx[p]! + rx[g]! * R;
        wy[g] = wy[p]! + ry[g]! * R;
        wr[g] = rr[g]! * R;
        anchor[g] = anchor[p]!;
      }
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < leafCount; i++) {
      out[2 * i] = wx[i]!;
      out[2 * i + 1] = wy[i]!;
      const a = anchor[i]!;
      const x = cx[a]!;
      const y = cy[a]!;
      const pad = a === i ? 0 : r[a]!;
      minX = Math.min(minX, x - pad);
      minY = Math.min(minY, y - pad);
      maxX = Math.max(maxX, x + pad);
      maxY = Math.max(maxY, y + pad);
    }
    return [minX, minY, maxX, maxY];
  }
}

/**
 * The frame {@link solveModule} maps a module's `k` unit-disc children by: their `rad²`-weighted centroid and
 * the extent of their discs about it. O(k).
 */
function discFrame(s: Scratch, k: number): { mx: number; my: number; extent: number } {
  const { x, y, rad } = s;
  let mx = 0;
  let my = 0;
  let mw = 0;
  for (let i = 0; i < k; i++) {
    const w = rad[i]! * rad[i]!;
    mx += x[i]! * w;
    my += y[i]! * w;
    mw += w;
  }
  mx /= mw;
  my /= mw;
  let extent = 0;
  for (let i = 0; i < k; i++) extent = Math.max(extent, Math.hypot(x[i]! - mx, y[i]! - my) + rad[i]!);
  return { mx, my, extent };
}

/**
 * A nested layout's module **boundary discs** (#329): each module's disc from `result`, with its centre
 * re-expressed as an offset from the module's leaf centroid in `result.positions` — the
 * {@link BoundaryDiscs} the network engine rings its expanded modules with (`lod({ moduleBoundary })`),
 * so a ring stays on its members' disc as they are dragged or eased. One O(tree size) pass, children
 * before parents (a module tree numbers every child below its parent). Aggregates only.
 */
export function nestedBoundaryDiscs(topo: Pick<NestedLayoutTopology, "size" | "leafCount" | "parent">, result: NestedLayoutResult): BoundaryDiscs {
  const { size, leafCount, parent } = topo;
  const { positions } = result;
  const sx = new Float64Array(size);
  const sy = new Float64Array(size);
  const count = new Float64Array(size);
  for (let i = 0; i < leafCount; i++) {
    sx[i] = positions[2 * i]!;
    sy[i] = positions[2 * i + 1]!;
    count[i] = 1;
  }
  for (let g = 0; g < size; g++) {
    const p = parent[g]!;
    if (p < 0) continue;
    sx[p] = sx[p]! + sx[g]!;
    sy[p] = sy[p]! + sy[g]!;
    count[p] = count[p]! + count[g]!;
  }
  const rows = size - leafCount;
  const dx = new Float32Array(rows);
  const dy = new Float32Array(rows);
  const r = new Float32Array(rows);
  for (let o = 0; o < rows; o++) {
    const g = leafCount + o;
    const n = count[g]!;
    // A module always holds a leaf; the guard only keeps a malformed (empty) one at its disc centre.
    dx[o] = n > 0 ? result.cx[g]! - sx[g]! / n : 0;
    dy[o] = n > 0 ? result.cy[g]! - sy[g]! / n : 0;
    r[o] = result.r[g]!;
  }
  return { dx, dy, r };
}

/** Where a warm-started map goes (#328): the current map's leaf centroid `(tx, ty)` and RMS spread. */
export interface Placement {
  readonly tx: number;
  readonly ty: number;
  readonly spread: number;
}

/**
 * Keep a warm-started map where the current one is (#328): translate — and, when `rescale`, scale about
 * the centroid — so the known leaves (`known[i] > 0`) get the current map's centroid and RMS spread
 * (`place`). A similarity transform, so containment and non-overlap are unchanged. Two passes over the
 * leaves in float64 (the mean, then the spread about it). O(tree size + leaves).
 */
export function placeOver(
  topo: Pick<NestedLayoutTopology, "size" | "leafCount">,
  known: ArrayLike<number>,
  place: Placement,
  rescale: boolean,
  positions: Float32Array,
  cx: Float32Array,
  cy: Float32Array,
  r: Float32Array,
): void {
  const { size, leafCount } = topo;
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < leafCount; i++) {
    if (!known[i]) continue;
    mx += positions[2 * i]!;
    my += positions[2 * i + 1]!;
    n++;
  }
  mx /= n;
  my /= n;
  let ss = 0;
  for (let i = 0; i < leafCount; i++) {
    if (!known[i]) continue;
    ss += (positions[2 * i]! - mx) ** 2 + (positions[2 * i + 1]! - my) ** 2;
  }
  const spread = Math.sqrt(ss / n);
  const s = rescale && spread > 0 ? place.spread / spread : 1;
  const { tx, ty } = place;
  for (let i = 0; i < leafCount; i++) {
    positions[2 * i] = tx + (positions[2 * i]! - mx) * s;
    positions[2 * i + 1] = ty + (positions[2 * i + 1]! - my) * s;
  }
  for (let g = 0; g < size; g++) {
    cx[g] = tx + (cx[g]! - mx) * s;
    cy[g] = ty + (cy[g]! - my) * s;
    r[g] = r[g]! * s;
  }
}

/**
 * Each leaf at its deepest placed ancestor's centre. Discs are placed top-down and every placed disc has
 * a positive radius, so `r > 0` marks a placed node. Returns the box the final leaf positions lie in
 * (see {@link NestedLayoutOptions.onDepth}): a placed leaf's position, else its placed ancestor's disc —
 * in the same pass, at no extra walk.
 */
function writeLeafPositions(topo: NestedLayoutTopology, cx: Float32Array, cy: Float32Array, r: Float32Array, out: Float32Array): FitBox {
  const { leafCount, parent } = topo;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < leafCount; i++) {
    let g = i;
    while (!(r[g]! > 0) && parent[g]! >= 0) g = parent[g]!;
    const x = cx[g] ?? NaN;
    const y = cy[g] ?? NaN;
    out[2 * i] = x;
    out[2 * i + 1] = y;
    const pad = g === i ? 0 : (r[g] ?? 0); // a placed leaf is final; an unplaced one lands inside this disc
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  }
  return [minX, minY, maxX, maxY];
}

/**
 * A module's local problem, in the unit disc (parent radius 1): its children's radii and seed positions
 * (written into the scratch's `x`, `y`, `rad` at local indices 0…k−1, velocities zeroed) and its sibling
 * links as local index pairs with their spring weights. Shared by the CPU solve ({@link solveModule}) and
 * the batched GPU port's CPU prep (#355), so both solve exactly the same problem. O(k log k + links).
 */
export interface ModuleSetup {
  /** Whether the children are seeded at their current centroids (a warm start): the solve starts at {@link WARM_ALPHA}. */
  readonly seeded: boolean;
  /** Link endpoints, as local child indices (a spring each way is kept as two links, as the CPU solves it). */
  readonly la: readonly number[];
  readonly lb: readonly number[];
  /** Link spring weights `√(flow / max flow) / max(1, min(degree))`. */
  readonly lw: readonly number[];
}

/**
 * Seed module `g`'s `k = end − start ≥ 2` children into the scratch's `x`, `y`, `rad` (local indices
 * 0…k−1, velocities zeroed): radii by area share of `weight` with a floor, and the golden-angle spiral — or
 * the warm seed. Returns whether they are warm-seeded. The first half of {@link setupModule}, on its own
 * for a warm start's seed frames (#454). O(k log k).
 */
export function seedModule(
  topo: NestedLayoutTopology,
  g: number,
  start: number,
  end: number,
  weight: Float64Array,
  packing: number,
  s: Scratch,
  warm: WarmStart | null,
): boolean {
  const { children } = topo;
  const k = end - start;
  s.ensure(k, topo.size);
  const { x, y, vx, vy, rad } = s;

  // Disc radii: area share of the parent's metric, with a floor so zero-metric children stay visible.
  let total = 0;
  for (let c = start; c < end; c++) total += weight[children[c]!]!;
  const floor = total > 0 ? total / (k * 50) : 1;
  let sum = 0;
  for (let i = 0; i < k; i++) sum += Math.max(weight[children[start + i]!]!, floor);
  // Warm start (#328): seed each child at its current centroid's offset from g's, the farthest at the
  // spiral's outer radius — when every child's centroid is known and they don't all coincide with g's.
  let far = 0;
  if (warm) {
    const { ox, oy, known } = warm;
    for (let i = 0; i < k && far >= 0; i++) {
      const c = children[start + i]!;
      far = known[c]! > 0 ? Math.max(far, Math.hypot(ox[c]! - ox[g]!, oy[c]! - oy[g]!)) : -1;
    }
  }
  const seeded = warm !== null && far > warm.spread * 1e-6;
  // Deterministic seed: a golden-angle spiral in heaviest-first order (heaviest near the centre). A warm
  // seed keeps a trace of it (WARM_SPIRAL), which splits coincident children deterministically.
  const order = Array.from({ length: k }, (_, i) => i).sort(
    (a, b) => weight[children[start + b]!]! - weight[children[start + a]!]! || a - b,
  );
  for (let rank = 0; rank < k; rank++) {
    const i = order[rank]!;
    const c = children[start + i]!;
    rad[i] = Math.sqrt((packing * Math.max(weight[c]!, floor)) / sum);
    const rr = 0.8 * Math.sqrt((rank + 0.5) / k);
    x[i] = rr * Math.cos(rank * GOLDEN);
    y[i] = rr * Math.sin(rank * GOLDEN);
    if (warm && seeded) {
      x[i] = (0.8 * (warm.ox[c]! - warm.ox[g]!)) / far + WARM_SPIRAL * x[i]!;
      y[i] = (0.8 * (warm.oy[c]! - warm.oy[g]!)) / far + WARM_SPIRAL * y[i]!;
    }
    vx[i] = 0;
    vy[i] = 0;
  }
  return seeded;
}

/**
 * Set up module `g`'s `k = end − start ≥ 2` children (see {@link ModuleSetup}): radii by area share of
 * `weight` with a floor, the golden-angle spiral (or the warm seed), and the sparsified, weighted
 * sibling links. Leaves `s.local` all −1 again.
 */
export function setupModule(
  topo: NestedLayoutTopology,
  g: number,
  start: number,
  end: number,
  weight: Float64Array,
  packing: number,
  s: Scratch,
  warm: WarmStart | null,
): ModuleSetup {
  const { children, superEdgeOffset, superEdgeTarget, superEdgeFlow, parent } = topo;
  const k = end - start;
  const seeded = seedModule(topo, g, start, end, weight, packing, s, warm);
  const { local } = s;
  for (let i = 0; i < k; i++) local[children[start + i]!] = i;

  // Sibling links: super-edges between two children of g, symmetrised (a spring each way is the same
  // spring), strength ∝ √(flow / max flow) / min(degree) so hubs don't collapse their neighbours.
  const la: number[] = [];
  const lb: number[] = [];
  const lw: number[] = [];
  if (superEdgeOffset && superEdgeTarget && superEdgeFlow) {
    for (let i = 0; i < k; i++) {
      const c = children[start + i]!;
      for (let e = superEdgeOffset[c]!; e < superEdgeOffset[c + 1]!; e++) {
        const t = superEdgeTarget[e]!;
        if (parent[t] !== g || t === c) continue;
        la.push(i);
        lb.push(local[t]!);
        lw.push(superEdgeFlow[e]!);
      }
    }
  }
  for (let c = start; c < end; c++) local[children[c]!] = -1;
  sparsifyLinks(la, lb, lw, k);
  const links = la.length;
  const degree = new Uint32Array(k);
  let maxFlow = 0;
  for (let l = 0; l < links; l++) {
    degree[la[l]!] = degree[la[l]!]! + 1;
    degree[lb[l]!] = degree[lb[l]!]! + 1;
    if (lw[l]! > maxFlow) maxFlow = lw[l]!;
  }
  for (let l = 0; l < links; l++) {
    lw[l] = Math.sqrt(lw[l]! / (maxFlow || 1)) / Math.max(1, Math.min(degree[la[l]!]!, degree[lb[l]!]!));
  }
  return { seeded, la, lb, lw };
}

/**
 * Solve one module's children in the unit disc, then map them into the module's world disc. Local
 * coordinates are unit-disc based (parent radius 1), so the solve is scale-free.
 */
function solveModule(
  topo: NestedLayoutTopology,
  g: number,
  start: number,
  end: number,
  weight: Float64Array,
  packing: number,
  iterations: number,
  s: Scratch,
  cx: Float32Array,
  cy: Float32Array,
  r: Float32Array,
  warm: WarmStart | null,
): void {
  const { children } = topo;
  const k = end - start;
  const R = r[g]!;
  if (k === 1) {
    const c = children[start]!;
    cx[c] = cx[g]!;
    cy[c] = cy[g]!;
    r[c] = R * NESTED.ONLY_CHILD;
    return;
  }
  const { seeded, la, lb, lw } = setupModule(topo, g, start, end, weight, packing, s, warm);
  const { x, y, vx, vy, rad } = s;
  const links = la.length;

  // Two phases. ORGANISE (first 60%): gravity + springs + many-body repulsion, discs may overlap, so
  // linked siblings can pass each other and the arrangement follows the links rather than the seed.
  // COMPACT (rest): gravity + springs + collision, no repulsion, packing the settled arrangement into
  // non-overlapping discs without reordering it. A warm seed starts cooler (WARM_ALPHA): the forces
  // are the same, so it settles into the same kind of arrangement, but the seed carries over.
  const { PAD, GRAVITY, DECAY } = NESTED;
  const REPULSION = NESTED.REPULSION_K / k; // unlinked siblings spread to ≈ the unit disc against gravity
  const organise = Math.ceil(iterations * NESTED.ORGANISE);
  let alpha = seeded ? WARM_ALPHA : 1;
  const alphaDecay = nestedAlphaDecay(alpha, iterations);
  for (let it = 0; it < iterations; it++) {
    const organising = it < organise;
    if (organising) repel(s, k, REPULSION * alpha);
    for (let i = 0; i < k; i++) {
      vx[i] = vx[i]! - x[i]! * GRAVITY * alpha;
      vy[i] = vy[i]! - y[i]! * GRAVITY * alpha;
    }
    for (let l = 0; l < links; l++) {
      const a = la[l]!;
      const b = lb[l]!;
      let dx = x[b]! + vx[b]! - x[a]! - vx[a]!;
      let dy = y[b]! + vy[b]! - y[a]! - vy[a]!;
      const d = Math.hypot(dx, dy) || 1e-9;
      const rest = organising ? 0 : (rad[a]! + rad[b]!) * PAD;
      const f = (Math.max(0, d - rest) / d) * alpha * lw[l]! * 0.5;
      dx *= f;
      dy *= f;
      // Split the correction by size: the smaller disc moves more.
      const ma = rad[a]! * rad[a]!;
      const mb = rad[b]! * rad[b]!;
      const sb = ma / (ma + mb);
      vx[b] = vx[b]! - dx * sb;
      vy[b] = vy[b]! - dy * sb;
      vx[a] = vx[a]! + dx * (1 - sb);
      vy[a] = vy[a]! + dy * (1 - sb);
    }
    for (let i = 0; i < k; i++) {
      vx[i] = vx[i]! * (1 - DECAY);
      vy[i] = vy[i]! * (1 - DECAY);
      x[i] = x[i]! + vx[i]!;
      y[i] = y[i]! + vy[i]!;
    }
    if (!organising) collide(s, k, PAD);
    alpha -= alpha * alphaDecay;
  }

  // Map the unit-disc solution into g's disc: centre the enclosing circle, scale it to 0.92·R.
  const { mx, my, extent } = discFrame(s, k);
  const scale = (NESTED.FILL * R) / (extent || 1);
  for (let i = 0; i < k; i++) {
    const c = children[start + i]!;
    cx[c] = cx[g]! + (x[i]! - mx) * scale;
    cy[c] = cy[g]! + (y[i]! - my) * scale;
    r[c] = rad[i]! * scale;
  }
}

/**
 * Links each child keeps for the solve when a module is dense. A dense module's arrangement is set by
 * each node's strongest ties; springs for the long tail only add per-tick cost (a bottom module of 962
 * leaves can carry ~150k leaf links). Layout-only: every link is still drawn.
 */
const LINKS_PER_NODE = 8;

/**
 * In place: when there are more than `LINKS_PER_NODE · k` sibling links, keep the union of every
 * child's `LINKS_PER_NODE` strongest (by flow, ties by index — deterministic). O(links · log links).
 */
function sparsifyLinks(la: number[], lb: number[], lw: number[], k: number): void {
  const n = la.length;
  if (n <= LINKS_PER_NODE * k) return;
  const order = Array.from({ length: n }, (_, l) => l).sort((p, q) => lw[q]! - lw[p]! || p - q);
  const kept = new Uint8Array(n);
  const used = new Uint16Array(k);
  for (const l of order) {
    const a = la[l]!;
    const b = lb[l]!;
    if (used[a]! < LINKS_PER_NODE || used[b]! < LINKS_PER_NODE) {
      kept[l] = 1;
      used[a] = used[a]! + 1;
      used[b] = used[b]! + 1;
    }
  }
  let w = 0;
  for (let l = 0; l < n; l++) {
    if (!kept[l]) continue;
    la[w] = la[l]!;
    lb[w] = lb[l]!;
    lw[w] = lw[l]!;
    w++;
  }
  la.length = w;
  lb.length = w;
  lw.length = w;
}

/** Up to this many children, repulsion and collision are exact O(k²); above it Barnes-Hut / a grid. */
export const EXACT_MAX = 32;

/** Local coordinates are unit-disc sized; the Barnes-Hut tree's softening is in absolute units. */
const BH_SCALE = 1000;

/**
 * Many-body repulsion `strength · (xᵢ − xⱼ) / d²` into the velocities: exact O(k²) for small k,
 * Barnes-Hut O(k log k) otherwise (built in a ×BH_SCALE frame so its fixed softening is negligible;
 * `strength · BH_SCALE` there yields the same unit-frame force).
 */
function repel(s: Scratch, k: number, strength: number): void {
  const { x, y, vx, vy } = s;
  if (k <= EXACT_MAX) {
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const dx = x[i]! - x[j]!;
        const dy = y[i]! - y[j]!;
        const d2 = dx * dx + dy * dy + 1e-9;
        const f = strength / d2;
        vx[i] = vx[i]! + dx * f;
        vy[i] = vy[i]! + dy * f;
        vx[j] = vx[j]! - dx * f;
        vy[j] = vy[j]! - dy * f;
      }
    }
    return;
  }
  const { pos32, fx, fy, bh } = s;
  for (let i = 0; i < k; i++) {
    pos32[2 * i] = x[i]! * BH_SCALE;
    pos32[2 * i + 1] = y[i]! * BH_SCALE;
    fx[i] = 0;
    fy[i] = 0;
  }
  bh.build(pos32, k);
  bh.applyForces(strength * BH_SCALE, 0.9, fx, fy); // children in the tree's Z order, for locality
  for (let i = 0; i < k; i++) {
    vx[i] = vx[i]! + fx[i]!;
    vy[i] = vy[i]! + fy[i]!;
  }
}

/** Push overlapping discs apart (position-based). O(k²) for small k, a uniform grid otherwise. */
export function collide(s: Scratch, k: number, pad: number): void {
  const { x, y, rad } = s;
  const resolve = (i: number, j: number): void => {
    const dx = x[j]! - x[i]!;
    const dy = y[j]! - y[i]!;
    const min = (rad[i]! + rad[j]!) * pad;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;
    // `push` scales (dx, dy), whose length is d, to the overlap `min − d`. Coincident discs (d² = 0) have no
    // such vector: they separate by exactly `min` along a fixed, index-derived unit direction, from the lower
    // index to the higher (i < j on both paths below) — deterministic (#357). (d² = NaN, from a non-finite
    // position, takes the same branch: the NaN disc stays NaN and its finite partner moves by its share of
    // `min`, not of min·1e9.) i and j are the module's local child indices (0..k−1); a batched port that
    // holds every module in one slot range reproduces the direction with `slot − segment start` (#355).
    const d = Math.sqrt(d2);
    const push = d2 > 0 ? (min - d) / d : min;
    const mi = rad[i]! * rad[i]!;
    const mj = rad[j]! * rad[j]!;
    const sj = mi / (mi + mj);
    const ux = d2 > 0 ? dx : Math.cos(i + j);
    const uy = d2 > 0 ? dy : Math.sin(i + j);
    x[j] = x[j]! + ux * push * sj;
    y[j] = y[j]! + uy * push * sj;
    x[i] = x[i]! - ux * push * (1 - sj);
    y[i] = y[i]! - uy * push * (1 - sj);
  };
  if (k <= EXACT_MAX) {
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) resolve(i, j);
    return;
  }
  // Uniform grid keyed by the largest disc: each disc checks the 3×3 cells around its own.
  let maxR = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < k; i++) {
    maxR = Math.max(maxR, rad[i]!);
    minX = Math.min(minX, x[i]!);
    minY = Math.min(minY, y[i]!);
    maxX = Math.max(maxX, x[i]!);
    maxY = Math.max(maxY, y[i]!);
  }
  const cell = 2 * maxR * pad || 1;
  const cols = Math.min(1024, Math.max(1, Math.ceil((maxX - minX) / cell) + 1));
  const rows = Math.min(1024, Math.max(1, Math.ceil((maxY - minY) / cell) + 1));
  if (s.cell.length < cols * rows) s.cell = new Int32Array(cols * rows);
  const head = s.cell;
  head.fill(-1, 0, cols * rows);
  const { next } = s;
  const colOf = (v: number): number => Math.min(cols - 1, Math.floor((v - minX) / cell));
  const rowOf = (v: number): number => Math.min(rows - 1, Math.floor((v - minY) / cell));
  for (let i = 0; i < k; i++) {
    const h = rowOf(y[i]!) * cols + colOf(x[i]!);
    next[i] = head[h]!;
    head[h] = i;
  }
  for (let i = 0; i < k; i++) {
    const ci = colOf(x[i]!);
    const ri = rowOf(y[i]!);
    for (let rr = Math.max(0, ri - 1); rr <= Math.min(rows - 1, ri + 1); rr++) {
      for (let cc = Math.max(0, ci - 1); cc <= Math.min(cols - 1, ci + 1); cc++) {
        for (let j = head[rr * cols + cc]!; j >= 0; j = next[j]!) if (j > i) resolve(i, j);
      }
    }
  }
}
