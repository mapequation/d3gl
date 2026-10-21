import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { buildStateGraph } from "../state-graph.js";
import { decodeImage, rasterizeSVG } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * #510: a share-mode flow border covers the share of a node's flow that leaves it (exit flow / flow) as a
 * share of the node's area — measured in pixels on every renderer (WebGL, Canvas, SVG), in both size modes,
 * with LOD off and on (leaves and module aggregates), and in a state network's views.
 *
 * Fill blue, flow border red, no links: inside a glyph a pixel is red (border) or blue (fill), so the share
 * of red among the glyph's red + blue pixels is the share of its area the border covers. Antialiased pixels
 * on the rims are neither and drop out of both counts.
 */

const W = 200;
const H = 200;
const R = 20;
const BLUE = "#0000ff";
const RED = "#ff0000";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

type Pixels = Awaited<ReturnType<typeof decodeImage>>;

/** The border's share of the red + blue pixels in a box. */
function redShare(px: Pixels, x0: number, y0: number, x1: number, y1: number): number {
  let red = 0;
  let blue = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * px.width + x) * 4;
      const r = px.data[o]!;
      const g = px.data[o + 1]!;
      const b = px.data[o + 2]!;
      if (r > 200 && g < 60 && b < 60) red++;
      else if (b > 200 && r < 60 && g < 60) blue++;
    }
  }
  return red + blue === 0 ? NaN : red / (red + blue);
}

// Node flow f and exit flow e. Leaves: e = f (all), e = 0 (none), e = f/2 (half), e = f/4 (a quarter).
const FLOW = [0.4, 0.1, 0.25, 0.25];
const EXIT = new Float32Array([0.4, 0, 0.125, 0.0625]);
const LEAF_SHARE = [1, 0, 0.5, 0.25];
// Modules {0, 1} and {2, 3}: summed exit flow over summed flow; the root likewise over all four.
const MODULE_SHARE = [0.4 / 0.5, 0.1875 / 0.5];
const ROOT_SHARE = 0.5875;
const MODULES = [
  { id: 0, path: [1, 1] },
  { id: 1, path: [1, 2] },
  { id: 2, path: [2, 1] },
  { id: 3, path: [2, 2] },
];
/** Four apart, one per quadrant: nothing overlaps, so LOD opens every module. */
const APART = new Float32Array([50, 50, 150, 50, 50, 150, 150, 150]);
/** Each module's two members overlapping, the modules far apart: LOD draws each module as one glyph. */
const OVERLAPPING = new Float32Array([90, 50, 110, 50, 90, 150, 110, 150]);

/** The three renderers, plus the WebGL `toSVG()` export (rebuilt through its own converter, #271). */
const BACKENDS = ["webgl", "canvas", "svg", "webgl toSVG"] as const;
const SIZE_MODES = ["world", "screen"] as const;

async function frame(
  backend: (typeof BACKENDS)[number],
  sizeMode: (typeof SIZE_MODES)[number],
  lod: false | { expandPx: number; source?: "spatial" },
  positions: Float32Array,
): Promise<Pixels> {
  const net = network(host(), { width: W, height: H, backend: backend === "webgl toSVG" ? "webgl" : backend });
  await net.whenReady();
  const graph = buildGraph({ nodeCount: 4, source: [], target: [], nodeFlow: FLOW });
  net.data(graph).style({ sizeMode, nodeRadius: R, nodeFill: BLUE, flowBorder: { share: true, flow: EXIT, color: RED } });
  if (lod) net.lod(lod.source ? { source: lod.source, expandPx: lod.expandPx, declutter: false } : { modules: MODULES, expandPx: lod.expandPx, declutter: false });
  net.layout({ backend: "positions", positions });
  net.setTransform({ k: 1, x: 0, y: 0 });
  expect(net.lodSource).toBe(lod ? (lod.source ?? "modules") : "none");
  net.render();
  const px = backend === "svg" || backend === "webgl toSVG" ? await rasterizeSVG(net.toSVG(), W, H) : await decodeImage(net.toPNG(), W, H);
  net.destroy();
  return px;
}

