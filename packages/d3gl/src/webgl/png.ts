import type { Device, Framebuffer } from "@luma.gl/core";
import type { TextData } from "../core/index.js";
import { paintTexts } from "../canvas/draw-texts.js";

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("toPNG: 2D context unavailable");
  return ctx;
}

/**
 * Read a rendered framebuffer back to a PNG data URL. WebGL readback is
 * bottom-left origin, so rows are flipped to top-left for the image. Browser
 * only (uses a 2D canvas to encode). Render into `framebuffer` before calling.
 * Pixels are written as they are, so a framebuffer blended premultiplied (as
 * `WebGLBackend` draws, RGB × alpha) exports its translucent pixels darker:
 * `WebGLBackend.toPNG()` exports its canvas instead (`canvasToPNG`).
 *
 * `texts` (#219): screen-space labels composited on top of the readback via the shared
 * 2D painter (the same one the Canvas backend renders with). Coordinates map 1:1 to
 * the framebuffer's pixels. Export-time only — never on a per-frame path.
 */
export function toPNG(device: Device, framebuffer: Framebuffer, width: number, height: number, texts: readonly TextData[] = []): string {
  const pixels = device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = context2d(canvas);
  const image = ctx.createImageData(width, height);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    image.data.set(pixels.subarray(src, src + rowBytes), dst);
  }
  ctx.putImageData(image, 0, 0);
  paintTexts(ctx, texts); // labels on top (screen px), matching the Canvas backend's render
  return canvas.toDataURL("image/png");
}

/**
 * Encode a WebGL canvas as drawn to a PNG data URL (#569): an export is what the screen shows, at the
 * canvas's device-px size, with its antialiased edges and its colours (`drawImage` turns the canvas's
 * premultiplied pixels into the straight alpha a PNG holds). Call it in the same task as the render
 * that drew the canvas, so it does not rely on `preserveDrawingBuffer`. `width` × `height` is the
 * canvas's CSS size: `texts` (#219), in CSS px, are painted on top under the device-px scale with the
 * shared 2D painter (the one the Canvas backend renders with). Export-time only.
 */
export function canvasToPNG(source: HTMLCanvasElement | OffscreenCanvas, width: number, height: number, texts: readonly TextData[] = []): string {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = context2d(canvas);
  ctx.drawImage(source, 0, 0);
  if (width > 0 && height > 0) ctx.scale(canvas.width / width, canvas.height / height);
  paintTexts(ctx, texts);
  return canvas.toDataURL("image/png");
}
