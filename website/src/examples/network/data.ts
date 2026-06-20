export interface GeneratedNetwork {
  nodeCount: number;
  source: number[];
  target: number[];
}

/**
 * A small circulant directed network: each node links to its next neighbour (the ring) and to a
 * chord partner, so the directed arrowheads read clearly. No coordinates — the engine's force
 * layout places the nodes.
 */
export function makeNetwork(count: number): GeneratedNetwork {
  const source: number[] = [];
  const target: number[] = [];
  const chord = Math.max(2, Math.floor(count / 3));
  for (let i = 0; i < count; i++) {
    source.push(i, i);
    target.push((i + 1) % count, (i + chord) % count);
  }
  return { nodeCount: count, source, target };
}
