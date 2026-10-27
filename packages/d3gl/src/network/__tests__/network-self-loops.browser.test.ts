import { describe, it, expect } from "vitest";
import { network, Network, type NetworkLinkHit, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import { keptLoopStats, selfLoopStats, SELF_LOOP_LAYER } from "../self-loops.js";
import { DROP_HALF_SPREAD, LOOP_LEG, loopPieceLength } from "../../core/loop-drop.js";
import type { Backend, RenderDelta, RenderLayer } from "../../core/backend.js";
import type { InstancedLayer } from "../../core/index.js";
import { CanvasBackend } from "../../canvas/canvas-backend.js";
import { SvgBackend } from "../../svg/svg-backend.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";

/**
 * #505: a self-link draws as a loop at its node, on WebGL, Canvas and SVG, in both size modes; a directed one
 * shows its arrowhead; the half-arrow style draws it too; hovering or clicking the loop reports the self-link.
 *
 * Node 0 (at x = 60) has a self-link and one neighbour, node 1 (at x = 140), so its loop points away from it,
 * towards −x. The loop runs from the node's centre back to it (#542: straight out to `E0 = c + ρ·u0`, the settled
 * cubic to `E1`, straight back, `ρ = r + max(2·arrowSize, 10·∛w)` in every style); its round far end, the cubic's `B(½)`, sits
 * `(4ρ + 3ℓ)·cos α/4` left of the centre (`ℓ = LOOP_LEG·r`), outside the node.
 */

const W = 200;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const SIZE_MODES = ["screen", "world"] as const;
const R = 10;
const CX = 60;
const CY = 100;
/** The draws' arrow size, and the loop's leg offset `ρ` at the default link width 3 (the same in every style). */
const ARROW_SIZE = 4;
const RHO = R + loopPieceLength(ARROW_SIZE, 3);
const APEX_X = CX - ((4 * RHO + 3 * LOOP_LEG * R) * Math.cos(DROP_HALF_SPREAD)) / 4;

/** Where the loop's first leg (the upper one, y < CY) crosses the circle of radius `d ≤ ρ` round node 0: on its
 *  straight piece, along `u(π + α)`. */
function legAt(d: number): [number, number] {
  return [CX - d * Math.cos(DROP_HALF_SPREAD), CY - d * Math.sin(DROP_HALF_SPREAD)];
}
const POSITIONS = new Float32Array([CX, CY, 140, CY]);

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${W}px`;
  document.body.appendChild(el);
  return el;
}

/** How many pixels of the rendered frame in the box are the link colour (red) — the loop sits there alone. Each
 *  counts by its alpha: over the frame's transparent background an edge pixel is pure red at partial coverage. */
async function redPixels(png: string, x0: number, y0: number, x1: number, y1: number): Promise<number> {
  const img = new Image();
  img.src = png;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0);
  const s = img.width / W;
  const d = ctx.getImageData(Math.round(x0 * s), Math.round(y0 * s), Math.round((x1 - x0) * s), Math.round((y1 - y0) * s)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 0) > 180 && (d[i + 1] ?? 0) < 90 && (d[i + 2] ?? 0) < 90) n += (d[i + 3] ?? 255) / 255;
  return n / (s * s);
}

interface Case {
  backend: (typeof BACKENDS)[number];
  sizeMode: (typeof SIZE_MODES)[number];
  directed: boolean;
  linkStyle?: "line" | "half-arrow";
  /** The edges after the 0–1 link: node 0's self-links (several = duplicates). */
  selfWeights?: number[];
  /** LOD on, every leaf kept (the loops of an LOD frame's kept leaves). */
  lod?: boolean;
  /** The link width (default 3). */
  linkWidth?: number;
  /** The loop's spread (degrees) and leg length (radii); absent ⇒ the defaults. */
  selfLinkSpread?: number;
  selfLinkLength?: number;
  /** Style overrides, applied last (#586: `selfLinks`, a metric-sized `nodeRadius`). */
  style?: NetworkStyle;
}

async function draw(c: Case) {
  const net = network(host(), { width: W, height: W, backend: c.backend });
  await net.whenReady();
  const self = c.selfWeights ?? [1];
  const g = buildGraph({ nodeCount: 2, source: [0, ...self.map(() => 0)], target: [1, ...self.map(() => 0)], weight: [1, ...self], directed: c.directed });
  // The overrides go in before data() too: data() draws at once, with the style it finds.
  if (c.style) net.style(c.style);
  net
    .data(g)
    .style({ nodeRadius: R, nodeFill: "#000000", linkStroke: "#ff0000", linkWidth: c.linkWidth ?? 3, arrowSize: ARROW_SIZE, directed: c.directed, linkStyle: c.linkStyle ?? "line", sizeMode: c.sizeMode, selfLinkSpread: c.selfLinkSpread, selfLinkLength: c.selfLinkLength, ...c.style })
    .lod(c.lod ? { expandPx: 1, declutter: false } : false)
    .layout({ backend: "positions", positions: POSITIONS });
  net.setTransform({ k: 1, x: 0, y: 0 });
  return net;
}

/** The rendered frame as an image URL: the PNG of a raster backend, the SVG backend's own document rasterized. */
function frame(net: Awaited<ReturnType<typeof draw>>, backend: Case["backend"]): string {
  return backend === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(net.toSVG())}` : net.toPNG();
}

