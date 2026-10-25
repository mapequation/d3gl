import { describe, it, expect, afterEach } from "vitest";
import { Network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { NodeRadiusSpec } from "../glyphs.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import { offsetColumnStats } from "../../webgl/instanced.js";
import type { InstancedLayer, InstancedCirclesData, ViewTransform } from "../../core/index.js";

/**
 * The state network's both view sizes its nodes from the app's `nodeRadius` spec in the app's `sizeMode` (#509), each
 * state node packed inside its physical node. Screen mode draws the state nodes at the state view's radii and each
 * physical node at the packing's radius; each state node is drawn at its physical node (the anchor) plus a px offset
 * column, so a zoom frame re-emits nothing and uploads no offset bytes. World mode (D5) draws each physical node at
 * the physical view's radius and scales its state nodes to fit, keeping the state view's ratios.
 *
 * Small N, WebGL lane: the emitted layers are read where they reach the backend.
 */

const W = 400;
const H = 300;
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

/** 5 physical nodes holding 1, 2, 3, 5 and 1 state nodes; directed state links (lines + arrows), unequal flows. */
function fixture() {
  const stateToPhysical = [0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3, 4];
  const n = stateToPhysical.length;
  const source: number[] = [];
  const target: number[] = [];
  for (let s = 0; s + 1 < n; s++) {
    source.push(s);
    target.push(s + 1);
  }
  source.push(7, 3, 10);
  target.push(2, 9, 0);
  const nodeFlow = Array.from({ length: n }, (_, s) => (s + 1) / ((n * (n + 1)) / 2));
  const graph = buildStateGraph({ stateCount: n, stateToPhysical, source, target, nodeFlow, directed: true });
  const positions = new Float32Array([0, 0, 100, 0, 200, 0, 0, 100, 100, 100]);
  return { graph, positions };
}

/** The last layer of each name the WebGL backend was handed, and how many emits reached it. */
class LayerSpy {
  readonly last = new Map<string, InstancedLayer>();
  emits = 0;
  private readonly origSet = WebGLBackend.prototype.setInstancedLayer;
  private readonly origUpdate = WebGLBackend.prototype.updateInstancedLayer;
  constructor() {
    const { origSet, origUpdate } = this;
    const record = (layer: InstancedLayer): void => {
      this.last.set(layer.name, layer);
      this.emits++;
    };
    WebGLBackend.prototype.setInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      record(layer);
      origSet.call(this, layer);
    };
    WebGLBackend.prototype.updateInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      record(layer);
      origUpdate.call(this, layer);
    };
  }
  circles(name: string): InstancedCirclesData {
    const layer = this.last.get(name);
    if (!layer || layer.primitive !== "circles") throw new Error(`no circles layer "${name}"`);
    return layer.circles;
  }
  sizeMode(name: string): "world" | "screen" | undefined {
    return this.last.get(name)?.sizeMode;
  }
  restore(): void {
    WebGLBackend.prototype.setInstancedLayer = this.origSet;
    WebGLBackend.prototype.updateInstancedLayer = this.origUpdate;
  }
}

function zoomAbout(k: number): ViewTransform {
  return { k, x: (W / 2) * (1 - k), y: (H / 2) * (1 - k) };
}

const SPECS: { name: string; spec: NodeRadiusSpec }[] = [
  { name: "constant", spec: 5 },
  { name: "by flow", spec: { by: "flow", scale: (v: number) => 3 + 120 * v } },
];
const MODES = ["world", "screen"] as const;

