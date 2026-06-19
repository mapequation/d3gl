export interface Point {
  id: number;
  x: number;
  y: number;
  /** Importance in [0, 1] — drives the radius, the color, AND (via input order after sorting)
   *  the declutter priority, so "biggest = most important = survives crowding" reads off one
   *  channel. */
  importance: number;
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
const R_MAX = 14;

/** `count` points scattered uniformly over the canvas, each with a skewed (squared) importance
 *  in [0, 1] driving radius + color. No labels and numeric ids — deliberately lean so the layout
 *  scales to ~1M points without the per-node string/label allocations of the labelled example. */
export function makePoints(count: number, width: number, height: number): Point[] {
  const rnd = mulberry32(count); // seed by count so each size is its own stable layout
  const points: Point[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const importance = rnd() ** 2; // skew toward small; a handful are large
    points[i] = {
      id: i,
      x: rnd() * width,
      y: rnd() * height,
      importance,
      radius: R_MIN + importance * (R_MAX - R_MIN),
    };
  }
  return points;
}
