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
});
