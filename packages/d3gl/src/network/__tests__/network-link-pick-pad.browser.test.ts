import { describe, it, expect } from "vitest";
import { network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * The Canvas/SVG pick pad of a filled link in screen sizing (#542). A directed `line` and a half-arrow are one
 * filled shape, baked into world coords at the current zoom; their pick pad must stay 1 px on screen (as the
 * stroked screen-mode link's was), not 1 world unit (k px). Measured through the public pick() at a far zoom-out
 * and a far zoom-in, each after the zoom-end re-bake.
 */

const W = 200;
const H = 200;
const BACKENDS = ["canvas", "svg"] as const;
const ZOOMS = [0.1, 20] as const;
// The link runs along world y = 0, drawn along screen y = H/2 through the view centre at every zoom.
const POS = new Float32Array([-1000, 0, 1000, 0]);
const transformAt = (k: number): { k: number; x: number; y: number } => ({ k, x: W / 2, y: H / 2 });
const WIDTH = 1;
const GLYPHS: readonly { name: string; style: NetworkStyle }[] = [
  { name: "directed line", style: { directed: true, linkStyle: "line", linkWidth: WIDTH, arrowSize: 4, nodeRadius: 4, sizeMode: "screen" } },
  { name: "half-arrow", style: { directed: true, linkStyle: "half-arrow", linkWidth: WIDTH, linkBend: 0, nodeRadius: 4, sizeMode: "screen" } },
];

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/** The screen-y offsets from the centre line (step 0.125 px) at which pick() at the view centre hits the link. */
function hitBand(pick: (y: number) => boolean): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (let dy = -12; dy <= 12; dy += 0.125) {
    if (!pick(dy)) continue;
    lo = Math.min(lo, dy);
    hi = Math.max(hi, dy);
  }
  return { lo, hi };
}

describe("filled link pick pad in screen sizing (#542)", () => {
  for (const backend of BACKENDS) {
    for (const { name, style } of GLYPHS) {
      for (const k of ZOOMS) {
        it(`${backend} · ${name} · k=${k}: the pick pad is 1 px on screen`, async () => {
          const net = network(host(), { width: W, height: H, backend });
          await net.whenReady();
          net.data(buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true })).style(style).layout({ backend: "positions", positions: POS });
          net.setTransform(transformAt(k));
          net.syncScreenGeometry();
          const onLink = (dy: number): boolean => net.pick(W / 2, H / 2 + dy)?.layer === "links";
          const band = hitBand(onLink);
          // The body is WIDTH px thick and the pad 1 px on each side: the band spans WIDTH + 2 px at every zoom
          // (a 1-world-unit pad would make it WIDTH + 0.2 px at k = 0.1 and WIDTH + 40 px at k = 20).
          expect(band.hi - band.lo).toBeGreaterThan(WIDTH + 2 - 0.5);
          expect(band.hi - band.lo).toBeLessThan(WIDTH + 2 + 0.5);
          if (style.linkStyle === "line") {
            // The arrow's shaft is centred on the line: 1.25 px off it (0.75 px outside the body) hits, 3 px misses.
            for (const side of [-1, 1]) {
              expect(onLink(side * 1.25)).toBe(true);
              expect(onLink(side * 3)).toBe(false);
            }
          }
          net.destroy();
        });
      }
    }
  }
});
