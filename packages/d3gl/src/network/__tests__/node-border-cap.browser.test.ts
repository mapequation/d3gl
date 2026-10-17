import { describe, it, expect } from "vitest";
import { Network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";

/**
 * A node's border never covers its fill (#506), on every backend, in both size modes, with LOD off and on,
 * for the node border (`nodeBorder`) and the flow border (`flowBorder`). Both are drawn inside the radius,
 * so before the cap a node whose radius was at or below the border width drew as a disc of pure border
 * colour. The probe reads each node's centre pixel from `toPNG()`: it must be the fill (blue), not the
 * border (white); SVG is read from its rasterised document. A control keeps a large node's border band exactly where it was.
 */

const W = 400;
const H = 400;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const FILL = "#1f4fff";
const BORDER = "#ffffff";
const MODULES: ModuleNode[] = [
  { id: 0, path: [1, 1] },
  { id: 1, path: [1, 2] },
];

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/** Two nodes at world (0, 0) and (gap, 0), drawn and then read back as RGBA at the given screen points. */
async function render(
  backend: (typeof BACKENDS)[number],
  style: NetworkStyle,
  view: { k: number; x: number; y: number },
  gap: number,
  lod: boolean,
  probes: [number, number][],
): Promise<number[][]> {
  const el = host();
  const net = new Network(el, { width: W, height: H, backend });
  await net.whenReady();
  const graph = buildGraph({ nodeCount: 2, source: [], target: [] });
  net.data(graph, { modules: MODULES }).style({ nodeFill: FILL, ...style });
  if (lod) net.lod({ expandPx: 1, declutter: false, aggregateOutline: false });
  net.layout({ backend: "positions", positions: new Float32Array([0, 0, gap, 0]) });
  net.setTransform(view);
  net.syncScreenGeometry();
  // A raster backend reads back its own frame; the SVG backend's document is rasterised by the browser.
  const img = new Image();
  img.src = backend === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(net.toSVG())}` : net.toPNG();
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width || W;
  c.height = img.height || H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0);
  const s = c.width / W;
  const out = probes.map(([x, y]) => Array.from(ctx.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data));
  net.destroy();
  el.remove();
  return out;
}

const isFill = ([r, g, b, a]: number[]): boolean => a! > 200 && b! > 200 && r! < 90 && g! < 130;
const isBorder = ([r, g, b, a]: number[]): boolean => a! > 200 && r! > 220 && g! > 220 && b! > 220;

const borders: [string, (sizeMode: "world" | "screen", r: number, w: number) => NetworkStyle][] = [
  ["nodeBorder", (sizeMode, r, w) => ({ sizeMode, nodeRadius: r, nodeBorder: { width: w, color: BORDER } })],
  ["flowBorder", (sizeMode, r, w) => ({ sizeMode, nodeRadius: r, flowBorder: { flow: new Float32Array([w, w]), scale: (v) => v, color: BORDER } })],
];

describe("a node's border never covers its fill (#506)", () => {
  for (const backend of BACKENDS) {
    for (const lod of [false, true]) {
      for (const [kind, styleOf] of borders) {
        it(`${backend}, LOD ${lod ? "on" : "off"}, ${kind}: a node of radius 0.5 with a border 1 wide shows its fill at the centre`, async () => {
          // World mode: radius 0.5, border 1, zoomed ×40 so the node is 20 px in radius on screen.
          const world = await render(backend, styleOf("world", 0.5, 1), { k: 40, x: W / 2, y: H / 2 }, 3, lod, [
            [W / 2, H / 2],
            [W / 2 + 120, H / 2],
          ]);
          for (const px of world) expect(isFill(px), `world centre pixel ${px}`).toBe(true);
          // Screen mode: the same 1 : 2 radius-to-border ratio in pixels (the fraction is unit-free).
          const screen = await render(backend, styleOf("screen", 20, 40), { k: 1, x: W / 2 - 60, y: H / 2 }, 120, lod, [
            [W / 2 - 60, H / 2],
            [W / 2 + 60, H / 2],
          ]);
          for (const px of screen) expect(isFill(px), `screen centre pixel ${px}`).toBe(true);
        });

        it(`${backend}, LOD ${lod ? "on" : "off"}, ${kind}: a large node keeps its border band where it was`, async () => {
          // Radius 10, border 1 (a tenth, under the cap), ×4: the border band covers [36, 40] px from the centre.
          const [inBand, inside, centre] = await render(backend, styleOf("world", 10, 1), { k: 4, x: W / 2, y: H / 2 }, 30, lod, [
            [W / 2 + 38, H / 2],
            [W / 2 + 34, H / 2],
            [W / 2, H / 2],
          ]);
          expect(isBorder(inBand!), `in the band ${inBand}`).toBe(true);
          expect(isFill(inside!), `just inside the band ${inside}`).toBe(true);
          expect(isFill(centre!), `centre ${centre}`).toBe(true);
        });
      }
    }
  }
});
