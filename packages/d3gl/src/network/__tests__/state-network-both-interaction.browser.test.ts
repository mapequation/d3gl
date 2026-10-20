import { describe, it, expect, afterEach } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { NodeRadiusSpec } from "../glyphs.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedCirclesData, InstancedLayer } from "../../core/backend.js";
import { decodeImage, rasterizeSVG, type PixelBuffer } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * Interaction in the state network's both view (#509), where each state node is drawn at its physical node's
 * position plus its packed offset: px in screen mode (the GPU adds it after projecting), world units in world mode
 * (baked into the positions). Hover, click, marquee and a state node drag must hit the state nodes and physical
 * nodes where they are drawn, in both sizeModes and at two zooms. "Drawn" is read from what reaches the WebGL
 * backend: the emitted `nodes` and `phys-container` circles (centres, radii and offsets), projected as the shaders
 * project them.
 *
 * Fixture: 3 physical nodes holding 3, 2 and 1 state nodes, with links between them.
 */

const W = 400;
const H = 300;
const POS = new Float32Array([40, 40, 110, 40, 75, 100]);
const STATE_TO_PHYSICAL = [0, 0, 0, 1, 1, 2];
const S = STATE_TO_PHYSICAL.length;
const P = 3;

/** A new spec object on every call, resolving to the same radii: each state node 6, each physical node 24 (the
 *  physical view's size, which world mode draws the physical nodes at, D5). */
const sizes = (): NodeRadiusSpec => (_value, _index, graph) => (graph.nodeCount === P ? 24 : 6);

function fixture() {
  return buildStateGraph({ stateCount: S, stateToPhysical: STATE_TO_PHYSICAL, source: [0, 1, 3, 2], target: [3, 5, 5, 4], directed: false });
}

/** The last circles emitted per layer name, as the WebGL backend received them. */
function emitSpy() {
  const last = new Map<string, InstancedCirclesData>();
  const origSet = WebGLBackend.prototype.setInstancedLayer;
  const origUpdate = WebGLBackend.prototype.updateInstancedLayer;
  const keep = (layer: InstancedLayer): void => {
    if (layer.primitive === "circles") last.set(layer.name, layer.circles);
  };
  WebGLBackend.prototype.setInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
    keep(layer);
    origSet.call(this, layer);
  };
  WebGLBackend.prototype.updateInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
    keep(layer);
    origUpdate.call(this, layer);
  };
  return {
    last,
    restore: () => {
      WebGLBackend.prototype.setInstancedLayer = origSet;
      WebGLBackend.prototype.updateInstancedLayer = origUpdate;
    },
  };
}

interface Disc { x: number; y: number; r: number }

/** Circle `i` of `c` as drawn, in host px: its centre projected plus its offset (screen mode), its radius in px. */
function drawn(c: InstancedCirclesData | undefined, i: number, k: number, screen: boolean): Disc {
  if (!c) return { x: NaN, y: NaN, r: NaN };
  const off = screen ? c.offsets : undefined;
  return {
    x: (c.centers[2 * i] ?? 0) * k + (off?.[2 * i] ?? 0),
    y: (c.centers[2 * i + 1] ?? 0) * k + (off?.[2 * i + 1] ?? 0),
    r: (c.radii[i] ?? 0) * (screen ? 1 : k),
  };
}

const NO_DISC: Disc = { x: NaN, y: NaN, r: NaN };
const nth = (discs: readonly Disc[], i: number): Disc => discs[i] ?? NO_DISC;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

async function setup(sizeMode: "world" | "screen", k: number) {
  const spy = emitSpy();
  const h = document.createElement("div");
  h.style.width = `${W}px`;
  h.style.height = `${H}px`;
  document.body.appendChild(h);
  const net = network(h, { width: W, height: H, backend: "webgl" });
  await net.whenReady();
  cleanup.push(() => {
    net.destroy();
    h.remove();
    spy.restore();
  });
  const graph = fixture();
  net.style({ sizeMode, nodeRadius: sizes() }).stateNetwork(graph, { view: "both" });
  net.layout({ backend: "positions", positions: POS });
  net.setTransform({ k, x: 0, y: 0 });
  net.interactive({ selectable: { multi: true }, draggable: true, hover: {} });
  net.toPNG();
  const screen = sizeMode === "screen";
  const state = (s: number): Disc => drawn(spy.last.get("nodes"), s, k, screen);
  const physical = (p: number): Disc => drawn(spy.last.get("phys-container"), p, k, screen);
  return { h, net, graph, state, physical };
}

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

