import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { BORDER_DARKEN } from "../glyphs.js";

/**
 * #506: a node border (`nodeBorder`) with no colour given is a darker shade of each node's own fill, as a
 * flow border is, on WebGL, Canvas and SVG, with LOD off and on (a collapsed module's ring in its module
 * colour). An explicit colour keeps one ring colour. Checked twice per case: the exported `<circle>`
 * strokes (`toSVG()`), and the rendered pixels on each glyph's ring and at its centre (`toPNG()`).
 */

const W = 200;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const MODULES = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
];
const FILLS = ["#1f77b4", "#1f77b4", "#ff7f0e", "#ff7f0e"]; // one opaque colour per module
/** LOD off: four separate nodes. */
const SPREAD = new Float32Array([40, 40, 160, 40, 40, 160, 160, 160]);
/** LOD on: each module's two members overlap, so each module collapses to one aggregate (#426). */
const CLUSTERED = new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]);

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const darken = ([r, g, b]: RGB): RGB => [Math.round(r * BORDER_DARKEN), Math.round(g * BORDER_DARKEN), Math.round(b * BORDER_DARKEN)];

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${W}px`;
  document.body.appendChild(el);
  return el;
}

interface Circle { cx: number; cy: number; r: number; strokeWidth: number; fill: RGB; stroke: RGB }

/** The exported node circles: centre, ring centreline radius, stroke width and the fill / stroke RGB. */
function circles(svg: string): Circle[] {
  const num = (tag: string, name: string): number => Number(new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1] ?? NaN);
  const color = (tag: string, name: string): RGB => {
    const m = new RegExp(`\\s${name}="rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)`).exec(tag);
    if (!m) throw new Error(`no ${name} colour on ${tag}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  return (svg.match(/<circle[^>]*>/g) ?? []).map((tag) => ({
    cx: num(tag, "cx"),
    cy: num(tag, "cy"),
    r: num(tag, "r"),
    strokeWidth: num(tag, "stroke-width"),
    fill: color(tag, "fill"),
    stroke: color(tag, "stroke"),
  }));
}

/** RGB of the rendered frame at CSS-px points. */
async function pixels(png: string, points: { x: number; y: number }[]): Promise<RGB[]> {
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
  return points.map(({ x, y }) => {
    const d = ctx.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  });
}

async function draw(backend: (typeof BACKENDS)[number], lod: boolean, nodeBorder: { width: number; color?: string }) {
  const net = network(host(), { width: W, height: W, backend });
  await net.whenReady();
  net
    .data(buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true }))
    .style({ nodeRadius: 16, nodeFill: (i) => FILLS[i]!, nodeBorder, linkStyle: "none" });
  if (lod) net.lod({ modules: MODULES, expandPx: 20 });
  net.layout({ backend: "positions", positions: lod ? CLUSTERED : SPREAD });
  net.setTransform({ k: 1, x: 0, y: 0 });
  const svg = net.toSVG();
  // The SVG backend's frame is its document: rasterize it as the browser draws it.
  const png = backend === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : net.toPNG();
  net.destroy();
  return { svg, png };
}

const close = (a: RGB, b: RGB, tol = 3): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe("#506 node border without a colour: a darker shade of each node's fill", () => {
  for (const backend of BACKENDS) {
    for (const lod of [false, true]) {
      it(`${backend}, LOD ${lod ? "on" : "off"}: each ring is its own fill darkened`, async () => {
        const { svg, png } = await draw(backend, lod, { width: 4 });
        const cs = circles(svg);
        expect(cs).toHaveLength(lod ? 2 : 4); // LOD on: one aggregate per module
        const fills = new Set(cs.map((c) => c.fill.join()));
        expect(fills, "both module colours drawn").toEqual(new Set([hex(FILLS[0]!).join(), hex(FILLS[2]!).join()]));
        for (const c of cs) {
          expect(c.strokeWidth, "a 4 px ring").toBeCloseTo(4, 3);
          expect(c.stroke, `stroke of the ${c.fill.join()} glyph`).toEqual(darken(c.fill));
        }
        // Pixels: on the ring centreline, the darkened fill; at the centre, the fill.
        const ring = await pixels(png, cs.map((c) => ({ x: c.cx + c.r, y: c.cy })));
        const centre = await pixels(png, cs.map((c) => ({ x: c.cx, y: c.cy })));
        cs.forEach((c, i) => {
          expect(close(ring[i]!, darken(c.fill)), `ring pixel ${ring[i]!.join()} vs ${darken(c.fill).join()}`).toBe(true);
          expect(close(centre[i]!, c.fill), `centre pixel ${centre[i]!.join()} vs ${c.fill.join()}`).toBe(true);
        });
      });

      it(`${backend}, LOD ${lod ? "on" : "off"}: a translucent fill's ring keeps its alpha, as WebGL's does`, async () => {
        const net = network(host(), { width: W, height: W, backend });
        await net.whenReady();
        net
          .data(buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true }))
          .style({ nodeRadius: 16, nodeFill: () => "rgba(31, 119, 180, 0.5)", nodeBorder: { width: 4 }, linkStyle: "none" });
        if (lod) net.lod({ modules: MODULES, expandPx: 20 });
        net.layout({ backend: "positions", positions: lod ? CLUSTERED : SPREAD });
        net.setTransform({ k: 1, x: 0, y: 0 });
        const tags = net.toSVG().match(/<circle[^>]*>/g) ?? [];
        net.destroy();
        expect(tags).toHaveLength(lod ? 2 : 4);
        const alpha = (tag: string, name: string): number => Number(new RegExp(`\\s${name}="rgba\\([^)]*,\\s*([\\d.]+)\\)"`).exec(tag)?.[1] ?? NaN);
        for (const tag of tags) {
          expect(alpha(tag, "fill"), tag).toBeCloseTo(0.5, 2);
          expect(alpha(tag, "stroke"), tag).toBeCloseTo(alpha(tag, "fill"), 2);
        }
      });

      it(`${backend}, LOD ${lod ? "on" : "off"}: an explicit colour keeps one ring colour`, async () => {
        const { svg, png } = await draw(backend, lod, { width: 4, color: "#ffffff" });
        const cs = circles(svg);
        expect(cs).toHaveLength(lod ? 2 : 4);
        for (const c of cs) expect(c.stroke).toEqual([255, 255, 255]);
        const ring = await pixels(png, cs.map((c) => ({ x: c.cx + c.r, y: c.cy })));
        for (const p of ring) expect(close(p, [255, 255, 255]), `ring pixel ${p.join()}`).toBe(true);
      });
    }
  }
});
