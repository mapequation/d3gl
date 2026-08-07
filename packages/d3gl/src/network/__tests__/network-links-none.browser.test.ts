import { describe, it, expect } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { NetworkGraph } from "../graph.js";
import type { BackendType } from "../../map/backend-factory.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

/** Count elements of one tag in a serialized document (`<circle …` / `<path …`). */
function count(svg: string, tag: string): number {
  return (svg.match(new RegExp(`<${tag}[\\s/>]`, "g")) ?? []).length;
}

const BACKENDS: BackendType[] = ["webgl", "canvas", "svg"];

/** 4 nodes, no edges at all. */
const edgeless = (): NetworkGraph => buildGraph({ nodeCount: 4, source: [], target: [], directed: true });
const POS4 = new Float32Array([40, 40, 100, 40, 40, 100, 100, 100]);

/** Mount + settle a network on `backend`, then hand it to `body`. */
async function withNet(backend: BackendType, body: (net: Network) => void): Promise<void> {
  const net = network(host(), { width: 200, height: 200, backend });
  await net.whenReady();
  try {
    body(net);
  } finally {
    net.destroy();
  }
}

// ---------------------------------------------------------------------------
// 1. A network with genuinely ZERO links must render fine on every backend.
// ---------------------------------------------------------------------------
describe("network with zero edges (#157)", () => {
  for (const backend of BACKENDS) {
    it(`renders nodes only, no link geometry, on the ${backend} backend`, async () => {
      await withNet(backend, (net) => {
        net.data(edgeless()).style({ nodeRadius: 6, directed: true }).layout({ backend: "positions", positions: POS4 });
        net.setTransform({ k: 1, x: 0, y: 0 });
        net.syncScreenGeometry();
        const svg = net.toSVG();
        expect(count(svg, "circle")).toBe(4);
        expect(count(svg, "path")).toBe(0);
      });
    });
  }

  it("renders an edgeless graph under LOD (spatial tree) without link geometry", async () => {
    await withNet("webgl", (net) => {
      net.data(edgeless()).style({ nodeRadius: 6, directed: true }).lod({ expandPx: 20 }).layout({ backend: "positions", positions: POS4 });
      net.setTransform({ k: 1, x: 0, y: 0 });
      net.syncScreenGeometry();
      const svg = net.toSVG();
      expect(count(svg, "circle")).toBeGreaterThan(0);
      expect(count(svg, "path")).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2/3. linkStyle:"none" and a constant linkWidth:0 skip the link layers entirely.
// ---------------------------------------------------------------------------
const line3 = (): NetworkGraph => buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
const POS3 = new Float32Array([40, 40, 100, 100, 160, 60]);

/** A 4-node graph in two two-node modules — collapses to two aggregate glyphs at k = 1. */
const clustered = (): NetworkGraph => buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
const CLUSTER_MODULES = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
];
const CLUSTER_POS = new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]);

describe('network style({ linkStyle: "none" }) (#157)', () => {
  for (const backend of BACKENDS) {
    it(`draws nodes only on the ${backend} backend (baseline draws links)`, async () => {
      await withNet(backend, (net) => {
        net.data(line3()).style({ nodeRadius: 6, directed: true }).layout({ backend: "positions", positions: POS3 });
        net.setTransform({ k: 1, x: 0, y: 0 });
        net.syncScreenGeometry();
        // Baseline: 2 links + 2 arrowheads are drawn.
        expect(count(net.toSVG(), "path")).toBeGreaterThan(0);

        net.style({ nodeRadius: 6, directed: true, linkStyle: "none" });
        net.syncScreenGeometry();
        const svg = net.toSVG();
        expect(count(svg, "circle")).toBe(3);
        expect(count(svg, "path")).toBe(0); // no links, no arrowheads
      });
    });
  }

  it("skips the LOD super-edges too (WebGL frontier emit)", async () => {
    await withNet("webgl", (net) => {
      net
        .data(clustered())
        .style({ nodeRadius: 5, directed: true })
        .lod({ modules: CLUSTER_MODULES, expandPx: 20 })
        .layout({ backend: "positions", positions: CLUSTER_POS });
      net.setTransform({ k: 1, x: 0, y: 0 });
      expect(count(net.toSVG(), "path")).toBeGreaterThan(0); // baseline: a super-edge is drawn

      net.style({ nodeRadius: 5, directed: true, linkStyle: "none" });
      const svg = net.toSVG();
      expect(count(svg, "circle")).toBe(2); // the two aggregate glyphs still draw
      expect(count(svg, "path")).toBe(0); // no super-edges, no arrowheads

      // Back on: the lane's emitted-layer SET changed, so base-engine re-adds the slots in canonical
      // order — the super-edges must come back (nothing was lost by skipping them).
      net.style({ nodeRadius: 5, directed: true, linkStyle: "line" });
      expect(count(net.toSVG(), "path")).toBeGreaterThan(0);
    });
  });

  it("skips the LOD super-edges on the retained Scene path (SVG export)", async () => {
    await withNet("svg", (net) => {
      net
        .data(clustered())
        .style({ nodeRadius: 5, directed: true, linkStyle: "none" })
        .lod({ modules: CLUSTER_MODULES, expandPx: 20 })
        .layout({ backend: "positions", positions: CLUSTER_POS });
      net.setTransform({ k: 1, x: 0, y: 0 });
      net.syncScreenGeometry();
      const svg = net.toSVG();
      expect(count(svg, "circle")).toBe(2);
      expect(count(svg, "path")).toBe(0);
    });
  });

  it("is reversible — switching back to \"line\" restores the links", async () => {
    await withNet("svg", (net) => {
      net.data(line3()).style({ nodeRadius: 6, directed: true, linkStyle: "none" }).layout({ backend: "positions", positions: POS3 });
      net.setTransform({ k: 1, x: 0, y: 0 });
      net.syncScreenGeometry();
      expect(count(net.toSVG(), "path")).toBe(0);

      net.style({ nodeRadius: 6, directed: true, linkStyle: "line" });
      net.syncScreenGeometry();
      expect(count(net.toSVG(), "path")).toBeGreaterThan(0);
    });
  });
});

// `linkStyle: "none"` is a RENDERING choice, not a data one: the edges still drive the force layout
// (`layout()` reads `this.graph`, never `this.styleOpts` — see network.ts `layout()` and
// `ForceLayout.tick`'s attraction loop over `graph.source`/`graph.target`).
describe('linkStyle: "none" does not change the layout (#157)', () => {
  /** A deterministic 24-node ring — every node has degree 2, so the springs visibly shape the result. */
  const ring = (): NetworkGraph => {
    const n = 24;
    const source = Array.from({ length: n }, (_, i) => i);
    const target = Array.from({ length: n }, (_, i) => (i + 1) % n);
    return buildGraph({ nodeCount: n, source, target });
  };

  const laidOut = async (linkStyle: "line" | "none", graph: NetworkGraph): Promise<Float32Array> => {
    const net = network(host(), { width: 200, height: 200, backend: "canvas" });
    await net.whenReady();
    net.data(graph).style({ nodeRadius: 4, linkStyle }).layout({ backend: "force", iterations: 80 });
    net.destroy();
    return Float32Array.from(graph.positions);
  };

  it("produces the SAME positions as linkStyle:\"line\", and edges still matter", async () => {
    const drawn = await laidOut("line", ring());
    const hidden = await laidOut("none", ring());
    expect(Array.from(hidden)).toEqual(Array.from(drawn)); // identical solve — the springs still ran

    // Control: drop the edges from the data and the same solve gives a different arrangement, so the
    // equality above is not vacuous (the springs are doing something).
    const noEdges = buildGraph({ nodeCount: 24, source: [], target: [] });
    const scattered = await laidOut("none", noEdges);
    expect(Array.from(scattered)).not.toEqual(Array.from(drawn));
  });
});

describe("network style({ linkWidth: 0 }) (#157)", () => {
  for (const backend of BACKENDS) {
    it(`takes the same skip path on the ${backend} backend`, async () => {
      await withNet(backend, (net) => {
        net.data(line3()).style({ nodeRadius: 6, directed: true, linkWidth: 0 }).layout({ backend: "positions", positions: POS3 });
        net.setTransform({ k: 1, x: 0, y: 0 });
        net.syncScreenGeometry();
        const svg = net.toSVG();
        expect(count(svg, "circle")).toBe(3);
        expect(count(svg, "path")).toBe(0);
      });
    });
  }

  it("a width SCALE that happens to return 0 does NOT skip (only a constant 0 does)", async () => {
    await withNet("svg", (net) => {
      net
        .data(line3())
        .style({ nodeRadius: 6, directed: true, linkWidth: (w: number) => (w > 5 ? 0 : 2) })
        .layout({ backend: "positions", positions: POS3 });
      net.setTransform({ k: 1, x: 0, y: 0 });
      net.syncScreenGeometry();
      expect(count(net.toSVG(), "path")).toBeGreaterThan(0);
    });
  });
});