/** The loop's box: left of node 0, beyond its rim. */
const loopRed = (png: string): Promise<number> => redPixels(png, APEX_X - 4, CY - 14, CX - R - 1, CY + 14);

describe("self-link loops (#505)", () => {

  for (const backend of BACKENDS)
    for (const sizeMode of SIZE_MODES) {
      it(`${backend} / ${sizeMode}: a self-link draws a loop at its node; a directed one adds its arrowhead`, async () => {
        const undirected = await draw({ backend, sizeMode, directed: false });
        const plain = await loopRed(frame(undirected, backend));
        // Nothing red on the far side of node 1 (no loop there) — the loop is drawn at ITS node only.
        const elsewhere = await redPixels(frame(undirected, backend), 152, CY - 14, 180, CY + 14);
        undirected.destroy();
        expect(plain).toBeGreaterThan(20);
        expect(elsewhere).toBe(0);

        const directed = await draw({ backend, sizeMode, directed: true });
        const withHead = await loopRed(frame(directed, backend));
        directed.destroy();
        expect(withHead).toBeGreaterThan(plain + 4);

        const half = await draw({ backend, sizeMode, directed: true, linkStyle: "half-arrow" });
        const halfRed = await loopRed(frame(half, backend));
        half.destroy();
        expect(halfRed).toBeGreaterThan(10);
      });
    }

  it("webgl: hovering / clicking the loop reports the node's first self-link, with the summed weight", async () => {
    const net = await draw({ backend: "webgl", sizeMode: "world", directed: false, selfWeights: [1, 3] });
    net.interactive({ hover: true });
    net.pickLinks(true);
    const hit = net.pick(APEX_X + 1, CY);
    expect(hit?.layer).toBe("links");
    expect(hit?.id).toBe(1); // edge 1 is node 0's first self-link; edge 2 is summed into its loop
    const d = hit?.datum as NetworkLinkHit;
    expect([d.source, d.target]).toEqual([0, 0]);
    expect(d.weight).toBeCloseTo(4);
    // The node itself still wins over its loop; the 0–1 link is still edge 0.
    expect(net.pick(CX, CY)?.layer).toBe("nodes");
    expect(net.pick(100, CY)?.id).toBe(0);
    net.destroy();
  });

  it("webgl: selection keeps the selected node's loop and dims another node's loop (selection.others)", async () => {
    const net = await draw({ backend: "webgl", sizeMode: "world", directed: false });
    net.interactive({ selectable: true }); // default selection.others: opacity 0.3
    net.select("nodes", [0]);
    const kept = await loopRed(net.toPNG());
    net.select("nodes", [1]);
    const dimmed = await loopRed(net.toPNG());
    net.destroy();
    expect(kept).toBeGreaterThan(20);
    expect(dimmed).toBeLessThan(kept / 4); // the dimmed loop is no longer full red
  });

  for (const backend of ["canvas", "svg"] as const)
    it(`${backend}: picking the loop reports its self-link`, async () => {
      const net = await draw({ backend, sizeMode: "screen", directed: false });
      net.interactive({ hover: true });
      const hit = net.pick(APEX_X + 1, CY);
      expect(hit?.layer).toBe("links");
      expect(hit?.id).toBe(1);
      net.destroy();
    });

  for (const backend of BACKENDS)
    it(`${backend}: with LOD on, a kept leaf draws its loop (line, directed, half-arrow)`, async () => {
      for (const sizeMode of SIZE_MODES) {
        const plainNet = await draw({ backend, sizeMode, directed: false, lod: true });
        const plain = await loopRed(frame(plainNet, backend));
        const elsewhere = await redPixels(frame(plainNet, backend), 152, CY - 14, 180, CY + 14);
        plainNet.destroy();
        expect(plain, sizeMode).toBeGreaterThan(20);
        expect(elsewhere, sizeMode).toBe(0);
        const directed = await draw({ backend, sizeMode, directed: true, lod: true });
        const withHead = await loopRed(frame(directed, backend));
        directed.destroy();
        expect(withHead, sizeMode).toBeGreaterThan(plain + 4);
        const half = await draw({ backend, sizeMode, directed: true, linkStyle: "half-arrow", lod: true });
        const halfRed = await loopRed(frame(half, backend));
        half.destroy();
        expect(halfRed, sizeMode).toBeGreaterThan(10);
      }
    });

  it("webgl: with LOD on, picking a kept leaf's loop reports its first self-link, with the summed weight", async () => {
    const net = await draw({ backend: "webgl", sizeMode: "world", directed: false, selfWeights: [1, 3], lod: true });
    net.interactive({ hover: true });
    net.pickLinks(true);
    const hit = net.pick(APEX_X + 1, CY);
    expect(hit?.layer).toBe("links");
    expect(hit?.id).toBe(1);
    expect((hit?.datum as NetworkLinkHit).weight).toBeCloseTo(4);
    expect(net.pick(100, CY)?.id).toBe(0); // the 0–1 leaf link still picks as edge 0
    net.destroy();
  });

  for (const backend of BACKENDS)
    for (const sizeMode of SIZE_MODES)
      it(`${backend} / ${sizeMode}: the loop leaves the node from its centre: no gap at the rim, both legs alike`, async () => {
        const net = await draw({ backend, sizeMode, directed: false });
        const png = frame(net, backend);
        // Just outside the rim, where each leg crosses it: the link colour, no background between loop and node.
        const [ux, uy] = legAt(R + 1.5);
        const upper = await redPixels(png, ux - 1.5, uy - 1.5, ux + 1.5, uy + 1.5);
        const lower = await redPixels(png, ux - 1.5, 2 * CY - uy - 1.5, ux + 1.5, 2 * CY - uy + 1.5);
        // Symmetric about the loop's axis (row CY): the halves above and below it hold the same red.
        const above = await redPixels(png, 0, CY - 30, CX, CY);
        const below = await redPixels(png, 0, CY, CX, CY + 30);
        net.destroy();
        expect(upper).toBeGreaterThan(4);
        expect(lower).toBeGreaterThan(4);
        expect(Math.abs(above - below)).toBeLessThan(0.1 * Math.max(above, below));
      });
  for (const backend of BACKENDS)
    for (const sizeMode of SIZE_MODES)
      it(`${backend} / ${sizeMode}: the half-arrow loop's band is one link width thick at its far end`, async () => {
        // The loop's axis (row CY, left of the node) crosses only the band's far end: the drop's apex, then the outer
        // edge `width` further out. An outer edge moved straight out per leg crossed the inner one there (#505).
        const width = 8;
        const net = await draw({ backend, sizeMode, directed: true, linkStyle: "half-arrow", linkWidth: width });
        const run = await redPixels(frame(net, backend), 0, CY, CX - R - 1, CY + 1);
        net.destroy();
        expect(run).toBeGreaterThan(width - 1.5);
        expect(run).toBeLessThan(width + 1.5);
      });

  it("webgl: a half-arrow loop level with its neighbour (a vertical chord) bows outward in world mode", async () => {
    // Node 1 exactly level with node 0 (θ = π): the chord is vertical, the case the lane's side rule decides from
    // the offsets alone (#505). Inward, the loop would hide under the node and leave its box empty.
    const net = await draw({ backend: "webgl", sizeMode: "world", directed: true, linkStyle: "half-arrow" });
    const red = await loopRed(net.toPNG());
    net.destroy();
    expect(red).toBeGreaterThan(10);
  });
});

