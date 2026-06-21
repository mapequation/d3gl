/**
 * Module-free structural level-of-detail (sub-issue #103 / epic #98).
 *
 * The mechanism that bounds per-frame work to *visible* elements so a module-free network reaches
 * ~10M: a retained **LOD tree** (the N4 coarsening hierarchy, kept instead of discarded) whose
 * nodes carry geometry derived from the final layout, plus an **adaptive cut** that each frame walks
 * the tree top-down and keeps only what's on-screen and large enough to matter — expanding an
 * aggregate into its children when its on-screen footprint grows, collapsing it to one glyph when it
 * shrinks. The frontier (leaves + aggregates) is what the renderer draws, so cost ∝ visible set.
 *
 * This is the structural-primary path (epic decision "Option B"). The spatial-quadtree fallback for
 * edge-less point clouds is a later slice; an edge-less graph yields a single-level tree here, which
 * the cut simply draws in full (no aggregation possible).
 *
 * Kept network-private for now behind the {@link cut} / frontier boundary; the same shape is meant
 * to be promotable to a shared core `select(transform) → visibleIndices` lane later (#108).
 */
import type { NetworkGraph } from "./graph.js";
import { buildHierarchy, type CoarsenOptions } from "./coarsen.js";

/**
 * A retained coarsening tree, flattened to SoA typed arrays for cache-friendly traversal at scale.
 *
 * Tree nodes are numbered by level: level 0 (the original graph) occupies global ids `[0, leafCount)`
 * and is the **leaves**; each coarser level follows, and the coarsest level is the **roots**. Ids are
 * stable for the life of the graph, so aggregates keep their identity across frames (no popping).
 */
export interface LODTree {
  /** Total tree nodes across all levels. */
  size: number;
  /** Number of leaves (= `graph.nodeCount` = level-0 node count). */
  leafCount: number;
  /** Number of coarsening levels; 1 means no coarsening was possible (tiny / edge-less graph). */
  levelCount: number;
  /** Global-id start of each level; length `levelCount + 1`. Level `k` is `[levelOffset[k], levelOffset[k+1])`. */
  levelOffset: Uint32Array;
  /** Children CSR: node `g`'s children are `children[childOffset[g] .. childOffset[g+1]]` (one level finer). */
  childOffset: Uint32Array;
  children: Uint32Array;
  /**
   * Same-level adjacency CSR for **aggregates** (super-edges): aggregate `g`'s same-level neighbours
   * are `edgeNeighbors[edgeOffset[g] .. edgeOffset[g+1]]`. Built from the coarse levels only; leaf
   * adjacency is the graph's own CSR (a leaf's global id equals its node id), so leaf entries are
   * empty here. Symmetric.
   */
  edgeOffset: Uint32Array;
  edgeNeighbors: Uint32Array;
  // --- geometry, filled by computeLODGeometry from the settled layout ---
  /** Centroid x of each node's leaf descendants. */
  cx: Float32Array;
  /** Centroid y of each node's leaf descendants. */
  cy: Float32Array;
  /**
   * Spatial bounding radius (world units): an upper bound on the distance from the centroid to any
   * descendant leaf. Drives viewport culling and the zoom-driven expand trigger.
   */
  extent: Float32Array;
  /**
   * Visual draw radius (world units): leaves take their resolved per-node radius (degree/strength/…
   * encoded); each aggregate is `√(Σ child radius²)` — area-additive, so it's agnostic to the node
   * sizing and an aggregate's ink ≈ its contents' total ink. Drives drawing and declutter occupancy.
   */
  radius: Float32Array;
  /** Number of leaf descendants. */
  count: Uint32Array;
  /** Summed leaf importance (default: strength) — drives super-edge weight and declutter priority. */
  weight: Float32Array;
}

/**
 * Build the retained LOD tree topology from a graph's coarsening hierarchy. Geometry is left zeroed;
 * call {@link computeLODGeometry} once positions have settled. Pure topology — no positions read.
 */
