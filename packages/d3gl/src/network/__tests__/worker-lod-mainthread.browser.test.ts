import { describe, it, expect, vi } from "vitest";
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
 * done at once when a synchronous call needs the tree (`pick`, `toSVG`/`toPNG`, `select`/`selection`,
 * `highlight`, `setStyle`/`clearStyle`). `lodSource` reports the state
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

  // select()/selection() resolve against the registered lane (WebGL) or Scene spec (Canvas/SVG). While the
  // build is queued neither exists, so without the flush a select chained after lod() was dropped: no
  // managed selection, no on("select").
  it("a select() chained after lod() is kept and observed, as with an immediate build", async () => {
    const { net, host } = makeNet();
    await net.whenReady();
    const seen: number[] = [];
    net.on("select", (hits) => seen.push(hits.length));

    net.data(placed(800)).interactive({ selectable: { multi: true } }).lod({ expandPx: 48, declutter: false }).select("nodes", [0, 1, 2]);
    expect(seen).toEqual([3]);
    const now = net.selection();
    expect(now.map((h) => h.id)).toEqual([0, 1, 2]);
    expect(now.every((h) => h.datum !== null)).toBe(true); // resolved through the LOD lane, not a missing layer
    await Promise.resolve();
    await frame();
    expect(net.selection().map((h) => h.id)).toEqual([0, 1, 2]);

    net.destroy();
    host.remove();
  });

  // highlight() resolves against the Scene spec on the vector backends. `expandPx: 1` opens every aggregate,
  // so leaf 0 is drawn and its highlight adds exactly one outline path to the export.
  it.each(["svg", "canvas"] as const)("on the %s backend, a highlight() chained after lod() is kept", async (backend) => {
    const host = document.createElement("div");
    host.style.width = "240px";
    host.style.height = "240px";
    document.body.appendChild(host);
    const net = network(host, { width: 240, height: 240, backend });
    await net.whenReady();
    const paths = () => (net.toSVG().match(/<path/g) ?? []).length;

    net.data(placed(200)).lod({ expandPx: 1, declutter: false }).highlight("nodes", [0]);
    await Promise.resolve();
    const withHighlight = paths();
    net.highlight("nodes", null);
    expect(withHighlight - paths()).toBe(1);

    net.destroy();
    host.remove();
  });

  // Interaction state made BEFORE lod() lives on the layers lod() would clear while its build is queued
  // (the vector backends clear the network's Scene). So lod() builds at once then, keeping that state.
  it.each(["svg", "canvas"] as const)("on the %s backend, a highlight made before lod() survives it", async (backend) => {
    const host = document.createElement("div");
    host.style.width = "240px";
    host.style.height = "240px";
    document.body.appendChild(host);
    const net = network(host, { width: 240, height: 240, backend });
    await net.whenReady();
    const paths = () => (net.toSVG().match(/<path/g) ?? []).length;

    net.data(placed(200)).highlight("nodes", [0]).lod({ expandPx: 1, declutter: false });
    expect(net.lodSource).toBe("main"); // built at once: nothing may be lost to a queued build
    await Promise.resolve();
    const withHighlight = paths();
    net.highlight("nodes", null);
    expect(withHighlight - paths()).toBe(1);

    net.destroy();
    host.remove();
  });

  it("toPNG() builds the deferred tree on demand too", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    net.data(placed(600)).lod({ expandPx: 48 });
    expect(net.toPNG()).toMatch(/^data:image\/png/);
    expect(net.lodSource).toBe("main");

    net.destroy();
    host.remove();
  });

  it("a gpu layout after lod() gets its main-thread tree at the end of the call chain", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    // No `fit`, so layout() itself builds nothing: the deferred build is what supplies the tree — whether
    // the solve runs on the GPU or falls back to the worker (which streams no tree for a gpu layout).
    net.data(clustered(600)).lod({ expandPx: 48 }).layout({ backend: "gpu", iterations: 5 });
    expect(net.lodSource).toBe("none");
    await Promise.resolve();
    expect(net.lodSource).toBe("main");
    await net.whenSettled();
    expect(net.lodSource).toBe("main");

    net.destroy();
    host.remove();
  });

  it("a graph swap later in the chain gets the tree, built for the new graph", async () => {
    const { net, host } = makeNet();
    await net.whenReady();

    // Two graphs in opposite corners, so a pick tells whose tree the cut draws.
    const corner = (n: number, x0: number) => {
      const g = clustered(n);
      for (let i = 0; i < g.nodeCount; i++) {
        g.positions[2 * i] = x0 + ((i * 37) % 60);
        g.positions[2 * i + 1] = x0 + ((i * 91) % 60);
      }
      return g;
    };
    net.data(corner(800, 20)).lod({ expandPx: 48, declutter: false }).data(corner(300, 160));
    expect(net.lodSource).toBe("none"); // data() dropped the (unbuilt) tree; the build is still queued
    await Promise.resolve();
    expect(net.lodSource).toBe("main"); // as `data(g2).lod(o)` would have: a tree before the next frame
    expect(net.pick(160, 160)).not.toBeNull(); // the new graph's node 0
    expect(net.pick(20, 20)).toBeNull(); // the old graph's node 0 — its tree was never built

    net.destroy();
    host.remove();
  });

  // A vector backend draws the full graph while LOD has no tree. With the build deferred, lod() must not
  // take that branch: it would tessellate the whole graph once more for a frame nobody sees, and the
  // queued build replaces it with the cut before the next frame. Before deferral, lod() drew the cut only.
  it.each(["svg", "canvas"] as const)("on the %s backend, lod() draws only the cut — never the full graph again", async (backend) => {
    const host = document.createElement("div");
    host.style.width = "240px";
    host.style.height = "240px";
    document.body.appendChild(host);
    const net = network(host, { width: 240, height: 240, backend });
    await net.whenReady();
    // The circles one render of the retained Scene draws: the live DOM on SVG (render() only repaints
    // when dirty), the `arc` calls of a fresh render on Canvas. Synchronous on purpose — any `await`
    // would let the queued build run first.
    const arc = vi.spyOn(CanvasRenderingContext2D.prototype, "arc");
    const drawn = () => {
      arc.mockClear();
      net.render();
      return backend === "svg" ? host.querySelectorAll("circle").length : arc.mock.calls.length;
    };

    // The circles painted while `step` runs: the `arc` calls on Canvas, the circles added to the DOM on SVG.
    const added = new MutationObserver(() => {});
    added.observe(host, { childList: true, subtree: true });
    const painted = (step: () => void): number => {
      arc.mockClear();
      added.takeRecords();
      step();
      if (backend === "canvas") return arc.mock.calls.length;
      let n = 0;
      for (const r of added.takeRecords())
        for (const node of r.addedNodes) if (node instanceof Element) n += node.matches("circle") ? 1 : node.querySelectorAll("circle").length;
      return n;
    };

    const g = placed(2000);
    net.data(g);
    expect(drawn()).toBe(g.nodeCount); // LOD off: the full graph, one circle per node
    // The build is queued, so lod() leaves the Scene empty — and clearing it repaints nothing on the way
    // (removing the layers one at a time repainted the rest of the full graph after each removal).
    expect(painted(() => net.lod({ expandPx: 48 }))).toBe(0);
    expect(drawn()).toBe(0);
    await Promise.resolve(); // the queued build runs first, and draws the cut
    expect(net.lodSource).toBe("main");
    const cut = drawn();
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(g.nodeCount);

    added.disconnect();
    arc.mockRestore();
    net.destroy();
    host.remove();
  });

  it("on the svg backend, a worker layout in the chain draws its streamed cut, and no full graph meanwhile", async () => {
    const host = document.createElement("div");
    host.style.width = "240px";
    host.style.height = "240px";
    document.body.appendChild(host);
    const net = network(host, { width: 240, height: 240, backend: "svg" });
    await net.whenReady();

    const g = clustered(1500);
    net.data(g).lod({ expandPx: 48 }).layout({ backend: "worker", iterations: 25 });
    expect(host.querySelectorAll("circle").length).toBe(0); // the worker's tree is on its way
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");
    const cut = host.querySelectorAll("circle").length;
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(g.nodeCount);

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
