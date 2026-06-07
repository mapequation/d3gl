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

/** Base cell size in degrees; the example scales it by powers of two via a slider. */
export const BASE_STEP = 1;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Generate a global grid of `step`°×`step`° cells with smooth synthetic fields. */
export function makeCells(step: number = BASE_STEP): Cell[] {
  const cells: Cell[] = [];
  let col = 0;
  for (let lon = -180; lon < 180; lon += step, col++) {
    let row = 0;
    for (let lat = -90; lat < 90; lat += step, row++) {
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
            [lon, lat + step],
            [lon + step, lat + step],
            [lon + step, lat],
            [lon, lat],
          ],
        ],
      };
      cells.push({
        id: `${col}-${row}`,
        geometry,
        center: [lon + step / 2, lat + step / 2],
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

/** A standalone Polygon feature (a box over the Sahara) to showcase polygon geometry.
 *  Wound CLOCKWISE so d3-geo fills the small box (not the sphere complement). */
export function makeDemoPolygon(): Feature<Polygon> {
  return {
    type: "Feature", properties: { name: "demo-region" },
    geometry: { type: "Polygon", coordinates: [[[0, 15], [0, 30], [30, 30], [30, 15], [0, 15]]] },
  };
}

// ---------------------------------------------------------------------------
// Streaming sources — async generators that emit batches of randomly-placed
// features lazily (only `batchSize` features are materialized per tick, never
// the whole `total`), so a consumer can `await`-iterate and append them live.
// Used by the "streaming data" examples to exercise LayerHandle.append.
// ---------------------------------------------------------------------------

/** Per-feature properties carried by streamed features: a stable id (continues
 *  across batches) plus a color the example mutates for the "randomize" button. */
export interface StreamProps {
  id: number;
  color: string;
}
export type StreamPoint = Feature<Point, StreamProps>;
export type StreamPolygon = Feature<Polygon, StreamProps>;

export interface StreamOptions {
  /** Total features emitted before the generator completes. Default 10,000,000. */
  total?: number;
  /** Features per yielded batch. Default 1000. */
  batchSize?: number;
  /** Artificial delay between batches (ms), to mirror loading from a file/network.
   *  Even 0 yields a macrotask so the browser can paint between batches. Default 0. */
  delayMs?: number;
  /** Seed for the deterministic PRNG (reproducible streams). Default 1. */
  seed?: number;
  /** Cooperative cancellation: iteration stops once `signal.aborted` is true. */
  signal?: { aborted: boolean };
}

/** Small, fast, seedable PRNG (mulberry32) — deterministic so streams reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random vivid color as a d3-color-parseable `hsl(h, s%, l%)` string. */
function randomColor(rng: () => number): string {
  return `hsl(${Math.floor(rng() * 360)}, 70%, 55%)`;
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stream random world points as GeoJSON `Feature<Point>` batches (lon/lat uniform). */
export async function* makeStreamingPoints(opts: StreamOptions = {}): AsyncGenerator<StreamPoint[]> {
  const { total = 10_000_000, batchSize = 1000, delayMs = 0, seed = 1, signal } = opts;
  const rng = mulberry32(seed);
  let id = 0;
  while (id < total) {
    if (signal?.aborted) return;
    const n = Math.min(batchSize, total - id);
    const batch: StreamPoint[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const lon = rng() * 360 - 180;
      const lat = rng() * 180 - 90;
      batch[k] = {
        type: "Feature",
        properties: { id: id++, color: randomColor(rng) },
        geometry: { type: "Point", coordinates: [lon, lat] },
      };
    }
    yield batch;
    await tick(delayMs);
  }
}

/** Stream small random cells as GeoJSON `Feature<Polygon>` batches (≈`size`° boxes,
 *  wound like makeCells so d3-geo fills the small box). */
export async function* makeStreamingPolygons(
  opts: StreamOptions & { size?: number } = {},
): AsyncGenerator<StreamPolygon[]> {
  const { total = 10_000_000, batchSize = 1000, delayMs = 0, seed = 1, size = 1.5, signal } = opts;
  const rng = mulberry32(seed);
  let id = 0;
  while (id < total) {
    if (signal?.aborted) return;
    const n = Math.min(batchSize, total - id);
    const batch: StreamPolygon[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const lon = rng() * (360 - size) - 180;
      const lat = rng() * (180 - size) - 90;
      batch[k] = {
        type: "Feature",
        properties: { id: id++, color: randomColor(rng) },
        geometry: {
          type: "Polygon",
          coordinates: [[[lon, lat], [lon, lat + size], [lon + size, lat + size], [lon + size, lat], [lon, lat]]],
        },
      };
    }
    yield batch;
    await tick(delayMs);
  }
}