describe("share-mode flow border (#510): the border covers the exit-flow share of the area", () => {
  for (const backend of BACKENDS) {
    for (const sizeMode of SIZE_MODES) {
      for (const lod of [false, true]) {
        it(`${backend}, ${sizeMode} size, LOD ${lod ? "on" : "off"}: each node`, async () => {
          const px = await frame(backend, sizeMode, lod && { expandPx: 100 }, APART);
          const got = [0, 1, 2, 3].map((i) => redShare(px, (i % 2) * 100, Math.floor(i / 2) * 100, (i % 2) * 100 + 100, Math.floor(i / 2) * 100 + 100));
          for (let i = 0; i < 4; i++) expect(got[i], `node ${i}: ${got.map((v) => v.toFixed(3)).join(", ")}`).toBeCloseTo(LEAF_SHARE[i]!, 1);
          expect(got[0]).toBeGreaterThan(0.99); // e = f: the whole node in the flow-border colour
          expect(got[1]).toBeLessThan(0.01); // e = 0: no border
        });
      }
      it(`${backend}, ${sizeMode} size, LOD on: each module aggregate, and the root`, async () => {
        // Each module's members overlap, so it draws as one glyph below `expandPx`; the root's footprint
        // is larger, so it opens at 100 px and draws as one glyph at 400 px.
        const px = await frame(backend, sizeMode, { expandPx: 100 }, OVERLAPPING);
        const got = [redShare(px, 0, 0, W, 100), redShare(px, 0, 100, W, H)];
        for (let m = 0; m < 2; m++) expect(got[m], `module ${m}: ${got.map((v) => v.toFixed(3)).join(", ")}`).toBeCloseTo(MODULE_SHARE[m]!, 1);
        const root = await frame(backend, sizeMode, { expandPx: 400 }, OVERLAPPING);
        expect(redShare(root, 0, 0, W, H), "root").toBeCloseTo(ROOT_SHARE, 1);
      });
      it(`${backend}, ${sizeMode} size, LOD on, spatial source: each node through the spatial tree`, async () => {
        // A leaf under LOD reads its flow from the tree too (summed with the style), so this proves the spatial
        // tree carries it; the cells' sums are pinned against a main-thread build in flow-border-share.test.ts.
        const px = await frame(backend, sizeMode, { expandPx: 100, source: "spatial" }, APART);
        const got = [0, 1, 2, 3].map((i) => redShare(px, (i % 2) * 100, Math.floor(i / 2) * 100, (i % 2) * 100 + 100, Math.floor(i / 2) * 100 + 100));
        for (let i = 0; i < 4; i++) expect(got[i], `node ${i}: ${got.map((v) => v.toFixed(3)).join(", ")}`).toBeCloseTo(LEAF_SHARE[i]!, 1);
      });
    }
  }

  // A state network: physical node 0 holds state nodes 0 and 1 (one module, so no pie), physical nodes 1 and
  // 2 one state node each. Each view takes its own graph's node flow: a physical node's flow is the sum of its
  // state nodes' flow.
  const stateNetwork = () =>
    buildStateGraph({ stateCount: 4, stateToPhysical: [0, 0, 1, 2], source: [], target: [], nodeFlow: [0.2, 0.2, 0.4, 0.2], directed: false });
  const stateModules = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [3, 1] },
  ];
  const physicalPositions = new Float32Array([50, 100, 150, 50, 150, 150]);

  for (const backend of BACKENDS) {
    it(`${backend}: a state network's physical view divides by the physical nodes' flow, its state view by the state nodes'`, async () => {
      const net = network(host(), { width: W, height: H, backend: backend === "webgl toSVG" ? "webgl" : backend });
      await net.whenReady();
      net.style({ nodeRadius: R, nodeFill: BLUE }).stateNetwork(stateNetwork(), { modules: stateModules, view: "physical" });
      net.layout({ backend: "positions", positions: physicalPositions });
      // Physical flow [0.4, 0.4, 0.2]: shares 0.2/0.4, 0.1/0.4, 0.15/0.2.
      net.style({ nodeRadius: R, nodeFill: BLUE, flowBorder: { share: true, flow: new Float32Array([0.2, 0.1, 0.15]), color: RED } });
      net.setTransform({ k: 1, x: 0, y: 0 });
      const shot = async () => {
        net.render();
        const px = backend === "svg" || backend === "webgl toSVG" ? await rasterizeSVG(net.toSVG(), W, H) : await decodeImage(net.toPNG(), W, H);
        return [redShare(px, 0, 0, 100, H), redShare(px, 100, 0, W, 100), redShare(px, 100, 100, W, H)];
      };
      const physical = await shot();
      for (const [p, want] of [0.5, 0.25, 0.75].entries()) expect(physical[p], `physical ${p}: ${physical.map((v) => v.toFixed(3)).join(", ")}`).toBeCloseTo(want, 1);
      // The state view: state flow [0.2, 0.2, 0.4, 0.2], shares 1 and 0 (physical node 0's two state nodes,
      // equal in size: half its red + blue), 0.5 and 0.25.
      net.view("state");
      net.style({ nodeRadius: R, nodeFill: BLUE, flowBorder: { share: true, flow: new Float32Array([0.2, 0, 0.2, 0.05]), color: RED } });
      const state = await shot();
      for (const [p, want] of [0.5, 0.5, 0.25].entries()) expect(state[p], `state, around physical ${p}: ${state.map((v) => v.toFixed(3)).join(", ")}`).toBeCloseTo(want, 1);
      net.destroy();
    });
  }
});
