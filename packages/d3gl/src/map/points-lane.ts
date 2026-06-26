import { rgb } from "d3-color";
import { declutterScreen, declutterScratch } from "../core/declutter.js";
import type { SelectionStrategy, LaneTransform } from "../core/instanced-lane.js";
import type { InstancedCirclesData } from "../core/backend.js";

/**
 * Gather a points datum array into instanced-circle SoA for the given visible indices
 * (index compaction). Only the `visible` subset is emitted, so draw cost is ∝ kept count.
 */
export function plotPointsCircles<D>(
  data: readonly D[],
  visible: Uint32Array,
  xOf: (d: D, i: number) => number,
  yOf: (d: D, i: number) => number,
  rOf: (d: D, i: number) => number,
  fillOf: (d: D, i: number) => string,
  count: number,
): InstancedCirclesData {
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 4);
  for (let j = 0; j < count; j++) {
    const i = visible[j]!;
    const d = data[i]!;
    centers[j * 2] = xOf(d, i);
    centers[j * 2 + 1] = yOf(d, i);
    radii[j] = rOf(d, i);
    const c = rgb(fillOf(d, i));
    colors[j * 4] = Math.round(c.r) & 255;
    colors[j * 4 + 1] = Math.round(c.g) & 255;
    colors[j * 4 + 2] = Math.round(c.b) & 255;
    colors[j * 4 + 3] = Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255;
  }
  return { centers, radii, colors, count };
}

/**
 * Declutter selection strategy for a plot points layer.
 *
 * `select` projects each point to screen, runs the shared greedy screen-space declutter
 * (kept = higher-priority glyphs, overlaps dropped), and returns the KEPT indices (index
 * compaction). Reuses `core/declutter.ts` so behaviour matches the existing flag-discard
 * path exactly — only the output differs (compacted draw vs hidden-but-drawn).
 *
 * `pick` is exact point-in-circle over the kept set in screen space, using the drawn point
 * radius (`pointRadiusOf`) as the hit radius — NOT the declutter exclusion px.
 *
 * @param pointRadiusOf - drawn radius per point (used for pick). With `screenSized` it is the
 *   on-screen px radius as-is; otherwise it is the world radius (scaled by k for the hit test).
 * @param declutterPxOf - centre-to-centre exclusion distance in screen px at zoom k=1 (used for
 *   `select` only; passed as `declutterPx/2` to `declutterScreen` so two glyphs collide when
 *   their centre distance < declutterPx — matching the convention in `base-engine.ts` `cullDeclutter`)
 * @param order - visit order (importance descending); omit for index order (first = highest priority)
 * @param screenSized - true ⇒ `sizeMode:"screen"` (constant-px glyphs; pick hit radius = `r`);
 *   false ⇒ `sizeMode:"world"` (radius scales with zoom; pick hit radius = `r × k`). Mirrors
 *   `pickNodes`/`pickFrontier`. `select` is unaffected (declutter exclusion is always screen-px).
 */
export function declutterPointsStrategy<D>(
  data: readonly D[],
  xOf: (d: D, i: number) => number,
  yOf: (d: D, i: number) => number,
  pointRadiusOf: (d: D, i: number) => number,
  declutterPxOf: (d: D, i: number) => number,
  order: ArrayLike<number> | undefined,
  width: number,
  height: number,
  screenSized: boolean,
): SelectionStrategy {
  const n = data.length;
  // Reusable per-frame scratch — allocated once, grown lazily inside declutterScreen.
  const scratch = declutterScratch();
  const flags = new Uint8Array(n);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const excl = new Float64Array(n); // per-point exclusion radius = declutterPx/2

  const project = (t: LaneTransform) => {
    for (let i = 0; i < n; i++) {
      const d = data[i]!;
      sx[i] = xOf(d, i) * t.k + t.x;
      sy[i] = yOf(d, i) * t.k + t.y;
      // Match cullDeclutter convention: exclusion = declutterPx, so radius passed = declutterPx/2
      // (two glyphs collide when dist < spacing*(rᵢ+rⱼ) = 1*(px/2+px/2) = px).
      excl[i] = declutterPxOf(d, i) / 2;
    }
  };

  return {
    select(t: LaneTransform, w: number, h: number): Uint32Array {
      project(t);
      flags.fill(0);
      declutterScreen(n, sx, sy, excl, order, w, h, 1, flags, scratch);
      let count = 0;
      for (let i = 0; i < n; i++) if (flags[i]) count++;
      const out = new Uint32Array(count);
      let w2 = 0;
      for (let i = 0; i < n; i++) if (flags[i]) out[w2++] = i;
      return out;
    },
    pick(px: number, py: number, t: LaneTransform, visible: Uint32Array): number {
      let found = -1;
      for (let j = 0; j < visible.length; j++) {
        const i = visible[j]!;
        const d = data[i]!;
        const scx = xOf(d, i) * t.k + t.x;
        const scy = yOf(d, i) * t.k + t.y;
        const dx = px - scx;
        const dy = py - scy;
        // On-screen hit radius: screen-sized glyphs are constant-px (r as-is); world-sized scale by k.
        const sr = screenSized ? pointRadiusOf(d, i) : pointRadiusOf(d, i) * t.k;
        if (dx * dx + dy * dy <= sr * sr) found = i; // last match = topmost
      }
      return found;
    },
  };
}
