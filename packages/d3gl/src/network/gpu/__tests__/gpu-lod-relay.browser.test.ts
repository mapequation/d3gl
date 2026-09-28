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
 * - **The spatial source** (#343): the same worker rebuilds the Morton tree for every relayed frame with the
 *   worker backend's per-frame step (`lodFrameStep`), and each repaint paints positions with the tree rebuilt
 *   for exactly them. The engine adopts each one in O(1), so while the GPU streams — and through a drag, its
 *   re-cool and pan/zoom — the main thread builds no spatial tree (`mortonTopologyBuilds`, a live counter a
 *   real worker's builds never touch) and aggregates no style (`lodStylePasses`); the frontier stays the
 *   spatial one; the rebuilds stop at convergence; a selected aggregate is carried over to its cell.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { startGpuLayout } from "../gpu-transport.js";
import { GpuStream, observeGpuLayoutFrames } from "../gpu-stream.js";
import { network, type Network, type NetworkHit } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import {
  buildLODTree,
  buildMortonLODTree,
  computeLODPositions,
  lodStylePasses,
  lodTreeFromTopology,
  mortonTopologyBuilds,
  type LODTree,
} from "../../lod.js";
import type { StreamedLODTree } from "../../worker-transport.js";
import type { HoverHit } from "../../../map/base-engine.js";
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
  it("no LOD worker can start (a page that blocks workers): one warning, the tree withdrawn, the run goes on from its disc", async () => {
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
      // One warning for the one cause, naming both consequences: no second worker is tried for the seed (#353).
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("no LOD worker could start");
      expect(String(warn.mock.calls[0]?.[0])).toContain("multilevel seed");
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

  it("the same on layout({ backend: 'auto' }) (#375): lod() after an earlier auto layout builds no tree", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      net.data(clustered(500, 1)).layout({ backend: "auto", iterations: 5 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      net.data(clustered(3000, 3)).style({ sizeMode: "screen" }).lod({ expandPx: 48 });
      expect(net.lodSource).toBe("none"); // the next auto layout streams the tree from a worker, either way
      net.layout({ backend: "auto", iterations: 60 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      expect(net.lodSource).toBe("worker");
      const types = posts.mock.calls.map((c: [MainToWorker, ...unknown[]]) => c[0].type);
      expect(types.filter((t) => t === "coarsen")).toHaveLength(1);
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

// ── The spatial source (#343) ──────────────────────────────────────────────

/** Communities joined by random long-range links — a force layout spreads each community out. */
function webLike(n: number, seed = 5): NetworkGraph {
  const rng = makePrng(seed);
  const source: number[] = [];
  const target: number[] = [];
  const size = 40;
  for (let i = 1; i < n; i++) {
    const base = i - (i % size);
    source.push(i);
    target.push(base + Math.floor(rng() * (i - base)));
    if (rng() < 0.6) {
      source.push(i);
      target.push(Math.floor(rng() * n));
    }
  }
  return buildGraph({ nodeCount: n, source, target });
}

/** How far a spatial `tree` is from the Morton tree a main-thread build makes at `positions` in its box (0 = bitwise). */
function spatialError(tree: LODTree, positions: Float32Array): number {
  const box = tree.morton?.box;
  if (!box) return Infinity;
  const reference = buildMortonLODTree(positions, tree.leafCount, { box });
  if (reference.size !== tree.size) return Infinity;
  computeLODPositions(reference, positions);
  return Math.max(maxDiff(reference.cx, tree.cx), maxDiff(reference.cy, tree.cy), maxDiff(reference.extent, tree.extent));
}

/** The first screen point, on a grid over the host, where the pointer hovers a glyph (`hover` on). */
function glyphPoint(net: Network, host: HTMLElement): [number, number] | null {
  let at: [number, number] | null = null;
  let point: [number, number] = [0, 0];
  net.on("hover", (hit) => {
    if (!at && hit) at = point;
  });
  const rect = host.getBoundingClientRect();
  for (let y = 10; y < H - 10 && !at; y += 5) {
    for (let x = 10; x < W - 10 && !at; x += 5) {
      point = [x, y];
      host.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1 }));
    }
  }
  net.on("hover", () => {});
  return at;
}

/** Grab the first glyph under a grid of screen points, drag it `frames` frames, and release it. */
async function dragGlyph(net: Network, host: HTMLElement, frames: number): Promise<void> {
  const at = glyphPoint(net, host);
  if (!at) throw new Error("no glyph to drag");
  const [x0, y0] = at;
  const rect = host.getBoundingClientRect();
  const pointer = (type: string, x: number, y: number): void => {
    host.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, button: 0, pointerId: 1 }));
  };
  pointer("pointerdown", x0, y0);
  pointer("pointermove", x0 + 8, y0); // past the click slop: the drag session starts
  for (let f = 1; f <= frames; f++) {
    pointer("pointermove", x0 + 8 + 3 * f, y0 + 2 * f);
    await nextFrame();
  }
  pointer("pointerup", x0 + 8 + 3 * frames, y0 + 2 * frames);
}

/** Hover a grid of screen points until the pointer is over an aggregate glyph of more than 2 nodes; its hit. */
function findAggregate(net: Network, host: HTMLElement): HoverHit | null {
  let found: HoverHit | null = null;
  net.on("hover", (hit) => {
    const d = hit?.datum as NetworkHit | undefined;
    if (!found && hit && d && "aggregate" in d && d.aggregate && d.count > 2) found = hit;
  });
  const rect = host.getBoundingClientRect();
  for (let y = 10; y < H - 10 && !found; y += 7) {
    for (let x = 10; x < W - 10 && !found; x += 7) {
      host.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1 }));
    }
  }
  net.on("hover", () => {});
  return found;
}

