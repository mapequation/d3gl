/**
 * A minimal two-node network reproducing the `mapequation/network-rendering` `example.svg` — the
 * "map of networks" glyph style, **without** LOD. Two directed nodes with **flow borders** (ring
 * width ∝ enter/exit flow, fill ∝ total flow) joined by reciprocal **bent half-arrow** links whose
 * width ∝ flow. The values below are chosen to match the reference SVG's sizes and colours.
 */

/** node fill ∝ total flow (the reference's two oranges); index by node. */
export const NODE_FILL = ["rgb(215, 89, 8)", "rgb(239, 117, 24)"];
/** flow-border ring colour (a light orange, as in the reference). */
export const BORDER_COLOR = "rgb(249, 163, 39)";
/** bent half-arrow link colour (the reference's blue). */
export const LINK_COLOR = "rgb(65, 142, 199)";

export interface ReplicaGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge flow → link width. */
  weight: Float32Array;
  positions: Float32Array;
  /** Per-node total flow → fill/size. */
  flow: Float32Array;
  /** Per-node enter/exit (boundary) flow → border-ring width. */
  enterExit: Float32Array;
}

/**
 * Two nodes (big + small) with reciprocal directed links — the reference layout, scaled up a touch.
 * Node 0 is larger (more total + boundary flow); the two links carry different flow.
 */
export function buildReplica(): ReplicaGraph {
  return {
    nodeCount: 2,
    source: Uint32Array.from([0, 1]),
    target: Uint32Array.from([1, 0]),
    weight: Float32Array.from([1.0, 0.45]), // 0→1 heavier than 1→0
    positions: Float32Array.from([200, 200, 560, 360]),
    flow: Float32Array.from([1.0, 0.44]), // → radius 30 / 20 through a sqrt scale
    enterExit: Float32Array.from([1.0, 0.25]), // → border 6px / 3px through a sqrt scale
  };
}

/** World bounds of the two nodes (+ their radii) — for fitting the initial view. */
export const REPLICA_BOUNDS = { minX: 150, maxX: 600, minY: 150, maxY: 400 };
