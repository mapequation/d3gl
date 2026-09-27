/**
 * The module-tree build over flat typed arrays (#428) — the core of {@link buildModuleLODTree}, and all
 * a Web Worker needs to build a module tree off the main thread (it imports this module, not
 * `./modules.js`, whose record-object API it never sees).
 *
 * A module hierarchy arrives as {@link FlatModuleRecords} (and module links as {@link FlatModuleLinks}):
 * transferable, so the main thread hands it to a worker without cloning an object per node. The build
 * interns every record's module chain into a prefix tree ({@link internModules}), levels the modules by
 * height and derives the super-edges — see {@link buildModuleTopology}.
 */
import { buildSuperEdges, type LODTopology } from "./lod.js";
import type { ModuleEdges } from "./modules.js";

/**
 * A module hierarchy's records as flat typed arrays (#428) — the transferable form of a `ModuleNode[]`:
 * record `r` places node `id[r]` at the Infomap path `entries[offset[r] .. offset[r + 1])`. A worker
 * builds the module tree from these without the main thread cloning an object per node (a structured
 * clone of 325k `{ id, path }` records costs ≈0.3 s; flattening them ≈5 ms). Path entries are integers
 * (int32), as a tree node's {@link LODTopology.branch} is. Make one with {@link flattenModuleRecords}.
 */
export interface FlatModuleRecords {
  id: Uint32Array;
  /** Length `records + 1`. */
  offset: Uint32Array;
  entries: Int32Array;
}

/**
 * {@link ModuleLink}s as flat typed arrays (#428): link `l` runs from the path
 * `source[sourceOffset[l] .. sourceOffset[l + 1])` to `target[targetOffset[l] .. targetOffset[l + 1])`
 * with `flow[l]`. Make one with {@link flattenModuleLinks}.
 */
export interface FlatModuleLinks {
  sourceOffset: Uint32Array;
  source: Int32Array;
  targetOffset: Uint32Array;
  target: Int32Array;
  flow: Float32Array;
}

/** `count` paths as one offsets + entries pair (path `i` is `entries[offset[i] .. offset[i + 1])`). O(total path length). */
export function flattenPaths(count: number, pathOf: (i: number) => ArrayLike<number>): { offset: Uint32Array; entries: Int32Array } {
  const offset = new Uint32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += pathOf(i).length;
    offset[i + 1] = total;
  }
  const entries = new Int32Array(total);
  let w = 0;
  for (let i = 0; i < count; i++) {
    const path = pathOf(i);
    for (let d = 0; d < path.length; d++) entries[w++] = path[d] ?? 0;
  }
  return { offset, entries };
}

/**
 * The records' paths copied into one entries array laid out by `offset` (length `records + 1`, the running
 * sum of the path lengths). The copy pass of a flatten whose caller counted the lengths in its own pass.
 */
export function copyRecordPaths(records: ArrayLike<{ path: ArrayLike<number> }>, offset: Uint32Array): Int32Array {
  const entries = new Int32Array(offset[records.length] ?? 0);
  let w = 0;
  for (let r = 0; r < records.length; r++) {
    const path = records[r]?.path;
    if (!path) continue;
    for (let d = 0; d < path.length; d++) entries[w++] = path[d] ?? 0;
  }
  return entries;
}

/**
 * The distinct modules a set of paths spell (#428), interned in first-seen order: each record's
 * enclosing-module chain (its path minus the last entry, which is the node's rank in its module).
 */
export interface ModuleInterning {
  /** Internal module index → parent internal index (-1 for the root, index 0). */
  moduleParent: number[];
  /** Internal module index → its path entry within the parent (-1 for the root). */
  moduleBranch: number[];
  /** Internal module index → (branch id → child internal index); null for a module with no sub-modules. */
  moduleChild: (Map<number, number> | null)[];
  /** Record index → its enclosing module's internal index. */
  recordModule: Int32Array;
}

