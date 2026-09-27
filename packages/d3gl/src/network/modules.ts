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
import { lodTreeFromTopology, type LODTree } from "./lod.js";
import {
  buildModuleTopology,
  copyRecordPaths,
  flattenPaths,
  modulePrefixTree,
  resolveLinkPaths,
  type FlatModuleLinks,
  type FlatModuleRecords,
} from "./module-topology.js";

export type { FlatModuleLinks, FlatModuleRecords } from "./module-topology.js";

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
 * Flatten `records` into {@link FlatModuleRecords}, checking them against a graph of `nodeCount` nodes on
 * the way — one record per node `0..nodeCount-1`, each with a non-empty path — as the tree build does.
 * Throws on an out-of-range, duplicate, missing or empty-path record (messages prefixed with `who`).
 * O(nodes · depth).
 */
export function flattenModuleRecords(nodeCount: number, records: ArrayLike<ModuleNode>, who = "buildModuleLODTree"): FlatModuleRecords {
  const count = records.length;
  const id = new Uint32Array(count);
  const offset = new Uint32Array(count + 1);
  const seen = new Uint8Array(nodeCount);
  let total = 0;
  for (let r = 0; r < count; r++) {
    const record = records[r];
    const i = record ? record.id : NaN;
    if (!(i >= 0 && i < nodeCount)) throw new Error(`${who}: record id ${i} out of range [0, ${nodeCount})`);
    if (seen[i]) throw new Error(`${who}: duplicate record for node id ${i}`);
    seen[i] = 1;
    const length = record ? record.path.length : 0;
    if (length < 1) throw new Error(`${who}: node id ${i} has an empty path`);
    id[r] = i;
    total += length;
    offset[r + 1] = total;
  }
  for (let i = 0; i < nodeCount; i++) {
    if (!seen[i]) throw new Error(`${who}: no record for node id ${i} (records must cover every node)`);
  }
  return { id, offset, entries: copyRecordPaths(records, offset) };
}

/** Flatten `links` into {@link FlatModuleLinks}. O(links · depth). Endpoints are checked when resolved. */
export function flattenModuleLinks(links: ArrayLike<ModuleLink>): FlatModuleLinks {
  const count = links.length;
  const source = flattenPaths(count, (l) => links[l]?.source ?? []);
  const target = flattenPaths(count, (l) => links[l]?.target ?? []);
  const flow = new Float32Array(count);
  for (let l = 0; l < count; l++) flow[l] = links[l]?.flow ?? 0;
  return { sourceOffset: source.offset, source: source.entries, targetOffset: target.offset, target: target.entries, flow };
}

/**
 * Check that `records` align with a graph's dense node indices — one record per node `0..nodeCount-1`,
 * each with a non-empty path — and return the record index of every node (`recordOf[id]`). The same
 * contract {@link buildModuleLODTree} enforces, checked on its own in O(nodeCount) so the engine can
 * validate a hierarchy once, when it is set (`Network.data(graph, { modules })`, #326), without building
 * the tree. Throws on an out-of-range, duplicate, missing or empty-path record.
 */
export function moduleRecordIndex(nodeCount: number, records: ArrayLike<ModuleNode>): Int32Array {
  const recordOf = new Int32Array(nodeCount).fill(-1);
  for (let r = 0; r < records.length; r++) {
    const { id, path } = records[r]!;
    if (!(id >= 0 && id < nodeCount)) throw new Error(`module records: record id ${id} out of range [0, ${nodeCount})`);
    if (recordOf[id]! >= 0) throw new Error(`module records: duplicate record for node id ${id}`);
    if (path.length < 1) throw new Error(`module records: node id ${id} has an empty path`);
    recordOf[id] = r;
  }
  for (let i = 0; i < nodeCount; i++) {
    if (recordOf[i]! < 0) throw new Error(`module records: no record for node id ${i} (records must cover every node)`);
  }
  return recordOf;
}

/**
 * Check that every {@link ModuleLink} endpoint names a module or a leaf of the hierarchy `records` spell
 * — what {@link buildModuleLODTree} checks when it resolves them — on its own, so the engine can validate
 * `moduleLinks` once, when they are set (`Network.data(graph, { modules, moduleLinks })`, #326), without
 * building the tree. Throws on an empty path or an endpoint that is not in the module tree. `records` must
 * pass {@link moduleRecordIndex}. O(nodes · depth + links · depth), transient memory only.
 */
export function checkModuleLinks(nodeCount: number, records: ArrayLike<ModuleNode>, links: ArrayLike<ModuleLink>, who = "module links"): void {
  if (links.length === 0) return;
  const { moduleChild, leafModule, leafRank } = modulePrefixTree(nodeCount, flattenModuleRecords(nodeCount, records, "module records"));
  // Resolve to internal module indices: only whether each endpoint resolves matters here.
  const resolve = resolveLinkPaths(moduleChild, Uint32Array.from(moduleChild.keys()), leafModule, leafRank, who);
  const flat = flattenModuleLinks(links);
  for (let l = 0; l < links.length; l++) {
    resolve(flat.source, flat.sourceOffset[l] ?? 0, flat.sourceOffset[l + 1] ?? 0);
    resolve(flat.target, flat.targetOffset[l] ?? 0, flat.targetOffset[l + 1] ?? 0);
  }
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
  const flatLinks = links?.length ? flattenModuleLinks(links) : undefined;
  return lodTreeFromTopology(buildModuleTopology(nodeCount, flattenModuleRecords(nodeCount, records), edges, flatLinks));
}

