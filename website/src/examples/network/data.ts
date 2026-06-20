export interface GeneratedNetwork {
  nodeCount: number;
  source: number[];
  target: number[];
}

const CLIQUE_SIZE = 10;

/**
 * A "ring of cliques": `count / 10` fully-connected cliques of 10 nodes, each bridged to the next
 * in a ring. The dense clusters joined by sparse bridges give the force layout real structure to
 * resolve — a good stress test for the layout and renderer as the node count scales from 10 to
 * 1,000,000.
 */
export function makeNetwork(count: number): GeneratedNetwork {
  const cliques = Math.max(1, Math.floor(count / CLIQUE_SIZE));
  const nodeCount = cliques * CLIQUE_SIZE;
  const source: number[] = [];
  const target: number[] = [];
  for (let c = 0; c < cliques; c++) {
    const base = c * CLIQUE_SIZE;
    // Complete graph within the clique (each undirected pair once).
    for (let i = 0; i < CLIQUE_SIZE; i++) {
      for (let j = i + 1; j < CLIQUE_SIZE; j++) {
        source.push(base + i);
        target.push(base + j);
      }
    }
    // Bridge to the next clique, closing the ring.
    if (cliques > 1) {
      source.push(base);
      target.push(((c + 1) % cliques) * CLIQUE_SIZE);
    }
  }
  return { nodeCount, source, target };
}
