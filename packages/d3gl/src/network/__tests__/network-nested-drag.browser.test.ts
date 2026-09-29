import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkLayoutOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";

/**
 * Node-drag on a nested module map, through the real gesture (pointer events on the host, the drag's own
 * animation frames): the grabbed leaf's module is re-solved around it — its siblings move, every leaf
 * outside the module keeps its exact position — and, for a collapsed module aggregate, its sibling
 * modules move aside while each keeps its inside layout. Once released the module cools and stops. The
 * same on every layout backend that lays a nested map out (the re-solve runs on the main thread).
 */

const TOP = 4;
const MID = 4;
const LEAVES = 12;
const N = TOP * MID * LEAVES;

function fixture(): { graph: NetworkGraph; modules: ModuleNode[]; links: ModuleLink[] } {
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const links: ModuleLink[] = [];
  for (let a = 1; a <= TOP; a++) {
    for (let m = 1; m <= MID; m++) {
      const lo = modules.length;
      for (let l = 1; l <= LEAVES; l++) modules.push({ id: modules.length, path: [a, m, l] });
      for (let i = 0; i < LEAVES; i++) {
        source.push(lo + i, lo + i);
        target.push(lo + ((i + 1) % LEAVES), lo + ((i + 5) % LEAVES));
      }
      links.push({ source: [a, m], target: [a, (m % MID) + 1], flow: 1 });
    }
    links.push({ source: [a], target: [(a % TOP) + 1], flow: 1 });
  }
  return { graph: buildGraph({ nodeCount: N, source, target, directed: true }), modules, links };
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;left:0;top:0;width:400px;height:400px";
  document.body.appendChild(el);
  return el;
}

const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};

function pointer(h: HTMLElement, type: string, x: number, y: number): void {
  const r = h.getBoundingClientRect();
  h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
}

/**
 * A nested map started as an app starts one (#428): `data(graph, { modules })`, the LOD, then
 * `layout({ nested })` with nothing built yet — so on the streaming backends the module tree is built on a
 * worker and the solve starts once it lands (a deferred layout handle), on the tree the drag then reads.
 */
async function laidOut(backend: NetworkLayoutOptions["backend"], lod: boolean): Promise<{ net: Network; h: HTMLElement; g: NetworkGraph }> {
  const h = host();
  const net = network(h, { width: 400, height: 400 });
  await net.whenReady();
  const { graph: g, modules, links } = fixture();
  net.data(g, { modules, moduleLinks: links }).style({ nodeRadius: 3, sizeMode: "screen" });
  net.lod(lod ? { declutter: false, moduleBoundary: {} } : false);
  net.layout({ backend, nested: true, fit: true });
  await net.whenSettled();
  await frames(20); // the settle's own refresh
  net.interactive({ draggable: true, selectable: true });
  return { net, h, g };
}

/** Zoom to `k` with world point (x, y) at the host's centre. */
function centreOn(net: Network, x: number, y: number, k: number): void {
  net.setTransform({ k, x: 200 - x * k, y: 200 - y * k });
}