/** The red mask of a rendered frame over the loop's box (1 = link colour at ≥ half coverage), at the frame's own scale. */
async function frameRedMask(png: string): Promise<Uint8Array> {
  const img = new Image();
  img.src = png;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = W;
  c.height = W;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, W, W);
  const x0 = Math.floor(APEX_X - 8), y0 = CY - 24;
  const d = ctx.getImageData(x0, y0, CX - x0, 48).data;
  const out = new Uint8Array(d.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (d[4 * i] ?? 0) > 180 && (d[4 * i + 1] ?? 0) < 90 && (d[4 * i + 2] ?? 0) < 90 && (d[4 * i + 3] ?? 0) > 127 ? 1 : 0;
  return out;
}

/** A non-default loop shape: a wider spread and shorter legs (still inside the mask's box). */
const SHAPE = { selfLinkSpread: 70, selfLinkLength: 2 };

describe("self-link loops: WebGL draws the Canvas Scene's shape (#542)", () => {
  const variants: Omit<Case, "backend" | "sizeMode">[] = [
    { directed: false },
    { directed: true },
    { directed: true, linkStyle: "half-arrow" },
    { directed: false, ...SHAPE },
    { directed: true, ...SHAPE },
    { directed: true, linkStyle: "half-arrow", ...SHAPE },
  ];
  for (const sizeMode of SIZE_MODES)
    for (const v of variants)
      it(`${sizeMode} / ${v.directed ? (v.linkStyle ?? "line") : "undirected"}${v.selfLinkSpread ? " / spread 70°, length 2" : ""}: the GPU loop covers the Canvas loop's pixels`, async () => {
        const gl = await draw({ backend: "webgl", sizeMode, ...v });
        const cv = await draw({ backend: "canvas", sizeMode, ...v });
        const ma = await frameRedMask(gl.toPNG());
        const mb = await frameRedMask(cv.toPNG());
        gl.destroy();
        cv.destroy();
        // A pixel one mask lights is off by more than antialiasing when the other lights none of its 3 × 3
        // neighbourhood: the Scene flattens its curves within a tolerance, the strip samples them, so their edges may
        // differ by a pixel, never more.
        const bw = CX - Math.floor(APEX_X - 8);
        const near = (m: Uint8Array, i: number): boolean => {
          const x = i % bw;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < bw && m[i + dy * bw + dx] === 1) return true;
          return false;
        };
        let red = 0, diff = 0;
        for (let i = 0; i < ma.length; i++) {
          red += mb[i] ?? 0;
          if ((ma[i] === 1 && !near(mb, i)) || (mb[i] === 1 && !near(ma, i))) diff++;
        }
        expect(red, "the Canvas loop drew nothing (non-vacuity)").toBeGreaterThan(20);
        expect(diff, `${diff} of ${red} loop pixels differ by more than a pixel`).toBe(0);
      });

  it("selfLinkSpread / selfLinkLength change the loop's shape (non-vacuity of the cases above)", async () => {
    const a = await draw({ backend: "canvas", sizeMode: "world", directed: true });
    const b = await draw({ backend: "canvas", sizeMode: "world", directed: true, ...SHAPE });
    const ma = await frameRedMask(a.toPNG());
    const mb = await frameRedMask(b.toPNG());
    a.destroy();
    b.destroy();
    let diff = 0;
    for (let i = 0; i < ma.length; i++) if (ma[i] !== mb[i]) diff++;
    expect(diff).toBeGreaterThan(50);
  });
});

