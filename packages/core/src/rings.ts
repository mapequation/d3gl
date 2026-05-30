import type { Subpath } from "./path-context.js";

/** One filled polygon: an outer ring plus zero or more hole rings. */
export interface RingGroup {
  outer: Subpath;
  holes: Subpath[];
}

/**
 * Shoelace signed area of a ring (interleaved x,y). Positive for
 * counter-clockwise winding, negative for clockwise. Magnitude is the area.
 */
export function signedArea(points: readonly number[]): number {
  let sum = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = points[2 * i]!;
    const y1 = points[2 * i + 1]!;
    const j = (i + 1) % n;
    const x2 = points[2 * j]!;
    const y2 = points[2 * j + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Ray-casting point-in-polygon test against a ring (interleaved x,y). */
export function pointInRing(x: number, y: number, points: readonly number[]): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[2 * i]!;
    const yi = points[2 * i + 1]!;
    const xj = points[2 * j]!;
    const yj = points[2 * j + 1]!;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Group a flat list of closed rings into filled polygons with holes.
 *
 * `PathRecorder` emits independent subpaths and discards which ring is an outer
 * boundary vs. a hole, so we recover it here: process rings largest-first; a ring
 * is a hole of the smallest already-seen outer that geometrically contains it,
 * otherwise it starts a new outer. Open or degenerate (<3 vertex) subpaths are
 * skipped — a fill needs a closed ring.
 *
 * Limitation: single-level nesting only (no hole-within-hole islands). This covers
 * grid cells (one ring each) and typical country polygons.
 */
export function groupRings(subpaths: readonly Subpath[]): RingGroup[] {
  const rings = subpaths
    .filter((s) => s.closed && s.points.length >= 6)
    .map((s) => ({ subpath: s, absArea: Math.abs(signedArea(s.points)) }))
    .filter((r) => r.absArea > 0)
    .sort((a, b) => b.absArea - a.absArea); // largest first

  const groups: RingGroup[] = [];
  for (const ring of rings) {
    const px = ring.subpath.points[0]!;
    const py = ring.subpath.points[1]!;
    // Find the smallest-area existing outer that contains this ring's first point.
    let container: RingGroup | null = null;
    let containerArea = Infinity;
    for (const g of groups) {
      const gArea = Math.abs(signedArea(g.outer.points));
      if (gArea < containerArea && pointInRing(px, py, g.outer.points)) {
        container = g;
        containerArea = gArea;
      }
    }
    if (container) {
      container.holes.push(ring.subpath);
    } else {
      groups.push({ outer: ring.subpath, holes: [] });
    }
  }
  return groups;
}
