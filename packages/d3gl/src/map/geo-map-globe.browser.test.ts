import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoOrthographic } from "d3-geo";
import { geoMap } from "./geo-map.js";

const sphere = { type: "Sphere" } as const;
const land = (): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 30], [30, 30], [30, 0], [0, 0]]] },
});

function mount() {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  return host;
}

describe("geoMap projections + rotation", () => {
  it("setProjection re-projects features and resets the transform", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoEquirectangular().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)", id: () => "L" });
    map.render();

    map.setProjection(geoOrthographic().fitSize([200, 200], sphere));
    expect((map as any).transform).toEqual({ k: 1, x: 0, y: 0 });
    const after = (map as any).scene.drawables("land")[0];
    expect(after).toBeTruthy();
    map.destroy();
  });

  it("enableRotation attaches a wheel handler and disableInteraction detaches it", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.enableRotation();

    const scaleBefore = (map as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBeGreaterThan(scaleBefore);

    map.disableInteraction();
    const scaleAfter = (map as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBe(scaleAfter);
    map.destroy();
  });

  it("destroy() detaches rotation listeners (no events on a destroyed engine)", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.enableRotation();

    map.destroy();
    const scaleAfter = (map as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBe(scaleAfter); // listener removed on destroy
  });

  it("a points layer with a culled back-face point + fill accessor does not throw", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    const pt = (lon: number, lat: number): GeoJSON.Feature => ({
      type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] },
    });
    // [0,0] is on the front hemisphere, [180,0] is the antipode (culled by geoLayer).
    // applyAccessors must not setFill the culled id (regression: "unknown drawable").
    expect(() => {
      map.layer("cities", [pt(0, 0), pt(180, 0)], { fill: (_g, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"), id: (_g, i) => `c${i}` });
      map.render();
    }).not.toThrow();
    // Only the front point produced a drawable.
    const ids = (map as any).scene.drawables("cities").map((d: any) => d.id);
    expect(ids).toContain("c0");
    expect(ids).not.toContain("c1");
    map.destroy();
  });

  it("a globe wheel-zoom hides hideOnInteraction layers while zooming", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.layer("dense", [land()], { fill: "rgb(0,0,200)", hideOnInteraction: true });
    map.enableRotation();

    const names = () => (map as any).renderSpecs().map((s: any) => s.name);
    expect(names()).toContain("dense");

    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    // The wheel marks the map interacting, so the dense layer drops out immediately.
    expect((map as any).interacting).toBe(true);
    expect(names()).not.toContain("dense");
    map.destroy(); // clears the debounce timer
  });

  it("hideOnInteraction drops the layer from the render only while interacting", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.layer("dense", [land()], { fill: "rgb(0,0,200)", hideOnInteraction: true });

    const names = () => (map as any).renderSpecs().map((s: any) => s.name);
    expect(names()).toContain("dense");

    (map as any).interacting = true;
    expect(names()).not.toContain("dense");
    expect(names()).toContain("land");

    (map as any).interacting = false;
    expect(names()).toContain("dense");
    map.destroy();
  });

  it("setInteracting only re-pushes when a hideOnInteraction layer is present", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("plain", [land()], { fill: "rgb(0,128,0)" }); // no hideOnInteraction

    // No opted-in layer → setInteracting just flips the flag, no render churn.
    (map as any).setInteracting(true);
    expect((map as any).interacting).toBe(true);
    const names = () => (map as any).renderSpecs().map((s: any) => s.name);
    expect(names()).toContain("plain"); // still rendered (it never opted in)

    (map as any).setInteracting(false);
    expect((map as any).interacting).toBe(false);
    map.destroy();
  });
});
