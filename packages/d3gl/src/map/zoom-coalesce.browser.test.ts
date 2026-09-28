import { describe, it, expect, afterEach } from "vitest";
import { zoomTransform } from "d3-zoom";
import { Plot, type PlotOptions } from "./plot.js";
import type { ViewTransform } from "../core/index.js";

/**
 * Pan/zoom input draws once per animation frame (#367).
 *
 * A wheel burst, or the mouse moves of a pan, can deliver several d3-zoom events inside one frame. Each
 * used to run the whole transform frame synchronously in the event handler (lane re-emit, declutter,
 * labels, render), so the work scaled with the event rate instead of the frame rate. Now the handler
 * records the latest transform and the engine draws it once, in its next animation frame.
 *
 * Contract pinned here, through the real d3-zoom wiring on the base engine (plot):
 *   1. a burst of wheel events in one frame renders nothing until the frame, then renders ONCE, at the
 *      latest transform — the one d3-zoom holds for the next gesture event;
 *   2. `onTransform` is told once per drawn frame, with the drawn view;
 *   3. the gesture's end draws its last transform before it settles, even if no frame ran;
 *   4. a programmatic `setTransform` supersedes a pending gesture transform (the latest wins);
 *   5. a d3-zoom transition (a double-click zoom) already ticks once per frame and still draws in its own
 *      tick — deferring it to another frame would put the drawn view a frame behind;
 *   6. `pick` answers against the drawn frame while a transform is pending.
 */

const W = 240;
const H = 180;
const hosts: HTMLElement[] = [];
function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

/** Stands in for `requestAnimationFrame` while installed: frames run only when {@link flushFrames} says. */
const queued = new Map<number, FrameRequestCallback>();
let nextId = 0;
let restore: (() => void) | null = null;
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

/** Counts renders and gesture boundaries; exposes the drawn view. */
class ProbePlot extends Plot {
  renders = 0;
  interactingCalls = 0;
  constructor(el: HTMLElement, opts: PlotOptions) {
    super(el, opts);
  }
  override render(): this {
    this.renders++;
    return super.render();
  }
  protected override setInteracting(v: boolean): void {
    this.interactingCalls++;
    super.setInteracting(v);
  }
  get view(): ViewTransform {
    return { ...this.transform };
  }
}

async function chart(): Promise<{ el: HTMLElement; c: ProbePlot }> {
  const el = host();
  const c = new ProbePlot(el, { width: W, height: H, backend: "webgl" });
  await c.whenReady();
  c.points("pts", [{ x: 40, y: 40 }, { x: 200, y: 140 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "#333", hover: true });
  return { el, c };
}

function wheel(el: HTMLElement, x: number, y: number, deltaY = -60): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + x, clientY: r.top + y, deltaY, bubbles: true, cancelable: true }));
}

const gesture = (el: HTMLElement): ViewTransform => {
  const t = zoomTransform(el);
  return { k: t.k, x: t.x, y: t.y };
};

async function until(done: () => boolean, maxMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!done() && performance.now() - t0 < maxMs) await new Promise((res) => setTimeout(res, 20));
}