/** The red mask of an SVG document, rasterized, over the loop's box (1 = link colour). */
async function svgRedMask(svg: string): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = W;
  c.height = W;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, W, W);
  const x0 = Math.floor(APEX_X - 8), y0 = CY - 16;
  const d = ctx.getImageData(x0, y0, CX - x0, 32).data;
  const out = new Uint8Array(d.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (d[4 * i] ?? 0) > 180 && (d[4 * i + 1] ?? 0) < 90 && (d[4 * i + 2] ?? 0) < 90 ? 1 : 0;
  return out;
}

describe("self-link drop export (#505)", () => {
  for (const sizeMode of SIZE_MODES)
    for (const [linkStyle, shape] of [["line", {}], ["half-arrow", {}], ["line", SHAPE], ["half-arrow", SHAPE]] as const)
      it(`${sizeMode} / ${linkStyle}${"selfLinkSpread" in shape ? " / spread 70°, length 2" : ""}: WebGL toSVG() draws the same drop as the Canvas Scene`, async () => {
        const gl = await draw({ backend: "webgl", sizeMode, directed: true, linkStyle, ...shape });
        const cv = await draw({ backend: "canvas", sizeMode, directed: true, linkStyle, ...shape });
        const a = gl.toSVG();
        const b = cv.toSVG();
        const ma = await svgRedMask(a);
        const mb = await svgRedMask(b);
        let red = 0, diff = 0;
        for (let i = 0; i < ma.length; i++) {
          red += ma[i] ?? 0;
          if (ma[i] !== mb[i]) diff++;
        }
        expect(red, "the export drew no loop (non-vacuity)").toBeGreaterThan(20);
        expect(diff, `${diff} of ${red} loop pixels differ`).toBeLessThanOrEqual(Math.max(4, red * 0.05));
      });
});

