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
});
