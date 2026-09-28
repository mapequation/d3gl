/**
 * The GPU layout's LOD tree off the main thread (#377, spec §12.1 decision A, §13 T8) — through the real
 * transport and a real layout worker:
 *
 * - **Aggregates follow the GPU frames.** Every repaint after the tree is adopted paints positions together
 *   with the tree geometry refit to exactly those positions (bitwise the worker backend's
 *   `computeLODPositions`), and the positions move between repaints — so the aggregates track the stream,
 *   never a frame behind or frozen at their first geometry.
 * - **`settled` carries the tree**: a run shorter than the coarsening still settles only once the tree has
 *   been adopted, with geometry for the final positions.
 * - **The engine adopts the worker's tree** through its public trigger — `data(g).lod(…).layout({ backend:
 *   "gpu" })`, also right after an earlier GPU layout, when `lod()` runs with the GPU backend already chosen:
 *   `lod()` builds nothing, one coarsen-only worker run streams the tree, and `lodSource` reports it. (The
 *   call counts — no `buildLODTree` / `computeLODGeometry` on the main thread — are pinned in
 *   `gpu-lod-mainthread.browser.test.ts`, which needs a mocked module no real worker can load.)
 * - **A failed LOD worker** withdraws the tree with one warning: the run goes on, and the engine keeps the
 *   adopted tree, refitting it itself.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { startGpuLayout } from "../gpu-transport.js";
import { observeGpuLayoutFrames } from "../gpu-stream.js";
import { network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { buildLODTree, computeLODPositions, lodTreeFromTopology, type LODTree } from "../../lod.js";
import type { MainToWorker } from "../../worker-protocol.js";

const W = 400;
const H = 300;

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A ring with random chords: coarsens into a real multi-level tree. */
function clustered(n: number, seed = 99): NetworkGraph {
  const rng = makePrng(seed);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push((i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  return buildGraph({ nodeCount: n, source, target });
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let d = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < a.length && d !== Infinity; i++) d = Math.max(d, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return d;
}

/** How far `tree`'s geometry is from the worker backend's `computeLODPositions` at `positions` (0 = bitwise). */
function geometryError(tree: LODTree, positions: Float32Array): number {
  const reference = lodTreeFromTopology(tree);
  computeLODPositions(reference, positions);
  return Math.max(maxDiff(reference.cx, tree.cx), maxDiff(reference.cy, tree.cy), maxDiff(reference.extent, tree.extent));
}

/** Whether a posted message is a `type` request. */
function isMessage(message: unknown, type: MainToWorker["type"]): boolean {
  return typeof message === "object" && message !== null && "type" in message && message.type === type;
}

/** Whether a posted message is an LOD refit request. */
function isRefit(message: unknown): boolean {
  return isMessage(message, "lod-geometry");
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  document.body.appendChild(host);
  hosts.push(host);
  return host;
}

afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GPU layout LOD relay (#377) — transport", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("aggregates follow the GPU frames: each repaint paints positions with the tree geometry for exactly them", async () => {
    const g = clustered(4000);
    let tree: LODTree | null = null;
    const errors: number[] = [];
    let moved = 0;
    let previous: Float32Array | null = null;
    const trees: (LODTree | null)[] = [];
    const handle = startGpuLayout(
      device,
      g,
      { width: W, height: H, iterations: 80, lod: true, coarsen: { minNodes: 4 } },
      () => {
        if (!tree) return; // before the tree: the frame is painted as with LOD off
        errors.push(geometryError(tree, g.positions));
        if (previous && maxDiff(previous, g.positions) > 0) moved++;
        previous = g.positions.slice();
      },
      (t) => {
        trees.push(t);
        tree = t;
      },
    );
    await handle.settled;
    try {
      expect(handle.transport).toBe("gpu");
      expect(trees).toHaveLength(1); // adopted once, never withdrawn
      expect(errors.length).toBeGreaterThan(3);
      expect(Math.max(...errors), "a repaint painted geometry that is not the positions'").toBe(0);
      expect(moved, "the positions did not move between repaints").toBeGreaterThan(2);
      // The settled state too: the final positions with their geometry.
      const settledTree = trees[0];
      if (!settledTree) throw new Error("no tree");
      expect(geometryError(settledTree, g.positions)).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it("the final frame is copied, refit and painted once: nothing streams after settled or after a re-cool", async () => {
    const g = clustered(4000, 11);
    let tree: LODTree | null = null;
    let settled = false;
    let framesAfter = 0;
    let refitsAfter = 0;
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if (settled && isRefit(args[0])) refitsAfter++;
      Reflect.apply(post, this, args);
    });
    // The ticks each readback copy holds: a copy that repeats the previous one's ticks is a wasted copy,
    // refit and repaint (the relayed final frame used to be copied twice).
    const copies: number[] = [];
    let lastFrameAt = performance.now();
    const unobserve = observeGpuLayoutFrames((s) => {
      lastFrameAt = performance.now();
      if (s.copied) copies.push(s.ticksDone);
    });
    const idle = async (): Promise<void> => {
      const t0 = performance.now();
      while (performance.now() - lastFrameAt < 400 && performance.now() - t0 < 10_000) await sleep(50);
    };
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 80, lod: true, coarsen: { minNodes: 4 } }, () => {
      if (settled) framesAfter++;
    }, (t) => {
      tree = t;
    });
    try {
      await handle.settled;
      settled = true;
      expect(tree, "the tree was not adopted before the final frame").not.toBeNull();
      await idle();
      expect(framesAfter, "repaints after settled").toBe(0);
      expect(refitsAfter, "LOD refits after settled").toBe(0);
      // A drag's re-cool ends the same way: its final frame is copied once.
      settled = false;
      handle.pin(Uint32Array.of(0), new Float32Array([(g.positions[0] ?? 0) + 40, g.positions[1] ?? 0]));
      for (let f = 0; f < 6; f++) await nextFrame();
      handle.unpin();
      await idle();
      const repeated = copies.filter((t, i) => i > 0 && t <= (copies[i - 1] ?? -1));
      expect(repeated, `copies repeating the previous copy's ticks (copies: ${copies.join(", ")})`).toEqual([]);
    } finally {
      unobserve();
      handle.stop();
    }
  });

  it("settled waits for the tree: a run shorter than the coarsening settles with it adopted and final", async () => {
    const g = clustered(30_000, 5);
    let tree: LODTree | null = null;
    let frames = 0;
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 0, lod: true }, () => {
      frames++;
    }, (t) => {
      tree = t;
    });
    await handle.settled;
    try {
      const adopted: LODTree | null = tree;
      expect(adopted, "settled before the LOD tree arrived").not.toBeNull();
      if (!adopted) return;
      expect(frames).toBeGreaterThanOrEqual(2); // the seed, then the tree's first repaint
      expect(geometryError(adopted, g.positions)).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it("a failed LOD worker withdraws the tree with one warning; the run goes on, repaints and settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = Worker.prototype.postMessage;
    let refits = 0;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      // The adoption refit and the first streamed one go through; the next cannot be posted.
      if (isRefit(args[0]) && ++refits === 3) throw new DOMException("refused", "DataCloneError");
      Reflect.apply(post, this, args);
    });
    const g = clustered(3000, 7);
    const trees: (LODTree | null)[] = [];
    let framesAfter = 0;
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 120, lod: true }, () => {
      if (trees.length === 2) framesAfter++;
    }, (t) => trees.push(t));
    await handle.settled;
    try {
      expect(refits).toBeGreaterThanOrEqual(3);
      expect(trees).toHaveLength(2);
      expect(trees[0]).not.toBeNull();
      expect(trees[1]).toBeNull();
      expect(framesAfter, "no repaint after the LOD worker failed").toBeGreaterThan(0);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("LOD tree is built on the main thread"))).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });
});

