import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

const POS = new Float32Array([40, 40, 100, 100, 160, 60]);
const graph = () => buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });

// N7b-2: the active backend draws labels so they survive export — SVG <text>, Canvas fillText.
// WebGL keeps the HTML overlay on screen; since #219 its setTextLayer is an export-only stash,
// pushed by the engine at toPNG()/toSVG() time so WebGL exports include the labels too.
describe("network.labels() backend-native text (#105 N7b-2)", () => {
  it("SVG backend renders labels as <text> (with halo) in toSVG()", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}`, color: "#222", halo: { color: "#fff", width: 2 } });
    net.setTransform({ k: 1, x: 0, y: 0 });

    const svg = net.toSVG();
    expect((svg.match(/<text/g) ?? []).length).toBe(3); // one per node (no-LOD ranks all in view)
    expect(svg).toContain("n0");
    expect(svg).toContain('paint-order="stroke"'); // halo
    net.destroy();
  });

  it("Canvas backend includes labels in toSVG() and renders to a PNG without throwing", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "canvas" });
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });

    expect(() => net.render()).not.toThrow();
    expect(net.toSVG()).toContain("n1");
    expect(net.toPNG().startsWith("data:image/png")).toBe(true);
    net.destroy();
  });

  it("WebGL backend keeps the HTML overlay live; its text seam is export-only (#219)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect(h.querySelectorAll("[data-label-id]").length).toBe(3); // overlay divs still own the screen
    expect((net as any).backend().textLayerMode).toBe("export-only"); // stash-for-export, not live text
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
    h.remove();
  });

  it("WebGL exports include the placed labels, pushed at export time only — never per transform (#219)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6, nodeFill: "#1f77b4" }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}`, color: "#ff0000", halo: { color: "#ffffff", width: 2 } });
    net.setTransform({ k: 1, x: 0, y: 0 });

    // Zero per-frame cost: a pan/zoom sweep never pushes TextData into the backend stash.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const backend = (net as any).backend();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    let pushes = 0;
    const orig = backend.setTextLayer.bind(backend);
    backend.setTextLayer = (texts: unknown[]) => { pushes++; orig(texts); };
    for (let i = 0; i < 20; i++) net.setTransform({ k: 1 + i * 0.02, x: i, y: -i });
    net.setTransform({ k: 1, x: 0, y: 0 }); // settle back so all three nodes are in view for export
    expect(pushes).toBe(0);
    expect(h.querySelectorAll("[data-label-id]").length).toBe(3); // overlay stayed live throughout

    // toSVG: one push, and the labels serialize as <text>. (The network's shape layers are a
    // separate WebGL-toSVG gap — #200 — so only the text output is asserted here.)
    const svg = net.toSVG();
    expect(pushes).toBe(1);
    expect((svg.match(/<text/g) ?? []).length).toBe(3);
    expect(svg).toContain("n0");
    expect(svg).toContain('paint-order="stroke"'); // halo

    // toPNG: one more push, and the label ink (pure red on blue nodes) is in the raster.
    const png = net.toPNG();
    expect(pushes).toBe(2);
    expect(png.startsWith("data:image/png")).toBe(true);
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("decode")); img.src = png; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 180 && d[i + 1]! < 90 && d[i + 2]! < 90 && d[i + 3]! > 0) red++;
    expect(red).toBeGreaterThan(10); // label glyph pixels present in the WebGL PNG export

    // labels(false) clears the export stash too: the next export has no text.
    net.labels(false);
    expect(net.toSVG()).not.toContain("<text");
    net.destroy();
    h.remove();
  });

  it("after a WebGL→SVG backend swap, labels move from the overlay into toSVG() <text>", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 }); // start on webgl (overlay)
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });
    expect(h.querySelectorAll("[data-label-id]").length).toBe(3); // overlay on webgl

    net.setBackend("svg");
    await net.whenReady();
    net.setTransform({ k: 1, x: 0, y: 0 });

    // The swap re-routes labels to the SVG backend's <text> (the website Export-SVG path).
    expect((net.toSVG().match(/<text/g) ?? []).length).toBe(3);
    expect(net.toSVG()).toContain("n0");
    net.destroy();
    h.remove();
  });

  it("LOD on a vector backend: aggregate labels reach toSVG() (cut computed directly, not via the lane)", async () => {
    // Reproduces the bug where the LOD frontier was read from the (WebGL-only) lane, leaving labels
    // empty on SVG/Canvas where the cut is drawn via the Scene path instead.
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net.data(g).style({ directed: true }).lod({ modules, expandPx: 20 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.labels({ labelOf: (_id, info) => (info.aggregate ? `${info.count}` : null) }); // badge modules only
    net.setTransform({ k: 1, x: 0, y: 0 }); // each module collapses to one aggregate

    const svg = net.toSVG();
    expect((svg.match(/<text/g) ?? []).length).toBe(2); // two module aggregates, badged
    expect(svg).toContain(">2<"); // each covers 2 leaves
    net.destroy();
  });

  it("Canvas backend: a backend swap bakes labels into that same render (not one frame stale)", async () => {
    // Canvas draws text in render() (vs SVG/WebGL which update the DOM in setTextLayer/overlay), so the
    // label refresh must run BEFORE the swap's render — otherwise labels are blank until the next zoom/pan.
    const { CanvasBackend } = await import("../../canvas/canvas-backend.js");
    const renders: number[] = [];
    const orig = CanvasBackend.prototype.render;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CanvasBackend.prototype.render = function (this: any) { renders.push(this.textData.length); return orig.call(this); };
    try {
      const net = network(host(), { width: 200, height: 200 }); // start on webgl (no canvas renders)
      await net.whenReady();
      net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
      net.labels({ labelOf: (id) => `n${id}` });
      net.setTransform({ k: 1, x: 0, y: 0 });
      renders.length = 0; // only watch what happens during/after the swap
      net.setBackend("canvas");
      await net.whenReady();
      // At least one render during the swap already had the labels set — no zoom/pan needed to show them.
      expect(renders.some((n) => n > 0)).toBe(true);
      net.destroy();
    } finally {
      CanvasBackend.prototype.render = orig;
    }
  });

  it("labels(false) clears backend-native text", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });
    expect(net.toSVG()).toContain("<text");

    net.labels(false);
    expect(net.toSVG()).not.toContain("<text");
    net.destroy();
  });
});
