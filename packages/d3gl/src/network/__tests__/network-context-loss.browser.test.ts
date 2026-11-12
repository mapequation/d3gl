/**
 * A lost WebGL context (#599): the render backend stops cleanly — no luma.gl shader-error overlay, no uncaught
 * error — and when the browser gives the context back, the engine redraws the same layout, camera and selection
 * on a fresh WebGL backend (the backend-swap path). If it does not come back, `onContextUnrestored` fires once.
 * The loss is driven with `WEBGL_lose_context`, during a network layout, as Chrome's GPU-process reset did.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import { Plot, type PlotOptions } from "../../map/plot.js";
import { gpuCaps, deviceReadsRG } from "../gpu/device-probe.js";
import type { PathContext, ViewTransform } from "../../core/index.js";

const W = 400;
const H = 300;

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
});

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Wait (in animation frames) until `done()` holds; fails the test after `frames` frames. */
async function until(done: () => boolean, what: string, frames = 600): Promise<void> {
  for (let i = 0; i < frames && !done(); i++) await nextFrame();
  expect(done(), `timed out waiting for ${what}`).toBe(true);
}

/** A ring with deterministic chords, big enough that a layout is still running when the context goes. */
function clustered(n: number, directed = false): NetworkGraph {
  let s = 99 >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push((i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  return buildGraph({ nodeCount: n, source, target, directed });
}

class Probe extends Network {
  constructor(host: HTMLElement, opts: NetworkOptions, private readonly restoreWaitMs = 60_000) {
    super(host, opts);
  }
  protected override contextRestoreWaitMs(): number { return this.restoreWaitMs; }
  /** The engine's live view transform (what is drawn). */
  viewTransform(): ViewTransform { return { ...this.transform }; }
  /** The live WebGL backend's screen pixel at CSS px (x, y), or null on another backend. */
  screenPixel(x: number, y: number): number[] | null {
    const b = this.backend();
    return b instanceof WebGLBackend ? b.readScreenPixel(x, y) : null;
  }
}

/** Uncaught errors and unhandled rejections from now on, and luma.gl's shader-error overlay. */
function watchErrors(): { errors: string[]; overlay: () => boolean; dispose: () => void } {
  const errors: string[] = [];
  const onError = (e: ErrorEvent): void => { errors.push(String(e.message)); };
  const onRejection = (e: PromiseRejectionEvent): void => { errors.push(String(e.reason)); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const overlay = (): boolean =>
    [...document.body.querySelectorAll("h1")].some((h) => (h.textContent ?? "").includes("Compilation error"));
  return {
    errors,
    overlay,
    dispose: () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    },
  };
}

function loseExtension(canvas: HTMLCanvasElement | null): WEBGL_lose_context {
  const gl = canvas?.getContext("webgl2") ?? null; // the context the engine already holds
  const ext = gl?.getExtension("WEBGL_lose_context") ?? null;
  if (!ext) throw new Error("WEBGL_lose_context unavailable");
  return ext;
}

/** The screen position (CSS px) of node `i` under `t`. */
function screenOf(graph: NetworkGraph, i: number, t: ViewTransform): [number, number] {
  return [(graph.positions[2 * i] ?? Number.NaN) * t.k + t.x, (graph.positions[2 * i + 1] ?? Number.NaN) * t.k + t.y];
}

/** Indices of the nodes inside the view (a margin from the edges), up to `max`. */
function visibleNodes(graph: NetworkGraph, t: ViewTransform, max: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < graph.nodeCount && out.length < max; i++) {
    const [x, y] = screenOf(graph, i, t);
    if (x > 20 && x < W - 20 && y > 20 && y < H - 20) out.push(i);
  }
  return out;
}

describe("a lost WebGL context (#599)", () => {
  it("stops cleanly during a layout and redraws the same layout, camera and selection when it is restored", async () => {
    const watch = watchErrors();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reports: number[] = [];
    const host = makeHost();
    const net = new Probe(host, { width: W, height: H, backend: "webgl", onContextUnrestored: () => reports.push(1) });
    try {
      await net.whenReady();
      const graph = clustered(2000);
      net.data(graph).layout({ backend: "gpu", iterations: 600 });
      const settled = net.whenSettled();
      for (let i = 0; i < 5; i++) await nextFrame(); // a few layout frames: the loss lands mid-run
      net.interactive({ selectable: { multi: true } });
      net.setTransform({ k: 1.2, x: 30, y: -10 });

      const oldCanvas = host.querySelector("canvas");
      const lose = loseExtension(oldCanvas);
      lose.loseContext();
      await settled; // the layout continues (on the worker) and settles while the context is lost
      for (let i = 0; i < 10; i++) await nextFrame();
      // While lost, the camera moves and a selection adds its ring lane: nothing is drawn or built, nothing throws.
      net.select("nodes", [0, 1, 2]);
      net.setTransform({ k: 1.5, x: 20, y: -30 });
      for (let i = 0; i < 5; i++) await nextFrame();
      expect(watch.errors).toEqual([]);
      expect(watch.overlay()).toBe(false);

      const transform = net.viewTransform();
      const selected = net.selection().map((h) => h.id).sort();
      const positions = Float64Array.from(graph.positions);
      const exported = net.toSVG();
      expect(selected).toEqual([0, 1, 2]);

      lose.restoreContext();
      await until(() => host.querySelector("canvas") !== oldCanvas, "the redraw on a new canvas");
      await net.whenReady();
      for (let i = 0; i < 5; i++) await nextFrame();

      const canvases = host.querySelectorAll("canvas");
      expect(canvases).toHaveLength(1);
      expect(watch.errors).toEqual([]);
      expect(watch.overlay()).toBe(false);
      expect(net.viewTransform()).toEqual(transform);
      expect(net.selection().map((h) => h.id).sort()).toEqual(selected);
      expect(Float64Array.from(graph.positions)).toEqual(positions);
      expect(net.toSVG()).toBe(exported);
      // The new backend draws: each visible node's centre is painted.
      const visible = visibleNodes(graph, transform, 20);
      expect(visible.length).toBeGreaterThan(0);
      for (const i of visible) {
        const [x, y] = screenOf(graph, i, transform);
        expect(net.screenPixel(x, y)?.[3], `node ${i} at (${x.toFixed(1)}, ${y.toFixed(1)})`).toBeGreaterThan(0);
      }
      expect(reports).toEqual([]); // it came back: nothing to report
      // The GPU layout's own loss handling still warns once (#311).
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("context was lost"))).toHaveLength(1);
    } finally {
      watch.dispose();
      net.destroy();
    }
  });

  it("reports once, and throws nothing, when the context does not come back", async () => {
    const watch = watchErrors();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reports: number[] = [];
    const host = makeHost();
    const net = new Probe(host, { width: W, height: H, backend: "webgl", onContextUnrestored: () => reports.push(1) }, 50);
    try {
      await net.whenReady();
      const graph = clustered(500);
      net.data(graph).layout({ backend: "gpu", iterations: 300 });
      for (let i = 0; i < 3; i++) await nextFrame();

      loseExtension(host.querySelector("canvas")).loseContext();
      for (let i = 0; i < 3; i++) await nextFrame();
      // Keep using the engine while the context is gone: new data whose arrows need programs not built yet,
      // a new layout (no probe on the lost device), a camera move, a selection, an export.
      net.data(clustered(300, true)).layout({ backend: "gpu", iterations: 50 });
      await net.whenSettled();
      net.interactive({ selectable: true });
      net.setTransform({ k: 2, x: 0, y: 0 });
      net.select("nodes", [3]);
      expect(net.toSVG()).toContain("<svg");
      for (let i = 0; i < 5; i++) await nextFrame();
      expect(watch.errors).toEqual([]);
      expect(watch.overlay()).toBe(false);

      await until(() => reports.length > 0, "the report");
      await new Promise((resolve) => setTimeout(resolve, 200)); // several report waits
      for (let i = 0; i < 5; i++) await nextFrame();

      expect(reports).toHaveLength(1);
      expect(watch.errors).toEqual([]);
      expect(watch.overlay()).toBe(false);
      expect(host.querySelectorAll("canvas")).toHaveLength(1);
    } finally {
      watch.dispose();
      net.destroy();
    }
    expect(watch.errors).toEqual([]);
  });
});