describe("state network both view: state nodes sized by the state view's spec, inside their physical nodes (#509)", () => {
  for (const sizeMode of MODES) {
    for (const { name, spec } of SPECS) {
      it(`${sizeMode} mode, nodeRadius ${name}`, async () => {
        const host = document.createElement("div");
        host.style.width = `${W}px`;
        host.style.height = `${H}px`;
        document.body.appendChild(host);
        hosts.push(host);
        const spy = new LayerSpy();
        try {
          const net = new Network(host, { width: W, height: H, backend: "webgl" });
          await net.whenReady();
          const { graph, positions } = fixture();
          net.style({ nodeRadius: spec, sizeMode }).stateNetwork(graph, { view: "state" });
          net.render();
          const stateRadii = Float32Array.from(spy.circles("nodes").radii);
          expect(spy.sizeMode("nodes")).toBe(sizeMode);
          const P = graph.physical.nodeCount;
          net.view("physical").layout({ backend: "positions", positions });
          net.render();
          const physicalRadii = Float32Array.from(spy.circles("nodes").radii.subarray(0, P));

          net.view("both").layout({ backend: "positions", positions });
          net.setTransform(zoomAbout(1));
          net.render();
          const nodes = spy.circles("nodes");
          const phys = spy.circles("phys-container");
          expect(spy.sizeMode("nodes"), "the both view's state nodes take the app's sizeMode").toBe(sizeMode);
          expect(spy.sizeMode("phys-container"), "the physical nodes take the state nodes' units").toBe(sizeMode);
          const s2p = graph.stateToPhysical;
          if (sizeMode === "screen") {
            // The drawn radius of each state node is the state view's, for the same node.
            expect(Array.from(nodes.radii)).toEqual(Array.from(stateRadii));
          } else {
            // D5: each physical node at the physical view's radius; its state nodes scaled by one factor, so they keep
            // the state view's ratios within it.
            expect(Array.from(phys.radii.subarray(0, P)), "a physical node's radius is not the physical view's").toEqual(Array.from(physicalRadii));
            const factor: number[] = [];
            for (let s = 0; s < graph.state.nodeCount; s++) {
              const p = s2p[s] ?? 0;
              const f = (nodes.radii[s] ?? 0) / (stateRadii[s] ?? 1);
              expect(f, `state node ${s} is not drawn`).toBeGreaterThan(0);
              if (factor[p] === undefined) factor[p] = f;
              else expect(f, `state node ${s} breaks the state view's ratios in physical node ${p}`).toBeCloseTo(factor[p] ?? NaN, 5);
            }
          }

          // D4: offset columns only in screen mode, on the state nodes and both ends of every link.
          const links = spy.last.get("links");
          const lineEnds = links?.primitive === "arrows" ? links.arrows : null;
          // #542: a directed link is a whole arrow, its head on its ends and offsets; no separate "arrows" layer.
          expect(spy.last.has("arrows")).toBe(false);
          expect(lineEnds?.arrowSize).toBeGreaterThan(0);
          if (sizeMode === "screen") {
            expect(nodes.offsets?.length).toBe(2 * graph.state.nodeCount);
            expect(lineEnds?.sourceOffsets?.length).toBe(2 * graph.state.edgeCount);
            expect(lineEnds?.targetOffsets?.length).toBe(2 * graph.state.edgeCount);
          } else {
            expect(nodes.offsets).toBeUndefined();
            expect(lineEnds?.sourceOffsets).toBeUndefined();
            expect(lineEnds?.targetOffsets).toBeUndefined();
          }

          // Each state node's position: its physical node (the anchor) in screen mode, plus its offset in world mode.
          let baked = 0;
          for (let s = 0; s < graph.state.nodeCount; s++) {
            const p = s2p[s] ?? 0;
            const d = Math.hypot((nodes.centers[2 * s] ?? 0) - (phys.centers[2 * p] ?? 0), (nodes.centers[2 * s + 1] ?? 0) - (phys.centers[2 * p + 1] ?? 0));
            if (d > 1e-3) baked++;
          }
          if (sizeMode === "screen") expect(baked, "a screen-mode state node is not at its anchor").toBe(0);
          else expect(baked, "no world-mode state node is offset from its physical node").toBeGreaterThan(0);

          // Every state node lies inside its physical node, as drawn in px, at two zooms, and no two of a physical node
          // overlap.
          for (const k of [0.5, 3]) {
            net.setTransform(zoomAbout(k));
            net.render();
            const n = spy.circles("nodes");
            const c = spy.circles("phys-container");
            const scale = sizeMode === "screen" ? 1 : k; // size units → px
            for (let s = 0; s < graph.state.nodeCount; s++) {
              const p = s2p[s] ?? 0;
              const dx = k * ((n.centers[2 * s] ?? 0) - (c.centers[2 * p] ?? 0)) + scale * (n.offsets?.[2 * s] ?? 0);
              const dy = k * ((n.centers[2 * s + 1] ?? 0) - (c.centers[2 * p + 1] ?? 0)) + scale * (n.offsets?.[2 * s + 1] ?? 0);
              const reach = Math.hypot(dx, dy) + scale * (n.radii[s] ?? 0);
              expect(reach, `state node ${s} reaches past its physical node ${p} at k=${k}`).toBeLessThanOrEqual(scale * (c.radii[p] ?? 0) + 1e-3);
              if (sizeMode === "world") expect(scale * (c.radii[p] ?? 0), `physical node ${p} is not at the physical view's size at k=${k}`).toBeCloseTo(k * (physicalRadii[p] ?? NaN), 4);
              for (let t = s + 1; t < graph.state.nodeCount; t++) {
                if ((s2p[t] ?? -1) !== p) continue;
                // The drawn centres in px: the world-mode offsets are in the centres, the screen-mode ones in the offsets.
                const ex = k * ((n.centers[2 * s] ?? 0) - (n.centers[2 * t] ?? 0)) + scale * ((n.offsets?.[2 * s] ?? 0) - (n.offsets?.[2 * t] ?? 0));
                const ey = k * ((n.centers[2 * s + 1] ?? 0) - (n.centers[2 * t + 1] ?? 0)) + scale * ((n.offsets?.[2 * s + 1] ?? 0) - (n.offsets?.[2 * t + 1] ?? 0));
                const dist = Math.hypot(ex, ey);
                expect(dist, `state nodes ${s} and ${t} overlap at k=${k}`).toBeGreaterThanOrEqual(scale * ((n.radii[s] ?? 0) + (n.radii[t] ?? 0)) - 1e-3);
              }
            }
          }
          // Packed: the physical node of five state nodes encloses more than its largest state node.
          expect(phys.radii[3] ?? 0).toBeGreaterThan(Math.max(...Array.from(nodes.radii.subarray(6, 11))));
          net.destroy();
        } finally {
          spy.restore();
        }
      });
    }
  }

  it("screen mode: a zoom sweep emits nothing and uploads no offset bytes; the offset columns are kept", async () => {
    const host = document.createElement("div");
    host.style.width = `${W}px`;
    host.style.height = `${H}px`;
    document.body.appendChild(host);
    hosts.push(host);
    const spy = new LayerSpy();
    try {
      const net = new Network(host, { width: W, height: H, backend: "webgl" });
      await net.whenReady();
      const { graph, positions } = fixture();
      net.style({ nodeRadius: { by: "flow", scale: (v: number) => 3 + 120 * v }, sizeMode: "screen" }).stateNetwork(graph, { view: "both" });
      net.layout({ backend: "positions", positions });
      net.setTransform(zoomAbout(1));
      net.render();
      const offsets = spy.circles("nodes").offsets;
      expect(offsets, "no offset column: the sweep would be vacuous").toBeDefined();
      const before = { ...offsetColumnStats };
      const emitsBefore = spy.emits;
      for (const k of [0.25, 0.5, 1, 2, 4, 8, 16]) {
        net.setTransform(zoomAbout(k));
        net.render();
      }
      expect(spy.emits - emitsBefore, "a zoom frame re-emitted a layer").toBe(0);
      expect(offsetColumnStats.bytes - before.bytes, "a zoom frame uploaded offset bytes").toBe(0);
      expect(offsetColumnStats.buffers - before.buffers).toBe(0);
      expect(spy.circles("nodes").offsets).toBe(offsets);
      net.destroy();
    } finally {
      spy.restore();
    }
  });
});

