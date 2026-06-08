import type { Subpath, PointBatch, DrawBatch, ProjectedPath, DrawItem } from "../core/index.js";
import { packColor } from "./color.js";

export type { Subpath, PointBatch, DrawBatch, ProjectedPath, DrawItem };

/**
 * Build a DrawBatch from user data and a per-datum builder function.
 *
 * Points packing: we don't know the total point count up front (items may carry
 * multiple centers each). We accumulate into plain number[] arrays then convert to
 * typed arrays at the end — one pass, no pre-sizing. This avoids a double-iteration
 * that would require materializing all items twice; clarity wins for a per-repaint path.
 */
export function buildBatch<D>(
  data: readonly D[],
  buildItem: (d: D, i: number) => DrawItem | null,
): DrawBatch {
  // Accumulate point data into dynamic arrays.
  const posArr: number[] = [];
  const radArr: number[] = [];
  const colArr: number[] = [];

  const paths: ProjectedPath[] = [];

  for (let i = 0; i < data.length; i++) {
    const item = buildItem(data[i]!, i);
    if (!item) continue;

    if (item.kind === "points") {
      const [r, g, b, a] = packColor(item.color);
      for (const [x, y] of item.centers) {
        posArr.push(x, y);
        radArr.push(item.radius);
        colArr.push(r, g, b, a);
      }
    } else {
      // kind === "path"
      const fill = item.fill !== null ? packColor(item.fill) : null;
      const stroke = item.stroke !== null ? packColor(item.stroke) : null;
      paths.push({ subpaths: item.subpaths, fill, stroke, lineWidth: item.lineWidth });
    }
  }

  const count = radArr.length;
  const points: PointBatch | null =
    count > 0
      ? {
          positions: new Float32Array(posArr),
          radii: new Float32Array(radArr),
          colors: new Uint8Array(colArr),
          count,
        }
      : null;

  return {
    points,
    paths: paths.length > 0 ? paths : null,
  };
}
