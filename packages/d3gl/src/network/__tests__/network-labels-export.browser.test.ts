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
// WebGL keeps the HTML overlay.
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

  it("WebGL backend uses the HTML overlay, not backend text", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.labels({ labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect(h.querySelectorAll("[data-label-id]").length).toBe(3); // overlay divs
    expect((net as any).backend().setTextLayer).toBeUndefined(); // WebGL has no native text seam
    /* eslint-enable @typescript-eslint/no-explicit-any */
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
