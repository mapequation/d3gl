/**
 * Overlapping-module pie wedges for the physical view of a state network (#171).
 *
 * A community detection (Infomap) partitions **state** nodes into modules, so a single physical node's
 * state nodes can land in **different modules** — the physical node has an *overlapping* module
 * membership. `physicalPieWedges` turns a per-state-node module assignment (Infomap's `path`-per-node
 * shape, keyed by state-node id) into, for each physical node, the wedges of a pie chart: one wedge per
 * distinct module its state nodes belong to, sized by the summed flow (or count) of those state nodes
 * and coloured by module.
 *
 * A physical node whose state nodes all share one module gets a single wedge (`wedgeCount ≤ 1`) — the
 * renderer draws that as a solid disc (today's glyph), reserving the pie glyph for the overlapping ones.
 *
 * Default colours match {@link moduleColors} at the chosen grouping level (top-level modules split the
 * hue circle into equal HCL arcs), so a solid single-module disc and a wedge for the same module read as
 * the same family hue. Pass `moduleColor` to match any other scheme.
 */
import { hcl } from "d3-color";
import type { StateNetworkGraph } from "./state-graph.js";
import type { ModulePathNode, ModuleColorOptions } from "./module-colors.js";

export interface PieWedgeOptions {
  /**
   * Group state nodes by their module at this **1-based path depth**. Default `1` (top-level module):
   * the natural grain for "which communities does this physical node span". A node whose path is
   * shorter than `level` is grouped by its enclosing module.
   */
  level?: number;
  /**
   * Wedge sizing: `"flow"` sums each state node's flow (needs `graph.state.flow`), `"count"` counts
   * them. Default `"flow"` when the state graph carries flow, else `"count"`.
   */
  by?: "flow" | "count";
  /** HCL colour scheme for the default per-module colours (matches {@link moduleColors}' top-level split). */
  color?: ModuleColorOptions;
  /** Override the per-module wedge colour by module key (the `":"`-joined path prefix). */
  moduleColor?: (moduleKey: string) => string;
}

/**
 * Packed per-physical-node pie wedges. Physical `p`'s wedges are the slice
 * `[offset[p], offset[p + 1])` of the parallel `end` / `color` / `moduleKey` arrays, ordered by module
 * (consistent across physical nodes). `end` is the **cumulative** fraction in `[0, 1]` (a wedge spans
 * `[end[i-1] .. end[i]]`, the first from 0; the last is exactly 1). `wedgeCount[p] ≤ 1` ⇒ a single
 * module ⇒ draw a solid disc, not a pie.
 */
export interface PhysicalPieWedges {
  /** Per-physical start offset into the wedge arrays; length `physicalCount + 1`. */
  offset: Uint32Array;
  /** Cumulative end fraction in `[0, 1]` per wedge (monotonic within a physical node; last = 1). */
  end: Float32Array;
  /** Per-wedge fill colour (CSS string). */
  color: string[];
  /** Per-wedge module key (the grouping-level path prefix), for legends / hit reporting. */
  moduleKey: string[];
  /** Per-physical wedge count; `≤ 1` ⇒ solid disc (single module). Length `physicalCount`. */
  wedgeCount: Uint32Array;
}

/** Compare two `":"`-joined numeric module keys component-wise numerically (so "10" sorts after "2"). */
function compareKeys(a: string, b: string): number {
  const pa = a.split(":");
  const pb = b.split(":");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return pa.length - pb.length;
}

/** The grouping key for a node's path at `level`: the prefix up to `min(level, path.length - 1)`. */
function moduleKeyAt(path: ArrayLike<number>, level: number): string {
  const depth = Math.max(1, Math.min(level, path.length - 1));
  let key = "";
  for (let d = 0; d < depth; d++) key += (d ? ":" : "") + path[d];
  return key || "root"; // path of length 1 (no enclosing module) → a single shared key
}

