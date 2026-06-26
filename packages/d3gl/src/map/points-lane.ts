import { rgb } from "d3-color";
import { declutterScreen, declutterScratch } from "../core/declutter.js";
import type { SelectionStrategy, LaneTransform } from "../core/instanced-lane.js";
import type { InstancedCirclesData } from "../core/backend.js";

/**
 * Resolve the full per-point SoA arrays from accessor functions — called ONCE when
 * data/style changes, not per frame. Returns pre-built allCenters (2N Float32), allRadii
 * (N Float32), allColors (4N Uint8) that the lane reuses across frames.
 */
export function resolvePlotPointsSoA<D>(
  data: readonly D[],
  xOf: (d: D, i: number) => number,
  yOf: (d: D, i: number) => number,
  rOf: (d: D, i: number) => number,
  fillOf: (d: D, i: number) => string,
): { allCenters: Float32Array; allRadii: Float32Array; allColors: Uint8Array } {
  const n = data.length;
  const allCenters = new Float32Array(n * 2);
  const allRadii = new Float32Array(n);
  const allColors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = data[i]!;
    allCenters[i * 2] = xOf(d, i);
    allCenters[i * 2 + 1] = yOf(d, i);
    allRadii[i] = rOf(d, i);
    const c = rgb(fillOf(d, i));
    allColors[i * 4] = Math.round(c.r) & 255;
    allColors[i * 4 + 1] = Math.round(c.g) & 255;
    allColors[i * 4 + 2] = Math.round(c.b) & 255;
    allColors[i * 4 + 3] = Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255;
  }
  return { allCenters, allRadii, allColors };
}

/**
 * Gather pre-resolved SoA arrays into an InstancedCirclesData for the given visible indices
 * (index compaction into reused scratch buffers). No accessor calls, no rgb() parse per frame.
 * `scratchCenters`, `scratchRadii`, `scratchColors` are caller-allocated scratch buffers of at
 * least `capacity` elements; only the first `visible.length` slots are written.
 */
export function plotPointsCircles(
  visible: Uint32Array,
  allCenters: Float32Array,
  allRadii: Float32Array,
  allColors: Uint8Array,
  scratchCenters: Float32Array,
  scratchRadii: Float32Array,
  scratchColors: Uint8Array,
): InstancedCirclesData {
  const count = visible.length;
  for (let j = 0; j < count; j++) {
    const i = visible[j]!;
    scratchCenters[j * 2] = allCenters[i * 2]!;
    scratchCenters[j * 2 + 1] = allCenters[i * 2 + 1]!;
    scratchRadii[j] = allRadii[i]!;
    scratchColors[j * 4] = allColors[i * 4]!;
    scratchColors[j * 4 + 1] = allColors[i * 4 + 1]!;
    scratchColors[j * 4 + 2] = allColors[i * 4 + 2]!;
    scratchColors[j * 4 + 3] = allColors[i * 4 + 3]!;
  }
  // Return sub-views so the GPU upload only sends the filled portion (count × element size).
  return {
    centers: scratchCenters.subarray(0, count * 2),
    radii: scratchRadii.subarray(0, count),
    colors: scratchColors.subarray(0, count * 4),
    count,
  };
}

/**
 * Declutter selection strategy for a plot points layer.
 *
 * `select` projects each point to screen from the pre-resolved `allCenters` + the transform
 * (NOT by re-calling xOf/yOf), runs the shared greedy screen-space declutter, and returns
 * the KEPT indices (index compaction). Reuses `core/declutter.ts` so behaviour matches the
 * existing flag-discard path exactly — only the output differs (compacted draw vs hidden-but-drawn).
 *
 * `pick` is exact point-in-circle over the kept set in screen space, using the pre-resolved
 * `allRadii` as the hit radius — NOT the declutter exclusion px.
 *
 * @param allCenters - pre-resolved Float32Array([x0,y0, x1,y1, …]) from {@link resolvePlotPointsSoA}
 * @param allRadii   - pre-resolved Float32Array([r0, r1, …]) from {@link resolvePlotPointsSoA}
 * @param declutterPx - centre-to-centre exclusion distance in screen px (constant for the layer)
 * @param order - visit order (importance descending); omit for index order (first = highest priority)
 * @param screenSized - true ⇒ `sizeMode:"screen"` (constant-px glyphs; pick hit radius = `r`);
 *   false ⇒ `sizeMode:"world"` (radius scales with zoom; pick hit radius = `r × k`). Mirrors
 *   `pickNodes`/`pickFrontier`. `select` is unaffected (declutter exclusion is always screen-px).
 */
export function declutterPointsStrategy(
  n: number,
  allCenters: Float32Array,
  allRadii: Float32Array,
  declutterPx: number,
  order: ArrayLike<number> | undefined,
  width: number,
  height: number,
  screenSized: boolean,
  winners?: Int32Array,
): SelectionStrategy {
  // Reusable per-frame scratch — allocated once, grown lazily inside declutterScreen.
  const scratch = declutterScratch();
  const flags = new Uint8Array(n);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  // Constant exclusion radius = declutterPx/2 for all points (match cullDeclutter convention:
  // two glyphs collide when dist < spacing*(rᵢ+rⱼ) = 1*(px/2+px/2) = px).
  const halfExcl = declutterPx / 2;

  return {
    select(t: LaneTransform, w: number, h: number): Uint32Array {
      // Project world→screen from pre-resolved centers (no accessor calls per frame).
      for (let i = 0; i < n; i++) {
        sx[i] = allCenters[i * 2]! * t.k + t.x;
        sy[i] = allCenters[i * 2 + 1]! * t.k + t.y;
      }
      flags.fill(0);
      // `winners` (when provided) records each point's kept survivor so a hit can list the points
      // absorbed under it (`members()`, #105 N7c-2). Recomputed each select (the kept set changes per zoom).
      declutterScreen(n, sx, sy, halfExcl, order, w, h, 1, flags, scratch, undefined, winners);
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
        const scx = allCenters[i * 2]! * t.k + t.x;
        const scy = allCenters[i * 2 + 1]! * t.k + t.y;
        const dx = px - scx;
        const dy = py - scy;
        // On-screen hit radius: screen-sized glyphs are constant-px (r as-is); world-sized scale by k.
        const sr = screenSized ? allRadii[i]! : allRadii[i]! * t.k;
        if (dx * dx + dy * dy <= sr * sr) found = i; // last match = topmost
      }
      return found;
    },
  };
}
