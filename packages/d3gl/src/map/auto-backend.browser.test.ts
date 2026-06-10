import { describe, it, expect, vi } from "vitest";
import { geoEquirectangular, geoOrthographic } from "d3-geo";
import { geoMap, GeoMap } from "./geo-map.js";

// BaseEngine.prototype — owns the `createWebGLBackend` seam the auto-upgrade resolves through.
// We spy here (not on a namespace import, which ESM live-bindings don't reliably intercept in the
// browser provider, and not on the instance, which is too late: the upgrade is kicked off
// synchronously inside the constructor).
const baseProto = Object.getPrototypeOf(GeoMap.prototype) as Record<string, unknown>;

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

// The engine stores the in-flight upgrade as a private `upgradeDone` promise; tests await it.
const upgradeOf = (map: unknown): Promise<void> | null => (map as { upgradeDone: Promise<void> | null }).upgradeDone;
const liveBackend = (map: unknown): string => (map as { currentBackend: string }).currentBackend;
// A WebGL-backed canvas yields a webgl2 context; a Canvas2D one does not.
const isWebGLCanvas = (host: HTMLElement): boolean => {
  const c = host.querySelector("canvas");
  if (!c) return false;
  try { return !!(c as HTMLCanvasElement).getContext("webgl2"); } catch { return false; }
};

describe("backend: \"auto\"", () => {
  it("paints canvas synchronously and resolves whenReady early, then upgrades to WebGL", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(255,0,0)", id: () => "c0" });

    // Early: whenReady resolves at the canvas first paint; the live backend is canvas.
    await map.whenReady();
    expect(liveBackend(map)).toBe("canvas");
    expect(host.querySelector("canvas")).toBeTruthy();
    // hit-test works on the canvas backend immediately (proj([10,10]) ≈ [108.7, 91.3]).
    expect(map.pick(108, 91)?.layer).toBe("cells");

    // Background upgrade: await the internal upgrade promise; the live backend is now WebGL.
    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");
    expect(isWebGLCanvas(host)).toBe(true);

    map.destroy();
    host.remove();
  });

  it("preserves layers, colors and transform across the upgrade", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    await map.whenReady();
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(0,200,0)", id: () => "c0" });
    map.setTransform({ k: 1, x: 5, y: 5 });

    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");
    // The layer + its color survive the swap (the spec is the source of truth, re-pushed on swap).
    const hit = map.pick(108 + 5, 91 + 5);
    expect(hit?.layer).toBe("cells");

    map.destroy();
    host.remove();
  });

  it("stays on canvas (and still renders) if the WebGL upgrade fails", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(baseProto, "createWebGLBackend").mockRejectedValue(new Error("no webgl2"));

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(255,0,0)", id: () => "c0" });
    await map.whenReady();
    await upgradeOf(map);

    expect(liveBackend(map)).toBe("canvas");
    expect(isWebGLCanvas(host)).toBe(false);
    expect(map.pick(108, 91)?.layer).toBe("cells"); // canvas still works
    expect(warn).toHaveBeenCalled();

    spy.mockRestore();
    warn.mockRestore();
    map.destroy();
    host.remove();
  });

  it("destroy during the upgrade leaves no orphan canvas", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    await map.whenReady();
    const up = upgradeOf(map);
    map.destroy();           // destroy before the WebGL device resolves
    await up;                // let the in-flight upgrade settle
    expect(host.querySelector("canvas")).toBeNull(); // no orphaned element left behind

    host.remove();
  });

  it("orthographic + enableZoom: rotation works on canvas and survives the WebGL upgrade", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().scale(90).translate([100, 100]), backend: "auto" });
    map.layer("land", [sqPoly(0, 0, 30)], { fill: "rgb(0,120,0)", id: () => "L" });
    map.enableZoom([1, 8]); // orthographic ⇒ rotation; dispatched against canvas first
    await map.whenReady();
    expect(liveBackend(map)).toBe("canvas");

    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");
    // The rotation interaction persists across the transparent upgrade (listeners on the host,
    // not the backend) — a drag still rotates after the swap to WebGL, no re-dispatch needed.
    const r = host.getBoundingClientRect();
    host.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 100, clientY: r.top + 100, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 140, clientY: r.top + 108, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 140, clientY: r.top + 108, bubbles: true }));
    expect((map as unknown as { projection: ReturnType<typeof geoOrthographic> }).projection.rotate()[0]).not.toBe(0);

    map.destroy();
    host.remove();
  });

  it("switching to \"webgl\" after the auto upgrade is inert — no new backend, no re-render", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    // Mirrors the Map-projections example: orthographic globe under "auto".
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().scale(90).translate([100, 100]), backend: "auto" });
    map.layer("ocean", [{ type: "Sphere" }], { fill: "rgb(212,230,245)" });
    map.layer("land", [sqPoly(0, 0, 30)], { fill: "rgb(0,120,0)", id: () => "L" });
    map.enableZoom([1, 8]);
    await map.whenReady();
    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");

    // The live backend is already WebGL. Selecting "webgl" must do nothing: no new backend
    // (same <canvas> element, swapToken unchanged) — selecting the live backend is a no-op.
    const canvasBefore = host.querySelector("canvas");
    const swapTokenBefore = (map as unknown as { swapToken: number }).swapToken;

    map.setBackend("webgl");
    await map.whenReady();

    expect(host.querySelector("canvas")).toBe(canvasBefore);     // same element — no swap
    expect((map as unknown as { swapToken: number }).swapToken).toBe(swapTokenBefore); // no swap kicked off
    expect(liveBackend(map)).toBe("webgl");

    map.destroy();
    host.remove();
  });

  it("keeps the swapped surface BELOW a later-appended overlay (no occlusion)", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(255,0,0)", id: () => "c0" });
    await map.whenReady();

    // The caller appends an HTML overlay AFTER the canvas (e.g. the website stats readout).
    // It must stay the last child so it paints on top.
    const overlay = document.createElement("div");
    host.appendChild(overlay);
    expect(host.lastElementChild).toBe(overlay);

    // Swap the backend. makeCanvas() appends the new canvas to the end of the host, but
    // installBackend repositions it to the old canvas's slot — so the overlay stays last.
    map.setBackend("webgl");
    await map.whenReady();
    expect(liveBackend(map)).toBe("webgl");
    expect(host.querySelectorAll("canvas").length).toBe(1); // old surface removed, one canvas
    expect(host.lastElementChild).toBe(overlay); // overlay still on top, not occluded

    map.destroy();
    host.remove();
  });
});
