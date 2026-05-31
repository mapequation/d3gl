import type { Backend } from "@d3gl/core";
import { CanvasBackend } from "@d3gl/canvas";
import { SvgBackend } from "@d3gl/svg";
import { WebGLBackend } from "@d3gl/webgl";

export type BackendType = "webgl" | "canvas" | "svg";

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

export async function createBackend(type: BackendType, host: HTMLElement, width: number, height: number): Promise<BackendHandle> {
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
