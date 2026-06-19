export interface Node {
  id: string;
  x: number;
  y: number;
  /** Importance in [0, 1] — drives the radius, the color, AND the declutter priority,
   *  so the "biggest = most important = survives crowding" story reads off one channel. */
  importance: number;
  radius: number;
  label: string;
}

/** Deterministic PRNG (mulberry32) so the scatter — and its screenshots — are stable. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEAD = ["Al", "Be", "Ca", "Da", "El", "Fi", "Go", "Ha", "Io", "Ju", "Ka", "Lo", "Ma", "Ne", "Or", "Pa", "Qu", "Ro", "Sa", "Ti", "Um", "Ve"];
const TAIL = ["ron", "vik", "mar", "dos", "lyn", "ter", "nia", "sk", "por", "gen", "tal", "wyn"];

const R_MIN = 3;
const R_MAX = 16;

/** `count` nodes scattered uniformly over the canvas. Each gets a random importance in
 *  [0, 1] (radius R_MIN…R_MAX, sequential color, and declutter priority), and a short
 *  pronounceable name. The importance is skewed (squared) so a few nodes are clearly the
 *  "big" ones that should win when the view gets crowded. */
export function makeNodes(count: number, width: number, height: number): Node[] {
  const rnd = mulberry32(count); // seed by count so each size is its own stable layout
  const nodes: Node[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const importance = rnd() ** 2; // skew toward small; a handful are large
    nodes[i] = {
      id: `n${i}`,
      x: rnd() * width,
      y: rnd() * height,
      importance,
      radius: R_MIN + importance * (R_MAX - R_MIN),
      label: `${HEAD[Math.floor(rnd() * HEAD.length)]}${TAIL[Math.floor(rnd() * TAIL.length)]}`,
    };
  }
  return nodes;
}
