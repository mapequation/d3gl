import { geoPath } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { GroupBuilder, PathContext } from "@d3gl/core";

/** A GeoJSON object d3-geo can project + render (feature, geometry, or collection). */
export type GeoInput = GeoJSON.GeoJSON;

/** Fit a d3 projection so `object`'s bounds fill a width x height viewport. Mutates + returns it. */
export function fitProjection<P extends GeoProjection>(
  projection: P,
  object: GeoInput,
  width: number,
  height: number,
): P {
  projection.fitSize([width, height], object as Parameters<P["fitSize"]>[1]);
  return projection;
}

/** How to derive a drawable id (and optional stroke width) from a feature. */
export interface FeatureAccessors<F> {
  id: (feature: F, index: number) => string | number;
  /** Stroke width in projected pixels; omit/0 for fill-only. */
  lineWidth?: number;
}

/**
 * A Scene.group builder that projects each GeoJSON feature ONCE with `projection`
 * (via geoPath into the drawable's PathContext) and registers it as a drawable.
 * After this, the GPU renders, recolors, and pans/zooms without re-projecting.
 */
export function featureGroup<F extends GeoInput>(
  features: readonly F[],
  projection: GeoProjection,
  accessors: FeatureAccessors<F>,
): (g: GroupBuilder) => void {
  const opts = accessors.lineWidth != null ? { lineWidth: accessors.lineWidth } : undefined;
  return (g) => {
    features.forEach((feature, i) => {
      g.drawable(
        accessors.id(feature, i),
        (ctx: PathContext) => {
          const path = geoPath(projection, ctx);
          path(feature as Parameters<typeof path>[0]);
        },
        opts,
      );
    });
  };
}