describe("GPU layout LOD relay (#377) — a relay that fails while the run starts", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("the coarsen post fails: the transport is reported first, then the tree withdrawn; the run goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if (isMessage(args[0], "coarsen")) throw new DOMException("refused", "DataCloneError");
      Reflect.apply(post, this, args);
    });
    // The engine's onTransport("gpu") marks the tree as streaming; a withdrawal heard before it would be undone.
    const events: string[] = [];
    const handle = startGpuLayout(device, clustered(2000, 12), { width: W, height: H, iterations: 30, lod: true }, () => {}, (t) => {
      events.push(t ? "tree" : "withdrawn");
    }, (transport) => events.push(`transport ${transport}`));
    try {
      expect(events).toEqual(["transport gpu", "withdrawn"]);
      await handle.settled;
      expect(handle.transport).toBe("gpu");
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("LOD tree is built on the main thread"))).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("the module seed throws: the relay's worker is terminated before the worker fallback, which alone streams a tree", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = clustered(2000, 13);
    const moduleTopology = buildLODTree(g); // a coarsening tree with super-edges seeds as a module tree does
    const post = Worker.prototype.postMessage;
    const coarsenWorkers: Worker[] = [];
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if (isMessage(args[0], "coarsen")) coarsenWorkers.push(this);
      Reflect.apply(post, this, args);
    });
    const terminated: Worker[] = [];
    const terminate = Worker.prototype.terminate;
    vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      terminated.push(this);
      Reflect.apply(terminate, this, []);
    });
    // The seed's first GPU allocation fails, after the relay has started coarsening.
    const createTexture = device.createTexture.bind(device);
    vi.spyOn(device, "createTexture").mockImplementation((props) => {
      if (coarsenWorkers.length > 0) throw new Error("seed allocation refused");
      return createTexture(props);
    });
    const trees: (LODTree | null)[] = [];
    const handle = startGpuLayout(Promise.resolve(device), g, { width: W, height: H, iterations: 20, lod: true, moduleTopology }, () => {}, (t) => {
      trees.push(t);
    });
    try {
      await handle.settled;
      expect(handle.transport).toBe("worker");
      expect(coarsenWorkers, "the relay never started").toHaveLength(1);
      expect(terminated, "the relay's worker outlived the failed start").toContain(coarsenWorkers[0]);
      await sleep(500); // a live relay would adopt its own tree by now
      expect(trees.filter((t) => t !== null)).toHaveLength(1); // the fallback worker's
    } finally {
      handle.stop();
    }
  });
});

