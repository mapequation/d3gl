import type { Device, Framebuffer } from "@luma.gl/core";
import type { GroupRenderer } from "./renderer.js";
import { decodePickColor } from "./palette.js";

/**
 * Render the pick pass and read the drawableId under a screen pixel.
 *
 * `x`, `y` are top-left-origin screen coordinates (as from a pointer event);
 * WebGL readback is bottom-left, so y is flipped with `height`. Returns the
 * drawableId, or -1 for empty background. The caller maps the id to a domain id.
 *
 * `framebuffer` is used as a scratch target (its contents are overwritten).
 */
export function pickAt(
  device: Device,
  renderer: GroupRenderer,
  framebuffer: Framebuffer,
  x: number,
  y: number,
  height: number,
): number {
  const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
  renderer.renderPick(pass);
  pass.end();
  device.submit();
  const px = device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: Math.floor(x),
    sourceY: Math.floor(height - 1 - y),
    sourceWidth: 1,
    sourceHeight: 1,
  });
  return decodePickColor(px[0]!, px[1]!, px[2]!);
}
