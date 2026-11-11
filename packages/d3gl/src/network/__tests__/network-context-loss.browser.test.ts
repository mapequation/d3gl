/**
 * A lost WebGL context (#599): the render backend stops cleanly — no luma.gl shader-error overlay, no uncaught
 * error — and when the browser gives the context back, the engine redraws the same layout, camera and selection
 * on a fresh WebGL backend (the backend-swap path). If it does not come back, `onContextLost` fires once.
 * The loss is driven with `WEBGL_lose_context`, during a network layout, as Chrome's GPU-process reset did.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { ViewTransform } from "../../core/index.js";

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
    const net = new Probe(host, { width: W, height: H, backend: "webgl", onContextLost: () => reports.push(1) });
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
    const net = new Probe(host, { width: W, height: H, backend: "webgl", onContextLost: () => reports.push(1) }, 50);
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
