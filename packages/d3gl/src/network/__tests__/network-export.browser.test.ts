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

/** Count elements of one tag in a serialized document (`<circle …` / `<path …`). */
function count(svg: string, tag: string): number {
  return (svg.match(new RegExp(`<${tag}[\\s/>]`, "g")) ?? []).length;
}

const POS = new Float32Array([40, 40, 100, 100, 160, 60]);
const line = (): ReturnType<typeof buildGraph> => buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });

/** A 4-node graph in two two-node modules — collapses to two aggregate glyphs at k = 1. */
const clustered = (): ReturnType<typeof buildGraph> => buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
const CLUSTER_MODULES = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
];
const CLUSTER_POS = new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]);

// #200: on WebGL the network draws through the GPU instanced lane, which has no retained Scene —
// so toSVG() used to serialize an empty document (`<defs/><g/>`, zero glyphs) while the same view
// exported fine from Canvas/SVG. The engine now hands the lane's current emit to the backend as an
// export-only vector stash (the #219 text-stash seam), so all three backends export the same view.
describe("network toSVG() on the WebGL backend (#200)", () => {
  it("plain network: exports the drawn nodes and links", async () => {
    const net = network(host(), { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net.data(line()).style({ nodeRadius: 6, nodeFill: "#1f77b4" }).layout({ backend: "positions", positions: POS });
    net.setTransform({ k: 1, x: 0, y: 0 });

    const svg = net.toSVG();
    expect(count(svg, "circle")).toBe(3); // one disc per node
    expect(count(svg, "path")).toBe(2); // one stroked path per link
    expect(svg).toContain("rgba(31, 119, 180"); // the node fill reached the export
    net.destroy();
  });

  it("clustered (LOD) network: exports the cut frontier, not an empty document", async () => {
    const net = network(host(), { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net
      .data(clustered())
      .style({ directed: true, nodeRadius: 5 })
      .lod({ modules: CLUSTER_MODULES, expandPx: 20 })
      .layout({ backend: "positions", positions: CLUSTER_POS });
    net.setTransform({ k: 1, x: 0, y: 0 }); // each module collapses to one aggregate

    const svg = net.toSVG();
    expect(count(svg, "circle")).toBe(2); // two aggregate glyphs
    expect(count(svg, "path")).toBeGreaterThan(0); // the super-edge between them (+ its arrowhead)
    net.destroy();
  });

  it("matches the Canvas backend's export for the same view", async () => {
    const gl = network(host(), { width: 200, height: 200 }); // webgl default
    await gl.whenReady();
    gl.data(line()).style({ nodeRadius: 6, nodeFill: "#1f77b4" }).layout({ backend: "positions", positions: POS });
    gl.setTransform({ k: 1, x: 0, y: 0 });

    const cv = network(host(), { width: 200, height: 200, backend: "canvas" });
    await cv.whenReady();
    cv.data(line()).style({ nodeRadius: 6, nodeFill: "#1f77b4" }).layout({ backend: "positions", positions: POS });
    cv.setTransform({ k: 1, x: 0, y: 0 });

    const a = gl.toSVG();
    const b = cv.toSVG();
    expect(count(a, "circle")).toBe(count(b, "circle"));
    expect(count(a, "path")).toBe(count(b, "path"));
    gl.destroy();
    cv.destroy();
  });

  it("map style (half-arrow links): exports the fused directed glyph, not just discs", async () => {
    const net = network(host(), { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net
      .data(buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true }))
      .style({ directed: true, linkStyle: "half-arrow", nodeRadius: 8, linkWidth: 4, linkBend: 20 })
      .layout({ backend: "positions", positions: POS });
    net.setTransform({ k: 1, x: 0, y: 0 });

    const svg = net.toSVG();
    expect(count(svg, "circle")).toBe(3);
    expect(count(svg, "path")).toBe(2); // one filled half-arrow shape per directed link
    expect(svg).toContain('fill="rgba('); // the shape is filled, not stroked
    net.destroy();
  });

  it("costs nothing per frame: a zoom sweep never pushes the export stash", async () => {
    const net = network(host(), { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net.data(line()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.setTransform({ k: 1, x: 0, y: 0 });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const backend = (net as any).backend();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    let pushes = 0;
    const orig = backend.setExportLayers.bind(backend);
    backend.setExportLayers = (layers: unknown[]) => { pushes++; orig(layers); };
    for (let i = 0; i < 20; i++) net.setTransform({ k: 1 + i * 0.05, x: i, y: -i });
    net.setTransform({ k: 1, x: 0, y: 0 });
    expect(pushes).toBe(0); // the draw path never touches the export seam

    expect(count(net.toSVG(), "circle")).toBe(3);
    expect(pushes).toBe(1); // exactly one push, at export time
    net.toPNG();
    expect(pushes).toBe(1); // PNG is a GPU readback — the lanes are already in the pixels
    net.destroy();
  });

  it("exports the view at the CURRENT transform", async () => {
    const net = network(host(), { width: 200, height: 200 }); // webgl default
    await net.whenReady();
    net.data(line()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
    net.setTransform({ k: 2, x: -50, y: -50 });

    const svg = net.toSVG();
    expect(count(svg, "circle")).toBe(3);
    expect(svg).toContain("translate(-50, -50) scale(2)"); // the view group carries the live transform
    net.destroy();
  });
});