/** A network whose test drives a streamed layout frame by hand: the main thread's half of a worker frame (the
 *  transport has written the positions; this is its repaint request). */
class StreamProbe extends Network {
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
}

/** Two animation frames: the engine's coalesced frame has run. */
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

describe("self-link loops: the LOD angle cache follows every position change (#542)", () => {
  /** Node 1 below node 0: the loop must then point up, away from it. */
  const BELOW: [number, number] = [CX, 180];
  /** Red in the box left of node 0 (where the loop points at first) and above it (where it must point after). */
  const leftRed = (png: string): Promise<number> => redPixels(png, CX - 40, CY - 14, CX - R - 1, CY + 14);
  const upRed = (png: string): Promise<number> => redPixels(png, CX - 14, CY - 40, CX + 14, CY - R - 1);

  /** Draw node 0's loop with LOD on (every leaf kept), check it points left, run `move`, and check it now points up. */
  async function turns(net: Network, g: ReturnType<typeof buildGraph>, move: () => void): Promise<void> {
    await net.whenReady();
    net
      .data(g)
      .style({ nodeRadius: R, nodeFill: "#000000", linkStroke: "#ff0000", linkWidth: 3, arrowSize: ARROW_SIZE, sizeMode: "world" })
      .lod({ expandPx: 1, declutter: false })
      .layout({ backend: "positions", positions: POSITIONS });
    net.setTransform({ k: 1, x: 0, y: 0 });
    await nextFrame();
    const before = net.toPNG();
    expect(await leftRed(before), "the loop does not point left at first (non-vacuity)").toBeGreaterThan(20);
    expect(await upRed(before)).toBe(0);
    // A zoom frame stamps the angles at this position version, as a user's would.
    net.setTransform({ k: 1, x: 0.5, y: 0 });
    net.setTransform({ k: 1, x: 0, y: 0 });
    await nextFrame();
    move();
    await nextFrame();
    const after = net.toPNG();
    expect(await upRed(after), "the loop did not turn to point up").toBeGreaterThan(20);
    expect(await leftRed(after), "the loop still points left: its angle is stale").toBe(0);
  }
  const graph = () => buildGraph({ nodeCount: 2, source: [0, 0], target: [1, 0], weight: [1, 1], directed: false });

  it("a node-drag of its neighbour turns the loop", async () => {
    const el = host();
    const net = network(el, { width: W, height: W, backend: "webgl" });
    await turns(net, graph(), () => {
      net.interactive({ draggable: true });
      const r = el.getBoundingClientRect();
      const ev = (type: string, x: number, y: number) => el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
      ev("pointerdown", 140, CY);
      ev("pointermove", BELOW[0], BELOW[1]);
      ev("pointerup", BELOW[0], BELOW[1]);
    });
    net.destroy();
  });

  it("a streamed layout frame turns the loop", async () => {
    const g = graph();
    const net = new StreamProbe(host(), { width: W, height: W, backend: "webgl" });
    await turns(net, g, () => {
      g.positions.set(BELOW, 2);
      net.streamFrame();
    });
    net.destroy();
  });

  it("layout({ backend: \"positions\" }) with new positions turns the loop", async () => {
    const net = network(host(), { width: W, height: W, backend: "webgl" });
    await turns(net, graph(), () => {
      net.layout({ backend: "positions", positions: new Float32Array([CX, CY, ...BELOW]) });
    });
    net.destroy();
  });

  // `update()` never moves positions (its contract) and rebuilds the loop cache, stamps included: a loop that turned
  // before it stays turned after it.
  it("update({ flow }) after new positions keeps the loop turned", async () => {
    const net = network(host(), { width: W, height: W, backend: "webgl" });
    await turns(net, graph(), () => {
      net.layout({ backend: "positions", positions: new Float32Array([CX, CY, ...BELOW]) });
      net.update({ flow: [0.25, 0.75] });
    });
    net.destroy();
  });
});

