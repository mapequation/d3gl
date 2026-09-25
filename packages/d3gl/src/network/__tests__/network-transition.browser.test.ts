import { describe, it, expect, vi } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { nestedLayout } from "../nested-layout.js";

/**
 * Warm-started nested re-layout + position transitions through the engine (#328): what the pure
 * `nestedLayout` / `positionTransition` tests can't see — no seed disc and no depth frames, the camera
 * left alone, `whenSettled()` waiting for the tween, and every way a transition is cancelled.
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

/** Two top modules of four leaves (module 1 split into two sub-modules), placed around (30, 30) and (150, 150). */
const MODULES: ModuleNode[] = [
  { id: 0, path: [1, 1, 1] }, { id: 1, path: [1, 1, 2] }, { id: 2, path: [1, 2, 1] }, { id: 3, path: [1, 2, 2] },
  { id: 4, path: [2, 1] }, { id: 5, path: [2, 2] }, { id: 6, path: [2, 3] }, { id: 7, path: [2, 4] },
];
/** A re-clustering of the same nodes: four pairs, each its own top module. */
const PAIRS: ModuleNode[] = MODULES.map(({ id }) => ({ id, path: [Math.floor(id / 2) + 1, (id % 2) + 1] }));
const POSITIONS = new Float32Array([20, 20, 40, 20, 20, 40, 40, 40, 140, 140, 160, 140, 140, 160, 160, 160]);

function graph(): NetworkGraph {
  return buildGraph({
    nodeCount: 8,
    source: [0, 2, 0, 4, 6, 4, 5, 3],
    target: [1, 3, 2, 5, 7, 6, 7, 4],
    directed: true,
  });
}

/** The pure warm nested layout of `records` from `initial` — what the engine must land on. */
function warmNested(g: NetworkGraph, records: ModuleNode[], initial: Float32Array): Float32Array {
  const tree = buildModuleLODTree(g.nodeCount, records, g);
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  return nestedLayout({ ...tree, parent }, { initial, size: g.flow ?? undefined }).positions;
}

