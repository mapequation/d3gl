import { describe, it, expect } from "vitest";
import { Network, type NetworkHit } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import type { HoverHit } from "../../map/base-engine.js";
import type { InstancedHighlight, InstancedLayer, ViewTransform } from "../../core/index.js";
import { PAN_MODIFIER } from "../../map/pan-modifier.js";

/**
 * Hover and select an open module by its boundary ring (#476), through the engine on every backend.
 *
 * The map is placed by hand (`layout({ backend: "positions" })`), so every ring is its module's centroid +
 * extent: module 1 opens into sub-modules 1:1 and 1:2, which open too, and whose rings each meet module
 * 1's ring away from any leaf, so their strokes overlap there; module 2
 * lies far off. Glyphs are screen-sized, so a zoom out crowds them and closes the modules again (#426).
 * The oracle is the export: `toSVG()` draws each ring as a circle on
 * its centreline with its stroke width, and each glyph as a circle, in one `translate(…) scale(k)` group —
 * so every expectation below is derived from what was drawn, not from the code under test.
 */

const W = 400;
const H = 400;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const RING = "#d62728"; // the rings' colour in the export: rgba(214, 39, 40, …)
const MIN_HIT_PX = 6;
const HIGHLIGHT = "rgba(220, 38, 38"; // the default hover / selection ring colour (#dc2626)

// Leaves 0-2: module 1:1, 3-5: 1:2, 6-8: 2:1, 9-11: 2:2.
const MODULES: ModuleNode[] = [];
for (const prefix of [[1, 1], [1, 2], [2, 1], [2, 2]]) for (let l = 1; l <= 3; l++) MODULES.push({ id: MODULES.length, path: [...prefix, l] });
const POSITIONS = new Float32Array([
  40, 10, 40, -10, 46, 0, // 1:1 — its ring meets module 1's off its leaves
  -40, 10, -40, -10, -46, 0, // 1:2
  -10, 600, -10.5, 600.5, -9.5, 599.5, // 2:1, far off: the root opens long before module 1 does
  10, 600, 10.5, 600.5, 9.5, 599.5, // 2:2
]);
const VIEW = { k: 3, x: W / 2, y: H / 2 };
/** Zoomed out until module 1's two sub-modules crowd each other: module 1 collapses, the root stays open. */
const OUT = { k: 0.06, x: W / 2, y: H / 2 };