export function buildLODTree(graph: NetworkGraph, coarsen?: CoarsenOptions): LODTree {
  const { levels, projections } = buildHierarchy(graph, coarsen);
  const levelCount = levels.length;

  const levelOffset = new Uint32Array(levelCount + 1);
  for (let k = 0; k < levelCount; k++) levelOffset[k + 1] = levelOffset[k]! + levels[k]!.nodeCount;
  const size = levelOffset[levelCount]!;
  const leafCount = graph.nodeCount;

  // Parent of each node (one level coarser): projections[k] maps level-k local → level-(k+1) local.
  const parent = new Int32Array(size).fill(-1);
  for (let k = 0; k < levelCount - 1; k++) {
    const proj = projections[k]!;
    const childBase = levelOffset[k]!;
    const parentBase = levelOffset[k + 1]!;
    for (let i = 0; i < proj.length; i++) parent[childBase + i] = parentBase + proj[i]!;
  }

  // Children CSR from the parent map (count → prefix-sum → scatter), like buildCSR.
  const childOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) {
    const p = parent[g]!;
    if (p >= 0) childOffset[p + 1] = childOffset[p + 1]! + 1;
  }
  for (let g = 0; g < size; g++) childOffset[g + 1] = childOffset[g + 1]! + childOffset[g]!;
  const children = new Uint32Array(childOffset[size]!);
  const cursor = childOffset.slice(0, size);
  for (let g = 0; g < size; g++) {
    const p = parent[g]!;
    if (p >= 0) {
      const pos = cursor[p]!;
      children[pos] = g;
      cursor[p] = pos + 1;
    }
  }

  // Same-level adjacency for aggregates (super-edges), from the coarse levels only (level 0 reuses
  // graph.csr). Symmetric: count → prefix-sum → scatter, like buildCSR.
  const edgeOffset = new Uint32Array(size + 1);
  for (let k = 1; k < levelCount; k++) {
    const lvl = levels[k]!;
    const base = levelOffset[k]!;
    for (let e = 0; e < lvl.source.length; e++) {
      const a = base + lvl.source[e]!;
      const b = base + lvl.target[e]!;
      edgeOffset[a + 1] = edgeOffset[a + 1]! + 1;
      edgeOffset[b + 1] = edgeOffset[b + 1]! + 1;
    }
  }
  for (let g = 0; g < size; g++) edgeOffset[g + 1] = edgeOffset[g + 1]! + edgeOffset[g]!;
  const edgeNeighbors = new Uint32Array(edgeOffset[size]!);
  const ecur = edgeOffset.slice(0, size);
  for (let k = 1; k < levelCount; k++) {
    const lvl = levels[k]!;
    const base = levelOffset[k]!;
    for (let e = 0; e < lvl.source.length; e++) {
      const a = base + lvl.source[e]!;
      const b = base + lvl.target[e]!;
      edgeNeighbors[ecur[a]!] = b;
      ecur[a] = ecur[a]! + 1;
      edgeNeighbors[ecur[b]!] = a;
      ecur[b] = ecur[b]! + 1;
    }
  }

  return {
    size,
    leafCount,
    levelCount,
    levelOffset,
    childOffset,
    children,
    edgeOffset,
    edgeNeighbors,
    cx: new Float32Array(size),
    cy: new Float32Array(size),
    extent: new Float32Array(size),
    radius: new Float32Array(size),
    count: new Uint32Array(size),
    weight: new Float32Array(size),
  };
}

/**
 * Fill the tree's geometry from the settled layout, the per-leaf visual radii, and a per-leaf
 * importance weight. Leaves take their own position/radius; each aggregate gets the count-weighted
 * centroid of its children (= the mean of its descendant leaf positions), the summed count/weight,
 * an area-additive visual radius (`√Σ child radius²`), and a bounding `extent` enclosing all
 * descendant leaves. One bottom-up pass over the levels — O(tree size) ≈ O(n).
 *
 * `leafRadii` is the resolved per-node radius (so aggregates respect the node sizing); `leafWeight`
 * is the per-leaf importance, defaulting to `graph.strength` (weighted degree) — pass `graph.flow`
 * or `graph.csr.degree` to prioritise differently.
 */