const tf = (net: Network): { k: number; x: number; y: number } => ({ ...(net as unknown as { transform: { k: number; x: number; y: number } }).transform });
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/** Record `positions` once per animation frame until `stop()`. */
function sampler(positions: () => Float32Array): { samples: Float32Array[]; stop(): void } {
  const samples: Float32Array[] = [];
  let on = true;
  const tick = (): void => {
    if (!on) return;
    samples.push(positions().slice());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { samples, stop: () => void (on = false) };
}

/** Where `sample` sits on the straight path `from → to`: one common fraction for every node, or NaN
 *  if it is off the path (a depth frame, a seed disc, a jump elsewhere). */
function pathFraction(sample: Float32Array, from: Float32Array, to: Float32Array): number {
  let ref = 0;
  for (let i = 1; i < from.length; i++) if (Math.abs(to[i]! - from[i]!) > Math.abs(to[ref]! - from[ref]!)) ref = i;
  const k = (sample[ref]! - from[ref]!) / (to[ref]! - from[ref]!);
  for (let i = 0; i < from.length; i++) {
    if (Math.abs(sample[i]! - (from[i]! + (to[i]! - from[i]!) * k)) > 1e-3 * (1 + Math.abs(to[i]! - from[i]!))) return Number.NaN;
  }
  return k;
}

describe("warm nested re-layout + position transitions (#328)", () => {
  it("a warm re-cluster on the worker eases from the current map to the pure warm layout, camera untouched", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).lod(false).layout({ backend: "positions", positions: POSITIONS });
    net.setTransform({ k: 1.5, x: -20, y: 10 });
    await nextFrame(); // let the first paint land: a transition is timed, so a stalled first frame would skip it
    await nextFrame();
    const camera = tf(net);

    net.data(g, { modules: PAIRS }); // re-cluster: same nodes, new hierarchy — positions untouched
    const from = g.positions.slice();
    const want = warmNested(g, PAIRS, from);
    const rec = sampler(() => g.positions);
    net.layout({ backend: "worker", nested: { warm: true }, transition: 400, fit: false });
    expect(Array.from(g.positions)).toEqual(Array.from(from)); // no seed disc over the current map
    await net.whenSettled();
    rec.stop();

    expect(Array.from(g.positions)).toEqual(Array.from(want));
    expect(tf(net)).toEqual(camera);
    // Every frame on the straight path old → new, in order: no depth frame collapsed a module.
    const ks = rec.samples.map((s) => pathFraction(s, from, want));
    expect(ks.every((k) => Number.isFinite(k)), `off-path frame: ${ks.join(", ")}`).toBe(true);
    for (let i = 1; i < ks.length; i++) expect(ks[i]!).toBeGreaterThanOrEqual(ks[i - 1]! - 1e-6);
    expect(ks.some((k) => k > 0.01 && k < 0.99), "no intermediate frame — it jumped instead of easing").toBe(true);
    net.destroy();
  });

  it("a cold nested layout with a transition eases too: the worker posts no depth frames", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: PAIRS }).lod(false).layout({ backend: "positions", positions: POSITIONS });
    await nextFrame();
    await nextFrame();
    const from = g.positions.slice();
    const tree = buildModuleLODTree(g.nodeCount, PAIRS, g);
    const parent = tree.parent;
    if (!parent) throw new Error("module trees carry a parent map");
    const want = nestedLayout({ ...tree, parent }, { radius: 10 * Math.sqrt(g.nodeCount), size: g.flow ?? undefined }).positions;
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    const rec = sampler(() => g.positions);
    net.layout({ backend: "worker", nested: true, transition: 400 });
    await net.whenSettled();
    rec.stop();
    // The worker is asked for the final layout only — depth frames would be wasted repaints under a tween.
    const start = posted.mock.calls.map(([m]) => m as { type?: string; stream?: boolean }).find((m) => m.type === "start-nested");
    posted.mockRestore();
    expect(start?.stream).toBe(false);
    expect(Array.from(g.positions)).toEqual(Array.from(want));
    const ks = rec.samples.map((s) => pathFraction(s, from, want));
    expect(ks.every((k) => Number.isFinite(k)), `off-path frame: ${ks.join(", ")}`).toBe(true);
    expect(ks.some((k) => k > 0.01 && k < 0.99), "no intermediate frame — it jumped instead of easing").toBe(true);
    net.destroy();
  });

  it("a warm re-cluster without a transition lands in one frame", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).lod({}).layout({ backend: "positions", positions: POSITIONS });
    const camera = tf(net);
    net.data(g, { modules: PAIRS }).lod({});
    const from = g.positions.slice();
    const want = warmNested(g, PAIRS, from);
    const rec = sampler(() => g.positions);
    net.layout({ backend: "worker", nested: { warm: true } });
    await net.whenSettled();
    await nextFrame();
    rec.stop();
    expect(Array.from(g.positions)).toEqual(Array.from(want));
    for (const s of rec.samples) expect([0, 1]).toContain(pathFraction(s, from, want));
    expect(tf(net)).toEqual(camera);
    net.destroy();
  });

  it("warm on the force backend is the pure warm layout, synchronously", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    g.positions.set(POSITIONS);
    const want = warmNested(g, PAIRS, POSITIONS);
    net.data(g, { modules: PAIRS }).layout({ backend: "force", nested: { warm: true } });
    expect(Array.from(g.positions)).toEqual(Array.from(want));
    net.destroy();
  });

  it("with fit, a warm transition frames the final layout", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).lod(false).layout({ backend: "positions", positions: POSITIONS });
    net.setTransform({ k: 0.2, x: 0, y: 0 });
    net.data(g, { modules: PAIRS });
    net.layout({ backend: "worker", nested: { warm: true }, transition: 100, fit: true });
    expect(Array.from(g.positions)).toEqual(Array.from(POSITIONS)); // fit places no seed disc over the map
    await net.whenSettled();
    expect(tf(net).k).toBeGreaterThan(0.2); // reframed onto the map, not left at the far-out zoom
    net.destroy();
  });

  it("eases a positions layout too; layoutTransport stays 'none'", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g).layout({ backend: "positions", positions: POSITIONS });
    await nextFrame(); // let the first paint land: a transition is timed, so a stalled first frame would skip it
    await nextFrame();
    const target = POSITIONS.map((v) => v + 10);
    const rec = sampler(() => g.positions);
    net.layout({ backend: "positions", positions: target, transition: 400 });
    target.fill(0); // the engine copied it: reusing the caller's buffer mid-transition is harmless
    expect(net.layoutTransport).toBe("none");
    await net.whenSettled();
    rec.stop();
    expect(Array.from(g.positions)).toEqual(Array.from(POSITIONS.map((v) => v + 10)));
    expect(rec.samples.some((s) => s[0]! > 20.1 && s[0]! < 29.9), "no intermediate frame").toBe(true);
    net.destroy();
  });

  it("a new layout(), data() or destroy() stops a running transition where it is", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).layout({ backend: "positions", positions: POSITIONS });

    // layout(): the long transition is superseded — its promise settles, and nothing moves after.
    net.layout({ backend: "positions", positions: POSITIONS.map((v) => v * 2), transition: 60_000 });
    const first = net.whenSettled();
    await nextFrame();
    await nextFrame();
    const moved = g.positions.slice();
    expect(Array.from(moved)).not.toEqual(Array.from(POSITIONS));
    net.stopLayout();
    await first;
    await nextFrame();
    await nextFrame();
    expect(Array.from(g.positions)).toEqual(Array.from(moved)); // stopped where it was

    net.layout({ backend: "worker", nested: { warm: true }, transition: 60_000 });
    await new Promise((r) => setTimeout(r, 300)); // the worker lands and the transition starts
    const replaced = POSITIONS.map((v) => v + 1);
    net.layout({ backend: "positions", positions: replaced });
    await nextFrame();
    await nextFrame();
    expect(Array.from(g.positions)).toEqual(Array.from(replaced));

    // data(): a transition over the old data stops with it.
    net.layout({ backend: "positions", positions: POSITIONS, transition: 60_000 });
    await nextFrame();
    net.data(graph());
    const atData = g.positions.slice();
    await nextFrame();
    await nextFrame();
    expect(Array.from(g.positions)).toEqual(Array.from(atData));

    // destroy(): same, and no frame fires into a torn-down engine.
    net.data(g).layout({ backend: "positions", positions: replaced.map((v) => v + 5), transition: 60_000 });
    await nextFrame();
    net.destroy();
    const atDestroy = g.positions.slice();
    await nextFrame();
    await nextFrame();
    expect(Array.from(g.positions)).toEqual(Array.from(atDestroy));
  });
});

