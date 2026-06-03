/**
 * Geographic projection plus a project-once GeoJSON pipeline. {@link fitProjection} fits any
 * d3 projection to a feature collection and viewport, {@link featureGroup} projects features
 * into a {@link core!Scene} group exactly once, and {@link viewTransform} /
 * {@link lonLatFromScreen} / {@link referenceFromScreen} map between screen, reference, and
 * lon/lat space.
 *
 * ```ts
 * import { fitProjection, featureGroup } from "@mapequation/d3gl/geo";
 *
 * const projection = fitProjection(geoNaturalEarth1(), featureCollection, width, height);
 * scene.group("cells", featureGroup(features, projection, { id: (f) => f.id, lineWidth: 0.5 }));
 * ```
 *
 * @packageDocumentation
 */
export { fitProjection, featureGroup } from "./project.js";
export type { GeoInput, FeatureAccessors } from "./project.js";
export { viewTransform, referenceFromScreen, lonLatFromScreen } from "./inverse.js";
export type { ViewTransform } from "./inverse.js";
export { geoLayer } from "./geo-layer.js";
export type { GeoLayerOptions } from "./geo-layer.js";