describe("state network physical view: the physical nodes follow the app's sizeMode (#509)", () => {
  for (const sizeMode of MODES) {
    for (const { name, spec } of SPECS) {
      it(`${sizeMode} mode, nodeRadius ${name}: constant px across zooms in screen mode, scaled by k in world mode`, async () => {
        const host = document.createElement("div");
        host.style.width = `${W}px`;
        host.style.height = `${H}px`;
        document.body.appendChild(host);
        hosts.push(host);
        const spy = new LayerSpy();
        try {
          const net = new Network(host, { width: W, height: H, backend: "webgl" });
          await net.whenReady();
          const { graph, positions } = fixture();
          net.style({ nodeRadius: spec, sizeMode }).stateNetwork(graph, { view: "physical" });
          net.layout({ backend: "positions", positions });
          const P = graph.physical.nodeCount;
          /** Each physical node's drawn radius in px at zoom k, and the pick model's answer just inside and just outside
           *  its drawn rim: probes that fall on another physical node's drawn disc are skipped (screen mode by flow
           *  overlaps its neighbours when zoomed out), so `probes` counts the ones that test this node alone. */
          const at = (k: number): { px: number[]; probes: number; inside: number; outside: number } => {
            const t = zoomAbout(k);
            net.setTransform(t);
            net.render();
            expect(spy.sizeMode("nodes"), "the physical nodes do not take the app's sizeMode").toBe(sizeMode);
            const c = spy.circles("nodes");
            expect(c.count).toBe(P);
            const px = Array.from(c.radii.subarray(0, P), (r) => r * (sizeMode === "screen" ? 1 : k));
            const cx = (p: number): number => t.k * (positions[2 * p] ?? 0) + t.x;
            const cy = (p: number): number => t.k * (positions[2 * p + 1] ?? 0) + t.y;
            const onOther = (p: number, x: number, y: number): boolean => {
              for (let q = 0; q < P; q++) if (q !== p && Math.hypot(x - cx(q), y - cy(q)) <= (px[q] ?? 0) + 1) return true;
              return false;
            };
            let probes = 0;
            let inside = 0;
            let outside = 0;
            for (let p = 0; p < P; p++) {
              const x = cx(p), y = cy(p), r = px[p] ?? 0;
              const ix = x + 0.8 * r, ox = x + 1.2 * r + 1;
              if (onOther(p, x, y) || onOther(p, ix, y) || onOther(p, ox, y)) continue;
              probes++;
              // The physical node as the pick model names it at its centre: hit inside its drawn rim, not outside it.
              const id = net.pick(x, y)?.id;
              if (id !== undefined && net.pick(ix, y)?.id === id) inside++;
              if (id !== undefined && net.pick(ox, y)?.id !== id) outside++;
            }
            return { px, probes, inside, outside };
          };
          const near = at(0.5);
          const far = at(3);
          for (const leg of [near, far]) {
            expect(leg.probes, "no physical node clear of its neighbours: the pick check is vacuous").toBeGreaterThan(0);
            expect(leg.inside, "a pick inside a physical node's drawn rim missed it").toBe(leg.probes);
            expect(leg.outside, "a pick outside a physical node's drawn rim hit it").toBe(leg.probes);
          }
          for (let p = 0; p < P; p++) {
            const a = near.px[p] ?? 0, b = far.px[p] ?? 0;
            expect(a, `physical node ${p} is not drawn`).toBeGreaterThan(0);
            if (sizeMode === "screen") expect(b, `physical node ${p}: px radius changed with the zoom`).toBeCloseTo(a, 5);
            else expect(b / a, `physical node ${p}: world radius did not scale with k`).toBeCloseTo(3 / 0.5, 5);
          }
          // The pies ride on the physical nodes: the same sizeMode.
          if (spy.last.has("pie")) expect(spy.sizeMode("pie")).toBe(sizeMode);
          net.destroy();
        } finally {
          spy.restore();
        }
      });
    }
  }
});