/** A drag from host-relative (x0, y0) to (x1, y1) through real pointer events (as network-drag tests). */
function drag(h: HTMLElement, x0: number, y0: number, x1: number, y1: number, release: boolean): () => void {
  const r = h.getBoundingClientRect();
  const ev = (type: string, sx: number, sy: number): void => {
    h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, button: 0, pointerId: 1 }));
  };
  ev("pointerdown", x0, y0);
  ev("pointermove", x1, y1);
  const up = (): void => ev("pointerup", x1, y1);
  if (release) up();
  return up;
}

describe("a transition next to a drag (#328)", () => {
  /** An engine on a fixed host (so pointer events land on the glyphs), world == screen, LOD off. */
  async function dragEngine(): Promise<{ net: Network; g: NetworkGraph; h: HTMLElement }> {
    const h = host();
    h.style.cssText = "position:absolute;left:0;top:0;width:200px;height:200px";
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).lod(false).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POSITIONS });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ draggable: true, selectable: true });
    return { net, g, h };
  }
  const at = (g: NetworkGraph, i: number): [number, number] => [g.positions[i * 2]!, g.positions[i * 2 + 1]!];

  it("a node grabbed while the worker solves the target stays under the cursor through the whole ease", async () => {
    const { net, g, h } = await dragEngine();
    net.data(g, { modules: PAIRS });
    net.layout({ backend: "worker", nested: { warm: true }, transition: 300 });
    const release = drag(h, 20, 20, 100, 20, false); // grab node 0 before the result lands, and hold it
    const rec = sampler(() => g.positions);
    await net.whenSettled();
    rec.stop();
    expect(rec.samples.length).toBeGreaterThan(3);
    for (const s of rec.samples) expect([s[0], s[1]]).toEqual([100, 20]); // never eased off the cursor
    expect(at(g, 0)).toEqual([100, 20]);
    expect(at(g, 5)).not.toEqual([POSITIONS[10], POSITIONS[11]]); // the rest of the map did move
    release();
    await nextFrame();
    expect(at(g, 0)).toEqual([100, 20]);
    net.destroy();
  });

  it("a node dropped before the worker's result lands stays where it was dropped", async () => {
    const { net, g, h } = await dragEngine();
    net.data(g, { modules: PAIRS });
    net.layout({ backend: "worker", nested: { warm: true }, transition: 300 });
    drag(h, 20, 20, 100, 20, true); // grab and release during the solve
    const rec = sampler(() => g.positions);
    await net.whenSettled();
    rec.stop();
    for (const s of rec.samples) expect([s[0], s[1]]).toEqual([100, 20]);
    expect(at(g, 0)).toEqual([100, 20]);
    net.destroy();
  });
});