describe("GPU layout LOD relay (#377) — no worker", () => {
  it("no LOD worker can start (a page that blocks workers): one warning, the tree withdrawn, the run goes on", async () => {
    const device = await makeTestDevice();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new DOMException("blocked by the page's policy", "SecurityError");
        }
      },
    );
    const trees: (LODTree | null)[] = [];
    let frames = 0;
    const handle = startGpuLayout(device, clustered(2000, 4), { width: W, height: H, iterations: 30, lod: true }, () => {
      frames++;
    }, (t) => trees.push(t));
    try {
      expect(trees).toEqual([null]); // withdrawn at once: the caller builds the tree
      await handle.settled;
      expect(handle.transport).toBe("gpu");
      expect(frames).toBeGreaterThan(0);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("no LOD worker could start"))).toHaveLength(1);
    } finally {
      handle.stop();
      device.destroy();
    }
  });
});

describe("GPU layout LOD relay (#377) — engine", () => {
  it("data → lod → layout({ backend: 'gpu' }) builds and refits no tree on the main thread; lodSource is the worker's", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      // An earlier GPU layout, so the next lod() runs with the GPU backend chosen (and data() stops it).
      net.data(clustered(500, 1)).layout({ backend: "gpu", iterations: 5 });
      await net.whenSettled();
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      net.data(clustered(3000, 3)).style({ sizeMode: "screen" }).lod({ expandPx: 48 });
      expect(net.lodSource).toBe("none"); // lod() built no tree: the layout's worker streams it
      net.layout({ backend: "gpu", iterations: 60 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      expect(net.lodSource).toBe("worker");
      // One coarsen-only run (no layout worker), and refits for the streamed frames.
      const types = posts.mock.calls.map((c: [MainToWorker, ...unknown[]]) => c[0].type);
      expect(types.filter((t) => t === "coarsen")).toHaveLength(1);
      expect(types.filter((t) => t === "start")).toHaveLength(0);
      expect(types.filter((t) => t === "lod-geometry").length).toBeGreaterThan(1);
      // Pan and zoom re-cut the worker's tree; nothing is rebuilt.
      net.setTransform({ k: 3, x: 12, y: -8 });
      await nextFrame();
      expect(net.lodSource).toBe("worker");
    } finally {
      net.destroy();
    }
  });

  it("a failed LOD worker: the engine keeps drawing the adopted tree and refits it itself", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      const post = Worker.prototype.postMessage;
      let refits = 0;
      vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
        if (isRefit(args[0]) && ++refits === 3) throw new DOMException("refused", "DataCloneError");
        Reflect.apply(post, this, args);
      });
      net.data(clustered(3000, 8)).lod({ expandPx: 48 }).layout({ backend: "gpu", iterations: 120 });
      await net.whenSettled();
      expect(refits).toBeGreaterThanOrEqual(3);
      expect(net.lodSource).toBe("main"); // the worker's tree, now refit on the main thread
    } finally {
      net.destroy();
    }
  });
});
