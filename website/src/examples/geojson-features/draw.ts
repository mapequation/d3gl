import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { LabelLayer, type LabelAnchor } from "@mapequation/d3gl/labels";
import type { ImperativeSetup } from "../types.js";
import {
  loadWorld,
  makeGraticule,
  makeRoute,
  makeCities,
  makeCluster,
  makeDemoPolygon,
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
 * a `LineString` route, a `MultiPoint` cluster, and `Point` cities — plus an HTML
 * `LabelLayer` overlay for the city names that tracks zoom. Every feature layer
 * has a hover `tooltip` (core-managed div); picking is clip-aware, so grid cells
 * only read out where they are visibly painted on land. Pure d3gl; the harness
 * supplies `width`/`height`/`backend`.
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

  // HTML label overlay over the canvas (host is positioned `relative` by the harness).
  const labelEl = document.createElement("div");
  labelEl.className = "absolute inset-0 pointer-events-none text-[11px] text-[#222]";
  host.appendChild(labelEl);

  const labels = new LabelLayer(labelEl, (a) => a.text);
  const anchors: LabelAnchor[] = cities.map((c) => {
    const [x, y] = projection(c.geometry.coordinates as [number, number])!;
    // Sit each label just right of the dot, vertically centred on it. The LabelLayer places
    // the box's TOP-LEFT at (refX + offsetX, refY + offsetY), so offset y = -height/2.
    return {
      id: c.id,
      refX: x,
      refY: y,
      text: c.name,
      width: c.name.length * 6.2 + 6,
      height: 14,
      offset: [PR + 3, -7],
    };
  });
  const update = (t = { k: 1, x: 0, y: 0 }) => labels.update(anchors, t, { width, height });
  map.enableZoom([1, 50], (t) => update(t)); // scroll to zoom, drag to pan; labels track zoom
  update();

  return { engine: map, dispose: () => labels.destroy() };
};