/**
 * Intern the modules of the paths `entries[offset[r] .. offset[r + 1])` by walking an integer-keyed prefix
 * tree: each module lazily holds a child map keyed by the next path entry (branch id). A prefix
 * corresponds one-to-one with a (parent, branch) chain, so this registers the exact modules — in the exact
 * order — that interning ":"-joined path strings did, without the O(nodes · depth) transient strings
 * (#215). Each module's parent is recorded at creation; the root (index 0) is always present.
 *
 * A record only walks the part of its chain it does not share with the record before it (#428): in tree
 * order (an Infomap `.tree`/`.ftree`/JSON file) consecutive nodes mostly share their whole module chain,
 * so the walk is O(total path length) integer compares with a map lookup only where the chain changes —
 * and still exact, with the same registration order, for records in any order.
 */
export function internModules(offset: Uint32Array, entries: Int32Array): ModuleInterning {
  const moduleParent: number[] = [];
  const moduleBranch: number[] = [];
  const moduleChild: (Map<number, number> | null)[] = [];
  const registerModule = (parent: number, branch: number): number => {
    moduleParent.push(parent);
    moduleBranch.push(branch);
    moduleChild.push(null);
    return moduleParent.length - 1;
  };
  registerModule(-1, -1); // the root — always present, even for a flat (module-less) network

  const records = offset.length - 1;
  const recordModule = new Int32Array(records);
  // The previous record's chain: chain[d] = the module its path prefix of length d + 1 names.
  let chain = new Int32Array(16);
  let chainLength = 0;
  let previous = 0; // the previous record's first entry
  for (let r = 0; r < records; r++) {
    const start = offset[r] ?? 0;
    const depth = (offset[r + 1] ?? start) - start - 1; // modules on the path: all entries but the rank
    let shared = 0;
    const limit = depth < chainLength ? depth : chainLength;
    while (shared < limit && entries[start + shared] === entries[previous + shared]) shared++;
    if (depth > chain.length) {
      const grown = new Int32Array(Math.max(depth, 2 * chain.length));
      grown.set(chain);
      chain = grown;
    }
    let m = shared > 0 ? (chain[shared - 1] ?? 0) : 0;
    for (let d = shared; d < depth; d++) {
      const branch = entries[start + d] ?? 0;
      let kids = moduleChild[m];
      if (!kids) moduleChild[m] = kids = new Map();
      let child = kids.get(branch);
      if (child === undefined) {
        child = registerModule(m, branch);
        kids.set(branch, child);
      }
      m = child;
      chain[d] = m;
    }
    recordModule[r] = m;
    chainLength = depth > 0 ? depth : 0;
    previous = start;
  }
  return { moduleParent, moduleBranch, moduleChild, recordModule };
}

/** The module prefix tree the records spell (step 1 of {@link buildModuleTopology}). */
export interface ModulePrefixTree extends Omit<ModuleInterning, "recordModule"> {
  /** Node id → enclosing module's internal index. */
  leafModule: Int32Array;
  /** Node id → last path entry (its rank in its module). */
  leafRank: Int32Array;
}

/** {@link internModules} keyed by node id. `records` must be valid ({@link flattenModuleRecords} checks). */
export function modulePrefixTree(nodeCount: number, records: FlatModuleRecords): ModulePrefixTree {
  const { moduleParent, moduleBranch, moduleChild, recordModule } = internModules(records.offset, records.entries);
  const leafModule = new Int32Array(nodeCount).fill(-1); // node id → enclosing module's internal index
  const leafRank = new Int32Array(nodeCount); // node id → last path entry (its rank in its module)
  for (let r = 0; r < recordModule.length; r++) {
    const id = records.id[r] ?? 0;
    leafModule[id] = recordModule[r] ?? 0;
    leafRank[id] = records.entries[(records.offset[r + 1] ?? 1) - 1] ?? 0;
  }
  return { moduleParent, moduleBranch, moduleChild, leafModule, leafRank };
}

/**
 * The {@link LODTopology} of a module hierarchy given as {@link FlatModuleRecords} (#428) — what
 * {@link buildModuleLODTree} builds, minus the geometry arrays; the form a worker builds and transfers.
 * `records` must be valid for `nodeCount` (as {@link flattenModuleRecords} checks); `edges` and `links`
 * derive the super-edges as in {@link buildModuleLODTree}.
 */
