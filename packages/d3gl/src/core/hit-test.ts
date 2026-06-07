import type { DrawableVector } from "./scene.js";
import { groupRings, pointInRing, type RingGroup } from "./rings.js";
import type { Subpath } from "./path-context.js";

interface Entry {
  id: string | number;
  minX: number; minY: number; maxX: number; maxY: number;
  filled: boolean;          // has >=1 closed subpath with area
  rings: RingGroup[];       // for filled (outer/holes are Subpath objects)
  strokes: Subpath[];       // for stroke hit-test
  halfWidth: number;
  circles: { x: number; y: number; r: number }[];
  tolerance: number;
}

function bounds(subpaths: Subpath[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of subpaths)
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i]!, y = s.points[i + 1]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  return [minX, minY, maxX, maxY];
}

function distToSegments(px: number, py: number, pts: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!, ay = pts[i + 1]!, bx = pts[i + 2]!, by = pts[i + 3]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best) best = d;
  }
  return best;
}

export class HitIndex {
  private entries: Entry[] = [];

  constructor(drawables: readonly DrawableVector[], private readonly tolerance = 1) {
    this.append(drawables);
  }

  /** Add more drawables to the index (used by incremental layer append). */
  append(drawables: readonly DrawableVector[]): void {
    for (const d of drawables) {
      if ((d.flags & 1) === 0) continue; // hidden never hits
      const closed = d.subpaths.filter((s) => s.closed && s.points.length >= 6);
      const circles = d.circles;

      // Compute bounding box from subpaths and/or circle extents.
      let [minX, minY, maxX, maxY] = bounds(d.subpaths);
      for (const c of circles) {
        if (c.x - c.r < minX) minX = c.x - c.r;
        if (c.x + c.r > maxX) maxX = c.x + c.r;
        if (c.y - c.r < minY) minY = c.y - c.r;
        if (c.y + c.r > maxY) maxY = c.y + c.r;
      }

      this.entries.push({
        id: d.id, minX, minY, maxX, maxY,
        filled: closed.length > 0,
        rings: closed.length > 0 ? groupRings(closed) : [],
        strokes: d.lineWidth > 0 ? d.subpaths : [],
        halfWidth: d.lineWidth / 2 + this.tolerance,
        circles,
        tolerance: this.tolerance,
      });
    }
  }

  /** Pick in PROJECTED coordinates (invert the view transform before calling). */
  pick(x: number, y: number): string | number | null {
    for (let i = this.entries.length - 1; i >= 0; i--) { // topmost first
      const e = this.entries[i]!;
      if (x < e.minX - e.halfWidth || x > e.maxX + e.halfWidth || y < e.minY - e.halfWidth || y > e.maxY + e.halfWidth) continue;
      if (e.filled) {
        for (const r of e.rings) {
          if (pointInRing(x, y, r.outer.points) && !r.holes.some((h) => pointInRing(x, y, h.points))) return e.id;
        }
      }
      if (e.strokes.length > 0) {
        for (const s of e.strokes) if (distToSegments(x, y, s.points) <= e.halfWidth) return e.id;
      }
      for (const c of e.circles) {
        if (Math.hypot(x - c.x, y - c.y) <= c.r + e.tolerance) return e.id;
      }
    }
    return null;
  }
}
