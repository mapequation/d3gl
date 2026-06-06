import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoOrthographic, geoMercator } from "d3-geo";
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

  it("uses the GPU globe path on webgl + orthographic, CPU otherwise", async () => {
    const host = mount();
    const gpu = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "webgl" });
    await gpu.whenReady();
    gpu.layer("land", [land()], { fill: "rgb(0,128,0)" });
    gpu.enableZoom([0.5, 8]);
    expect((gpu as any).gpuGlobe).toBe(true);
    // A drag updates projection.rotate() but must NOT throw and must not depend on CPU rebuild.
    const r = host.getBoundingClientRect();
    host.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 100, clientY: r.top + 100, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 140, clientY: r.top + 110, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 140, clientY: r.top + 110, bubbles: true }));
    expect((gpu as any).projection.rotate()[0]).not.toBe(0); // rotated
    gpu.destroy();

    const host2 = mount();
    const cpu = geoMap(host2, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await cpu.whenReady();
    cpu.layer("land", [land()], { fill: "rgb(0,128,0)" });
    cpu.enableZoom([0.5, 8]);
    expect((cpu as any).gpuGlobe).toBe(false); // canvas → CPU path
    cpu.destroy();
  });

  it("enableZoom dispatches: rotation for spherical, affine zoom for flat", async () => {
    // Spherical (orthographic): enableZoom attaches the rotation wheel handler
    // (wheel changes projection.scale), not d3-zoom.
    const host = mount();
    const globe = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await globe.whenReady();
    globe.layer("land", [land()], { fill: "rgb(0,128,0)" });
    globe.enableZoom([0.5, 8]);
    const s0 = (globe as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((globe as any).projection.scale()).toBeGreaterThan(s0); // rotation path scales the projection
    globe.destroy();

    // Flat (mercator): enableZoom attaches d3-zoom; projection.scale stays fixed.
    const host2 = mount();
    const flat = geoMap(host2, { width: 200, height: 200, projection: geoMercator().fitSize([200, 200], sphere), backend: "canvas" });
    await flat.whenReady();
    flat.layer("land", [land()], { fill: "rgb(0,128,0)" });
    flat.enableZoom([1, 8]);
    const fs0 = (flat as any).projection.scale();
    host2.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((flat as any).projection.scale()).toBe(fs0); // affine path leaves projection.scale unchanged
    flat.destroy();
  });
});
