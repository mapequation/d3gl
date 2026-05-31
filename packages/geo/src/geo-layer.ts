import { geoPath } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { GroupBuilder, PathContext } from "@d3gl/core";
import type { GeoInput } from "./project.js";

export interface GeoLayerOptions<F> {
  id?: (feature: F, index: number) => string | number;
  /** Stroke width in projected px (Line/MultiLine and polygon outlines). */
  lineWidth?: number;
  /** Dot radius in projected px for Point/MultiPoint. */
  pointRadius?: number;
}

function geomOf(input: GeoInput): GeoJSON.Geometry | null {
  if (input.type === "Feature") return input.geometry;
  if (input.type === "FeatureCollection" || input.type === "GeometryCollection") return null;
  return input as GeoJSON.Geometry;
}

function dot(ctx: PathContext, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
}

function drawFeature(ctx: PathContext, feature: GeoInput, projection: GeoProjection, radius: number): void {
  const geom = geomOf(feature);
  if (geom && geom.type === "Point") {
    const p = projection(geom.coordinates as [number, number]);
    if (p) dot(ctx, p[0], p[1], radius);
    return;
  }
  if (geom && geom.type === "MultiPoint") {
    for (const c of geom.coordinates) {
      const p = projection(c as [number, number]);
      if (p) dot(ctx, p[0], p[1], radius);
    }
    return;
  }
  // Everything else (Line/MultiLine/Polygon/MultiPolygon/Sphere/GeometryCollection/Feature).
  geoPath(projection, ctx)(feature as Parameters<ReturnType<typeof geoPath>>[0]);
}

/** A Scene.group builder projecting any GeoJSON geometry once. Points → filled dots. */
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
      g.drawable(id, (ctx: PathContext) => drawFeature(ctx, feature, projection, radius), drawOpts);
    });
  };
}
