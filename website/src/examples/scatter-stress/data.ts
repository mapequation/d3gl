export interface Point {
  id: string;
  x: number;
  y: number;
  /** A category 1–10, encoded as the fill color. */
  category: number;
  /** A value in [0, 1], encoded as the radius. */
  value: number;
  radius: number;
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

const R_MIN = 2;
const R_MAX = 9;

/** `count` points scattered uniformly over the canvas: each gets a random category (1–10,
 *  drives color), a random value in [0, 1] (drives radius R_MIN…R_MAX), and a random x/y. */
export function makePoints(count: number, width: number, height: number): Point[] {
  const rnd = mulberry32(count); // seed by count so each size is its own stable layout
  const points: Point[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const value = rnd();
    points[i] = {
      id: `p${i}`,
      x: rnd() * width,
      y: rnd() * height,
      category: 1 + Math.floor(rnd() * 10),
      value,
      radius: R_MIN + value * (R_MAX - R_MIN),
    };
  }
  return points;
}