describe("pan/zoom input draws once per animation frame (#367)", () => {
  it("a wheel burst renders nothing until the frame, then once, at the latest transform", async () => {
    const { el, c } = await chart();
    const told: ViewTransform[] = [];
    c.enableZoom([0.5, 40], (t) => told.push({ ...t }));
    told.length = 0; // enableZoom reports its starting view once (#309)
    holdFrames();
    const before = c.renders;
    for (let i = 0; i < 8; i++) wheel(el, 60 + 10 * i, 50 + 5 * i);
    expect(c.renders - before, "a wheel event rendered inside its handler").toBe(0);
    expect(told, "onTransform ran before anything was drawn").toHaveLength(0);
    expect(c.view, "the drawn view moved before the frame").toEqual({ k: 1, x: 0, y: 0 });
    const latest = gesture(el);
    expect(latest.k, "non-vacuity: the burst did not zoom").toBeGreaterThan(1);

    flushFrames();
    expect(c.renders - before, "one frame, one render").toBe(1);
    expect(c.view, "the frame did not draw the latest transform").toEqual(latest);
    expect(told, "onTransform must be told the drawn view, once per frame").toEqual([latest]);

    flushFrames(); // nothing pending: no further render
    expect(c.renders - before).toBe(1);
    c.destroy();
  });

  it("a pan's mouse moves draw once per frame, and the release draws nothing new", async () => {
    const { el, c } = await chart();
    c.enableZoom([0.5, 40]);
    holdFrames();
    const r = el.getBoundingClientRect();
    const mouse = (target: EventTarget, type: string, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, view: window }));
    const before = c.renders;
    mouse(el, "mousedown", 120, 90);
    for (let i = 1; i <= 6; i++) mouse(window, "mousemove", 120 - 5 * i, 90 + 3 * i);
    expect(c.renders - before, "a pan move rendered inside its handler").toBe(0);
    flushFrames();
    expect(c.renders - before).toBe(1);
    expect(c.view).toEqual(gesture(el));
    expect(c.view.x).toBe(-30);
    mouse(window, "mouseup", 90, 108);
    expect(c.renders - before, "the release re-drew a transform already drawn").toBe(1);
    c.destroy();
  });

  it("the gesture's end draws its last transform before it settles, even if no frame ran", async () => {
    const { el, c } = await chart();
    c.enableZoom([0.5, 40]);
    holdFrames(); // frames never run on their own below
    for (let i = 0; i < 4; i++) wheel(el, 120, 90);
    expect(c.interactingCalls).toBe(1);
    await until(() => c.interactingCalls === 2); // d3-zoom ends a wheel gesture once it goes idle (150 ms)
    expect(c.interactingCalls).toBe(2);
    expect(c.view, "the gesture settled on a stale view").toEqual(gesture(el));
    c.destroy();
  });

  it("a programmatic setTransform supersedes a pending gesture transform", async () => {
    const { el, c } = await chart();
    c.enableZoom([0.5, 40]);
    holdFrames();
    for (let i = 0; i < 4; i++) wheel(el, 120, 90);
    const set = { k: 3, x: -50, y: -40 };
    c.setTransform(set);
    flushFrames();
    expect(c.view, "a stale gesture frame overwrote the programmatic view").toEqual(set);
    expect(gesture(el), "d3-zoom went stale (#202)").toEqual(set);
    c.destroy();
  });

  it("a double-click zoom transition draws each tick in its own frame", async () => {
    const { el, c } = await chart();
    const told: { t: ViewTransform; latest: ViewTransform }[] = [];
    c.enableZoom([0.5, 40], (t) => told.push({ t: { ...t }, latest: gesture(el) }));
    told.length = 0;
    holdFrames(); // the engine's own frames never run: a tick that deferred its draw would never draw
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("dblclick", { clientX: r.left + 120, clientY: r.top + 90, bubbles: true, button: 0, view: window }));
    await until(() => c.interactingCalls === 2, 3000); // the transition ends
    // A deferred tick would only be drawn by the end's flush: one report. Drawn in its own tick: one per tick.
    expect(told.length, "a transition tick did not draw in its own frame").toBeGreaterThanOrEqual(2);
    for (const { t, latest } of told) expect(t, "a tick drew a transform other than its own").toEqual(latest);
    expect(c.view.k).toBeCloseTo(2, 6);
    c.destroy();
  });

  it("pick answers against the drawn frame while a transform is pending", async () => {
    const { el, c } = await chart();
    c.enableZoom([0.5, 40]);
    holdFrames();
    expect(c.pick(40, 40)?.id, "non-vacuity: the point is not under the cursor").toBe(0);
    for (let i = 0; i < 6; i++) wheel(el, 200, 140);
    expect(c.pick(40, 40)?.id, "pick answered against a view that is not drawn yet").toBe(0);
    flushFrames();
    expect(c.pick(40, 40), "pick kept answering against the old view after it was redrawn").toBeNull();
    c.destroy();
  });
});
