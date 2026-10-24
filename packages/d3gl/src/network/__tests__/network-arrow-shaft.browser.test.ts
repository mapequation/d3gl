import { describe, it, expect } from "vitest";
import { network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import { arrowHead } from "../../core/arrowhead.js";
import { decodeImage, type PixelBuffer } from "../../map/__tests__/backend-equivalence-harness.js";
import type { ModuleNode } from "../modules.js";

/**
 * #542 (design C), LOD off: a directed `line` link is ONE shape — the shaft up to the head's base, then the head —
 * on WebGL, Canvas and SVG. Read from the rendered pixels at two zooms, world and screen sizeMode, straight and bent:
 * the tip sits on the target's rim, no shaft pixel shows beside the tip (the head is always wider than the line),
 * no gap opens at the join, a translucent link has no darker band there (nothing double-blends), and a bent link's
 * head is full (both barbs) and sits on its own line's end.
 *
 * LOD on (#542 step 4): a leaf link (both ends kept leaves) and a super-edge (from a collapsed module to a leaf) are
 * the same one shape — the same assertions, and the same pixels as the LOD-off link around the head.
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

type Link = (typeof LINKS)[number];

/** The one-shape assertions on a rendered link from POS[0] to the target, read from its pixels. */
function expectOneShape(px: PixelBuffer, k: number, sizeMode: "world" | "screen", bend: number, link: Link): void {
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
}

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
              expectOneShape(await render(backend, style, k), k, sizeMode, bend, link);
            });
});

/**
 * The LOD-on frame (#542 step 4): `leaf` — both nodes top-level leaves, expanded, so the link is a leaf link (#447,
 * the indexed lane on WebGL); `super` — the source end a collapsed two-node module whose centroid is POS[0], so the
 * link is a super-edge to the leaf target (`expandPx` 120 opens the root, ~260px across, but not the module,
 * ~70px). Either way the link runs POS[0] → TARGET, as the LOD-off one does.
 */
async function renderLod(backend: (typeof BACKENDS)[number], style: NetworkStyle, k: number, kind: "leaf" | "super"): Promise<PixelBuffer> {
  const net = network(host(), { width: W, height: H, backend });
  await net.whenReady();
  const leaf = kind === "leaf";
  const positions = leaf ? POS : new Float32Array([40, 90, 40, 110, 200, 100]);
  const modules: ModuleNode[] = leaf
    ? [{ id: 0, path: [1] }, { id: 1, path: [2] }]
    : [{ id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2] }];
  const graph = leaf
    ? buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true })
    : buildGraph({ nodeCount: 3, source: [0, 1], target: [2, 2], directed: true });
  net.data(graph).style(style).lod({ modules, expandPx: leaf ? 1 : 120, declutter: false }).layout({ backend: "positions", positions });
  net.setTransform(transformAt(k));
  net.syncScreenGeometry();
  const png = backend === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(net.toSVG())}` : net.toPNG();
  net.destroy();
  return decodeImage(png, W, H);
}

describe("network: LOD on, a directed line link is the same one shape (#542)", () => {
  for (const backend of BACKENDS)
    for (const kind of ["leaf", "super"] as const)
      for (const bend of [0, 0.25])
        for (const sizeMode of ["world", "screen"] as const)
          for (const link of [LINKS[0], LINKS[2]])
            it(`${backend}, ${kind}, ${bend ? "bent" : "straight"}, ${sizeMode}, ${link.name}`, async () => {
              const k = 1.6;
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
              const lod = await renderLod(backend, style, k, kind);
              expectOneShape(lod, k, sizeMode, bend, link);
              // The same pixels as the LOD-off link, right of the source end (a collapsed module's glyph sits there).
              const off = await render(backend, style, k);
              let differ = 0;
              for (let y = 0; y < H; y++) for (let x = 110; x < W; x++) if (dist(at(lod, x, y), at(off, x, y)) > 24) differ++;
              expect(differ, "pixels that differ from the LOD-off link").toBeLessThanOrEqual(2);
            });
});
