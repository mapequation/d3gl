import { describe, it, expect } from "vitest";
import { network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import { diffExports } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * #445 through the engine: `nodeFill: { by, scale }` fills a collapsed module with the scale on its total
 * flow, and `flowBorder.moduleFlow` gives a module its own ring value (its colour accessor sees that value).
 * Read from `toSVG()` — the same emit the backend draws — on all three backends, which must agree.
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

/** Two two-node modules that collapse to two aggregate glyphs at k = 1 with `expandPx: 20`. */
const graph = () =>
  buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true, nodeFlow: [0.1, 0.2, 0.3, 0.4] });
const MODULES = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
];
const POS = new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]);
const ENTER_EXIT = new Float32Array([0.5, 0.5, 0.5, 0.5]);

const byte = (v: number) => Math.round(255 * v);
const STYLE: NetworkStyle = {
  directed: true,
  nodeRadius: 5,
  linkStyle: "none",
  nodeFill: { by: "flow", scale: (v) => `rgb(${byte(v)}, 0, 0)` }, // red ∝ flow
  flowBorder: {
    flow: ENTER_EXIT,
    scale: (v) => 4 * v, // ring width ∝ enter/exit flow
    color: (v) => `rgb(0, ${byte(v)}, 0)`, // green ∝ the value the ring draws
    moduleFlow: (path) => (path.length === 1 && path[0] === 1 ? 0.3 : undefined), // only module [1] has one
  },
};

interface Circle { fill: number[]; stroke: number[]; strokeWidth: number }

/** Every exported `<circle>`'s fill + stroke channels and stroke width, in document order. */
function circles(svg: string): Circle[] {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const rgba = (s: string | null) => (s?.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  return Array.from(doc.querySelectorAll("circle"), (c) => ({
    fill: rgba(c.getAttribute("fill")),
    stroke: rgba(c.getAttribute("stroke")),
    strokeWidth: Number(c.getAttribute("stroke-width") ?? 0),
  }));
}

describe("nodeFill { by, scale } + flowBorder.moduleFlow through the engine (#445)", () => {
  const exports = new Map<string, string>(); // backend → the collapsed view's export, for the pixel diff
  for (const backend of ["webgl", "canvas", "svg"] as const) {
    it(`${backend}: a collapsed module fills by its total flow and rings by its module value`, async () => {
      const net = network(host(), { width: 200, height: 200, backend });
      await net.whenReady();
      net.data(graph(), { modules: MODULES }).style(STYLE).lod({ expandPx: 20 }).layout({ backend: "positions", positions: POS });
      net.setTransform({ k: 1, x: 0, y: 0 });

      const svg = net.toSVG();
      exports.set(backend, svg);
      const agg = circles(svg).sort((a, b) => a.fill[0]! - b.fill[0]!);
      expect(agg).toHaveLength(2);
      // Fill: the scale on each module's summed flow — 0.1 + 0.2, and 0.3 + 0.4.
      expect(agg[0]!.fill).toEqual([byte(0.3), 0, 0]);
      expect(agg[1]!.fill).toEqual([byte(0.7), 0, 0]);
      // Ring: module [1] draws its own value 0.3 (not the members' 1.0); module [2] has none → the sum.
      expect(agg[0]!.strokeWidth).toBeCloseTo(4 * 0.3, 3);
      expect(agg[1]!.strokeWidth).toBeCloseTo(4 * 1.0, 3);
      expect(agg[0]!.stroke).toEqual([0, byte(0.3), 0]);
      expect(agg[1]!.stroke).toEqual([0, byte(1.0), 0]);

      // LOD off: every node is filled by its own flow, and rings by its own enter/exit flow.
      net.lod(false);
      const leaves = circles(net.toSVG()).sort((a, b) => a.fill[0]! - b.fill[0]!);
      expect(leaves.map((c) => c.fill[0])).toEqual([0.1, 0.2, 0.3, 0.4].map(byte));
      for (const c of leaves) {
        expect(c.strokeWidth).toBeCloseTo(4 * 0.5, 3);
        expect(c.stroke).toEqual([0, byte(0.5), 0]);
      }
      net.destroy();
    });
  }

  it("the three backends' exports rasterise to the same pixels", async () => {
    const gl = exports.get("webgl")!;
    for (const other of ["canvas", "svg"]) {
      const d = await diffExports(gl, exports.get(other)!, 200, 200, { radius: 1 });
      expect(d.considered).toBeGreaterThan(300); // two ringed module discs of real ink
      expect(d.fraction).toBeLessThan(0.005);
    }
  });

  it("a structural tree fills by the summed flow too, but ignores moduleFlow and sums the ring", async () => {
    // 64 nodes on a ring, 8 modules of 8; zoomed far out with a huge expandPx, the cut is the root alone.
    const n = 64;
    const source = Array.from({ length: n }, (_, i) => i);
    const target = source.map((i) => (i + 1) % n);
    const g = buildGraph({ nodeCount: n, source, target, directed: true, nodeFlow: new Float32Array(n).fill(1 / n) });
    const modules = source.map((i) => ({ id: i, path: [1 + Math.floor(i / 8), 1 + (i % 8)] }));
    const positions = new Float32Array(source.flatMap((i) => [100 + 50 * Math.cos((2 * Math.PI * i) / n), 100 + 50 * Math.sin((2 * Math.PI * i) / n)]));
    const style: NetworkStyle = {
      ...STYLE,
      flowBorder: { flow: new Float32Array(n).fill(1 / n), scale: (v) => 4 * v, color: (v) => `rgb(0, ${byte(v)}, 0)`, moduleFlow: () => 0.1 },
    };
    const net = network(host(), { width: 200, height: 200, backend: "canvas" });
    await net.whenReady();
    net.data(g, { modules }).style(style).layout({ backend: "positions", positions });
    net.setTransform({ k: 0.05, x: 95, y: 95 });

    // Modules: the root module's own value (path []) is 0.1.
    net.lod({ expandPx: 10_000 });
    const root = circles(net.toSVG());
    expect(root).toHaveLength(1);
    expect(root[0]!.fill).toEqual([255, 0, 0]); // total flow 1
    expect(root[0]!.strokeWidth).toBeCloseTo(0.4, 3);
    expect(root[0]!.stroke).toEqual([0, byte(0.1), 0]);

    // Structure: coarsening stops at a few top aggregates. Each fills by its members' summed flow, and its
    // ring sums their enter/exit flow — the same members' fraction, as both leaf values are 1/64 — and
    // moduleFlow's 0.1 is never read. So each glyph's ring width and green follow its fill's red.
    net.lod({ expandPx: 10_000, source: "structure" });
    const top = circles(net.toSVG());
    expect(top.length).toBeGreaterThan(1);
    expect(top.length).toBeLessThan(n);
    let red = 0;
    for (const c of top) {
      red += c.fill[0]!;
      expect(c.fill[0]).toBeGreaterThan(byte(1 / n)); // an aggregate, not a leaf
      expect(c.stroke[1]).toBe(c.fill[0]);
      expect(c.strokeWidth).toBeCloseTo((4 * c.fill[0]!) / 255, 1);
    }
    expect(Math.abs(red - 255)).toBeLessThanOrEqual(top.length); // the fractions cover the whole flow
    net.destroy();
  });
});
