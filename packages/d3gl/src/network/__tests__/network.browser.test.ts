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

// Pixel-level rendering of each primitive is covered (typed) at the backend layer in
// webgl/__tests__/instanced.browser.test.ts; layer assembly is covered (typed) by the
// networkLayers unit tests. These tests cover the engine's integration: mounting, the
// chainable API, and that data/style/layout drive a real backend without throwing.
describe("network() engine", () => {
  it("mounts on the default (webgl) backend and resolves whenReady", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    expect(typeof net.render).toBe("function");
    net.destroy();
  });

  it("pushes a directed graph through the lane without throwing, chainably", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });

    expect(net.data(g)).toBe(net);
    expect(net.style({ directed: true, linkWidth: 2 })).toBe(net);
    expect(net.layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) })).toBe(net);

    net.destroy();
  });

  it("renders a network to SVG on the svg backend (publication export)", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
    net
      .data(g)
      .style({ directed: true, nodeRadius: 5, nodeFill: "#ff0000", linkStroke: "#999999", linkWidth: 1 })
      .layout({ backend: "positions", positions: new Float32Array([20, 20, 100, 100, 180, 40]) });

    const svg = net.toSVG();
    expect((svg.match(/<circle/g) ?? []).length).toBe(3); // one circle per node
    expect(svg).toContain("<path"); // links + arrowheads emitted as paths

    net.destroy();
  });

  it("auto-positions an unpositioned graph with the force backend", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 8, source: [0, 1, 2, 3], target: [1, 2, 3, 0] });

    net.data(g).layout({ backend: "force", iterations: 50 });

    const svg = net.toSVG();
    const cxs = [...svg.matchAll(/<circle cx="([\d.eE+-]+)"/g)].map((m) => Number(m[1]));
    expect(cxs.length).toBe(8);
    expect(new Set(cxs).size).toBeGreaterThan(1); // nodes spread out, not all stacked

    net.destroy();
  });
});
