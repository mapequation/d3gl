/**
 * #201 — `backend: "auto"` must not block the main thread on the placeholder canvas.
 *
 * In `"auto"` mode a Canvas2D backend is installed synchronously (instant first paint) and
 * replaced by WebGL as soon as the device resolves. The network's Scene path and Plot's
 * decluttered-points fallback exist ONLY because a vector backend has no instanced lane, so
 * while the upgrade is in flight they tessellate + paint geometry the incoming WebGL backend
 * discards immediately. At 12,957 nodes / 610,954 edges that was ~9.5 s of main-thread block per
 * rebuild and ~19 s in total before the first WebGL frame.
 *
 * The regression has an exact, scale-free signature, so that is the primary assertion here:
 * **the placeholder canvas is handed ZERO drawables** for a large input. The wall-clock ceiling is
 * secondary — and deliberately constant in N, because the withheld path is O(1) in node/edge count
 * (`clearNetworkScene` is O(layers), the Scene build never runs). A non-vacuity leg pins the other
 * half of the contract: a SMALL input still paints on the placeholder instantly, which is the whole
 * reason `"auto"` exists.
 */
import { describe, it, expect, vi } from "vitest";
import { network, Network } from "../network/network.js";
import { buildGraph, type NetworkGraph } from "../network/graph.js";
import { plot } from "./plot.js";
import { CanvasBackend } from "../canvas/canvas-backend.js";
import type { RenderLayer, RenderDelta } from "../core/index.js";
import type { BackendHandle } from "./backend-factory.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

const W = 800;
const H = 600;

/** Large fixture: the tier's N (CI 100k) or the local default; capped at the reported graph's size. */
const BIG_EDGES = perfN(200_000, { max: 610_954 });
const BIG_NODES = Math.max(1000, Math.round(BIG_EDGES / 47)); // the reported graph's edge:node ratio
/** Small fixture — deliberately NOT scaled: it must stay under the placeholder budget. */
const SMALL_NODES = 200;
const SMALL_EDGES = 800;

/**
 * Worst tolerated wall-clock for any single `data()`/`style()`/`layout()` call while the
 * placeholder is live. Constant, not `c0 + c1 * N`: withholding makes the call O(1) in edge count
 * (measured 0.2-0.3 ms at 611k edges), so a term that grows with N would only mask the regression.
 * Pre-fix the same call cost ~2.8 s at 200k edges and ~6 s at 611k.
 */
const CALL_BUDGET_MS = perfBudget(100);

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

function makeGraph(nodes: number, edges: number): { graph: NetworkGraph; positions: Float32Array } {
  const source = new Uint32Array(edges);
  const target = new Uint32Array(edges);
  let s = 12345;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let e = 0; e < edges; e++) {
    source[e] = Math.floor(rnd() * nodes);
    target[e] = Math.floor(rnd() * nodes);
  }
  const positions = new Float32Array(nodes * 2);
  for (let i = 0; i < nodes; i++) {
    positions[2 * i] = rnd() * W;
    positions[2 * i + 1] = rnd() * H;
  }
  return { graph: buildGraph({ nodeCount: nodes, source, target, directed: true }), positions };
}

/**
 * Count every drawable handed to ANY CanvasBackend instance. These three methods are the only
 * ways geometry reaches it, and it renders exactly what it was given — so a zero count is proof
 * that no full-detail emission (and hence no `drawShapes` over it) happened. Patching the
 * prototype rather than spying an instance catches the placeholder created inside the engine
 * constructor, before a test can reach it.
 */
function watchCanvas(): { drawables: () => number; restore: () => void } {
  let n = 0;
  const setLayers = CanvasBackend.prototype.setLayers;
  const updateLayer = CanvasBackend.prototype.updateLayer;
  const appendToLayer = CanvasBackend.prototype.appendToLayer;
  CanvasBackend.prototype.setLayers = function (this: CanvasBackend, layers: RenderLayer[]): void {
    for (const l of layers) n += l.drawables.length;
    setLayers.call(this, layers);
  };
  CanvasBackend.prototype.updateLayer = function (this: CanvasBackend, name: string, layer: RenderLayer): void {
    n += layer.drawables.length;
    updateLayer.call(this, name, layer);
  };
  CanvasBackend.prototype.appendToLayer = function (this: CanvasBackend, delta: RenderDelta): void {
    n += delta.drawables.length;
    appendToLayer.call(this, delta);
  };
  return {
    drawables: () => n,
    restore: () => {
      CanvasBackend.prototype.setLayers = setLayers;
      CanvasBackend.prototype.updateLayer = updateLayer;
      CanvasBackend.prototype.appendToLayer = appendToLayer;
    },
  };
}

/** A WebGL-backed surface yields a webgl2 context; the Canvas2D placeholder does not. */
const isWebGLCanvas = (h: HTMLElement): boolean => {
  const c = h.querySelector("canvas");
  if (!c) return false;
  try { return !!c.getContext("webgl2"); } catch { return false; }
};

/** Poll until `ok()`, so the tests never reach for the engine's private upgrade promise. */
async function until(ok: () => boolean, timeoutMs = 60_000): Promise<void> {
  const t0 = performance.now();
  while (!ok()) {
    if (performance.now() - t0 > timeoutMs) throw new Error("timed out waiting for the auto upgrade");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Non-transparent pixel count of the engine's own PNG export — "something is actually drawn". */
async function paintedPixels(png: string): Promise<number> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not decode the exported PNG"));
    img.src = png;
  });
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2D context for the PNG check");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++;
  return painted;
}

