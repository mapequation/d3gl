/**
 * Rosette placement for state networks (#171) — the deterministic, backend-independent stopgap for
 * state-node positions until the GPU/module-aware `stateLayout` (#106) lands.
 *
 * A physical node's state nodes are fanned onto a compact phyllotaxis ("sunflower") disc centred on
 * the physical node — a golden-angle rosette. This is exactly the `"rosette"` mode #106 defines
 * (`γ→∞`: state positions = physical centre + a fixed deterministic ring), computed as a pure
 * transform here so #171 needs no layout-solver changes: lay out the **physical** network with the
 * existing `force`/`worker` backend, then feed the derived state positions via `backend: "positions"`.
 *
 * Deterministic (no RNG): identical inputs → identical output, so the layout is reproducible.
 */
import type { StateNetworkGraph } from "./state-graph.js";

export interface RosetteOptions {
  /**
   * Rosette radius for a physical node's state disc. A `number` is a constant world-unit radius; a
   * function receives `(physicalId, stateCount)` to scale per physical node. Default:
   * `4 * sqrt(count)` — busier physical nodes fan wider, keeping the on-disc density roughly constant.
   * A physical node with a single state node ignores this and sits exactly on the physical centre.
   */
  radius?: number | ((physicalId: number, stateCount: number) => number);
  /** Angular offset (radians) applied to every rosette. Default 0. */
  rotate?: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const defaultRadius = (_id: number, count: number): number => 4 * Math.sqrt(count);

/**
 * Derive state-node positions by rosette placement around the (already laid-out) physical nodes.
 * Reads `graph.physical.positions` (fill it first via a layout) and returns a fresh interleaved
 * `[x, y, …]` array of length `2 * graph.state.nodeCount`, ready for
 * `net.data(graph.state).layout({ backend: "positions", positions })`.
 *
 * Each physical node's state nodes are placed on a golden-angle disc of the given radius centred on
 * the physical position; a lone state node coincides with its physical node. Every state node lands
 * within `radius` of its physical centre (guaranteed containment).
 */
export function rosettePositions(graph: StateNetworkGraph, opts: RosetteOptions = {}): Float32Array {
  const { physical, physicalToState, physicalCount, state } = graph;
  const { offsets, states } = physicalToState;
  const pos = physical.positions;
  const rotate = opts.rotate ?? 0;
  const radiusOf = typeof opts.radius === "number" ? () => opts.radius as number : (opts.radius ?? defaultRadius);

  const out = new Float32Array(state.nodeCount * 2);
  for (let p = 0; p < physicalCount; p++) {
    const start = offsets[p]!;
    const count = offsets[p + 1]! - start;
    if (count === 0) continue;
    const cx = pos[2 * p]!;
    const cy = pos[2 * p + 1]!;
    if (count === 1) {
      const s = states[start]!;
      out[2 * s] = cx;
      out[2 * s + 1] = cy;
      continue;
    }
    const R = radiusOf(p, count);
    for (let k = 0; k < count; k++) {
      const s = states[start + k]!;
      // Phyllotaxis disc: golden-angle spacing, radius ∝ √((k+½)/count) so points fill the disc evenly
      // out to R (the outermost sits at R, guaranteeing containment within the physical node).
      const a = rotate + k * GOLDEN_ANGLE;
      const r = R * Math.sqrt((k + 0.5) / count);
      out[2 * s] = cx + r * Math.cos(a);
      out[2 * s + 1] = cy + r * Math.sin(a);
    }
  }
  return out;
}
