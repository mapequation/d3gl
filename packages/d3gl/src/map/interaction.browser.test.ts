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

  it("does not fire after a pointercancel interrupts the gesture", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    const clicks: unknown[] = [];
    map.on("click", (hit) => clicks.push(hit));

    pointer(host, "pointerdown", 108, 91);
    pointer(host, "pointercancel", 108, 91);
    pointer(host, "pointerup", 108, 91);
    expect(clicks.length).toBe(0);
    map.destroy();
    host.remove();
  });
});

describe("clip-aware pick", () => {
  it("a clipped layer only hits where its clip source is also hit", async () => {
    const { map, host } = await makeMap();
    // "land" mask covers only the c1 square's area; cells cover both squares.
    map.layer("land", [sqPoly(0, 0, 20)], { fill: "#eee" });
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`, clipTo: "land",
    });
    map.render();
    expect(map.pick(108, 91)?.id).toBe("c1"); // on the mask: cell hit
    expect(map.pick(91, 109)).toBeNull();     // c0 is clipped away entirely → no hit at all
    map.destroy();
    host.remove();
  });
});

describe("select", () => {
  it("dims the complement, keeps the selected set, clears on null", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`,
      selection: { others: { opacity: 0.3 } },
    });
    map.render();

    map.select("cells", ["c1"]);
    expect(pixelAt(host, 108, 91)[3]).toBe(255);          // selected: base style
    expect(pixelAt(host, 91, 109)[3]).toBeLessThan(110);  // other: dimmed

    // select-then-select (no intervening null): dimming flips to the new set
    map.select("cells", ["c0"]);
    expect(pixelAt(host, 91, 109)[3]).toBe(255);          // c0 now selected: full alpha
    expect(pixelAt(host, 108, 91)[3]).toBeLessThan(110);  // c1 now other: dimmed

    map.select("cells", null);
    expect(pixelAt(host, 91, 109)[3]).toBe(255);

    // Predicate form + selected style.
    map.layer("cells2", [sqPoly(40, -20, 20)], {
      fill: "rgb(0,0,255)", id: () => "x0",
      selection: { selected: { fill: "rgb(255,0,0)" }, others: { opacity: 0.3 } },
    });
    map.render();
    map.select("cells2", () => true);
    // proj([50,-10]) ≈ [143.6, 108.7]
    expect([...pixelAt(host, 143, 108)].slice(0, 3)).toEqual([255, 0, 0]);
    map.destroy();
    host.remove();
  });
});

describe("highlight", () => {
  it("draws the highlighted item on top without touching the base layer; null clears", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.highlight("cells", "c1", { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([255, 0, 0]); // base untouched

    map.highlight("cells", null);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);
    map.destroy();
    host.remove();
  });

  it("array of ids; overlay inherits clipTo; survives a transform re-push", async () => {
    const { map, host } = await makeMap();
    map.layer("land", [sqPoly(0, 0, 20)], { fill: "#eee" });
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`, clipTo: "land",
    });
    map.render();
    map.highlight("cells", ["c0", "c1"], { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    // c0's area is outside the land mask: the overlay is clipped there too.
    expect(pixelAt(host, 91, 109)[3]).toBe(0);
    // A setClip→pushLayers full re-push must keep the overlay (overlays ride along).
    map.setClip("cells", "land");
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    map.destroy();
    host.remove();
  });

  it("re-resolves against rebuilt geometry on setProjection, drops vanished ids", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.highlight("cells", "c1", { fill: "rgb(0,255,0)" });
    map.setProjection(proj());
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    map.destroy();
    host.remove();
  });

  it("rejects user layer names ending in :highlight", async () => {
    const { map, host } = await makeMap();
    expect(() => map.layer("bad:highlight", [sqPoly(0, 0, 10)], {})).toThrow(/reserved/);
    map.destroy();
    host.remove();
  });

  it("highlight + clear works on the webgl backend (empty overlay buffers)", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "webgl" });
    await map.whenReady();
    addCells(map);
    map.highlight("cells", "c1", { fill: "rgb(0,255,0)" });
    map.highlight("cells", null); // empty overlay buffers must not throw on webgl
    map.highlight("cells", ["c0", "c1"], { fill: "rgb(0,255,0)" });
    map.highlight("cells", null);
    expect(map.toPNG().startsWith("data:image/png")).toBe(true); // renders cleanly after clears
    map.destroy();
    host.remove();
  });
});

describe("hover option", () => {
  it("auto-highlights the hovered drawable, no-ops within it, clears on leave", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: (_f, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
      id: (_f, i) => `c${i}`,
      hover: { fill: "rgb(0,255,0)" },
    });
    map.render();

    pointer(host, "pointermove", 108, 91);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);

    pointer(host, "pointermove", 110, 92); // same cell: still highlighted
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);

    pointer(host, "pointermove", 91, 109); // crossed into c0
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]); // c1 restored

    pointer(host, "pointermove", 10, 10);  // empty space clears
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([255, 0, 0]);

    pointer(host, "pointermove", 108, 91);
    host.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);
    map.destroy();
    host.remove();
  });

  it("hover works without any on(hover) callback registered", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(0,0,255)", id: () => "c1", hover: { fill: "rgb(0,255,0)" } });
    map.render();
    pointer(host, "pointermove", 108, 91);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    map.destroy();
    host.remove();
  });
});
