import { rgb } from "d3-color";

/** Transient, GPU/Canvas-ready point data. Owned by no one — built per repaint and discarded. */
export interface PointBatch {
  /** [x, y] per point, in projected world coords (pre view-transform). */
  positions: Float32Array;
  /** radius (reference px) per point. */
  radii: Float32Array;
  /** RGBA bytes per point (4 per point), parallel to positions. */
  colors: Uint8Array;
  /** number of points actually packed (after culling). */
  count: number;
}

export interface ProjectPointsOpts<D> {
  /** Project a datum to projected world coords, or null to cull it (off-globe / off-screen). */
  project: (d: D, i: number) => [number, number] | null;
  /** Radius per point (reference px). Constant or per-datum. */
  radius: number | ((d: D, i: number) => number);
  /** CSS color per point. Constant or per-datum. */
  color: string | ((d: D, i: number) => string);
}

/** Clamp to a 0–255 byte (CSS clamps out-of-range channels; Uint8Array would wrap). */
function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Build a PointBatch from raw user data. Pure and DOM-free: project + accessors only.
 * Allocates exactly `data.length` capacity then trims to the visible count.
 */
export function projectPoints<D>(data: readonly D[], opts: ProjectPointsOpts<D>): PointBatch {
  const n = data.length;
  const positions = new Float32Array(n * 2);
  const radii = new Float32Array(n);
  const colors = new Uint8Array(n * 4);
  const radiusFn = typeof opts.radius === "function" ? opts.radius : () => opts.radius as number;
  const colorFn = typeof opts.color === "function" ? opts.color : () => opts.color as string;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = opts.project(data[i]!, i);
    if (!p) continue;
    positions[count * 2] = p[0];
    positions[count * 2 + 1] = p[1];
    radii[count] = radiusFn(data[i]!, i);
    const cs = colorFn(data[i]!, i);
    const c = rgb(cs);
    if (Number.isNaN(c.r)) throw new Error(`invalid color: ${cs}`);
    const off = count * 4;
    colors[off] = toByte(c.r);
    colors[off + 1] = toByte(c.g);
    colors[off + 2] = toByte(c.b);
    colors[off + 3] = toByte((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255);
    count++;
  }
  return {
    positions: positions.subarray(0, count * 2),
    radii: radii.subarray(0, count),
    colors: colors.subarray(0, count * 4),
    count,
  };
}
