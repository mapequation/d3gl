/**
 * Provided module hierarchy → LOD tree (sub-issue #104 N6 / epic #98).
 *
 * The "maps of networks" register reuses the N5 adaptive-cut LOD engine ({@link ./lod.js}); only the
 * hierarchy *source* differs. d3gl does not cluster — the module tree is computed app-side (Infomap)
 * and passed in, mirroring externally-provided positions (#101). This adapter turns the app's
 * per-node module assignment into the same {@link LODTopology} the cut already walks, so modules
 * expand → sub-modules → leaves on zoom with no engine changes.
 *
 * **Input shape** is Infomap's JSON `nodes` array directly: each record is a graph node with an `id`
 * (the dense node index, aligned with `buildGraph`'s node order) and a `path` — Infomap's 1-based
 * child-index chain from the root down to the node. A node's enclosing module is `path.slice(0, -1)`
 * (the last entry is the node's rank within that module), so two nodes share a module iff their path
 * prefixes match. The empty prefix is the root.
 *
 * **Ragged trees:** Infomap modules nest to different depths, so leaves live at one level (level 0)
 * but modules don't align to fixed levels. We assign each module a level by **height** (1 + the
 * deepest child's height), exactly as the spatial quadtree LOD does — this guarantees every node's
 * children sit in a strictly lower level (required by the bottom-up geometry passes) and makes the
 * root the unique tallest node (required by {@link cut}, which seeds only the coarsest level).
 */
import { lodTreeFromTopology, buildSuperEdges, type LODTree, type LODTopology } from "./lod.js";

/**
 * A graph node's placement in the provided module tree — the Infomap JSON node shape. Extra fields
 * (`flow`, `name`, `modules`, …) are accepted and ignored here; `flow` feeds flow-border rendering in
 * N6b.
 */
export interface ModuleNode {
  /** Dense node index, aligned with the graph built by `buildGraph` (its leaf id in the LOD tree). */
  id: number;
  /**
   * Infomap module path: the 1-based child-index chain from the root to this node (e.g. `[2, 1, 3]` =
   * top module 2 → sub-module 1 → the node ranked 3). The enclosing module is `path.slice(0, -1)`.
   */
  path: ArrayLike<number>;
}

/** Directed, weighted edge list for deriving module super-edges (#104 N6c) — the graph's own arrays. */
export interface ModuleEdges {
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Per-edge flow/weight; the super-edge flow is the directed sum. */
  weight: ArrayLike<number>;
}

/**
 * A link between two tree nodes addressed by Infomap path (#199) — the rows of an Infomap `.ftree`'s
 * per-module `*Links` sections. `source`/`target` are the paths of **modules or leaves** (e.g. `[1, 1]`
 * → `[1, 2]` for a link between sub-modules 1 and 2 of top module 1; `[2]` for top module 2; a leaf's
 * full node path). A `.ftree` stores leaf links only inside bottom modules and every coarser link only
 * aggregated per level, so these are the real data for the map's inter-module super-edges: each
 * contributes from its endpoints' own level up to (not including) their lowest common module, exactly
 * like a graph edge does from the leaves up. Don't repeat links already in the graph's edges — both are
 * summed.
 */
export interface ModuleLink {
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Link flow, summed per ordered pair with any other contribution to it. */
  flow: number;
}

/**
 * Build a {@link LODTree} from a provided module hierarchy (the priority-chain entry that precedes
 * structural coarsening). Geometry is left zeroed — fill it with {@link computeLODGeometry} once
 * positions exist.
 *
 * With `edges` (the graph's directed edge list), also derive **directed, flow-weighted super-edges**
 * (#104 N6c) so a map's inter-module links render as bent half-arrows; omit them (N6a) for a
 * node-only map. `records` must cover every node `0..nodeCount-1` exactly once.
 *
 * With `links` ({@link ModuleLink}s, #199), module-level links addressed by path add their flow to the
 * super-edges directly — for inputs like an Infomap `.ftree` that carry inter-module links only in
 * aggregate, with no leaf edges to derive them from.
 */
export function buildModuleLODTree(
  nodeCount: number,
  records: ArrayLike<ModuleNode>,
  edges?: ModuleEdges,
  links?: ArrayLike<ModuleLink>,
): LODTree {
  return lodTreeFromTopology(buildModuleTopology(nodeCount, records, edges, links));
}

