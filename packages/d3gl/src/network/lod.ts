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
import { buildHierarchy, type CoarsenOptions, type Hierarchy } from "./coarsen.js";
import { declutterScreen, declutterScratch, type DeclutterScratch } from "../core/declutter.js";
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
   * whichever the cut makes visible. Between endpoints at different depths (a ragged tree) it also
   * contributes a **lift pair** per level in between, pairing each deeper-side node with the shallower
   * endpoint in the edge's direction (#325), so a depth-4 leaf and a depth-3 leaf are linked directly.
   * Absent for coarsening / spatial trees. @see {@link buildModuleLODTree}
   */
  superEdgeOffset?: Uint32Array;
  superEdgeTarget?: Uint32Array;
  superEdgeFlow?: Float32Array;
  /**
   * Per-node depth below the root (root = 0), length `size` — built and present together with the
   * super-edge CSR. A pair whose endpoints differ in depth is a lift pair (#325); the gather follows it
   * only from its deeper endpoint, so its flow is never counted twice. @see {@link buildSuperEdges}
   */
  depth?: Int32Array;
  /**
   * Provided-module trees only (#197/#324): each tree node's last Infomap path entry — a module's branch
   * id within its parent, a leaf's rank in its module; `-1` for the root. With {@link parent} it spells
   * any node's path (walk up, collecting entries) — so an aggregate can be named by its module.
   */
  branch?: Int32Array;
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
  /**
   * The **module links** (#199) indexed by their own endpoints (#329), for anchoring a link at an
   * expanded module's boundary: aggregate `g`'s outgoing links are
   * `[moduleLinkOffset[g − leafCount] .. moduleLinkOffset[g − leafCount + 1])` → `moduleLinkTarget`
   * with `moduleLinkFlow`, its incoming ones the same in the `moduleLinkIn*` arrays. Summed per
   * ordered pair; a link inside one subtree (into an endpoint's own ancestor) is left out, as in the
   * super-edge CSR. Rows exist for aggregates only (a leaf is never expanded), so each offsets array
   * has `size − leafCount + 1` entries. Present only on a module tree built with module links — graph
   * edges never enter it. @see {@link buildModuleLODTree}
   */
  moduleLinkOffset?: Uint32Array;
  moduleLinkTarget?: Uint32Array;
  moduleLinkFlow?: Float32Array;
  moduleLinkInOffset?: Uint32Array;
  moduleLinkInSource?: Uint32Array;
  moduleLinkInFlow?: Float32Array;
  /**
   * **Contiguous leaf ranges** (#343): the leaves in an order where every tree node's leaf descendants
   * are one run — node `g` covers `leafOrder[leafStart[g] .. leafEnd[g])`. A leaf's own run is its rank
   * (`leafEnd = leafStart + 1`), so two nodes are nested iff their runs overlap. Present on a spatial
   * (Morton) tree ({@link buildMortonLODTree}), where it lets the super-edge gather walk a glyph's leaves
   * without a super-edge CSR; absent on coarsening and module trees.
   */
  leafOrder?: Uint32Array;
  /** Per-node first rank into {@link leafOrder}, length `size` (a leaf's is its own rank). */
  leafStart?: Uint32Array;
  /** Per-node rank one past its last leaf in {@link leafOrder}, length `size`. */
  leafEnd?: Uint32Array;
  /** A spatial (Morton) tree's cells (#343): each aggregate's square in the root box. @see {@link MortonCells} */
  morton?: MortonCells;
}

/**
 * A power-of-two square the spatial LOD tree quantises positions into (#343): `[x0, x0 + side)` ×
 * `[y0, y0 + side)`. `side` is a power of two and the corner a multiple of `side / 4`, so every cell two or
 * more levels down is a square of the one global power-of-two grid, whatever box it was cut from.
 */
export interface MortonBox {
  x0: number;
  y0: number;
  side: number;
}

/**
 * The cells of a spatial (Morton) LOD tree (#343). Aggregate `g` (index `g − leafCount`) is the square
 * `level[o]` levels below the root {@link box} whose Morton prefix is `code[o]` — the longest prefix all its
 * leaves share, 16 bits per axis interleaved and left-aligned in 32 bits (the low `32 − 2·level` bits are
 * zero). A cell names the same square in every tree built in the same box, so an aggregate can be found
 * again after a rebuild ({@link findMortonCell}).
 */
export interface MortonCells {
  box: MortonBox;
  level: Uint8Array;
  code: Uint32Array;
}

/**
 * Each module's **disc** from a nested layout (#329), per aggregate (index `g − leafCount`): its centre
 * as an offset (`dx`, `dy`) from the module's leaf centroid, and its radius `r`, in world units
 * (`nestedBoundaryDiscs` gives these). Passed to {@link computeLODPositions}, they become the module's
 * LOD geometry — `cx`/`cy` the disc centre, `extent` the disc radius — so the cut culls and expands a
 * module by its disc, and its boundary ring is drawn on it. Keeping the centre relative to the centroid
 * lets the disc follow its members through a drag or a position transition.
 */
export interface BoundaryDiscs {
  dx: Float32Array;
  dy: Float32Array;
  r: Float32Array;
}

/**
 * The **expanded** aggregates a {@link cut} collects for the module-boundary rings (#329). Pass one as
 * {@link CutOptions.boundaries}; each cut overwrites `ids` / `alpha` / `count` (the arrays grow on demand
 * and are reused — keep one per engine, from {@link makeCutBoundaries}).
 */
export interface CutBoundaries {
  /**
   * The ring radius per aggregate (index `g − leafCount`) for the ring drawers — a nested layout's disc
   * radii ({@link BoundaryDiscs.r}), for a tree whose geometry they placed. Absent ⇒ `extent`. The cut
   * never reads it: it tests the tree's `cx`/`cy`/`extent`.
   */
  radius?: Float32Array;
  /** Output: the expanded aggregates whose boundary meets the view — only `ids[0 .. count)` is valid. */
  ids: Uint32Array;
  /** Output, parallel to `ids`: the alpha each one's children are drawn at (1 without a cross-fade). */
  alpha: Float32Array;
  /** Output: how many were collected. */
  count: number;
}

/** A fresh, empty {@link CutBoundaries} collector. */
export function makeCutBoundaries(): CutBoundaries {
  return { ids: new Uint32Array(64), alpha: new Float32Array(64), count: 0 };
}

/**
 * A module's boundary circle (#329) — the circle its ring is drawn on: centred on the module (`cx`/`cy`,
 * the disc centre when a nested layout placed it), with radius `radius` when given (the disc's, see
 * {@link CutBoundaries.radius}), else `extent`. Written into `out` as `[x, y, r]` (world units); O(1).
 */
