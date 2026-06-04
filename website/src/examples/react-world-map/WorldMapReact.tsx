import { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import type { GeoMap as Engine, BackendType } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { loadWorld } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";

export interface WorldMapReactProps {
  /** Fixed render size; the ExampleFrame canvas slot sizes the frame to match. */
  width?: number;
  height?: number;
}

/**
 * The zoomable world map, built with the React `<GeoMap>` wrapper and rendered as a
 * genuine Astro island. There is NO control bar in here — the shared ExampleFrame status
 * bar (backend switch, export, perf) lives outside and drives this via scoped DOM events:
 *
 *   - on mount we find our frame (`.d3gl-example`), read its initial `data-backend`, and
 *     subscribe to `d3gl:setbackend` so the control bar can swap backend (React state →
 *     `<GeoMap>`'s `[backend]` effect → `map.setBackend()`, preserving the current zoom/pan);
 *   - once `<GeoMap>` hands back the engine (layers added, zoom enabled, rendered) we
 *     dispatch `d3gl:ready` carrying an `exportImage()` handle the export button calls.
 */
export default function WorldMapReact({ width = 720, height = 380 }: WorldMapReactProps) {
  const ref = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [backend, setBackend] = useState<BackendType>("webgl");

  // Connect to the surrounding ExampleFrame control bar.
  useEffect(() => {
    const frame = ref.current?.closest<HTMLElement>(".d3gl-example");
    if (!frame) return;
    setBackend((frame.dataset.backend as BackendType) ?? "webgl");
    const onSetBackend = (e: Event): void => setBackend((e as CustomEvent<BackendType>).detail);
    frame.addEventListener("d3gl:setbackend", onSetBackend);
    return () => frame.removeEventListener("d3gl:setbackend", onSetBackend);
  }, []);

  // Fit the projection to the canvas once; `geoNaturalEarth1` is a plain d3-geo
  // projection and `loadWorld()` gives us the land MultiPolygon + a GeoSphere.
  const projection = useMemo(
    () => fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height),
    [width, height],
  );

  const dispatchReady = (): void => {
    const frame = ref.current?.closest<HTMLElement>(".d3gl-example");
    if (!frame) return;
    frame.dispatchEvent(
      new CustomEvent("d3gl:ready", {
        detail: {
          // Read the live backend off the frame so the format always matches the
          // currently displayed backend (this handle is captured once at ready time).
          exportImage: () => {
            const map = engineRef.current!;
            return frame.dataset.backend === "svg"
              ? { format: "svg" as const, data: map.toSVG() }
              : { format: "png" as const, data: map.toPNG() };
          },
        },
      }),
    );
  };

  return (
    <div ref={ref}>
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
          engineRef.current = map;
          dispatchReady();
        }}
      />
    </div>
  );
}
