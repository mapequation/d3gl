import { describe, it, expect, afterEach } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * The network example (#238) re-layouts (and reframes via `fit: true`) only when the graph changes, and
 * just re-styles for cosmetic controls — so a cosmetic toggle keeps your pan/zoom. This guards the
 * library guarantee that makes that split safe: `style()` / `lod()` never move the view transform, while
 * a fresh `layout({ fit: true })` does reframe. (If a restyle reset the view, the example's split would
 * silently reset the user's zoom on every toggle.)
 */

const W = 400;
const H = 300;
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

function moduleGraph(seed: number) {
  const K = 6, m = 25, nodeCount = K * m;
  let s = seed >>> 0;
  const rand = () => ((s = Math.imul(1664525, s) + 1013904223), (s >>> 0) / 0x100000000);
  const members: number[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < nodeCount; i++) members[i % K]!.push(i);
  const src: number[] = [], tgt: number[] = [];
  for (let c = 0; c < K; c++) { const mem = members[c]!; for (const a of mem) for (let e = 0; e < 4; e++) { const b = mem[Math.floor(rand() * mem.length)]!; if (b !== a) { src.push(a); tgt.push(b); } } }
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { src.push(members[a]![0]!); tgt.push(members[b]![0]!); }
  const rank = new Map<number, number>();
  const modules = Array.from({ length: nodeCount }, (_, id) => { const c = id % K; const r = (rank.get(c) ?? 0) + 1; rank.set(c, r); return { id, path: [c + 1, r] }; });
  return { graph: buildGraph({ nodeCount, source: src, target: tgt }), modules };
}

const tf = (net: unknown) => ({ ...(net as { transform: { k: number; x: number; y: number } }).transform });

describe("fit + cosmetic restyle", () => {
  it("style()/lod() keep the fitted view; a fresh layout({fit}) reframes", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    const { graph, modules } = moduleGraph(0x1234);

    net.data(graph);
    net.lod({ modules });
    net.style({ nodeRadius: 5 });
    net.layout({ backend: "gpu", fit: true, iterations: 150 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");

    const framed = tf(net);
    expect(framed.k).toBeGreaterThan(0);

    // Cosmetic re-style + re-lod (what a Node-size / Declutter toggle does): the view must NOT move.
    net.style({ nodeRadius: 9 });
    net.lod({ modules, expandPx: 72 });
    const afterRestyle = tf(net);
    expect(afterRestyle.k).toBeCloseTo(framed.k, 6);
    expect(afterRestyle.x).toBeCloseTo(framed.x, 6);
    expect(afterRestyle.y).toBeCloseTo(framed.y, 6);

    // A fresh layout on a different graph DOES reframe (graph-affecting control).
    const next = moduleGraph(0x9999);
    net.data(next.graph);
    net.lod({ modules: next.modules });
    net.layout({ backend: "gpu", fit: true, iterations: 150 });
    await net.whenSettled();
    const reframed = tf(net);
    const moved = Math.abs(reframed.k - framed.k) > 1e-4 || Math.abs(reframed.x - framed.x) > 0.5 || Math.abs(reframed.y - framed.y) > 0.5;
    expect(moved).toBe(true);

    net.destroy();
  });
});
