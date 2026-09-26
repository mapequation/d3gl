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

/**
 * `lod()` on an engine that has not run a layout yet cannot know whether a `layout({ backend: "worker" })`
 * follows — and that worker streams the structural tree itself (#103). So the main-thread build waits for
 * the end of the call chain: skipped when a worker took over, done before the next frame otherwise, and
 * done at once when a synchronous `pick`/`toSVG`/`toPNG` needs the tree. `lodSource` reports the state
 * as it is (`"none"` while deferred), which is what these tests observe: a main-thread build would show
 * up as `"main"`.
 */
describe("lod() before the first layout defers the main-thread tree build", () => {
  const labelEls = (h: HTMLElement) => h.querySelectorAll("[data-label-id]").length;
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  function placed(n: number) {
    const g = clustered(n);
    for (let i = 0; i < g.nodeCount; i++) {
      g.positions[2 * i] = 20 + ((i * 37) % 200);
      g.positions[2 * i + 1] = 20 + ((i * 91) % 200);
    }
    return g;
  }

  it("builds no main-thread tree when the chain goes on to a worker layout", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(clustered(1500)).style({ sizeMode: "screen" }).lod({ expandPx: 48 });
    expect(net.lodSource).toBe("none"); // deferred — before the fix this was a synchronous "main" build
    net.layout({ backend: "worker", iterations: 25 });
    await Promise.resolve(); // the deferred build's microtask has run — and found the worker streaming
    expect(net.lodSource).toBe("none");
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");

    net.destroy();
    host.remove();
  });

  it("places no labels over the undrawn graph while the worker tree is on its way, then labels it", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.labels({ labelOf: (id) => `n${String(id)}` });
    net.data(clustered(1500)).style({ sizeMode: "screen" }).lod({ expandPx: 48 }).layout({ backend: "worker", iterations: 25 });
    // LOD is on and no tree exists yet, so nothing is drawn — and nothing may be labelled.
    expect(labelEls(host)).toBe(0);
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");
    expect(labelEls(host)).toBeGreaterThan(0);

    net.destroy();
    host.remove();
  });

  it("with no layout, builds the tree before the next frame", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(placed(800)).lod({ expandPx: 48 });
    await Promise.resolve(); // microtasks run before the browser renders the next frame
    expect(net.lodSource).toBe("main");
    await frame();
    expect(net.toSVG()).toContain("<circle");

    net.destroy();
    host.remove();
  });

  it("with no layout, a synchronous pick or export builds the tree on demand", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(placed(800)).lod({ expandPx: 48, declutter: false });
    expect(net.pick(20, 20)).not.toBeNull(); // node 0 sits at (20, 20)
    expect(net.lodSource).toBe("main");

    net.lod(false).data(placed(600)).lod({ expandPx: 48 });
    expect(net.toSVG()).toContain("<circle");
    expect(net.lodSource).toBe("main");

    net.destroy();
    host.remove();
  });

  it("never builds on an engine destroyed in the same call chain (a React StrictMode re-mount)", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(clustered(800)).lod({ expandPx: 48 }).layout({ backend: "worker", iterations: 25 });
    net.destroy(); // stops the worker, so no run streams the tree any more
    await Promise.resolve();
    expect(net.lodSource).toBe("none");

    host.remove();
  });

  it("positions and force layouts after lod() still build synchronously", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    const g = clustered(800);
    const positions = new Float32Array(g.nodeCount * 2).map((_, i) => 10 + ((i * 53) % 220));
    net.data(g).lod({ expandPx: 48 }).layout({ backend: "positions", positions });
    expect(net.lodSource).toBe("main");

    const { net: net2, host: host2 } = makeNet();
    await net2.whenReady();
    net2.data(clustered(600)).lod({ expandPx: 32 }).layout({ backend: "force", iterations: 10 });
    expect(net2.lodSource).toBe("main");

    net.destroy();
    host.remove();
    net2.destroy();
    host2.remove();
  });
});
