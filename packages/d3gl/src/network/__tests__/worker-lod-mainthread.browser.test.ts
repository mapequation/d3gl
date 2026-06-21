import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * Verifies the headline worker-LOD property (#103) through the public `lodSource` getter: when LOD is
 * configured before a worker layout, the worker builds + streams the tree and the engine **adopts**
 * it (`lodSource === "worker"`) — so the main thread runs no coarsening and no O(N) geometry pass,
 * only the style geometry + the cut. The contrast cases (force backend, LOD off) pin the selection.
 * Needs a real Worker (adoption only happens when the worker streams), so it's a browser test.
 */
function clustered(n: number) {
  let s = 99 >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n); // ring backbone
    source.push(i);
    target.push((i + 1 + Math.floor(rng() * (n - 2))) % n); // deterministic chords → coarsens
  }
  return buildGraph({ nodeCount: n, source, target });
}

function makeNet() {
  const host = document.createElement("div");
  host.style.width = "240px";
  host.style.height = "240px";
  document.body.appendChild(host);
  const net = network(host, { width: 240, height: 240 });
  return { net, host };
}

describe("worker-LOD source selection (#103)", () => {
  it("adopts the worker-streamed tree when lod() precedes layout({ backend: 'worker' })", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(clustered(1500)).style({ sizeMode: "screen" }).lod({ expandPx: 48 }).layout({ backend: "worker", iterations: 25 });
    await net.whenSettled();

    // The active LOD tree IS the worker's — the main thread never coarsened or ran the O(N) geometry
    // pass; it adopted the streamed tree and only filled the style geometry + ran the cut.
    expect(net.lodSource).toBe("worker");

    // Panning/zooming keeps using the worker tree (re-cut only) — it does not fall back to a rebuild.
    net.setTransform({ k: 3, x: 12, y: -8 });
    expect(net.lodSource).toBe("worker");

    net.destroy();
    host.remove();
  });

  it("builds on the main thread for the force backend, and reports 'none' when LOD is off", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(clustered(800)).lod({ expandPx: 48 }).layout({ backend: "force", iterations: 40 });
    expect(net.lodSource).toBe("main"); // synchronous backend → main-thread tree

    net.lod(false);
    expect(net.lodSource).toBe("none"); // LOD disabled

    net.destroy();
    host.remove();
  });

  it("uses the spatial quadtree for an edge-less point cloud (#103)", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    // An edge-less graph can't be coarsened, so LOD falls back to a spatial quadtree over positions.
    const N = 3000;
    const r = (() => {
      let s = 11 >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();
    const positions = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      positions[i * 2] = r() * 500;
      positions[i * 2 + 1] = r() * 500;
    }
    const g = buildGraph({ nodeCount: N, source: [], target: [] });

    net.data(g).style({ sizeMode: "screen" }).lod({ expandPx: 48 }).layout({ backend: "positions", positions });
    expect(net.lodSource).toBe("spatial");

    // Pan/zoom re-cuts the spatial tree (O(visible)) without rebuilding or throwing.
    net.setTransform({ k: 4, x: 30, y: -20 });
    expect(net.lodSource).toBe("spatial");

    net.destroy();
    host.remove();
  });
});
