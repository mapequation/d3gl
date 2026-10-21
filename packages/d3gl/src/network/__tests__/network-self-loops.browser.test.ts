import { describe, it, expect } from "vitest";
import { network, type NetworkLinkHit } from "../network.js";
import { buildGraph } from "../graph.js";
import { LOOP_REACH } from "../self-loops.js";

/**
 * #505: a self-link draws as a loop at its node, on WebGL, Canvas and SVG, in both size modes; a directed one
 * shows its arrowhead; the half-arrow style draws it too; hovering or clicking the loop reports the self-link.
 *
 * Node 0 (at x = 60) has a self-link and one neighbour, node 1 (at x = 140), so its loop points away from it,
 * towards −x: its apex sits `r·(1 + LOOP_REACH)` left of the centre, outside the node.
 */

const W = 200;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const SIZE_MODES = ["screen", "world"] as const;
const R = 10;
const CX = 60;
const CY = 100;
const APEX_X = CX - R * (1 + LOOP_REACH);
const POSITIONS = new Float32Array([CX, CY, 140, CY]);

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${W}px`;
  document.body.appendChild(el);
  return el;
}

/** How many pixels of the rendered frame in the box are the link colour (red) — the loop sits there alone. */
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

interface Case {
  backend: (typeof BACKENDS)[number];
  sizeMode: (typeof SIZE_MODES)[number];
  directed: boolean;
  linkStyle?: "line" | "half-arrow";
  /** The edges after the 0–1 link: node 0's self-links (several = duplicates). */
  selfWeights?: number[];
  /** LOD on, every leaf kept (the loops of an LOD frame's kept leaves). */
  lod?: boolean;
}

async function draw(c: Case) {
  const net = network(host(), { width: W, height: W, backend: c.backend });
  await net.whenReady();
  const self = c.selfWeights ?? [1];
  const g = buildGraph({ nodeCount: 2, source: [0, ...self.map(() => 0)], target: [1, ...self.map(() => 0)], weight: [1, ...self], directed: c.directed });
  net
    .data(g)
    .style({ nodeRadius: R, nodeFill: "#000000", linkStroke: "#ff0000", linkWidth: 3, arrowSize: 4, directed: c.directed, linkStyle: c.linkStyle ?? "line", sizeMode: c.sizeMode })
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

  it("webgl: a half-arrow loop level with its neighbour (a vertical chord) bows outward in world mode", async () => {
    // Node 1 exactly level with node 0 (θ = π): the chord is vertical, the case the lane's side rule decides from
    // the offsets alone (#505). Inward, the loop would hide under the node and leave its box empty.
    const net = await draw({ backend: "webgl", sizeMode: "world", directed: true, linkStyle: "half-arrow" });
    const red = await loopRed(net.toPNG());
    net.destroy();
    expect(red).toBeGreaterThan(10);
  });
});
