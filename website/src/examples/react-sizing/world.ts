import type { GeoMap } from "@mapequation/d3gl/map";
import { loadWorld } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

/** Paint the Natural Earth land + ocean sphere onto a freshly-mounted map. Shared by the
 *  three sizing demos so each component file shows only its distinctive sizing prop. */
export function addWorld(map: GeoMap): void {
  const world = loadWorld();
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
  map.render();
}
