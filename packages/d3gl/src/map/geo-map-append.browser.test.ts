import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoOrthographic } from "d3-geo";
import { geoMap } from "./geo-map.js";

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

describe("GeoMap incremental append", () => {
  it("appends points that become pickable while existing ones are kept", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();

    const occ = map.layer("occ", [pt(0, 0)], { pointRadius: 4, fill: "rgb(255,0,0)", id: (f) => `o${(f.geometry as any).coordinates[0]}` });
    map.render();
    expect(map.pick(100, 100)?.id).toBe("o0"); // proj([0,0]) = [100,100]

    occ.append(pt(20, 0)); // proj([20,0]) = [110,100]
    map.render();
    expect(map.pick(110, 100)?.id).toBe("o20"); // appended point hits
    expect(map.pick(100, 100)?.id).toBe("o0");  // original still hits

    map.destroy();
  });

  it("appends on the webgl backend without throwing (drawable count grows)", async () => {
    // Regression guard: webgl updateLayer asserts an unchanged drawable count, so
    // append must route through the backend's appendToLayer (renderer rebuild), not
    // updateColors. The hit index (CPU) confirms both points are present.
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "webgl" });
    await map.whenReady();
    const occ = map.layer("occ", [pt(0, 0)], { pointRadius: 4, fill: "rgb(255,0,0)", id: (f) => `o${(f.geometry as any).coordinates[0]}` });
    map.render();
    expect(() => occ.append(pt(20, 0))).not.toThrow();
    map.render();
    expect(map.pick(110, 100)?.id).toBe("o20");
    expect(map.pick(100, 100)?.id).toBe("o0");
    map.destroy();
  });

  it("keeps appended features after setProjection", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    const occ = map.layer("occ", [pt(0, 0)], { pointRadius: 4, fill: "rgb(255,0,0)", id: (f) => `o${(f.geometry as any).coordinates[0]}` });
    occ.append(pt(20, 0));

    map.setProjection(geoOrthographic().scale(50).translate([100, 100]));
    map.render();
    const p = geoOrthographic().scale(50).translate([100, 100])([20, 0])!;
    expect(map.pick(Math.round(p[0]), Math.round(p[1]))?.id).toBe("o20");
    map.destroy();
  });

  it("throws on duplicate id append", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    const occ = map.layer("occ", [pt(0, 0)], { id: () => "dup" });
    expect(() => occ.append(pt(20, 0))).toThrow(/duplicate drawable id/);
    map.destroy();
  });

  it("canvas draw-on-top: many batches accumulate and survive a zoom redraw", async () => {
    // Exercises CanvasBackend.appendToLayer (draw new on top, no clear) + the stored-
    // layer accumulation that a later full render() (e.g. after zoom) redraws from.
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    const occ = map.layer("occ", [] as GeoJSON.Feature[], {
      pointRadius: 3,
      fill: "rgb(255,0,0)",
      id: (f) => `o${(f.geometry as any).coordinates[0]}`,
    });
    // Append across several batches: lon 0,10,20 → x 100,110,120 (lat 0 → y 100).
    occ.append(pt(0, 0));
    occ.append([pt(10, 0), pt(20, 0)]);
    map.render();
    expect(map.pick(100, 100)?.id).toBe("o0"); // first batch
    expect(map.pick(110, 100)?.id).toBe("o10"); // later batch
    expect(map.pick(120, 100)?.id).toBe("o20");

    // A full redraw (e.g. on zoom) must still show every accumulated batch.
    map.setTransform({ k: 1, x: 0, y: 0 });
    map.render();
    expect(map.pick(100, 100)?.id).toBe("o0");
    expect(map.pick(120, 100)?.id).toBe("o20");
    map.destroy();
  });
});
