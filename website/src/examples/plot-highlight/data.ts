export interface Dot { id: string; x: number; y: number; group: number; value: number }
export interface Region { group: number; x: number; y: number; w: number; h: number }

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

/** Six gaussian clusters of points, plus a padded bounding-box region per cluster. */
export function makeData(width: number, height: number): { dots: Dot[]; regions: Region[] } {
  const rnd = mulberry32(42);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const groups = 6;
  const perGroup = 70;
  const pad = 14;
  const dots: Dot[] = [];
  const regions: Region[] = [];
  for (let g = 0; g < groups; g++) {
    const cx = width * (0.15 + 0.7 * rnd());
    const cy = height * (0.15 + 0.7 * rnd());
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < perGroup; k++) {
      const x = cx + gauss() * width * 0.05;
      const y = cy + gauss() * height * 0.05;
      dots.push({ id: `g${g}-${k}`, x, y, group: g, value: rnd() });
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    regions.push({ group: g, x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad });
  }
  return { dots, regions };
}
