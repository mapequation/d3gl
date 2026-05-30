import type { Device, Framebuffer } from "@luma.gl/core";

/**
 * Read a rendered framebuffer back to a PNG data URL. WebGL readback is
 * bottom-left origin, so rows are flipped to top-left for the image. Browser
 * only (uses a 2D canvas to encode). Render into `framebuffer` before calling.
 */
export function toPNG(device: Device, framebuffer: Framebuffer, width: number, height: number): string {
  const pixels = device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    image.data.set(pixels.subarray(src, src + rowBytes), dst);
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}
