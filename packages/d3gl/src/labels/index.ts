/**
 * HTML label overlay. {@link LabelLayer} keeps geometry on the GPU and renders only the
 * visible labels into the DOM, positioning {@link LabelAnchor | anchors} (reference-space)
 * under a {@link core!ViewTransform}; {@link cullLabels} does the viewport + collision culling.
 *
 * ```ts
 * import { LabelLayer } from "@mapequation/d3gl/labels";
 *
 * const labels = new LabelLayer(containerEl, (a) => a.text);
 * labels.update(anchors, transform, { width, height });
 * ```
 *
 * @packageDocumentation
 */
export { cullLabels, labelCullScratch, labelGeometry, labelTransform, labelTextY } from "./cull.js";
export type { LabelBox, LabelBaseline, LabelCullScratch, CullOptions, TextAnchor, LabelGeometry } from "./cull.js";
export { LabelLayer, placeLabels, resolveLabelStyle, DEFAULT_LABEL_STYLE, DEFAULT_LABEL_TEXT } from "./label-layer.js";
export type { LabelAnchor, LabelStyle } from "./label-layer.js";
export { measureText, canvasFont, fontRowHeight, TextMeasurer } from "./measure.js";
