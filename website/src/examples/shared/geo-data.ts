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

/** A fine grid over the central third of the globe (lon ±60°, lat ±30°), 4° cells —
 *  a "dense" demo layer (used clipped to land). */
export function centreCells(): Cell[] {
  return makeCells(4).filter((c) => Math.abs(c.center[0]) <= 60 && Math.abs(c.center[1]) <= 30);
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

/** A handful of major rivers as rough named polylines (the bundled world-atlas data
 *  has no rivers), shown on the GeoJSON-features map and used as streaming cluster
 *  centers. Coordinates are approximate [lon, lat] traces, mouth → source. */
export function makeMajorRivers(): Feature<LineString, { name: string }>[] {
  const rivers: [string, [number, number][]][] = [
    ["Amazon", [[-50.0, -0.7], [-55.5, -2.5], [-60.0, -3.1], [-67.9, -3.5], [-73.2, -4.5]]],
    ["Nile", [[31.3, 31.4], [32.9, 24.1], [32.5, 15.6], [32.5, 9.5], [31.6, 2.3]]],
    ["Mississippi", [[-89.2, 29.2], [-90.1, 32.3], [-90.2, 38.6], [-91.2, 43.5], [-95.0, 47.2]]],
    ["Yangtze", [[121.8, 31.4], [114.3, 30.6], [106.5, 29.6], [100.2, 26.9], [94.7, 33.5]]],
    ["Congo", [[12.4, -6.0], [16.2, -4.3], [20.0, -1.0], [25.2, 0.5], [27.2, 3.0]]],
    ["Volga", [[48.0, 46.3], [45.0, 48.7], [44.5, 51.6], [47.5, 54.3], [37.0, 57.3]]],
    ["Ganges", [[90.5, 22.5], [88.0, 24.5], [83.0, 25.4], [78.0, 26.5], [78.9, 30.1]]],
  ];
  return rivers.map(([name, coordinates]) => ({
    type: "Feature",
    properties: { name },
    geometry: { type: "LineString", coordinates },
  }));
}

// ---------------------------------------------------------------------------
// Streaming sources — async generators that emit batches of features lazily
// (only `batchSize` are materialized per tick, never the whole `total`), so a
// consumer can `await`-iterate and append them live. Points/cells are CLUSTERED
// around cities + major-river vertices (not uniform), which the world-map
// examples then clip to land. Used by the "streaming data" examples.
// ---------------------------------------------------------------------------

/** A solid default color all streamed features start with (the example's
 *  "randomize" button swaps in a new color for new + retained features). */
export const DEFAULT_STREAM_COLOR = "#e23b2f";

/** Per-feature properties: a stable id (continues across batches) + a color the
 *  example owns (constant by default; swapped by the randomize button). */
export interface StreamProps {
  id: number;
  color: string;
}
export type StreamPoint = Feature<Point, StreamProps>;
export type StreamPolygon = Feature<Polygon, StreamProps>;

export interface StreamOptions {
  /** Total features emitted before the generator completes. Default 10,000,000. */
  total?: number;
  /** Features per yielded batch. A function is re-read every batch, so the caller can
   *  resize adaptively (e.g. to fit a frame budget). Default 1000. */
  batchSize?: number | (() => number);
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

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/**
 * A clustered point process (Thomas-like): many weighted "hotspot" parents at a
 * range of scales — tight, dense cities; medium clumps along rivers; and a field
 * of random global hotspots with varied spread/weight. Offspring fall around a
 * parent with an exponential (heavy-tailed) radius, so the result is patchy and
 * multi-scale — far closer to real species-occurrence density than a smooth
 * gaussian. Clip-to-land then carves the continental outline.
 */
interface Parent {
  lon: number;
  lat: number;
  /** Mean offspring radius in degrees. */
  spread: number;
  /** Relative share of points drawn from this parent. */
  weight: number;
}

function buildParents(rng: () => number): Parent[] {
  const parents: Parent[] = [];
  for (const c of makeCities())
    parents.push({ lon: c.geometry.coordinates[0]!, lat: c.geometry.coordinates[1]!, spread: 1.5, weight: 3 });
  for (const river of makeMajorRivers())
    for (const p of river.geometry.coordinates) parents.push({ lon: p[0]!, lat: p[1]!, spread: 2.5, weight: 2 });
  // Random global hotspots: rng()*rng() biases toward small spreads/weights, so
  // most clumps are tight with a few diffuse ones — a wide range of scales.
  for (let i = 0; i < 240; i++) {
    parents.push({
      lon: rng() * 360 - 180,
      lat: rng() * 160 - 80,
      spread: 0.6 + 9 * rng() * rng(),
      weight: 0.2 + 3 * rng() * rng(),
    });
  }
  return parents;
}

function cumulativeWeights(parents: readonly Parent[]): number[] {
  const cum: number[] = [];
  let s = 0;
  for (const p of parents) {
    s += p.weight;
    cum.push(s);
  }
  return cum;
}

/** Pick a parent by weight (binary search over cumulative weights). */
function pickParent(rng: () => number, parents: readonly Parent[], cum: readonly number[]): Parent {
  const r = rng() * cum[cum.length - 1]!;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! < r) lo = mid + 1;
    else hi = mid;
  }
  return parents[lo]!;
}

