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

/** Backing-store pixels per CSS pixel. Rendering at the physical display resolution keeps thin
 *  strokes/points crisp on HiDPI ("retina") screens instead of letting the browser upscale a
 *  CSS-resolution buffer. 1 on a standard display — then all the per-backend dpr math is a no-op. */
function dpr(): number {
  return (typeof window !== "undefined" && window.devicePixelRatio) || 1;
}

function makeCanvas(host: HTMLElement, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  // CSS size stays in layout px; the drawing buffer is device px (CSS × dpr). The WebGL path
  // lets luma own the buffer (useDevicePixels), reconciling to this same CSS size.
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr());
  canvas.height = Math.round(h * dpr());
  canvas.style.display = "block";
  // Take the canvas out of normal flow and pin it to the host's top-left. The host is
  // always positioned (the React <GeoMap>/<Plot> wrappers set position:relative; a bare
  // engine host should too). This matters for "auto" mode: during the canvas→WebGL upgrade
  // (and the React StrictMode double-mount that compounds it) two or more backend canvases
  // coexist in the host for ~100s of ms. In normal flow each display:block canvas would
  // stack vertically, inflating host height and pushing the live map below its reserved box
  // — a visible "jump up" when the stale canvases detach. Absolute positioning overlaps them
  // at the origin so the swap never affects layout. Hit-testing is unaffected: pointers are
  // measured from host.getBoundingClientRect(), and the canvas sits at the host's origin.
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
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
