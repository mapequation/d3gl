import { afterEach, describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import { DROP_HALF_SPREAD, DROP_LENGTH } from "../../core/loop-drop.js";

/**
 * #535: a state link between two state nodes of ONE physical node is flow that stays in that physical node. The
 * physical graph keeps it as the node's self-link, and the physical view draws its loop, on WebGL, Canvas and SVG.
 *
 * Physical node A (0, at x = 60) holds state nodes 0 and 1; physical node B (1, at x = 140) holds state node 2.
 * State links 0 → 2 and 1 → 2 cross from A to B; 0 → 1 stays in A. A's loop points away from B, towards −x. The
 * drop is a cubic from the centre back to the centre with its controls DROP_LENGTH·r out along ±DROP_HALF_SPREAD,
 * so its far end (the cubic's midpoint) sits `0.75·DROP_LENGTH·cos(θ)·r` left of A's centre, outside the node.
 */

const W = 200;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const R = 10;
const CX = 60;
const CY = 100;
const APEX_X = CX - 0.75 * DROP_LENGTH * Math.cos(DROP_HALF_SPREAD) * R;
const POSITIONS = new Float32Array([CX, CY, 140, CY]);

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${W}px`;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/** How many pixels of the rendered frame in the box are the link colour (red). */
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
  for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 0) > 180 && (d[i + 1] ?? 0) < 90 && (d[i + 2] ?? 0) < 90) n++;
  return n / (s * s);
}

/** The state network in its physical view, A and B placed; `inside` adds the state link 0 → 1 inside A. */
async function draw(backend: (typeof BACKENDS)[number], inside: boolean) {
  const net = network(host(), { width: W, height: W, backend });
  await net.whenReady();
  const graph = buildStateGraph({
    stateCount: 3,
    stateToPhysical: [0, 0, 1],
    source: inside ? [0, 1, 0] : [0, 1],
    target: inside ? [2, 2, 1] : [2, 2],
    weight: inside ? [1, 1, 2] : [1, 1],
    nodeFlow: [0.25, 0.25, 0.5],
    directed: true,
  });
  net
    .style({ nodeRadius: R, nodeFill: "#000000", linkStroke: "#ff0000", linkWidth: 3, arrowSize: 4, directed: true, sizeMode: "screen" })
    .stateNetwork(graph, { view: "physical" });
  net.layout({ backend: "positions", positions: POSITIONS });
  net.setTransform({ k: 1, x: 0, y: 0 });
  const png = backend === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(net.toSVG())}` : net.toPNG();
  net.destroy();
  return png;
}

/** The loop's box: left of A, beyond its rim. */
const loopRed = (png: string): Promise<number> => redPixels(png, APEX_X - 4, CY - 14, CX - R - 1, CY + 14);

describe("state network: the physical view draws a loop for flow that stays in a physical node (#535)", () => {
  for (const backend of BACKENDS)
    it(`${backend}: a state link inside one physical node draws that node's loop; none without it`, async () => {
      const withLink = await draw(backend, true);
      const loop = await loopRed(withLink);
      // Nothing red beyond B (B has no self-link).
      const atB = await redPixels(withLink, 152, CY - 14, 180, CY + 14);
      const without = await loopRed(await draw(backend, false));
      expect(loop).toBeGreaterThan(20);
      expect(atB).toBe(0);
      expect(without).toBe(0);
    });
});
