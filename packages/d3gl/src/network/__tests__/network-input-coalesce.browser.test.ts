import { describe, it, expect, afterEach } from "vitest";
import { zoomTransform } from "d3-zoom";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ViewTransform } from "../../core/index.js";

/**
 * Network pan/zoom and node-drag input draw once per animation frame, on every backend (#367).
 *
 * A wheel event used to run the LOD cut, declutter and super-edge gather inside d3-zoom's handler, and a
 * node-drag pointer move a whole `rebuild()` inside its own — so a burst of events cost one draw per event.
 * Input now records its latest state and the engine draws once per frame; a streamed layout frame joins
 * the same frame instead of drawing a second time. The per-frame cost at scale is pinned by
 * `network-input-coalesce-perf.browser.test.ts`; this file pins the behaviour on WebGL, Canvas and SVG:
 *   1. a wheel burst renders once, in the frame, at the latest transform; the gesture's end still settles
 *      the vector scene once (the #309 contract);
 *   2. a wheel burst and a streamed layout frame pending in the same frame draw ONCE;
 *   3. a node drag (WebGL — interaction rides the instanced lane) writes the held positions on every move
 *      (the zero-lag contract of #140) but redraws once per frame, merged with any pending zoom or
 *      streamed frame;
 *   4. `pick` answers against the drawn frame while input is pending, and a streamed frame whose layout is
 *      halted before its frame runs draws nothing.
 */

const W = 300;
const H = 200;
const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

const queued = new Map<number, FrameRequestCallback>();
let nextId = 0;
let restore: (() => void) | null = null;
/** Replace `requestAnimationFrame` with a queue that runs only on {@link flushFrames}. */
function holdFrames(): void {
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    queued.set(++nextId, cb);
    return nextId;
  };
  globalThis.cancelAnimationFrame = (id) => void queued.delete(id);
  restore = () => {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
  };
}
function flushFrames(): void {
  const due = [...queued.values()];
  queued.clear();
  const now = performance.now();
  for (const cb of due) cb(now);
}
afterEach(() => {
  restore?.();
  restore = null;
  queued.clear();
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

/** Counts renders, frame redraws, `setTransform` calls, gesture boundaries and vector re-bakes; exposes the
 *  drawn view and the streamed-frame trigger (what the worker transport calls after copying a frame's
 *  positions). */
class Probe extends Network {
  renders = 0;
  redraws = 0;
  transforms = 0;
  interactingCalls = 0;
  screenSyncs = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  override render(): this {
    this.renders++;
    return super.render();
  }
  protected override drawFrame(): void {
    this.redraws++;
    super.drawFrame();
  }
  override setTransform(t: ViewTransform): this {
    this.transforms++;
    return super.setTransform(t);
  }
  protected override setInteracting(v: boolean): void {
    this.interactingCalls++;
    super.setInteracting(v);
  }
  override syncScreenGeometry(): this {
    this.screenSyncs++;
    return super.syncScreenGeometry();
  }
  get drawnView(): ViewTransform {
    return { ...this.transform };
  }
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
}

/** A 3×3 grid of nodes, 60px apart from (60, 40), with a path through it. */
function grid(): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const positions = new Float32Array(18);
  for (let i = 0; i < 9; i++) {
    positions[2 * i] = 60 + 60 * (i % 3);
    positions[2 * i + 1] = 40 + 60 * Math.floor(i / 3);
  }
  const source = [0, 1, 2, 3, 4, 5, 6, 7];
  const target = [1, 2, 3, 4, 5, 6, 7, 8];
  return { graph: buildGraph({ nodeCount: 9, source, target, directed: false }), positions };
}

async function engine(backend: "webgl" | "canvas" | "svg"): Promise<{ host: HTMLElement; net: Probe; positions: Float32Array }> {
  const host = makeHost();
  const net = new Probe(host, { width: W, height: H, backend });
  await net.whenReady();
  const { graph, positions } = grid();
  net.data(graph).style({ nodeRadius: 8 }).layout({ backend: "positions", positions });
  net.setTransform({ k: 1, x: 0, y: 0 });
  return { host, net, positions: graph.positions };
}

const gesture = (host: HTMLElement): ViewTransform => {
  const t = zoomTransform(host);
  return { k: t.k, x: t.x, y: t.y };
};

function wheel(host: HTMLElement, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + x, clientY: r.top + y, deltaY: -40, bubbles: true, cancelable: true }));
}

function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
}

async function until(done: () => boolean, maxMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!done() && performance.now() - t0 < maxMs) await new Promise((res) => setTimeout(res, 20));
}

