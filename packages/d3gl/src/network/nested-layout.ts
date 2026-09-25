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
 * current map (same leaf centroid and spread), so the new map lands where the old one was.
 *
 * Cost: each module solves its `k` children for `iterations` ticks at O(k + sibling links) per tick
 * (exact O(k²) repulsion/collision up to 32 children, Barnes-Hut / a uniform grid above), so the whole layout is O(Σ_modules
 * (k + links) · iterations) ≈ O((leaves + modules + super-edges) · iterations) — one-shot, never
 * per frame. Memory is O(tree size) for disc centres/radii plus per-module scratch of O(max k); a warm
 * start adds O(tree size) for the current centroids and one O(leaves) pass to place the result.
 */
import type { LODTopology } from "./lod.js";
import { BarnesHutTree } from "./quadtree.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/**
 * Starting alpha of a warm-seeded module solve (#328); a cold solve starts at 1. At 0.1 a warm start
 * from a map's own nested layout moves leaves ~2-4% of the root radius and repeated warm starts
 * converge (each moves less than the last); at 0.3 they moved twice as far and kept drifting.
 */
const WARM_ALPHA = 0.1;
/** Share of the cold spiral kept in a warm seed — splits coincident children deterministically. */
const WARM_SPIRAL = 0.01;

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
   * Not called on a warm start (`initial`): its placement is final only once every depth is, and
   * collapsing leaves onto their module centres is what a warm start exists to avoid.
   */
  onDepth?: (depth: number, positions: Float32Array) => void;
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

/** Reusable per-solve scratch, grown to the largest module's child count. */
class Scratch {
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
interface WarmStart {
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
function warmStart(topo: NestedLayoutTopology, initial: ArrayLike<number>, root: number): WarmStart | null {
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

/** Lay out a module tree top-down, each module's children inside its disc. @see the module docs above. */
export function nestedLayout(topo: NestedLayoutTopology, opts: NestedLayoutOptions = {}): NestedLayoutResult {
  const { size, leafCount, childOffset, children, parent } = topo;
  const iterations = Math.max(1, opts.iterations ?? 100);
  const packing = opts.packing ?? 0.45;

  // Subtree size metric, bottom-up (children have lower ids than their parents).
  const weight = new Float64Array(size);
  for (let i = 0; i < leafCount; i++) {
    const w = opts.size ? opts.size[i]! : 1;
    weight[i] = Number.isFinite(w) && w > 0 ? w : 0;
  }
  let root = -1;
  for (let g = 0; g < size; g++) {
    const p = parent[g]!;
    if (p >= 0) weight[p] = weight[p]! + weight[g]!;
    else if (g >= leafCount) root = g;
  }
  if (root < 0) throw new Error("nestedLayout: the topology has no root module");
  const warm = opts.initial ? warmStart(topo, opts.initial, root) : null;

  const cx = new Float32Array(size);
  const cy = new Float32Array(size);
  const r = new Float32Array(size);
  r[root] = opts.radius ?? 10 * Math.sqrt(leafCount);

  const positions = new Float32Array(2 * leafCount);
  const scratch = new Scratch();

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
    if (opts.onDepth && !opts.initial && next.length) {
      writeLeafPositions(topo, cx, cy, r, positions);
      opts.onDepth(depth + 1, positions);
    }
    frontier = next;
  }
  writeLeafPositions(topo, cx, cy, r, positions);
  if (warm) placeOver(topo, warm, root, opts.radius === undefined, positions, cx, cy, r);
  return { positions, cx, cy, r };
}

/**
 * Keep a warm-started map where the current one is (#328): translate — and, when `rescale`, scale about
 * the centroid — so the known leaves get the current map's centroid and RMS spread. A similarity
 * transform, so containment and non-overlap are unchanged. O(tree size + leaves).
 */
function placeOver(
  topo: NestedLayoutTopology,
  warm: WarmStart,
  root: number,
  rescale: boolean,
  positions: Float32Array,
  cx: Float32Array,
  cy: Float32Array,
  r: Float32Array,
): void {
  const { size, leafCount } = topo;
  const { known } = warm;
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
  const s = rescale && spread > 0 ? warm.spread / spread : 1;
  const tx = warm.ox[root]!;
  const ty = warm.oy[root]!;
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
 * a positive radius, so `r > 0` marks a placed node.
 */
function writeLeafPositions(topo: NestedLayoutTopology, cx: Float32Array, cy: Float32Array, r: Float32Array, out: Float32Array): void {
  const { leafCount, parent } = topo;
  for (let i = 0; i < leafCount; i++) {
    let g = i;
    while (!(r[g]! > 0) && parent[g]! >= 0) g = parent[g]!;
    out[2 * i] = cx[g]!;
    out[2 * i + 1] = cy[g]!;
  }
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
  const { children, superEdgeOffset, superEdgeTarget, superEdgeFlow, parent } = topo;
  const k = end - start;
  const R = r[g]!;
  if (k === 1) {
    const c = children[start]!;
    cx[c] = cx[g]!;
    cy[c] = cy[g]!;
    r[c] = R * 0.9;
    return;
  }
  s.ensure(k, topo.size);
  const { x, y, vx, vy, rad, local } = s;

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
    local[c] = i;
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

  // Two phases. ORGANISE (first 60%): gravity + springs + many-body repulsion, discs may overlap, so
  // linked siblings can pass each other and the arrangement follows the links rather than the seed.
  // COMPACT (rest): gravity + springs + collision, no repulsion, packing the settled arrangement into
  // non-overlapping discs without reordering it. A warm seed starts cooler (WARM_ALPHA): the forces
  // are the same, so it settles into the same kind of arrangement, but the seed carries over.
  const PAD = 1.15; // collision spacing, as a factor on the radius sum
  const GRAVITY = 0.08;
  const REPULSION = (0.5 * GRAVITY) / k; // unlinked siblings spread to ≈ the unit disc against gravity
  const DECAY = 0.4; // velocity decay per tick
  const organise = Math.ceil(iterations * 0.6);
  const alphaMin = 0.001;
  let alpha = seeded ? WARM_ALPHA : 1;
  const alphaDecay = 1 - Math.pow(alphaMin / alpha, 1 / iterations);
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
  const scale = (0.92 * R) / (extent || 1);
  for (let i = 0; i < k; i++) {
    const c = children[start + i]!;
    cx[c] = cx[g]! + (x[i]! - mx) * scale;
    cy[c] = cy[g]! + (y[i]! - my) * scale;
    r[c] = rad[i]! * scale;
    local[c] = -1;
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
const EXACT_MAX = 32;

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
  for (let i = 0; i < k; i++) bh.applyForce(i, strength * BH_SCALE, 0.9, fx, fy);
  for (let i = 0; i < k; i++) {
    vx[i] = vx[i]! + fx[i]!;
    vy[i] = vy[i]! + fy[i]!;
  }
}

/** Push overlapping discs apart (position-based). O(k²) for small k, a uniform grid otherwise. */
function collide(s: Scratch, k: number, pad: number): void {
  const { x, y, rad } = s;
  const resolve = (i: number, j: number): void => {
    const dx = x[j]! - x[i]!;
    const dy = y[j]! - y[i]!;
    const min = (rad[i]! + rad[j]!) * pad;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 1e-9;
    const push = (min - d) / d;
    const mi = rad[i]! * rad[i]!;
    const mj = rad[j]! * rad[j]!;
    const sj = mi / (mi + mj);
    // Coincident discs: separate along a fixed, index-derived direction (deterministic).
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
