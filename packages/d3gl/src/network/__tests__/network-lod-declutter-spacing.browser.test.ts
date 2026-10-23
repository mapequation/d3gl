import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * #512: LOD declutter hides a frontier glyph whose centre is within `declutterSpacing·(rᵢ + rⱼ)` of a
 * kept glyph. The default spacing 2 keeps a gap around kept glyphs (so links between them stay visible),
 * which in this small graph hides one of two module aggregates that don't overlap. `declutterSpacing: 1`
 * (only real overlaps) and `declutter: false` draw both. WebGL, Canvas and SVG.
 */

const W = 200;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const MODULES = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
];
/** Each module's two members overlap, so each module collapses to one aggregate (r = 12·√2 ≈ 17). The two
 * aggregate centres are ≈ 49 px apart: a ≈ 15 px gap between the circles. */
const CLUSTERED = new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]);

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${W}px`;
  document.body.appendChild(el);
  return el;
}

type Declutter = { declutter?: boolean; declutterSpacing?: number };

async function drawnCircles(backend: (typeof BACKENDS)[number], declutter: Declutter = {}): Promise<number> {
  const net = network(host(), { width: W, height: W, backend });
  await net.whenReady();
  net
    .data(buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true }))
    .style({ nodeRadius: 12, linkStyle: "none" });
  net.lod({ modules: MODULES, expandPx: 20, ...declutter });
  net.layout({ backend: "positions", positions: CLUSTERED });
  net.setTransform({ k: 1, x: 0, y: 0 });
  const count = (net.toSVG().match(/<circle[^>]*>/g) ?? []).length;
  net.destroy();
  return count;
}

describe("#512 LOD declutter's spacing rule", () => {
  for (const backend of BACKENDS) {
    it(`${backend}: the default spacing 2 hides one of two non-overlapping module aggregates`, async () => {
      expect(await drawnCircles(backend)).toBe(1);
    });

    it(`${backend}: declutterSpacing 1 hides only real overlaps, so both aggregates are drawn`, async () => {
      expect(await drawnCircles(backend, { declutterSpacing: 1 })).toBe(2);
    });

    it(`${backend}: declutter false draws both aggregates`, async () => {
      expect(await drawnCircles(backend, { declutter: false })).toBe(2);
    });
  }
});
