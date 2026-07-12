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
import { hcl, rgb } from "d3-color";
import type { NetworkGraph } from "./graph.js";
import { buildHierarchy, type CoarsenOptions, type Hierarchy } from "./coarsen.js";
import { declutterScreen } from "../core/declutter.js";
import type { ScreenRect } from "../core/instanced-lane.js";

/**
 * The position-independent **topology** of the LOD tree: the flattened coarsening hierarchy (levels,
 * children CSR, super-edge adjacency) with no geometry. Built once from a {@link Hierarchy} — on the
 * worker, which already coarsens for multilevel seeding, then streamed to the main thread (#103
 * worker-LOD) so the main thread never re-coarsens. {@link LODTree} extends this with geometry.
 */
export interface LODTopology {
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
   * Per-node parent global id (one level coarser), length `size`; the root's parent is `-1`. Lets the
   * super-edge gather walk a node up to its nearest present ancestor for cross-level edges (#139).
   * Present on provided-module trees (built with the parent map); absent on coarsening/spatial trees,
   * which also carry no super-edge CSR — so the cross-level path never needs it there.
   */
  parent?: Int32Array;
  /**
   * Same-level adjacency CSR for **aggregates** (super-edges): aggregate `g`'s same-level neighbours
   * are `edgeNeighbors[edgeOffset[g] .. edgeOffset[g+1]]`. Built from the coarse levels only; leaf
   * adjacency is the graph's own CSR (a leaf's global id equals its node id), so leaf entries are
   * empty here. Symmetric.
   */
  edgeOffset: Uint32Array;
  edgeNeighbors: Uint32Array;
  /**
   * **Directed, flow-weighted super-edges** (#104 N6c), built from a provided module hierarchy so a
   * map's inter-module links render as bent half-arrows. Out-adjacency CSR over *all* tree nodes:
   * node `g`'s out-edges are `[superEdgeOffset[g] .. superEdgeOffset[g+1])`, going to `superEdgeTarget`
   * with summed directed `superEdgeFlow`. A graph edge contributes at every level from the leaves up to
   * its endpoints' lowest common module, so leaf↔leaf and module↔module pairs both have an entry —
   * whichever the cut makes visible. Absent for coarsening / spatial trees. @see {@link buildModuleLODTree}
   */
  superEdgeOffset?: Uint32Array;
  superEdgeTarget?: Uint32Array;
  superEdgeFlow?: Float32Array;
  /**
   * The **transpose** of the super-edge CSR (in-adjacency, by target): node `g`'s incoming edges are
   * `[superEdgeInOffset[g] .. superEdgeInOffset[g+1])`, coming from `superEdgeInSource` with the same
   * summed `superEdgeInFlow`. Lets the gather keep a visible node's edges to off-screen neighbours in
   * *both* directions (incoming as well as outgoing) without scanning off-screen sources. Built and
   * present together with the out-adjacency above. @see {@link buildSuperEdges}
   */
  superEdgeInOffset?: Uint32Array;
  superEdgeInSource?: Uint32Array;
  superEdgeInFlow?: Float32Array;
}

/**
 * A retained coarsening tree, flattened to SoA typed arrays for cache-friendly traversal at scale.
 *
 * Tree nodes are numbered by level: level 0 (the original graph) occupies global ids `[0, leafCount)`
 * and is the **leaves**; each coarser level follows, and the coarsest level is the **roots**. Ids are
 * stable for the life of the graph, so aggregates keep their identity across frames (no popping).
 */
export interface LODTree extends LODTopology {
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
   * sizing and an aggregate's ink ≈ its contents' total ink — *unless* a {@link RadiusAggregate} is
   * supplied, when an aggregate is sized by the leaf scale on its summed metric (flow-sized modules).
   * Drives drawing and declutter occupancy.
   */
  radius: Float32Array;
  /** Number of leaf descendants. */
  count: Uint32Array;
  /** Summed leaf importance (default: strength) — drives super-edge weight and declutter priority. */
  weight: Float32Array;
  /**
   * Summed leaf flow-border metric (e.g. enter/exit flow) — the raw value a flow border encodes
   * (#104 N6). Each leaf takes its provided value; each aggregate the sum of its descendants', so a
   * module's border reflects its members' total. Zero when no border metric is supplied. The draw
   * scale (value → ring width) is applied at glyph-build time, not stored here.
   */
  border: Float32Array;
  /**
   * Per-node fill colour as RGBA bytes, length `4 · size` (#104 N6 rework). Each leaf takes its
   * provided colour; each aggregate the (count-)averaged colour of its descendants — so a module
   * drawn from a categorical palette keeps its colour when collapsed, and its leaves share it. Zero
   * when no colours are supplied (the engine falls back to a single fill).
   */
  color: Uint8Array;
}

/**
 * Flatten a coarsening {@link Hierarchy} into the LOD tree's {@link LODTopology} — the level offsets,
 * children CSR, and aggregate super-edge adjacency — with no geometry. Pure topology, no positions
 * read. Reused by both the main-thread {@link buildLODTree} and the layout worker, which already has
 * the hierarchy from multilevel seeding and streams this topology to the main thread (#103).
 */
export function flattenHierarchyToTopology(hierarchy: Hierarchy, leafCount: number, edges?: SuperEdgeInput): LODTopology {
  const { levels, projections } = hierarchy;
  const levelCount = levels.length;

  const levelOffset = new Uint32Array(levelCount + 1);
  for (let k = 0; k < levelCount; k++) levelOffset[k + 1] = levelOffset[k]! + levels[k]!.nodeCount;
  const size = levelOffset[levelCount]!;

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

  const topo: LODTopology = { size, leafCount, levelCount, levelOffset, childOffset, children, edgeOffset, edgeNeighbors, parent };
  // Directed, flow-weighted super-edges (#104 N6) — built the same way for the coarsening tree as for a
  // module tree, so the LOD edge logic is identical for both. Only when the graph's edges are supplied
  // (the main-thread build); the worker streams a tree without them.
  if (edges) Object.assign(topo, buildSuperEdges(size, parent, edges));
  return topo;
}

/**
 * An **ancestor-aware "is selected"** predicate over a tree's parent pointers (#162): node `g` counts
 * as selected if it OR any ancestor satisfies `isSelected`. Lets a selected aggregate keep its expanding
 * children highlighted as you zoom in, while the selection set itself stays literal (just the aggregate
 * id). Memoised with path-compression — each node's whole ancestor chain is cached on first walk — so
 * applying it across a frontier is O(frontier · depth) worst case but amortises toward O(frontier) as
 * chains overlap, and is independent of the leaf count. `parent[g] < 0` marks a root.
 */
export function ancestorAwareSelected(parent: Int32Array, isSelected: (g: number) => boolean): (g: number) => boolean {
  const memo = new Map<number, boolean>();
  return (g: number): boolean => {
    const seen = memo.get(g);
    if (seen !== undefined) return seen;
    const path: number[] = [];
    let cur = g;
    let result = false;
    for (;;) {
      if (isSelected(cur)) { result = true; break; }
      const cached = memo.get(cur);
      if (cached !== undefined) { result = cached; break; }
      const par = parent[cur];
      if (par === undefined || par < 0) break; // reached a root with no selected ancestor
      path.push(cur);
      cur = par;
    }
    memo.set(g, result);
    for (const p of path) memo.set(p, result);
    return result;
  };
}

/**
 * Enumerate the leaf descendants of tree node `g` (its global ids `< leafCount`, which equal the
 * original graph node ids). A leaf returns `[itself]`; an aggregate is a DFS over the children CSR.
 * O(subtree leaves), run lazily on a hit (`members()`) — never per frame. Sorted ascending so the
 * member list is deterministic regardless of traversal order. Works for coarsening and module trees
 * (both carry the children CSR). #105 N7c-2: answers "which leaf nodes are inside this aggregate?".
 */
export function leavesUnder(tree: LODTopology, g: number): number[] {
  const { leafCount, childOffset, children } = tree;
  if (g < leafCount) return [g];
  const out: number[] = [];
  const stack = [g];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n < leafCount) { out.push(n); continue; }
    for (let c = childOffset[n]!; c < childOffset[n + 1]!; c++) stack.push(children[c]!);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Directed edges (source/target/weight) used to build the flow-weighted super-edge CSR. */
export interface SuperEdgeInput {
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  weight: ArrayLike<number>;
}

/**
 * Directed, flow-weighted super-edge adjacency over a tree (#104 N6). Each graph edge `u→v` contributes
 * at every level from the leaves up to (not including) `u`/`v`'s lowest common ancestor: walk both
 * ancestor chains in lockstep (after equalising depth), adding a directed `a→b` at each level until they
 * meet, summing flow per ordered pair. Tree-generic — works for a coarsening tree or a module tree (it
 * only needs `parent`, with parent ids greater than child ids). The cut renders whichever level is
 * visible. Both the **out**-adjacency (by source) and the **in**-adjacency (the transpose, by target)
 * are returned, so the gather can keep a visible node's edges to off-screen neighbours symmetrically —
 * outgoing (walk the node's out-edges) *and* incoming (walk its in-edges) — without re-scanning
 * off-screen sources (#104: WebGL incoming-link culling fix).
 */
export function buildSuperEdges(
  size: number,
  parent: Int32Array,
  edges: SuperEdgeInput,
): Pick<LODTopology, "superEdgeOffset" | "superEdgeTarget" | "superEdgeFlow" | "superEdgeInOffset" | "superEdgeInSource" | "superEdgeInFlow"> {
  // Depth from root. Parents have higher ids than children, so a single descending pass finalises each
  // parent before its children.
  const depth = new Int32Array(size);
  for (let g = size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;

  const flowByPair = new Map<number, number>();
  const m = edges.source.length;
  for (let e = 0; e < m; e++) {
    let a = edges.source[e]!;
    let b = edges.target[e]!;
    if (a === b) continue; // self-loop
    const w = edges.weight[e]!;
    while (depth[a]! > depth[b]!) a = parent[a]!;
    while (depth[b]! > depth[a]!) b = parent[b]!;
    while (a !== b) {
      const key = a * size + b;
      flowByPair.set(key, (flowByPair.get(key) ?? 0) + w);
      a = parent[a]!;
      b = parent[b]!;
    }
  }

  const superEdgeOffset = new Uint32Array(size + 1);
  for (const key of flowByPair.keys()) superEdgeOffset[Math.floor(key / size) + 1]!++;
  for (let g = 0; g < size; g++) superEdgeOffset[g + 1] = superEdgeOffset[g + 1]! + superEdgeOffset[g]!;
  const total = superEdgeOffset[size]!;
  const superEdgeTarget = new Uint32Array(total);
  const superEdgeFlow = new Float32Array(total);
  const cursor = superEdgeOffset.slice(0, size);
  for (const [key, flow] of flowByPair) {
    const a = Math.floor(key / size);
    const pos = cursor[a]!;
    superEdgeTarget[pos] = key - a * size;
    superEdgeFlow[pos] = flow;
    cursor[a] = pos + 1;
  }

  // Transpose: the same pairs grouped by *target*, so a visible node can find its incoming edges
  // (whose source may be off-screen) without scanning off-screen sources' out-lists.
  const superEdgeInOffset = new Uint32Array(size + 1);
  for (const key of flowByPair.keys()) superEdgeInOffset[(key % size) + 1]!++; // b = key % size
  for (let g = 0; g < size; g++) superEdgeInOffset[g + 1] = superEdgeInOffset[g + 1]! + superEdgeInOffset[g]!;
  const superEdgeInSource = new Uint32Array(total);
  const superEdgeInFlow = new Float32Array(total);
  const inCursor = superEdgeInOffset.slice(0, size);
  for (const [key, flow] of flowByPair) {
    const a = Math.floor(key / size);
    const b = key - a * size;
    const pos = inCursor[b]!;
    superEdgeInSource[pos] = a;
    superEdgeInFlow[pos] = flow;
    inCursor[b] = pos + 1;
  }
  return { superEdgeOffset, superEdgeTarget, superEdgeFlow, superEdgeInOffset, superEdgeInSource, superEdgeInFlow };
}

/** Allocate zeroed geometry arrays over a topology, yielding a renderable {@link LODTree}. */
/** Derive the parent map from the children CSR (parent = inverse of children), root = -1. O(size), once per build. */
function deriveParent(topo: LODTopology): Int32Array {
  const parent = new Int32Array(topo.size).fill(-1);
  for (let g = 0; g < topo.size; g++) {
    for (let p = topo.childOffset[g]!; p < topo.childOffset[g + 1]!; p++) parent[topo.children[p]!] = g;
  }
  return parent;
}

/**
 * Leaf-descendant count per node — pure topology: `count[leaf] = 1`, `count[aggregate] = Σ children`,
 * one bottom-up pass by level. Only the **worker path** needs this filled at construction (see
 * {@link lodTreeFromTopology}): the worker streams `cx`/`cy`/`extent` per frame but NOT `count`, and
 * never re-runs the per-frame {@link computeLODPositions} on the main thread, so without it the
 * main-thread worker tree's `count` stayed 0 (#105: hovering an aggregate showed "0 nodes"). The
 * main-thread builders ({@link attachGeometry} callers) get `count` from `computeLODPositions`, which
 * always runs right after they build — so they must NOT call this (it would be redundant work, and the
 * spatial tree rebuilds per frame as positions converge). O(tree size), run once per worker topology.
 */
function leafDescendantCounts(topo: LODTopology): Uint32Array {
  const { size, leafCount, levelCount, levelOffset, childOffset, children } = topo;
  const count = new Uint32Array(size);
  for (let i = 0; i < leafCount; i++) count[i] = 1;
  for (let k = 1; k < levelCount; k++) {
    for (let g = levelOffset[k]!; g < levelOffset[k + 1]!; g++) {
      let sum = 0;
      for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) sum += count[children[p]!]!;
      count[g] = sum;
    }
  }
  return count;
}

function attachGeometry(topo: LODTopology): LODTree {
  const { size } = topo;
  return {
    ...topo,
    // Ensure a parent map (the spatial-quadtree builder doesn't set one) so the cross-fade declutter
    // can test ancestry (#133). Coarsening/module topologies already carry it, so this is a no-op there.
    parent: topo.parent ?? deriveParent(topo),
    cx: new Float32Array(size),
    cy: new Float32Array(size),
    extent: new Float32Array(size),
    radius: new Float32Array(size),
    // count is filled by computeLODPositions, which always runs right after this builder (and again per
    // frame as the layout converges — for the spatial tree, on every rebuild). Don't fill it here.
    count: new Uint32Array(size),
    weight: new Float32Array(size),
    border: new Float32Array(size),
    color: new Uint8Array(size * 4),
  };
}

/**
 * Build the retained LOD tree topology from a graph's coarsening hierarchy. Geometry is left zeroed;
 * call {@link computeLODGeometry} once positions have settled. This is the main-thread path (the
 * `force`/`positions` backends and LOD enabled after a worker has finished); the worker backend
 * streams an already-built {@link LODTopology} instead (#103), assembled via {@link lodTreeFromTopology}.
 */
export function buildLODTree(graph: NetworkGraph, coarsen?: CoarsenOptions): LODTree {
  // Pass the graph's directed edges so the coarsening tree carries flow-weighted super-edges too —
  // the same edge-LOD path then serves both structural and module trees.
  return attachGeometry(
    flattenHierarchyToTopology(buildHierarchy(graph, coarsen), graph.nodeCount, { source: graph.source, target: graph.target, weight: graph.weight }),
  );
}

export interface SpatialLODOptions {
  /**
   * Safety cap on quadtree depth. Cells stop subdividing here and bucket their points, so
   * coincident / near-coincident points can't recurse forever. Default 24.
   */
  maxDepth?: number;
}

const SPATIAL_MAX_DEPTH = 24;

/**
 * Build a {@link LODTree} from a point cloud's positions alone — a spatial **quadtree** used as the
 * LOD hierarchy when there are no edges to coarsen (#103). The structural coarsening tree needs edges
 * (heavy-edge matching), so an edge-less graph would otherwise yield a single-level tree whose
 * {@link cut} degenerates to O(N) per frame with no aggregation; the quadtree restores hierarchical
 * culling (O(visible)) and zoom-out aggregation.
 *
 * Leaves are the points (global ids `[0, count)`); each quadtree cell is an aggregate whose children
 * are its points (a bottom cell) or its sub-cells. Cells are bucketed into {@link LODTopology} levels
 * by **height** (1 + the deepest child's height), so the existing {@link cut} /
 * {@link computeLODGeometry} / {@link declutterFrontier} all work unchanged. There are no super-edges
 * (the `edge*` arrays are empty). Geometry is left zeroed — fill it with {@link computeLODGeometry}.
 *
 * Generic over any positions buffer (not network-specific), so the same point-cloud LOD can back
 * other engines later (`plot.points()` / map scatter, #108).
 */
export function buildSpatialLODTree(positions: ArrayLike<number>, count: number, opts: SpatialLODOptions = {}): LODTree {
  const maxDepth = opts.maxDepth ?? SPATIAL_MAX_DEPTH;
  // ≤ 1 point: nothing to aggregate — a single-level tree of just the points.
  if (count <= 1) {
    return attachGeometry({
      size: count,
      leafCount: count,
      levelCount: 1,
      levelOffset: Uint32Array.from([0, count]),
      childOffset: new Uint32Array(count + 1),
      children: new Uint32Array(0),
      edgeOffset: new Uint32Array(count + 1),
      edgeNeighbors: new Uint32Array(0),
    });
  }

  // Root bounding square over all points.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let rootHalf = Math.max(maxX - minX, maxY - minY) / 2;
  if (!(rootHalf > 0)) rootHalf = 1; // all coincident
  rootHalf *= 1.0001; // pad so max-corner points fall strictly inside

  // Flat cell store (one body per leaf, like the Barnes-Hut tree; coincident points bucket via a
  // per-point linked list). Grown geometrically; `let` so the grow closure can reassign the bindings.
  let cap = Math.max(64, count);
  let cx: Float64Array = new Float64Array(cap);
  let cy: Float64Array = new Float64Array(cap);
  let half: Float64Array = new Float64Array(cap);
  let child: Int32Array = new Int32Array(cap * 4);
  let head: Int32Array = new Int32Array(cap); // leaf body-list head, -1 = empty
  let internal: Uint8Array = new Uint8Array(cap);
  const next = new Int32Array(count).fill(-1); // per-point next pointer (coincident buckets)
  let cellCount = 0;

  const grow = (): void => {
    cap *= 2;
    const g64 = (a: Float64Array): Float64Array => {
      const b = new Float64Array(cap);
      b.set(a);
      return b;
    };
    cx = g64(cx);
    cy = g64(cy);
    half = g64(half);
    const c4 = new Int32Array(cap * 4);
    c4.set(child);
    child = c4;
    const h = new Int32Array(cap);
    h.set(head);
    head = h;
    const ig = new Uint8Array(cap);
    ig.set(internal);
    internal = ig;
  };
  const newCell = (ccx: number, ccy: number, chalf: number): number => {
    if (cellCount >= cap) grow();
    const c = cellCount++;
    cx[c] = ccx;
    cy[c] = ccy;
    half[c] = chalf;
    child[c * 4] = child[c * 4 + 1] = child[c * 4 + 2] = child[c * 4 + 3] = -1;
    head[c] = -1;
    internal[c] = 0;
    return c;
  };
  const quadrant = (c: number, x: number, y: number): number => (x >= cx[c]! ? 1 : 0) | (y >= cy[c]! ? 2 : 0);
  const makeChild = (parent: number, q: number): number => {
    const h2 = half[parent]! / 2;
    const c = newCell(cx[parent]! + ((q & 1) === 0 ? -h2 : h2), cy[parent]! + ((q & 2) === 0 ? -h2 : h2), h2);
    child[parent * 4 + q] = c;
    internal[parent] = 1;
    return c;
  };

  newCell((minX + maxX) / 2, (minY + maxY) / 2, rootHalf);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    let cell = 0;
    let depth = 0;
    for (;;) {
      if (internal[cell]) {
        const q = quadrant(cell, x, y);
        const c = child[cell * 4 + q]!;
        if (c === -1) {
          const nc = makeChild(cell, q);
          head[nc] = i;
          break;
        }
        cell = c;
        if (++depth >= maxDepth) {
          next[i] = head[cell]!;
          head[cell] = i;
          break;
        }
        continue;
      }
      if (head[cell] === -1 || depth >= maxDepth) {
        next[i] = head[cell]!;
        head[cell] = i;
        break;
      }
      // Occupied leaf: push its body into a child, mark internal, re-loop to place point i.
      const j = head[cell]!;
      head[cell] = -1;
      const cj = makeChild(cell, quadrant(cell, positions[j * 2]!, positions[j * 2 + 1]!));
      head[cj] = j;
      next[j] = -1;
    }
  }

