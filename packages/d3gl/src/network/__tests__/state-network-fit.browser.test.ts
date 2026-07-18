import { describe, it, expect, afterEach } from "vitest";
import { network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";

/**
 * State networks (#238) now frame a streaming layout via the CAMERA fit (`layout({ fit: true })`) instead
 * of the internal `scaleToViewport` position-remap. This guards the two things that could regress:
 *   1. framing — the rendered (derived rosette / physical) positions must open INSIDE the viewport, not
 *      piled at the origin and not over-zoomed to "all white" (an over-zoom maps ~0% on-screen);
 *   2. sizing — container/rosette radii are scale-relative (computeStateSizing sizes against
 *      physicalSpacing), so leaving positions in force scale must still yield finite, sane radii.
 * Runs on the GPU backend (the streaming path); asserts across the physical / state / both views.
 */

const W = 400;
const H = 300;
const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}
afterEach(() => { for (const h of hosts) h.remove(); hosts.length = 0; });

/** A small state network: 6 physical nodes, 2 state nodes each (12 states), chained so the physical
 *  layout spreads; each physical node's two states sit in modules 1 and 2. */
function stateNet() {
  const P = 6;
  const stateCount = 2 * P;
  const stateToPhysical: number[] = [];
  for (let p = 0; p < P; p++) stateToPhysical.push(p, p);
  // Chain physical nodes p→p+1 via a state edge (state 2p → state 2(p+1)); plus a couple of cross links.
  const source: number[] = [];
  const target: number[] = [];
  for (let p = 0; p < P - 1; p++) { source.push(2 * p); target.push(2 * (p + 1)); }
  source.push(1, 3); target.push(2 * (P - 1), 2 * (P - 2) + 1);
  const modules: ModulePathNode[] = [];
  for (let s = 0; s < stateCount; s++) modules.push({ id: s, path: [(s % 2) + 1, Math.floor(s / 2) + 1] });
  const graph = buildStateGraph({ stateCount, stateToPhysical, source, target, nodeFlow: new Array(stateCount).fill(1), directed: false });
  return { graph, modules, P };
}

const internals = (net: unknown) =>
  net as unknown as {
    transform: { k: number; x: number; y: number };
    graph: { positions: Float32Array; nodeCount: number } | null;
    containerRadii: Float32Array | null;
    stateSpacing: number;
  };

describe("state-network fit", () => {
  for (const view of ["physical", "state", "both"] as const) {
    it(`fit:true frames the ${view} view on the GPU backend (rendered positions on-screen, sane sizing)`, async () => {
      const { graph, modules } = stateNet();
      const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
      net.enableZoom([0.05, 40]);
      net.style({ nodeRadius: 6 }).stateNetwork(graph, { modules, view }).layout({ backend: "gpu", fit: true, iterations: 150 });
      await net.whenSettled();

      expect(net.layoutTransport).toBe("gpu");
      const ns = internals(net);
      const pos = ns.graph!.positions;
      const n = ns.graph!.nodeCount;
      const t = ns.transform;
      expect(Number.isFinite(t.k)).toBe(true);
      expect(t.k).toBeGreaterThan(0);

      // The rendered positions (physical for the physical view; derived rosette for state/both) are framed:
      // the bulk lands inside the viewport — NOT the origin pile, NOT the over-zoomed "all white" collapse.
      let onScreen = 0;
      for (let i = 0; i < n; i++) {
        const x = t.k * pos[2 * i]! + t.x;
        const y = t.k * pos[2 * i + 1]! + t.y;
        if (x >= 0 && x <= W && y >= 0 && y <= H) onScreen++;
      }
      expect(onScreen / n).toBeGreaterThan(0.9);

      // Sizing stays scale-relative + sane: container radii finite, positive, and a sensible fraction of
      // the physical spacing (computeStateSizing caps them at 0.46·spacing), never NaN/0/absurd.
      const radii = ns.containerRadii;
      if (radii && radii.length > 0) {
        for (const r of radii) {
          expect(Number.isFinite(r)).toBe(true);
          expect(r).toBeGreaterThan(0);
          expect(r).toBeLessThanOrEqual(0.46 * ns.stateSpacing + 1e-3);
        }
      }
      net.destroy();
    });
  }
});
