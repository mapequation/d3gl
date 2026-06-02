import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const poly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

describe("geoMap.setClip", () => {
  it("toggles clipTo on an existing layer without throwing", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [poly(-40, -40, 40)], { fill: "rgb(40,40,40)" });
    map.layer("cells", [poly(-40, -40, 80)], { fill: "rgb(255,0,0)" });
    map.render();
    expect(() => map.setClip("cells", "land")).not.toThrow();
    expect(() => map.setClip("cells", undefined)).not.toThrow();
    map.destroy();
  });
});