export function computeLODGeometry(
  tree: LODTree,
  graph: NetworkGraph,
  leafRadii: ArrayLike<number>,
  leafWeight: ArrayLike<number> = graph.strength,
): void {
  const { leafCount, levelCount, levelOffset, childOffset, children, cx, cy, extent, radius, count, weight } = tree;
  const pos = graph.positions;

  for (let i = 0; i < leafCount; i++) {
    cx[i] = pos[i * 2]!;
    cy[i] = pos[i * 2 + 1]!;
    count[i] = 1;
    radius[i] = leafRadii[i]!;
    weight[i] = leafWeight[i]!;
    extent[i] = 0;
  }

  for (let k = 1; k < levelCount; k++) {
    for (let g = levelOffset[k]!; g < levelOffset[k + 1]!; g++) {
      const c0 = childOffset[g]!;
      const c1 = childOffset[g + 1]!;
      let sumC = 0;
      let sx = 0;
      let sy = 0;
      let sw = 0;
      let sumR2 = 0;
      for (let p = c0; p < c1; p++) {
        const c = children[p]!;
        const cc = count[c]!;
        sumC += cc;
        sx += cc * cx[c]!;
        sy += cc * cy[c]!;
        sw += weight[c]!;
        sumR2 += radius[c]! * radius[c]!;
      }
      const gx = sumC > 0 ? sx / sumC : 0;
      const gy = sumC > 0 ? sy / sumC : 0;
      cx[g] = gx;
      cy[g] = gy;
      count[g] = sumC;
      weight[g] = sw;
      radius[g] = Math.sqrt(sumR2); // area-additive: aggregate ink ≈ Σ child ink
      // Bounding radius: the farthest child's centre distance plus that child's own extent.
      let ext = 0;
      for (let p = c0; p < c1; p++) {
        const c = children[p]!;
        const dx = gx - cx[c]!;
        const dy = gy - cy[c]!;
        const d = Math.hypot(dx, dy) + extent[c]!;
        if (d > ext) ext = d;
      }
      extent[g] = ext;
    }
  }
}

/** Screen-space transform: `screen = world * k + (x, y)` (matches {@link BaseEngine} `ViewTransform`). */
export interface LODTransform {
  k: number;
  x: number;
  y: number;
}

export interface CutOptions {
  /**
   * Expand an aggregate into its children once its on-screen footprint (diameter = `2·extent·k`, in
   * px) reaches this threshold; below it the aggregate draws as a single glyph. Larger → coarser
   * (fewer, bigger glyphs); smaller → finer. Default 48.
   */
  expandPx?: number;
  /** True when glyphs are screen-pixel sized; converts the per-node draw radius to world for the cull margin. */
  screenSized?: boolean;
  /** Aggregate draw-radius cap (matches rendering), so the cull margin reflects the drawn size. */
  maxAggregateRadius?: number;
}

const DEFAULT_EXPAND_PX = 48;

/**
 * Adaptive hierarchy cut: walk the tree top-down for the given view and return the **frontier** —
 * the set of node ids to draw. A subtree is culled when its bounding box misses the viewport; an
 * aggregate expands when its on-screen footprint is large enough, otherwise it is drawn as one
 * glyph; leaves always draw. Work is proportional to the visible frontier, not to the tree size.
 */
export function cut(
  tree: LODTree,
  t: LODTransform,
  width: number,
  height: number,
  opts: CutOptions = {},
): Uint32Array {
  const { leafCount, levelCount, levelOffset, childOffset, children, cx, cy, extent, radius } = tree;
  const expandPx = opts.expandPx ?? DEFAULT_EXPAND_PX;
  const maxAgg = opts.maxAggregateRadius ?? Infinity;
  // Per-node draw radius in world units, so a glyph stays until its *whole body* leaves the viewport
  // (not just its centre) — no popping at the screen edge when zoomed in.
  const drawMargin = (g: number): number => {
    const r = g < leafCount ? radius[g]! : Math.min(radius[g]!, maxAgg);
    return opts.screenSized ? r / t.k : r;
  };

  // Visible world rectangle (inverse of screen = world·k + translate).
  const ax = (0 - t.x) / t.k;
  const bx = (width - t.x) / t.k;
  const ay = (0 - t.y) / t.k;
  const by = (height - t.y) / t.k;
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);

  const frontier: number[] = [];
  // Seed the stack with the roots (coarsest level).
  const stack: number[] = [];
  for (let g = levelOffset[levelCount - 1]!; g < levelOffset[levelCount]!; g++) stack.push(g);

  while (stack.length > 0) {
    const g = stack.pop()!;
    const ext = extent[g]!;
    const gx = cx[g]!;
    const gy = cy[g]!;
    // Cull only when the node's drawn body (bbox grown by its draw radius) misses the viewport, so a
    // glyph stays until its whole body is off-screen.
    const m = ext + drawMargin(g);
    if (gx + m < minX || gx - m > maxX || gy + m < minY || gy - m > maxY) continue;
    if (g < leafCount) {
      frontier.push(g); // a real leaf — nothing finer to expand into
      continue;
    }
    if (2 * ext * t.k >= expandPx) {
      for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) stack.push(children[p]!);
    } else {
      frontier.push(g);
    }
  }

  return Uint32Array.from(frontier);
}

