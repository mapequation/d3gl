import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

describe("geoMap engine", () => {
  it("renders, recolors, switches backend, and hit-tests", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: (_f, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
      id: (_f, i) => `c${i}`,
    });
    map.render();

    // hit-test: pick within the projected bounds of sqPoly(0,0,20).
    // proj([0,0]) = [100,100], proj([20,20]) ≈ [117.5, 82.5].
    // Center of sqPoly(0,0,20) ≈ proj([10,10]) ≈ [108.7, 91.3] — clearly inside.
    const hit = map.pick(108, 91);
    expect(hit?.layer).toBe("cells");

    // recolor: no throw, returns engine
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], { fill: "rgb(0,255,0)", id: (_f, i) => `c${i}` });
    map.recolor("cells");

    // switch backends without throwing
    map.setBackend("svg");
    await map.whenReady();
    expect(host.querySelector("svg")).toBeTruthy();

    map.setBackend("webgl");
    await map.whenReady();
    expect(host.querySelector("canvas")).toBeTruthy();

    map.destroy();
  });
});