  // Height of each cell (1 + deepest child; leaf cells are 1, parenting height-0 points). Children
  // always have a higher cell index than their parent, so a single reverse pass suffices.
  const cheight = new Uint32Array(cellCount);
  for (let c = cellCount - 1; c >= 0; c--) {
    if (internal[c]) {
      let h = 0;
      for (let q = 0; q < 4; q++) {
        const ch = child[c * 4 + q]!;
        if (ch !== -1 && cheight[ch]! > h) h = cheight[ch]!;
      }
      cheight[c] = h + 1;
    } else {
      cheight[c] = 1;
    }
  }
  const maxHeight = cheight[0]!; // the root is the ancestor of all cells → the tallest

  // Assign global ids: points keep [0, count); cells follow, ordered by height (counting sort) so
  // each LOD level is a contiguous id range and every child's id < its parent's.
  const size = count + cellCount;
  const perHeight = new Uint32Array(maxHeight + 1); // perHeight[h] = number of cells of height h
  for (let c = 0; c < cellCount; c++) perHeight[cheight[c]!] = perHeight[cheight[c]!]! + 1;
  const heightStart = new Uint32Array(maxHeight + 1); // first LOD id for height-h cells
  let acc = count;
  for (let h = 1; h <= maxHeight; h++) {
    heightStart[h] = acc;
    acc += perHeight[h]!;
  }
  const lodId = new Uint32Array(cellCount);
  const hcursor = heightStart.slice();
  for (let c = 0; c < cellCount; c++) {
    const h = cheight[c]!;
    lodId[c] = hcursor[h]!;
    hcursor[h] = hcursor[h]! + 1;
  }

