import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import { fitProjection } from "@mapequation/d3gl/geo";
import Example from "../../components/Example.js";
import { loadWorld } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

/**
 * The zoomable world map built with the React `<GeoMap>` wrapper. The universal
 * <Example> harness supplies `backend` + the measured `width`/`height` and an
 * export hook via `registerEngine` — this file is just the viz.
 */
export default function WorldMapReact() {
  return (
    <Example width={720} height={380}>
      {({ backend, width, height, registerEngine }) => (
        <GeoMap
          width={width}
          height={height}
          backend={backend}
          projection={fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height)}
          onReady={(map) => {
            const world = loadWorld();
            map.layer("ocean", [world.sphere], { fill: OCEAN });
            map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
            map.enableZoom([1, 50]);
            map.render();
            registerEngine(map);
          }}
        />
      )}
    </Example>
  );
}
