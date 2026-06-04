/**
 * React bindings. The {@link D3GL} component mounts a canvas, builds it from initial
 * {@link D3GLGroup | groups} + a {@link core!ViewTransform}, renders, and hands back the
 * headless {@link MapController}; {@link GeoMap} wraps the project-once map engine.
 *
 * ```tsx
 * import { D3GL } from "@mapequation/d3gl/react";
 *
 * <D3GL width={width} height={height} groups={groups} onReady={(c) => controllerRef.current = c} />
 * ```
 *
 * @packageDocumentation
 */
export { MapController } from "./controller.js";
export type { MapControllerOptions } from "./controller.js";
export { D3GL } from "./D3GL.js";
export type { D3GLProps, D3GLGroup } from "./D3GL.js";
export { GeoMap } from "./GeoMap.js";
export type { GeoMapProps } from "./GeoMap.js";
export { Plot, Layer, Points } from "./Plot.js";
export type { PlotProps, LayerProps, PointsProps } from "./Plot.js";