class PlotProbe extends Plot {
  constructor(host: HTMLElement, opts: PlotOptions, private readonly restoreWaitMs = 60_000) {
    super(host, opts);
  }
  protected override contextRestoreWaitMs(): number { return this.restoreWaitMs; }
  /** The live WebGL backend's screen pixel at CSS px (x, y), or null on another backend. */
  screenPixel(x: number, y: number): number[] | null {
    const b = this.backend();
    return b instanceof WebGLBackend ? b.readScreenPixel(x, y) : null;
  }
}

/** A filled axis-aligned square, centred on (cx, cy). */
function square(cx: number, cy: number, r: number): (ctx: PathContext) => void {
  return (ctx) => {
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy - r);
    ctx.lineTo(cx + r, cy + r);
    ctx.lineTo(cx - r, cy + r);
    ctx.closePath();
  };
}

/** A WebGL plot with one square layer, its canvas, and the canvas's lose-context extension. */
async function lostPlot(
  host: HTMLElement,
  opts: PlotOptions,
  waitMs?: number,
): Promise<{ chart: PlotProbe; canvas: HTMLCanvasElement; lose: WEBGL_lose_context }> {
  const chart = new PlotProbe(host, { width: W, height: H, backend: "webgl", ...opts }, waitMs);
  await chart.whenReady();
  chart.layer("a", [0], { draw: square(100, 100, 30), fill: "#ff0000", id: () => "a0" });
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  const lose = loseExtension(canvas);
  await loseNow(canvas, lose);
  return { chart, canvas, lose };
}

