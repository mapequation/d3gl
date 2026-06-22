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
 */
export function moduleColors(nodes: ArrayLike<ModulePathNode>, opts: ModuleColorOptions = {}): string[] {
  const L = opts.lightness ?? 65;
  const C = opts.chroma ?? 48;
  const rotate = opts.rotate ?? 20;
  const n = nodes.length;
  const prefixKey = (path: ArrayLike<number>, len: number): string => {
    let s = "";
    for (let i = 0; i < len; i++) s += (i ? ":" : "") + path[i];
    return s;
  };

  // Per module prefix, the sorted set of its children's components → ordinal index, so each level can
  // split its parent's arc deterministically by child order.
  const childSets = new Map<string, Set<number>>();
  for (let r = 0; r < n; r++) {
    const { path } = nodes[r]!;
    for (let d = 0; d + 1 < path.length; d++) {
      const k = prefixKey(path, d);
      let set = childSets.get(k);
      if (!set) childSets.set(k, (set = new Set()));
      set.add(path[d]!);
    }
  }
  const ordinals = new Map<string, Map<number, number>>();
  for (const [k, set] of childSets) {
    const ord = new Map<number, number>();
    [...set].sort((a, b) => a - b).forEach((c, i) => ord.set(c, i));
    ordinals.set(k, ord);
  }

  const out = new Array<string>(n);
  for (let r = 0; r < n; r++) {
    const { id, path } = nodes[r]!;
    let a = 0;
    let b = 360;
    for (let d = 0; d + 1 < path.length; d++) {
      const ord = ordinals.get(prefixKey(path, d))!;
      const span = (b - a) / ord.size;
      a += ord.get(path[d]!)! * span;
      b = a + span;
    }
    out[id] = hcl((a + b) / 2 + rotate, C, L).formatHex(); // the enclosing module's arc centre
  }
  return out;
}
