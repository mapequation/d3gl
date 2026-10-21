import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * #512: LOD declutter hides a frontier glyph only when it overlaps a kept glyph (default
 * `declutterSpacing` 1). Two module aggregates that sit apart are both drawn at radius 12, on WebGL,
 * Canvas and SVG; `declutterSpacing: 2` still widens the exclusion and drops one of them.
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

async function drawnCircles(backend: (typeof BACKENDS)[number], declutterSpacing?: number): Promise<number> {
  const net = network(host(), { width: W, height: W, backend });
  await net.whenReady();
  net
    .data(buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true }))
    .style({ nodeRadius: 12, linkStyle: "none" });
  net.lod({ modules: MODULES, expandPx: 20, ...(declutterSpacing === undefined ? {} : { declutterSpacing }) });
  net.layout({ backend: "positions", positions: CLUSTERED });
  net.setTransform({ k: 1, x: 0, y: 0 });
  const count = (net.toSVG().match(/<circle[^>]*>/g) ?? []).length;
  net.destroy();
  return count;
}

describe("#512 LOD declutter hides only overlapping glyphs by default", () => {
  for (const backend of BACKENDS) {
    it(`${backend}: both non-overlapping module aggregates are drawn at radius 12`, async () => {
      expect(await drawnCircles(backend)).toBe(2);
    });

    it(`${backend}: declutterSpacing 2 still widens the exclusion and drops one`, async () => {
      expect(await drawnCircles(backend, 2)).toBe(1);
    });
  }
});