describe("network pan/zoom and node-drag draw once per animation frame (#367)", () => {
  for (const backend of ["webgl", "canvas", "svg"] as const) {
    it(`${backend}: a wheel burst renders once, at the latest transform; the end settles once`, async () => {
      const { host, net } = await engine(backend);
      net.enableZoom([0.1, 40]);
      holdFrames();
      const renders = net.renders;
      const syncs = net.screenSyncs;
      expect(net.pick(60, 40)?.id, "non-vacuity: node 0 is not under the probe point").toBe(0);
      for (let i = 0; i < 6; i++) wheel(host, 150 + 5 * i, 100);
      expect(net.renders - renders, "a wheel event rendered inside its handler").toBe(0);
      expect(net.pick(60, 40)?.id, "pick answered against a view that is not drawn yet").toBe(0);
      flushFrames();
      expect(net.renders - renders, "one frame, one render").toBe(1);
      expect(net.drawnView, "the frame did not draw the latest transform").toEqual(gesture(host));
      expect(net.drawnView.k, "non-vacuity: the burst did not zoom").toBeGreaterThan(1);
      expect(net.pick(60, 40), "pick kept answering against the old view after it was redrawn").toBeNull();
      expect(net.screenSyncs, "a gesture frame re-baked the vector scene").toBe(syncs);
      await until(() => net.interactingCalls === 2); // the wheel goes idle: d3-zoom ends the gesture
      expect(net.screenSyncs, "the gesture's end must settle the vector scene once").toBe(syncs + 1);
      net.destroy();
    });

    it(`${backend}: a wheel burst and a streamed layout frame pending in one frame draw once`, async () => {
      const { host, net } = await engine(backend);
      net.enableZoom([0.1, 40]);
      holdFrames();
      const renders = net.renders;
      const transforms = net.transforms;
      for (let i = 0; i < 4; i++) wheel(host, 150, 100);
      net.streamFrame();
      for (let i = 0; i < 4; i++) wheel(host, 150, 100);
      expect(net.renders - renders, "input or a streamed frame drew outside the frame").toBe(0);
      flushFrames();
      // One draw: the stream's rebuild at the frame's transform, never a gesture frame on top of it. (A vector
      // backend's rebuild renders once per retained layer it re-registers, so renders are not the count here.)
      expect(net.redraws, "the streamed frame was not redrawn exactly once").toBe(1);
      expect(net.transforms - transforms, "the gesture transform drew a second time").toBe(0);
      if (backend === "webgl") expect(net.renders - renders, "the pending zoom and stream rendered more than once").toBe(1);
      expect(net.drawnView).toEqual(gesture(host));
      net.destroy();
    });
  }

  it("webgl: a streamed frame whose layout is halted before its frame runs draws nothing", async () => {
    const { net } = await engine("webgl");
    holdFrames();
    const renders = net.renders;
    net.streamFrame();
    net.stopLayout(); // the run is gone: its frame has nothing left to draw
    flushFrames();
    expect(net.redraws, "a halted layout's streamed frame still redrew").toBe(0);
    expect(net.renders - renders).toBe(0);
    net.destroy();
  });

  it("webgl: a node drag writes the held position per move and redraws once per frame", async () => {
    const { host, net, positions } = await engine("webgl");
    net.interactive({ draggable: true, selectable: true });
    holdFrames();
    pointer(host, "pointerdown", 120, 100); // node 4, the grid's centre
    pointer(host, "pointermove", 120, 110); // past the click slop: the grab selects the node (a click-rate restyle)
    flushFrames();
    const renders = net.renders;
    for (let i = 1; i <= 5; i++) {
      pointer(host, "pointermove", 120 + 6 * i, 100 + 4 * i);
      expect([positions[8], positions[9]], "the held node lagged the cursor").toEqual([120 + 6 * i, 100 + 4 * i]);
    }
    expect(net.renders - renders, "a drag move redrew inside its handler").toBe(0);
    flushFrames();
    expect(net.renders - renders, "one frame, one redraw").toBe(1);
    expect(net.pick(150, 120)?.id, "the frame did not draw the dragged node where it was dropped").toBe(4);
    pointer(host, "pointerup", 150, 120);
    flushFrames();
    expect([positions[8], positions[9]]).toEqual([150, 120]);
    net.destroy();
  });

  it("webgl: a wheel burst, a streamed layout frame and drag moves pending in one frame draw once", async () => {
    const { host, net, positions } = await engine("webgl");
    net.enableZoom([0.1, 40]);
    net.interactive({ draggable: true, selectable: true });
    holdFrames();
    pointer(host, "pointerdown", 120, 100);
    pointer(host, "pointermove", 130, 104); // past the click slop: the drag begins
    flushFrames();
    const renders = net.renders;
    const redraws = net.redraws;
    const transforms = net.transforms;
    for (let i = 0; i < 4; i++) wheel(host, 40, 30);
    net.streamFrame();
    for (let i = 1; i <= 4; i++) pointer(host, "pointermove", 130 + 3 * i, 104 + 2 * i);
    expect(net.renders - renders, "input or a streamed frame drew outside the frame").toBe(0);
    flushFrames();
    expect(net.renders - renders, "the pending zoom, stream and drag drew more than once").toBe(1);
    expect(net.redraws - redraws).toBe(1);
    expect(net.transforms - transforms, "the gesture transform drew a second time").toBe(0);
    expect(net.drawnView).toEqual(gesture(host));
    expect(positions[8]).toBeCloseTo(142, 6);
    pointer(host, "pointerup", 142, 112);
    net.destroy();
  });
});
