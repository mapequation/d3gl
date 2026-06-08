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
const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const pt = (lon: number, lat: number, id?: string): GeoJSON.Feature => ({
  type: "Feature", properties: { id }, geometry: { type: "Point", coordinates: [lon, lat] },
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

    // Seed a single point at lon 0 (proj([0,0]) = [100,100]). Ids come from a
    // stable per-feature property so each drawable is unique regardless of where
    // it lands — longitudes repeat across thousands of points, but ids must not.
    const occ = map.layer("occ", [pt(0, 0, "o0")], {
      pointRadius: 3,
      fill: "rgb(255,0,0)",
      id: (f) => (f.properties as { id: string }).id,
    });
    map.render();
    expect(map.pick(100, 100)?.id).toBe("o0");

    // Append in several batches up to a few thousand points. Crossing 256 unique
    // drawables forces palette-texture recreation; the cumulative counts (10 → 60
    // → 260 → 1260 → 3260) force multiple GrowBuffer capacity-doubling reallocs.
    // Longitudes sweep 6..175 — far enough from lon 0 that no appended point falls
    // within the seed's pick tolerance at x=100 (proj([6,0]) ≈ x105 vs the 3px
    // radius + 1px tolerance), so the seed stays the sole hit there. Ids are a
    // running counter so every drawable is unique (longitudes repeat; ids must not).
    let next = 1;
    const batches = [10, 50, 200, 1000, 2000];
    expect(() => {
      for (const n of batches) {
        const feats: GeoJSON.Feature[] = [];
        for (let i = 0; i < n; i++) {
          const lon = 6 + (next % 170); // [6,175]: clear of x=100, within [-180,180]
          feats.push(pt(lon, 0, `p${next}`));
          next++;
        }
        occ.append(feats);
      }
    }).not.toThrow();
    map.render();

    // The very first point (uploaded before any growth) must still be present and
    // pickable — proves the seed geometry survived the buffer reallocs + Model rebind.
    expect(map.pick(100, 100)?.id).toBe("o0");

    // A late point (appended after growth) must also be present. x=110 maps back to
    // lon ≈ 11.5 (proj([12,0]) ≈ [110.5,100]); the 4..178 sweep lands points there,
    // so something is pickable at x=110 well away from the seed at x=100.
    expect(map.pick(110, 100)).not.toBeNull();

    map.destroy();
  });
});
