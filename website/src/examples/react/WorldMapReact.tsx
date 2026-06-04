import { useMemo } from "react";
import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import { fitProjection } from "@mapequation/d3gl/geo";
import { loadWorld } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

const WIDTH = 700;
const HEIGHT = 360;

/**
 * The same world map as the vanilla example, built with the React `<GeoMap>`
 * component. `<GeoMap>` mounts the project-once map engine and hands it back via
 * `onReady`, where we add the ocean + land layers and render once.
 */
export default function WorldMapReact() {
  // Fit the projection to the canvas once; `geoNaturalEarth1` is a plain d3-geo
  // projection and `loadWorld()` gives us the land MultiPolygon + a GeoSphere.
  const projection = useMemo(
    () => fitProjection(geoNaturalEarth1(), { type: "Sphere" }, WIDTH, HEIGHT),
    [],
  );

  return (
    <GeoMap
      width={WIDTH}
      height={HEIGHT}
      projection={projection}
      backend="webgl"
      onReady={(map) => {
        const world = loadWorld();
        map.layer("ocean", world.sphere, { fill: OCEAN });
        map.layer("land", world.land, { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
        map.render();
      }}
    />
  );
}
