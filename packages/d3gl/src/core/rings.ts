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
    const x1 = points[2 * i] ?? 0;
    const y1 = points[2 * i + 1] ?? 0;
    const j = (i + 1) % n;
    const x2 = points[2 * j] ?? 0;
    const y2 = points[2 * j + 1] ?? 0;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Ray-casting point-in-polygon test against a ring (interleaved x,y). */
export function pointInRing(x: number, y: number, points: readonly number[]): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[2 * i] ?? 0;
    const yi = points[2 * i + 1] ?? 0;
    const xj = points[2 * j] ?? 0;
    const yj = points[2 * j + 1] ?? 0;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** A candidate ring, prepared once: winding direction, area, bbox and a probe point. */
interface Ring {
  subpath: Subpath;
  /** +1 counter-clockwise, −1 clockwise. Never 0 (zero-area rings are dropped). */
  dir: number;
  absArea: number;
  /** Bounding box, used to reject non-containers before the O(vertices) ray cast. Left
   *  wide open (±Infinity — never consulted) for a lone ring, which has no containers. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Probe point for containment: the ring's first vertex. */
  px: number;
  py: number;
  /** Index into the result when this ring bounds a filled region from outside; −1 otherwise. */
  group: number;
}

/**
 * Group a flat list of closed rings into filled polygons with holes, at ARBITRARY
 * nesting depth (issue #73 — an island in a lake in land, and deeper).
 *
 * `PathRecorder` emits independent subpaths and discards which ring is an outer
 * boundary vs. a hole, so we recover it from the geometry. The rule is the NONZERO
 * winding rule — the same rule Canvas (`ctx.fill()`) and SVG (`fill-rule: nonzero`)
 * apply natively to the very same subpaths, so all three backends agree by
 * construction (AGENTS.md "Backend compositing equivalence"). For each ring we
 * compute the winding number of the region just OUTSIDE it (the signed sum of the
 * rings that enclose it) and just INSIDE it (that sum plus the ring's own
 * direction). A ring is then:
 *
 * - an **outer** (starts a new `RingGroup`) when the fill turns on across it —
 *   outside 0, inside ≠ 0;
 * - a **hole** of the nearest enclosing outer when the fill turns off — outside
 *   ≠ 0, inside 0;
 * - **dropped** when both sides are filled or both empty, since it bounds nothing.
 *
 * With the documented winding convention (exterior rings clockwise in `[lon, lat]`,
 * holes wound the opposite way, so nesting levels alternate — see AGENTS.md "GeoJSON
 * winding") this is exactly alternating solid/hole by depth: land → lake → island →
 * pond. Rings that do NOT alternate (two nested rings wound the same way) stay solid,
 * which is what the Canvas/SVG nonzero fill already draws.
 *
 * Open or degenerate (<3 vertex, zero-area) subpaths are skipped — a fill needs a
 * closed ring.
 *
 * Cost: rings are prepared once (area + bbox), sorted by descending area, and each
 * ring is tested against the larger ones. The bbox test rejects non-containers before
 * the O(vertices) ray cast, so the ray cast runs only for the handful of rings that
 * actually overlap the probe point — the common geo case (thousands of disjoint
 * island rings in one MultiPolygon) stays at cheap coordinate compares.
 */
export function groupRings(subpaths: readonly Subpath[]): RingGroup[] {
  // A lone ring can be enclosed by nothing, so the containment scan never runs and its
  // bbox is never read. Skip building one — this is the common call shape (a grid cell,
  // a single-Polygon feature), so the extra vertex pass would be pure overhead there.
  const needBounds = subpaths.length > 1;
  const rings: Ring[] = [];
  for (const subpath of subpaths) {
    if (!subpath.closed || subpath.points.length < 6) continue;
    const area = signedArea(subpath.points);
    if (area === 0) continue;
    const pts = subpath.points;
    let minX = -Infinity, minY = -Infinity, maxX = Infinity, maxY = Infinity;
    if (needBounds) {
      minX = minY = Infinity;
      maxX = maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i] ?? 0;
        const y = pts[i + 1] ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    rings.push({
      subpath,
      dir: area > 0 ? 1 : -1,
      absArea: Math.abs(area),
      minX, minY, maxX, maxY,
      px: pts[0] ?? 0,
      py: pts[1] ?? 0,
      group: -1,
    });
  }
  // Largest first: a ring can only be enclosed by a ring of larger area, so every
  // possible container of rings[i] sits at some j < i and is already classified.
  rings.sort((a, b) => b.absArea - a.absArea);

  const groups: RingGroup[] = [];
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    if (!ring) continue;
    let winding = 0; // winding number of the region just outside this ring
    let parent = -1; // nearest enclosing ring that is a fill outer
    // Descending index = ascending area, so the first enclosing outer found is the nearest.
    for (let j = i - 1; j >= 0; j--) {
      const c = rings[j];
      if (!c) continue;
      if (ring.px < c.minX || ring.px > c.maxX || ring.py < c.minY || ring.py > c.maxY) continue;
      if (!pointInRing(ring.px, ring.py, c.subpath.points)) continue;
      winding += c.dir;
      if (parent < 0 && c.group >= 0) parent = c.group;
    }
    const outsideFilled = winding !== 0;
    const insideFilled = winding + ring.dir !== 0;
    if (insideFilled && !outsideFilled) {
      ring.group = groups.length;
      groups.push({ outer: ring.subpath, holes: [] });
    } else if (outsideFilled && !insideFilled && parent >= 0) {
      groups[parent]?.holes.push(ring.subpath);
    }
    // Otherwise the ring separates two equally-filled (or equally-empty) regions and
    // contributes no fill boundary — nonzero draws nothing for it.
  }
  return groups;
}
