import { describe, expect, it } from "vitest";
import { network, type NetworkLayoutOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";

/**
 * #566 — a network with a module hierarchy lays out as its map of modules by default: `layout()` on a backend that
 * computes the layout is `nested` unless `nested` is given. `nested: false` keeps the flat layout; `"positions"`
 * and a graph without a hierarchy are unchanged.
 */

/** 3 modules of 20 nodes, each a ring with a chord, the modules joined by two links. */
function modularGraph(): { graph: () => NetworkGraph; modules: { id: number; path: number[] }[] } {
  const source: number[] = [];
  const target: number[] = [];
  for (let m = 0; m < 3; m++) {
    for (let i = 0; i < 20; i++) {
      source.push(20 * m + i);
      target.push(20 * m + ((i + 1) % 20));
    }
    source.push(20 * m);
    target.push(20 * m + 10);
  }
  source.push(0, 20);
  target.push(25, 45);
  const modules = Array.from({ length: 60 }, (_, id) => ({ id, path: [Math.floor(id / 20) + 1, (id % 20) + 1] }));
  return { graph: () => buildGraph({ nodeCount: 60, source, target }), modules };
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "300px";
  el.style.height = "300px";
  document.body.appendChild(el);
  return el;
}

/** The positions a fresh engine lays the graph out at with `opts` — with or without its module hierarchy. */
async function laidOut(opts: NetworkLayoutOptions, withModules = true): Promise<Float32Array> {
  const { graph, modules } = modularGraph();
  const el = host();
  const net = network(el, { width: 300, height: 300, backend: "canvas" });
  await net.whenReady();
  const g = graph();
  net.data(g, withModules ? { modules } : undefined);
  net.layout(opts);
  const out = g.positions.slice();
  net.destroy();
  el.remove();
  return out;
}

describe("the nested layout is the default with a module hierarchy (#566)", () => {
  it("a force layout without `nested` is the nested layout, and `nested: false` the flat one", async () => {
    const byDefault = await laidOut({ backend: "force", iterations: 60 });
    const nested = await laidOut({ backend: "force", iterations: 60, nested: true });
    const flat = await laidOut({ backend: "force", iterations: 60, nested: false });
    expect(Array.from(byDefault)).toEqual(Array.from(nested));
    expect(Array.from(byDefault)).not.toEqual(Array.from(flat));
  });

  it("is flat without a hierarchy, and leaves caller-supplied positions alone", async () => {
    const plain = await laidOut({ backend: "force", iterations: 60 }, false);
    const plainFlat = await laidOut({ backend: "force", iterations: 60, nested: false }, false);
    expect(Array.from(plain)).toEqual(Array.from(plainFlat));
    const given = Float32Array.from({ length: 120 }, (_, i) => (i * 37) % 101);
    expect(Array.from(await laidOut({ backend: "positions", positions: given }))).toEqual(Array.from(given));
  });
});
