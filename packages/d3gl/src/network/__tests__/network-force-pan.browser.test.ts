import { describe, it, expect } from "vitest";
import { Network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { geoMercator } from "d3-geo";
import { Plot } from "../../map/plot.js";
import { GeoMap } from "../../map/geo-map.js";
import type { HoverHit } from "../../map/base-engine.js";
import type { BackendType } from "../../map/backend-factory.js";
import type { ViewTransform } from "../../core/index.js";
import type { PanModifier } from "../../map/pan-modifier.js";

/**
 * Force-pan modifier (#178). With node-drag on, a press that lands on a node grabs it — so on a dense
 * graph, where nearly every press lands on a node, you can barely pan. Holding the platform's command
 * key (⌘ on Apple platforms, Ctrl elsewhere) makes the drag ALWAYS pan, even over a node.
 *
 * Driven by the gesture a browser really fires for a mouse drag: each pointer event followed by its
 * compatibility mouse event. Node-drag listens to the pointer events and d3-zoom to the mouse events,
 * so both gates run — and they must agree about who owns the gesture.
 *
 * The platform is detected once and hard-coded (`PAN_MODIFIER`). The probe subclasses override the
 * protected field instead, so BOTH platforms' behaviour runs on whatever machine runs the tests.
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;left:0;top:0;width:200px;height:200px";
  document.body.appendChild(el);
  return el;
}

/** A network whose force-pan key is fixed, and which counts the draggable hit-tests it runs, the
 *  gesture boundaries it opens and the vector re-bakes a gesture end costs. */
class NetworkProbe extends Network {
  protected override readonly panModifier: PanModifier;
  draggablePicks = 0;
  /** Every `setInteracting(true)`: each clears hover, re-pushes hideOnInteraction layers, snapshots the
   *  pass-through surface and releases a streaming fit-on-layout. */
  gestureStarts = 0;
  /** {@link Network.syncScreenGeometry} calls — a gesture end runs one, and on Canvas/SVG it is a full
   *  re-registration of the network Scene (O(drawn nodes + edges)). */
  screenSyncs = 0;
  constructor(h: HTMLElement, modifier: PanModifier, backend?: BackendType) {
    super(h, backend ? { width: 200, height: 200, backend } : { width: 200, height: 200 });
    this.panModifier = modifier;
  }
  protected override pickDraggable(x: number, y: number): HoverHit | null {
    this.draggablePicks++;
    return super.pickDraggable(x, y);
  }
  protected override setInteracting(v: boolean): void {
    if (v) this.gestureStarts++;
    super.setInteracting(v);
  }
  override syncScreenGeometry(): this {
    this.screenSyncs++;
    return super.syncScreenGeometry();
  }
  resetCounters(): void { this.draggablePicks = this.gestureStarts = this.screenSyncs = 0; }
  /** The engine's live view transform (what is drawn). */
  viewTransform(): ViewTransform { return { ...this.transform }; }
}

class PlotProbe extends Plot {
  protected override readonly panModifier: PanModifier;
  constructor(h: HTMLElement, modifier: PanModifier) {
    super(h, { width: 200, height: 200 });
    this.panModifier = modifier;
  }
  viewTransform(): ViewTransform { return { ...this.transform }; }
}

class GeoMapProbe extends GeoMap {
  protected override readonly panModifier: PanModifier;
  constructor(h: HTMLElement, modifier: PanModifier) {
    super(h, { width: 200, height: 200, projection: geoMercator().scale(30).translate([100, 100]) });
    this.panModifier = modifier;
  }
  viewTransform(): ViewTransform { return { ...this.transform }; }
}

const held = (m: PanModifier): EventModifierInit => (m === "metaKey" ? { metaKey: true } : { ctrlKey: true });
const label = (m: PanModifier) => (m === "metaKey" ? "⌘" : "Ctrl");

/** A mouse drag along `path` (host CSS px) with modifiers `mods`, as a browser dispatches it: pointer +
 *  mouse down on the host, then each move/up (the move/up listeners of node-drag, the marquee and
 *  d3-zoom all live on `window`). A one-point path is a click. */
function gesture(h: HTMLElement, path: [number, number][], mods: EventModifierInit = {}): void {
  const r = h.getBoundingClientRect();
  const at = (x: number, y: number): MouseEventInit => ({ clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, view: window, ...mods });
  const pointer = (type: string, x: number, y: number) => h.dispatchEvent(new PointerEvent(type, { ...at(x, y), pointerId: 1 }));
  const [x0, y0] = path[0] ?? [0, 0];
  pointer("pointerdown", x0, y0);
  h.dispatchEvent(new MouseEvent("mousedown", at(x0, y0)));
  let last: [number, number] = [x0, y0];
  for (const p of path.slice(1)) {
    pointer("pointermove", p[0], p[1]);
    window.dispatchEvent(new MouseEvent("mousemove", at(p[0], p[1])));
    last = p;
  }
  pointer("pointerup", last[0], last[1]);
  window.dispatchEvent(new MouseEvent("mouseup", at(last[0], last[1])));
}

/** Nodes 0..2 at (40,40) (100,100) (160,160), radius 8, world == screen, zoom + drag + multi-select on. */
async function setup(modifier: PanModifier, backend?: BackendType): Promise<{ h: HTMLElement; net: NetworkProbe; g: NetworkGraph }> {
  const h = host();
  const net = new NetworkProbe(h, modifier, backend);
  await net.whenReady();
  const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
  net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 100, 100, 160, 160]) });
  net.setTransform({ k: 1, x: 0, y: 0 });
  net.enableZoom([0.2, 8]);
  net.interactive({ draggable: true, selectable: { multi: true } });
  return { h, net, g };
}