/** Lose `canvas`'s context and wait for the (queued) loss event, so the backend has seen it. */
async function loseNow(canvas: HTMLCanvasElement, lose: WEBGL_lose_context): Promise<void> {
  const seen = new Promise((resolve) => canvas.addEventListener("webglcontextlost", resolve, { once: true }));
  lose.loseContext();
  await seen;
}

/**
 * Give `canvas`'s lost context back. Chrome refuses a `restoreContext()` that comes right after the loss
 * (INVALID_OPERATION, nothing restored), so retry until it is taken.
 */
async function restoreNow(canvas: HTMLCanvasElement, lose: WEBGL_lose_context): Promise<void> {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("no WebGL2 context");
  for (let i = 0; i < 100; i++) {
    gl.getError(); // clear CONTEXT_LOST_WEBGL
    lose.restoreContext();
    if (gl.getError() !== gl.INVALID_OPERATION) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("restoreContext() was refused");
}

/** The fills of an SVG export's paths, in order. */
function fills(svg: string): string[] {
  return [...svg.matchAll(/<path[^>]* fill="([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("an engine whose WebGL context is lost (#599)", () => {
  it("keeps toSVG() current through a data and a style change made while lost, and redraws them on restore", async () => {
    const watch = watchErrors();
    const host = makeHost();
    const { chart, canvas, lose } = await lostPlot(host, {});
    try {
      chart.layer("b", [0], { draw: square(250, 150, 20), fill: "#00ff00", id: () => "b0" }); // data while lost
      chart.setStyle("a", "a0", { fill: "#0000ff" }); // style while lost
      const svg = chart.toSVG();
      expect(fills(svg)).toEqual(["rgba(0, 0, 255, 1.0000)", "rgba(0, 255, 0, 1.0000)"]);

      await restoreNow(canvas, lose);
      await until(() => host.querySelector("canvas") !== canvas, "the redraw on a new canvas");
      await chart.whenReady();
      expect(chart.toSVG()).toBe(svg);
      expect(chart.screenPixel(250, 150)?.slice(0, 3)).toEqual([0, 255, 0]);
      expect(chart.screenPixel(100, 100)?.slice(0, 3)).toEqual([0, 0, 255]);
      expect(watch.errors).toEqual([]);
    } finally {
      watch.dispose();
      chart.destroy();
    }
  });

  it("throws a clear error from toPNG() while lost, and exports again once restored", async () => {
    const host = makeHost();
    const { chart, canvas, lose } = await lostPlot(host, {});
    try {
      expect(() => chart.toPNG()).toThrow(/WebGL context is lost/);
      await restoreNow(canvas, lose);
      await until(() => host.querySelector("canvas") !== canvas, "the redraw on a new canvas");
      await chart.whenReady();
      expect(chart.toPNG()).toMatch(/^data:image\/png/);
    } finally {
      chart.destroy();
    }
  });

  it("rebuilds on setBackend(\"webgl\") while lost, without waiting for the browser", async () => {
    const reports: number[] = [];
    const host = makeHost();
    const { chart, canvas } = await lostPlot(host, { onContextUnrestored: () => reports.push(1) }, 100);
    try {
      chart.setBackend("webgl");
      await chart.whenReady();
      expect(host.querySelector("canvas")).not.toBe(canvas);
      expect(host.querySelectorAll("canvas")).toHaveLength(1);
      expect(chart.screenPixel(100, 100)?.slice(0, 3)).toEqual([255, 0, 0]);
      await new Promise((resolve) => setTimeout(resolve, 250)); // past the (cleared) wait
      expect(reports).toEqual([]);
    } finally {
      chart.destroy();
    }
  });

  it("switches to Canvas from onContextUnrestored", async () => {
    const watch = watchErrors();
    const host = makeHost();
    let chart: PlotProbe | null = null;
    const switched = { done: false };
    const lost = await lostPlot(host, {
      onContextUnrestored: () => {
        chart?.setBackend("canvas");
        void chart?.whenReady().then(() => { switched.done = true; });
      },
    }, 50);
    chart = lost.chart;
    try {
      await until(() => switched.done, "the switch to Canvas");
      const now = host.querySelector("canvas");
      expect(now).not.toBe(lost.canvas);
      expect(now?.getContext("2d")).not.toBeNull();
      expect(chart.toPNG()).toMatch(/^data:image\/png/);
      expect(watch.errors).toEqual([]);
    } finally {
      watch.dispose();
      chart.destroy();
    }
  });

  it("never reports a loss after destroy() during the wait", async () => {
    const reports: number[] = [];
    const host = makeHost();
    const { chart } = await lostPlot(host, { onContextUnrestored: () => reports.push(1) }, 50);
    chart.destroy();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reports).toEqual([]);
  });

  it("restores again after a second loss of the restored backend", async () => {
    const reports: number[] = [];
    const host = makeHost();
    const { chart, canvas, lose } = await lostPlot(host, { onContextUnrestored: () => reports.push(1) });
    try {
      await restoreNow(canvas, lose);
      await until(() => host.querySelector("canvas") !== canvas, "the first redraw");
      await chart.whenReady();
      const second = host.querySelector("canvas");
      if (!second) throw new Error("no canvas");
      const lose2 = loseExtension(second);
      await loseNow(second, lose2);
      expect(() => chart.toPNG()).toThrow(/WebGL context is lost/);
      await restoreNow(second, lose2);
      await until(() => host.querySelector("canvas") !== second, "the second redraw");
      await chart.whenReady();
      expect(host.querySelectorAll("canvas")).toHaveLength(1);
      expect(chart.screenPixel(100, 100)?.slice(0, 3)).toEqual([255, 0, 0]);
      expect(reports).toEqual([]);
    } finally {
      chart.destroy();
    }
  });

  it("reports once when the restore swap fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reports: number[] = [];
    const host = makeHost();
    const { chart, canvas, lose } = await lostPlot(host, { onContextUnrestored: () => reports.push(1) });
    try {
      vi.spyOn(WebGLBackend, "create").mockRejectedValueOnce(new Error("no device"));
      await restoreNow(canvas, lose);
      await until(() => reports.length > 0, "the report");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reports).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("could not be created"))).toBe(true);
    } finally {
      chart.destroy();
    }
  });

  it("waits for a context lost before its backend was installed, and reports it", async () => {
    const reports: number[] = [];
    const host = makeHost();
    const chart = new PlotProbe(host, { width: W, height: H, backend: "canvas", onContextUnrestored: () => reports.push(1) }, 50);
    try {
      await chart.whenReady();
      chart.layer("a", [0], { draw: square(100, 100, 30), fill: "#ff0000", id: () => "a0" });
      const create = WebGLBackend.create.bind(WebGLBackend);
      let lostCanvas: HTMLCanvasElement | null = null;
      vi.spyOn(WebGLBackend, "create").mockImplementationOnce(async (canvas, opts) => {
        const backend = await create(canvas, opts);
        loseExtension(canvas).loseContext(); // lost in flight, before installBackend
        lostCanvas = canvas;
        return backend;
      });
      chart.setBackend("webgl");
      await chart.whenReady();
      expect(host.querySelector("canvas")).toBe(lostCanvas);
      await until(() => reports.length > 0, "the report");
      expect(reports).toHaveLength(1);
      // A lost WebGL backend is not "current": an explicit pick rebuilds it.
      chart.setBackend("webgl");
      await chart.whenReady();
      expect(host.querySelector("canvas")).not.toBe(lostCanvas);
      expect(chart.screenPixel(100, 100)?.slice(0, 3)).toEqual([255, 0, 0]);
    } finally {
      chart.destroy();
    }
  });

  it("releases the restored context of the replaced backend", async () => {
    const host = makeHost();
    const { chart, canvas, lose } = await lostPlot(host, {});
    try {
      const gl = canvas.getContext("webgl2");
      await restoreNow(canvas, lose);
      await until(() => host.querySelector("canvas") !== canvas, "the redraw on a new canvas");
      await chart.whenReady();
      await nextFrame();
      expect(gl?.isContextLost()).toBe(true); // released, not left live until GC
    } finally {
      chart.destroy();
    }
  });

  it("takes no device probe on a lost context", async () => {
    const host = makeHost();
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: W, height: H });
    try {
      const device = backend.gpuDevice;
      loseExtension(canvas).loseContext();
      await nextFrame();
      const texture = vi.spyOn(device, "createTexture");
      const framebuffer = vi.spyOn(device, "createFramebuffer");
      expect(gpuCaps(device)?.blendProbe).toBe("error");
      expect(deviceReadsRG(device)).toBe(false);
      expect(texture).not.toHaveBeenCalled();
      expect(framebuffer).not.toHaveBeenCalled();
    } finally {
      backend.destroy();
    }
  });
});

