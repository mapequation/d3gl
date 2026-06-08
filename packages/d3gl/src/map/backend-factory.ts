import type { Backend } from "../core/index.js";
import { CanvasBackend } from "../canvas/index.js";
import { SvgBackend } from "../svg/index.js";
import { WebGLBackend } from "../webgl/index.js";

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
