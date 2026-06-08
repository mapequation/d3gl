import type { PointBatch } from "../core/index.js";
import { packColor } from "./color.js";

export type { PointBatch };

export interface ProjectPointsOpts<D> {
  /** Project a datum to projected world coords, or null to cull it (off-globe / off-screen). */
  project: (d: D, i: number) => [number, number] | null;
  /** Radius per point (reference px). Constant or per-datum. */
  radius: number | ((d: D, i: number) => number);
  /** CSS color per point. Constant or per-datum. */
  color: string | ((d: D, i: number) => string);
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
    const [r, g, b, a] = packColor(colorFn(data[i]!, i));
    const off = count * 4;
    colors[off] = r;
    colors[off + 1] = g;
    colors[off + 2] = b;
    colors[off + 3] = a;
    count++;
  }
  return {
    positions: positions.subarray(0, count * 2),
    radii: radii.subarray(0, count),
    colors: colors.subarray(0, count * 4),
    count,
  };
}
