/** Test helper (#542): how far a traced outline strays from a densely sampled reference outline. */

/** Distance from `(px, py)` to the closed polyline `poly` (`n` points). */
function polyDist(px: number, py: number, poly: ArrayLike<number>, n: number): number {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[2 * i] ?? 0, ay = poly[2 * i + 1] ?? 0;
    const dx = (poly[2 * j] ?? 0) - ax, dy = (poly[2 * j + 1] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}

/** Symmetric (Hausdorff) distance between two closed polylines. */
export function outlineGap(a: ArrayLike<number>, na: number, b: ArrayLike<number>, nb: number): number {
  let m = 0;
  for (let i = 0; i < na; i++) m = Math.max(m, polyDist(a[2 * i] ?? 0, a[2 * i + 1] ?? 0, b, nb));
  for (let i = 0; i < nb; i++) m = Math.max(m, polyDist(b[2 * i] ?? 0, b[2 * i + 1] ?? 0, a, na));
  return m;
}