  const levelCount = maxHeight + 1;
  const levelOffset = new Uint32Array(levelCount + 1);
  levelOffset[1] = count;
  for (let h = 1; h <= maxHeight; h++) levelOffset[h + 1] = levelOffset[h]! + perHeight[h]!;

  // Children CSR: count → prefix-sum → scatter (points have none; cells point to sub-cells or bodies).
  const childOffset = new Uint32Array(size + 1);
  for (let c = 0; c < cellCount; c++) {
    let n = 0;
    if (internal[c]) {
      for (let q = 0; q < 4; q++) if (child[c * 4 + q]! !== -1) n++;
    } else {
      for (let b = head[c]!; b !== -1; b = next[b]!) n++;
    }
    childOffset[lodId[c]! + 1] = n;
  }
  for (let g = 0; g < size; g++) childOffset[g + 1] = childOffset[g + 1]! + childOffset[g]!;
  const children = new Uint32Array(childOffset[size]!);
  const ccur = childOffset.slice(0, size);
  for (let c = 0; c < cellCount; c++) {
    const g = lodId[c]!;
    if (internal[c]) {
      for (let q = 0; q < 4; q++) {
        const ch = child[c * 4 + q]!;
        if (ch !== -1) {
          children[ccur[g]!] = lodId[ch]!;
          ccur[g] = ccur[g]! + 1;
        }
      }
    } else {
      for (let b = head[c]!; b !== -1; b = next[b]!) {
        children[ccur[g]!] = b; // a point id (already its own LOD id)
        ccur[g] = ccur[g]! + 1;
      }
    }
  }

