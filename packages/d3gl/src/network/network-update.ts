import { checkModuleLinks, moduleRecordIndex, type ModuleLink, type ModuleNode } from "./modules.js";
import type { NetworkUpdateOptions } from "./network.js";

/** An engine-owned module hierarchy (#326), with each node's record index (`recordOf[id]`, from the one-time
 *  alignment check). */
export interface ModuleHierarchy {
  modules: ArrayLike<ModuleNode>;
  moduleLinks: ArrayLike<ModuleLink> | undefined;
  recordOf: Int32Array;
}

/** A checked change to the flow and the modules of a loaded network (#547). `undefined` = unchanged. */
export interface NetworkUpdatePlan {
  /** The new per-node flow, the engine's own copy. */
  flow: Float32Array | undefined;
  /** The new hierarchy, `null` = none. */
  hierarchy: ModuleHierarchy | null | undefined;
}

/**
 * Check a change to the flow and the modules of a network of `nodeCount` nodes that holds `held` (#547), as
 * `data()` checks its hierarchy: a flow value per node, a module record for every node exactly once, and every
 * module link endpoint a module or leaf of the hierarchy it ends up with. A field left out is unchanged, except that
 * new modules without `moduleLinks` clear the held module links; `modules: null` removes the modules and their links.
 * Throws, prefixed with `who`, on a bad change. O(nodes + total path length + module links), and nothing is
 * changed: the caller applies the plan only once it has passed.
 */
export function planNetworkUpdate(who: string, nodeCount: number, opts: NetworkUpdateOptions, held: ModuleHierarchy | null): NetworkUpdatePlan {
  const { flow, modules, moduleLinks } = opts;
  let nextFlow: Float32Array | undefined;
  if (flow !== undefined) {
    if (flow.length !== nodeCount) throw new Error(`${who}: flow length ${flow.length} !== nodeCount ${nodeCount}`);
    nextFlow = Float32Array.from(flow);
  }
  if (modules === undefined && moduleLinks === undefined) return { flow: nextFlow, hierarchy: undefined };
  const nextModules = modules === undefined ? (held?.modules ?? null) : modules;
  if (nextModules === null) {
    if (moduleLinks) throw new Error(`${who}: moduleLinks requires modules`);
    return { flow: nextFlow, hierarchy: null };
  }
  // New modules clear the held module links unless new ones come with them: those are addressed in the old
  // partition's paths, and an old path that happens to exist in the new modules would draw a wrong link.
  const nextLinks = moduleLinks !== undefined ? (moduleLinks ?? undefined) : modules === undefined ? held?.moduleLinks : undefined;
  // Held records were checked when they were set; new ones are checked here.
  const recordOf = modules === undefined && held ? held.recordOf : moduleRecordIndex(nodeCount, nextModules);
  if (nextLinks) checkModuleLinks(nodeCount, nextModules, nextLinks);
  return { flow: nextFlow, hierarchy: { modules: nextModules, moduleLinks: nextLinks, recordOf } };
}