describe("node-drag on a nested map", () => {
  const leafCases = [
    ["force", false],
    ["worker", false],
    ["gpu", false],
    ["worker", true],
    ["gpu", true],
  ] as const;
  for (const [backend, lod] of leafCases) {
    it(`${backend}, LOD ${lod ? "on" : "off"}: re-solves the grabbed leaf's module around it; dragged out, the module travels and its neighbours make room`, async () => {
      const { net, h, g } = await laidOut(backend, lod);
      const leaf = 2 * LEAVES + 3; // top module 1, bottom module 3
      const lo = leaf - (leaf % LEAVES);
      const x0 = g.positions[2 * leaf]!;
      const y0 = g.positions[2 * leaf + 1]!;
      const K = 20; // 1 world unit = 20 px: past the click slop
      centreOn(net, x0, y0, K);
      await frames(1);
      expect(net.pick(200, 200)?.id).toBe(leaf);
      const before = g.positions.slice();
      // Toward the module's leaf centroid by 1 world unit: the held leaf stays inside its module's disc.
      let mx = 0;
      let my = 0;
      for (let i = lo; i < lo + LEAVES; i++) {
        mx += before[2 * i]! / LEAVES;
        my += before[2 * i + 1]! / LEAVES;
      }
      const d = Math.hypot(mx - x0, my - y0);
      const [ux, uy] = [(mx - x0) / d, (my - y0) / d];
      pointer(h, "pointerdown", 200, 200);
      pointer(h, "pointermove", 200 + 0.5 * ux * K, 200 + 0.5 * uy * K); // past the click slop
      pointer(h, "pointermove", 200 + ux * K, 200 + uy * K);
      await frames(30);
      expect(g.positions[2 * leaf]).toBeCloseTo(x0 + ux, 1);
      expect(g.positions[2 * leaf + 1]).toBeCloseTo(y0 + uy, 1);
      let siblingsMoved = 0;
      for (let i = lo; i < lo + LEAVES; i++) if (i !== leaf && (g.positions[2 * i] !== before[2 * i] || g.positions[2 * i + 1] !== before[2 * i + 1])) siblingsMoved++;
      expect(siblingsMoved, "the module did not re-solve around the held leaf").toBeGreaterThan(0);
      for (let i = 0; i < N; i++) {
        if (i >= lo && i < lo + LEAVES) continue;
        expect(g.positions[2 * i], `leaf ${i} outside the module moved`).toBe(before[2 * i]);
        expect(g.positions[2 * i + 1]).toBe(before[2 * i + 1]);
      }
      // Out of the module's disc, well past its edge (the module is ~15 world units across): the leaf
      // still follows the cursor exactly, its module comes along, and the modules around make room.
      const out = -25;
      pointer(h, "pointermove", 200 + out * ux * K, 200 + out * uy * K);
      await frames(40);
      expect(g.positions[2 * leaf]).toBeCloseTo(x0 + out * ux, 1);
      expect(g.positions[2 * leaf + 1]).toBeCloseTo(y0 + out * uy, 1);
      let cx = 0;
      let cy = 0;
      for (let i = lo; i < lo + LEAVES; i++) {
        cx += g.positions[2 * i]! / LEAVES;
        cy += g.positions[2 * i + 1]! / LEAVES;
      }
      const along = (cx - mx) * -ux + (cy - my) * -uy;
      expect(along, "the module did not travel with its dragged leaf").toBeGreaterThan(5);
      let made = 0;
      for (let i = 0; i < N; i++) if ((i < lo || i >= lo + LEAVES) && g.positions[2 * i] !== before[2 * i]) made++;
      expect(made, "nothing around the travelling module made room").toBeGreaterThan(0);
      pointer(h, "pointerup", 200 + out * ux * K, 200 + out * uy * K);
      await frames(120); // the cool-down (at most 90 ticks)
      const settled = g.positions.slice();
      await frames(10);
      expect(g.positions, "still moving after the cool-down").toEqual(settled);
      net.destroy();
      h.remove();
    });
  }

  for (const backend of ["force", "worker", "gpu"] as const) it(`${backend}: a collapsed module moves its sibling modules aside, each as a whole`, async () => {
    const { net, h, g } = await laidOut(backend, true);
    const R = 10 * Math.sqrt(N);
    const K = 400 / (6 * R); // zoomed well out: the top modules drawn collapsed (each ~45 px across)
    centreOn(net, 0, 0, K);
    await frames(2);
    // Find a drawn top-module aggregate: its members are one top module's leaves.
    let hit = null;
    for (let y = 20; y < 380 && !hit; y += 4) {
      for (let x = 20; x < 380 && !hit; x += 4) {
        const p = net.pick(x, y);
        if (p && (p.members?.().length ?? 0) === MID * LEAVES) hit = { p, x, y };
      }
    }
    expect(hit, "no collapsed top module in view").not.toBeNull();
    const members = hit!.p.members!() as number[];
    const top = Math.floor(members[0]! / (MID * LEAVES));
    const before = g.positions.slice();
    pointer(h, "pointerdown", hit!.x, hit!.y);
    pointer(h, "pointermove", hit!.x + 6, hit!.y);
    pointer(h, "pointermove", hit!.x + 12, hit!.y + 4);
    await frames(40);
    pointer(h, "pointerup", hit!.x + 12, hit!.y + 4);
    // The held module followed the cursor rigidly.
    for (const i of members) {
      expect(g.positions[2 * i]! - before[2 * i]!).toBeCloseTo(12 / K, 0);
    }
    // Every other top module moved (or not) as a whole: one displacement for all its leaves.
    let movedModules = 0;
    for (let a = 0; a < TOP; a++) {
      if (a === top) continue;
      const i0 = a * MID * LEAVES;
      const ux = g.positions[2 * i0]! - before[2 * i0]!;
      const uy = g.positions[2 * i0 + 1]! - before[2 * i0 + 1]!;
      if (Math.hypot(ux, uy) > 1e-3) movedModules++;
      for (let i = i0; i < i0 + MID * LEAVES; i++) {
        expect(g.positions[2 * i]! - before[2 * i]!).toBeCloseTo(ux, 2);
        expect(g.positions[2 * i + 1]! - before[2 * i + 1]!).toBeCloseTo(uy, 2);
      }
    }
    expect(movedModules, "no sibling module made room").toBeGreaterThan(0);
    net.destroy();
    h.remove();
  });
});
