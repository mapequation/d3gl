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
 *   3. a node drag writes the held positions on every move (the zero-lag contract of #140) but redraws once
 *      per frame on every backend, merged with any pending zoom, streamed frame or transition frame (LOD on:
 *      the aggregate follows); a move that lands after a wheel tick, before its frame, maps the cursor through
 *      the view that frame draws, so the held node is drawn under the cursor;
 *   4. `pick` answers against the drawn frame while input is pending; a streamed frame whose layout is
 *      halted before its frame runs draws nothing, but a drag move sharing that frame still draws;
 *   5. a fit (`layout({ fit: true })`) started while a gesture transform waits for its frame wins, and a later
 *      tick of the gesture takes the view back over, as a gesture frame always did.
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

/** Two modules of two leaves each, one collapsed aggregate apiece at k = 1: A (leaves 0, 1) centred on
 *  (77.5, 90) and B (leaves 2, 3) on (122.5, 110). Draggable, positions backend. */
async function lodEngine(): Promise<{ host: HTMLElement; net: Probe }> {
  const host = makeHost();
  const net = new Probe(host, { width: W, height: H, backend: "webgl" });
  await net.whenReady();
  const graph = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
  const modules = [{ id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] }];
  net.data(graph).lod({ modules, expandPx: 20 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
  net.setTransform({ k: 1, x: 0, y: 0 });
  net.interactive({ draggable: true, selectable: true });
  return { host, net };
}

/** A two-leaf aggregate is drawn under (x, y). */
const aggregateAt = (net: Probe, x: number, y: number): boolean => net.pick(x, y)?.members?.().length === 2;

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

  it("webgl: stopping the layout keeps the frame of a drag move still waiting for it", async () => {
    const { host, net } = await engine("webgl");
    net.interactive({ draggable: true, selectable: true });
    holdFrames();
    pointer(host, "pointerdown", 120, 100);
    pointer(host, "pointermove", 120, 110); // past the click slop: the drag begins
    flushFrames();
    const redraws = net.redraws;
    net.streamFrame();
    pointer(host, "pointermove", 150, 120);
    net.stopLayout(); // withdraws the halted run's streamed frame — but not the drag move sharing its frame
    flushFrames();
    expect(net.redraws - redraws, "stopping the layout dropped a pending drag move's frame").toBe(1);
    expect(net.pick(150, 120)?.id, "the drag move was not drawn").toBe(4);
    pointer(host, "pointerup", 150, 120);
    net.destroy();
  });

  for (const backend of ["webgl", "canvas", "svg"] as const) {
    it(`${backend}: a node drag writes the held position per move and redraws once per frame`, async () => {
      const { host, net, positions } = await engine(backend);
      net.interactive({ draggable: true, selectable: true });
      // On Canvas/SVG `interactive()` alone wires no pointer listeners (they ride the WebGL lane's registration;
      // the vector node layer carries no `selectable`/`draggable`), a gap outside this test: a click listener
      // wires them, so the drag reaches the engine the same way.
      if (backend !== "webgl") net.on("click", () => {});
      holdFrames();
      pointer(host, "pointerdown", 120, 100); // node 4, the grid's centre
      pointer(host, "pointermove", 120, 110); // past the click slop: the grab selects the node (a click-rate restyle)
      flushFrames();
      // One move's frame: its render count is one draw on this backend (a vector backend's rebuild renders once
      // per retained layer it re-registers, WebGL once).
      let renders = net.renders;
      let redraws = net.redraws;
      pointer(host, "pointermove", 120, 106);
      flushFrames();
      const oneMove = net.renders - renders;
      expect(net.redraws - redraws, "one move, one redraw").toBe(1);
      if (backend === "webgl") expect(oneMove, "a WebGL redraw is one render").toBe(1);
      expect(oneMove, "non-vacuity: the move's frame rendered nothing").toBeGreaterThan(0);
      renders = net.renders;
      redraws = net.redraws;
      for (let i = 1; i <= 5; i++) {
        pointer(host, "pointermove", 120 + 6 * i, 100 + 4 * i);
        expect([positions[8], positions[9]], "the held node lagged the cursor").toEqual([120 + 6 * i, 100 + 4 * i]);
      }
      expect(net.renders - renders, "a drag move rendered inside its handler").toBe(0);
      expect(net.redraws - redraws, "a drag move redrew inside its handler").toBe(0);
      flushFrames();
      expect(net.redraws - redraws, "five moves, one redraw").toBe(1);
      expect(net.renders - renders, "five moves' frame drew more than one move's").toBe(oneMove);
      expect(net.pick(150, 120)?.id, "the frame did not draw the dragged node where it was dropped").toBe(4);
      pointer(host, "pointerup", 150, 120);
      flushFrames();
      expect([positions[8], positions[9]]).toEqual([150, 120]);
      net.destroy();
    });
  }

  it("webgl, LOD on: drag moves and a streamed frame in one frame draw once, the aggregate where it was dropped", async () => {
    const { host, net } = await lodEngine();
    holdFrames();
    expect(aggregateAt(net, 77.5, 90), "non-vacuity: module A is not one aggregate under its centroid").toBe(true);
    pointer(host, "pointerdown", 77.5, 90);
    pointer(host, "pointermove", 77.5, 100); // past the click slop: the grab holds A's two leaves
    flushFrames();
    const redraws = net.redraws;
    for (let i = 1; i <= 4; i++) pointer(host, "pointermove", 77.5, 100 + 10 * i);
    net.streamFrame();
    flushFrames();
    expect(net.redraws - redraws, "the drag moves and the streamed frame drew more than once").toBe(1);
    expect(aggregateAt(net, 77.5, 140), "the aggregate did not follow the drag").toBe(true);
    expect(net.pick(77.5, 90), "the aggregate is still drawn where it was grabbed").toBeNull();
    pointer(host, "pointerup", 77.5, 140);
    net.destroy();
  });

  it("webgl, LOD on: a transition frame landing on a pending drag move folds in every node's move, once", async () => {
    const { host, net } = await lodEngine();
    holdFrames();
    pointer(host, "pointerdown", 77.5, 90);
    pointer(host, "pointermove", 77.5, 100); // the drag holds module A
    flushFrames();
    // A transition starts mid-drag, moving module B down by 50; its frame is queued ahead of the next move's.
    net.layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 160, 130, 160]), transition: 1 });
    expect(aggregateAt(net, 122.5, 110), "non-vacuity: module B is not one aggregate under its centroid").toBe(true);
    pointer(host, "pointermove", 77.5, 110); // only A's leaves moved — pending when the transition frame runs
    await new Promise((res) => setTimeout(res, 10)); // past the 1 ms duration: the first frame is the last
    const redraws = net.redraws;
    flushFrames();
    expect(net.redraws - redraws, "the transition frame and the drag move drew more than once").toBe(1);
    expect(aggregateAt(net, 122.5, 160), "the frame folded in only the drag's held set: module B did not follow").toBe(true);
    pointer(host, "pointerup", 77.5, 110);
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
    const drawn = net.drawnView;
    expect(drawn).toEqual(gesture(host));
    expect(drawn.k, "non-vacuity: the wheel ticks did not zoom").toBeGreaterThan(1);
    // The moves landed after the wheel ticks, before their frame: they map the cursor through the view that
    // frame draws, so the held node is drawn under the cursor — not through the view still on screen.
    const under = (): [number, number] => [positions[8]! * drawn.k + drawn.x, positions[9]! * drawn.k + drawn.y];
    expect(under()[0], "the held node was drawn off the cursor").toBeCloseTo(142, 3);
    expect(under()[1], "the held node was drawn off the cursor").toBeCloseTo(112, 3);
    pointer(host, "pointerup", 142, 112);
    flushFrames();
    expect(under()[0], "the release left the held node off the cursor").toBeCloseTo(142, 3);
    expect(under()[1], "the release left the held node off the cursor").toBeCloseTo(112, 3);
    net.destroy();
  });

  it("webgl: a fit layout started while a wheel transform waits for its frame wins; a later wheel tick takes the view over", async () => {
    const { host, net } = await engine("webgl");
    const told: ViewTransform[] = [];
    net.enableZoom([0.01, 40], (t) => told.push({ ...t }));
    holdFrames();
    for (let i = 0; i < 4; i++) wheel(host, 150, 100); // a gesture transform waiting for its frame
    net.layout({ backend: "worker", fit: true, iterations: 300 }); // frames the layout at once and re-seeds d3-zoom
    const fitted = net.drawnView;
    flushFrames();
    // The fit is newer than the pending gesture transform: that frame must not draw the old view over it,
    // or the drawn view and d3-zoom (seeded to the fit) disagree and the next wheel tick snaps (#202).
    expect(net.drawnView, "the pending gesture transform drew over the fit").toEqual(fitted);
    expect(gesture(host), "d3-zoom is not seeded to the drawn view").toEqual(net.drawnView);
    // A further tick of the same wheel gesture, with a streamed frame in its frame: the user's view wins —
    // the gesture takes over the fit, as a gesture frame always did — and onTransform is told what is drawn.
    wheel(host, 150, 100);
    const wanted = gesture(host);
    expect(wanted.k, "non-vacuity: the tick did not zoom past the fit").toBeGreaterThan(fitted.k);
    net.streamFrame();
    flushFrames();
    expect(net.drawnView, "the streaming fit reframed away from the user's wheel tick").toEqual(wanted);
    expect(told[told.length - 1], "onTransform was not told the drawn view").toEqual(net.drawnView);
    net.stopLayout();
    net.destroy();
  });
});
