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

  it("sizes nodes by degree through the full style→export path", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    // star: node 0 is the hub (degree 3); nodes 1/2/3 are leaves (degree 1).
    const g = buildGraph({ nodeCount: 4, source: [0, 0, 0], target: [1, 2, 3], directed: true });
    net
      .data(g)
      .style({ nodeRadius: { by: "degree", scale: (d) => d } }) // radius == degree
      .layout({ backend: "positions", positions: new Float32Array([100, 100, 20, 20, 180, 20, 100, 180]) });

    const radii = [...net.toSVG().matchAll(/<circle[^>]*\br="([\d.eE+-]+)"/g)].map((m) => Number(m[1]));
    expect(radii.length).toBe(4);
    expect(new Set(radii)).toEqual(new Set([3, 1])); // hub radius 3, leaves radius 1

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

  it("drives the LOD cut through layout, enable, and zoom on the WebGL lane without throwing", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // A ring of 40 nodes (coarsens to several levels) with supplied positions ⇒ settled at once.
    const N = 40;
    const source: number[] = [];
    const target: number[] = [];
    const positions = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      source.push(i);
      target.push((i + 1) % N);
      const a = (i / N) * Math.PI * 2;
      positions[i * 2] = 100 + 80 * Math.cos(a);
      positions[i * 2 + 1] = 100 + 80 * Math.sin(a);
    }
    const g = buildGraph({ nodeCount: N, source, target });

    net
      .data(g)
      .layout({ backend: "positions", positions })
      .lod({ expandPx: 48, coarsen: { minNodes: 2 } });

    // Re-cut across a wide zoom range: collapsed aggregates when out, individual leaves when in.
    expect(net.setTransform({ k: 0.05, x: 100, y: 100 })).toBe(net);
    expect(net.setTransform({ k: 20, x: -1900, y: -1900 })).toBe(net);
    // Disabling LOD restores the full-graph draw.
    expect(net.lod(false)).toBe(net);

    net.destroy();
  });

  it("drives the LOD cut from a provided module hierarchy (N6) across layout order and zoom", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // Two modules of two nodes each, bridged — Infomap JSON node shape (id + path).
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2] });
    const modules = [
      { id: 0, path: [1, 1], flow: 0.25 },
      { id: 1, path: [1, 2], flow: 0.25 },
      { id: 2, path: [2, 1], flow: 0.25 },
      { id: 3, path: [2, 2], flow: 0.25 },
    ];

    net
      .data(g)
      .style({ sizeMode: "screen" })
      .lod({ modules, expandPx: 48 })
      .layout({ backend: "positions", positions: new Float32Array([10, 10, 30, 10, 170, 190, 190, 190]) });

    // The provided hierarchy — not coarsening — drives LOD.
    expect(net.lodSource).toBe("modules");
    // Re-cut across zoom: modules collapse when out, expand to leaves when in — no throw.
    expect(net.setTransform({ k: 0.1, x: 100, y: 100 })).toBe(net);
    expect(net.setTransform({ k: 30, x: -2900, y: -2900 })).toBe(net);

    net.destroy();
  });
});