export function buildModuleTopology(
  nodeCount: number,
  records: FlatModuleRecords,
  edges?: ModuleEdges,
  links?: FlatModuleLinks,
): LODTopology {
  const { moduleParent, moduleBranch, moduleChild, leafModule, leafRank } = modulePrefixTree(nodeCount, records);
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

  const branch = new Int32Array(size);
  branch.set(leafRank);
  for (let m = 0; m < moduleCount; m++) branch[moduleId[m]!] = moduleBranch[m]!;

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
    branch, // + parent → any node's Infomap path (aggregate identity for labels/picks)
  };
  const hasLinks = !!links?.flow.length;
  if (edges || hasLinks) {
    const input =
      links && hasLinks
        ? withModuleLinks(edges, links, resolveLinkPaths(moduleChild, moduleId, leafModule, leafRank))
        : edges;
    if (input) Object.assign(topo, buildSuperEdges(size, parent, input));
    // The module links on their own too, by endpoint (#329): what an expanded module's boundary anchors.
    if (input && hasLinks) Object.assign(topo, moduleLinkRows(size, nodeCount, parent, input, edges?.source.length ?? 0));
  }
  return topo;
}

/**
 * The module links (#199) indexed by their own endpoints (#329) — `edges[from ..]`, as resolved tree
 * ids: per aggregate, its outgoing links (other endpoint + flow, summed per ordered pair) and, as the
 * transpose, its incoming ones. These are what a module's boundary anchors when the cut expands it,
 * since no finer pair carries a module link's flow. A link into its own endpoint's ancestor lies
 * inside one subtree at every cut and is left out, as in {@link buildSuperEdges}. Rows exist for
 * aggregates only. O(links · depth) time (the ancestor test), O(modules + links) memory.
 */
function moduleLinkRows(
  size: number,
  leafCount: number,
  parent: Int32Array,
  edges: ModuleEdges,
  from: number,
): Pick<LODTopology, "moduleLinkOffset" | "moduleLinkTarget" | "moduleLinkFlow" | "moduleLinkInOffset" | "moduleLinkInSource" | "moduleLinkInFlow"> {
  const rows = size - leafCount;
  const m = edges.source.length;
  // Tree ids grow toward the root, so `a` is `b`'s ancestor (or vice versa) iff climbing from the smaller
  // id while below the larger one lands on it.
  const nested = (a: number, b: number): boolean => {
    let x = a < b ? a : b;
    const top = a < b ? b : a;
    while (x >= 0 && x < top) x = parent[x]!;
    return x === top;
  };
  const kept = new Uint8Array(m - from);
  const outOffset = new Uint32Array(rows + 1);
  const inOffset = new Uint32Array(rows + 1);
  for (let e = from; e < m; e++) {
    const s = edges.source[e]!;
    const t = edges.target[e]!;
    if (s === t || nested(s, t)) continue;
    kept[e - from] = 1;
    if (s >= leafCount) outOffset[s - leafCount + 1]!++;
    if (t >= leafCount) inOffset[t - leafCount + 1]!++;
  }
  for (let r = 0; r < rows; r++) {
    outOffset[r + 1] = outOffset[r + 1]! + outOffset[r]!;
    inOffset[r + 1] = inOffset[r + 1]! + inOffset[r]!;
  }
  const outOther = new Uint32Array(outOffset[rows]!);
  const outFlow = new Float32Array(outOffset[rows]!);
  const inOther = new Uint32Array(inOffset[rows]!);
  const inFlow = new Float32Array(inOffset[rows]!);
  const outCursor = outOffset.slice(0, rows);
  const inCursor = inOffset.slice(0, rows);
  for (let e = from; e < m; e++) {
    if (!kept[e - from]) continue;
    const s = edges.source[e]!;
    const t = edges.target[e]!;
    const w = edges.weight[e]!;
    if (s >= leafCount) {
      const p = outCursor[s - leafCount]!++;
      outOther[p] = t;
      outFlow[p] = w;
    }
    if (t >= leafCount) {
      const p = inCursor[t - leafCount]!++;
      inOther[p] = s;
      inFlow[p] = w;
    }
  }
  // Sum repeated pairs within each row, compacting in place (`mark[x] === r` ⇔ x already in row r).
  const mark = new Int32Array(size).fill(-1);
  const slot = new Uint32Array(size);
  const compact = (offset: Uint32Array, other: Uint32Array, flow: Float32Array): [Uint32Array, Float32Array] => {
    let w = 0;
    let start = 0;
    for (let r = 0; r < rows; r++) {
      const end = offset[r + 1]!;
      for (let p = start; p < end; p++) {
        const x = other[p]!;
        if (mark[x] !== r) {
          mark[x] = r;
          slot[x] = w;
          other[w] = x;
          flow[w] = flow[p]!;
          w++;
        } else {
          flow[slot[x]!] = flow[slot[x]!]! + flow[p]!;
        }
      }
      start = end;
      offset[r + 1] = w;
    }
    return [other.slice(0, w), flow.slice(0, w)];
  };
  const [moduleLinkTarget, moduleLinkFlow] = compact(outOffset, outOther, outFlow);
  mark.fill(-1);
  const [moduleLinkInSource, moduleLinkInFlow] = compact(inOffset, inOther, inFlow);
  return { moduleLinkOffset: outOffset, moduleLinkTarget, moduleLinkFlow, moduleLinkInOffset: inOffset, moduleLinkInSource, moduleLinkInFlow };
}

