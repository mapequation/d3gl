/**
 * The luma.gl v9 WebGL2 backend. {@link WebGLBackend} draws {@link core!RenderLayer | render layers}
 * via a {@link GroupRenderer} (palette-texture color keyed by `drawableId`, a `mat3` transform
 * uniform, texture-write recolor), with GPU {@link pickAt | picking}, {@link clipFromView}
 * view math, and {@link toPNG} export.
 *
 * ```ts
 * import { WebGLBackend } from "@mapequation/d3gl/webgl";
 *
 * const backend = await WebGLBackend.create(canvasEl, { width, height });
 * backend.setLayers(layers); // RenderLayer[] built from a Scene's buffers
 * backend.render();
 * ```
 *
 * @packageDocumentation
 */
export { clipFromView } from "./transform.js";
export type { ViewTransform } from "./transform.js";
export { WebGLBackend } from "./webgl-backend.js";
export {
  paletteDimensions,
  padPalette,
  padFlags,
  encodePickColor,
  decodePickColor,
} from "./palette.js";
export type { PaletteDimensions } from "./palette.js";
export { GroupRenderer } from "./renderer.js";
export { InstancedCircles, InstancedLines, InstancedArrows } from "./instanced.js";
export { pickAt } from "./pick.js";
export { toPNG } from "./png.js";
