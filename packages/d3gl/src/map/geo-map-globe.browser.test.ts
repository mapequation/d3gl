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

  it("webgl + orthographic rotates via the same CPU reprojection path as canvas", async () => {
    // Both backends render the identical geoPath-projected geometry; rotation re-projects on
    // the CPU and pushes to whichever backend is live (no separate GPU bake path).
    for (const backend of ["webgl", "canvas"] as const) {
      const host = mount();
      const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend });
      await map.whenReady();
      map.layer("land", [land()], { fill: "rgb(0,128,0)" });
      map.enableZoom([0.5, 8]);
      const r = host.getBoundingClientRect();
      host.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 100, clientY: r.top + 100, bubbles: true }));
      host.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 140, clientY: r.top + 110, bubbles: true }));
      host.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 140, clientY: r.top + 110, bubbles: true }));
      expect((map as any).projection.rotate()[0]).not.toBe(0); // rotated, no throw, on both backends
      map.destroy();
    }
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

  it("enableZoom on an unready webgl backend does not throw (backend resolves later)", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200,200], sphere), backend: "webgl" });
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    expect(() => map.enableZoom([0.5, 8])).not.toThrow(); // called before whenReady()
    await map.whenReady();
    await Promise.resolve();
    // Rotation works once the backend is live (a drag updates the projection, no throw).
    const r = host.getBoundingClientRect();
    host.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 100, clientY: r.top + 100, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 140, clientY: r.top + 110, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 140, clientY: r.top + 110, bubbles: true }));
    expect((map as any).projection.rotate()[0]).not.toBe(0);
    map.destroy();
  });

  it("rotation wheel-zoom limits stay anchored across a backend swap (can still zoom back out)", async () => {
    // Regression: the wheel clamps zoom to [baseScale·minK, baseScale·maxK] where baseScale is
    // the FITTED scale captured when the projection was set. A backend swap must NOT re-anchor it
    // to the (already zoomed-in) live scale — that would ratchet the floor up and trap the zoom.
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.enableZoom([0.5, 8]);
    const fitted = (map as any).baseScale as number;

    // Zoom IN a few notches.
    for (let i = 0; i < 5; i++) host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBeGreaterThan(fitted);

    // Swap backend while zoomed in, then zoom OUT hard — must return to the fitted floor.
    map.setBackend("webgl");
    await map.whenReady();
    await Promise.resolve();
    expect((map as any).baseScale).toBeCloseTo(fitted, 5); // anchor unchanged by the swap
    for (let i = 0; i < 40; i++) host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBeCloseTo(fitted * 0.5, 1); // floor = baseScale·minK
    map.destroy();
  });

  it("a backend swap preserves the current rotation AND zoom (shared projection state)", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "webgl" });
    await map.whenReady();
    await Promise.resolve();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.enableZoom([0.5, 8]);
    // Rotate + zoom on webgl.
    const r = host.getBoundingClientRect();
    host.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 100, clientY: r.top + 100, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 140, clientY: r.top + 108, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 140, clientY: r.top + 108, bubbles: true }));
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    const rot = (map as any).projection.rotate()[0];
    const scl = (map as any).projection.scale();
    expect(rot).not.toBe(0);

    map.setBackend("canvas"); // zoom was lost on this swap before the unification
    await map.whenReady();
    expect((map as any).projection.rotate()[0]).toBeCloseTo(rot, 6); // rotation preserved
    expect((map as any).projection.scale()).toBeCloseTo(scl, 6);     // zoom preserved too
    map.destroy();
  });

  it("switching from orthographic to a flat projection re-dispatches affine pan/zoom", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200,200], sphere), backend: "webgl" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.enableZoom([0.5, 8]);
    expect((map as any).isSpherical()).toBe(true);
    map.setProjection(geoMercator().fitSize([200,200], sphere));
    expect((map as any).isSpherical()).toBe(false); // flat now → affine path, no throw
    // Wheel on a flat projection leaves projection.scale fixed (d3-zoom affine path).
    const s0 = (map as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBe(s0);
    map.destroy();
  });
});
