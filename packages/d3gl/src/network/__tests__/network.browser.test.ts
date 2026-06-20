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

describe("network() engine scaffold", () => {
  it("mounts on the default (webgl) backend and resolves whenReady", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    expect(typeof net.render).toBe("function");
    net.destroy();
  });

  it("accepts a graph and the data/style/layout methods are chainable", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });

    expect(net.data(g)).toBe(net);
    expect(net.style({ directed: true })).toBe(net);
    expect(net.layout({ backend: "positions", positions: new Float32Array(6) })).toBe(net);

    net.destroy();
  });

  it("renders without throwing and exports an svg string", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    net.render();
    expect(typeof net.toSVG()).toBe("string");
    net.destroy();
  });

  it("renders nodes through the instanced lane (pixel readback)", async () => {
    const el = document.createElement("div");
    el.style.width = "64px";
    el.style.height = "64px";
    document.body.appendChild(el);
    const net = network(el, { width: 64, height: 64 });
    await net.whenReady();

    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    net
      .data(g)
      .style({ nodeRadius: 12, nodeFill: "#ff0000" })
      .layout({ backend: "positions", positions: new Float32Array([32, 32]) });
    net.render();

    // backend() is protected; reach the WebGL backend's readPixel test-aid via a cast.
    const be = (net as unknown as { backend(): { readPixel(x: number, y: number): number[] } | null }).backend();
    const centre = be!.readPixel(32, 32);
    expect(centre[0]).toBeGreaterThan(200); // red node rendered at its world centre

    net.destroy();
  });

  it("renders links through the instanced lane", async () => {
    const el = document.createElement("div");
    el.style.width = "64px";
    el.style.height = "64px";
    document.body.appendChild(el);
    const net = network(el, { width: 64, height: 64 });
    await net.whenReady();

    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    net
      .data(g)
      .style({ nodeRadius: 1, linkWidth: 8, linkStroke: "#00ff00" })
      .layout({ backend: "positions", positions: new Float32Array([10, 32, 54, 32]) });
    net.render();

    const be = (net as unknown as { backend(): { readPixel(x: number, y: number): number[] } | null }).backend();
    const midpoint = be!.readPixel(32, 32); // on the link, between the two nodes
    expect(midpoint[1]).toBeGreaterThan(150); // green link rendered

    net.destroy();
  });
});
