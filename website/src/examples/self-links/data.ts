/**
 * A modular, weighted, directed network with self-links, generated from a fixed seed: 56 nodes in four modules
 * of different sizes. Links fall mostly within a module and a few between modules; weights run from 1 to 5. One
 * node in five has a self-link, its weight drawn on the same scale as the other links (in a flow network a
 * self-link is the flow that stays at a node, e.g. a journey that starts and ends at the same place).
 */

export interface SelfLinkGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge weight → link width (a loop's width is its self-link's weight). */
  weight: Float32Array;
  /** Per-node module index, for the node colour. */
  module: Uint8Array;
}

/** Module sizes. */
const MODULES = [20, 15, 12, 9];
/** Expected out-links per node within its module, and to other modules. */
const OUT_WITHIN = 2.4;
const OUT_BETWEEN = 0.25;
const SELF_LINK_SHARE = 0.2;

/** A small seeded PRNG (mulberry32), so the network is the same on every load. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSelfLinkGraph(seed = 505): SelfLinkGraph {
  const rand = random(seed);
  const nodeCount = MODULES.reduce((a, b) => a + b, 0);
  const module = new Uint8Array(nodeCount);
  const start: number[] = [];
  let at = 0;
  MODULES.forEach((size, m) => {
    start.push(at);
    module.fill(m, at, at + size);
    at += size;
  });
  // Skewed weights (mostly light, a few heavy), the same draw for every link, loops included.
  const weightOf = (): number => 1 + Math.floor(5 * rand() ** 2);
  const edges = new Map<string, [number, number, number]>();
  const add = (s: number, t: number): void => {
    if (!edges.has(`${s} ${t}`)) edges.set(`${s} ${t}`, [s, t, weightOf()]);
  };
  for (let s = 0; s < nodeCount; s++) {
    const m = module[s] ?? 0;
    const size = MODULES[m] ?? 1;
    const first = start[m] ?? 0;
    // Within the module: a ring through it keeps it connected, plus random links.
    add(s, first + ((s - first + 1) % size));
    for (let k = 0; k < OUT_WITHIN - 1; k++) {
      const t = first + Math.floor(rand() * size);
      if (t !== s && rand() < 0.9) add(s, t);
    }
    if (rand() < OUT_BETWEEN) {
      const t = Math.floor(rand() * nodeCount);
      if (module[t] !== m) add(s, t);
    }
    if (rand() < SELF_LINK_SHARE) add(s, s);
  }
  // One bridge from each module to the next keeps the network connected.
  for (let m = 1; m < MODULES.length; m++) add(start[m - 1] ?? 0, start[m] ?? 0);
  const list = [...edges.values()];
  return {
    nodeCount,
    source: Uint32Array.from(list, (e) => e[0]),
    target: Uint32Array.from(list, (e) => e[1]),
    weight: Float32Array.from(list, (e) => e[2]),
    module,
  };
}
