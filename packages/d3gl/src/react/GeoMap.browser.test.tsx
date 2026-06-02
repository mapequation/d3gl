import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { geoEquirectangular } from "d3-geo";
import { GeoMap } from "./GeoMap.js";
import type { GeoMap as Engine } from "../map/index.js";

describe("<GeoMap>", () => {
  it("mounts, calls onReady with the engine, and renders a canvas", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const ready = new Promise<Engine>((resolve) => {
      root.render(
        <GeoMap width={120} height={120} projection={geoEquirectangular().scale(30).translate([60, 60])} backend="canvas" onReady={(m) => resolve(m)} />,
      );
    });
    const map = await ready;
    expect(map).toBeTruthy();
    map.layer("cells", [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]] } }], { fill: "rgb(255,0,0)" });
    map.render();
    expect(host.querySelector("canvas")).toBeTruthy();
    root.unmount();
  });
});
