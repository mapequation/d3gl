import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "../geo-map.js";

// Backend init fails in Node (no canvas); we only exercise the CPU hit-index path,
// which is what `pickable` controls. (whenReady rejects — swallowed.)
const proj = () => geoEquirectangular().scale(50).translate([100, 100]); // proj([0,0]) = [100,100]
const pt = (lon: number, lat: number): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [lon, lat] },
});

describe("pickable:false", () => {
  it("skips the hit index so the layer can't be picked (the layer below wins)", () => {
    const map = geoMap({} as unknown as HTMLElement, { width: 200, height: 200, projection: proj() });
    map.whenReady().catch(() => {});
    map.layer("under", [pt(0, 0)], { pointRadius: 6, id: () => "under" }); // pickable (default)
    map.layer("over", [pt(0, 0)], { pointRadius: 6, id: () => "over", pickable: false }); // skipped

    // "over" is on top but has no hit index, so a pick at the shared point falls through to "under".
    expect(map.pick(100, 100)?.id).toBe("under");
  });

  it("a pickable layer on top is still picked (control)", () => {
    const map = geoMap({} as unknown as HTMLElement, { width: 200, height: 200, projection: proj() });
    map.whenReady().catch(() => {});
    map.layer("under", [pt(0, 0)], { pointRadius: 6, id: () => "under" });
    map.layer("over", [pt(0, 0)], { pointRadius: 6, id: () => "over" }); // pickable default → wins
    expect(map.pick(100, 100)?.id).toBe("over");
  });
});
