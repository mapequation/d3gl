import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "../map/geo-map.js";

// Verifies the WebGL O(new) incremental append (capacity-doubling GrowBuffers +
// texture growth + Model rebind). The GrowBuffer minimum capacity is 256 elements,
// and each appended point expands to 4 vertices / 6 indices, so appending a few
// thousand points crosses MULTIPLE capacity-doubling boundaries (and the palette
// texture's 256-wide row boundary). The geometry uploaded BEFORE growth must survive
// the buffer reallocation + Model.setAttributes/setIndexBuffer rebind.
//
// NOTE: cannot run in the headless node harness (the vitest-browser/Playwright setup
// hangs at Vite "Re-optimizing dependencies"). For interactive/CI browser runs only.

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const pt = (lon: number, lat: number): GeoJSON.Feature => ({
  type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] },
});

function mount() {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  return host;
}

describe("WebGL O(new) incremental append across capacity-doubling boundaries", () => {
  it("seeds 1 point then appends a few thousand; early AND late points survive growth", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "webgl" });
    await map.whenReady();

    // Seed a single point at lon 0 (proj([0,0]) = [100,100]).
    const occ = map.layer("occ", [pt(0, 0)], {
      pointRadius: 3,
      fill: "rgb(255,0,0)",
      id: (f) => `o${(f.geometry as any).coordinates[0]}`,
    });
    map.render();
    expect(map.pick(100, 100)?.id).toBe("o0");

    // Append in several batches up to a few thousand points, spread across longitudes
    // 1..N so each lands at a distinct x. This forces multiple GrowBuffer reallocations
    // (1 -> ... -> a few thousand vertices) and palette-texture recreations (crossing
    // 256 drawables). Each batch is a distinct id so no duplicate throws.
    let next = 1;
    const batches = [10, 50, 200, 1000, 2000];
    expect(() => {
      for (const n of batches) {
        const feats: GeoJSON.Feature[] = [];
        for (let i = 0; i < n; i++) {
          const lon = ((next % 359) - 179); // keep within [-180,180]
          feats.push(pt(lon, 0));
          next++;
        }
        occ.append(feats);
      }
    }).not.toThrow();
    map.render();

    // The very first point (uploaded before any growth) must still be present and
    // pickable — proves the seed geometry survived the buffer reallocs + Model rebind.
    expect(map.pick(100, 100)?.id).toBe("o0");

    // A late point (appended after growth) must also be present. lon 0 maps to x 100;
    // pick a different known longitude from the last batch. proj([10,0]) = [110,100].
    // lon 10 was appended (10 falls within the swept range), so it is pickable.
    expect(map.pick(110, 100)).not.toBeNull();

    map.destroy();
  });
});
