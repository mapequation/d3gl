import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap, type GeoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

/** Read one pixel from the canvas backend's surface (dpr is 1 in the test browser). */
function pixelAt(host: HTMLElement, x: number, y: number): Uint8ClampedArray {
  const canvas = host.querySelector("canvas")!;
  return canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
}

function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
}

async function makeMap(): Promise<{ map: GeoMap; host: HTMLDivElement }> {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
  await map.whenReady();
  return { map, host };
}

// Two squares: c0 over proj([-20,-20])..proj([0,0]) ≈ x 82..100, y 100..117;
// c1 over proj([0,0])..proj([20,20]) ≈ x 100..117, y 82..100.
// Probe centers: c0 ≈ (91, 109), c1 ≈ (108, 91).
function addCells(map: GeoMap): void {
  map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
    fill: (_f, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
    id: (_f, i) => `c${i}`,
  });
  map.render();
}

describe("setStyle / clearStyle", () => {
  it("applies fill/opacity overrides per drawable and restores on clear", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);

    map.setStyle("cells", "c1", { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([255, 0, 0]); // c0 untouched

    map.setStyle("cells", ["c0", "c1"], { opacity: 0.3 });
    const dim = pixelAt(host, 91, 109);
    expect(dim[0]).toBe(255);                 // hue kept
    expect(dim[3]).toBeGreaterThan(50);       // ~0.3 alpha
    expect(dim[3]).toBeLessThan(110);

    map.clearStyle("cells");
    expect(pixelAt(host, 91, 109)[3]).toBe(255);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);
    map.destroy();
    host.remove();
  });

  it("overrides survive setProjection, and recolor() reapplies them over fresh accessors", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.setStyle("cells", "c0", { opacity: 0.3 });
    map.setProjection(proj()); // re-projects + re-runs accessors
    expect(pixelAt(host, 91, 109)[3]).toBeLessThan(110);
    map.recolor("cells");
    expect(pixelAt(host, 91, 109)[3]).toBeLessThan(110);
    map.destroy();
    host.remove();
  });

  it("re-declaring the layer drops its overrides", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.setStyle("cells", "c0", { opacity: 0.3 });
    addCells(map); // map.layer(...) again
    expect(pixelAt(host, 91, 109)[3]).toBe(255);
    map.destroy();
    host.remove();
  });

  it("opacity 0 hides; clearStyle restores a layer with no base fill accessor", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.setStyle("cells", "c1", { opacity: 0 });
    expect(pixelAt(host, 108, 91)[3]).toBe(0); // fully transparent, no throw

    // A layer with NO fill accessor: override paints it, clear must restore transparency.
    map.layer("ghost", [sqPoly(40, -20, 20)], { id: () => "g0" });
    map.render();
    expect(pixelAt(host, 143, 108)[3]).toBe(0);
    map.setStyle("ghost", "g0", { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 143, 108)].slice(0, 3)).toEqual([0, 255, 0]);
    map.clearStyle("ghost");
    expect(pixelAt(host, 143, 108)[3]).toBe(0);
    map.destroy();
    host.remove();
  });
});

describe("on(click)", () => {
  it("fires with the picked hit on a stationary click; a drag does not fire", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    const clicks: ({ layer: string; id: string | number } | null)[] = [];
    map.on("click", (hit) => clicks.push(hit ? { layer: hit.layer, id: hit.id } : null));

    pointer(host, "pointerdown", 108, 91);
    pointer(host, "pointerup", 108, 91);
    expect(clicks).toEqual([{ layer: "cells", id: "c1" }]);

    pointer(host, "pointerdown", 108, 91);
    pointer(host, "pointerup", 130, 110); // > 4px travel: a drag, not a click
    expect(clicks.length).toBe(1);

    pointer(host, "pointerdown", 10, 10); // empty space
    pointer(host, "pointerup", 10, 10);
    expect(clicks[1]).toBeNull();
    map.destroy();
    host.remove();
  });
});
