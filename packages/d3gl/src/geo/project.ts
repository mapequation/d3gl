import { geoPath } from "d3-geo";
import type { GeoProjection, GeoSphere } from "d3-geo";
import type { GroupBuilder, PathContext } from "../core/index.js";

/**
 * A GeoJSON object d3-geo can project + render (feature, geometry, or collection),
 * plus the GeoJSON-adjacent `GeoSphere` (`{ type: "Sphere" }`) that d3-geo's
 * projections and `geoPath` accept natively to draw the whole-globe outline (the
 * ocean/graticule background). `GeoSphere` isn't part of the GeoJSON spec, so it
 * has to be unioned in explicitly — without it, callers must cast a Sphere with
 * `as any` / `as unknown as GeoInput`.
 */
export type GeoInput = GeoJSON.GeoJSON | GeoSphere;

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
 *
 * Winding matters: geoPath fills on the sphere, so a ring's orientation selects
 * the region it encloses. Wind exterior rings CLOCKWISE in [lon, lat] (latitude
 * up; i.e. negative signed area, like `makeCells`/`makeDemoPolygon`). A ring wound
 * COUNTER-clockwise is treated as its complement (the whole sphere minus the
 * region) and projects to a giant, map-covering polygon — if every polygon renders
 * as one solid fill covering the map, your rings are wound the wrong way. (Holes:
 * opposite winding to their exterior.) See also AGENTS.md "GeoJSON winding".
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