class Probe extends Network {
  /** The backend's highlight pushes and base-lane layer writes, recorded (typed: no casts). */
  readonly styled: { name: string; h: InstancedHighlight }[] = [];
  readonly written: InstancedLayer[] = [];
  spyBackend(): void {
    const b = this.backend();
    if (!b?.styleInstancedLayer || !b.setInstancedLayer) return;
    const style = b.styleInstancedLayer.bind(b);
    const set = b.setInstancedLayer.bind(b);
    b.styleInstancedLayer = (name, h) => { this.styled.push({ name, h }); style(name, h); };
    b.setInstancedLayer = (layer) => { this.written.push(layer); set(layer); };
    const update = b.updateInstancedLayer?.bind(b);
    if (update) b.updateInstancedLayer = (layer) => { this.written.push(layer); update(layer); };
  }
  draggableAt(x: number, y: number): HoverHit | null {
    return this.pickDraggable(x, y);
  }
  /** The view the next frame draws (a pan's latest transform included). */
  nextView(): ViewTransform {
    return this.latestTransform();
  }
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

async function engine(backend: (typeof BACKENDS)[number], view = VIEW): Promise<{ net: Probe; el: HTMLElement; graph: NetworkGraph }> {
  const el = host();
  const net = new Probe(el, { width: W, height: H, backend });
  await net.whenReady();
  const graph = buildGraph({ nodeCount: 12, source: [0, 1, 3, 4, 6, 9], target: [1, 2, 4, 5, 7, 10], directed: true });
  net
    .data(graph, { modules: MODULES })
    .style({ nodeRadius: 6, sizeMode: "screen", nodeFill: "#7f7f7f", directed: true })
    // Module 1's ring 1 px wide (its hit band widened to 6 px), its sub-modules' 8 px (their own stroke).
    .lod({ expandPx: 30, declutter: false, moduleBoundary: { width: (path) => (path.length === 1 ? 1 : 8), color: RING, opacity: 1 }, aggregateOutline: false })
    .layout({ backend: "positions", positions: POSITIONS });
  net.setTransform(view);
  net.syncScreenGeometry();
  return { net, el, graph };
}

interface Circle { x: number; y: number; r: number; w: number }

/** The rings and glyphs the export drew, in screen px. */
function drawn(net: Network): { rings: Circle[]; glyphs: Circle[] } {
  const svg = new DOMParser().parseFromString(net.toSVG(), "image/svg+xml");
  const rings: Circle[] = [];
  const glyphs: Circle[] = [];
  for (const c of Array.from(svg.querySelectorAll("circle"))) {
    let tx = 0;
    let ty = 0;
    let k = 1;
    for (let p = c.parentElement; p; p = p.parentElement) {
      const m = /translate\(([-\d.e]+),\s*([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(p.getAttribute("transform") ?? "");
      if (m) {
        tx = Number(m[1]);
        ty = Number(m[2]);
        k = Number(m[3]);
        break;
      }
    }
    const circle = { x: tx + k * Number(c.getAttribute("cx")), y: ty + k * Number(c.getAttribute("cy")), r: k * Number(c.getAttribute("r")), w: k * Number(c.getAttribute("stroke-width") ?? 0) };
    if ((c.getAttribute("stroke") ?? "").startsWith("rgba(214, 39, 40")) rings.push(circle);
    else if ((c.getAttribute("fill") ?? "").startsWith("rgba(127, 127, 127")) glyphs.push(circle);
  }
  return { rings, glyphs };
}

const isNetworkHit = (d: unknown): d is NetworkHit => typeof d === "object" && d !== null && "aggregate" in d && "count" in d;
const datumOf = (hit: HoverHit | null): NetworkHit | null => (hit && isNetworkHit(hit.datum) ? hit.datum : null);
const isOpen = (hit: HoverHit | null): boolean => datumOf(hit)?.open === true;

/** Whether a point is inside ring `c`'s hit band — its stroke, widened to {@link MIN_HIT_PX} — by `margin` px. */
function inBand(c: Circle, x: number, y: number, margin: number): boolean {
  const half = Math.max(c.w, MIN_HIT_PX) / 2 - margin;
  return Math.abs(Math.hypot(x - c.x, y - c.y) - c.r) <= half;
}
/** Whether a point is within `pad` px of glyph `c`. */
const nearGlyph = (c: Circle, x: number, y: number, pad: number): boolean => Math.hypot(x - c.x, y - c.y) <= c.r + c.w / 2 + pad;

describe("an open module is picked by its boundary ring on every backend (#476)", () => {
  for (const backend of BACKENDS) {
    it(`${backend}: on the stroke → the module (open); deepest of overlapping strokes; glyphs win; inside the disc → no module`, async () => {
      const { net, el } = await engine(backend);
      const { rings, glyphs } = drawn(net);
      expect(rings.length, "rings drawn: modules 1, 1:1 and 1:2").toBe(3);
      const moduleOf = new Map<number, { id: number; depth: number }>(); // ring index → its module, learnt where it alone is hit
      const multi: { x: number; y: number; rings: number[] }[] = [];
      const counts = { single: 0, overlap: 0, glyph: 0, inside: 0, outside: 0 };
      for (let i = 0; i < rings.length; i++) {
        const c = rings[i]!;
        for (let a = 0; a < 180; a++) {
          const th = (a / 180) * 2 * Math.PI;
          // On the centreline, and 4 px inside / outside the hit band.
          for (const [off, kind] of [[0, "on"], [-(Math.max(c.w, MIN_HIT_PX) / 2 + 4), "inside"], [Math.max(c.w, MIN_HIT_PX) / 2 + 4, "outside"]] as const) {
            const x = c.x + (c.r + off) * Math.cos(th);
            const y = c.y + (c.r + off) * Math.sin(th);
            if (glyphs.some((gl) => nearGlyph(gl, x, y, 12))) {
              // Well inside a glyph drawn over the ring: the glyph wins, drawn above the rings.
              if (kind === "on" && glyphs.some((gl) => Math.hypot(x - gl.x, y - gl.y) < gl.r - 1.5)) {
                const hit = net.pick(x, y);
                expect(hit?.layer).toBe("nodes");
                expect(isOpen(hit), `a glyph over ring ${i} at ${th.toFixed(2)}`).toBe(false);
                counts.glyph++;
              }
              continue;
            }
            const under = rings.flatMap((r, j) => (inBand(r, x, y, -0.75) ? [j] : []));
            const clear = rings.flatMap((r, j) => (inBand(r, x, y, 0.75) ? [j] : []));
            if (under.length !== clear.length) continue; // within a pixel of a band's edge: either answer
            const hit = net.pick(x, y);
            if (under.length === 0) {
              expect(hit?.layer === "nodes", `${kind} ring ${i} at ${th.toFixed(2)}: no module, got ${hit?.id}`).toBe(false);
              counts[kind === "on" ? "outside" : kind]++;
            } else if (under.length === 1) {
              expect(isOpen(hit), `on ring ${i} at ${th.toFixed(2)}`).toBe(true);
              const d = datumOf(hit)!;
              expect(d.aggregate).toBe(true);
              if (hit!.members) expect(hit!.members()).toHaveLength(d.count); // attached where the engine attaches them
              const known = moduleOf.get(under[0]!);
              if (known) expect(hit!.id).toBe(known.id);
              else moduleOf.set(under[0]!, { id: hit!.id as number, depth: d.path?.length ?? 0 });
              counts.single++;
            } else multi.push({ x, y, rings: under });
          }
        }
      }
      expect(moduleOf.size, "every ring was hit somewhere on its own").toBe(3);
      expect(new Set([...moduleOf.values()].map((m) => m.id)).size).toBe(3);
      // Where strokes overlap, the deepest module wins.
      for (const p of multi) {
        const deepest = Math.max(...p.rings.map((j) => moduleOf.get(j)!.depth));
        const winners = p.rings.filter((j) => moduleOf.get(j)!.depth === deepest).map((j) => moduleOf.get(j)!.id);
        const hit = net.pick(p.x, p.y);
        expect(isOpen(hit)).toBe(true);
        expect(winners, `overlap at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).toContain(hit!.id);
        counts.overlap++;
      }
      // Non-vacuous: every case really occurred.
      for (const [kind, n] of Object.entries(counts)) expect(n, `${backend}: ${kind} samples`).toBeGreaterThan(0);
      net.destroy();
      el.remove();
    });
  }

  it("on('hover' | 'click') hand a ring hit to the callbacks, on every backend", async () => {
    for (const backend of BACKENDS) {
      const { net, el } = await engine(backend);
      const { rings } = drawn(net);
      const c = rings.reduce((a, b) => (b.r > a.r ? b : a)); // module 1, the largest ring
      const hovers: (HoverHit | null)[] = [];
      const clicks: (HoverHit | null)[] = [];
      net.on("hover", (h) => hovers.push(h)).on("click", (h) => clicks.push(h));
      const r = el.getBoundingClientRect();
      const at = { clientX: r.left + c.x, clientY: r.top + c.y - c.r, bubbles: true }; // the ring's top
      el.dispatchEvent(new PointerEvent("pointermove", at));
      el.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: 0 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...at, button: 0 }));
      expect(isOpen(hovers.at(-1) ?? null), `${backend}: hover`).toBe(true);
      expect(isOpen(clicks.at(-1) ?? null), `${backend}: click`).toBe(true);
      expect(datumOf(clicks.at(-1) ?? null)?.path, backend).toEqual([1]);
      net.destroy();
      el.remove();
    }
  });
});

describe("hover, selection and tooltip of an open module (WebGL, #476)", () => {
  async function interactive(opts: Parameters<Network["interactive"]>[0]): Promise<{ net: Probe; el: HTMLElement; ring: Circle; at: (x: number, y: number, type?: string) => void }> {
    const { net, el } = await engine("webgl");
    net.interactive(opts);
    const ring = drawn(net).rings.reduce((a, b) => (b.r > a.r ? b : a)); // module 1
    const r = el.getBoundingClientRect();
    const at = (x: number, y: number, type = "pointermove"): void => {
      el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0 }));
    };
    return { net, el, ring, at };
  }
  /** Highlight-coloured circles in the export, in screen px. */
  const highlights = (net: Network): Circle[] => {
    const svg = new DOMParser().parseFromString(net.toSVG(), "image/svg+xml");
    const g = svg.querySelector("g[transform]");
    const m = /translate\(([-\d.e]+),\s*([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(g?.getAttribute("transform") ?? "");
    const [tx, ty, k] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
    return Array.from(svg.querySelectorAll("circle"))
      .filter((c) => (c.getAttribute("stroke") ?? "").startsWith(HIGHLIGHT))
      .map((c) => ({ x: tx + k * Number(c.getAttribute("cx")), y: ty + k * Number(c.getAttribute("cy")), r: k * Number(c.getAttribute("r")), w: k * Number(c.getAttribute("stroke-width") ?? 0) }));
  };

  it("hover rings the module on its boundary ring, shows its tooltip, and re-emits no base geometry", async () => {
    const { net, el, ring, at } = await interactive({ hover: true, tooltip: (d) => `module ${d.path?.join(":")}${d.open ? " (open)" : ""}` });
    net.spyBackend();
    at(ring.x, ring.y - ring.r);
    const tip = el.querySelector(".d3gl-tooltip");
    expect(tip?.textContent).toBe("module 1 (open)");
    // Base layers: nothing written on the hover (a uniform push only); the highlight lane only.
    expect(net.written.filter((l) => !l.name.startsWith("network-highlight")).map((l) => l.name)).toEqual([]);
    expect(net.written.some((l) => l.name.endsWith(":boundary"))).toBe(true);
    // The highlight sits on the ring's circle, at least as wide as the ring.
    const hl = highlights(net);
    expect(hl).toHaveLength(1);
    expect(hl[0]!.x).toBeCloseTo(ring.x, 3);
    expect(hl[0]!.y).toBeCloseTo(ring.y, 3);
    expect(hl[0]!.w).toBeGreaterThanOrEqual(ring.w - 1e-6);
    expect(Math.abs(hl[0]!.r - ring.r)).toBeLessThanOrEqual(hl[0]!.w / 2);
    // Off the ring, inside the disc: no module, no highlight.
    at(ring.x, ring.y - ring.r + 20);
    expect(highlights(net)).toHaveLength(0);
    expect(el.querySelector<HTMLElement>(".d3gl-tooltip")?.style.display).toBe("none");
    net.destroy();
    el.remove();
  });

  it("hover with `others` dimming keeps exactly the open module's drawn members undimmed", async () => {
    const { net, el, ring, at } = await interactive({ hover: { others: { opacity: 0.2 } } });
    net.spyBackend();
    net.setTransform(VIEW); // re-emit the base lane once, recorded, so the test knows its node order
    const nodes = net.written.filter((l) => l.name === "nodes").at(-1);
    const groups = nodes?.primitive === "circles" ? nodes.circles.groups : undefined;
    expect(groups, "the node layer carries its tree ids").toBeDefined();
    at(ring.x, ring.y - ring.r);
    const push = net.styled.filter((s) => s.name === "nodes").at(-1)!.h;
    expect(push.dimActive).toBe(true);
    const [lo, hi] = push.hoverInstances ?? [0, 0];
    const members = Array.from(groups!.subarray(lo, hi)).sort((a, b) => a - b);
    expect(members, "module 1's leaves (0-5), drawn open").toEqual([0, 1, 2, 3, 4, 5]);
    // Off every ring and glyph: the hover and its run clear.
    at(ring.x, ring.y - ring.r + 20);
    expect(net.styled.filter((s) => s.name === "nodes").at(-1)!.h.hoverInstances).toEqual([0, 0]);
    net.destroy();
    el.remove();
  });

  it("pixels: hovering the ring leaves every drawn member opaque, where hovering one member dims the others", async () => {
    const { net, el, ring, at } = await interactive({ hover: { others: { opacity: 0.2 } } });
    const leaves = drawn(net).glyphs; // module 1's six leaves, every glyph in view
    expect(leaves).toHaveLength(6);
    /** How opaque each leaf's centre renders: its coverage of the grey `#7f7f7f` over whatever is behind it
     *  (alpha on a transparent frame, the grey's depth on an opaque one), 0-255. */
    const alphas = async (): Promise<number[]> => {
      const img = new Image();
      img.src = net.toPNG();
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const s = img.width / W;
      return leaves.map((l) => {
        const [r, , , a] = ctx.getImageData(Math.round(l.x * s), Math.round(l.y * s), 1, 1).data;
        return Math.min(a!, Math.round(255 - ((r! - 127) / (255 - 127)) * 255));
      });
    };
    const before = await alphas();
    expect(Math.min(...before), "non-vacuous: the probe reads the opaque glyphs").toBeGreaterThan(200);
    // Control: hovering one leaf dims the other five.
    at(leaves[0]!.x, leaves[0]!.y);
    const one = await alphas();
    expect(one[0]).toBeGreaterThan(200);
    expect(Math.max(...one.slice(1)), "the other members dim on a leaf hover").toBeLessThan(120);
    // The ring: module 1 hovered, all six of its drawn members stay opaque.
    at(ring.x, ring.y - ring.r);
    expect(Math.min(...(await alphas())), "members of the hovered open module").toBeGreaterThan(200);
    net.destroy();
    el.remove();
  });

  it("click selects the module; it keeps its highlight as it collapses and opens again; a click inside the disc clears", async () => {
    const { net, el, ring, at } = await interactive({ selectable: true, selection: { others: { opacity: 0.3 } } });
    const selects: HoverHit[][] = [];
    net.on("select", (hits) => selects.push(hits));
    net.spyBackend();
    at(ring.x, ring.y - ring.r, "pointerdown");
    at(ring.x, ring.y - ring.r, "pointerup");
    const sel = selects.at(-1)!;
    expect(sel).toHaveLength(1);
    expect(datumOf(sel[0]!)?.path).toEqual([1]);
    expect(sel[0]!.members?.()).toHaveLength(6);
    const id = sel[0]!.id;
    expect(net.selection().map((h) => h.id)).toEqual([id]);
    // Drawn on its ring, and its members are flagged selected (so the selection dim leaves them).
    expect(highlights(net).some((h) => Math.abs(h.x - ring.x) < 1e-3 && Math.abs(h.r - ring.r) < 2)).toBe(true);
    const nodes = net.written.filter((l) => l.name === "nodes").at(-1);
    if (nodes?.primitive !== "circles") throw new Error("no node layer written on the selection");
    const flagged = Array.from(nodes.circles.groups ?? []).filter((_, i) => nodes.circles.selected?.[i] === 1).sort((a, b) => a - b);
    expect(flagged).toEqual([0, 1, 2, 3, 4, 5]);
    // Zoomed out, module 1 collapses: still highlighted, now around its glyph.
    net.setTransform(OUT);
    net.syncScreenGeometry();
    expect(drawn(net).rings).toHaveLength(0);
    expect(highlights(net)).toHaveLength(1);
    net.setTransform(VIEW);
    net.syncScreenGeometry();
    expect(highlights(net).some((h) => Math.abs(h.x - ring.x) < 1e-3 && Math.abs(h.r - ring.r) < 2)).toBe(true);
    // A click inside the disc, off every ring and glyph, clears the selection.
    at(ring.x, ring.y - ring.r + 20, "pointerdown");
    at(ring.x, ring.y - ring.r + 20, "pointerup");
    expect(net.selection()).toEqual([]);
    net.destroy();
    el.remove();
  });

});


/** A mouse drag along `path` (host CSS px) with modifiers `mods`, as a browser dispatches it: pointer + mouse
 *  down on the host, then each move / up on `window` (where node-drag and d3-zoom listen). One point: a click. */
function gesture(el: HTMLElement, path: [number, number][], mods: EventModifierInit = {}): void {
  const r = el.getBoundingClientRect();
  const at = (x: number, y: number): MouseEventInit => ({ clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, view: window, ...mods });
  const pointer = (type: string, x: number, y: number): void => void el.dispatchEvent(new PointerEvent(type, { ...at(x, y), pointerId: 1 }));
  const [x0, y0] = path[0] ?? [0, 0];
  pointer("pointerdown", x0, y0);
  el.dispatchEvent(new MouseEvent("mousedown", at(x0, y0)));
  let last: [number, number] = [x0, y0];
  for (const p of path.slice(1)) {
    pointer("pointermove", p[0], p[1]);
    window.dispatchEvent(new MouseEvent("mousemove", at(p[0], p[1])));
    last = p;
  }
  pointer("pointerup", last[0], last[1]);
  window.dispatchEvent(new MouseEvent("mouseup", at(last[0], last[1])));
}

/** Each leaf's move since `before`, in world units. */
function moves(graph: NetworkGraph, before: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < graph.nodeCount; i++) out.push([graph.positions[2 * i]! - before[2 * i]!, graph.positions[2 * i + 1]! - before[2 * i + 1]!]);
  return out;
}

const MODULE_1 = [0, 1, 2, 3, 4, 5]; // module 1's leaves
const DRAG: [number, number] = [12, 9]; // the drag, in screen px

describe("drag an open module by its boundary ring (#479), on every backend", () => {
  async function draggable(backend: (typeof BACKENDS)[number], view = VIEW) {
    const { net, el, graph } = await engine(backend, view);
    net.interactive({ draggable: true, selectable: true }).enableZoom([0.01, 50]);
    const clicks: (HoverHit | null)[] = [];
    net.on("click", (h) => clicks.push(h));
    return { net, el, graph, clicks };
  }
  /** Drag from (x, y) by {@link DRAG}; returns each leaf's move scaled to screen px at `k`, and the view's pan. */
  function dragFrom(net: Probe, el: HTMLElement, graph: NetworkGraph, x: number, y: number, mods: EventModifierInit = {}) {
    const before = graph.positions.slice();
    const t0 = net.nextView();
    gesture(el, [[x, y], [x + DRAG[0] / 2, y], [x + DRAG[0], y + DRAG[1]]], mods);
    const t1 = net.nextView();
    return { px: moves(graph, before).map(([dx, dy]) => [dx * t0.k, dy * t0.k]), pan: [t1.x - t0.x, t1.y - t0.y] };
  }

  for (const backend of BACKENDS) {
    it(`${backend}: a drag from a ring moves the module's leaves as the same drag of the collapsed module does`, async () => {
      // Open (VIEW): grab module 1 by the top of its ring.
      const open = await draggable(backend);
      const ring = drawn(open.net).rings.reduce((a, b) => (b.r > a.r ? b : a));
      const grab = open.net.draggableAt(ring.x, ring.y - ring.r);
      expect(isOpen(grab), "the ring grabs").toBe(true);
      expect(datumOf(grab)?.path).toEqual([1]);
      const byRing = dragFrom(open.net, open.el, open.graph, ring.x, ring.y - ring.r);
      expect(byRing.pan, "the view did not pan").toEqual([0, 0]);
      expect(open.clicks, "a drag is not a click").toHaveLength(0);

      // Collapsed (OUT): grab module 1's glyph. The reference is the WebGL drag: on Canvas/SVG a collapsed
      // glyph's hit lists its tree id as its only member, so that drag moves no leaf (#481).
      const shut = await draggable("webgl", OUT);
      expect(drawn(shut.net).rings, "module 1 collapsed: no ring drawn").toHaveLength(0);
      const glyph = drawn(shut.net).glyphs.find((c) => shut.net.draggableAt(c.x, c.y)?.id === grab?.id);
      if (!glyph) throw new Error("module 1's collapsed glyph not found");
      expect(isOpen(shut.net.draggableAt(glyph.x, glyph.y))).toBe(false);
      const byGlyph = dragFrom(shut.net, shut.el, shut.graph, glyph.x, glyph.y);
      expect(byGlyph.pan).toEqual([0, 0]);

      // The same leaves move, by the same screen distance: the drag's.
      for (let i = 0; i < 12; i++) {
        const want = MODULE_1.includes(i) ? DRAG : [0, 0];
        for (const [label, m] of [["ring", byRing.px[i]!], ["collapsed", byGlyph.px[i]!]] as const) {
          expect(m[0], `${label}: leaf ${i} x`).toBeCloseTo(want[0]!, 3);
          expect(m[1], `${label}: leaf ${i} y`).toBeCloseTo(want[1]!, 3);
        }
      }
      for (const e of [open, shut]) {
        e.net.destroy();
        e.el.remove();
      }
    });

    it(`${backend}: unchanged — a click on a ring picks it without moving; off the ring, or with ⌘/Ctrl, a press pans; a glyph over a ring wins the grab`, async () => {
      const { net, el, graph, clicks } = await draggable(backend);
      const { rings, glyphs } = drawn(net);
      const ring = rings.reduce((a, b) => (b.r > a.r ? b : a)); // module 1
      const top: [number, number] = [ring.x, ring.y - ring.r];
      const still = (m: { px: number[][] }): boolean => m.px.every(([dx, dy]) => dx === 0 && dy === 0);

      // A click without a move: the module is clicked (and selected, where the lane selects), nothing moves.
      const before = graph.positions.slice();
      gesture(el, [top]);
      expect(isOpen(clicks.at(-1) ?? null), "click").toBe(true);
      expect(moves(graph, before).every(([dx, dy]) => dx === 0 && dy === 0), "a click moved a leaf").toBe(true);
      if (backend === "webgl") expect(net.selection().map((h) => datumOf(h)?.path?.join(":"))).toEqual(["1"]);

      // Inside the disc but off the ring: nothing to grab, the press pans.
      const inside: [number, number] = [ring.x, ring.y - ring.r + 20];
      expect(net.draggableAt(...inside)).toBeNull();
      const offRing = dragFrom(net, el, graph, ...inside);
      expect(offRing.pan, "off the ring: pans").toEqual(DRAG);
      expect(still(offRing), "off the ring: a leaf moved").toBe(true);

      // The force-pan modifier on the ring: pans, grabs nothing.
      net.setTransform(VIEW);
      net.syncScreenGeometry();
      const forced = dragFrom(net, el, graph, ...top, { [PAN_MODIFIER]: true });
      expect(forced.pan, `${PAN_MODIFIER} on the ring: pans`).toEqual(DRAG);
      expect(still(forced), `${PAN_MODIFIER} on the ring: a leaf moved`).toBe(true);

      // A glyph drawn over a ring wins the grab: only that leaf moves.
      net.setTransform(VIEW);
      net.syncScreenGeometry();
      let over: { x: number; y: number } | null = null;
      for (const c of glyphs) {
        for (const rg of rings) {
          const d = Math.hypot(c.x - rg.x, c.y - rg.y);
          if (Math.abs(d - rg.r) > c.r / 2) continue; // the ring's centreline runs through the glyph's inner half
          const x = rg.x + ((c.x - rg.x) * rg.r) / d;
          const y = rg.y + ((c.y - rg.y) * rg.r) / d;
          if (inBand(rg, x, y, 0.75)) over = { x, y };
        }
        if (over) break;
      }
      if (!over) throw new Error("no glyph over a ring");
      const hit = net.draggableAt(over.x, over.y);
      expect(hit?.layer).toBe("nodes");
      expect(isOpen(hit), "a glyph over the ring").toBe(false);
      const leaf = hit!.id as number;
      expect(leaf, "a leaf (tree ids below the leaf count)").toBeLessThan(12);
      const byGlyph = dragFrom(net, el, graph, over.x, over.y);
      expect(byGlyph.pan).toEqual([0, 0]);
      for (let i = 0; i < 12; i++) {
        const want = i === leaf ? DRAG : [0, 0];
        expect(byGlyph.px[i]![0], `leaf ${i} x`).toBeCloseTo(want[0]!, 3);
        expect(byGlyph.px[i]![1], `leaf ${i} y`).toBeCloseTo(want[1]!, 3);
      }
      net.destroy();
      el.remove();
    });
  }
});
