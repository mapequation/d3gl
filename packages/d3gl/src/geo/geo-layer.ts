import { geoPath, geoDistance } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { GroupBuilder, LineJoin, LineCap } from "../core/index.js";
import type { GeoInput } from "./project.js";

export interface GeoLayerOptions<F> {
  id?: (feature: F, index: number) => string | number;
  /** Stroke width in projected px (Line/MultiLine and polygon outlines). */
  lineWidth?: number;
  /** Stroke corner style: "bevel" (default) | "miter" | "round". Identical across backends. */
  lineJoin?: LineJoin;
  /** Miter length / width above which a miter falls back to a bevel (default 10). */
  miterLimit?: number;
  /** End-cap style for open strokes ("butt" default | "square" | "round"). */
  lineCap?: LineCap;
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

/**
 * Project a Point's `[lon, lat]` to screen coords, or return `null` when it isn't
 * visible. A raw `projection(point)` returns coordinates even for back-facing points
 * (they fold onto the front disc). An azimuthal projection reports a positive
 * clipAngle (e.g. orthographic ≈ 90°); others report 0 (no angular clip). When
 * azimuthal, cull points whose great-circle distance from the view centre exceeds
 * that angle. Shared by {@link geoLayer} and the pass-through path so both cull
 * identically.
 */
export function projectVisiblePoint(
  projection: GeoProjection,
  coordinates: [number, number],
): [number, number] | null {
  const clipAngle = projection.clipAngle();
  const azimuthal = clipAngle != null && clipAngle > 0;
  if (azimuthal) {
    const rot = projection.rotate();
    const centre: [number, number] = [-rot[0], -rot[1]];
    const limit = (clipAngle * Math.PI) / 180;
    if (geoDistance(coordinates, centre) > limit) return null;
  }
  const p = projection(coordinates);
  return p ? [p[0], p[1]] : null;
}

/**
 * A Scene.group builder projecting any GeoJSON geometry once. Points → analytic circles.
 *
 * WINDING (Polygon/MultiPolygon): geoPath fills on the sphere, so exterior rings must be
 * wound CLOCKWISE in [lon, lat] (latitude up; negative signed area). A counter-clockwise
 * ring is treated as its complement and fills the entire map. If polygons render as one
 * map-covering fill, rewind them. See AGENTS.md "GeoJSON winding" and geo/project.ts.
 */
export function geoLayer<F extends GeoInput>(
  features: readonly F[],
  projection: GeoProjection,
  opts: GeoLayerOptions<F> = {},
): (g: GroupBuilder) => void {
  const radius = opts.pointRadius ?? 3;
  const drawOpts = opts.lineWidth != null
    ? { lineWidth: opts.lineWidth, lineJoin: opts.lineJoin, miterLimit: opts.miterLimit, lineCap: opts.lineCap }
    : undefined;
  // Polygons/lines are clipped to the visible hemisphere by geoPath, but a raw
  // `projection(point)` returns coordinates even for back-facing points (they fold
  // onto the front disc). An azimuthal projection reports a positive clipAngle
  // (e.g. orthographic ≈ 90°); others report 0 (no angular clip). When azimuthal,
  // cull points whose great-circle distance from the view centre exceeds that angle.
  const clipAngle = projection.clipAngle();
  const azimuthal = clipAngle != null && clipAngle > 0;
  const rot = projection.rotate();
  const centre: [number, number] = [-rot[0], -rot[1]];
  const limit = azimuthal ? (clipAngle * Math.PI) / 180 : Infinity;
  const visible = (c: [number, number]): boolean => !azimuthal || geoDistance(c, centre) <= limit;
  return (g) => {
    features.forEach((feature, i) => {
      const id = opts.id ? opts.id(feature, i) : i;
      const geom = geomOf(feature);
      if (geom && geom.type === "Point") {
        const p = projectVisiblePoint(projection, geom.coordinates as [number, number]);
        if (p) g.point(id, p[0], p[1], radius);
      } else if (geom && geom.type === "MultiPoint") {
        const centers: [number, number][] = [];
        for (const c of geom.coordinates) {
          if (!visible(c as [number, number])) continue;
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
