/**
 * Hierarchical module colours (#104 rework).
 *
 * Encode a provided module hierarchy (Infomap-style `path` per node) as colour: the top-level modules
 * split the hue circle into equal arcs, and each deeper level subdivides its *parent's* arc among that
 * parent's children. So a top module is a hue family and its sub-modules are neighbouring hues within
 * it — the planted hierarchy reads as colour, and (paired with the LOD cut's circular-hue averaging)
 * a collapsed module glyph shows its family's representative hue.
 *
 * Clean-room reimplementation of the scheme mapequation uses for module colours, generalised to a
 * standalone function over the path-per-node shape. Colours are in HCL/CIELCh for perceptually even
 * spacing.
 */
import { hcl } from "d3-color";
import { copyRecordPaths, internModules } from "./module-topology.js";

/** A node's placement in the module tree — `path` is the Infomap 1-based chain (last entry is the rank). */
export interface ModulePathNode {
  id: number;
  path: ArrayLike<number>;
}

export interface ModuleColorOptions {
  /** HCL lightness (0–100), default 65. */
  lightness?: number;
  /** HCL chroma (≈0–130), default 48. A muted, mapequation-like default. */
  chroma?: number;
  /** Rotate all hues (degrees), to shift where the palette starts. Default 20. */
  rotate?: number;
}

/**
 * Per-node CSS colours (indexed by node `id`) for a module hierarchy. A node takes the hue of its
 * **enclosing module** (`path` minus the final rank), so all nodes in a module share a colour and
 * sibling modules get neighbouring hues within their parent's arc.
 *
 * A colour belongs to a module, so each is computed once per module (#428): O(nodes · depth) integer work
 * to find every node's module (see {@link internModules}), plus one HCL conversion per module that holds
 * a node — not one per node. For a 325k-node, ~40k-module Infomap map: 0.2 s → 58-66 ms in a production
 * browser build (cold), 0.22 s → 24-26 ms in Node once warm.
 */
export function moduleColors(nodes: ArrayLike<ModulePathNode>, opts: ModuleColorOptions = {}): string[] {
  const L = opts.lightness ?? 65;
  const C = opts.chroma ?? 48;
  const rotate = opts.rotate ?? 20;
  const n = nodes.length;
  const offset = new Uint32Array(n + 1);
  for (let r = 0, total = 0; r < n; r++) {
    total += nodes[r]?.path.length ?? 0;
    offset[r + 1] = total;
  }
  const { moduleParent, moduleChild, recordModule } = internModules(offset, copyRecordPaths(nodes, offset));

  // Each module's arc: its parent's arc split evenly among the parent's sub-modules, in branch order.
  // A module is registered after its parent, so one forward pass sees every parent's arc first.
  const count = moduleParent.length;
  const ordinal = new Int32Array(count);
  const siblings = new Int32Array(count);
  for (let m = 0; m < count; m++) {
    const kids = moduleChild[m];
    if (!kids) continue;
    const branches = [...kids.keys()].sort((a, b) => a - b);
    for (let i = 0; i < branches.length; i++) {
      const child = kids.get(branches[i] ?? 0) ?? 0;
      ordinal[child] = i;
      siblings[child] = branches.length;
    }
  }
  const lo = new Float64Array(count);
  const hi = new Float64Array(count);
  hi[0] = 360;
  for (let m = 1; m < count; m++) {
    const p = moduleParent[m] ?? 0;
    const a = lo[p] ?? 0;
    const span = ((hi[p] ?? 0) - a) / (siblings[m] ?? 1);
    lo[m] = a + (ordinal[m] ?? 0) * span;
    hi[m] = (lo[m] ?? 0) + span;
  }

  const colour = new Array<string | undefined>(count);
  const out = new Array<string>(n);
  for (let r = 0; r < n; r++) {
    const m = recordModule[r] ?? 0;
    let c = colour[m];
    if (c === undefined) colour[m] = c = hcl(((lo[m] ?? 0) + (hi[m] ?? 0)) / 2 + rotate, C, L).formatHex(); // the arc centre
    out[nodes[r]?.id ?? r] = c;
  }
  return out;
}