/** How many pixels of the rendered frame in the box are the node fill (black, opaque). */
async function blackPixels(png: string, x0: number, y0: number, x1: number, y1: number): Promise<number> {
  const img = new Image();
  img.src = png;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0);
  const s = img.width / W;
  const d = ctx.getImageData(Math.round(x0 * s), Math.round(y0 * s), Math.round((x1 - x0) * s), Math.round((y1 - y0) * s)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 60 && (d[i + 1] ?? 255) < 60 && (d[i + 2] ?? 255) < 60 && (d[i + 3] ?? 0) > 200) n++;
  return n / (s * s);
}

/**
 * What the backends are handed while it is on: every drawable of the `links` Scene layer, on any backend (Canvas and
 * SVG draw the loop there, #505; WebGL's Scene only for an export), and every instanced layer WebGL is handed, by
 * name. Patches the prototypes, so the network's own backend is observed.
 */
function watchBackends(): { linkDrawables: () => number; instanced: string[]; restore: () => void } {
  let n = 0;
  const instanced: string[] = [];
  const protos: Backend[] = [CanvasBackend.prototype, SvgBackend.prototype, WebGLBackend.prototype];
  const saved = protos.map((p) => ({ setLayers: p.setLayers, updateLayer: p.updateLayer, appendToLayer: p.appendToLayer }));
  for (const [k, p] of protos.entries()) {
    const was = saved[k];
    if (!was) continue;
    p.setLayers = function (this: Backend, layers: RenderLayer[]): void {
      for (const l of layers) if (l.name === "links") n += l.drawables.length;
      was.setLayers.call(this, layers);
    };
    p.updateLayer = function (this: Backend, name: string, layer: RenderLayer): void {
      if (name === "links") n += layer.drawables.length;
      was.updateLayer.call(this, name, layer);
    };
    p.appendToLayer = function (this: Backend, delta: RenderDelta): void {
      if (delta.name === "links") n += delta.drawables.length;
      was.appendToLayer?.call(this, delta);
    };
  }
  const gl = WebGLBackend.prototype;
  const { setInstancedLayer, updateInstancedLayer } = gl;
  gl.setInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
    instanced.push(layer.name);
    setInstancedLayer.call(this, layer);
  };
  gl.updateInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
    instanced.push(layer.name);
    updateInstancedLayer.call(this, layer);
  };
  return {
    linkDrawables: () => n,
    instanced,
    restore: () => {
      for (const [k, p] of protos.entries()) {
        const was = saved[k];
        if (!was) continue;
        p.setLayers = was.setLayers;
        p.updateLayer = was.updateLayer;
        p.appendToLayer = was.appendToLayer;
      }
      gl.setInstancedLayer = setInstancedLayer;
      gl.updateInstancedLayer = updateInstancedLayer;
    },
  };
}

