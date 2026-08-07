import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import {
  loadWorld,
  makeGraticule,
  makeRoute,
  makeCities,
  makeCluster,
  makeDemoPolygon,
  makeIslandInLake,
  makeMajorRivers,
  centreCells,
} from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";
const PR = 3.5; // city point radius, in px
const heat = scaleSequential(interpolateViridis).domain([0, 1]);

/**
 * One map exercising every GeoJSON geometry type — land (`MultiPolygon`),
 * graticule (`MultiLineString`), a value grid clipped to land, a demo `Polygon`,
 * a `LineString` route, a `MultiPoint` cluster, and `Point` cities — plus engine
 * `map.labels(...)` for the city names, which tracks zoom and survives SVG/PNG
 * export. Every feature layer has a hover `tooltip` (core-managed div); picking is
 * clip-aware, so grid cells only read out where they are visibly painted on land.
 * Pure d3gl; the harness supplies `width`/`height`/`backend`.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const cities = makeCities();
  const cells = centreCells();
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height);

  const map = geoMap(host, {
    width, height, projection, backend,
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
  // Declared right after land so rivers/route/cities render — and pick — above the grid.
  map.layer("cells", cells.map((c) => c.geometry), {
    id: (_g, i) => cells[i]!.id,
    fill: (_g, i) => heat(cells[i]!.value),
    clipTo: "land",
    tooltip: (_g, id) => {
      const c = cellById.get(id as string);
      return c ? `value ${c.value.toFixed(3)}` : null;
    },
  });
  map.layer("graticule", [makeGraticule()], { stroke: "#bcc6d0", lineWidth: 0.5 });
  map.layer("rivers", makeMajorRivers(), {
    id: (f) => f.properties.name,
    stroke: "#3b82c4",
    lineWidth: 0.9,
    tooltip: (f) => f.properties.name,
  });
  map.layer("region", [makeDemoPolygon()], {
    fill: "#9bd1a466", stroke: "#3b8c4e", lineWidth: 1,
    tooltip: () => "Sahara box (demo region)",
  });
  // Nested rings: land ▸ lake ▸ island ▸ pond in one MultiPolygon. Ring nesting is
  // resolved by the nonzero fill rule at any depth, so the island fills solid and its
  // pond cuts back out — identically on WebGL, Canvas and SVG.
  map.layer("island-in-a-lake", [makeIslandInLake()], {
    fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5,
    tooltip: () => "Island in a lake (nested rings)",
  });
  map.layer("route", [makeRoute()], {
    stroke: "#e8932f", lineWidth: 1.5,
    tooltip: () => "London → New York → Tokyo",
  });
  map.layer("cluster", [makeCluster()], {
    fill: "#4dd0e1", pointRadius: 3,
    tooltip: () => "Cluster (MultiPoint)",
  });
  map.layer("cities", cities.map((c) => c.geometry), {
    id: (_g, i) => cities[i]!.id,
    fill: "#e23b2f",
    pointRadius: PR,
    tooltip: (_g, id) => String(id),
  });
  map.render();

  // City names as engine-managed labels: `anchorOf` projects each city to a screen point, and the
  // engine measures the text, culls overlaps, and re-places them on every pan/zoom (sat just right
  // of the dot, vertically centred). No overlay div, transform callback, or metric estimates.
  map.labels(cities, {
    labelOf: (c) => c.name,
    anchorOf: (c) => projection(c.geometry.coordinates as [number, number]),
    offset: [PR + 3, 0],
    style: { font: "11px system-ui, sans-serif", color: "#222", textShadow: "none" },
  });
  map.enableZoom([1, 50]); // scroll to zoom, drag to pan; labels track zoom

  return { engine: map };
};
