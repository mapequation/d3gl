import { describe, it, expect, afterEach } from "vitest";
import { zoomTransform } from "d3-zoom";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ViewTransform } from "../../core/index.js";

/**
 * Streaming `layout({ fit: true })` with zoom enabled (#327, #309).
 *
 * The bug: the fit's own d3-zoom re-seed (`fitViewToLayout` → `syncZoomToView` → `behavior.transform`)
 * made d3-zoom emit `start`/`end`, and the engine treated them as a user gesture — `setInteracting(true)`
 * released the fit on the FIRST frame, so the camera froze on the seed while the layout grew past it,
 * and on Canvas/SVG every programmatic view change paid a full Scene rebuild at the fake gesture's end.
 * With LOD off the fit box was also computed once from the seed and held, so it could not follow the
 * layout either.
 *
 * Guarded here, through the real d3-zoom wiring on a real host:
 *   1. a programmatic view change is not a gesture on any backend — `setInteracting` and
 *      `syncScreenGeometry` run 0 times — while a real wheel gesture still is;
 *   2. the camera follows the streaming layout frame after frame and ends framed tightly on the settled
 *      leaves, LOD on and off;
 *   3. a real wheel gesture, or an explicit `setTransform` (the Navigator's zoom-to: `setTransform` then
 *      re-`enableZoom`, #202), hands the view over for good — neither a later frame nor the settle
 *      reframes away from it, and d3-zoom stays in step with the view.
 */

const W = 400;
const H = 300;
const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}
afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

/** Counts the gesture-boundary hooks, and exposes the view, without reaching into privates. */
class ProbeNetwork extends Network {
  interactingCalls = 0;
  screenSyncs = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  protected override setInteracting(v: boolean): void {
    this.interactingCalls++;
    super.setInteracting(v);
  }
  override syncScreenGeometry(): this {
    this.screenSyncs++;
    return super.syncScreenGeometry();
  }
  get view(): ViewTransform {
    return { ...this.transform };
  }
}

/** A connected random graph: a ring plus random chords — spreads into a disc under the force layout. */
function randomGraph(n: number, seed: number): NetworkGraph {
  let s = seed >>> 0;
  const rand = (): number => ((s = Math.imul(1664525, s) + 1013904223), (s >>> 0) / 0x100000000);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push(Math.floor(rand() * n));
  }
  return buildGraph({ nodeCount: n, source, target });
}

/** The exact bounding box of the leaves, mapped through `t`: its longest side / the shorter view side, and its centre. */
function framing(graph: NetworkGraph, t: ViewTransform): { fill: number; cx: number; cy: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const p = graph.positions;
  for (let i = 0; i < graph.nodeCount; i++) {
    const x = p[2 * i] ?? 0;
    const y = p[2 * i + 1] ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    fill: (t.k * Math.max(maxX - minX, maxY - minY)) / Math.min(W, H),
    cx: t.k * ((minX + maxX) / 2) + t.x,
    cy: t.k * ((minY + maxY) / 2) + t.y,
  };
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sample the view on every animation frame until `done` resolves; returns the distinct scales seen. */
async function sampleUntil(net: ProbeNetwork, done: Promise<void>): Promise<number[]> {
  let settled = false;
  void done.then(() => { settled = true; });
  const ks: number[] = [];
  while (!settled) {
    await nextFrame();
    const k = net.view.k;
    if (ks.length === 0 || Math.abs(k - (ks[ks.length - 1] ?? 0)) > 1e-9) ks.push(k);
  }
  return ks;
}

/** Wait until the view has changed `times` times (the stream is running and the fit is following it). */
async function framesStreamed(net: ProbeNetwork, times: number): Promise<void> {
  let prev = net.view.k;
  let changes = 0;
  for (let f = 0; f < 600 && changes < times; f++) {
    await nextFrame();
    const k = net.view.k;
    if (Math.abs(k - prev) > 1e-9) changes++;
    prev = k;
  }
  expect(changes, "the streamed layout never moved the fitted view").toBeGreaterThanOrEqual(times);
}

function wheel(host: HTMLElement, deltaY: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + W / 2, clientY: r.top + H / 2, deltaY, bubbles: true, cancelable: true }));
}

