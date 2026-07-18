import { describe, it, expect, vi } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { plot } from "./plot.js";
import { geoMap } from "./geo-map.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";

// Engine-owned labels for plot()/geoMap() (#223): the base measures each label once, places + culls
// on every transform, and routes to the active backend (HTML overlay on WebGL, native text on
// Canvas/SVG so labels survive export). These tests cover placement-on-zoom, importance capping,
// native-text export routing, and the per-frame signature (measured once, styled once — never per
// frame), reusing #224's sentinel idea.

function host(w = 240, h = 180): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  document.body.appendChild(el);
  return el;
}

const labelEls = (h: HTMLElement) => Array.from(h.querySelectorAll<HTMLElement>("[data-label-id]"));

interface Pt { id: number; x: number; y: number; name: string }
// Four well-separated nodes so all four labels survive collision culling in a 240×180 box.
const NODES: Pt[] = [
  { id: 0, x: 40, y: 40, name: "Alpha" },
  { id: 1, x: 190, y: 40, name: "Beta" },
  { id: 2, x: 40, y: 150, name: "Gamma" },
  { id: 3, x: 190, y: 150, name: "Delta" },
];

describe("plot().labels() — engine-owned data labels (#223)", () => {
  it("renders a label per datum in the WebGL overlay and re-places them on zoom", async () => {
    const h = host();
    const chart = plot(h, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.labels(NODES, { labelOf: (d) => d.name, anchorOf: (d) => [d.x, d.y], offset: [6, 0] });

    const els = labelEls(h);
    expect(els.length).toBe(4);
    expect(els.map((e) => e.textContent).sort()).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);

    // Zoom in: the same element is reused (reconciled by id) but repositioned by the transform.
    const el0 = h.querySelector<HTMLElement>("[data-label-id='0']")!;
    const left0 = el0.style.left;
    chart.setTransform({ k: 2, x: 0, y: 0 });
    expect(h.querySelector<HTMLElement>("[data-label-id='0']")).toBe(el0); // reused, not recreated
    expect(el0.style.left).not.toBe(left0); // re-placed on zoom
    chart.destroy();
    h.remove();
  });

  it("caps to the top-k by importance when `max` is set", async () => {
    const h = host();
    const chart = plot(h, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.labels(NODES, {
      labelOf: (d) => d.name,
      anchorOf: (d) => [d.x, d.y],
      importanceOf: (d) => d.id, // Delta (3) > Gamma (2) > Beta (1) > Alpha (0)
      offset: [6, 0],
      max: 2,
    });
    const shown = labelEls(h).map((e) => e.textContent).sort();
    expect(shown).toEqual(["Delta", "Gamma"]); // the two highest-importance
    chart.destroy();
    h.remove();
  });

  it("labels(false) removes the overlay", async () => {
    const h = host();
    const chart = plot(h, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.labels(NODES, { labelOf: (d) => d.name, anchorOf: (d) => [d.x, d.y] });
    expect(labelEls(h).length).toBeGreaterThan(0);
    chart.labels(false);
    expect(labelEls(h).length).toBe(0);
    chart.destroy();
    h.remove();
  });

  it("skips a datum whose labelOf/anchorOf returns null", async () => {
    const h = host();
    const chart = plot(h, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.labels(NODES, {
      labelOf: (d) => (d.id === 1 ? null : d.name), // Beta has no label
      anchorOf: (d) => (d.id === 2 ? null : [d.x, d.y]), // Gamma off-anchor
      offset: [6, 0],
    });
    expect(labelEls(h).map((e) => e.textContent).sort()).toEqual(["Alpha", "Delta"]);
    chart.destroy();
    h.remove();
  });
});

describe("geoMap().labels() — native-text export routing (#223)", () => {
  it("Canvas backend draws labels as <text> in toSVG(), styled by font/color/halo", async () => {
    const h = host(200, 200);
    const projection = geoEquirectangular().scale(30).translate([100, 100]);
    const map = geoMap(h, { width: 200, height: 200, projection, backend: "canvas" });
    await map.whenReady();
    // Vertically separated (different latitudes) so their label boxes don't collide + cull.
    const cities = [
      { name: "Null", lonlat: [0, 40] as [number, number] },
      { name: "South", lonlat: [0, -40] as [number, number] },
    ];
    map.labels(cities, {
      labelOf: (c) => c.name,
      anchorOf: (c) => projection(c.lonlat),
      offset: [4, 0],
      color: "#ff0000",
      halo: { color: "#ffffff", width: 2 },
    });
    const svg = map.toSVG();
    const texts = svg.match(/<text[^>]*>[^<]*<\/text>/g) ?? [];
    expect(texts.length).toBe(2);
    expect(svg).toContain(">Null<");
    expect(svg).toContain(">South<");
    expect(texts[0]).toContain('fill="#ff0000"');
    expect(texts[0]).toContain('paint-order="stroke"'); // the halo
    // No HTML overlay divs on a native-text backend — the backend owns the labels.
    expect(labelEls(h).length).toBe(0);
    map.destroy();
    h.remove();
  });

  it("WebGL keeps the overlay live and includes the labels in toSVG() via the export-only stash (#219), pushed at export time only", async () => {
    const h = host();
    const chart = plot(h, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    // Spy on the WebGL export stash: the live path (overlay) must NEVER push into it per transform.
    const pushes = vi.spyOn(WebGLBackend.prototype, "setTextLayer");
    chart.labels(NODES, { labelOf: (d) => d.name, anchorOf: (d) => [d.x, d.y], offset: [6, 0] });
    expect(labelEls(h).length).toBe(4); // the HTML overlay owns the screen on WebGL

    // A pan/zoom sweep re-places the overlay but pushes NOTHING into the export stash (zero per-frame cost).
    pushes.mockClear();
    for (let i = 0; i < 20; i++) chart.setTransform({ k: 1 + i * 0.02, x: i, y: -i });
    chart.setTransform({ k: 1, x: 0, y: 0 }); // settle back so all four nodes are in view for export
    expect(pushes.mock.calls.length).toBe(0);
    expect(labelEls(h).length).toBe(4); // overlay stayed live throughout

    // toSVG: exactly one push, and the placed labels serialize as <text>.
    const svg = chart.toSVG();
    expect(pushes.mock.calls.length).toBe(1);
    expect((svg.match(/<text/g) ?? []).length).toBe(4);
    expect(svg).toContain(">Alpha<");

    // labels(false) clears the stash too: the next export carries no text.
    chart.labels(false);
    expect(chart.toSVG()).not.toContain("<text");
    pushes.mockRestore();
    chart.destroy();
    h.remove();
  });
});

describe("plot().labels() — per-frame signature (#223, AGENTS §5)", () => {
  it("measures each label ONCE at registration and NEVER on the per-transform path", async () => {
    const h = host(400, 300);
    const chart = plot(h, { width: 400, height: 300, backend: "webgl" });
    await chart.whenReady();

    // A large, all-distinct label set: each text is measured exactly once at registration.
    const N = 2000;
    const data = Array.from({ length: N }, (_, i) => ({ i, x: (i * 37) % 400, y: (i * 53) % 300, name: `node-${i}` }));

    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, "measureText");
    chart.labels(data, { labelOf: (d) => d.name, anchorOf: (d) => [d.x, d.y], offset: [4, 0] });
    const atRegister = spy.mock.calls.length;
    expect(atRegister).toBe(N); // once per distinct label text — no per-datum re-measure, no estimate

    // A zoom sweep must NOT re-measure any text (measurement is retained on the anchors).
    spy.mockClear();
    const t0 = performance.now();
    for (let s = 0; s < 20; s++) chart.setTransform({ k: 1 + s * 0.1, x: -s, y: -s });
    const perFrame = (performance.now() - t0) / 20;
    expect(spy.mock.calls.length).toBe(0); // ZERO measurements during the transform sweep
    expect(perFrame).toBeLessThan(50); // generous ceiling; catches an order-of-magnitude regression

    spy.mockRestore();
    chart.destroy();
    h.remove();
  });

  it("styles a label element ONCE at creation — the per-transform update repositions but never restyles", async () => {
    const h = host();
    const chart = plot(h, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.labels(NODES, {
      labelOf: (d) => d.name,
      anchorOf: (d) => [d.x, d.y],
      offset: [6, 0],
      style: { color: "rgb(51, 51, 51)" },
    });
    const el0 = h.querySelector<HTMLElement>("[data-label-id='0']")!;
    expect(el0.style.color).toBe("rgb(51, 51, 51)"); // style applied at creation
    const left0 = el0.style.left;
    el0.style.color = "red"; // sentinel: any per-frame restyle would overwrite it
    chart.setTransform({ k: 1.5, x: 5, y: 5 }); // pan/zoom — same element reused
    expect(h.querySelector<HTMLElement>("[data-label-id='0']")).toBe(el0); // reused node
    expect(el0.style.left).not.toBe(left0); // repositioned…
    expect(el0.style.color).toBe("red"); // …but NOT restyled per transform
    chart.destroy();
    h.remove();
  });
});