/** Offspring location around a parent: exponential radius, uniform direction. */
function clusteredLonLat(rng: () => number, p: Parent): [number, number] {
  const radius = -p.spread * Math.log(Math.max(1e-9, rng())); // exponential, mean = spread
  const ang = rng() * 2 * Math.PI;
  return [
    clamp(p.lon + radius * Math.cos(ang), -180, 180),
    clamp(p.lat + radius * Math.sin(ang), -90, 90),
  ];
}

/**
 * An irregular, star-convex polygon ring (3–10 vertices, varied per-vertex radius)
 * centered at [clon, clat] with overall extent ≤ ~`size`° — a rough species range.
 * Angles are evenly spaced with bounded jitter so they stay monotonic ⇒ the ring is
 * simple (non-self-intersecting) and closed. Longitude offsets are widened by
 * 1/cos(lat) so ranges don't look squished toward the poles.
 *
 * WINDING: built CLOCKWISE in [lon, lat] (note the NEGATIVE angle). d3-geo fills on
 * the sphere, and a small exterior ring wound counter-clockwise is treated as its
 * complement → it fills the whole map. See `AGENTS.md` and `geo/project.ts`.
 */
function randomRangeRing(rng: () => number, clon: number, clat: number, size: number): [number, number][] {
  const verts = 3 + Math.floor(rng() * 8); // 3..10
  // Strongly heavy-tailed size: the vast majority of ranges are TINY and only ~3% are
  // visibly large. At high counts the translucent fill then reads as a density gradient
  // (clustered richness hotspots) instead of saturating the whole map red.
  const base =
    rng() < 0.03
      ? size * (0.1 + 0.15 * rng()) // ~3% larger ranges: 0.10..0.25 * size
      : size * (0.02 + 0.07 * rng() * rng()); // most tiny: 0.02..0.09 * size, biased small (rng²)
  const latScale = 1 / Math.max(0.25, Math.cos((clat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i < verts; i++) {
    const ang = -((i + 0.5 * rng()) / verts) * 2 * Math.PI; // NEGATIVE ⇒ clockwise ⇒ fills interior
    const r = base * (0.5 + rng()); // per-vertex radius variation
    ring.push([
      clamp(clon + r * Math.cos(ang) * latScale, -180, 180),
      clamp(clat + r * Math.sin(ang), -90, 90),
    ]);
  }
  ring.push(ring[0]!); // close the ring
  return ring;
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stream world points as GeoJSON `Feature<Point>` batches, clustered around
 *  many multi-scale hotspots. All start with DEFAULT_STREAM_COLOR. */
export async function* makeStreamingPoints(opts: StreamOptions = {}): AsyncGenerator<StreamPoint[]> {
  const { total = 10_000_000, batchSize = 1000, delayMs = 0, seed = 1, signal } = opts;
  const sizeOf = (): number => Math.max(1, Math.floor(typeof batchSize === "function" ? batchSize() : batchSize));
  const rng = mulberry32(seed);
  const parents = buildParents(rng);
  const cum = cumulativeWeights(parents);
  let id = 0;
  while (id < total) {
    if (signal?.aborted) return;
    const n = Math.min(sizeOf(), total - id);
    const batch: StreamPoint[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const [lon, lat] = clusteredLonLat(rng, pickParent(rng, parents, cum));
      batch[k] = {
        type: "Feature",
        properties: { id: id++, color: DEFAULT_STREAM_COLOR },
        geometry: { type: "Point", coordinates: [lon, lat] },
      };
    }
    yield batch;
    await tick(delayMs);
  }
}

/** Stream irregular polygon "ranges" clustered around hotspots — each a 3–10
 *  vertex star-convex polygon of varied size ≤ ~`size`°, to mimic species ranges.
 *  All start with DEFAULT_STREAM_COLOR; the example renders them very transparent
 *  so overlapping ranges build up richness. */
export async function* makeStreamingPolygons(
  opts: StreamOptions & { size?: number } = {},
): AsyncGenerator<StreamPolygon[]> {
  const { total = 10_000_000, batchSize = 1000, delayMs = 0, seed = 1, size = 16, signal } = opts;
  const sizeOf = (): number => Math.max(1, Math.floor(typeof batchSize === "function" ? batchSize() : batchSize));
  const rng = mulberry32(seed);
  const parents = buildParents(rng);
  const cum = cumulativeWeights(parents);
  let id = 0;
  while (id < total) {
    if (signal?.aborted) return;
    const n = Math.min(sizeOf(), total - id);
    const batch: StreamPolygon[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const [clon, clat] = clusteredLonLat(rng, pickParent(rng, parents, cum));
      batch[k] = {
        type: "Feature",
        properties: { id: id++, color: DEFAULT_STREAM_COLOR },
        geometry: { type: "Polygon", coordinates: [randomRangeRing(rng, clon, clat, size)] },
      };
    }
    yield batch;
    await tick(delayMs);
  }
}