/**
 * Every node's **enclosing module** (#494) — its path minus the final rank, as {@link moduleColors} colours
 * it — with each distinct module listed once, so a colour per module is resolved once per module, not once
 * per node. `moduleOf[id]` indexes `paths`; −1 for an id no record covers.
 */
export interface NodeModules {
  /** Node id → its enclosing module's index in {@link paths} (−1: no record). Length `nodeCount`. */
  moduleOf: Int32Array;
  /** Module index → its path (`[]` for the root: a node whose path is its rank alone). */
  paths: readonly (readonly number[])[];
}

/** {@link NodeModules} of `records` over `nodeCount` node ids: O(total path length + modules · depth). */
export function nodeModules(nodeCount: number, records: ArrayLike<ModulePathNode>): NodeModules {
  const n = records.length;
  const offset = new Uint32Array(n + 1);
  for (let r = 0, total = 0; r < n; r++) {
    total += records[r]?.path.length ?? 0;
    offset[r + 1] = total;
  }
  const { moduleParent, moduleBranch, recordModule } = internModules(offset, copyRecordPaths(records, offset));
  // A module is registered after its parent, so one forward pass extends each parent's path.
  const paths = new Array<readonly number[]>(moduleParent.length);
  for (let m = 0; m < moduleParent.length; m++) {
    const parent = moduleParent[m] ?? -1;
    paths[m] = parent < 0 ? [] : [...(paths[parent] ?? []), moduleBranch[m] ?? 0];
  }
  const moduleOf = new Int32Array(nodeCount).fill(-1);
  for (let r = 0; r < n; r++) {
    const id = records[r]?.id ?? -1;
    if (id >= 0 && id < nodeCount) moduleOf[id] = recordModule[r] ?? -1;
  }
  return { moduleOf, paths };
}

/** The parts of a provided-module LOD tree that name its aggregates' modules (`parent` + `branch`, #197). */
export interface ModuleTreeNames {
  leafCount: number;
  size: number;
  levelCount: number;
  levelOffset: Uint32Array;
  parent?: Int32Array;
  branch?: Int32Array;
}

/**
 * Each aggregate's own module colour on a module tree (#494): RGBA per aggregate, `4·(size − leafCount)`. An
 * aggregate's module path (as its hit's `path`) is looked up among `paths` (an interned hierarchy's modules)
 * and coloured `rgbaOf(m)` — so a module the nodes' colours already resolved is not asked again — or, for a path
 * outside it (an explicit `lod({ modules })` of another partition), `rgbaOfPath(path)`. Null for a tree that is
 * not a module tree (spatial, structural): its aggregates are no modules. Levels are walked from the root down,
 * so each path extends its parent's. O(aggregates · depth + modules · depth) once per (tree, style), never per
 * frame; the path index is dropped when it returns.
 */
export function moduleAggregateColors(
  tree: ModuleTreeNames,
  paths: readonly (readonly number[])[],
  rgbaOf: (m: number) => ArrayLike<number>,
  rgbaOfPath: (path: readonly number[]) => ArrayLike<number>,
): Uint8Array | null {
  const { leafCount, size, levelCount, levelOffset, parent, branch } = tree;
  if (!parent || !branch) return null;
  const index = new Map<string, number>();
  for (let m = 0; m < paths.length; m++) index.set((paths[m] ?? []).join(","), m);
  const out = new Uint8Array(4 * (size - leafCount));
  const named = new Array<readonly number[]>(size - leafCount);
  // A parent sits on a higher level than its children (levels are module heights), so it is named first.
  for (let k = levelCount - 1; k >= 1; k--) {
    for (let g = levelOffset[k]!; g < levelOffset[k + 1]!; g++) {
      const p = parent[g]!;
      const path = p < 0 ? [] : [...(named[p - leafCount] ?? []), branch[g]!];
      named[g - leafCount] = path;
      const m = index.get(path.join(","));
      out.set(m === undefined ? rgbaOfPath(path) : rgbaOf(m), 4 * (g - leafCount));
    }
  }
  return out;
}
