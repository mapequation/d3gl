import { describe, expect, it } from "vitest";
import { network } from "../network.js";
import { computeLODCrowding, computeLODGeometry, crowdingOptionsOf, cut, declutterFrontier, lodSpacing, type LODTransform } from "../lod.js";
import { buildModuleLODTree } from "../modules.js";
import { sierpinski } from "./sierpinski-fixture.js";

/**
 * #561 — the engine cuts at the declutter spacing: the Modular level of detail example's setup draws exactly the
 * glyphs a cut at `lodSpacing` opens, none hidden by the declutter. Before, the engine cut at overlap (spacing 1)
 * and the default declutter (spacing 2) hid a third to two thirds of what it opened, with their links.
 */

const W = 760;
const H = 520;
const BACKENDS = ["webgl", "canvas", "svg"] as const;

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

describe("the engine's LOD cut at the declutter spacing (#561)", () => {
  for (const backend of BACKENDS) {
    it(`${backend}: draws every glyph the spacing-2 cut opens on the modular-LOD gasket`, async () => {
      const { graph, modules } = sierpinski(4);
      // The pure pipeline, as the engine should run it: crowding and cut at the default spacing.
      const spacing = lodSpacing(undefined, undefined);
      const tree = buildModuleLODTree(graph.nodeCount, modules);
      computeLODGeometry(tree, graph, new Float32Array(graph.nodeCount).fill(6), graph.strength);
      computeLODCrowding(tree, crowdingOptionsOf(tree, { screenSized: true, expandPx: 120, spacing }));

      const el = host();
      const net = network(el, { width: W, height: H, backend });
      await net.whenReady();
      net.data(graph, { modules }).style({ sizeMode: "screen", nodeRadius: 6, linkStyle: "none" });
      net.lod({ expandPx: 120, maxAggregateRadius: 26 });
      net.layout({ backend: "positions", positions: graph.positions.slice() });
      try {
        // Zooms where a cut at overlap (spacing 1) draws more than the declutter keeps: the opening view and the
        // leaf transition of the example.
        for (const k of [0.3, 0.54, 0.8, 1.3, 1.9, 2.6]) {
          const t: LODTransform = { k, x: W / 2 - 500 * k, y: H / 2 - 433 * k };
          net.setTransform(t);
          const drawn = cut(tree, t, W, H, { expandPx: 120, spacing, screenSized: true, maxAggregateRadius: 26 }).slice();
          const kept = declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k, maxAggregateRadius: 26, spacing });
          expect(kept.length, `k = ${k}: the cut is never thinned`).toBe(drawn.length);
          net.syncScreenGeometry(); // the vector backends re-cut at the end of a zoom (#138)
          const circles = (net.toSVG().match(/<circle[^>]*>/g) ?? []).length;
          expect(circles, `k = ${k}: the engine draws the cut's glyphs`).toBe(drawn.length);
        }
      } finally {
        net.destroy();
        el.remove();
      }
    });
  }
});
