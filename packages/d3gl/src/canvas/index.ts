/**
 * The Canvas2D backend. {@link CanvasBackend} renders {@link core!RenderLayer | render layers}
 * to a 2D canvas context (honouring per-layer clipping and world/screen size modes), and
 * {@link CanvasContext} is a passthrough {@link core!PathContext} that draws directly to a
 * `CanvasRenderingContext2D`.
 *
 * ```ts
 * import { CanvasBackend } from "@mapequation/d3gl/canvas";
 *
 * const backend = new CanvasBackend(canvasEl, width, height);
 * backend.setLayers(layers); // RenderLayer[] built from a Scene's buffers
 * backend.render();
 * ```
 *
 * @packageDocumentation
 */
export { CanvasContext } from "./canvas-context.js";
export { CanvasBackend } from "./canvas-backend.js";
