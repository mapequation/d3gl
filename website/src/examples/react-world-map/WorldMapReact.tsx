import { useMemo } from "react";
import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import type { GeoMap as Engine, BackendType } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { loadWorld } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

export interface WorldMapReactProps {
  backend: BackendType;
  width: number;
  height: number;
  onEngine: (engine: Engine) => void;
}

/**
 * A pure renderer for the zoomable world map, built with the React `<GeoMap>`
 * wrapper. The shared Astro control bar (backend switch, export, perf) lives
 * outside this component and drives it via props — there is no status bar here.
 *
 * `<GeoMap>` mounts the project-once map engine, hands it back through `onReady`
 * (where we add the ocean + land layers, enable zoom, and render), and — when the
 * `backend` prop changes — keeps the engine alive and calls `map.setBackend()` (no
 * remount), so the layers and the current zoom/pan are preserved across a swap.
 */
export default function WorldMapReact({ backend, width, height, onEngine }: WorldMapReactProps) {
  // Fit the projection to the canvas once; `geoNaturalEarth1` is a plain d3-geo
  // projection and `loadWorld()` gives us the land MultiPolygon + a GeoSphere.
  const projection = useMemo(
    () => fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height),
    [width, height],
  );

  return (
    <GeoMap
      width={width}
      height={height}
      projection={projection}
      backend={backend}
      onReady={(map) => {
        const world = loadWorld();
        map.layer("ocean", [world.sphere], { fill: OCEAN });
        map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
        map.enableZoom([1, 50]);
        map.render();
        onEngine(map);
      }}
    />
  );
}