describe("a programmatic view change is not a gesture (#309)", () => {
  for (const backend of ["webgl", "canvas", "svg"] as const) {
    it(`${backend}: enableZoom + setTransform run no gesture boundary; a wheel still does`, async () => {
      const host = makeHost();
      const net = new ProbeNetwork(host, { width: W, height: H, backend });
      await net.whenReady();
      const graph = randomGraph(200, 7);
      net.data(graph).style({ sizeMode: "screen", linkStyle: "half-arrow" }).layout({ backend: "force", iterations: 50 });

      net.enableZoom([0.05, 40]);
      expect(net.interactingCalls, "enableZoom's own seed ran a gesture boundary").toBe(0);

      for (const t of [{ k: 2, x: 10, y: 10 }, { k: 0.5, x: -20, y: 30 }, { k: 1.25, x: 5, y: -5 }]) {
        net.setTransform(t);
        expect(zoomTransform(host), "d3-zoom went stale after a programmatic setTransform (#202)").toMatchObject(t);
      }
      expect(net.interactingCalls, "a programmatic setTransform ran a gesture boundary").toBe(0);
      expect(net.screenSyncs, "a programmatic setTransform re-baked the vector scene").toBe(0);

      // A real wheel gesture is still a gesture: it starts at once and ends when the wheel goes idle.
      wheel(host, -120);
      expect(net.interactingCalls).toBe(1);
      await sleep(250);
      expect(net.interactingCalls).toBe(2);
      expect(net.screenSyncs).toBe(1); // the gesture's end re-bakes the vector scene, as before
      net.destroy();
    });
  }
});

describe("streaming fit with zoom enabled (#327)", () => {
  for (const lod of [false, true]) {
    it(`follows the layout frame by frame and ends framed tightly on the settled leaves (LOD ${lod ? "on" : "off"})`, async () => {
      const host = makeHost();
      const net = new ProbeNetwork(host, { width: W, height: H, backend: "webgl" });
      await net.whenReady();
      const graph = randomGraph(3000, 11);
      net.data(graph);
      if (lod) net.lod({});
      net.enableZoom([0.001, 100]);
      net.layout({ backend: "worker", fit: true, iterations: 300 });
      const ks = await sampleUntil(net, net.whenSettled());
      await nextFrame();

      // The camera kept following the converging layout — it was not released by its own re-seed.
      expect(ks.length, `the fitted view froze (distinct scales seen: ${ks.length})`).toBeGreaterThanOrEqual(5);
      expect(net.interactingCalls, "the fit's re-seed ran a gesture boundary").toBe(0);

      // …and the settle framed the final leaves tightly: their box fills the fit's 85% (less the glyph
      // pad), centred — not the median-extent box that framed the layout 1.6-4.3× too loose.
      const f = framing(graph, net.view);
      expect(f.fill).toBeGreaterThan(0.8);
      expect(f.fill).toBeLessThan(0.86);
      expect(Math.abs(f.cx - W / 2)).toBeLessThan(1);
      expect(Math.abs(f.cy - H / 2)).toBeLessThan(1);
      expect(zoomTransform(host)).toMatchObject(net.view); // d3-zoom seeded to the final frame
      net.destroy();
    });
  }

  it("a real wheel gesture mid-stream hands the view to the user — no later frame or settle reframes it", async () => {
    const host = makeHost();
    const net = new ProbeNetwork(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const graph = randomGraph(3000, 13);
    net.data(graph).enableZoom([0.001, 100]);
    net.layout({ backend: "worker", fit: true, iterations: 300 });
    const settled = net.whenSettled();
    await framesStreamed(net, 2);

    wheel(host, -240);
    await sleep(250); // the wheel gesture ends once it goes idle
    const user = net.view;
    await settled;
    await nextFrame();
    expect(net.view).toEqual(user);
    expect(zoomTransform(host)).toMatchObject(user);
    net.destroy();
  });

  it("an explicit setTransform mid-stream (the Navigator's zoom-to + re-enableZoom, #202) keeps its view", async () => {
    const host = makeHost();
    const net = new ProbeNetwork(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const graph = randomGraph(3000, 17);
    net.data(graph).enableZoom([0.001, 100]);
    net.layout({ backend: "worker", fit: true, iterations: 300 });
    const settled = net.whenSettled();
    await framesStreamed(net, 2);

    const target = { k: 0.9, x: 12, y: -8 };
    net.setTransform(target);
    net.enableZoom([0.001, 100]);
    expect(net.interactingCalls).toBe(0);
    await settled;
    await nextFrame();
    expect(net.view).toEqual(target);
    expect(zoomTransform(host)).toMatchObject(target);
    net.destroy();
  });
});