/** A point inside physical node `p`'s disc, at `RIM` of its radius, clear of every state node. */
const RIM = 0.96;
function rimPoint(physical: Disc, states: Disc[]): [number, number] | null {
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * 2 * Math.PI;
    const x = physical.x + RIM * physical.r * Math.cos(t), y = physical.y + RIM * physical.r * Math.sin(t);
    if (states.every((d) => Math.hypot(x - d.x, y - d.y) > d.r + 0.1)) return [x, y];
  }
  return null;
}

/** A state node drag as the browser fires it: pointer events, one animation frame per move (#367). */
async function drag(h: HTMLElement, path: [number, number][]): Promise<void> {
  const r = h.getBoundingClientRect();
  const ev = (type: string, x: number, y: number) =>
    h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
  const [x0, y0] = path[0] ?? [0, 0];
  ev("pointerdown", x0, y0);
  let last: [number, number] = [x0, y0];
  for (const p of path.slice(1)) {
    ev("pointermove", p[0], p[1]);
    await frame();
    last = p;
  }
  ev("pointerup", last[0], last[1]);
  await frame();
}

describe("state network both view: interaction hits what is drawn (#509)", () => {
  for (const sizeMode of ["screen", "world"] as const) {
    for (const k of [1, 2.5]) {
      it(`${sizeMode} mode, k = ${k}: hover and click hit the drawn state node and the drawn physical node`, async () => {
        const { h, net, graph, state, physical } = await setup(sizeMode, k);
        const states = Array.from({ length: S }, (_, s) => state(s));
        for (let s = 0; s < S; s++) {
          const d = nth(states, s);
          expect(d.r, `state node ${s} is not drawn`).toBeGreaterThan(0);
          // The centre, and a point inside its rim towards its physical node's edge.
          const hit = net.pick(d.x, d.y);
          expect(hit?.id, `state node ${s} at its drawn centre`).toBe(s);
          expect((hit?.datum as NetworkHit).level).toBe("state");
          expect(net.pick(d.x + 0.7 * d.r, d.y)?.id, `state node ${s} inside its drawn rim`).toBe(s);
        }
        for (let p = 0; p < P; p++) {
          const c = physical(p);
          const at = rimPoint(c, states);
          expect(at, `physical node ${p} has no point clear of its state nodes`).not.toBeNull();
          if (!at) continue;
          const hit = net.pick(at[0], at[1])?.datum as NetworkHit | undefined;
          expect(hit?.level, `physical node ${p} at its drawn rim`).toBe("physical");
          expect(hit?.physical).toBe(p);
          // Just outside the drawn rim, along the same ray: not this physical node.
          const ox = c.x + ((at[0] - c.x) / RIM) * 1.1, oy = c.y + ((at[1] - c.y) / RIM) * 1.1;
          expect((net.pick(ox, oy)?.datum as NetworkHit | undefined)?.physical, `physical node ${p} picked outside its rim`).not.toBe(p);
        }
        // A click on a drawn state node selects it; a hover on it reports it.
        const target = nth(states, 4);
        const hovered: number[] = [];
        net.on("hover", (hit) => hovered.push(Number(hit?.id ?? -1)));
        gesture(h, [[target.x, target.y]]);
        expect(net.selection().map((x) => Number(x.id))).toEqual([4]);
        h.dispatchEvent(new PointerEvent("pointermove", { clientX: h.getBoundingClientRect().left + target.x, clientY: h.getBoundingClientRect().top + target.y, bubbles: true, pointerId: 1 }));
        expect(hovered).toContain(4);
        expect(graph.stateToPhysical[4]).toBe(1);
      });

      it(`${sizeMode} mode, k = ${k}: a marquee selects the state nodes whose drawn centre it covers`, async () => {
        const { h, net, state } = await setup(sizeMode, k);
        const ds = Array.from({ length: S }, (_, s) => state(s));
        // A box around physical node 0's state nodes' drawn centres, and a 1 px box beside one of them.
        const own = [0, 1, 2].map((s) => nth(ds, s));
        const x0 = Math.min(...own.map((d) => d.x)) - 0.5, x1 = Math.max(...own.map((d) => d.x)) + 0.5;
        const y0 = Math.min(...own.map((d) => d.y)) - 0.5, y1 = Math.max(...own.map((d) => d.y)) + 0.5;
        gesture(h, [[x0, y0], [x1, y1]], { shiftKey: true });
        expect(net.selection().map((x) => Number(x.id)).sort((a, b) => a - b)).toEqual([0, 1, 2]);
      });

      it(`${sizeMode} mode, k = ${k}: a state node drag moves it as drawn and holds it inside its physical node`, async () => {
        const { h, net, graph, state, physical } = await setup(sizeMode, k);
        const s = 1;
        const p = graph.stateToPhysical[s] ?? 0;
        const before = state(s);
        // A small move towards its physical node's centre, past the click slop (4 px): the state node follows the
        // pointer, unclamped.
        const home = physical(p);
        const len = Math.hypot(home.x - before.x, home.y - before.y) || 1;
        const ux = (5 * (home.x - before.x)) / len, uy = (5 * (home.y - before.y)) / len;
        const to: [number, number] = [before.x + ux, before.y + uy];
        await drag(h, [[before.x, before.y], to, to]);
        const small = state(s);
        expect(small.x - before.x, "the state node did not follow the pointer").toBeCloseTo(ux, 1);
        expect(small.y - before.y).toBeCloseTo(uy, 1);
        // Far out: clamped inside its physical node, in its drawn size.
        await drag(h, [[small.x, small.y], [small.x + 100, small.y + 5], [small.x + 300, small.y + 10]]);
        const after = state(s);
        const c = physical(p);
        expect(after.x, "the state node did not move").toBeGreaterThan(small.x + 0.5);
        expect(Math.hypot(after.x - c.x, after.y - c.y) + after.r, "the dragged state node left its physical node").toBeLessThanOrEqual(c.r + 1e-3);
        // Picked where it is drawn now.
        expect(net.pick(after.x, after.y)?.id).toBe(s);
        // The physical layout did not move.
        expect(Array.from(graph.physical.positions)).toEqual(Array.from(POS));
      });
    }
  }

  it("a style() call with a new but equal nodeRadius spec keeps a dragged state node where it was dropped", async () => {
    const { h, net, state } = await setup("world", 1);
    net.style({ nodeRadius: sizes() }); // the same radii from a new spec: the packing is kept
    net.toPNG();
    const before = state(1);
    await drag(h, [[before.x, before.y], [before.x + 6, before.y], [before.x + 6, before.y]]);
    const dropped = state(1);
    expect(Math.hypot(dropped.x - before.x, dropped.y - before.y), "the drag did not move the state node").toBeGreaterThan(1);
    net.style({ nodeRadius: sizes() }); // a new spec object, resolving to the same radii
    net.toPNG();
    const kept = state(1);
    expect([kept.x, kept.y]).toEqual([dropped.x, dropped.y]);
  });
});

