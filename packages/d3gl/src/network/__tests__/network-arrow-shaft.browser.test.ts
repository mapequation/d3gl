import { describe, it, expect } from "vitest";
import { network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import { arrowHead } from "../../core/arrowhead.js";
import { decodeImage, type PixelBuffer } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * #542 (design C), LOD off: a directed `line` link is ONE shape — the shaft up to the head's base, then the head —
 * on WebGL, Canvas and SVG. Read from the rendered pixels at two zooms, world and screen sizeMode, straight and bent:
 * the tip sits on the target's rim, no shaft pixel shows beside the tip (the head is always wider than the line),
 * no gap opens at the join, a translucent link has no darker band there (nothing double-blends), and a bent link's
 * head is full (both barbs) and sits on its own line's end.
 */

const W = 300;
const H = 200;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const ZOOMS = [1, 1.6, 3] as const;
const RADIUS = 12;
// Target node at world (200, 100), drawn at screen (210, 100) at every zoom; the source sits to its left.
const POS = new Float32Array([40, 100, 200, 100]);
const TARGET = { x: 200, y: 100 };
const transformAt = (k: number): { k: number; x: number; y: number } => ({ k, x: 210 - TARGET.x * k, y: 100 - TARGET.y * k });

const LINKS = [
  { name: "thin", width: 2, size: 6, stroke: "#d62728" },
  { name: "wide (w > 2·size)", width: 10, size: 4, stroke: "#2ca02c" },
  { name: "translucent", width: 6, size: 6, stroke: "rgba(31, 119, 180, 0.5)" },
] as const;

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

async function render(backend: (typeof BACKENDS)[number], style: NetworkStyle, k: number): Promise<PixelBuffer> {
  const net = network(host(), { width: W, height: H, backend });
  await net.whenReady();
  net.data(buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true })).style(style).layout({ backend: "positions", positions: POS });
  net.setTransform(transformAt(k));
  net.syncScreenGeometry();
  const png = backend === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(net.toSVG())}` : net.toPNG();
  net.destroy();
  return decodeImage(png, W, H);
}

const at = (p: PixelBuffer, x: number, y: number): number[] => {
  const i = 4 * (Math.round(y) * p.width + Math.round(x));
  return [p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0, p.data[i + 3] ?? 0];
};
const dist = (a: number[], b: number[]): number => Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));

describe("network: a directed line link is one shape, shaft + head (#542, LOD off)", () => {
  for (const backend of BACKENDS)
    for (const bend of [0, 0.25])
      for (const sizeMode of ["world", "screen"] as const)
        for (const k of ZOOMS)
          for (const link of LINKS)
            it(`${backend}, ${bend ? "bent" : "straight"}, ${sizeMode}, k=${k}, ${link.name}`, async () => {
              const style: NetworkStyle = {
                directed: true,
                linkStyle: "line",
                linkBend: bend,
                sizeMode,
                nodeRadius: RADIUS,
                nodeFill: "rgba(0, 0, 0, 0)",
                linkWidth: link.width,
                arrowSize: link.size,
                linkStroke: link.stroke,
              };
              const px = await render(backend, style, k);
              const bg = at(px, 2, 2);
              const ink = (x: number, y: number): boolean => dist(at(px, x, y), bg) > 40;
              // The expected head in screen px (the geometry is scale-equivariant: solve at screen scale).
              const s = sizeMode === "world" ? k : 1;
              const t = transformAt(k);
              const head = new Float64Array(6);
              arrowHead(head, 0, {
                sx: (POS[0] ?? 0) * k + t.x, sy: (POS[1] ?? 0) * k + t.y, tx: TARGET.x * k + t.x, ty: TARGET.y * k + t.y,
                radius: RADIUS * s, width: link.width * s, size: link.size * s, bend,
              });
              const [lx, ly, tx, ty, rx, ry] = Array.from(head) as [number, number, number, number, number, number];
              const mx = (lx + rx) / 2, my = (ly + ry) / 2;
              const len = Math.hypot(tx - mx, ty - my);
              const ux = (tx - mx) / len, uy = (ty - my) / len;
              const nx = -uy, ny = ux;
              const wpx = link.width * s;

              // The tip sits on the target's rim: ink just inside it, none just past it.
              expect(Math.hypot(tx - 210, ty - 100)).toBeCloseTo(RADIUS * s, 3);
              // 4px back the thinnest head is ~1.3px wide: enough to cover a pixel centre without AA (WebGL's
              // toPNG has none, so a 1px sliver on a diagonal tip can fall between two pixel centres).
              expect(ink(tx - 4 * ux, ty - 4 * uy), "no ink just behind the tip").toBe(true);
              expect(ink(tx + 2 * ux, ty + 2 * uy), "ink past the tip (inside the target)").toBe(false);
              // No shaft pixel beside the tip: the line's edges never reach the tip region.
              const aside = Math.max(wpx / 2 - 0.5, 2.5);
              for (const side of [-1, 1])
                expect(ink(tx - ux + side * aside * nx, ty - uy + side * aside * ny), `link pixel beside the tip (side ${side})`).toBe(false);
              // The head is full: both barbs are drawn (a one-sided head misses one).
              for (const [a, b] of [[0.6, 0.2], [0.2, 0.6]] as const)
                expect(ink(0.2 * tx + a * lx + b * rx, 0.2 * ty + a * ly + b * ry), `barb ${a > b ? "left" : "right"} missing`).toBe(true);
              // No gap at the join: the axis from behind the base to the tip, and the shaft's edges across the base.
              // A bent link's shaft runs into the head along the head's axis, so it stays on the axis behind the base.
              const back = -8;
              // Sampled at pixel centres: `at` rounds, so a coordinate c reads the pixel covering [c − 0.5, c + 0.5);
              // shift by half (WebGL's toPNG has no AA, so a thin diagonal line can miss a half-pixel-off sample).
              const inkAt = (x: number, y: number): boolean => ink(x - 0.5, y - 0.5);
              for (let d = back; d <= len - 3; d += 1) expect(inkAt(mx + d * ux, my + d * uy), `gap on the axis at ${d.toFixed(0)}px from the base`).toBe(true);
              if (wpx >= 4)
                for (const side of [-1, 1])
                  for (let d = -3; d <= 1; d++)
                    expect(ink(mx + d * ux + side * (wpx / 2 - 1.5) * nx, my + d * uy + side * (wpx / 2 - 1.5) * ny), `gap at the shaft edge by the base (${side}, ${d})`).toBe(true);
              // No sideways step: just behind the base the shaft is centred on the head's axis.
              const extent = (side: number): number => {
                let e = 0;
                for (let o = 0; o <= wpx / 2 + 4; o += 0.25) {
                  if (!inkAt(mx - 3 * ux + side * o * nx, my - 3 * uy + side * o * ny)) break;
                  e = o;
                }
                return e;
              };
              expect(Math.abs(extent(1) - extent(-1)), "shaft off the head's axis behind the base").toBeLessThanOrEqual(1);
              // A translucent link composites once: the axis colour is the same on the shaft, across the join and in the head.
              if (link.name === "translucent") {
                const ref = at(px, mx + back * ux, my + back * uy);
                for (let d = back; d <= len - 3; d += 1) expect(dist(at(px, mx + d * ux, my + d * uy), ref), `darker band at ${d.toFixed(0)}px from the base`).toBeLessThanOrEqual(8);
              }
            });
});