  return attachGeometry({
    size,
    leafCount: count,
    levelCount,
    levelOffset,
    childOffset,
    children,
    edgeOffset: new Uint32Array(size + 1),
    edgeNeighbors: new Uint32Array(0),
  });
}

/**
 * Assemble a {@link LODTree} from a worker-streamed {@link LODTopology}, optionally binding the
 * position-derived geometry (`cx`/`cy`/`extent`) to caller-provided buffers — typically views into a
 * `SharedArrayBuffer` the worker writes live each frame (#103 worker-LOD), so the main thread reads
 * the converging geometry with no copy. Style-derived geometry (`radius`/`weight`) is main-allocated
 * and filled once with {@link computeLODStyle}; the topological `count` is filled here (it's
 * position-independent — the worker streams cx/cy/extent but not count, #105).
 */
export function lodTreeFromTopology(
  topo: LODTopology,
  geometry?: { cx: Float32Array; cy: Float32Array; extent: Float32Array },
): LODTree {
  const { size } = topo;
  return {
    ...topo,
    cx: geometry?.cx ?? new Float32Array(size),
    cy: geometry?.cy ?? new Float32Array(size),
    extent: geometry?.extent ?? new Float32Array(size),
    radius: new Float32Array(size),
    count: leafDescendantCounts(topo),
    weight: new Float32Array(size),
    border: new Float32Array(size),
    color: new Uint8Array(size * 4),
  };
}

