import { describe, it, expect, afterEach, vi } from "vitest";
import { zoomTransform } from "d3-zoom";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import type { ViewTransform } from "../../core/index.js";
import { easeCubicInOut } from "../transition.js";

/**
 * `layout({ fit: true })` beyond streaming (#427), through the real engine and d3-zoom on a real host:
 *   1. with a `transition`, the camera eases along with the nodes — from the view it was at to the one
 *      framing the final layout, on the transition's own eased progress in the same frames (the world
 *      rectangle it shows moves in a straight line, as the nodes do) — and ends on the final layout's
 *      exact box; nothing moves at the `layout()` call itself;
 *   2. a real wheel gesture, an explicit `setTransform` or a node grab mid-transition hands the view to
 *      the user for good, while the camera's own moves never count as a gesture (#309);
 *   3. a layout landed in one go (`"positions"`, `"force"`) is framed once, as it lands;
 *   4. a cold nested map streamed depth by depth frames a box its final layout is known to lie in — so
 *      the camera only zooms in as depths land (#324) — and settles on the leaves' exact box, like a flat
 *      layout, instead of the root disc it used to keep (fill 0.53 in the Navigator).
 */

const W = 400;
const H = 300;
const hosts: HTMLElement[] = [];
function makeHost(fixed = false): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = fixed ? `position:absolute;left:0;top:0;width:${W}px;height:${H}px` : `width:${W}px;height:${H}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}
afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

/** Counts gesture boundaries and exposes the view, without reaching into privates. */
class ProbeNetwork extends Network {
  interactingCalls = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  protected override setInteracting(v: boolean): void {
    this.interactingCalls++;
    super.setInteracting(v);
  }
  get camera(): ViewTransform {
    return { ...this.transform };
  }
}

/** Runs each streamed frame's coalesced repaint as soon as it is requested, and records the view it fits. */
class DepthProbe extends ProbeNetwork {
  flushFrames: () => void = () => {};
  readonly frameScales: number[] = [];
  protected override scheduleLayoutRepaint(): void {
    super.scheduleLayoutRepaint();
    this.flushFrames();
    this.frameScales.push(this.camera.k);
  }
}

async function engine(fixed = false): Promise<{ net: ProbeNetwork; host: HTMLElement }> {
  const host = makeHost(fixed);
  const net = new ProbeNetwork(host, { width: W, height: H, backend: "webgl" });
  await net.whenReady();
  return { net, host };
}

/** A `cols`-wide grid of `n` nodes, `step` apart, chained into a path. */
function grid(n: number, cols: number, step: number): { graph: NetworkGraph; positions: Float32Array } {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 1; i < n; i++) {
    source.push(i - 1);
    target.push(i);
  }
  const positions = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = (i % cols) * step;
    positions[2 * i + 1] = Math.floor(i / cols) * step;
  }
  return { graph: buildGraph({ nodeCount: n, source, target }), positions };
}

/** `p` scaled by `s` about the origin, then shifted by (dx, dy). */
const moved = (p: Float32Array, s: number, dx: number, dy: number): Float32Array => p.map((v, i) => v * s + (i % 2 ? dy : dx));

interface Framing {
  /** The exact box's longest side over the shorter view side. */
  fill: number;
  cx: number;
  cy: number;
  /** Every node's centre on screen. */
  allInside: boolean;
}
function framingOf(positions: Float32Array, t: ViewTransform): Framing {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length / 2; i++) {
    const x = positions[2 * i] ?? NaN;
    const y = positions[2 * i + 1] ?? NaN;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const sx = (x: number): number => t.k * x + t.x;
  const sy = (y: number): number => t.k * y + t.y;
  const eps = 1e-3;
  return {
    fill: (t.k * Math.max(maxX - minX, maxY - minY)) / Math.min(W, H),
    cx: sx((minX + maxX) / 2),
    cy: sy((minY + maxY) / 2),
    allInside: sx(minX) >= -eps && sx(maxX) <= W + eps && sy(minY) >= -eps && sy(maxY) <= H + eps,
  };
}
/** Framed by the fit: its 85% less the glyph pad, centred. */
function expectFramed(positions: Float32Array, t: ViewTransform): void {
  const f = framingOf(positions, t);
  expect(f.fill).toBeGreaterThan(0.8);
  expect(f.fill).toBeLessThan(0.86);
  expect(Math.abs(f.cx - W / 2)).toBeLessThan(1);
  expect(Math.abs(f.cy - H / 2)).toBeLessThan(1);
  expect(f.allInside).toBe(true);
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, maxMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!done() && performance.now() - t0 < maxMs) await sleep(10);
}

interface Sample {
  positions: Float32Array;
  view: ViewTransform;
}
/** Record the positions and the view once per animation frame until `stop()`. */
function sampler(net: ProbeNetwork, graph: NetworkGraph): { samples: Sample[]; stop(): void } {
  const samples: Sample[] = [];
  let on = true;
  const tick = (): void => {
    if (!on) return;
    samples.push({ positions: graph.positions.slice(), view: net.camera });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { samples, stop: () => void (on = false) };
}

/** Where `sample` sits on the straight path `from → to`: one common fraction for every node, or NaN. */
function pathFraction(sample: Float32Array, from: Float32Array, to: Float32Array): number {
  let ref = 0;
  let span = 0;
  for (let i = 0; i < from.length; i++) {
    const d = Math.abs((to[i] ?? NaN) - (from[i] ?? NaN));
    if (d > span) [ref, span] = [i, d];
  }
  const at = (a: Float32Array, i: number): number => a[i] ?? NaN;
  const k = (at(sample, ref) - at(from, ref)) / (at(to, ref) - at(from, ref));
  for (let i = 0; i < from.length; i++) {
    const want = at(from, i) + (at(to, i) - at(from, i)) * k;
    if (Math.abs(at(sample, i) - want) > 1e-3 * (1 + Math.abs(at(to, i) - at(from, i)))) return Number.NaN;
  }
  return k;
}

/** Where view `t` sits between views `a` and `b` along the fit's camera path (its `1/k`, linear in progress). */
const cameraFraction = (t: ViewTransform, a: ViewTransform, b: ViewTransform): number => (1 / t.k - 1 / a.k) / (1 / b.k - 1 / a.k);

function wheel(host: HTMLElement, deltaY: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + W / 2, clientY: r.top + H / 2, deltaY, bubbles: true, cancelable: true }));
}

describe("fit + transition: the camera eases along with the nodes (#427)", () => {
  it("from the current view to the final layout's exact box, on the transition's own ease, every node on screen throughout", async () => {
    const { net, host } = await engine();
    const { graph, positions: a } = grid(400, 20, 10);
    net.data(graph).style({ nodeRadius: 3, sizeMode: "screen" }).enableZoom([0.001, 100]);
    net.layout({ backend: "positions", positions: a, fit: true });
    expectFramed(a, net.camera); // no transition: framed once, as it lands
    await nextFrame(); // let the first paint land: a transition is timed, so a stalled first frame would skip it
    await nextFrame();

    const start = net.camera;
    const b = moved(a, 2, 300, -120); // twice the extent, elsewhere
    const rec = sampler(net, graph);
    net.layout({ backend: "positions", positions: b, transition: 1000, fit: true });
    expect(net.camera).toEqual(start); // nothing jumps at the call
    await net.whenSettled();
    await nextFrame();
    rec.stop();
    const end = net.camera;

    expectFramed(b, end);
    expect(zoomTransform(host)).toMatchObject(end); // d3-zoom kept in step with the camera
    expect(net.interactingCalls, "the camera's own moves ran a gesture boundary").toBe(0);

    const moving = rec.samples.filter((s) => {
      const f = pathFraction(s.positions, a, b);
      return f > 1e-4 && f < 1 - 1e-4;
    });
    // A handful is enough to show it eased: a loaded machine paints few frames (the checks below hold on each).
    expect(moving.length, "no intermediate frame — it jumped instead of easing").toBeGreaterThanOrEqual(3);
    let prevK = start.k;
    for (const s of rec.samples) {
      const fp = pathFraction(s.positions, a, b);
      expect(Number.isFinite(fp), "an off-path position frame").toBe(true);
      // The camera is exactly as far along its path as the nodes are along theirs: same ease, same frame.
      expect(cameraFraction(s.view, start, end)).toBeCloseTo(fp, 3);
      expect(s.view.k).toBeLessThanOrEqual(prevK + 1e-12); // zooms out monotonically onto the larger map
      prevK = s.view.k;
      expect(framingOf(s.positions, s.view).allInside, "a node left the screen mid-transition").toBe(true);
    }
    net.destroy();
  });

  it("a warm nested re-cluster eases the camera from where it is to the new map (the Navigator's RELAYOUT)", async () => {
    const { net } = await engine();
    const g = buildGraph({ nodeCount: 8, source: [0, 2, 0, 4, 6, 4, 5, 3], target: [1, 3, 2, 5, 7, 6, 7, 4], directed: true });
    const MODULES: ModuleNode[] = [
      { id: 0, path: [1, 1, 1] }, { id: 1, path: [1, 1, 2] }, { id: 2, path: [1, 2, 1] }, { id: 3, path: [1, 2, 2] },
      { id: 4, path: [2, 1] }, { id: 5, path: [2, 2] }, { id: 6, path: [2, 3] }, { id: 7, path: [2, 4] },
    ];
    const PAIRS: ModuleNode[] = MODULES.map(({ id }) => ({ id, path: [Math.floor(id / 2) + 1, (id % 2) + 1] }));
    const POSITIONS = new Float32Array([20, 20, 40, 20, 20, 40, 40, 40, 140, 140, 160, 140, 140, 160, 160, 160]);
    net.data(g, { modules: MODULES }).lod(false).layout({ backend: "positions", positions: POSITIONS });
    net.setTransform({ k: 0.4, x: 150, y: 100 }); // zoomed out, off-centre: the map is small and not framed
    await nextFrame();
    await nextFrame();

    const start = net.camera;
    const from = g.positions.slice();
    net.data(g, { modules: PAIRS });
    const rec = sampler(net, g);
    net.layout({ backend: "worker", nested: { warm: true }, transition: 800, fit: true });
    await net.whenSettled();
    await nextFrame();
    rec.stop();
    const to = g.positions.slice();
    const end = net.camera;

    expectFramed(to, end);
    expect(end.k).toBeGreaterThan(start.k);
    let prevK = start.k;
    for (const s of rec.samples) {
      const fp = pathFraction(s.positions, from, to);
      expect(Number.isFinite(fp), "an off-path position frame").toBe(true);
      expect(cameraFraction(s.view, start, end)).toBeCloseTo(fp, 3); // still at `start` while the worker solves
      expect(s.view.k).toBeGreaterThanOrEqual(prevK - 1e-12);
      prevK = s.view.k;
    }
    expect(rec.samples.some((s) => cameraFraction(s.view, start, end) > 0.05 && cameraFraction(s.view, start, end) < 0.95), "the camera jumped instead of easing").toBe(true);
    net.destroy();
  });
});

describe("fit + transition: the user takes the view over, the camera's own moves never do (#427, #309)", () => {
  /** A long fitted transition from a framed grid to one twice its size, running for a few frames. */
  async function running(fixed = false): Promise<{ net: ProbeNetwork; host: HTMLElement; graph: NetworkGraph; b: Float32Array }> {
    const { net, host } = await engine(fixed);
    const { graph, positions: a } = grid(400, 20, 10);
    net.data(graph).style({ nodeRadius: 4, sizeMode: "screen" }).enableZoom([0.001, 100]);
    net.layout({ backend: "positions", positions: a, fit: true });
    await nextFrame();
    await nextFrame();
    const b = moved(a, 2, 300, -120);
    const k0 = net.camera.k;
    net.layout({ backend: "positions", positions: b, transition: 1500, fit: true });
    await until(() => net.camera.k < k0 * 0.97, 3000); // the camera is under way
    expect(net.camera.k, "the camera never started easing").toBeLessThan(k0 * 0.97);
    return { net, host, graph, b };
  }

  it("a real wheel gesture mid-transition leaves the camera where the user put it; the nodes still land", async () => {
    const { net, host, graph, b } = await running();
    wheel(host, -240);
    await until(() => net.interactingCalls === 2); // the wheel gesture ends once it goes idle
    expect(net.interactingCalls, "the wheel gesture never ended").toBe(2);
    const user = net.camera;
    await net.whenSettled();
    await nextFrame();
    expect(net.camera).toEqual(user);
    expect(zoomTransform(host)).toMatchObject(user);
    expect(Array.from(graph.positions)).toEqual(Array.from(b));
    net.destroy();
  });

  it("an explicit setTransform mid-transition keeps its view", async () => {
    const { net, host, graph, b } = await running();
    const target = { k: 0.9, x: 12, y: -8 };
    net.setTransform(target);
    await net.whenSettled();
    await nextFrame();
    expect(net.camera).toEqual(target);
    expect(zoomTransform(host)).toMatchObject(target);
    expect(net.interactingCalls).toBe(0);
    expect(Array.from(graph.positions)).toEqual(Array.from(b));
    net.destroy();
  });

  it("a node grabbed mid-transition keeps the view it had: the camera holds still under the cursor", async () => {
    const { net, host, graph } = await running(true);
    net.interactive({ draggable: true });
    const grabbed = net.camera;
    const id = 0;
    const x = grabbed.k * (graph.positions[2 * id] ?? NaN) + grabbed.x;
    const y = grabbed.k * (graph.positions[2 * id + 1] ?? NaN) + grabbed.y;
    const r = host.getBoundingClientRect();
    const ev = (type: string, sx: number, sy: number): void => {
      host.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, button: 0, pointerId: 1 }));
    };
    ev("pointerdown", x, y);
    ev("pointermove", x + 30, y);
    ev("pointerup", x + 30, y);
    await net.whenSettled();
    await nextFrame();
    await nextFrame();
    expect(net.camera).toEqual(grabbed);
    expect(zoomTransform(host)).toMatchObject(grabbed);
    net.destroy();
  });
});

/**
 * Frames stepped by hand on a virtual clock: `requestAnimationFrame` queues, {@link Stepper.step} advances
 * the clock by `ms` and runs the queued frames, so each transition frame's eased progress is known exactly.
 */
interface Stepper {
  step(ms: number): void;
  restore(): void;
}
function stepper(): Stepper {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  globalThis.requestAnimationFrame = (cb) => (queue.set(++id, cb), id);
  globalThis.cancelAnimationFrame = (i) => void queue.delete(i);
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  return {
    step(ms) {
      clock += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(clock);
    },
    restore() {
      now.mockRestore();
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCaf;
    },
  };
}

describe("fit + transition: the destination follows the viewport and the glyph pad (#427)", () => {
  // The camera heads for the view framing the target in the viewport and with the glyph pad as they are
  // NOW: a resize or a restyle mid-ease re-aims it from where it is — no jump — and it lands on the view
  // the settle frames, so there is no snap at the end either.
  for (const change of ["resize", "restyle"] as const) {
    it(`a ${change} mid-ease re-aims the camera from where it is, and it lands on the settled fit`, async () => {
      const { net } = await engine(true);
      const { graph, positions: a } = grid(400, 20, 10);
      net.data(graph).style({ nodeRadius: 3, sizeMode: change === "restyle" ? "world" : "screen" }).enableZoom([0.001, 100]);
      net.layout({ backend: "positions", positions: a, fit: true });
      const frames = stepper();
      try {
        const D = 1000;
        const b = moved(a, 2, 300, -120);
        net.layout({ backend: "positions", positions: b, transition: D, fit: true }); // starts at clock 0
        let settled = false;
        void net.whenSettled().then(() => void (settled = true));
        const seen: { e: number; view: ViewTransform }[] = [];
        let changedAfter = -1; // the last frame before the change
        for (let i = 1; i <= 40 && !settled; i++) {
          if (i === 9) {
            changedAfter = seen.length - 1;
            if (change === "resize") net.setSize(W * 0.6, H * 0.6);
            else net.style({ nodeRadius: 60, sizeMode: "world" });
          }
          frames.step(50);
          seen.push({ e: easeCubicInOut(Math.min(1, (50 * i) / D)), view: net.camera });
          await sleep(0); // the settle's microtasks run here
        }
        expect(settled, "the transition never settled").toBe(true);
        const final = net.camera;
        const last = seen[seen.length - 1];
        const before = seen[changedAfter];
        if (!last || !before) throw new Error("no frames");
        // The last transition frame is already the settled fit: no snap at the settle.
        expect(last.view.k).toBeCloseTo(final.k, 9);
        expect(last.view.x).toBeCloseTo(final.x, 6);
        expect(last.view.y).toBeCloseTo(final.y, 6);
        expect(final.k, "non-vacuity: the change did not move the destination").toBeLessThan(before.view.k * 0.9);
        // From the change on, the camera goes from where it was to the new destination over the progress
        // left, in step with the nodes — so it never jumps at the change.
        for (const f of seen.slice(changedAfter + 1)) {
          expect(cameraFraction(f.view, before.view, final)).toBeCloseTo((f.e - before.e) / (1 - before.e), 6);
        }
        if (change === "resize") {
          const f = framingOf(b, final);
          expect(f.fill * Math.min(W, H) / Math.min(W * 0.6, H * 0.6)).toBeGreaterThan(0.8); // framed in the new size
        }
      } finally {
        frames.restore();
        net.destroy();
      }
    });
  }
});

describe("fit + transition on Canvas and SVG: each frame's retained scene is cut at that frame's camera (#427)", () => {
  // The camera moves through frameView (transform state + zoom re-seed), not setTransform, so no
  // programmatic-transform hook re-bakes the vector scene: the frame's own rebuild must, at the view the
  // camera just took. A frame baked at the previous view would draw screen-sized glyphs, labels and link
  // widths one camera step behind.
  const num = (v: string | undefined): number => Number(v ?? NaN);
  for (const backend of ["canvas", "svg"] as const) {
    it(`${backend}: glyphs, labels and link widths mid-transition match the camera and positions of that frame`, async () => {
      const host = makeHost(true);
      const net = new ProbeNetwork(host, { width: W, height: H, backend });
      await net.whenReady();
      const { graph, positions: a } = grid(100, 10, 20);
      net.data(graph).style({ nodeRadius: 4, sizeMode: "screen", linkWidth: 1 }).enableZoom([0.001, 100]);
      net.labels({ labelOf: (i) => `n${i}` });
      net.layout({ backend: "positions", positions: a, fit: true });
      const start = net.camera;
      const frames = stepper();
      try {
        net.layout({ backend: "positions", positions: moved(a, 2.5, 200, -90), transition: 1000, fit: true });
        for (let i = 0; i < 9; i++) frames.step(50); // mid-ease
        const t = net.camera;
        expect(t.k, "non-vacuity: the camera did not move").toBeLessThan(start.k * 0.8);
        const mid = net.toSVG();

        // Node glyphs: screen-sized, at this frame's positions through this frame's camera.
        const circles = [...mid.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g)];
        expect(circles.length).toBe(graph.nodeCount);
        circles.forEach((m, i) => {
          expect(num(m[1])).toBeCloseTo(t.k * (graph.positions[2 * i] ?? NaN) + t.x, 2);
          expect(num(m[2])).toBeCloseTo(t.k * (graph.positions[2 * i + 1] ?? NaN) + t.y, 2);
          expect(num(m[3])).toBeCloseTo(4, 6);
        });
        // Labels: on their nodes, at this frame.
        const labels = [...mid.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>n(\d+)<\/text>/g)];
        expect(labels.length, "no label was placed").toBeGreaterThan(0);
        for (const m of labels) {
          const i = num(m[3]);
          expect(num(m[1])).toBeCloseTo(t.k * (graph.positions[2 * i] ?? NaN) + t.x, 2);
          expect(num(m[2])).toBeCloseTo(t.k * (graph.positions[2 * i + 1] ?? NaN) + t.y, 2);
        }
        // Links: a 1px screen width baked into world units at this frame's k.
        const widths = [...mid.matchAll(/<path d="[^"]*" fill="none" stroke="[^"]*" stroke-width="([^"]+)"/g)];
        expect(widths.length).toBe(graph.edgeCount);
        for (const m of widths) expect(num(m[1]) * t.k).toBeCloseTo(1, 3);
        // …and the whole document is what a forced re-cut at this view gives.
        net.syncScreenGeometry();
        expect(net.toSVG(), "the retained scene lagged the camera").toBe(mid);
        expect(net.interactingCalls).toBe(0);
      } finally {
        frames.restore();
        net.destroy();
      }
    });
  }
});

describe("fit without a transition frames a layout landed in one go, once (#427)", () => {
  it("\"positions\" and \"force\" are framed as they land", async () => {
    const { net } = await engine();
    const { graph, positions } = grid(400, 20, 10);
    net.data(graph).style({ nodeRadius: 3, sizeMode: "screen" });
    net.setTransform({ k: 0.1, x: 0, y: 0 });
    net.layout({ backend: "positions", positions: moved(positions, 3, -500, 800), fit: true });
    expectFramed(graph.positions, net.camera);
    net.setTransform({ k: 0.1, x: 0, y: 0 });
    net.layout({ backend: "force", fit: true, iterations: 50 });
    expectFramed(graph.positions, net.camera);
    net.destroy();
  });
});

/** A cold nested map: `T` top modules × `S` sub-modules × `L` leaves, leaves chained in each sub-module,
 *  sub-modules in a ring in each top module, top modules in a ring. */
function threeLevel(T: number, S: number, L: number): { graph: NetworkGraph; modules: ModuleNode[] } {
  const n = T * S * L;
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  for (let id = 0; id < n; id++) {
    const t = Math.floor(id / (S * L));
    const s = Math.floor((id % (S * L)) / L);
    const l = id % L;
    modules.push({ id, path: [t + 1, s + 1, l + 1] });
    if (l > 0) {
      source.push(id - 1);
      target.push(id);
    }
    if (l === 0) {
      source.push(id);
      target.push(t * S * L + ((s + 1) % S) * L); // the next sub-module in the ring
    }
    if (s === 0 && l === 0) {
      source.push(id);
      target.push(((t + 1) % T) * S * L); // the next top module in the ring
    }
  }
  return { graph: buildGraph({ nodeCount: n, source, target }), modules };
}

describe("a cold nested map frames its actual bounds, not the root disc (#427)", () => {
  it("streamed: the camera only zooms in as depths land, and settles on the leaves' exact box", async () => {
    const host = makeHost();
    const net = new DepthProbe(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const { graph, modules } = threeLevel(6, 5, 40);
    net.data(graph, { modules }).lod(false).style({ nodeRadius: 2, sizeMode: "screen" }).enableZoom([0.001, 100]);
    // Repaint every streamed depth frame as it arrives: a real frame loop coalesces depth frames the worker
    // posts faster than it paints (all of them, on a loaded machine), which would leave nothing to compare.
    const realRaf = globalThis.requestAnimationFrame;
    const realCaf = globalThis.cancelAnimationFrame;
    const queue = new Map<number, FrameRequestCallback>();
    let id = 0;
    globalThis.requestAnimationFrame = (cb) => (queue.set(++id, cb), id);
    globalThis.cancelAnimationFrame = (i) => void queue.delete(i);
    net.flushFrames = () => {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(performance.now());
    };
    try {
      net.layout({ backend: "worker", nested: true, fit: true });
      const rootDisc = net.camera; // the first paint: framed on the root disc, the only bound known yet
      await net.whenSettled();
      net.flushFrames();

      expectFramed(graph.positions, net.camera);
      expect(net.interactingCalls).toBe(0);
      // One fitted repaint per depth (top modules, sub-modules, leaves), then the final layout's.
      const ks = [rootDisc.k, ...net.frameScales];
      expect(net.frameScales.length, `frames: ${ks.join(", ")}`).toBe(4);
      for (let i = 1; i < ks.length; i++) expect(ks[i], `zoomed out at frame ${i}: ${ks.join(", ")}`).toBeGreaterThanOrEqual((ks[i - 1] ?? NaN) - 1e-12);
      expect(ks[1], "the first depth did not tighten the root disc").toBeGreaterThan(rootDisc.k * 1.01);
      expect(net.frameScales[3]).toBe(net.camera.k); // the leaves' exact box, streamed and settled alike
      // The root disc it used to keep framed this map at under two thirds of the fit's fill.
      expect(framingOf(graph.positions, rootDisc).fill).toBeLessThan(0.7);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCaf;
      net.destroy();
    }
  });

  it("a transport that posts no depth bound frames the leaves it has from the first paint, never the root disc", async () => {
    // Without Workers the nested solve runs on the main thread and lands in one go: a transport with no
    // per-depth bound (as is the GPU nested stream). The engine assumes none: it frames the live leaves.
    const { net } = await engine();
    const { graph, modules } = threeLevel(6, 5, 40);
    net.data(graph, { modules }).lod(false).style({ nodeRadius: 2, sizeMode: "screen" }).enableZoom([0.001, 100]);
    vi.stubGlobal("Worker", undefined);
    try {
      net.layout({ backend: "worker", nested: true, fit: true });
      const first = net.camera; // the synchronous first paint: the solve has already landed
      expectFramed(graph.positions, first);
      await net.whenSettled();
      await nextFrame();
      expectFramed(graph.positions, net.camera);
      expect(net.camera.k, "the settle snapped away from the first paint").toBeCloseTo(first.k, 6);
    } finally {
      vi.unstubAllGlobals();
      net.destroy();
    }
  });

  it("synchronous (\"force\"): framed once on the leaves' exact box", async () => {
    const { net } = await engine();
    const { graph, modules } = threeLevel(6, 5, 40);
    net.data(graph, { modules }).lod(false).style({ nodeRadius: 2, sizeMode: "screen" });
    net.layout({ backend: "force", nested: true, fit: true });
    expectFramed(graph.positions, net.camera);
    net.destroy();
  });
});