type Rgba = readonly [number, number, number, number];
/** The pixel at host px (x, y), as [r, g, b, a]. */
function px(img: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const i = 4 * (Math.round(y) * img.width + Math.round(x));
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0, img.data[i + 3] ?? 0];
}
const isNode = ([r, g, b, a]: Rgba): boolean => a > 200 && r > 200 && g < 90 && b < 90;
const isLink = ([r, g, b, a]: Rgba): boolean => a > 120 && b > 150 && r < 140 && g < 140;
/** Distance from (x, y) to the segment a–b. */
function toSegment(x: number, y: number, a: Disc, b: Disc): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(x - a.x - t * vx, y - a.y - t * vy);
}

const BACKENDS = ["webgl", "canvas", "svg"] as const;
const DRAG_K = 2.5;
const NODE_FILL = "#ff0000";
const LINK = "#0000ff";
const LINK_WIDTH = 3;
/** The dragged state node, and the far end of its one link (1 → 5, physical node 0 → 2). */
const HELD = 1;
const FAR = 5;

describe("state network both view: a state node drag draws where it was dropped, on every backend (#509)", () => {
  for (const sizeMode of ["screen", "world"] as const) {
    it(`${sizeMode} mode: the GPU (in-place offset upload) and the retained Scene (re-baked per move) draw the dropped state node and its link`, async () => {
      // The plan, from what reaches the WebGL backend: the held state node's drawn disc, a drop point inside its
      // physical node clear of every other state node and of where it was, and points on its new link.
      const plan = await setup(sizeMode, DRAG_K);
      const discs = Array.from({ length: S }, (_, s) => plan.state(s));
      const held = nth(discs, HELD);
      const far = nth(discs, FAR);
      const home = plan.physical(plan.graph.stateToPhysical[HELD] ?? 0);
      const others = discs.filter((_, s) => s !== HELD);
      // Of the clear points on its physical node's inner rim, the one farthest from its old link, so the new link
      // runs apart from the old one.
      let drop: Disc | null = null;
      let apart = 0;
      for (let a = 0; a < 128; a++) {
        const t = (a / 128) * 2 * Math.PI, d = home.r - held.r - 0.5;
        const c = { x: home.x + d * Math.cos(t), y: home.y + d * Math.sin(t), r: held.r };
        const clear = Math.hypot(c.x - held.x, c.y - held.y) > 2 * held.r + 2 && others.every((o) => Math.hypot(c.x - o.x, c.y - o.y) > o.r + held.r + 2);
        // Off the line through the old link (not just its segment), so the two links diverge.
        const off = Math.abs((far.x - held.x) * (c.y - held.y) - (far.y - held.y) * (c.x - held.x)) / (Math.hypot(far.x - held.x, far.y - held.y) || 1);
        if (clear && off > apart) {
          apart = off;
          drop = c;
        }
      }
      expect(drop, "no drop point clear of the other state nodes: the fixture is too tight").not.toBeNull();
      if (!drop) return;
      // Points on its new link just past its rim, clear of every other state node, of the physical nodes' rims and of
      // the old link (by its half-width and 2 px): what a link end left behind would not cover. Where the held state
      // node was is not excluded: it must be gone (asserted below).
      const samples: [number, number][] = [];
      const len = Math.hypot(far.x - drop.x, far.y - drop.y);
      const physicals = Array.from({ length: P }, (_, p) => plan.physical(p));
      const half = (LINK_WIDTH * (sizeMode === "screen" ? 1 : DRAG_K)) / 2;
      for (let d = held.r + 3; d < len - far.r - 4 && samples.length < 4; d += 1) {
        const x = drop.x + ((far.x - drop.x) * d) / len, y = drop.y + ((far.y - drop.y) * d) / len;
        if (others.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + 2)) continue;
        if (physicals.some((c) => Math.abs(Math.hypot(x - c.x, y - c.y) - c.r) < 3)) continue;
        if (toSegment(x, y, held, far) < half + 2) continue;
        samples.push([x, y]);
      }
      expect(samples.length, "no point on the new link clear of the rest: the link check is vacuous").toBeGreaterThanOrEqual(2);
      plan.net.destroy();
      plan.h.remove();

      for (const backend of BACKENDS) {
        const h = document.createElement("div");
        h.style.width = `${W}px`;
        h.style.height = `${H}px`;
        document.body.appendChild(h);
        const net = network(h, { width: W, height: H, backend });
        await net.whenReady();
        cleanup.push(() => {
          net.destroy();
          h.remove();
        });
        net
          .style({ sizeMode, nodeRadius: sizes(), nodeFill: NODE_FILL, linkStroke: LINK, linkWidth: LINK_WIDTH })
          .stateNetwork(fixture(), { view: "both" })
          .layout({ backend: "positions", positions: POS });
        net.setTransform({ k: DRAG_K, x: 0, y: 0 });
        net.interactive({ draggable: true });
        // A programmatic setTransform without zoom does not re-bake the retained Scene's screen-mode geometry (D3).
        net.syncScreenGeometry();
        const pixels = (): Promise<PixelBuffer> => (backend === "svg" ? rasterizeSVG(net.toSVG(), W, H) : decodeImage(net.toPNG(), W, H));
        const before = await pixels();
        expect(isNode(px(before, held.x, held.y)), `${backend}: the held state node is not drawn where WebGL draws it`).toBe(true);
        expect(isNode(px(before, drop.x, drop.y)), `${backend}: the drop point is already covered`).toBe(false);

        const r = h.getBoundingClientRect();
        // Pointer and mouse events, as a browser fires them (the mouse ones on the window while held).
        const ev = (type: "down" | "move" | "up", x: number, y: number): void => {
          const at: MouseEventInit = { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, view: window };
          h.dispatchEvent(new PointerEvent(`pointer${type}`, { ...at, pointerId: 1 }));
          (type === "down" ? h : window).dispatchEvent(new MouseEvent(`mouse${type}`, at));
        };
        ev("down", held.x, held.y);
        for (const [x, y] of [[(held.x + drop.x) / 2, (held.y + drop.y) / 2], [drop.x, drop.y], [drop.x, drop.y]] as const) {
          ev("move", x, y);
          await frame();
        }
        // Mid-gesture: the GPU after the in-place offset upload, the retained Scene after the move's re-register.
        const during = await pixels();
        expect(isNode(px(during, drop.x, drop.y)), `${backend} while held: the state node is not drawn where it was dropped`).toBe(true);
        expect(isNode(px(during, held.x, held.y)), `${backend} while held: the state node is still drawn where it was`).toBe(false);
        for (const [x, y] of samples) expect(isLink(px(during, x, y)), `${backend} while held: its link does not follow it at (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(true);
        ev("up", drop.x, drop.y);
        await frame();
        const after = await pixels();
        expect(isNode(px(after, drop.x, drop.y)), `${backend} after the drop: the state node is not where it was dropped`).toBe(true);
        expect(isNode(px(after, held.x, held.y)), `${backend} after the drop: the state node is back where it was`).toBe(false);
        for (const [x, y] of samples) expect(isLink(px(after, x, y)), `${backend} after the drop: its link does not follow it`).toBe(true);
      }
    });
  }
});