/** One draw under the watch, with a zoom and a position frame after it, then an export: what it handed the backend
 *  and what loop work it did. */
async function watchedDraw(c: Case): Promise<{ linkDrawables: number; loopLayers: number; loopUpdates: number; loopInstances: number; listed: number }> {
  const watch = watchBackends();
  const u0 = selfLoopStats.updates;
  const i0 = selfLoopStats.instances;
  const f0 = keptLoopStats.frames;
  try {
    const net = await draw(c);
    net.setTransform({ k: 1.5, x: -20, y: -20 });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.layout({ backend: "positions", positions: POSITIONS.map((v) => v + 1) });
    net.render();
    net.toSVG();
    net.destroy();
    return {
      linkDrawables: watch.linkDrawables(),
      loopLayers: watch.instanced.filter((name) => name === SELF_LOOP_LAYER).length,
      loopUpdates: selfLoopStats.updates - u0,
      loopInstances: selfLoopStats.instances - i0,
      listed: keptLoopStats.frames - f0,
    };
  } finally {
    watch.restore();
  }
}

const HIDDEN: NetworkStyle = { selfLinks: false };

describe("selfLinks: false hides the self-link loops (#586)", () => {
  for (const backend of BACKENDS)
    for (const sizeMode of SIZE_MODES)
      it(`${backend} / ${sizeMode}: no loop pixels in any style, LOD off or on; the default draws them`, async () => {
        for (const lod of [false, true])
          for (const [directed, linkStyle] of [[false, "line"], [true, "line"], [true, "half-arrow"]] as const) {
            const label = `${lod ? "LOD" : "no LOD"}, ${directed ? "directed" : "undirected"} ${linkStyle}`;
            const shown = await draw({ backend, sizeMode, directed, linkStyle, lod });
            const on = await loopRed(frame(shown, backend));
            shown.destroy();
            const hidden = await draw({ backend, sizeMode, directed, linkStyle, lod, style: HIDDEN });
            const off = await loopRed(frame(hidden, backend));
            // The node-to-node link still draws: red between the two nodes.
            const link = await redPixels(frame(hidden, backend), CX + R + 4, CY - 3, 140 - R - 8, CY + 3);
            // WebGL's export (toSVG) draws no loop either.
            const exported = backend === "webgl" ? await loopRed(frame(hidden, "svg")) : 0;
            hidden.destroy();
            expect(on, `${label}: the default drew no loop (non-vacuity)`).toBeGreaterThan(10);
            expect(off, `${label}: loop pixels with selfLinks: false`).toBe(0);
            expect(exported, `${label}: loop pixels in WebGL's toSVG()`).toBe(0);
            expect(link, `${label}: the 0–1 link`).toBeGreaterThan(10);
          }
      });

  for (const backend of BACKENDS)
    it(`${backend}: hidden loops cost what no self-links cost — no loop drawable, layer, update or LOD listing`, async () => {
      for (const lod of [false, true]) {
        const label = lod ? "LOD" : "no LOD";
        const none = await watchedDraw({ backend, sizeMode: "screen", directed: true, lod, selfWeights: [] });
        const hidden = await watchedDraw({ backend, sizeMode: "screen", directed: true, lod, style: HIDDEN });
        const shown = await watchedDraw({ backend, sizeMode: "screen", directed: true, lod });
        // The same drawables and layers as the graph without self-links, on the same frames.
        expect(hidden, label).toEqual(none);
        expect(hidden.loopUpdates + hidden.loopInstances + hidden.listed + hidden.loopLayers, label).toBe(0);
        // Non-vacuity: the watch sees the loop when it is drawn (a Scene drawable on Canvas/SVG, a layer on WebGL).
        if (backend === "webgl") expect(shown.loopLayers, `${label}: the default handed no loop layer`).toBeGreaterThan(0);
        else expect(shown.linkDrawables, `${label}: the default handed no loop drawable`).toBeGreaterThan(none.linkDrawables);
        expect(shown.loopInstances, `${label}: the default wrote no loop`).toBeGreaterThan(0);
      }
    });

  for (const backend of BACKENDS)
    it(`${backend}: a hidden loop is not picked; the node and the 0–1 link still are`, async () => {
      const net = await draw({ backend, sizeMode: "world", directed: false, style: HIDDEN });
      net.interactive({ hover: true });
      net.pickLinks(true);
      expect(net.pick(APEX_X + 1, CY)?.layer, "the loop's place picked something").toBeUndefined();
      expect(net.pick(CX, CY)?.layer).toBe("nodes");
      expect(net.pick(100, CY)?.id).toBe(0);
      net.destroy();
    });

  for (const backend of BACKENDS)
    it(`${backend}: style({ selfLinks }) toggles the loops on a drawn network, LOD off and on`, async () => {
      for (const lod of [false, true]) {
        const label = lod ? "LOD" : "no LOD";
        const net = await draw({ backend, sizeMode: "screen", directed: true, lod });
        const on = await loopRed(frame(net, backend));
        net.style({ selfLinks: false });
        const off = await loopRed(frame(net, backend));
        net.style({ selfLinks: true });
        const back = await loopRed(frame(net, backend));
        net.destroy();
        expect(on, label).toBeGreaterThan(20);
        expect(off, label).toBe(0);
        expect(back, label).toBeCloseTo(on, 0);
      }
    });

  for (const backend of BACKENDS)
    it(`${backend}: hiding changes no degree or strength — a metric-sized node keeps its size`, async () => {
      // Node 0: the 0–1 link (weight 1) and self-links of weight 1 + 3. Degree 3 and strength 5 count each self-link
      // once (#535); dropping them from the data would give degree 1 and strength 1, a node 1/9 or 1/25 the area.
      const sizes = async (nodeRadius: NetworkStyle["nodeRadius"]): Promise<number[]> => {
        const out: number[] = [];
        for (const style of [{}, HIDDEN]) {
          const net = await draw({ backend, sizeMode: "world", directed: false, selfWeights: [1, 3], style: { ...style, nodeRadius } });
          out.push(await blackPixels(frame(net, backend), CX - 14, CY - 14, CX + 14, CY + 14));
          net.destroy();
        }
        return out;
      };
      const area = Math.PI * R * R;
      for (const [metric, nodeRadius] of [["degree", { by: "degree", scale: (d: number) => (R / 3) * d }], ["strength", { by: "strength", scale: (s: number) => (R / 5) * s }]] as const) {
        const [shown = 0, hidden = 0] = await sizes(nodeRadius);
        expect(shown, `${metric}: the node is r = ${R}`).toBeGreaterThan(area * 0.85);
        expect(shown, `${metric}: the node is r = ${R}`).toBeLessThan(area * 1.15);
        expect(Math.abs(hidden - shown), `${metric}: ${hidden} vs ${shown} px`).toBeLessThanOrEqual(area * 0.03);
      }
    });
});
