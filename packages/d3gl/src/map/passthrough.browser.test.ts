import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { plot } from "./plot.js";
import { geoMap } from "./geo-map.js";
import { LayerHandle } from "./layer-handle.js";

// Task 5 wires the passThrough OPTION + callback data into points()/layer(). The backend
// pass-through *rendering* (canvas) lands in Task 6; until a backend declares
// supportsPassThrough, registering a pass-through layer against a LIVE backend throws
// "not supported". So these tests assert the public-API surface that is verifiable now:
//   - the synchronous return of a LayerHandle (registration defers before the backend is ready),
//   - the callback-without-passThrough guard,
//   - that the (current) unsupported-backend error surfaces once the backend installs.
// Task 6 extends this file with the real "registers + draws + is NOT pickable" assertions
// once canvas pass-through rendering exists.

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const point = (lon: number, lat: number): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [lon, lat] },
});

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

describe("passThrough public API", () => {
  it("plot.points(passThrough) returns a handle synchronously (registration defers, no retained layer)", () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "canvas" });
    // Called BEFORE whenReady(): no backend live yet, so registerPassThrough defers.
    const handle = chart.points(
      "pts",
      [{ x: 50, y: 50 }, { x: 100, y: 100 }],
      { x: (d) => d.x, y: (d) => d.y, radius: 4, fill: "rgb(255,0,0)", passThrough: true },
    );
    expect(handle).toBeInstanceOf(LayerHandle);
    expect(handle.name).toBe("pts");
    // No retained/pickable layer was created (pick reads specs + hit indexes only).
    expect(chart.pick(50, 50)).toBe(null);
    expect(chart.pick(100, 100)).toBe(null);
    // recolor() on a pass-through layer must not throw (it repaints; here it's a deferred no-op).
    expect(() => handle.recolor()).not.toThrow();
    chart.destroy();
  });

  it("geoMap.layer(passThrough) returns a handle synchronously and accepts a callback source", () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    const arrHandle = map.layer("cities", [point(0, 0), point(10, 10)], {
      fill: "rgb(0,0,255)", pointRadius: 4, passThrough: true,
    });
    expect(arrHandle).toBeInstanceOf(LayerHandle);
    expect(arrHandle.name).toBe("cities");

    const data = [point(0, 0)];
    const cbHandle = map.layer("dyn", () => data, { fill: "rgb(0,255,0)", passThrough: true });
    expect(cbHandle).toBeInstanceOf(LayerHandle);

    // No retained Point drawables → not pickable. (proj([0,0]) = [100,100].)
    expect(map.pick(100, 100)).toBe(null);
    map.destroy();
  });

  it("plot.points(callback) without passThrough throws", () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "canvas" });
    expect(() =>
      chart.points("bad", () => [{ x: 0, y: 0 }], { x: (d) => d.x, y: (d) => d.y }),
    ).toThrow(/passThrough/);
    chart.destroy();
  });

  it("geoMap.layer(callback) without passThrough throws", () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    expect(() => map.layer("bad", () => [point(0, 0)], { fill: "red" })).toThrow(/passThrough/);
    map.destroy();
  });

  it("pass-through against a backend that lacks support surfaces a clear error (until Task 6 adds canvas support)", async () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    map.layer("cities", [point(0, 0)], { fill: "red", passThrough: true });
    // Registration deferred (no backend yet); the backend install replays it and — since the
    // canvas backend does not yet declare supportsPassThrough — throws "not supported".
    await expect(map.whenReady()).rejects.toThrow(/not supported/);
    map.destroy();
  });
});
