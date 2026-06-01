import { geoPath } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { GroupBuilder } from "@d3gl/core";
import type { GeoInput } from "./project.js";

export interface GeoLayerOptions<F> {
  id?: (feature: F, index: number) => string | number;
  /** Stroke width in projected px (Line/MultiLine and polygon outlines). */
  lineWidth?: number;
  /** Dot radius in projected px for Point/MultiPoint. */
  pointRadius?: number;
  /** "world" (default): radius scales with zoom. "screen": constant pixel size. */
  sizeMode?: "world" | "screen";
}

function geomOf(input: GeoInput): GeoJSON.Geometry | null {
  if (input.type === "Feature") return input.geometry;
  if (input.type === "FeatureCollection" || input.type === "GeometryCollection") return null;
  return input as GeoJSON.Geometry;
}

/** A Scene.group builder projecting any GeoJSON geometry once. Points → analytic circles. */
export function geoLayer<F extends GeoInput>(
  features: readonly F[],
  projection: GeoProjection,
  opts: GeoLayerOptions<F> = {},
): (g: GroupBuilder) => void {
  const radius = opts.pointRadius ?? 3;
  const drawOpts = opts.lineWidth != null ? { lineWidth: opts.lineWidth } : undefined;
  return (g) => {
    features.forEach((feature, i) => {
      const id = opts.id ? opts.id(feature, i) : i;
      const geom = geomOf(feature);
      if (geom && geom.type === "Point") {
        const p = projection(geom.coordinates as [number, number]);
        if (p) g.point(id, p[0], p[1], radius);
      } else if (geom && geom.type === "MultiPoint") {
        const centers: [number, number][] = [];
        for (const c of geom.coordinates) {
          const p = projection(c as [number, number]);
          if (p) centers.push([p[0], p[1]]);
        }
        if (centers.length > 0) g.points(id, centers, radius);
      } else {
        // Everything else (Line/MultiLine/Polygon/MultiPolygon/Sphere/GeometryCollection/Feature).
        g.drawable(id, (ctx) => geoPath(projection, ctx)(feature as Parameters<ReturnType<typeof geoPath>>[0]), drawOpts);
      }
    });
  };
}
