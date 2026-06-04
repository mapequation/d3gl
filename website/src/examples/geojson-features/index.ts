import { geoNaturalEarth1 } from "d3-geo";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { LabelLayer, type LabelAnchor } from "@mapequation/d3gl/labels";
import type { ExampleHandle, ExampleOptions } from "../types.js";
import { loadWorld, makeGraticule, makeRoute, makeCities, makeCluster, makeDemoPolygon } from "../shared/geo-data.js";

const W = 900, H = 450;
const OCEAN = "#d4e6f5", LAND = "#e3e6ea";

export function mount(el: HTMLElement, opts: ExampleOptions): ExampleHandle {
  const world = loadWorld();
  const cities = makeCities();
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" }, W, H);

  // A label overlay over the canvas; ExampleFrame's canvas wrapper is `relative`.
  const labelEl = document.createElement("div");
  labelEl.className = "absolute inset-0 pointer-events-none text-[11px] text-[#222]";

  const map = geoMap(el, { width: W, height: H, projection, backend: opts.backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
  map.layer("graticule", [makeGraticule()], { stroke: "#bcc6d0", lineWidth: 0.5 });   // MultiLineString
  map.layer("region", [makeDemoPolygon()], { fill: "#9bd1a466", stroke: "#3b8c4e", lineWidth: 1 }); // Polygon
  map.layer("route", [makeRoute()], { stroke: "#e8932f", lineWidth: 1.5 });            // LineString
  map.layer("cluster", [makeCluster()], { fill: "#4dd0e1", pointRadius: 3 });          // MultiPoint
  map.layer("cities", cities.map((c) => c.geometry), { id: (_g, i) => cities[i]!.id, fill: "#e23b2f", pointRadius: 3.5 }); // Point
  map.render();

  el.appendChild(labelEl);
  const labels = new LabelLayer(labelEl, (a) => a.text);
  const PR = 3.5; // city point radius, in px
  const anchors: LabelAnchor[] = cities.map((c) => {
    const [x, y] = projection(c.geometry.coordinates as [number, number])!;
    // Sit each label just right of the dot, vertically centred on it. The LabelLayer places
    // the box's TOP-LEFT at (refX + offsetX, refY + offsetY), so offset y = -height/2.
    return { id: c.id, refX: x, refY: y, text: c.name, width: c.name.length * 6.2 + 6, height: 14, offset: [PR + 3, -7] };
  });
  const updateLabels = (t = { k: 1, x: 0, y: 0 }) => labels.update(anchors, t, { width: W, height: H });
  map.enableZoom([1, 50], (t) => updateLabels(t));   // scroll to zoom, drag to pan
  updateLabels();

  return {
    dispose: () => { labels.destroy(); labelEl.remove(); map.destroy(); },
    exportImage: () =>
      opts.backend === "svg" ? { format: "svg", data: map.toSVG() } : { format: "png", data: map.toPNG() },
  };
}