/**
 * Path → global tree id resolver for {@link ModuleLink} endpoints: walks the module prefix tree, and
 * falls back to the leaf ranked `path[last]` in the enclosing module. Leaf lookup is a (module, rank)
 * map built once — O(nodeCount), only when links are given.
 */
export function resolveLinkPaths(
  moduleChild: readonly (Map<number, number> | null)[],
  moduleId: Uint32Array,
  leafModule: Int32Array,
  leafRank: Int32Array,
  who = "buildModuleLODTree",
): (entries: Int32Array, start: number, end: number) => number {
  const leafByRank = new Map<number, Map<number, number>>(); // module internal index → rank → leaf id
  for (let id = 0; id < leafModule.length; id++) {
    const m = leafModule[id]!;
    let ranks = leafByRank.get(m);
    if (!ranks) leafByRank.set(m, (ranks = new Map()));
    ranks.set(leafRank[id]!, id);
  }
  return (entries, start, end) => {
    if (end - start < 1) throw new Error(`${who}: module link endpoint has an empty path`);
    let m = 0;
    for (let d = start; d < end; d++) {
      const branch = entries[d] ?? 0;
      const child = moduleChild[m]?.get(branch);
      if (child !== undefined) {
        m = child;
        continue;
      }
      const leaf = d === end - 1 ? leafByRank.get(m)?.get(branch) : undefined;
      if (leaf === undefined) {
        throw new Error(`${who}: module link endpoint ${Array.from(entries.subarray(start, end)).join(":")} is not in the module tree`);
      }
      return leaf;
    }
    return moduleId[m] ?? 0;
  };
}

/** The graph's edges (leaf ids) followed by the module links (resolved global ids), as one edge list. */
function withModuleLinks(
  edges: ModuleEdges | undefined,
  links: FlatModuleLinks,
  resolve: (entries: Int32Array, start: number, end: number) => number,
): ModuleEdges {
  const m = edges?.source.length ?? 0;
  const n = m + links.flow.length;
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
  for (let l = 0; l < links.flow.length; l++) {
    source[m + l] = resolve(links.source, links.sourceOffset[l] ?? 0, links.sourceOffset[l + 1] ?? 0);
    target[m + l] = resolve(links.target, links.targetOffset[l] ?? 0, links.targetOffset[l + 1] ?? 0);
    weight[m + l] = links.flow[l] ?? 0;
  }
  return { source, target, weight };
}