describe("GPU layout LOD relay — the spatial source (#343)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("each repaint paints positions with the spatial tree the worker rebuilt for exactly them; the rebuilds stop at convergence", async () => {
    const g = clustered(4000, 21);
    const n = g.nodeCount;
    const lodStyle = { radii: new Float32Array(n).fill(2), weight: new Float32Array(n).fill(1) };
    /** The tree the last frame painted, with its handle (a holder: the callbacks below assign it). */
    const latest: { current: { tree: LODTree; streamed: StreamedLODTree } | null } = { current: null };
    const withdrawn: number[] = [];
    const frames: number[] = [];
    const errors: number[] = [];
    let moved = 0;
    let previous: Float32Array | null = null;
    let settled = false;
    let framesAfter = 0;
    let relayedAfter = 0;
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if (settled && isRefit(args[0])) relayedAfter++;
      Reflect.apply(post, this, args);
    });
    let lastFrameAt = performance.now();
    const unobserve = observeGpuLayoutFrames(() => {
      lastFrameAt = performance.now();
    });
    const handle = startGpuLayout(
      device,
      g,
      { width: W, height: H, iterations: 80, lod: true, lodSource: "spatial", lodStyle, lodStyleVersion: 1 },
      () => {
        if (settled) framesAfter++;
        const current = latest.current;
        if (!current) return; // before the first tree: nothing to compare
        errors.push(spatialError(current.tree, g.positions));
        if (previous && maxDiff(previous, g.positions) > 0) moved++;
        previous = g.positions.slice();
      },
      (tree, streamed) => {
        if (!tree || !streamed) {
          withdrawn.push(1);
          return;
        }
        const replaced = latest.current;
        latest.current = { tree, streamed };
        frames.push(streamed.header.frame);
        replaced?.streamed.release(); // as the engine does once no repaint draws it
      },
    );
    try {
      await handle.settled;
      settled = true;
      expect(handle.transport).toBe("gpu");
      expect(withdrawn).toEqual([]);
      expect(frames.length, "no spatial tree came with the frames").toBeGreaterThan(3);
      expect(frames.every((f, i) => i === 0 || f > (frames[i - 1] ?? Infinity)), `frame ids ${frames.join(", ")}`).toBe(true);
      expect(errors.length).toBeGreaterThan(3);
      expect(Math.max(...errors), "a repaint painted a spatial tree that is not the positions'").toBe(0);
      expect(moved, "the positions did not move between repaints").toBeGreaterThan(2);
      // Converged: nothing more is relayed, rebuilt or painted after settled.
      const t0 = performance.now();
      while (performance.now() - lastFrameAt < 400 && performance.now() - t0 < 10_000) await sleep(50);
      expect(framesAfter, "repaints after settled").toBe(0);
      expect(relayedAfter, "relayed frames after settled").toBe(0);
      const settledTree = latest.current;
      if (!settledTree) throw new Error("no tree");
      expect(spatialError(settledTree.tree, g.positions)).toBe(0);
    } finally {
      unobserve();
      handle.stop();
    }
  });
});