describe(`backend "auto" placeholder (#201) — ${BIG_NODES} nodes / ${BIG_EDGES} edges`, () => {
  it("withholds the full-detail emission from the placeholder canvas (LOD off)", async () => {
    const { graph, positions } = makeGraph(BIG_NODES, BIG_EDGES);
    const watch = watchCanvas();
    const h = host();
    try {
      const net = network(h, { width: W, height: H, backend: "auto" });
      const worst = { ms: 0, call: "" };
      const timed = (call: string, fn: () => void): void => {
        const t = performance.now();
        fn();
        const dt = performance.now() - t;
        if (dt > worst.ms) { worst.ms = dt; worst.call = call; }
      };
      timed("data", () => void net.data(graph));
      timed("style", () => void net.style({ directed: true, nodeRadius: 3 }));
      timed("layout", () => void net.layout({ backend: "positions", positions }));

      // Deterministic signature: nothing was ever handed to the placeholder.
      expect(watch.drawables()).toBe(0);
      // Wall-clock: each call stays O(1) in edge count.
      expect(worst.ms, `${worst.call}() took ${worst.ms.toFixed(1)}ms at ${BIG_EDGES.toLocaleString()} edges`).toBeLessThan(CALL_BUDGET_MS);

      await until(() => isWebGLCanvas(h));
      // …and it stays zero across the upgrade: the placeholder is replaced, never drawn into.
      expect(watch.drawables()).toBe(0);
      // The graph really is on screen once WebGL lands (the withheld emission was not lost).
      expect(await paintedPixels(net.toPNG())).toBeGreaterThan(0);
      net.destroy();
    } finally {
      watch.restore();
      h.remove();
    }
  }, 240_000);

  it("withholds it with LOD on too (reductions on)", async () => {
    const { graph, positions } = makeGraph(BIG_NODES, BIG_EDGES);
    const watch = watchCanvas();
    const h = host();
    try {
      const net = network(h, { width: W, height: H, backend: "auto" });
      net.data(graph).style({ directed: true, nodeRadius: 3 }).lod({ maxAggregateRadius: 40 });
      net.layout({ backend: "positions", positions });
      expect(watch.drawables()).toBe(0);
      await until(() => isWebGLCanvas(h));
      expect(watch.drawables()).toBe(0);
      expect(await paintedPixels(net.toPNG())).toBeGreaterThan(0);
      net.destroy();
    } finally {
      watch.restore();
      h.remove();
    }
  }, 240_000);

  it("still paints a SMALL graph on the placeholder immediately (non-vacuity)", async () => {
    const { graph, positions } = makeGraph(SMALL_NODES, SMALL_EDGES);
    const watch = watchCanvas();
    const h = host();
    try {
      const net = network(h, { width: W, height: H, backend: "auto" });
      net.data(graph).style({ directed: true, nodeRadius: 3 });
      net.layout({ backend: "positions", positions });
      // The whole point of "auto": below the budget the placeholder draws the graph before the
      // WebGL device exists. If this ever hits 0 the guard above has become vacuous.
      expect(watch.drawables()).toBeGreaterThan(SMALL_NODES);
      expect(isWebGLCanvas(h)).toBe(false); // still on the placeholder at this point
      await until(() => isWebGLCanvas(h));
      net.destroy();
    } finally {
      watch.restore();
      h.remove();
    }
  }, 120_000);

  it("withholds a large decluttered plot points layer from the placeholder", async () => {
    const n = perfN(200_000, { max: 1_000_000 });
    const pts = Array.from({ length: n }, (_, i) => ({ x: (i * 37) % W, y: (i * 71) % H }));
    const watch = watchCanvas();
    const h = host();
    try {
      const p = plot(h, { width: W, height: H, backend: "auto" });
      const t = performance.now();
      p.points("pts", pts, { x: (d) => d.x, y: (d) => d.y, radius: 2, fill: "#3366cc", declutter: 4 });
      const dt = performance.now() - t;
      expect(watch.drawables()).toBe(0);
      expect(dt, `points() took ${dt.toFixed(1)}ms at ${n.toLocaleString()} points`).toBeLessThan(CALL_BUDGET_MS);
      await until(() => isWebGLCanvas(h));
      expect(watch.drawables()).toBe(0);
      expect(await paintedPixels(p.toPNG())).toBeGreaterThan(0);
      p.destroy();
    } finally {
      watch.restore();
      h.remove();
    }
  }, 240_000);
});

describe("backend \"auto\" placeholder — WebGL unavailable", () => {
  /** Rejects the upgrade through the engine's own seam, with no spying on privates. */
  class NoWebGLNetwork extends Network {
    protected override createWebGLBackend(): Promise<BackendHandle> {
      return Promise.reject(new Error("no webgl2"));
    }
  }

  it("falls back to a canvas that actually has the content drawn on it", async () => {
    // Above the placeholder budget (so the emission IS withheld) but small enough that the
    // fallback's real Canvas2D emission stays quick — this leg is about correctness, not scale.
    const { graph, positions } = makeGraph(2_000, 30_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watch = watchCanvas();
    const h = host();
    try {
      const net = new NoWebGLNetwork(h, { width: W, height: H, backend: "auto" });
      net.data(graph).style({ directed: true, nodeRadius: 3 });
      net.layout({ backend: "positions", positions });
      expect(watch.drawables()).toBe(0); // withheld while the upgrade is in flight

      // The upgrade fails ⇒ canvas is the FINAL backend ⇒ the engine must emit for real.
      await until(() => watch.drawables() > 0);
      expect(isWebGLCanvas(h)).toBe(false);
      expect(warn).toHaveBeenCalled();
      expect(await paintedPixels(net.toPNG())).toBeGreaterThan(0);
      net.destroy();
    } finally {
      watch.restore();
      warn.mockRestore();
      h.remove();
    }
  }, 120_000);
});