function buildModuleTopology(
  nodeCount: number,
  records: ArrayLike<ModuleNode>,
  edges?: ModuleEdges,
  links?: ArrayLike<ModuleLink>,
): LODTopology {
  // --- 1. Register every distinct module prefix (root + all ancestors) in first-seen order by
  // walking an integer-keyed prefix tree: each module lazily holds a child map keyed by the next
  // path component (branch id). A prefix corresponds one-to-one with a (parent, branch) chain, so
  // this registers the exact modules — in the exact order — that interning ":"-joined path strings
  // did, without the O(nodeCount·depth) transient strings (#215). Each module's parent is recorded
  // at creation; the root (index 0) has none. ---
  const moduleParent: number[] = []; // internal index → parent internal index (-1 for the root)
  const moduleChild: (Map<number, number> | null)[] = []; // internal index → (branch id → child internal index)
  const registerModule = (parent: number): number => {
    moduleParent.push(parent);
    moduleChild.push(null);
    return moduleParent.length - 1;
  };
  registerModule(-1); // the root — always present, even for a flat (module-less) network

  const leafModule = new Int32Array(nodeCount).fill(-1); // node id → enclosing module's internal index
  const leafRank = links?.length ? new Float64Array(nodeCount) : null; // node id → last path entry (for link lookup)
  const seen = new Uint8Array(nodeCount);
  for (let r = 0; r < records.length; r++) {
    const { id, path } = records[r]!;
    if (!(id >= 0 && id < nodeCount)) {
      throw new Error(`buildModuleLODTree: record id ${id} out of range [0, ${nodeCount})`);
    }
    if (seen[id]) throw new Error(`buildModuleLODTree: duplicate record for node id ${id}`);
    seen[id] = 1;
    const depth = path.length;
    if (depth < 1) throw new Error(`buildModuleLODTree: node id ${id} has an empty path`);
    // Walk root → path[0] → path[0:1] → …, creating unseen modules; the enclosing module is the
    // prefix of length depth-1 (the last path entry is the node's rank within that module, not a
    // module).
    let m = 0; // the root
    for (let d = 0; d < depth - 1; d++) {
      const branch = path[d]!;
      const kids = (moduleChild[m] ??= new Map());
      let child = kids.get(branch);
      if (child === undefined) {
        child = registerModule(m);
        kids.set(branch, child);
      }
      m = child;
    }
    leafModule[id] = m;
    if (leafRank) leafRank[id] = path[depth - 1]!;
  }
  for (let i = 0; i < nodeCount; i++) {
    if (!seen[i]) throw new Error(`buildModuleLODTree: no record for node id ${i} (records must cover every node)`);
  }

  const moduleCount = moduleParent.length;

  // --- 2. Module heights (leaves are height 0; a module is 1 + its deepest child's height). A child
  // module is always registered after its parent, so descending internal-index order finalises every
  // child before its parent. ---
  const moduleHeight = new Int32Array(moduleCount).fill(1); // ≥1: every module has ≥1 (leaf) child
  for (let m = moduleCount - 1; m >= 1; m--) {
    const p = moduleParent[m]!;
    if (moduleHeight[m]! + 1 > moduleHeight[p]!) moduleHeight[p] = moduleHeight[m]! + 1;
  }

  // --- 3. Global ids: leaves keep [0, nodeCount); modules are counting-sorted by height so each LOD
  // level is a contiguous id range and every child's id < its parent's (cut/geometry rely on both). ---
  let maxHeight = 1;
  for (let m = 0; m < moduleCount; m++) if (moduleHeight[m]! > maxHeight) maxHeight = moduleHeight[m]!;
  const perHeight = new Uint32Array(maxHeight + 1);
  for (let m = 0; m < moduleCount; m++) perHeight[moduleHeight[m]!] = perHeight[moduleHeight[m]!]! + 1;
  const heightStart = new Uint32Array(maxHeight + 1); // first global id for height-h modules
  let acc = nodeCount;
  for (let h = 1; h <= maxHeight; h++) {
    heightStart[h] = acc;
    acc += perHeight[h]!;
  }
  const moduleId = new Uint32Array(moduleCount); // internal index → global id
  const hcursor = heightStart.slice();
  for (let m = 0; m < moduleCount; m++) {
    const h = moduleHeight[m]!;
    moduleId[m] = hcursor[h]!;
    hcursor[h] = hcursor[h]! + 1;
  }

  const size = nodeCount + moduleCount;
  const levelCount = maxHeight + 1; // level 0 = leaves, levels 1..maxHeight = modules by height
  const levelOffset = new Uint32Array(levelCount + 1);
  levelOffset[1] = nodeCount;
  for (let h = 1; h <= maxHeight; h++) levelOffset[h + 1] = levelOffset[h]! + perHeight[h]!;

  // --- 4. Parent of every tree node (global id), then children CSR (count → prefix-sum → scatter). ---
  const parent = new Int32Array(size).fill(-1);
  for (let i = 0; i < nodeCount; i++) parent[i] = moduleId[leafModule[i]!]!; // leaf → its module
  for (let m = 0; m < moduleCount; m++) {
    const p = moduleParent[m]!;
    if (p >= 0) parent[moduleId[m]!] = moduleId[p]!; // module → parent module (root stays -1)
  }

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
      children[cursor[p]!] = g;
      cursor[p] = cursor[p]! + 1;
    }
  }

  const topo: LODTopology = {
    size,
    leafCount: nodeCount,
    levelCount,
    levelOffset,
    childOffset,
    children,
    edgeOffset: new Uint32Array(size + 1), // undirected coarse adjacency unused for module trees
    edgeNeighbors: new Uint32Array(0),
    parent, // lets the cross-level super-edge gather walk a node up to its present ancestor (#139)
  };
  const hasLinks = !!links?.length;
  if (edges || hasLinks) {
    const input =
      links && leafRank && hasLinks
        ? withModuleLinks(edges, links, resolveLinkPaths(moduleChild, moduleId, leafModule, leafRank))
        : edges;
    if (input) Object.assign(topo, buildSuperEdges(size, parent, input));
  }
  return topo;
}

