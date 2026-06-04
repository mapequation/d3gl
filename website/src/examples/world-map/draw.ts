import { geoNaturalEarth1 } from "d3-geo";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import { loadWorld } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

/**
 * The simplest d3gl world map: fill a sphere as ocean, draw the Natural Earth
 * land outline, fit the projection to the canvas, and enable zoom. Pure d3gl —
 * `host` is the element to render into, `width`/`height`/`backend` come from the
 * harness.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height);
  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
  map.enableZoom([1, 50]);
  map.render();
  return map;
};