/**
 * Derive per-physical-node pie wedges from a state-node module assignment. `modules` is Infomap's
 * `nodes` array (each record's `id` is a **state-node** index, `path` its module chain), as consumed by
 * {@link moduleColors} / {@link buildModuleLODTree}. Records must cover every state node.
 */
export function physicalPieWedges(
  graph: StateNetworkGraph,
  modules: ArrayLike<ModulePathNode>,
  opts: PieWedgeOptions = {},
): PhysicalPieWedges {
  const { state, physicalCount, physicalToState } = graph;
  const level = opts.level ?? 1;
  const by = opts.by ?? (state.flow ? "flow" : "count");
  const flow = by === "flow" ? state.flow : null;

  // State-node id → its grouping-level module key. Records must cover every state node.
  const keyOf = new Array<string>(state.nodeCount);
  const seen = new Uint8Array(state.nodeCount);
  for (let r = 0; r < modules.length; r++) {
    const { id, path } = modules[r]!;
    if (!(id >= 0 && id < state.nodeCount)) throw new Error(`physicalPieWedges: module record id ${id} out of range`);
    keyOf[id] = moduleKeyAt(path, level);
    seen[id] = 1;
  }
  for (let s = 0; s < state.nodeCount; s++) {
    if (!seen[s]) throw new Error(`physicalPieWedges: no module record for state node ${s} (must cover every state node)`);
  }

  // Global sorted set of module keys at this level → ordinal, for a consistent wedge order + the default
  // equal-arc HCL colour (matching moduleColors' level split).
  const allKeys = [...new Set(keyOf)].sort(compareKeys);
  const ordinal = new Map<string, number>();
  allKeys.forEach((k, i) => ordinal.set(k, i));

  const L = opts.color?.lightness ?? 65;
  const C = opts.color?.chroma ?? 48;
  const rotate = opts.color?.rotate ?? 20;
  const span = 360 / Math.max(allKeys.length, 1);
  const colorCache = new Map<string, string>();
  const colorOf = (key: string): string => {
    if (opts.moduleColor) return opts.moduleColor(key);
    let c = colorCache.get(key);
    if (c === undefined) {
      const centre = (ordinal.get(key)! + 0.5) * span; // this key's arc centre — matches moduleColors
      c = hcl(centre + rotate, C, L).formatHex();
      colorCache.set(key, c);
    }
    return c;
  };

  // First pass: per-physical-node module → summed size, counting wedges.
  const { offsets, states } = physicalToState;
  const perPhysical: Array<Map<string, number>> = new Array(physicalCount);
  const offset = new Uint32Array(physicalCount + 1);
  const wedgeCount = new Uint32Array(physicalCount);
  for (let p = 0; p < physicalCount; p++) {
    const groups = new Map<string, number>();
    for (let i = offsets[p]!; i < offsets[p + 1]!; i++) {
      const s = states[i]!;
      const w = flow ? flow[s]! : 1;
      const key = keyOf[s]!;
      groups.set(key, (groups.get(key) ?? 0) + w);
    }
    perPhysical[p] = groups;
    wedgeCount[p] = groups.size;
    offset[p + 1] = offset[p]! + groups.size;
  }

  // Second pass: pack cumulative end-fractions + colours, wedges ordered by global module ordinal.
  const total = offset[physicalCount]!;
  const end = new Float32Array(total);
  const color = new Array<string>(total);
  const moduleKey = new Array<string>(total);
  for (let p = 0; p < physicalCount; p++) {
    const groups = perPhysical[p]!;
    let sum = 0;
    for (const w of groups.values()) sum += w;
    const keys = [...groups.keys()].sort((a, b) => ordinal.get(a)! - ordinal.get(b)!);
    let acc = 0;
    let w = offset[p]!;
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!;
      acc += groups.get(key)!;
      end[w] = j === keys.length - 1 ? 1 : sum > 0 ? acc / sum : (j + 1) / keys.length; // last wedge closes at exactly 1
      color[w] = colorOf(key);
      moduleKey[w] = key;
      w++;
    }
  }

  return { offset, end, color, moduleKey, wedgeCount };
}