/**
 * Path → global tree id resolver for {@link ModuleLink} endpoints: walks the module prefix tree, and
 * falls back to the leaf ranked `path[last]` in the enclosing module. Leaf lookup is a (module, rank)
 * map built once — O(nodeCount), only when links are given.
 */
function resolveLinkPaths(
  moduleChild: readonly (Map<number, number> | null)[],
  moduleId: Uint32Array,
  leafModule: Int32Array,
  leafRank: Float64Array,
): (path: ArrayLike<number>) => number {
  const leafByRank = new Map<number, Map<number, number>>(); // module internal index → rank → leaf id
  for (let id = 0; id < leafModule.length; id++) {
    const m = leafModule[id]!;
    let ranks = leafByRank.get(m);
    if (!ranks) leafByRank.set(m, (ranks = new Map()));
    ranks.set(leafRank[id]!, id);
  }
  return (path) => {
    if (path.length < 1) throw new Error("buildModuleLODTree: module link endpoint has an empty path");
    let m = 0;
    for (let d = 0; d < path.length; d++) {
      const child = moduleChild[m]?.get(path[d]!);
      if (child !== undefined) {
        m = child;
        continue;
      }
      const leaf = d === path.length - 1 ? leafByRank.get(m)?.get(path[d]!) : undefined;
      if (leaf === undefined) {
        throw new Error(`buildModuleLODTree: module link endpoint ${Array.from(path).join(":")} is not in the module tree`);
      }
      return leaf;
    }
    return moduleId[m]!;
  };
}

/** The graph's edges (leaf ids) followed by the module links (resolved global ids), as one edge list. */
function withModuleLinks(
  edges: ModuleEdges | undefined,
  links: ArrayLike<ModuleLink>,
  resolve: (path: ArrayLike<number>) => number,
): ModuleEdges {
  const m = edges?.source.length ?? 0;
  const n = m + links.length;
  const source = new Uint32Array(n);
  const target = new Uint32Array(n);
  const weight = new Float32Array(n);
  if (edges) {
    for (let e = 0; e < m; e++) {
      source[e] = edges.source[e]!;
      target[e] = edges.target[e]!;
      weight[e] = edges.weight[e]!;
    }
  }
  for (let l = 0; l < links.length; l++) {
    const link = links[l]!;
    source[m + l] = resolve(link.source);
    target[m + l] = resolve(link.target);
    weight[m + l] = link.flow;
  }
  return { source, target, weight };
}
