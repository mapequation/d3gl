/**
 * A small directed network with self-links: six nodes on a ring and a hub, linked around the ring and to the
 * hub, with a self-link on three ring nodes (each loop points away from the hub). Node 2 has two self-link edges, which d3gl sums into one loop.
 */

export interface SelfLinkGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge weight → link width (a loop's width is its node's summed self-link weight). */
  weight: Float32Array;
  positions: Float32Array;
}

const RING = 6;
const RADIUS = 120;

/** Edges as `[source, target, weight]`; a self-link has `source === target`. */
const EDGES: [number, number, number][] = [
  // around the ring, and each ring node to the hub (node 6)
  [0, 1, 2], [1, 2, 1], [2, 3, 3], [3, 4, 1], [4, 5, 2], [5, 0, 1],
  [0, 6, 1], [6, 1, 2], [2, 6, 1], [6, 3, 1], [4, 6, 2], [6, 5, 1],
  // self-links: node 2's two edges are summed into one loop of weight 4
  [0, 0, 3], [2, 2, 1], [2, 2, 3], [4, 4, 1],
];

export function buildSelfLinkGraph(): SelfLinkGraph {
  const positions = new Float32Array(2 * (RING + 1));
  for (let i = 0; i < RING; i++) {
    const a = (2 * Math.PI * i) / RING - Math.PI / 2;
    positions[2 * i] = RADIUS * Math.cos(a);
    positions[2 * i + 1] = RADIUS * Math.sin(a);
  }
  return {
    nodeCount: RING + 1,
    source: Uint32Array.from(EDGES, (e) => e[0]),
    target: Uint32Array.from(EDGES, (e) => e[1]),
    weight: Float32Array.from(EDGES, (e) => e[2]),
    positions, // the hub sits at the origin
  };
}

/** World bounds of the layout, loops included, for fitting the initial view. */
export const BOUNDS = { minX: -190, maxX: 190, minY: -190, maxY: 190 };
