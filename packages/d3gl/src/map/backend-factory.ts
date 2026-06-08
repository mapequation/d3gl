import type { Backend } from "../core/index.js";
import { CanvasBackend } from "../canvas/index.js";
import { SvgBackend } from "../svg/index.js";
import { WebGLBackend } from "../webgl/index.js";

/**
 * Which renderer an engine ({@link GeoMap} / {@link Plot}, or the React `<GeoMap>`) draws
 * the {@link core!Scene} with. Geometry is projected & tessellated once (backend-independent);
 * the backend only turns it into pixels (or SVG nodes). Defaults to `"webgl"`.
 *
 * - `"webgl"` *(default)* — luma.gl v9 WebGL2. Best for large/dense scenes, smooth pan/zoom,
 *   and the GPU globe. One-time GPU device creation delays the first paint (can be 100s of ms
 *   on a cold load). Exports via `toPNG()`.
 * - `"canvas"` — Canvas2D. Instant (synchronous) startup, no GPU dependency; ideal for small/
 *   medium scenes and the fastest first paint. Exports via `toPNG()`.
 * - `"svg"` — SVG nodes. Instant startup; for vector export / print / hand-editable output.
 *   Exports via `toSVG()`.
 * - `"auto"` — progressive: install `"canvas"` synchronously for an instant first paint, then
 *   create the WebGL device in the background and swap to it transparently when ready. Falls
 *   back to staying on Canvas (with a `console.warn`) if WebGL is unavailable. In `"auto"` mode
 *   `whenReady()` resolves at the canvas first paint (early); the upgrade is transparent.
 *
 * Switch a live engine with `setBackend(...)` (layers, colors, and the current view are
 * preserved); switching to the already-live backend is a no-op.
 */
export type BackendType = "webgl" | "canvas" | "svg" | "auto";

export interface BackendHandle {
  backend: Backend;
  /** The DOM node the backend draws into (a <canvas> for raster, the host for svg). */
  element: HTMLElement;
}

function makeCanvas(host: HTMLElement, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.style.display = "block";
  host.appendChild(canvas);
  return canvas;
}

/**
 * Synchronously create a Canvas backend + its <canvas> element. Used by the engine's
 * "auto" mode for an instant (non-async) first paint before the WebGL device is ready.
 */
export function createCanvasBackend(host: HTMLElement, width: number, height: number): BackendHandle {
  const canvas = makeCanvas(host, width, height);
  return { backend: new CanvasBackend(canvas, width, height), element: canvas };
}

export async function createBackend(type: BackendType, host: HTMLElement, width: number, height: number): Promise<BackendHandle> {
  // "auto" is an engine-level orchestration (canvas-first paint, then a background WebGL
  // upgrade), not a real backend — the engine installs canvas via createCanvasBackend and
  // upgrades via its own path, so createBackend should never receive it.
  if (type === "auto") throw new Error('createBackend: "auto" is engine-level — use createCanvasBackend + the engine upgrade path');
  if (type === "canvas") {
    const canvas = makeCanvas(host, width, height);
    return { backend: new CanvasBackend(canvas, width, height), element: canvas };
  }
  if (type === "svg") {
    return { backend: new SvgBackend(host, width, height), element: host };
  }
  const canvas = makeCanvas(host, width, height);
  const backend = await WebGLBackend.create(canvas, { width, height });
  return { backend, element: canvas };
}
