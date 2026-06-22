/**
 * The exact `mapequation/network-rendering` `example.svg` network — the "map of networks" glyph style,
 * **without** LOD. Two directed nodes joined by reciprocal links, with a planted **flow** model:
 *
 * - node **flow** (total) → fill colour + radius
 * - node **enter/exit flow** (`outFlow`) → flow-border ring width + colour
 * - link **flow** (the per-edge weight) → half-arrow width + colour
 *
 * The numbers below are the reference's: nodes at (100,100)/(300,180), the same flow values, so the
 * d3 scales in `draw.ts` reproduce the reference's radii (20–30), border widths (3–6) and palette.
 */

/** Node fill colour range (low→high flow): the reference's two oranges. */
export const NODE_FILL_RANGE: [string, string] = ["#EF7518", "#D75908"];
/** Flow-border ring colour range (low→high enter/exit flow): the reference's light oranges. */
export const NODE_BORDER_RANGE: [string, string] = ["#FFAE38", "#f9a327"];
/** Half-arrow link colour range (low→high link flow): the reference's two blues. */
export const LINK_RANGE: [string, string] = ["#71B2D7", "#418EC7"];

export interface ReplicaGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge link flow → half-arrow width + colour. */
  weight: Float32Array;
  positions: Float32Array;
  /** Per-node total flow → fill colour + radius. */
  flow: Float32Array;
  /** Per-node enter/exit (boundary) flow → ring width + colour. */
  outFlow: Float32Array;
}

/** The two-node reference network: node 0 carries more flow than node 1; the 0→1 link is heavier. */
export function buildReplica(): ReplicaGraph {
  return {
    nodeCount: 2,
    source: Uint32Array.from([0, 1]),
    target: Uint32Array.from([1, 0]),
    weight: Float32Array.from([0.5, 0.3]), // link flow: 0→1 heavier than 1→0
    positions: Float32Array.from([100, 100, 300, 180]),
    flow: Float32Array.from([0.6, 0.4]), // node total flow → radius 30 / 20
    outFlow: Float32Array.from([0.3, 0.2]), // enter/exit flow → border 6 / 3
  };
}

/** World bounds of the reference layout (its 400×300 frame), for fitting the initial view. */
export const REPLICA_BOUNDS = { minX: 40, maxX: 360, minY: 50, maxY: 230 };