/** Whether a frontier id is a real leaf (vs. an aggregate). */
export function isLeaf(tree: LODTree, g: number): boolean {
  return g < tree.leafCount;
}

export interface DeclutterOptions {
  /** True when glyphs are sized in screen pixels (`sizeMode: "screen"`); else world radii × k. */
  screenSized: boolean;
  /** The transform scale `k`, used to project world radii to pixels when not screen-sized. */
  k: number;
  /** Aggregate draw-radius cap (matches {@link frontierCircles}), for the on-screen size. */
  maxAggregateRadius?: number;
  /** Spacing multiplier on the exclusion radius (>1 = sparser, <1 = denser). Default 1. */
  spacing?: number;
}

/**
 * Thin an LOD frontier in screen space: keep higher-importance glyphs (by tree {@link LODTree.weight}
 * = strength) and drop lower-importance ones that would **overlap** a kept glyph (centre distance <
 * sum of the two radii). Greedy in descending importance over a uniform screen grid, so a dense
 * cluster keeps its most important members and the kept set is overlap-free (no overdraw). Runs per
 * cut, so it's zoom-dependent — more glyphs resolve as you zoom in. Returns the kept frontier ids
 * (original order).
 */
export function declutterFrontier(
  tree: LODTree,
  frontier: Uint32Array,
  t: LODTransform,
  width: number,
  height: number,
  opts: DeclutterOptions,
): Uint32Array {
  const F = frontier.length;
  if (F <= 1) return frontier;
  const maxAgg = opts.maxAggregateRadius ?? Infinity;
  const spacing = opts.spacing ?? 1;

  // Project each glyph to screen and resolve its on-screen draw radius (matching frontierCircles).
  const px = new Float64Array(F);
  const py = new Float64Array(F);
  const pr = new Float64Array(F);
  let maxR = 1;
  for (let i = 0; i < F; i++) {
    const g = frontier[i]!;
    const drawn = g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    const r = opts.screenSized ? drawn : drawn * opts.k;
    pr[i] = r;
    px[i] = tree.cx[g]! * t.k + t.x;
    py[i] = tree.cy[g]! * t.k + t.y;
    if (r > maxR) maxR = r;
  }

  // Visit in descending importance so the most important glyph in a cluster survives.
  const order = Array.from({ length: F }, (_, i) => i);
  order.sort((a, b) => tree.weight[frontier[b]!]! - tree.weight[frontier[a]!]!);

  // Uniform grid sized so any overlapping pair (centre distance < spacing·(rᵢ+rⱼ) ≤ 2·spacing·maxR)
  // lands within the 3×3 neighbourhood. Intrusive linked list of kept glyphs per cell (no per-cell
  // allocation).
  const cell = Math.max(2 * maxR * spacing, 1);
  const cols = Math.floor(width / cell) + 3;
  const rows = Math.floor(height / cell) + 3;
  const head = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(F);
  const kept = new Uint8Array(F);

  for (const i of order) {
    const x = px[i]!;
    const y = py[i]!;
    const r = pr[i]!;
    let cx = Math.floor(x / cell) + 1;
    let cy = Math.floor(y / cell) + 1;
    cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
    cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
    let occluded = false;
    for (let gx = cx - 1; gx <= cx + 1 && !occluded; gx++) {
      if (gx < 0 || gx >= cols) continue;
      for (let gy = cy - 1; gy <= cy + 1 && !occluded; gy++) {
        if (gy < 0 || gy >= rows) continue;
        for (let p = head[gy * cols + gx]!; p !== -1; p = next[p]!) {
          const dx = px[p]! - x;
          const dy = py[p]! - y;
          const thresh = spacing * (r + pr[p]!); // circles must not overlap
          if (dx * dx + dy * dy < thresh * thresh) {
            occluded = true;
            break;
          }
        }
      }
    }
    if (!occluded) {
      kept[i] = 1;
      const c = cy * cols + cx;
      next[i] = head[c]!;
      head[c] = i;
    }
  }

  let n = 0;
  for (let i = 0; i < F; i++) if (kept[i]) n++;
  const out = new Uint32Array(n);
  let w = 0;
  for (let i = 0; i < F; i++) if (kept[i]) out[w++] = frontier[i]!;
  return out;
}