export function boundaryCircle(tree: LODTree, g: number, radius: Float32Array | undefined, out: Float64Array): void {
  out[0] = tree.cx[g]!;
  out[1] = tree.cy[g]!;
  out[2] = radius ? radius[g - tree.leafCount]! : tree.extent[g]!;
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
  /**
   * **Leaf-level branching** (#191): how many children the aggregate that owns a *typical leaf* has —
   * the median child count of the leaf-parents, weighted by how many leaves each owns. `2` for a
   * binary coarsening tree, `1` for a quadtree bottom cell, `30`–`600` for a provided module
   * partition. Pure topology, so it is computed **once per tree at build** ({@link leafBranchingOf})
   * and never changes as the layout converges. Drives the adaptive default expand threshold —
   * see {@link defaultExpandPx}.
   */
  leafBranching: number;
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
 * meet, summing flow per ordered pair. When `u` and `v` sit at **different depths** (a ragged module
 * tree), equalising depth adds a **lift pair** at each step, pairing the deeper side's node at that step
 * with the shallower endpoint in the edge's direction (#325), so the edge is linked wherever its deeper
 * side is visible below the shallower endpoint's depth (a depth-4 leaf to a depth-3 leaf). An edge from a node into its own
 * ancestor lies inside one subtree at every cut and contributes nothing. Tree-generic — works for a
 * coarsening tree or a module tree (it only needs `parent`, with parent ids greater than child ids).
 * The cut renders whichever level is visible. Both the **out**-adjacency (by source) and the
 * **in**-adjacency (the transpose, by target) are returned, so the gather can keep a visible node's
 * edges to off-screen neighbours symmetrically — outgoing (walk the node's out-edges) *and* incoming
 * (walk its in-edges) — without re-scanning off-screen sources (#104: WebGL incoming-link culling fix).
 * The per-node `depth` is returned with them: the gather tells a lift pair by its endpoints' depths.
 */
export function buildSuperEdges(
  size: number,
  parent: Int32Array,
  edges: SuperEdgeInput,
): Pick<LODTopology, "superEdgeOffset" | "superEdgeTarget" | "superEdgeFlow" | "superEdgeInOffset" | "superEdgeInSource" | "superEdgeInFlow" | "depth"> {
  // Depth from root. Parents have higher ids than children, so a single descending pass finalises each
  // parent before its children.
  const depth = new Int32Array(size);
  for (let g = size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;

  // Aggregate the directed pairs with a flat typed-array counting sort instead of a
  // `Map<number, number>` keyed by `a * size + b` (#177). V8 caps a Map at 2²⁴ entries, and a ~1M-leaf
  // hierarchy produces more distinct (ancestor-a, ancestor-b) pairs than that summed over its levels —
  // `.set()` threw `RangeError: Map maximum size exceeded` and LOD init died before the first frame.
  // `coarsen.ts` `coarsenLevel` already solved exactly this the same way. Bucket every contribution by
  // its source `a` (pass 1 counts, pass 2 scatters), then sum duplicates within each bucket via a
  // per-`a` mark. No hashing, no boxing, no composite key, and no entry ceiling.
  const m = edges.source.length;

  // Pass 1 — contributions per source ancestor. Walking the chains twice (count, then scatter) is
  // still cheaper than one walk through a Map: every step here is a typed-array increment.
  const outDeg = new Uint32Array(size);
  let contributions = 0;
  for (let e = 0; e < m; e++) {
    let a = edges.source[e]!;
    let b = edges.target[e]!;
    if (a === b) continue; // self-loop
    // Equalise depth: lift the deeper endpoint to the shallower one's depth (only one side moves).
    let la = a;
    let lb = b;
    while (depth[la]! > depth[b]!) la = parent[la]!;
    while (depth[lb]! > depth[a]!) lb = parent[lb]!;
    if (la === lb) continue; // one endpoint is the other's ancestor: inside one subtree at every cut
    // Lift pairs (#325): each node the lift passes → the shallower endpoint (deeper source → b, or a → deeper target).
    for (let x = a; x !== la; x = parent[x]!) {
      outDeg[x] = outDeg[x]! + 1;
      contributions++;
    }
    for (let y = b; y !== lb; y = parent[y]!) {
      outDeg[a] = outDeg[a]! + 1;
      contributions++;
    }
    a = la;
    b = lb;
    while (a !== b) {
      outDeg[a] = outDeg[a]! + 1;
      contributions++;
      a = parent[a]!;
      b = parent[b]!;
    }
  }

  const bucketOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) bucketOffset[g + 1] = bucketOffset[g]! + outDeg[g]!;
  // Duplicates included; compacted in place by pass 3, so these double as the output arrays.
  const bucketTarget = new Uint32Array(contributions);
  const bucketFlow = new Float32Array(contributions);
  const cursor = bucketOffset.slice(0, size);

  // Pass 2 — scatter each contribution into its source's bucket.
  for (let e = 0; e < m; e++) {
    let a = edges.source[e]!;
    let b = edges.target[e]!;
    if (a === b) continue;
    const w = edges.weight[e]!;
    let la = a;
    let lb = b;
    while (depth[la]! > depth[b]!) la = parent[la]!;
    while (depth[lb]! > depth[a]!) lb = parent[lb]!;
    if (la === lb) continue;
    for (let x = a; x !== la; x = parent[x]!) {
      const p = cursor[x]!;
      cursor[x] = p + 1;
      bucketTarget[p] = b;
      bucketFlow[p] = w;
    }
    for (let y = b; y !== lb; y = parent[y]!) {
      const p = cursor[a]!;
      cursor[a] = p + 1;
      bucketTarget[p] = y;
      bucketFlow[p] = w;
    }
    a = la;
    b = lb;
    while (a !== b) {
      const p = cursor[a]!;
      cursor[a] = p + 1;
      bucketTarget[p] = b;
      bucketFlow[p] = w;
      a = parent[a]!;
      b = parent[b]!;
    }
  }

  // Pass 3 — sum duplicates within each bucket. `mark[b] === a` means "b already emitted in a's row".
  // Compacts in place: the write cursor `w` never overtakes the read cursor `p` (w <= p always), and
  // both entries are read before the write, so the deduped rows overwrite the bucket arrays safely.
  const superEdgeOffset = new Uint32Array(size + 1);
  const mark = new Int32Array(size).fill(-1);
  const slot = new Uint32Array(size);
  let w = 0;
  for (let a = 0; a < size; a++) {
    for (let p = bucketOffset[a]!; p < bucketOffset[a + 1]!; p++) {
      const b = bucketTarget[p]!;
      const flow = bucketFlow[p]!;
      if (mark[b] !== a) {
        mark[b] = a;
        slot[b] = w;
        bucketTarget[w] = b;
        bucketFlow[w] = flow;
        w++;
      } else {
        const at = slot[b]!;
        bucketFlow[at] = bucketFlow[at]! + flow;
      }
    }
    superEdgeOffset[a + 1] = w;
  }
  const total = w;
  // Exact-size copies so the oversized (duplicate-inclusive) buffers can be collected.
  const superEdgeTarget = bucketTarget.slice(0, total);
  const superEdgeFlow = bucketFlow.slice(0, total);

  // Transpose: the same pairs grouped by *target*, so a visible node can find its incoming edges
  // (whose source may be off-screen) without scanning off-screen sources' out-lists.
  const superEdgeInOffset = new Uint32Array(size + 1);
  for (let i = 0; i < total; i++) superEdgeInOffset[superEdgeTarget[i]! + 1]!++;
  for (let g = 0; g < size; g++) superEdgeInOffset[g + 1] = superEdgeInOffset[g + 1]! + superEdgeInOffset[g]!;
  const superEdgeInSource = new Uint32Array(total);
  const superEdgeInFlow = new Float32Array(total);
  const inCursor = superEdgeInOffset.slice(0, size);
  for (let a = 0; a < size; a++) {
    for (let p = superEdgeOffset[a]!; p < superEdgeOffset[a + 1]!; p++) {
      const b = superEdgeTarget[p]!;
      const pos = inCursor[b]!;
      superEdgeInSource[pos] = a;
      superEdgeInFlow[pos] = superEdgeFlow[p]!;
      inCursor[b] = pos + 1;
    }
  }
  return { superEdgeOffset, superEdgeTarget, superEdgeFlow, superEdgeInOffset, superEdgeInSource, superEdgeInFlow, depth };
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

/** Child-count histogram width for {@link leafBranchingOf} — 16 KB of transient scratch, once per
 *  tree build. Aggregates with more children than this all land in the last bucket; the threshold it
 *  feeds is clamped well below what such a branching would ask for anyway. */
const BRANCHING_BUCKETS = 4096;

/**
 * The tree's **leaf-level branching** (see {@link LODTree.leafBranching}): the median number of
 * children of the aggregates that own leaves, **weighted by how many leaves each owns** — i.e. what
 * the finest aggregate a typical *node* sits in would split into. Weighting by leaf children (rather
 * than counting aggregates) is what makes it robust in both directions: a coarsening tree's rare
 * mixed-level parent (one stray leaf riding up several levels beside big sub-aggregates) carries a
 * weight of 1 and can't drag it up, and a partition of a few big modules plus a long tail of
 * singletons can't drag it down to 1.
 *
 * Exact and allocation-light: one pass over the children CSR — O(tree size), i.e. ~2·nodeCount for a
 * binary coarsening tree — plus a fixed {@link BRANCHING_BUCKETS}-entry histogram, no sort. Pure
 * topology (no positions read), so it is computed **once per tree at build** and stays valid for the
 * life of the tree, however the layout moves.
 */
function leafBranchingOf(topo: LODTopology): number {
  const { size, leafCount, childOffset, children } = topo;
  const hist = new Uint32Array(BRANCHING_BUCKETS);
  let total = 0;
  for (let g = leafCount; g < size; g++) {
    const c0 = childOffset[g]!;
    const c1 = childOffset[g + 1]!;
    let leafKids = 0;
    for (let p = c0; p < c1; p++) if (children[p]! < leafCount) leafKids++;
    if (leafKids === 0) continue; // not a leaf-parent — its children are aggregates
    const b = Math.min(c1 - c0, BRANCHING_BUCKETS - 1);
    hist[b] = (hist[b] ?? 0) + leafKids;
    total += leafKids;
  }
  if (total === 0) return 1; // a single-level tree (no aggregates): nothing to expand into
  let acc = 0;
  for (let b = 0; b < BRANCHING_BUCKETS; b++) {
    acc += hist[b] ?? 0;
    if (acc * 2 >= total) return b;
  }
  return 1;
}

function attachGeometry(topo: LODTopology): LODTree {
  const { size } = topo;
  return {
    ...topo,
    leafBranching: leafBranchingOf(topo),
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
   * Leaves per bottom cell (#343): a cell holding at most this many leaves is not split further. Default
   * 8 — the measured knee between build time and frontier size (4-64 moves the build by only ~2×).
   * Coincident points share one bottom cell whatever its size.
   */
  bucket?: number;
  /**
   * Cap on cell depth below the root box: a cell this deep is a bottom cell whatever its size. Positions
   * are quantised to 16 bits per axis, so depths past 16 change nothing. Default 16.
   */
  maxDepth?: number;
}

/** Leaves per bottom cell of a spatial tree (#343) — see {@link SpatialLODOptions.bucket}. */
const SPATIAL_BUCKET = 8;
/** Bits per axis of a Morton code; a cell is at most this many levels below the root box. */
const MORTON_BITS = 16;
/** Quantisation steps per axis (`2^16`). */
const MORTON_STEPS = 1 << MORTON_BITS;

/**
 * The root box for a spatial tree over `positions` (#343): a power-of-two square, its corner on a
 * multiple of a quarter of its side, holding every finite position. With `prev` — the box the previous
 * build used — it returns `prev` itself while every position still lies inside it and the layout still
 * fills more than an eighth of its side, so a streamed layout rebuilds over the **same cells** frame to
 * frame (only their membership changes) and an aggregate can be found again by its cell. O(count).
 * A non-finite coordinate (NaN, or ±Infinity from a diverged layout) is left out of the box and clamped
 * into an edge cell by the build, so one diverged node cannot collapse every other into a single cell.
 */
export function mortonRootBox(positions: ArrayLike<number>, count: number, prev?: MortonBox): MortonBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    // `v > -Infinity && v < Infinity` is false for NaN and both infinities.
    if (x > -Infinity && x < Infinity) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (y > -Infinity && y < Infinity) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!(maxX >= minX) || !(maxY >= minY)) return prev ?? { x0: 0, y0: 0, side: 1 }; // no finite position
  const span = Math.max(maxX - minX, maxY - minY);
  if (prev && minX >= prev.x0 && minY >= prev.y0 && maxX < prev.x0 + prev.side && maxY < prev.y0 + prev.side && span * 8 > prev.side) return prev;
  // side ≥ 4/3 · span with the corner on a quarter-side grid: the corner sits < side/4 below the minimum,
  // so the maximum stays < side above it. A zero span (one point, or all coincident) gets side 1.
  const side = span > 0 ? 2 ** Math.ceil(Math.log2((span * 4) / 3)) : 1;
  const unit = side / 4;
  const box = { x0: Math.floor(minX / unit) * unit, y0: Math.floor(minY / unit) * unit, side };
  // log2 rounding can leave the box a hair short: double until it holds the maximum (at most once).
  while (maxX >= box.x0 + box.side || maxY >= box.y0 + box.side) {
    box.side *= 2;
    box.x0 = Math.floor(minX / (box.side / 4)) * (box.side / 4);
    box.y0 = Math.floor(minY / (box.side / 4)) * (box.side / 4);
  }
  return box;
}

/** Spread the low 16 bits of `v` to the even bit positions (the Morton interleave of one axis). */
function spreadBits(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x;
}

/** The inverse of {@link spreadBits}: gather the even bits of `v` into 16 bits. */
function gatherBits(v: number): number {
  let x = v & 0x55555555;
  x = (x | (x >>> 1)) & 0x33333333;
  x = (x | (x >>> 2)) & 0x0f0f0f0f;
  x = (x | (x >>> 4)) & 0x00ff00ff;
  x = (x | (x >>> 8)) & 0x0000ffff;
  return x;
}

/** The mask keeping the top `2·level` bits of a 32-bit Morton code (level 0 keeps none). */
function mortonMask(level: number): number {
  return level <= 0 ? 0 : (~0 << (32 - 2 * level)) >>> 0;
}

/** The depth of the longest 2-bit prefix two Morton codes share (16 when they are equal). */
function commonLevel(a: number, b: number): number {
  return a === b ? MORTON_BITS : Math.clz32((a ^ b) >>> 0) >>> 1;
}

/**
 * Reusable working storage for {@link buildMortonLODTree} (#343): the codes, the radix sort's key and
 * index buffers and histogram, and the cell records of the compressed quadtree. Grown on demand to the
 * largest build and reused, so a layout that rebuilds its tree every streamed frame allocates nothing
 * here once warm — about 16 B per leaf plus 13 B per cell, and a 256 KB histogram.
 */
export interface MortonScratch {
  keyA: Uint32Array;
  keyB: Uint32Array;
  idxA: Uint32Array;
  idxB: Uint32Array;
  hist: Uint32Array;
  cellLo: Uint32Array;
  cellHi: Uint32Array;
  cellParent: Int32Array;
  cellBottom: Uint8Array;
  cellHeight: Uint8Array;
  cellId: Uint32Array;
  stackLo: Uint32Array;
  stackHi: Uint32Array;
  stackParent: Int32Array;
}

/** Deepest the cell walk's stack gets: ≤ 3 pending siblings per split level plus the 4 of the last split. */
const MORTON_STACK = 4 * MORTON_BITS + 8;

/** A fresh, empty {@link MortonScratch}. */
export function makeMortonScratch(): MortonScratch {
  return {
    keyA: new Uint32Array(0),
    keyB: new Uint32Array(0),
    idxA: new Uint32Array(0),
    idxB: new Uint32Array(0),
    hist: new Uint32Array(MORTON_STEPS + 1),
    cellLo: new Uint32Array(0),
    cellHi: new Uint32Array(0),
    cellParent: new Int32Array(0),
    cellBottom: new Uint8Array(0),
    cellHeight: new Uint8Array(0),
    cellId: new Uint32Array(0),
    stackLo: new Uint32Array(MORTON_STACK),
    stackHi: new Uint32Array(MORTON_STACK),
    stackParent: new Int32Array(MORTON_STACK),
  };
}

/**
 * The arrays of a spatial (Morton) topology (#343), sized by {@link MortonTopologySizes}. {@link
 * buildMortonTopology} writes into them; a caller that owns the memory (the layout worker, which packs one
 * streamed frame into one transferable buffer) supplies them through {@link MortonAllocate}.
 */
export interface MortonTopologyArrays {
  levelOffset: Uint32Array;
  childOffset: Uint32Array;
  children: Uint32Array;
  parent: Int32Array;
  leafOrder: Uint32Array;
  leafStart: Uint32Array;
  leafEnd: Uint32Array;
  mortonLevel: Uint8Array;
  mortonCode: Uint32Array;
}

/** The sizes a spatial topology's arrays need (see {@link MortonTopologyArrays}). */
export interface MortonTopologySizes {
  size: number;
  leafCount: number;
  levelCount: number;
}

/** Hands {@link buildMortonTopology} the arrays to write a topology of the given sizes into. */
export type MortonAllocate = (sizes: MortonTopologySizes) => MortonTopologyArrays;

/** Allocate a spatial topology's arrays as separate typed arrays. */
export function allocateMortonTopology({ size, leafCount, levelCount }: MortonTopologySizes): MortonTopologyArrays {
  const cells = size - leafCount;
  return {
    levelOffset: new Uint32Array(levelCount + 1),
    childOffset: new Uint32Array(size + 1),
    children: new Uint32Array(Math.max(0, size - 1)),
    parent: new Int32Array(size),
    leafOrder: new Uint32Array(leafCount),
    leafStart: new Uint32Array(size),
    leafEnd: new Uint32Array(size),
    mortonLevel: new Uint8Array(cells),
    mortonCode: new Uint32Array(cells),
  };
}

/**
 * A shared, all-zero `Uint32Array` of at least `length` entries, viewed to exactly `length`: the empty
 * same-level adjacency (`edgeOffset`) a spatial tree has — no CSR entries anywhere. Shared by every
 * spatial tree so a tree rebuilt per streamed frame does not allocate one; nothing writes to it.
 */
let zeroOffsets = new Uint32Array(0);
function sharedZeroOffsets(length: number): Uint32Array {
  if (zeroOffsets.length < length) zeroOffsets = new Uint32Array(Math.max(length, zeroOffsets.length * 2));
  return zeroOffsets.subarray(0, length);
}
const NO_NEIGHBORS = new Uint32Array(0);

/** Options for {@link buildMortonTopology}: the {@link SpatialLODOptions} plus the root box to build in. */
export interface MortonLODOptions extends SpatialLODOptions {
  /** The root box (default {@link mortonRootBox} over the positions). Pass the previous build's box
   *  through {@link mortonRootBox} to keep the cells stable while a layout streams. */
  box?: MortonBox;
}

/** LSD radix sort of `count` 32-bit keys in two 16-bit passes; the sorted keys and their source indices
 *  end back in `sc.keyA` / `sc.idxA` (an even number of passes). O(count), no comparisons. */
function radixSortMorton(sc: MortonScratch, count: number): void {
  const hist = sc.hist;
  let kSrc = sc.keyA;
  let iSrc = sc.idxA;
  let kDst = sc.keyB;
  let iDst = sc.idxB;
  for (let shift = 0; shift < 32; shift += MORTON_BITS) {
    hist.fill(0);
    for (let i = 0; i < count; i++) hist[((kSrc[i]! >>> shift) & 0xffff) + 1]!++;
    for (let d = 0; d < MORTON_STEPS; d++) hist[d + 1] = hist[d + 1]! + hist[d]!;
    for (let i = 0; i < count; i++) {
      const k = kSrc[i]!;
      const d = (k >>> shift) & 0xffff;
      const at = hist[d]!;
      hist[d] = at + 1;
      kDst[at] = k;
      iDst[at] = iSrc[i]!;
    }
    const tk = kSrc; kSrc = kDst; kDst = tk;
    const ti = iSrc; iSrc = iDst; iDst = ti;
  }
}

/** First index in `keys[lo, hi)` (sorted ascending) whose key is ≥ `key`. */
function lowerBound(keys: Uint32Array, lo: number, hi: number, key: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Grow the scratch's per-cell arrays to `cap` cells, keeping the walk's records so far. */
function growCells(sc: MortonScratch, cap: number): void {
  const lo = new Uint32Array(cap); lo.set(sc.cellLo); sc.cellLo = lo;
  const hi = new Uint32Array(cap); hi.set(sc.cellHi); sc.cellHi = hi;
  const par = new Int32Array(cap); par.set(sc.cellParent); sc.cellParent = par;
  const bot = new Uint8Array(cap); bot.set(sc.cellBottom); sc.cellBottom = bot;
  sc.cellHeight = new Uint8Array(cap); // filled after the walk
  sc.cellId = new Uint32Array(cap); // filled after the walk
}

/**
 * Build a **spatial LOD tree**'s topology over `positions` (#343): a compressed, bucketed quadtree cut from
 * one sort of the leaves' Morton codes. Each position is quantised to 16 bits per axis inside the root box
 * ({@link MortonLODOptions.box}), the codes are radix-sorted (two 16-bit passes), and the tree is read off
 * the sorted run: a run of at most `bucket` leaves — or of coincident ones — is a bottom cell whose
 * children are its leaves; a longer run splits at the first 2-bit group its first and last codes differ
 * in, so single-child chains never appear. Every node therefore covers one contiguous run of the sorted
 * leaves ({@link LODTopology.leafOrder} / `leafStart` / `leafEnd`), and each aggregate records its cell
 * ({@link LODTopology.morton}). Cells are bucketed into levels by height, as for any LOD tree, so the cut,
 * the geometry passes and declutter apply unchanged; there is no super-edge CSR (the gather walks the leaf
 * runs instead).
 *
 * Unlike the coarsening tree, an aggregate is always a compact region of the layout, so the cut frontier
 * stays bounded by the screen area over the expand threshold rather than by how the layout spreads a
 * graph's communities. O(count) for the codes and the sort plus O(cells · log bucket) for the splits;
 * with `scratch` ({@link makeMortonScratch}) a rebuild allocates only the topology — and with `allocate`
 * (the caller's own buffers) nothing at all. Geometry is left for {@link computeLODPositions}.
 */
export function buildMortonTopology(
  positions: ArrayLike<number>,
  count: number,
  opts: MortonLODOptions = {},
  scratch: MortonScratch = makeMortonScratch(),
  allocate: MortonAllocate = allocateMortonTopology,
): LODTopology & MortonTopologyArrays & { morton: MortonCells } {
  const bucket = Math.max(1, opts.bucket ?? SPATIAL_BUCKET);
  const maxDepth = Math.max(0, Math.min(MORTON_BITS, opts.maxDepth ?? MORTON_BITS));
  const box = opts.box ?? mortonRootBox(positions, count);
  const sc = scratch;
  // ≤ 1 leaf: nothing to aggregate — a single-level tree of just the leaves (no cells).
  if (count <= 1) {
    const a = allocate({ size: count, leafCount: count, levelCount: 1 });
    a.levelOffset[0] = 0;
    a.levelOffset[1] = count;
    a.childOffset.fill(0);
    if (count === 1) { a.parent[0] = -1; a.leafOrder[0] = 0; a.leafStart[0] = 0; a.leafEnd[0] = 1; }
    return { ...a, size: count, leafCount: count, levelCount: 1, edgeOffset: sharedZeroOffsets(count + 1), edgeNeighbors: NO_NEIGHBORS, morton: { box, level: a.mortonLevel, code: a.mortonCode } };
  }

  // 1. Codes: quantise into the box (NaN → cell 0), interleave x (even bits) and y (odd bits).
  if (sc.keyA.length < count) {
    sc.keyA = new Uint32Array(count);
    sc.keyB = new Uint32Array(count);
    sc.idxA = new Uint32Array(count);
    sc.idxB = new Uint32Array(count);
  }
  const scale = MORTON_STEPS / box.side;
  const keys = sc.keyA;
  const idx = sc.idxA;
  for (let i = 0; i < count; i++) {
    const fx = (positions[i * 2]! - box.x0) * scale;
    const fy = (positions[i * 2 + 1]! - box.y0) * scale;
    const qx = fx >= 0 ? (fx < MORTON_STEPS ? fx | 0 : MORTON_STEPS - 1) : 0;
    const qy = fy >= 0 ? (fy < MORTON_STEPS ? fy | 0 : MORTON_STEPS - 1) : 0;
    keys[i] = (spreadBits(qx) | (spreadBits(qy) << 1)) >>> 0;
    idx[i] = i;
  }
  // 2. Sort the leaves by code.
  radixSortMorton(sc, count);
  const sorted = sc.keyA;
  const order = sc.idxA;

  // 3. Cells, pre-order over the sorted run (an explicit stack; siblings pushed last-first so they are
  //    created — and later listed — in Morton order). A cell is a bottom cell when its run holds at most
  //    `bucket` leaves, all its codes are equal, or it is `maxDepth` deep; else it splits at the first
  //    2-bit group its first and last codes differ in, into the (≥ 2) non-empty quadrants.
  if (sc.cellLo.length === 0) growCells(sc, Math.max(64, ((count / bucket) * 2) | 0));
  const { stackLo, stackHi, stackParent } = sc;
  let cells = 0;
  let sp = 1;
  stackLo[0] = 0;
  stackHi[0] = count;
  stackParent[0] = -1;
  while (sp > 0) {
    sp--;
    const lo = stackLo[sp]!;
    const hi = stackHi[sp]!;
    if (cells === sc.cellLo.length) growCells(sc, cells * 2);
    const c = cells++;
    sc.cellLo[c] = lo;
    sc.cellHi[c] = hi;
    sc.cellParent[c] = stackParent[sp]!;
    const first = sorted[lo]!;
    const level = commonLevel(first, sorted[hi - 1]!);
    if (hi - lo <= bucket || level >= maxDepth) {
      sc.cellBottom[c] = 1;
      continue;
    }
    sc.cellBottom[c] = 0;
    const shift = 30 - 2 * level;
    const prefix = (first & mortonMask(level)) >>> 0;
    let end = hi;
    for (let q = 3; q >= 1; q--) {
      const start = lowerBound(sorted, lo, end, (prefix | (q << shift)) >>> 0);
      if (end > start) { stackLo[sp] = start; stackHi[sp] = end; stackParent[sp] = c; sp++; }
      end = start;
    }
    if (end > lo) { stackLo[sp] = lo; stackHi[sp] = end; stackParent[sp] = c; sp++; }
  }

  // 4. Heights (pre-order: a cell's children follow it, so one reverse pass).
  const { cellLo, cellHi, cellParent, cellBottom, cellHeight, cellId } = sc;
  cellHeight.fill(0, 0, cells);
  for (let c = cells - 1; c >= 0; c--) {
    if (cellBottom[c] === 1) cellHeight[c] = 1;
    const p = cellParent[c]!;
    if (p >= 0 && cellHeight[p]! < cellHeight[c]! + 1) cellHeight[p] = cellHeight[c]! + 1;
  }
  const maxHeight = cellHeight[0]!; // the root is the tallest
  const levelCount = maxHeight + 1;
  const size = count + cells;
  const a = allocate({ size, leafCount: count, levelCount });
  const { levelOffset, childOffset, children, parent, leafOrder, leafStart, leafEnd, mortonLevel, mortonCode } = a;

  // 5. Level offsets (leaves, then cells by height) and each cell's global id, handed out per height in
  //    creation order.
  levelOffset.fill(0);
  for (let c = 0; c < cells; c++) levelOffset[cellHeight[c]! + 1]!++;
  levelOffset[1] = count;
  for (let h = 1; h <= maxHeight; h++) levelOffset[h + 1] = levelOffset[h + 1]! + levelOffset[h]!;
  const next = levelOffset.slice(0, levelCount); // per-height id cursor (tiny: one entry per level)
  for (let c = 0; c < cells; c++) {
    const h = cellHeight[c]!;
    cellId[c] = next[h]!;
    next[h] = next[h]! + 1;
  }

  // 6. Children CSR: a bottom cell parents its run's leaves, an internal cell its child cells.
  childOffset.fill(0);
  for (let c = 0; c < cells; c++) {
    if (cellBottom[c] === 1) childOffset[cellId[c]! + 1] = cellHi[c]! - cellLo[c]!;
    const p = cellParent[c]!;
    if (p >= 0) childOffset[cellId[p]! + 1]!++;
  }
  for (let g = 0; g < size; g++) childOffset[g + 1] = childOffset[g + 1]! + childOffset[g]!;
  // Scatter in creation order (an internal cell lists its children in Morton order; a bottom cell its
  // leaves in rank order), with the parents, leaf runs and cells alongside. `leafEnd` doubles as the
  // children cursor until the leaf runs are written.
  const fill = leafEnd;
  for (let g = count; g < size; g++) fill[g] = childOffset[g]!;
  for (let c = 0; c < cells; c++) {
    const g = cellId[c]!;
    const lo = cellLo[c]!;
    const hi = cellHi[c]!;
    const p = cellParent[c]!;
    if (p >= 0) {
      const pg = cellId[p]!;
      parent[g] = pg;
      children[fill[pg]!] = g;
      fill[pg] = fill[pg]! + 1;
    } else {
      parent[g] = -1;
    }
    if (cellBottom[c] === 1) {
      for (let r = lo; r < hi; r++) {
        const leaf = order[r]!;
        children[fill[g]!] = leaf;
        fill[g] = fill[g]! + 1;
        parent[leaf] = g;
      }
    }
    const first = sorted[lo]!;
    const level = commonLevel(first, sorted[hi - 1]!);
    mortonLevel[g - count] = level;
    mortonCode[g - count] = (first & mortonMask(level)) >>> 0;
  }
  for (let c = 0; c < cells; c++) {
    const g = cellId[c]!;
    leafStart[g] = cellLo[c]!;
    leafEnd[g] = cellHi[c]!;
  }
  for (let r = 0; r < count; r++) {
    const leaf = order[r]!;
    leafOrder[r] = leaf;
    leafStart[leaf] = r;
    leafEnd[leaf] = r + 1;
  }
  return { ...a, size, leafCount: count, levelCount, edgeOffset: sharedZeroOffsets(size + 1), edgeNeighbors: NO_NEIGHBORS, morton: { box, level: mortonLevel, code: mortonCode } };
}

/**
 * A spatial LOD tree over `positions`, ready for geometry (#343) — {@link buildMortonTopology} with the
 * tree's geometry arrays attached (zeroed; fill them with {@link computeLODGeometry}). The spatial source
 * (`lod({ source: "spatial" })`) on the main thread, and the tree of an edge-less graph. Pass a `scratch`
 * ({@link makeMortonScratch}) to reuse the sort buffers across rebuilds.
 */
export function buildMortonLODTree(positions: ArrayLike<number>, count: number, opts: MortonLODOptions = {}, scratch?: MortonScratch): LODTree {
  return attachGeometry(buildMortonTopology(positions, count, opts, scratch));
}

/**
 * Build a {@link LODTree} from a point cloud's positions alone — the spatial tree used as the LOD
 * hierarchy when there are no edges to coarsen (#103). The structural coarsening tree needs edges
 * (heavy-edge matching), so an edge-less graph would otherwise yield a single-level tree whose
 * {@link cut} degenerates to O(N) per frame with no aggregation; the spatial tree restores hierarchical
 * culling (O(visible)) and zoom-out aggregation. Since #343 this is the bucketed Morton tree of
 * {@link buildMortonLODTree} (up to 8 points per bottom cell by default) rather than a pointer quadtree
 * with one point per cell: one sort instead of a pointer chase per point, and a smaller, shallower tree.
 *
 * Generic over any positions buffer (not network-specific), so the same point-cloud LOD can back
 * other engines later (`plot.points()` / map scatter, #108).
 */
export function buildSpatialLODTree(positions: ArrayLike<number>, count: number, opts: SpatialLODOptions = {}): LODTree {
  return buildMortonLODTree(positions, count, opts);
}

/**
 * The node of a spatial tree that holds the cell `(level, code)` of `box` (#343) — the square a node of an
 * earlier build of the tree named ({@link MortonCells}). Descends from the root through the child whose
 * cell contains the square, O(depth · 4): a node whose cell lies inside the square (level ≥ `level`, the
 * compressed node for exactly the leaves in it) is the answer; a bottom cell that still contains it is the
 * closest cover; `-1` when no leaf of this tree lies in the square. A `box` other than the tree's is
 * mapped onto the tree's box first (the grid is shared for cells ≥ 2 levels down); `-1` if it does not fit.
 */
export function findMortonCell(tree: LODTopology, box: MortonBox, level: number, code: number): number {
  const cells = tree.morton;
  if (!cells || tree.size === tree.leafCount) return -1;
  const tb = cells.box;
  let lv = level;
  let cd = code >>> 0;
  if (tb.side !== box.side || tb.x0 !== box.x0 || tb.y0 !== box.y0) {
    // The square in world units, re-expressed as a cell of the tree's box.
    const side = box.side / 2 ** level;
    const shift = 32 - 2 * level;
    const ix = level === 0 ? 0 : gatherBits(cd >>> shift);
    const iy = level === 0 ? 0 : gatherBits((cd >>> shift) >>> 1);
    const x = box.x0 + ix * side;
    const y = box.y0 + iy * side;
    const ratio = tb.side / side;
    const nl = Math.round(Math.log2(ratio));
    if (!(nl >= 0 && nl <= MORTON_BITS) || 2 ** nl !== ratio) return -1;
    const jx = (x - tb.x0) / side;
    const jy = (y - tb.y0) / side;
    const n = 2 ** nl;
    if (!(jx >= 0 && jy >= 0 && jx < n && jy < n)) return -1;
    lv = nl;
    cd = nl === 0 ? 0 : ((spreadBits(Math.floor(jx)) | (spreadBits(Math.floor(jy)) << 1)) << (32 - 2 * nl)) >>> 0;
  }
  const { leafCount, childOffset, children, levelOffset, levelCount } = tree;
  const root = levelOffset[levelCount - 1]!;
  let g = root;
  for (;;) {
    const o = g - leafCount;
    const gl = cells.level[o]!;
    if (gl >= lv) {
      // g's cell is at or below the square's depth: it lies inside the square iff it matches there.
      return ((cells.code[o]! & mortonMask(lv)) >>> 0) === ((cd & mortonMask(lv)) >>> 0) ? g : -1;
    }
    // g's cell strictly contains the square iff their prefixes agree to g's depth.
    if (((cells.code[o]! ^ cd) & mortonMask(gl)) >>> 0 !== 0) return -1;
    let next = -1;
    let leafChildren = false;
    for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) {
      const c = children[p]!;
      if (c < leafCount) { leafChildren = true; break; }
      const co = c - leafCount;
      const m = mortonMask(Math.min(cells.level[co]!, lv));
      if (((cells.code[co]! ^ cd) & m) >>> 0 === 0) { next = c; break; }
    }
    if (leafChildren) return g; // a bottom cell covering the square: its closest cover
    if (next < 0) return -1; // the square's quadrant holds no leaf of this tree
    g = next;
  }
}

/**
 * Assemble a {@link LODTree} from a worker-streamed {@link LODTopology}, optionally binding the
 * position-derived geometry (`cx`/`cy`/`extent`) to caller-provided buffers — typically views into a
 * `SharedArrayBuffer` the worker writes live each frame (#103 worker-LOD), so the main thread reads
 * the converging geometry with no copy. Style-derived geometry (`radius`/`weight`) is main-allocated
 * and filled once with {@link computeLODStyle}; the topological `count` is filled here (it's
 * position-independent — the worker streams cx/cy/extent but not count, #105).
 *
 * A spatial tree streamed per frame (#343) arrives with everything computed: pass its `count`, style arrays
 * and leaf branching as `computed`, and the assembly is O(1) — views only, no pass over the tree.
 */
export function lodTreeFromTopology(
  topo: LODTopology,
  geometry?: { cx: Float32Array; cy: Float32Array; extent: Float32Array },
  computed?: { count: Uint32Array; radius: Float32Array; weight: Float32Array; border: Float32Array; color: Uint8Array; leafBranching?: number },
): LODTree {
  const { size } = topo;
  return {
    ...topo,
    leafBranching: computed?.leafBranching ?? leafBranchingOf(topo),
    cx: geometry?.cx ?? new Float32Array(size),
    cy: geometry?.cy ?? new Float32Array(size),
    extent: geometry?.extent ?? new Float32Array(size),
    radius: computed?.radius ?? new Float32Array(size),
    count: computed?.count ?? leafDescendantCounts(topo),
    weight: computed?.weight ?? new Float32Array(size),
    border: computed?.border ?? new Float32Array(size),
    color: computed?.color ?? new Uint8Array(size * 4),
  };
}

/**
 * The part of an {@link LODTree} that {@link computeLODPositions} reads and writes: the level layout, the
 * children CSR, and the position geometry (`cx`/`cy`/`extent`, plus the leaf `count`). The GPU layout's LOD
 * worker keeps only this between refits (#377) — no style arrays, no super-edges.
 */
export type LODPositionTree = Pick<
  LODTree,
  "size" | "leafCount" | "levelCount" | "levelOffset" | "childOffset" | "children" | "cx" | "cy" | "extent" | "count"
>;

/**
 * Scratch for {@link computeLODPositions}'s exact bounding boxes (#343): 4 floats per aggregate, grown
 * on demand. Keep one per tree consumer (the engine, the layout worker) so a per-frame refit allocates
 * nothing; `computeLODPositions` makes a throwaway one when none is passed.
 */
export interface LODBoundsScratch {
  bounds: Float32Array;
}

/** A fresh {@link LODBoundsScratch}. */
export function makeLODBoundsScratch(): LODBoundsScratch {
  return { bounds: new Float32Array(0) };
}

/**
 * Fill the tree's **position-derived** geometry from a layout snapshot: each leaf's centroid is its
 * own position (extent 0, count 1); each aggregate gets the count-weighted centroid of its children
 * (= the mean of its descendant leaf positions), the summed leaf `count`, and a bounding `extent`
 * enclosing all descendant leaves. One bottom-up pass — O(tree size) ≈ O(n).
 *
 * The extent is the smaller of two upper bounds on the farthest descendant leaf (#343): the compounding
 * one (the farthest child's centre distance plus that child's extent — exact one level above the leaves)
 * and the distance to the farthest corner of the aggregate's exact bounding box (built bottom-up in the
 * same pass). The compounding bound alone inflates with depth (2-10× the true radius at the top of a
 * coarsening tree); the corner bound does not, so the cut expands and culls on a tight footprint at every
 * level. The boxes need 16 B per aggregate of scratch (`bounds`).
 *
 * With a nested layout's `discs` (#329), each module is placed on its disc instead: `cx`/`cy` is the
 * disc centre (its leaf centroid + the disc's offset) and `extent` the disc radius — grown only if a
 * member lies outside the disc (mid-transition, or dragged out), so it still bounds every descendant.
 * The same pass, O(1) more per child.
 *
 * This is the *only* geometry that changes as the layout converges, so it is the per-frame pass: the
 * layout worker runs it each streamed frame and writes `cx`/`cy`/`extent` into the shared buffer the
 * main thread renders from (#103 worker-LOD). Style-derived geometry is {@link computeLODStyle}.
 */
export function computeLODPositions(tree: LODPositionTree, positions: ArrayLike<number>, discs?: BoundaryDiscs, scratch?: LODBoundsScratch): void {
  const { leafCount, levelCount, levelOffset, childOffset, children, cx, cy, extent, count } = tree;
  const sc = scratch ?? makeLODBoundsScratch();
  const need = 4 * (tree.size - leafCount);
  if (sc.bounds.length < need) sc.bounds = new Float32Array(need);
  const bb = sc.bounds; // aggregate g's box: bb[4o .. 4o + 4) = minX, minY, maxX, maxY with o = g − leafCount

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
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let p = c0; p < c1; p++) {
        const c = children[p]!;
        const cc = count[c]!;
        let x = cx[c]!;
        let y = cy[c]!;
        if (c < leafCount) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } else {
          const o = 4 * (c - leafCount);
          if (bb[o]! < minX) minX = bb[o]!;
          if (bb[o + 1]! < minY) minY = bb[o + 1]!;
          if (bb[o + 2]! > maxX) maxX = bb[o + 2]!;
          if (bb[o + 3]! > maxY) maxY = bb[o + 3]!;
          if (discs) {
            // A child module sits on its disc centre: take its disc offset back off for its leaf centroid.
            x -= discs.dx[c - leafCount]!;
            y -= discs.dy[c - leafCount]!;
          }
        }
        sumC += cc;
        sx += cc * x;
        sy += cc * y;
      }
      let gx = sumC > 0 ? sx / sumC : 0;
      let gy = sumC > 0 ? sy / sumC : 0;
      let disc = 0;
      if (discs) {
        const o = g - leafCount;
        gx += discs.dx[o]!;
        gy += discs.dy[o]!;
        disc = discs.r[o]!;
      }
      cx[g] = gx;
      cy[g] = gy;
      count[g] = sumC;
      const o = 4 * (g - leafCount);
      bb[o] = minX;
      bb[o + 1] = minY;
      bb[o + 2] = maxX;
      bb[o + 3] = maxY;
      // Corner bound: the farthest corner of the exact box (every descendant leaf lies in it).
      const ex = Math.max(gx - minX, maxX - gx);
      const ey = Math.max(gy - minY, maxY - gy);
      const corner2 = ex * ex + ey * ey;
      const corner = Math.sqrt(corner2);
      // Compounding bound: the farthest child's centre distance plus that child's own extent — for leaf
      // children (extent 0) compared squared, one square root at the end. Once it passes the corner bound
      // the smaller of the two is the corner: stop.
      let leafD2 = 0;
      let comp = 0;
      for (let p = c0; p < c1 && comp < corner && leafD2 < corner2; p++) {
        const c = children[p]!;
        const dx = gx - cx[c]!;
        const dy = gy - cy[c]!;
        const e = extent[c]!;
        if (e === 0) {
          const d2 = dx * dx + dy * dy;
          if (d2 > leafD2) leafD2 = d2;
        } else {
          const d = Math.sqrt(dx * dx + dy * dy) + e;
          if (d > comp) comp = d;
        }
      }
      const leafD = Math.sqrt(leafD2);
      if (leafD > comp) comp = leafD;
      const leaves = corner < comp ? corner : comp;
      // On a disc: at least the disc's radius.
      extent[g] = leaves > disc ? leaves : disc;
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

// CIE Lab constants (D50), exactly as d3-color's lab.js — see rgbToHcl / hclToRgb.
const LAB_XN = 0.96422;
const LAB_YN = 1;
const LAB_ZN = 0.82521;
const LAB_T0 = 4 / 29;
const LAB_T1 = 6 / 29;
const LAB_T2 = 3 * LAB_T1 * LAB_T1;
const LAB_T3 = LAB_T1 * LAB_T1 * LAB_T1;
const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;
const rgb2lrgb = (v: number): number => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const xyz2lab = (t: number): number => (t > LAB_T3 ? Math.pow(t, 1 / 3) : t / LAB_T2 + LAB_T0);
const lab2xyz = (t: number): number => (t > LAB_T1 ? t * t * t : LAB_T2 * (t - LAB_T0));
const lrgb2rgb = (v: number): number => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
/** Reused out-parameter for the colour conversions below (`[h, c, l]`, `[r, g, b]` or the hue terms). */
const hclOut = new Float64Array(4);
/** `rgb2lrgb` of every byte value — the same numbers d3-color computes for an integer channel. */
const LRGB = Float64Array.from({ length: 256 }, (_, v) => rgb2lrgb(v));
/** Direct-mapped memo of a colour's contribution to the aggregate colour mean, by 24-bit colour (16k slots,
 *  ~650 KB): a categorical palette converts each colour once. It stores the computed values, so a hit is
 *  bit-identical to converting again. */
const HCL_MEMO_BITS = 14;
const hclMemoKey = new Int32Array(1 << HCL_MEMO_BITS).fill(-1);
const hclMemoVal = new Float64Array(4 << HCL_MEMO_BITS);

/**
 * A byte colour's terms in {@link computeLODStyle}'s chroma-weighted circular hue mean, into `out`:
 * `[cos(h)·c, sin(h)·c, c, l]` — the hue terms 0 for an achromatic colour (NaN hue) and chroma/lightness 0
 * where d3-color gives NaN — computed exactly as the pass did, through the memo.
 */
function hueTerms(r: number, g: number, b: number, out: Float64Array): void {
  const key = (r << 16) | (g << 8) | b;
  const slot = Math.imul(key, 0x9e3779b1) >>> (32 - HCL_MEMO_BITS);
  if (hclMemoKey[slot] === key) {
    out[0] = hclMemoVal[4 * slot]!;
    out[1] = hclMemoVal[4 * slot + 1]!;
    out[2] = hclMemoVal[4 * slot + 2]!;
    out[3] = hclMemoVal[4 * slot + 3]!;
    return;
  }
  rgbToHcl(r, g, b, out);
  const h = out[0]!;
  const ch = Number.isNaN(out[1]!) ? 0 : out[1]!;
  const l = Number.isNaN(out[2]!) ? 0 : out[2]!;
  // (Adding +0 for a NaN hue leaves a sum from +0 unchanged — the pass skipped the term instead.)
  out[0] = Number.isNaN(h) ? 0 : Math.cos((h * Math.PI) / 180) * ch;
  out[1] = Number.isNaN(h) ? 0 : Math.sin((h * Math.PI) / 180) * ch;
  out[2] = ch;
  out[3] = l;
  hclMemoKey[slot] = key;
  hclMemoVal[4 * slot] = out[0]!;
  hclMemoVal[4 * slot + 1] = out[1]!;
  hclMemoVal[4 * slot + 2] = ch;
  hclMemoVal[4 * slot + 3] = l;
}

/**
 * `hcl(rgb(r, g, b))` from d3-color for byte channels, as the same float operations in the same order — so
 * the result is bit-identical — but written into `out` as `[h, c, l]` instead of allocating two colour
 * objects. The aggregate colour pass runs it once per tree node (#343: every streamed frame for a spatial
 * tree), through {@link hueTerms}' memo.
 */
function rgbToHcl(r: number, g: number, b: number, out: Float64Array): void {
  const lr = LRGB[r]!;
  const lg = LRGB[g]!;
  const lb = LRGB[b]!;
  const y = xyz2lab((0.2225045 * lr + 0.7168786 * lg + 0.0606169 * lb) / LAB_YN);
  let x = y;
  let z = y;
  if (!(lr === lg && lg === lb)) {
    x = xyz2lab((0.4360747 * lr + 0.3850649 * lg + 0.1430804 * lb) / LAB_XN);
    z = xyz2lab((0.0139322 * lr + 0.0971045 * lg + 0.7141733 * lb) / LAB_ZN);
  }
  const l = 116 * y - 16;
  const a = 500 * (x - y);
  const bb = 200 * (y - z);
  if (a === 0 && bb === 0) {
    out[0] = NaN;
    out[1] = 0 < l && l < 100 ? 0 : NaN;
    out[2] = l;
    return;
  }
  const h = Math.atan2(bb, a) * DEGREES;
  out[0] = h < 0 ? h + 360 : h;
  out[1] = Math.sqrt(a * a + bb * bb);
  out[2] = l;
}

/** `rgb(hcl(h, c, l))` from d3-color, bit-identical, written into `out` as unclamped `[r, g, b]`. */
function hclToRgb(h: number, c: number, l: number, out: Float64Array): void {
  let a = 0;
  let b = 0;
  if (!Number.isNaN(h)) {
    const hr = h * RADIANS;
    a = Math.cos(hr) * c;
    b = Math.sin(hr) * c;
  }
  let y = (l + 16) / 116;
  let x = Number.isNaN(a) ? y : y + a / 500;
  let z = Number.isNaN(b) ? y : y - b / 200;
  x = LAB_XN * lab2xyz(x);
  y = LAB_YN * lab2xyz(y);
  z = LAB_ZN * lab2xyz(z);
  out[0] = lrgb2rgb(3.1338561 * x - 1.6168667 * y - 0.4906146 * z);
  out[1] = lrgb2rgb(-0.9787684 * x + 1.9161415 * y + 0.033454 * z);
  out[2] = lrgb2rgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z);
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
          hueTerms(color[c * 4]!, color[c * 4 + 1]!, color[c * 4 + 2]!, hclOut);
          hx += hclOut[0]!;
          hy += hclOut[1]!;
          sumC += hclOut[2]!;
          sumL += hclOut[3]!;
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
        hclToRgb(hue, sumC / nc, sumL / nc, hclOut);
        color[g * 4] = Math.max(0, Math.min(255, Math.round(hclOut[0]!)));
        color[g * 4 + 1] = Math.max(0, Math.min(255, Math.round(hclOut[1]!)));
        color[g * 4 + 2] = Math.max(0, Math.min(255, Math.round(hclOut[2]!)));
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
 * or `graph.csr.degree` to prioritise differently. `discs` places each module on its nested-layout
 * disc (#329, see {@link computeLODPositions}); `bounds` is the position pass's reusable box scratch.
 */
export function computeLODGeometry(
  tree: LODTree,
  graph: NetworkGraph,
  leafRadii: ArrayLike<number>,
  leafWeight: ArrayLike<number> = graph.strength,
  leafBorder?: ArrayLike<number>,
  leafColors?: ArrayLike<number>,
  radiusAggregate?: RadiusAggregate,
  discs?: BoundaryDiscs,
  bounds?: LODBoundsScratch,
): void {
  computeLODPositions(tree, graph.positions, discs, bounds);
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
   * (fewer, bigger glyphs); smaller → finer. An absolute pixel size — omit it to get the tree-adaptive
   * default ({@link defaultExpandPx}: 48 px for a binary coarsening tree, more for a coarser-branching
   * one such as a provided module partition).
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
   * With {@link boundaries}, an expanded aggregate that is not itself drawn gets its children's alpha
   * here too (the alpha its ring and anchored links fade with).
   */
  fadeAlpha?: Float32Array;
  /**
   * Collect the **expanded** aggregates whose boundary circle (`cx`/`cy` + `extent`: the disc, after a
   * nested layout — see {@link BoundaryDiscs}) meets the view (#329) — the modules the engine rings with
   * `lod({ moduleBoundary })`. Each one the walk expands (in the fade band: one whose children it draws)
   * is recorded with its children's alpha, at O(1) per expanded node the walk visits anyway; the walk
   * itself and the returned frontier are unchanged. A tree's single root (a module tree's: the whole
   * network) is never collected.
   */
  boundaries?: CutBoundaries;
  /**
   * Also record, in the scratch, the nodes the walk **culls** (subtree roots whose box misses the view) and
   * the ones it both draws and expands (a cross-fade band) — {@link CutScratch.culled} / `split` — so the
   * lazy super-edge gather (#343) can tell which drawn or culled node covers any leaf. O(1) per node the
   * walk visits anyway; off ⇒ zero added cost.
   */
  recordCulled?: boolean;
}

/** Floor for the adaptive default (and the historical fixed default): a binary tree's threshold. */
const DEFAULT_EXPAND_PX = 48;
/** Branching the historical fixed 48 px default is calibrated for — a binary coarsening tree. The
 *  adaptive default scales off it as `48·√(c/2)`, so `c = 2` reproduces 48 px *exactly* (no float
 *  drift), i.e. ≈34 px of screen room per child. */
const CALIBRATED_BRANCHING = 2;
/** Ceiling for the adaptive default, as a fraction of the shorter viewport side — see {@link defaultExpandPx}. */
const MAX_DEFAULT_EXPAND_FRACTION = 0.5;

/**
 * The **adaptive default** expand threshold, in px, for a tree with no explicit
 * {@link CutOptions.expandPx} (#191).
 *
 * `expandPx` is an absolute on-screen size, but the natural scale of the footprint it is compared
 * against is set by how many leaves the *finest* aggregate holds: a coarsening tree's leaf-parent
 * holds 2 leaves and is 7–23 px across at a fit view, a provided-module tree's holds 30–60 and is
 * 96–123 px. One fixed 48 px therefore did real work on the first (22–34 % of the fit frontier stayed
 * raw leaves, the rest aggregates) and *nothing* on the second — `lod({ modules })` opened on 100 %
 * raw leaves, which is why both website examples used to hard-code `240`.
 *
 * So scale the default by the tree's own {@link LODTree.leafBranching} `c`: a parent of `c`
 * equal-sized children is `√c` times their diameter (equal discs, area-conserving), so
 * `48·√(c/{@link CALIBRATED_BRANCHING})` gives every child the same ~34 px of screen room the 48 px
 * default gives the two children of a binary parent. That is exactly 48 px for a coarsening tree (and
 * for a quadtree bottom cell, via the floor), so those keep their calibration **byte-for-byte**,
 * while a 30–60-member module partition asks for 190–260 px — a genuinely aggregated opening view.
 *
 * Clamped both ways: never below the historical 48 px, and never above half the shorter viewport
 * side, so a tree with enormous leaf-parents (one 2 000-member module) can't push the threshold past
 * the whole framed layout and collapse the map to a single blob.
 *
 * O(1) — a `√`, a multiply and two clamps, off one number computed at tree build. Safe on a tree that
 * predates the field (`leafBranching` absent ⇒ the flat 48 px default).
 */
export function defaultExpandPx(tree: LODTree, width: number, height: number): number {
  const c = tree.leafBranching;
  const perChild = c > 0 ? DEFAULT_EXPAND_PX * Math.sqrt(c / CALIBRATED_BRANCHING) : DEFAULT_EXPAND_PX;
  const cap = MAX_DEFAULT_EXPAND_FRACTION * Math.min(width, height);
  return Math.max(DEFAULT_EXPAND_PX, Math.min(perChild, cap));
}

/** Smoothstep (Hermite) ease on [0,1] — the cross-fade ramp (#133), softer than linear at both ends. */
const smoothstep = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Reusable scratch for {@link cut} (#213) — engine-owned so a zoom/pan frame allocates nothing
 * steady-state: the frontier output, the DFS stack, and its parallel cross-fade alpha stack are
 * grow-on-demand typed arrays reused across frames. The returned frontier is a `subarray` **view**
 * of `frontier`, valid until the next {@link cut} with the same scratch — every per-frame consumer
 * re-selects before reading, so one scratch per engine serves all paths.
 */
export interface CutScratch {
  /** Emitted frontier ids; only the returned `subarray(0, n)` prefix is valid per call. */
  frontier: Uint32Array;
  /** DFS stack of pending tree-node ids (only a call-local prefix is live). */
  stack: Uint32Array;
  /** Inherited cross-fade multiplier (#133), parallel to `stack` — only touched when fading. */
  alpha: Float64Array;
  /** With {@link CutOptions.recordCulled}: the culled subtree roots of the last cut, `culled[0 .. culledCount)`. */
  culled: Uint32Array;
  culledCount: number;
  /** With {@link CutOptions.recordCulled}: the nodes the last cut both drew and expanded (a cross-fade
   *  band), `split[0 .. splitCount)`. Empty without a fade. */
  split: Uint32Array;
  splitCount: number;
}

/** Fresh {@link CutScratch}. The network engine keeps ONE per instance; {@link cut} falls back to a
 *  throwaway one when none is passed (backward-compatible, but then every call allocates). */
export function makeCutScratch(): CutScratch {
  return { frontier: new Uint32Array(256), stack: new Uint32Array(256), alpha: new Float64Array(256), culled: new Uint32Array(64), culledCount: 0, split: new Uint32Array(16), splitCount: 0 };
}

/**
 * Adaptive hierarchy cut: walk the tree top-down for the given view and return the **frontier** —
 * the set of node ids to draw. A subtree is culled when its bounding box misses the viewport; an
 * aggregate expands when its on-screen footprint is large enough, otherwise it is drawn as one
 * glyph; leaves always draw. Work is proportional to the visible frontier, not to the tree size.
 * With {@link CutOptions.boundaries} it also collects the expanded aggregates whose boundary meets
 * the view (#329), at O(1) per expanded node.
 *
 * Pass an engine-owned `scratch` ({@link makeCutScratch}) to make the walk allocation-free
 * steady-state (#213); the returned frontier is then a view of `scratch.frontier`, valid until the
 * next cut with that scratch. Without it, every call allocates a private scratch.
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
  scratch?: CutScratch,
): Uint32Array {
  const { leafCount, levelCount, levelOffset, childOffset, children, cx, cy, extent, radius } = tree;
  // No explicit threshold ⇒ the tree-adaptive default (#191) — O(1) off `tree.leafBranching`, which
  // was computed once at tree build; nothing here scales with the tree or the frontier.
  const expandPx = opts.expandPx ?? defaultExpandPx(tree, width, height);
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

  // #213: all working storage comes from the (reused) scratch — no boxed number[]s, no output copy.
  // `n`/`sp` are the live frontier / stack lengths; the grow-doubles run only until the scratch is warm.
  const sc = scratch ?? makeCutScratch();
  let n = 0;
  let sp = 0;
  // Seed the stack with the roots (coarsest level). The parallel alpha slot carries the inherited fade
  // multiplier (only touched when fading; Float64 keeps the exact doubles the boxed stack held).
  const push = (g: number, a: number): void => {
    if (sp === sc.stack.length) {
      const cap = sp * 2;
      const ns = new Uint32Array(cap); ns.set(sc.stack); sc.stack = ns;
      const na = new Float64Array(cap); na.set(sc.alpha); sc.alpha = na;
    }
    sc.stack[sp] = g;
    if (fade) sc.alpha[sp] = a;
    sp++;
  };
  for (let g = levelOffset[levelCount - 1]!; g < levelOffset[levelCount]!; g++) push(g, 1);
  const emit = (g: number, a: number): void => {
    if (n === sc.frontier.length) { const nf = new Uint32Array(n * 2); nf.set(sc.frontier); sc.frontier = nf; }
    sc.frontier[n++] = g;
    if (fade && alphaOut) alphaOut[g] = a;
  };

  // Module boundaries (#329): record each expanded aggregate whose boundary circle meets the view.
  const bnd = opts.boundaries;
  // A tree with a single root (every module tree: the whole network) gets no ring for it — it is no module.
  const soleRoot = levelOffset[levelCount]! - levelOffset[levelCount - 1]! === 1 ? levelOffset[levelCount - 1]! : -1;
  let nb = 0;
  // Whether aggregate g's circle (centre + extent) meets the view rect — tighter than the cull box.
  const meets = (g: number): boolean => {
    const x = cx[g]!;
    const y = cy[g]!;
    const r = extent[g]!;
    const qx = x < minX ? minX : x > maxX ? maxX : x;
    const qy = y < minY ? minY : y > maxY ? maxY : y;
    return (x - qx) * (x - qx) + (y - qy) * (y - qy) <= r * r;
  };
  // Culled roots and drawn-and-expanded nodes (#343), for the lazy super-edge gather.
  const recordCulled = opts.recordCulled === true;
  let nc = 0;
  let ns = 0;
  const cull = (g: number): void => {
    if (nc === sc.culled.length) { const nx = new Uint32Array(nc * 2); nx.set(sc.culled); sc.culled = nx; }
    sc.culled[nc++] = g;
  };
  const record = (g: number, a: number): void => {
    if (!bnd) return;
    if (nb === bnd.ids.length) {
      const ni = new Uint32Array(nb * 2); ni.set(bnd.ids); bnd.ids = ni;
      const na = new Float32Array(nb * 2); na.set(bnd.alpha); bnd.alpha = na;
    }
    bnd.ids[nb] = g;
    bnd.alpha[nb] = a;
    nb++;
  };

  while (sp > 0) {
    sp--;
    const g = sc.stack[sp]!;
    const a = fade ? sc.alpha[sp]! : 1;
    const ext = extent[g]!;
    const gx = cx[g]!;
    const gy = cy[g]!;
    // Cull only when the node's drawn body (bbox grown by its draw radius) misses the viewport, so a
    // glyph stays until its whole body is off-screen.
    const m = ext + drawMargin(g);
    if (gx + m < minX || gx - m > maxX || gy + m < minY || gy - m > maxY) {
      if (recordCulled) cull(g);
      continue;
    }
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
      if (recordCulled && drawA > 0) {
        if (ns === sc.split.length) { const nx = new Uint32Array(ns * 2); nx.set(sc.split); sc.split = nx; }
        sc.split[ns++] = g;
      }
      if (bnd && g !== soleRoot && meets(g)) {
        record(g, childA);
        // Not drawn itself: its ring (and anchored links) fade with its children.
        if (fade && alphaOut && drawA <= 0) alphaOut[g] = childA;
      }
      for (let p = childOffset[g]!; p < childOffset[g + 1]!; p++) push(children[p]!, childA);
    }
  }

  if (bnd) bnd.count = nb;
  sc.culledCount = nc;
  sc.splitCount = ns;
  return sc.frontier.subarray(0, n);
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
 * Reusable scratch for {@link declutterFrontier} (#213) — engine-owned so the per-frame thinning
 * allocates nothing steady-state: the projected centres/radii, the typed sort keys + visit order,
 * the kept flags, the shared declutter grid, and the output buffer are all grown on demand (to the
 * largest frontier seen) and reused. The returned kept set is a `subarray` **view** of `out`, valid
 * until the next call with the same scratch.
 */
export interface DeclutterFrontierScratch {
  /** Projected screen centres + on-screen draw radii, parallel to the frontier. */
  px: Float64Array;
  py: Float64Array;
  pr: Float64Array;
  /** Per-frontier-index importance key (`tree.weight[frontier[i]]`), gathered once per call so the
   *  sort reads one flat array — not two boxed `tree.weight[frontier[i]]` lookups per compare. */
  key: Float32Array;
  /** Bit view over `key`'s SAME buffer; transformed in place to the descending-order radix key. */
  keyBits: Uint32Array;
  /** Radix scatter partner for `keyBits`. */
  keyBits2: Uint32Array;
  /** Frontier-index visit order; the `[0, F)` prefix is sorted descending by `key` each call. */
  order: Uint32Array;
  /** Radix scatter partner for `order`. */
  order2: Uint32Array;
  /** Per-pass byte histogram / running offsets for the radix sort. */
  counts: Uint32Array;
  /** Kept flags from {@link declutterScreen} (fully rewritten each call — no clearing needed). */
  kept: Uint8Array;
  /** Uniform-grid scratch for the shared {@link declutterScreen} engine. */
  grid: DeclutterScratch;
  /** Kept frontier ids; only the returned `subarray(0, n)` prefix is valid per call. */
  out: Uint32Array;
}

/** Fresh {@link DeclutterFrontierScratch}. The network engine keeps ONE per instance;
 *  {@link declutterFrontier} falls back to a throwaway one when none is passed (backward-compatible,
 *  but then every call allocates). */
export function makeDeclutterFrontierScratch(): DeclutterFrontierScratch {
  const key = new Float32Array(0);
  return { px: new Float64Array(0), py: new Float64Array(0), pr: new Float64Array(0), key, keyBits: new Uint32Array(key.buffer), keyBits2: new Uint32Array(0), order: new Uint32Array(0), order2: new Uint32Array(0), counts: new Uint32Array(256), kept: new Uint8Array(0), grid: declutterScratch(), out: new Uint32Array(0) };
}

/**
 * Sort `sc.order[0..F)` by weight **descending**, ties in original index order — the exact
 * permutation a stable comparator sort by `-key` produces — via a **stable LSD byte-radix** on the
 * float32 bit pattern (#213): O(F) with zero allocation, instead of an O(F log F) comparator-callback
 * sort (which V8 also makes allocate internally). `sc.keyBits` (a bit view over the gathered `key`
 * floats) is transformed in place to a monotonic unsigned key; passes whose byte is constant are
 * skipped (an identity permutation, so stability is preserved). Returns the array holding the final
 * permutation (`sc.order` or `sc.order2`, depending on pass parity). (A NaN weight — always a caller
 * bug — gets a deterministic slot above +∞ here, where a comparator sort's order was unspecified.)
 */
function sortOrderByWeightDesc(sc: DeclutterFrontierScratch, F: number): Uint32Array {
  // Monotonic descending transform: asc = sign ? ~b : b|0x80000000 orders bit patterns like the
  // floats ascending; complementing gives descending. −0 is normalized to +0 first so the two zero
  // encodings tie (as they do under a numeric comparator).
  const bits = sc.keyBits;
  for (let i = 0; i < F; i++) {
    const b = bits[i] === 0x80000000 ? 0 : bits[i]!;
    bits[i] = (b & 0x80000000) !== 0 ? b : ~b & 0x7fffffff;
  }
  let srcO = sc.order;
  let srcK = sc.keyBits;
  let dstO = sc.order2;
  let dstK = sc.keyBits2;
  const counts = sc.counts;
  for (let shift = 0; shift < 32; shift += 8) {
    counts.fill(0);
    for (let i = 0; i < F; i++) counts[(srcK[i]! >>> shift) & 0xff]!++;
    if (counts[(srcK[0]! >>> shift) & 0xff] === F) continue; // constant byte — skip the pass
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = counts[b]!;
      counts[b] = sum;
      sum += c;
    }
    for (let i = 0; i < F; i++) {
      const b = (srcK[i]! >>> shift) & 0xff;
      const j = counts[b]!;
      counts[b] = j + 1;
      dstO[j] = srcO[i]!;
      dstK[j] = srcK[i]!;
    }
    const tO = srcO; srcO = dstO; dstO = tO;
    const tK = srcK; srcK = dstK; dstK = tK;
  }
  return srcO;
}

/**
 * Thin an LOD frontier in screen space: keep higher-importance glyphs (by tree {@link LODTree.weight}
 * = strength) and drop lower-importance ones that would **overlap** a kept glyph (centre distance <
 * sum of the two radii). Greedy in descending importance over a uniform screen grid, so a dense
 * cluster keeps its most important members and the kept set is overlap-free (no overdraw). Runs per
 * cut, so it's zoom-dependent — more glyphs resolve as you zoom in. Returns the kept frontier ids
 * (original order).
 *
 * Pass an engine-owned `scratch` ({@link makeDeclutterFrontierScratch}) to make the thinning
 * allocation-free steady-state (#213); the returned set is then a view of `scratch.out`, valid until
 * the next call with that scratch. Without it, every call allocates a private scratch.
 */
export function declutterFrontier(
  tree: LODTree,
  frontier: Uint32Array,
  t: LODTransform,
  width: number,
  height: number,
  opts: DeclutterOptions,
  scratch?: DeclutterFrontierScratch,
): Uint32Array {
  const F = frontier.length;
  if (F <= 1) return frontier;
  const maxAgg = opts.maxAggregateRadius ?? Infinity;
  const spacing = opts.spacing ?? 1;

  // #213: all working storage comes from the (reused) scratch, grown together to the largest frontier
  // seen. Every array's `[0, F)` prefix is fully rewritten below, so reuse needs no clearing.
  const sc = scratch ?? makeDeclutterFrontierScratch();
  if (sc.px.length < F) {
    const cap = Math.max(F, sc.px.length * 2);
    sc.px = new Float64Array(cap);
    sc.py = new Float64Array(cap);
    sc.pr = new Float64Array(cap);
    sc.key = new Float32Array(cap);
    sc.keyBits = new Uint32Array(sc.key.buffer);
    sc.keyBits2 = new Uint32Array(cap);
    sc.order = new Uint32Array(cap);
    sc.order2 = new Uint32Array(cap);
    sc.kept = new Uint8Array(cap);
    sc.out = new Uint32Array(cap);
  }
  const px = sc.px;
  const py = sc.py;
  const pr = sc.pr;
  const key = sc.key;

  // Project each glyph to screen and resolve its on-screen draw radius (matching frontierCircles),
  // gathering the sort key (importance) in the same pass.
  for (let i = 0; i < F; i++) {
    const g = frontier[i]!;
    const drawn = g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    pr[i] = opts.screenSized ? drawn : drawn * opts.k;
    px[i] = tree.cx[g]! * t.k + t.x;
    py[i] = tree.cy[g]! * t.k + t.y;
    key[i] = tree.weight[g]!;
  }

  // Visit in descending importance so the most important glyph in a cluster survives, then run the
  // shared greedy declutter (one engine across backends + the geo layers — see core/declutter).
  // Stable radix index sort on the flat key array's bit pattern — the same permutation the stable
  // boxed comparator over tree.weight produced, at O(F) with zero allocation (see the sorter's doc).
  for (let i = 0; i < F; i++) sc.order[i] = i;
  const order = sortOrderByWeightDesc(sc, F);
  // Cross-fade (#133): a transitioning glyph ignores its ANCESTOR as an occluder, so a fading parent
  // doesn't cull its fading-in children — but children still declutter against siblings (and the parent
  // still occludes unrelated glyphs). Only the fade adds a parent+child pair to the frontier (it's
  // otherwise an antichain), so ancestry alone identifies the pairs; gate on the fade pass for zero cost.
  const par = opts.fadeAlpha ? tree.parent : undefined;
  const ignore = par ? (i: number, j: number) => onSamePath(frontier[i]!, frontier[j]!, par) : undefined;
  const kept = declutterScreen(F, px, py, pr, order, width, height, spacing, sc.kept, sc.grid, ignore);

  const out = sc.out;
  let n = 0;
  for (let i = 0; i < F; i++) if (kept[i]) out[n++] = frontier[i]!;
  return out.subarray(0, n);
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
