import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "../geo-map.js";

// Backend creation needs a DOM/GPU canvas, which doesn't exist in Node — so the
// engine's backend never initializes here and `whenReady()` rejects (we swallow it).
// That's fine: append's CPU path (scene + spec + id validation + hit index) still runs,
// which is what we measure. Guards the O(total)/batch regression where the duplicate-id
// check rebuilt `new Set(spec.ids)` every append (making streaming quadratic).
const pt = (lon: number, lat: number): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [lon, lat] },
});
const batch = (n: number, base: number): GeoJSON.Feature[] =>
  Array.from({ length: n }, (_, i) => pt(((base + i) % 360) - 180, (((base + i) * 7) % 180) - 90));

describe("GeoMap append stays O(new) per batch (independent of layer total)", () => {
  it("a tiny append is fast even when the layer already holds many features", () => {
    const map = geoMap({} as unknown as HTMLElement, { width: 256, height: 256, projection: geoEquirectangular() });
    map.whenReady().catch(() => {}); // backend init fails in Node — expected; CPU paths still run
    const occ = map.layer<GeoJSON.Feature>("occ", [], { pointRadius: 1, id: (_f, i) => i });

    const tinyAppend = (base: number): number => {
      const b = batch(10, base);
      const t0 = performance.now();
      occ.append(b);
      return performance.now() - t0;
    };

    // Tiny append against an ~empty layer.
    const small = Math.min(tinyAppend(0), tinyAppend(10), tinyAppend(20));

    // Grow the layer to ~300k with a few big appends (each O(new); done once).
    for (let i = 0; i < 6; i++) occ.append(batch(50_000, 1_000 + i * 50_000));

    // Tiny append against the now-large layer. With the O(total) id-rebuild bug this
    // rebuilds a Set of ~300k ids every call (~tens of ms); O(new) keeps it ~constant.
    const big = Math.min(tinyAppend(900_000), tinyAppend(910_000), tinyAppend(920_000));

    // A 10-feature append must not get materially slower just because the layer is large.
    expect(big).toBeLessThan(small + 5); // ms; O(total) bug would blow this by tens of ms
  });
});
