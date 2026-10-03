import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";

/**
 * #447: where the cut keeps every node as a leaf, LOD on draws the links as LOD off does — the leaf links by
 * edge id from the full-detail path's own style columns, through the same vertex shaders with their inputs
 * fetched from the edge tables — so the two frames are the same pixels, for each link glyph (lines,
 * lines + arrowheads, half-arrows), bent or straight, with and without a selection.
 */

const W = 240;
const H = 240;

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/** 36 nodes on a 6 × 6 grid, 40 apart (nothing overlaps at k = 1), in 6 modules of a row each; ring and chord edges. */
function fixture(directed: boolean): { graph: NetworkGraph; positions: Float32Array; modules: { id: number; path: number[] }[] } {
  const n = 36;
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i); target.push((i + 1) % n); weight.push(1 + (i % 4));
    source.push(i); target.push((i * 7 + 5) % n); weight.push(0.5 + (i % 3));
    if (i % 5 === 0) { source.push((i * 7 + 5) % n); target.push(i); weight.push(2); } // the reverse direction too
  }
  const graph = buildGraph({ nodeCount: n, source, target, weight, directed });
  const positions = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = 20 + 40 * (i % 6);
    positions[2 * i + 1] = 20 + 40 * Math.floor(i / 6);
  }
  const modules = Array.from({ length: n }, (_, i) => ({ id: i, path: [1 + Math.floor(i / 6), 1 + (i % 6)] }));
  return { graph, positions, modules };
}

const CASES = [
  { name: "lines", directed: false, style: { linkStyle: "line" as const } },
  { name: "bent lines + arrowheads", directed: true, style: { linkStyle: "line" as const, linkBend: 0.3 } },
  { name: "half-arrows", directed: true, style: { linkStyle: "half-arrow" as const } },
];

type Case = (typeof CASES)[number];

/** One engine's frame of the fixture: LOD on (modules, every node opened) or off, with an optional selection.
 *  A fresh engine per frame, so the lanes register in the same order in both modes. */
async function frame(c: Case, lod: false | "modules" | "spatial", selected: number[] | null, style: object = {}): Promise<string> {
  const el = host();
  const net = network(el, { width: W, height: H, backend: "webgl" });
  await net.whenReady();
  const { graph, positions, modules } = fixture(c.directed);
  net.data(graph).style({ directed: c.directed, nodeRadius: 4, linkWidth: 2, ...c.style, ...style }).layout({ backend: "positions", positions });
  // The module tree's leaf links come from a walk of the kept leaves' rows; the spatial tree's from the lazy
  // gather's own read of them, sorted into edge order (#447) — without the sort they stack differently where a
  // selected link crosses another.
  if (lod === "modules") net.lod({ modules, expandPx: 1 });
  else if (lod === "spatial") net.lod({ source: "spatial", expandPx: 1 });
  net.setTransform({ k: 1, x: 0, y: 0 });
  if (lod) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const visible = [...((net as any).instancedLanes.get("network").lane.visible as Uint32Array)];
    expect(visible.length, "every node kept").toBe(graph.nodeCount);
    expect(visible.every((g) => g < tree.leafCount), "no aggregate").toBe(true);
    if (!("linkStyle" in style)) expect((net as any).leafLinksDrawn, "every edge a leaf link").toBe(graph.edgeCount);
  }
  if (selected) {
    net.interactive({ selectable: true });
    net.select("nodes", selected);
  }
  const png = net.render().toPNG();
  net.destroy();
  el.remove();
  return png;
}

describe("network LOD leaf links render as LOD off (#447)", () => {
  for (const c of CASES) {
    it(`${c.name}: the same pixels where every node is a leaf, with and without a selection (module and spatial trees)`, async () => {
      const off = await frame(c, false, null);
      // Not vacuous: the links are in those pixels.
      expect((await frame(c, false, null, { linkStyle: "none" })) === off, "the frame without links equals the frame with them").toBe(false);
      // A selection (the per-edge selected flags): the same dim and recolour, and the same stacking where links cross.
      const offSel = await frame(c, false, [3, 14]);
      expect(offSel === off, "the selection changes the frame").toBe(false);
      for (const source of ["modules", "spatial"] as const) {
        expect((await frame(c, source, null)) === off, `${source}: LOD on and off frames differ`).toBe(true);
        expect((await frame(c, source, [3, 14])) === offSel, `${source}: LOD on and off frames differ with a selection`).toBe(true);
      }
    });
  }
});
