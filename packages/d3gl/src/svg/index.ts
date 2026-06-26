/**
 * The SVG backend and publication-quality vector export. {@link SvgBackend} renders
 * {@link core!RenderLayer | render layers} as SVG, {@link SvgPathContext} is a
 * {@link core!PathContext} that records path `d` strings, and {@link svgDocument} /
 * {@link svgFromLayers} serialize geometry to a standalone SVG document.
 *
 * ```ts
 * import { svgFromLayers } from "@mapequation/d3gl/svg";
 *
 * const svg = svgFromLayers(layers, { width, height }); // serializable SVG string
 * ```
 *
 * @packageDocumentation
 */
export { SvgPathContext } from "./svg-context.js";
export { svgDocument } from "./document.js";
export type { SvgPath } from "./document.js";
export { svgFromLayers, serializeTexts } from "./serialize.js";
export { SvgBackend } from "./svg-backend.js";
