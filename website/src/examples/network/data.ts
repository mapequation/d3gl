export interface GeneratedNetwork {
  nodeCount: number;
  source: number[];
  target: number[];
  /** Interleaved [x, y, …] world positions, one per node. */
  positions: Float32Array;
}

/**
 * A small circulant directed network laid out on a circle: each node links to its next neighbour
 * (the ring) and to a chord partner, so the directed arrowheads read clearly. Positions are
 * supplied directly here — d3gl's in-library force layout for unpositioned graphs lands in a
 * later step.
 */
export function makeNetwork(count: number, width: number, height: number): GeneratedNetwork {
  const positions = new Float32Array(count * 2);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.4;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    positions[i * 2] = cx + radius * Math.cos(angle);
    positions[i * 2 + 1] = cy + radius * Math.sin(angle);
  }

  const source: number[] = [];
  const target: number[] = [];
  const chord = Math.max(2, Math.floor(count / 3));
  for (let i = 0; i < count; i++) {
    source.push(i, i);
    target.push((i + 1) % count, (i + chord) % count);
  }

  return { nodeCount: count, source, target, positions };
}