/**
 * Fill the tree's **position-derived** geometry from a layout snapshot: each leaf's centroid is its
 * own position (extent 0, count 1); each aggregate gets the count-weighted centroid of its children
 * (= the mean of its descendant leaf positions), the summed leaf `count`, and a bounding `extent`
 * enclosing all descendant leaves. One bottom-up pass — O(tree size) ≈ O(n).
 *
 * This is the *only* geometry that changes as the layout converges, so it is the per-frame pass: the
 * layout worker runs it each streamed frame and writes `cx`/`cy`/`extent` into the shared buffer the
 * main thread renders from (#103 worker-LOD). Style-derived geometry is {@link computeLODStyle}.
 */
export function computeLODPositions(tree: LODTree, positions: ArrayLike<number>): void {
  const { leafCount, levelCount, levelOffset, childOffset, children, cx, cy, extent, count } = tree;

  for (let i = 0; i < leafCount; i++) {
    cx[i] = positions[i * 2]!;
    cy[i] = positions[i * 2 + 1]!;
    count[i] = 1;
    extent[i] = 0;
  }

  for (let k = 1; k < levelCount; k++) {
    for (let g = levelOffset[k]!; g < levelOffset[k + 1]!; g++) {
      const c0 = childOffset[g]!;
      const c1 = childOffset[g + 1]!;
      let sumC = 0;
      let sx = 0;
      let sy = 0;
      for (let p = c0; p < c1; p++) {
        const c = children[p]!;
        const cc = count[c]!;
        sumC += cc;
        sx += cc * cx[c]!;
        sy += cc * cy[c]!;
      }
      const gx = sumC > 0 ? sx / sumC : 0;
      const gy = sumC > 0 ? sy / sumC : 0;
      cx[g] = gx;
      cy[g] = gy;
      count[g] = sumC;
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

/**
 * Optional radius aggregation for {@link computeLODStyle}. When node radius is sized by an **additive
 * metric** (degree / strength / flow), an aggregate is sized like a single *leaf carrying the combined
 * value* — the SAME scale applied to the summed child value (e.g. a module's radius from its members'
 * total flow). That is what the node sizing means hierarchically, and a `scaleSqrt` extrapolates above
 * the leaf domain as an honest area-proportional continuation. Omitted ⇒ the area-additive `√(Σ child
 * radius²)` fallback (agnostic to the sizing — used for structural / spatial trees with no metric).
 */
export interface RadiusAggregate {
  /** Per-leaf additive metric value (length `leafCount`); summed up the tree onto each aggregate. */
  leafValue: ArrayLike<number>;
  /** Maps a (summed) value → radius — the SAME scale used for the leaves. */
  radiusOf: (value: number) => number;
}

/**
 * Fill the tree's **style-derived** geometry: each leaf takes its resolved visual `radius` and
 * importance `weight`; each aggregate gets the summed child weight and, by default, an area-additive
 * radius (`√Σ child radius²`, so its ink ≈ its contents' total ink, agnostic to the node sizing).
 * Pass `radiusAggregate` to instead size an aggregate by the leaf scale applied to its summed child
 * value (flow-sized modules — see {@link RadiusAggregate}). Independent of positions, so this is
 * constant through a solve — computed once on the main thread (recomputed only when the style's radii
 * change), never per frame.
 *
 * `leafRadii` is the resolved per-node radius; `leafWeight` is the per-leaf importance (typically
 * `graph.strength`) driving super-edge weight and declutter priority. `leafBorder` (optional) is the
 * per-leaf flow-border metric (e.g. enter/exit flow); each aggregate gets the **sum** of its
 * descendants' (so a module's border reflects its members' total). Omitted ⇒ `border` stays zero.
 */
export function computeLODStyle(
  tree: LODTree,
  leafRadii: ArrayLike<number>,
  leafWeight: ArrayLike<number>,
  leafBorder?: ArrayLike<number>,
  leafColors?: ArrayLike<number>,
  radiusAggregate?: RadiusAggregate,
): void {
  const { leafCount, levelCount, levelOffset, childOffset, children, radius, weight, border, color } = tree;
  // Summed additive metric per node, only when sizing aggregates by the leaf scale (else null → the
  // area-additive √Σr² fallback). One temp array per style recompute, never per frame.
  const value = radiusAggregate ? new Float64Array(tree.size) : null;

  for (let i = 0; i < leafCount; i++) {
    radius[i] = leafRadii[i]!;
    weight[i] = leafWeight[i]!;
    border[i] = leafBorder ? leafBorder[i]! : 0;
    if (value) value[i] = radiusAggregate!.leafValue[i]!;
    if (leafColors) {
      color[i * 4] = leafColors[i * 4]!;
      color[i * 4 + 1] = leafColors[i * 4 + 1]!;
      color[i * 4 + 2] = leafColors[i * 4 + 2]!;
      color[i * 4 + 3] = leafColors[i * 4 + 3]!;
    }
  }

  for (let k = 1; k < levelCount; k++) {
    for (let g = levelOffset[k]!; g < levelOffset[k + 1]!; g++) {
      let sw = 0;
      let sumR2 = 0;
      let sv = 0;
      let sb = 0;
      // Colour: a chroma-weighted circular-hue mean in HCL, so a module's aggregate takes its hue
      // family's representative hue (crisp) rather than a muddy RGB average across the family.
      let hx = 0, hy = 0, sumC = 0, sumL = 0, sumA = 0, nc = 0;
      for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) {
        const c = children[p]!;
        sw += weight[c]!;
        if (value) sv += value[c]!;
        else sumR2 += radius[c]! * radius[c]!;
        sb += border[c]!;
        if (leafColors) {
          const col = hcl(rgb(color[c * 4]!, color[c * 4 + 1]!, color[c * 4 + 2]!));
          const ch = Number.isNaN(col.c) ? 0 : col.c;
          if (!Number.isNaN(col.h)) {
            hx += Math.cos((col.h * Math.PI) / 180) * ch;
            hy += Math.sin((col.h * Math.PI) / 180) * ch;
          }
          sumC += ch;
          sumL += Number.isNaN(col.l) ? 0 : col.l;
          sumA += color[c * 4 + 3]!;
          nc++;
        }
      }
      weight[g] = sw;
      if (value) {
        value[g] = sv;
        radius[g] = radiusAggregate!.radiusOf(sv); // leaf scale on the summed value (flow-sized modules)
      } else {
        radius[g] = Math.sqrt(sumR2); // area-additive: aggregate ink ≈ Σ child ink
      }
      border[g] = sb; // sum-additive: a module's border metric ≈ Σ member metric
      if (leafColors && nc > 0) {
        const hue = (Math.atan2(hy, hx) * 180) / Math.PI;
        const c = rgb(hcl(hue, sumC / nc, sumL / nc));
        color[g * 4] = Math.max(0, Math.min(255, Math.round(c.r)));
        color[g * 4 + 1] = Math.max(0, Math.min(255, Math.round(c.g)));
        color[g * 4 + 2] = Math.max(0, Math.min(255, Math.round(c.b)));
        color[g * 4 + 3] = Math.round(sumA / nc);
      }
    }
  }
}

/**
 * Fill the tree's full geometry from the settled layout, the per-leaf visual radii, and a per-leaf
 * importance weight — {@link computeLODPositions} then {@link computeLODStyle}. The main-thread path
 * (synchronous solve / supplied positions); the worker backend splits these passes across threads.
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
  leafBorder?: ArrayLike<number>,
  leafColors?: ArrayLike<number>,
  radiusAggregate?: RadiusAggregate,
): void {
  computeLODPositions(tree, graph.positions);
  computeLODStyle(tree, leafRadii, leafWeight, leafBorder, leafColors, radiusAggregate);
}

/**
 * Fold a small set of **moved leaves** into the tree's position-derived geometry incrementally
 * (#211) — the node-drag repaint path, where only the held leaves changed since the last pass.
 * O(moved · depth) instead of the full O(tree size) {@link computeLODPositions}:
 *
 * - **Centroids (exact):** an aggregate's centroid is the mean of its descendant leaf positions
 *   (the count-weighted child centroid telescopes to that), so one leaf moving by `δ` shifts every
 *   ancestor's centroid by exactly `δ / count[ancestor]` — updated along the parent chain.
 * - **Extent (grow-only, conservative):** the bounding radius is a *max* over children, which can
 *   shrink when a leaf moves inward — detecting that would need a per-ancestor child scan. Instead
 *   the extent only widens: grown by the ancestor's own centroid shift (covering its distance change
 *   to every unmoved child) and by the moved child's exact reach (`|centroid − child| + child
 *   extent`). An over-wide extent is safe — the cut culls less and expands earlier (never hides
 *   geometry) — and the caller runs one exact {@link computeLODPositions} when the drag settles.
 *
 * Style-derived geometry (`radius`/`weight`/`border`/`color`) is position-independent and untouched.
 * `parent` is the tree's parent-pointer array (derive it from the children CSR for coarsening /
 * spatial trees, as `Network.treeParent` does — once per tree, not per move). Allocation-free.
 */
export function updateLODPositionsForLeaves(
  tree: LODTree,
  positions: ArrayLike<number>,
  leaves: ArrayLike<number>,
  parent: Int32Array,
): void {
  const { cx, cy, extent, count } = tree;
  for (let k = 0; k < leaves.length; k++) {
    const i = leaves[k]!;
    const nx = positions[i * 2]!;
    const ny = positions[i * 2 + 1]!;
    const dx = nx - cx[i]!;
    const dy = ny - cy[i]!;
    if (dx === 0 && dy === 0) continue;
    cx[i] = nx;
    cy[i] = ny;
    let child = i;
    for (let a = parent[i]!; a !== -1; a = parent[a]!) {
      const inv = 1 / count[a]!; // count ≥ 1 for every tree node
      const ax = cx[a]! + dx * inv;
      const ay = cy[a]! + dy * inv;
      // Grow-only: the centroid moved by |δ|/count (distance to every unmoved child changes by at
      // most that), and the moved child's reach from the new centroid is recomputed exactly.
      const reach = Math.hypot(ax - cx[child]!, ay - cy[child]!) + extent[child]!;
      const grown = extent[a]! + Math.hypot(dx * inv, dy * inv);
      extent[a] = reach > grown ? reach : grown;
      cx[a] = ax;
      cy[a] = ay;
      child = a;
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
  /**
   * **Cross-fade band** (#133): half-width, as a fraction of `expandPx`, of the zoom band around the
   * expand threshold over which an aggregate and its children are drawn *together* — the aggregate
   * easing out (alpha 1→0) as its children ease in (0→1), so a split/merge reads smoothly instead of
   * popping. `0`/absent ⇒ off (the hard threshold, **zero added cost**). When > 0, fill {@link fadeAlpha}.
   */
  fadeBand?: number;
  /**
   * Scratch buffer, indexed by tree-node id (length ≥ `tree.size`), the cut fills with each emitted
   * node's draw alpha when {@link fadeBand} > 0 (only frontier nodes are written; stale entries are
   * never read). Reusable across frames to avoid per-frame GC. Required when `fadeBand > 0`.
   */
  fadeAlpha?: Float32Array;
}

const DEFAULT_EXPAND_PX = 48;

/** Smoothstep (Hermite) ease on [0,1] — the cross-fade ramp (#133), softer than linear at both ends. */
const smoothstep = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Adaptive hierarchy cut: walk the tree top-down for the given view and return the **frontier** —
 * the set of node ids to draw. A subtree is culled when its bounding box misses the viewport; an
 * aggregate expands when its on-screen footprint is large enough, otherwise it is drawn as one
 * glyph; leaves always draw. Work is proportional to the visible frontier, not to the tree size.
 */
/** The visible world rectangle for a transform + viewport (inverse of `screen = world·k + translate`). */
export function visibleWorldRect(t: LODTransform, width: number, height: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const ax = (0 - t.x) / t.k;
  const bx = (width - t.x) / t.k;
  const ay = (0 - t.y) / t.k;
  const by = (height - t.y) / t.k;
  return { minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minY: Math.min(ay, by), maxY: Math.max(ay, by) };
}

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

  const { minX, maxX, minY, maxY } = visibleWorldRect(t, width, height);

  // Cross-fade band (#133): when on, an aggregate whose footprint falls in [lo, hi] is drawn together
  // with its children, alpha-interpolated in opposite directions. The alpha multiplies down the chain
  // (a child in its own band fades within its parent's fade), and is written per emitted node into the
  // scratch `alphaOut`. Off (band 0) ⇒ the alphaStack/ease/writes are all skipped: byte-identical to before.
  const fadeBand = opts.fadeBand ?? 0;
  const fade = fadeBand > 0;
  const lo = expandPx * (1 - fadeBand);
  const hi = expandPx * (1 + fadeBand);
  const alphaOut = opts.fadeAlpha;

  const frontier: number[] = [];
  // Seed the stack with the roots (coarsest level). A parallel alpha stack carries the inherited fade
  // multiplier (only touched when fading).
  const stack: number[] = [];
  const alphaStack: number[] = [];
  for (let g = levelOffset[levelCount - 1]!; g < levelOffset[levelCount]!; g++) {
    stack.push(g);
    if (fade) alphaStack.push(1);
  }
  const emit = (g: number, a: number): void => {
    frontier.push(g);
    if (fade && alphaOut) alphaOut[g] = a;
  };

  while (stack.length > 0) {
    const g = stack.pop()!;
    const a = fade ? alphaStack.pop()! : 1;
    const ext = extent[g]!;
    const gx = cx[g]!;
    const gy = cy[g]!;
    // Cull only when the node's drawn body (bbox grown by its draw radius) misses the viewport, so a
    // glyph stays until its whole body is off-screen.
    const m = ext + drawMargin(g);
    if (gx + m < minX || gx - m > maxX || gy + m < minY || gy - m > maxY) continue;
    if (g < leafCount) {
      emit(g, a); // a real leaf — nothing finer to expand into
      continue;
    }
    const footprint = 2 * ext * t.k;
    // Decide this node's draw alpha (`drawA`) and/or the alpha to expand its children at (`childA`);
    // -1 = "don't". Inlined (no per-node closure) so the off path stays a plain expand/draw split.
    let drawA = -1;
    let childA = -1;
    if (!fade) {
      if (footprint >= expandPx) childA = 1; // expand
      else drawA = 1; // draw as one glyph
    } else if (footprint >= hi) {
      childA = a; // above the band: fully expanded, children inherit `a`
    } else if (footprint >= lo) {
      // In the band: draw the aggregate easing out and its children easing in.
      const aggA = smoothstep((hi - footprint) / (hi - lo)); // 1 at lo → 0 at hi
      drawA = a * aggA;
      childA = a * (1 - aggA);
    } else {
      drawA = a; // below the band: a single aggregate glyph
    }
    if (drawA > 0) emit(g, drawA);
    if (childA > 0) {
      for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) {
        stack.push(children[p]!);
        if (fade) alphaStack.push(childA);
      }
    }
  }

  return Uint32Array.from(frontier);
}

/** Whether a frontier id is a real leaf (vs. an aggregate). */
export function isLeaf(tree: LODTree, g: number): boolean {
  return g < tree.leafCount;
}

/** True when `a` and `b` lie on the same root-to-leaf path — i.e. one is an ancestor of the other. O(depth). */
function onSamePath(a: number, b: number, parent: Int32Array): boolean {
  for (let x = parent[a]!; x >= 0; x = parent[x]!) if (x === b) return true;
  for (let x = parent[b]!; x >= 0; x = parent[x]!) if (x === a) return true;
  return false;
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
  /**
   * Cross-fade alpha (#133), indexed by tree-node id. A glyph mid-transition (`fadeAlpha[g] < 1`) is
   * **exempt** from declutter — it can't be culled by its (also-transitioning) parent nor cull its
   * children, so the split/merge cross-fades smoothly instead of the children popping in after the
   * parent has faded out. Absent ⇒ normal declutter (zero added cost).
   */
  fadeAlpha?: Float32Array;
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
  for (let i = 0; i < F; i++) {
    const g = frontier[i]!;
    const drawn = g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    pr[i] = opts.screenSized ? drawn : drawn * opts.k;
    px[i] = tree.cx[g]! * t.k + t.x;
    py[i] = tree.cy[g]! * t.k + t.y;
  }

  // Visit in descending importance so the most important glyph in a cluster survives, then run the
  // shared greedy declutter (one engine across backends + the geo layers — see core/declutter).
  const order = Array.from({ length: F }, (_, i) => i);
  order.sort((a, b) => tree.weight[frontier[b]!]! - tree.weight[frontier[a]!]!);
  // Cross-fade (#133): a transitioning glyph ignores its ANCESTOR as an occluder, so a fading parent
  // doesn't cull its fading-in children — but children still declutter against siblings (and the parent
  // still occludes unrelated glyphs). Only the fade adds a parent+child pair to the frontier (it's
  // otherwise an antichain), so ancestry alone identifies the pairs; gate on the fade pass for zero cost.
  const par = opts.fadeAlpha ? tree.parent : undefined;
  const ignore = par ? (i: number, j: number) => onSamePath(frontier[i]!, frontier[j]!, par) : undefined;
  const kept = declutterScreen(F, px, py, pr, order, width, height, spacing, new Uint8Array(F), undefined, ignore);

  let n = 0;
  for (let i = 0; i < F; i++) if (kept[i]) n++;
  const out = new Uint32Array(n);
  let w = 0;
  for (let i = 0; i < F; i++) if (kept[i]) out[w++] = frontier[i]!;
  return out;
}

export interface PickOptions {
  /** True when glyphs are screen-pixel sized (`sizeMode: "screen"`); else world radii × k. */
  screenSized: boolean;
  /** Aggregate draw-radius cap (matches {@link frontierCircles}/{@link declutterFrontier}). */
  maxAggregateRadius?: number;
}

/**
 * Hit-test a screen point (CSS px) against the LOD cut **frontier** — the only glyphs on screen — and
 * return the frontier node id under it, or `-1` for a miss. Projects each glyph exactly as
 * {@link frontierCircles}/{@link declutterFrontier} do (`screen = world·k + t`; on-screen radius =
 * `screenSized ? radius : radius·k`, aggregates clamped to `maxAggregateRadius`), so the hit area
 * matches the drawn circle at any zoom. Nodes/aggregates are circles, so point-in-circle is exact.
 *
 * On overlap (declutter off) the **last** containing glyph wins — the frontier is drawn in order and
 * the GPU paints later instances on top, so the last match is the topmost glyph the user sees.
 *
 * O(frontier): the frontier is bounded by the viewport + expand threshold, never the graph size — so
 * this is cheap per pointer event even at 10M nodes. No GPU readback needed (see #105 / #141).
 */
export function pickFrontier(
  tree: LODTree,
  frontier: Uint32Array,
  x: number,
  y: number,
  t: LODTransform,
  opts: PickOptions,
): number {
  const maxAgg = opts.maxAggregateRadius ?? Infinity;
  let found = -1;
  for (let i = 0; i < frontier.length; i++) {
    const g = frontier[i]!;
    const drawn = g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    const pr = opts.screenSized ? drawn : drawn * t.k;
    const dx = x - (tree.cx[g]! * t.k + t.x);
    const dy = y - (tree.cy[g]! * t.k + t.y);
    if (dx * dx + dy * dy <= pr * pr) found = g; // last match = topmost in paint order
  }
  return found;
}

/**
 * Marquee region query over the LOD frontier (#159): the tree-node ids whose **centre** projects inside
 * `rect` (CSS px). Centre-in-rect is sizeMode-independent (only the radius differs), so no `PickOptions`.
 * O(frontier) — bounded by the viewport, like {@link pickFrontier}, so cheap per gesture even at scale.
 */
export function regionFrontier(tree: LODTree, frontier: Uint32Array, rect: ScreenRect, t: LODTransform): number[] {
  const out: number[] = [];
  for (let i = 0; i < frontier.length; i++) {
    const g = frontier[i]!;
    const sx = tree.cx[g]! * t.k + t.x;
    const sy = tree.cy[g]! * t.k + t.y;
    if (sx >= rect.x0 && sx <= rect.x1 && sy >= rect.y0 && sy <= rect.y1) out.push(g);
  }
  return out;
}