/** The graph's own positions array — the engine writes a dragged node's position into it. */
const xy = (g: NetworkGraph, i: number): [number, number] => [g.positions[i * 2] ?? NaN, g.positions[i * 2 + 1] ?? NaN];
const ids = (net: Network) => net.selection().map((s) => Number(s.id)).sort((a, b) => a - b);
/** Let d3-zoom's wheel-idle timer (150 ms) end its gesture before the engine is torn down. */
const wheelIdle = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
/** Outlast d3-zoom's 250 ms dblclick zoom transition. */
const dblclickDone = () => new Promise<void>((resolve) => setTimeout(resolve, 400));
function dblclick(h: HTMLElement, x: number, y: number, mods: EventModifierInit = {}): void {
  const r = h.getBoundingClientRect();
  h.dispatchEvent(new MouseEvent("dblclick", { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, view: window, ...mods }));
}

describe("force-pan modifier (#178)", () => {
  for (const modifier of ["metaKey", "ctrlKey"] as const) {
    it(`${label(modifier)}-drag starting ON a node pans and never grabs it`, async () => {
      const { h, net, g } = await setup(modifier);
      gesture(h, [[40, 40], [0, 20]], held(modifier)); // press on node 0, drag by (−40, −20)
      expect(net.viewTransform()).toEqual({ k: 1, x: -40, y: -20 }); // panned by the drag
      expect(xy(g, 0)).toEqual([40, 40]); // node 0 not grabbed
      expect(net.selection()).toEqual([]); // and not click-selected either
      // The modifier is read BEFORE the hit-test: a force-pan press costs no pick at all.
      expect(net.draggablePicks).toBe(0);
      net.destroy();
    });

    it(`${label(modifier)}-drag on empty space still pans`, async () => {
      const { h, net, g } = await setup(modifier);
      gesture(h, [[190, 10], [150, 30]], held(modifier));
      expect(net.viewTransform()).toEqual({ k: 1, x: -40, y: 20 });
      expect(xy(g, 0)).toEqual([40, 40]);
      net.destroy();
    });

    it(`${label(modifier)}-click on a node still toggles it in the multi-selection (no pan, no move)`, async () => {
      const { h, net, g } = await setup(modifier);
      net.select("nodes", [0]);
      gesture(h, [[100, 100]], held(modifier)); // click node 1 → added
      expect(ids(net)).toEqual([0, 1]);
      gesture(h, [[40, 40]], held(modifier)); // click node 0 → toggled off
      expect(ids(net)).toEqual([1]);
      expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
      expect(xy(g, 0)).toEqual([40, 40]);
      expect(xy(g, 1)).toEqual([100, 100]);
      net.destroy();
    });

    for (const backend of ["webgl", "canvas", "svg"] as const) {
      it(`${label(modifier)}-click on a node opens NO gesture on ${backend}: no re-bake, no fit release`, async () => {
        // The multi-select click is let through to d3-zoom now (it no longer grabs), and d3-zoom starts a
        // gesture on every admitted mousedown. A press that never moves the view must not pay the gesture
        // boundary — on Canvas/SVG its end re-registers the whole network Scene, and its start releases
        // a streaming fit-on-layout.
        const { h, net, g } = await setup(modifier, backend);
        net.resetCounters();
        gesture(h, [[100, 100]], held(modifier));
        expect(net.gestureStarts).toBe(0);
        expect(net.screenSyncs).toBe(0);
        expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
        expect(xy(g, 1)).toEqual([100, 100]);
        // The toggle itself is pinned on WebGL above; this fixture's Canvas/SVG click-pick does not select
        // even without a modifier, so it is not asserted there.
        if (backend === "webgl") expect(ids(net)).toEqual([1]);
        net.destroy();
      });

      it(`${label(modifier)}-drag on a node pans on ${backend}, as ONE gesture`, async () => {
        const { h, net, g } = await setup(modifier, backend);
        net.resetCounters();
        gesture(h, [[40, 40], [20, 30], [0, 20]], held(modifier));
        expect(net.viewTransform()).toEqual({ k: 1, x: -40, y: -20 });
        expect(xy(g, 0)).toEqual([40, 40]);
        expect(net.gestureStarts).toBe(1); // opened on the first move, not once per move
        expect(net.screenSyncs).toBe(1); // and re-baked once, at its end
        net.destroy();
      });
    }

    it(`plain drag is unchanged (${label(modifier)} platform): on a node it grabs, on empty space it pans`, async () => {
      const { h, net, g } = await setup(modifier);
      gesture(h, [[40, 40], [90, 70]]); // plain drag on node 0 → the node follows, the view stays
      expect(xy(g, 0)[0]).toBeCloseTo(90, 3);
      expect(xy(g, 0)[1]).toBeCloseTo(70, 3);
      expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
      gesture(h, [[190, 10], [150, 10]]); // plain drag on empty space → pans, no node moves
      expect(net.viewTransform()).toEqual({ k: 1, x: -40, y: 0 });
      expect(xy(g, 1)).toEqual([100, 100]);
      net.destroy();
    });

    it(`wheel zoom never hit-tests, with or without ${label(modifier)} held`, async () => {
      // d3-zoom runs its filter on EVERY wheel tick — the zoom path — so the pan/grab gate must reject a
      // wheel before it reaches the draggable hit-test (on a lane with link picking, a miss there is a
      // synchronous GPU readback). Deterministic signature: zero draggable picks across the sweep.
      const { h, net } = await setup(modifier);
      const r = h.getBoundingClientRect();
      for (let i = 0; i < 16; i++) {
        const mods = i % 2 ? held(modifier) : {};
        h.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + 40, clientY: r.top + 40, deltaY: -30, bubbles: true, cancelable: true, ...mods }));
      }
      expect(net.viewTransform().k).toBeGreaterThan(1); // the sweep really zoomed (over node 0)
      expect(net.draggablePicks).toBe(0);
      // Control: a plain press on the node does hit-test — the counter sees the gate.
      await wheelIdle();
      gesture(h, [[40, 40]]);
      expect(net.draggablePicks).toBeGreaterThan(0);
      net.destroy();
    });
  }

  it("a plain click on empty space opens no gesture either (it used to re-bake a Canvas network)", async () => {
    const { h, net } = await setup("metaKey", "canvas");
    net.resetCounters();
    gesture(h, [[190, 10]]);
    expect(net.gestureStarts).toBe(0);
    expect(net.screenSyncs).toBe(0);
    expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
    net.destroy();
  });

  it("Ctrl+dblclick still does not zoom where Ctrl is the pan key (only a Ctrl PRESS is re-admitted)", async () => {
    const { h, net } = await setup("ctrlKey");
    dblclick(h, 190, 10, { ctrlKey: true });
    await dblclickDone();
    expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
    dblclick(h, 190, 10); // control: a plain dblclick does zoom
    await dblclickDone();
    expect(net.viewTransform().k).toBeCloseTo(2, 6);
    net.destroy();
  });

  it("Ctrl on a ⌘ platform does not force-pan (macOS ctrl-click opens the context menu) — nor grab", async () => {
    const { h, net, g } = await setup("metaKey");
    gesture(h, [[40, 40], [0, 20]], { ctrlKey: true });
    expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
    expect(xy(g, 0)).toEqual([40, 40]);
    net.destroy();
  });

  it("shift+drag still draws the marquee and ⇧⌥ subtracts — neither pans nor grabs", async () => {
    const { h, net, g } = await setup("metaKey");
    gesture(h, [[20, 20], [120, 120]], { shiftKey: true }); // box over nodes 0 and 1 → added
    expect(ids(net)).toEqual([0, 1]);
    gesture(h, [[20, 20], [60, 60]], { shiftKey: true, altKey: true }); // box over node 0 → subtracted
    expect(ids(net)).toEqual([1]);
    expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
    expect(xy(g, 0)).toEqual([40, 40]);
    net.destroy();
  });

  it("⌥ alone is not a pan key: a ⌥-drag on a node still grabs it (⌥ means subtract, for the marquee)", async () => {
    const { h, net, g } = await setup("metaKey");
    gesture(h, [[40, 40], [90, 70]], { altKey: true });
    expect(xy(g, 0)[0]).toBeCloseTo(90, 3);
    expect(net.viewTransform()).toEqual({ k: 1, x: 0, y: 0 });
    net.destroy();
  });

  it("plot() shares the gate: Ctrl-drag pans on a Ctrl platform (it used to be refused)", async () => {
    const h = host();
    const chart = new PlotProbe(h, "ctrlKey");
    await chart.whenReady();
    chart.points("pts", [{ x: 40, y: 40 }, { x: 100, y: 100 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "#333" });
    chart.setTransform({ k: 1, x: 0, y: 0 });
    chart.enableZoom([0.2, 8]);
    gesture(h, [[40, 40], [0, 20]], { ctrlKey: true });
    expect(chart.viewTransform()).toEqual({ k: 1, x: -40, y: -20 });
    chart.destroy();
  });

  it("a flat-projection geoMap() shares the gate too: Ctrl-drag pans on a Ctrl platform", async () => {
    const h = host();
    const map = new GeoMapProbe(h, "ctrlKey");
    await map.whenReady();
    map.setTransform({ k: 1, x: 0, y: 0 });
    map.enableZoom([0.2, 8]); // Mercator is flat → d3-zoom affine pan/zoom (a sphere would rotate)
    gesture(h, [[40, 40], [0, 20]], { ctrlKey: true });
    expect(map.viewTransform()).toEqual({ k: 1, x: -40, y: -20 });
    map.destroy();
  });
});