describe("GPU layout LOD relay — the spatial source (#343), engine", () => {
  it("builds no spatial tree and aggregates no style on the main thread while the GPU streams, through a drag and pan/zoom", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      net.interactive({ draggable: true, hover: true });
      net.data(webLike(6000)).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 });
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      const builds0 = mortonTopologyBuilds;
      const styles0 = lodStylePasses;
      const painted: string[] = [];
      const unobserve = observeGpuLayoutFrames((s) => {
        if (s.repainted) painted.push(net.lodSource);
      });
      try {
        net.layout({ backend: "gpu", iterations: 80, fit: true });
        await net.whenSettled();
        expect(net.layoutTransport).toBe("gpu");
        expect(net.lodSource).toBe("worker"); // the relay's spatial tree, adopted
        expect(painted.filter((p) => p === "worker").length, "no repaint drew the relay's tree").toBeGreaterThan(3);
        expect(mortonTopologyBuilds - builds0, "main-thread spatial tree builds while the GPU streamed").toBe(0);
        expect(lodStylePasses - styles0, "main-thread style passes while the GPU streamed").toBe(0);
        // The frontier is the spatial one: its links come from the lazy gather (a spatial tree has no
        // super-edge CSR), and its glyphs are bounded by the screen.
        expect(net.superEdgeStats).not.toBeNull();
        expect(net.declutterStats?.glyphs ?? Infinity).toBeLessThan(1500);
        // One coarsen-only worker streams it (no layout worker), rebuilt per relayed frame, buffers handed back.
        const types = posts.mock.calls.map((c: [MainToWorker, ...unknown[]]) => c[0].type);
        const coarsen = posts.mock.calls.map((c: [MainToWorker, ...unknown[]]) => c[0]).filter((m) => m.type === "coarsen");
        expect(coarsen).toHaveLength(1);
        expect(coarsen[0]?.type === "coarsen" && coarsen[0].lodSource).toBe("spatial");
        expect(types.filter((t) => t === "start")).toHaveLength(0);
        expect(types.filter((t) => t === "lod-geometry").length).toBeGreaterThan(3);
        expect(types.filter((t) => t === "lod-recycle").length).toBeGreaterThan(0);

        // A drag reheats the layout: its frames are relayed and rebuilt in the worker too.
        const relayed = types.filter((t) => t === "lod-geometry").length;
        const pins = vi.spyOn(GpuStream.prototype, "pin");
        await dragGlyph(net, host, 16);
        expect(pins.mock.calls.length, "the drag held no node").toBeGreaterThan(0);
        for (let f = 0; f < 30; f++) await nextFrame();
        const after = posts.mock.calls.filter((c: [MainToWorker, ...unknown[]]) => c[0].type === "lod-geometry").length;
        expect(after, "the drag's frames were not relayed").toBeGreaterThan(relayed);
        // Pan and zoom re-cut the adopted tree.
        net.setTransform({ k: 3, x: -200, y: -150 });
        await nextFrame();
        net.setTransform({ k: 0.8, x: 40, y: 30 });
        await nextFrame();
        expect(net.lodSource).toBe("worker");
        expect(mortonTopologyBuilds - builds0, "main-thread spatial tree builds through the drag and pan/zoom").toBe(0);
        expect(lodStylePasses - styles0, "main-thread style passes through the drag and pan/zoom").toBe(0);
      } finally {
        unobserve();
      }
    } finally {
      net.destroy();
    }
  });

  it("carries a selected aggregate over to the same cell while the relay rebuilds the tree", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      const g = webLike(8000, 9);
      net.interactive({ selectable: true, hover: true });
      net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "gpu", iterations: 300 });
      for (let i = 0; i < 400 && net.lodSource !== "worker"; i++) await sleep(10);
      expect(net.lodSource).toBe("worker");
      let hit = findAggregate(net, host);
      for (let i = 0; i < 20 && !hit; i++) {
        await sleep(20);
        hit = findAggregate(net, host);
      }
      if (!hit) throw new Error("no aggregate under the pointer");
      net.select("nodes", [hit.id]);
      const members0 = net.selection()[0]?.members?.() ?? [];
      expect(members0.length).toBeGreaterThan(2);
      const centre = (members: readonly (string | number)[]): [number, number] => {
        let x = 0;
        let y = 0;
        for (const m of members) {
          x += g.positions[2 * Number(m)] ?? 0;
          y += g.positions[2 * Number(m) + 1] ?? 0;
        }
        return [x / members.length, y / members.length];
      };
      const c0 = centre(members0);
      let span = 1;
      for (const m of members0) span = Math.max(span, Math.abs((g.positions[2 * Number(m)] ?? 0) - c0[0]), Math.abs((g.positions[2 * Number(m) + 1] ?? 0) - c0[1]));
      let repaints = 0;
      const unobserve = observeGpuLayoutFrames((s) => {
        if (s.repainted) repaints++;
      });
      await net.whenSettled();
      unobserve();
      expect(repaints, "no rebuilt tree was painted while selected").toBeGreaterThan(0);
      const after = net.selection();
      // The cell may have emptied as the layout moved nodes (then it is dropped); if kept, it is the same place.
      if (after.length > 0) {
        expect(after).toHaveLength(1);
        const d = after[0]?.datum as NetworkHit | undefined;
        const members1 = after[0]?.members?.() ?? [];
        expect(members1.length).toBe(d && "count" in d ? d.count : -1);
        const c1 = centre(members1);
        expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeLessThan(4 * span + 50);
      }
    } finally {
      net.destroy();
    }
  });

  it("an edge-less graph's spatial tree streams from the relay too", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      net.data(buildGraph({ nodeCount: 3000, source: [], target: [] })).lod({ maxAggregateRadius: 18 });
      const builds0 = mortonTopologyBuilds; // (a first lod() builds its tree at once: #373 defers it)
      net.layout({ backend: "gpu", iterations: 40 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      expect(net.lodSource).toBe("worker");
      expect(mortonTopologyBuilds - builds0).toBe(0);
    } finally {
      net.destroy();
    }
  });

  it("style() mid-run sends the relay its new style; the trees after it carry it, with no main-thread re-aggregation per frame", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    try {
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      net.data(webLike(4000, 3)).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "gpu", iterations: 200 });
      for (let i = 0; i < 400 && net.lodSource !== "worker"; i++) await sleep(10);
      expect(net.lodSource).toBe("worker");
      const styles0 = lodStylePasses;
      net.style({ sizeMode: "screen", nodeRadius: 5 });
      await net.whenSettled();
      expect(posts.mock.calls.filter((c: [MainToWorker, ...unknown[]]) => c[0].type === "lod-style")).toHaveLength(1);
      // Re-aggregated here: at most the tree drawn when the style changed and the one frame the worker was
      // building then (the relay has one out at a time); the worker's later trees carry the new style.
      expect(lodStylePasses - styles0).toBeLessThanOrEqual(2);
      expect(net.lodSource).toBe("worker");
    } finally {
      net.destroy();
    }
  });
});
