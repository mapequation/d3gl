import { useMemo, useRef, useState } from "react";
import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import type { GeoMap as Engine, BackendType } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { loadWorld } from "../shared/geo-data.js";
import { download } from "../../components/controls.ts";
import StatusBar from "./StatusBar.tsx";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

const WIDTH = 720;
const HEIGHT = 380;

/**
 * The same zoomable world map as the vanilla example, built with the React
 * `<GeoMap>` component. `<GeoMap>` mounts the project-once map engine and hands it
 * back via `onReady`, where we add the ocean + land layers, enable zoom, and render.
 *
 * Backend switching is handled by `<GeoMap>` itself: it keeps the engine alive and
 * calls `map.setBackend()` when the `backend` prop changes (no remount), so we just
 * lift `backend` to state and feed it down.
 */
export default function WorldMapReact() {
  const [backend, setBackend] = useState<BackendType>("webgl");
  const mapRef = useRef<Engine | null>(null);

  // Fit the projection to the canvas once; `geoNaturalEarth1` is a plain d3-geo
  // projection and `loadWorld()` gives us the land MultiPolygon + a GeoSphere.
  const projection = useMemo(
    () => fitProjection(geoNaturalEarth1(), { type: "Sphere" }, WIDTH, HEIGHT),
    [],
  );

  const onExport = () => {
    const map = mapRef.current;
    if (!map) return;
    if (backend === "svg") download(URL.createObjectURL(new Blob([map.toSVG()], { type: "image/svg+xml" })), "world-map.svg");
    else download(map.toPNG(), "world-map.png");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <StatusBar
        backend={backend}
        onBackendChange={setBackend}
        onExport={onExport}
        exportLabel={backend === "svg" ? "Export SVG" : "Export PNG"}
      />
      <GeoMap
        width={WIDTH}
        height={HEIGHT}
        projection={projection}
        backend={backend}
        onReady={(map) => {
          mapRef.current = map;
          const world = loadWorld();
          map.layer("ocean", [world.sphere], { fill: OCEAN });
          map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
          map.enableZoom([1, 50]);
          map.render();
        }}
      />
    </div>
  );
}
