import type { DrawableVector, ViewTransform } from "../core/index.js";

/** A screen-space (CSS px) rectangle: `[x0, y0, x1, y1]`. */
export type ScreenRect = [number, number, number, number];

/** Antialiasing reach of a painted edge beyond its geometry, in CSS px. */
const AA = 1;

/** How far a stroke can reach past its path, as a multiple of half its width: a miter join up to
 *  `miterLimit`, a square cap or a bevel by √2. */
function strokeReach(d: DrawableVector): number {
  return d.lineJoin === "miter" ? Math.max(d.miterLimit, Math.SQRT2) : Math.SQRT2;
}

/**
 * The screen rectangle the visible `drawables` paint into under `t`, exactly as the Canvas backend's
 * `drawShapes` places them (world paths and circles scaled by the view, screen-mode circles and
 * anchored glyphs at constant pixel size), padded by each stroke's reach and the antialiasing edge.
 * `null` when nothing is visible. O(points of `drawables`): the highlight overlay's size, not the scene's.
 */
export function overlayBounds(drawables: readonly DrawableVector[], screenMode: boolean, t: ViewTransform): ScreenRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number, pad: number): void => {
    if (x - pad < x0) x0 = x - pad;
    if (y - pad < y0) y0 = y - pad;
    if (x + pad > x1) x1 = x + pad;
    if (y + pad > y1) y1 = y + pad;
  };
  for (const d of drawables) {
    if ((d.flags & 1) === 0) continue;
    const half = d.stroke[3] > 0 ? (d.lineWidth / 2) * strokeReach(d) : 0;
    if (d.circles.length > 0) {
      for (const c of d.circles) {
        // A circle's stroke has no joins: half the width (screen px, or world units scaled by k).
        const r = c.r + d.lineWidth / 2;
        if (screenMode) add(t.k * c.x + t.x, t.k * c.y + t.y, r + AA);
        else add(t.k * c.x + t.x, t.k * c.y + t.y, t.k * r + AA);
      }
    } else if (screenMode && d.anchor) {
      const [ax, ay] = d.anchor;
      const ox = t.k * ax + t.x, oy = t.k * ay + t.y;
      for (const s of d.subpaths) {
        const p = s.points;
        for (let i = 0; i + 1 < p.length; i += 2) add(ox + ((p[i] ?? 0) - ax), oy + ((p[i + 1] ?? 0) - ay), half + AA);
      }
    } else {
      // World path; in screen mode the stroke width is constant px (drawShapes divides it by k).
      const pad = (screenMode ? half : t.k * half) + AA;
      for (const s of d.subpaths) {
        const p = s.points;
        for (let i = 0; i + 1 < p.length; i += 2) add(t.k * (p[i] ?? 0) + t.x, t.k * (p[i + 1] ?? 0) + t.y, pad);
      }
    }
  }
  return x1 >= x0 && y1 >= y0 ? [x0, y0, x1, y1] : null;
}
