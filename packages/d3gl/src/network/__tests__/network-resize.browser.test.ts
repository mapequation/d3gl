import { describe, it, expect, afterEach } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * Drives the map-of-modules example's exact re-render flow when the Nodes slider changes: reusing ONE
 * engine, `data(g) → lod({modules}) → layout({gpu,fit}) → style({flowBorder, nodeRadius:{by:'flow'}})`
 * at one size, then the SAME sequence at a different node count. Two regressions this guards (#206):
 *   1. swapping the graph must NOT throw `flowBorder.flow length … !== nodeCount …` — data() rebuilds with
 *      the previous style still holding the old-length per-node array (this was the reported slider crash);
 *   2. each size must open FRAMED (fit) — the bulk of nodes on-screen, not piled at the origin.
 */

const W = 820;
const H = 560;
const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  document.body.appendChild(host);
  hosts.push(host);
  return host;
}
afterEach(() => { for (const h of hosts) h.remove(); hosts.length = 0; });

const raggedPrefix = (c: number): number[] => {
  const sup = Math.floor(c / 4);
  return c % 4 === 0 ? [10000 + c] : c % 4 === 3 ? [1 + sup, 500 + sup, 200 + c] : [1 + sup, 100 + c];
};

/** A small directed modular network with per-node flow + boundary-flow arrays, like makeModularMap. */
function makeData(nodeCount: number) {
  const K = 12, per = Math.max(2, Math.floor(nodeCount / 12));
  const n = K * per;
  const community = new Int32Array(n);
  const members: number[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i++) { community[i] = i % K; members[i % K]!.push(i); }
  let s = 0xabcd >>> 0;
  const rand = () => ((s = Math.imul(1664525, s) + 1013904223), (s >>> 0) / 0x100000000);
  const src: number[] = [], tgt: number[] = [];
  for (let c = 0; c < K; c++) { const mem = members[c]!; for (const a of mem) for (let e = 0; e < 4; e++) { const b = mem[Math.floor(rand() * mem.length)]!; if (b !== a) { src.push(a, b); tgt.push(b, a); } } }
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { src.push(members[a]![0]!); tgt.push(members[b]![0]!); }
  const nodeFlow = new Float32Array(n);
  const enterExit = new Float32Array(n);
  for (let e = 0; e < src.length; e++) { nodeFlow[src[e]!]! += 1; if (community[src[e]!] !== community[tgt[e]!]) enterExit[src[e]!]! += 1; }
  const rank = new Map<number, number>();
  const modules = Array.from(community, (c, id) => { const r = (rank.get(c) ?? 0) + 1; rank.set(c, r); return { id, path: [...raggedPrefix(c), r] }; });
  return { nodeCount: n, source: Uint32Array.from(src), target: Uint32Array.from(tgt), nodeFlow, enterExit, modules };
}

describe("map-of-modules resize flow (Nodes slider)", () => {
  it("swapping node count re-renders without throwing and re-frames each size", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    net.enableZoom([0.1, 40]);

    for (const size of [48, 120]) {
      const d = makeData(size);
      const graph = buildGraph({ nodeCount: d.nodeCount, source: d.source, target: d.target, directed: true, nodeFlow: d.nodeFlow });
      // The example's order: data → lod → layout, THEN style (so on the 2nd size, data() runs while the
      // engine still holds the previous size's flowBorder array — the exact crash this test guards).
      net.data(graph);
      net.lod({ modules: d.modules });
      net.layout({ backend: "gpu", fit: true, iterations: 40 });
      net.style({
        sizeMode: "screen",
        nodeRadius: { by: "flow", scale: (v: number) => 3 + Math.sqrt(v) },
        flowBorder: { flow: d.enterExit, scale: (v: number) => Math.sqrt(v) },
      });
      await net.whenSettled();

      expect(net.layoutTransport).toBe("gpu");
      const t = (net as unknown as { transform: { k: number; x: number; y: number } }).transform;
      const pos = graph.positions;
      let onScreen = 0;
      for (let i = 0; i < d.nodeCount; i++) {
        const x = t.k * pos[2 * i]! + t.x;
        const y = t.k * pos[2 * i + 1]! + t.y;
        if (x >= 0 && x <= W && y >= 0 && y <= H) onScreen++;
      }
      // Framed (fit), not piled off-screen or over-zoomed to "all white": the vast majority of the final
      // nodes land inside the viewport. (The old extent-based frame collapsed n=120 to k≈5e8 → 0% on-screen.)
      expect(onScreen / d.nodeCount).toBeGreaterThan(0.9);
    }

    net.destroy();
  });
});
