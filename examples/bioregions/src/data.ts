import { geoGraticule } from "d3-geo";
import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon } from "geojson";
import { feature } from "topojson-client";
import land110m from "world-atlas/land-110m.json";

/** A synthetic grid cell with a continuous value and a categorical bioregion. */
export interface Cell {
  id: string;
  geometry: Polygon;
  /** Cell centroid [lon, lat]. */
  center: [number, number];
  /** Continuous field in [0, 1] (heatmap). */
  value: number;
  /** Categorical bioregion id in 0..7. */
  bioregion: number;
}

const STEP = 6; // degrees (coarser for SVG perf)

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Generate a global grid of 6°×6° cells with smooth synthetic fields. */
export function makeCells(): Cell[] {
  const cells: Cell[] = [];
  let col = 0;
  for (let lon = -180; lon < 180; lon += STEP, col++) {
    let row = 0;
    for (let lat = -90; lat < 90; lat += STEP, row++) {
      const lonR = (lon * Math.PI) / 180;
      const latR = (lat * Math.PI) / 180;
      const value = clamp01(0.5 + 0.5 * Math.sin(lonR * 2) * Math.cos(latR * 3));
      const field = (Math.sin(lon / 40) + Math.cos(lat / 30)) * 0.5 + 1; // ~[0,2]
      const bioregion = Math.min(7, Math.max(0, Math.floor((field / 2) * 8)));
      const geometry: Polygon = {
        type: "Polygon",
        coordinates: [
          [
            [lon, lat],
            [lon, lat + STEP],
            [lon + STEP, lat + STEP],
            [lon + STEP, lat],
            [lon, lat],
          ],
        ],
      };
      cells.push({
        id: `${col}-${row}`,
        geometry,
        center: [lon + STEP / 2, lat + STEP / 2],
        value,
        bioregion,
      });
    }
  }
  return cells;
}

/** Wrap cells as a FeatureCollection for projection fitting. */
export function cellsToFeatureCollection(cells: readonly Cell[]): FeatureCollection {
  const features: Feature[] = cells.map((c) => ({
    type: "Feature",
    properties: { id: c.id },
    geometry: c.geometry,
  }));
  return { type: "FeatureCollection", features };
}

/** A GeoJSON object d3-geo can fill that isn't part of the strict GeoJSON spec. */
export type Sphere = { type: "Sphere" };

/** The land outline (Natural Earth 110m) plus a sphere to fill as ocean. */
export interface World {
  sphere: Sphere;
  land: MultiPolygon;
}

// Derive the topojson Topology type from feature()'s own signature so we don't
// take a direct dependency on the (transitive) topojson-specification types.
type Topology = Parameters<typeof feature>[0];

/**
 * Convert the bundled world-atlas TopoJSON into a land MultiPolygon and a sphere.
 */
export function loadWorld(): World {
  const topo = land110m as unknown as Topology;
  const fc = feature(topo, topo.objects.land!) as unknown as FeatureCollection<MultiPolygon>;
  return { sphere: { type: "Sphere" }, land: fc.features[0]!.geometry };
}

/** A few well-known cities to show point geometry rendered alongside the grid. */
export interface City {
  id: string;
  name: string;
  geometry: Point;
}

export function makeCities(): City[] {
  const places: [string, number, number][] = [
    ["London", -0.13, 51.51],
    ["New York", -74.01, 40.71],
    ["Tokyo", 139.69, 35.69],
    ["Sydney", 151.21, -33.87],
    ["Cape Town", 18.42, -33.92],
    ["Rio de Janeiro", -43.2, -22.91],
    ["Nairobi", 36.82, -1.29],
    ["Mumbai", 72.88, 19.08],
  ];
  return places.map(([name, lon, lat]) => ({
    id: name!,
    name: name!,
    geometry: { type: "Point", coordinates: [lon!, lat!] },
  }));
}

/** A 20° graticule as one MultiLineString feature. */
export function makeGraticule(): Feature<MultiLineString> {
  return { type: "Feature", properties: {}, geometry: geoGraticule().step([20, 20])() };
}

/** A great-circle-ish route as a LineString feature (London -> New York -> Tokyo). */
export function makeRoute(): Feature<LineString> {
  return {
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: [[-0.13, 51.51], [-74.01, 40.71], [139.69, 35.69]] },
  };
}

/** A cluster of locations as one MultiPoint feature. */
export function makeCluster(): Feature<MultiPoint> {
  return {
    type: "Feature", properties: {},
    geometry: { type: "MultiPoint", coordinates: [[18.42, -33.92], [151.21, -33.87], [-43.2, -22.91], [36.82, -1.29], [72.88, 19.08]] },
  };
}
