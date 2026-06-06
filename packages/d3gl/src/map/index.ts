/**
 * The high-level engines that wire a {@link core!Scene}, a backend, and d3-zoom together:
 * {@link geoMap} (a project-once map engine over GeoJSON) and {@link plot} (a generic 2D
 * engine driven by per-datum draw callbacks). {@link createBackend} selects the rendering
 * backend by {@link BackendType}.
 *
 * ```ts
 * import { plot } from "@mapequation/d3gl/map";
 *
 * plot(el, { width, height }).layer("links", data, {
 *   draw: (ctx, d) => { ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); },
 *   stroke: "#888",
 * });
 * ```
 *
 * @packageDocumentation
 */
export { createBackend } from "./backend-factory.js";
export type { BackendType, BackendHandle } from "./backend-factory.js";
export { geoMap, GeoMap } from "./geo-map.js";
export type { GeoMapOptions, LayerOptions, HoverHit } from "./geo-map.js";
export { plot, Plot } from "./plot.js";
export type { PlotOptions, PlotLayerOptions, PlotPointOptions } from "./plot.js";
export { LayerHandle } from "./layer-handle.js";
