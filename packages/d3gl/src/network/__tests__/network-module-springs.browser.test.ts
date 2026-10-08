/**
 * Module links as springs in the engine's flat force layouts (#455), end to end: `data(graph, { modules,
 * moduleLinks })` reaches every flat backend's solver.
 *
 * - `force`: a real pointer drag of a selected module (one tick per animation frame, as the drag loop runs)
 *   pulls the module linked to it and not the unlinked ones; without module links nothing follows it.
 * - `worker`: the run's start message carries the springs (the worker's solve is pinned bit for bit to this
 *   thread's in `worker-layout.browser.test.ts`).
 * - `gpu`: the GPU solve runs its module-spring passes (their parity with the CPU is pinned in
 *   `gpu-module-springs.browser.test.ts`).
 * - Without module links the flat layout is exactly the graph's own.
 * - A warm layout (#454), which goes on from the positions on screen, pulls along them too, on every backend.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { network, type Network } from "../network.js";
import { DEFAULT_FORCE, ForceLayout } from "../force.js";
import type { ModuleLink } from "../modules.js";
import type { MainToWorker, StartMessage } from "../worker-protocol.js";
import { GpuModuleSprings } from "../gpu/module-springs.js";
import { LINKS, TOPS, centroid, fixture, springsOf } from "./module-springs-fixture.js";

const SIZE = 600;
const hosts: HTMLElement[] = [];
function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:0;top:0;width:${SIZE}px;height:${SIZE}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
  vi.restoreAllMocks();
});

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const SPACING = Math.sqrt((Math.PI * DEFAULT_FORCE.repulsion) / DEFAULT_FORCE.centering);

/** A pointer event on the host (down) or bubbling from it (move/up), at host-relative CSS px. */
function pointer(h: HTMLElement, type: string, x: number, y: number): void {
  const r = h.getBoundingClientRect();
  h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
}

/**
 * Lay the fixture out on the `force` backend, select module 1 and drag it 12 equilibrium spacings away
 * from the layout's centroid over 30 animation frames with real pointer events. Returns how far module 2
 * and the other modules (on average) followed, in spacings, as the drag lands.
 */
async function forceDrag(links: ModuleLink[] | undefined): Promise<{ followed2: number; others: number }> {
  const f = fixture();
  const h = host();
  const net: Network = network(h, { width: SIZE, height: SIZE });
  await net.whenReady();
  net.data(f.graph, { modules: f.records, ...(links ? { moduleLinks: links } : {}) }).style({ nodeRadius: 6 });
  net.layout({ backend: "force", iterations: 300 });
  const p = f.graph.positions;
  const all = Array.from({ length: f.graph.nodeCount }, (_, i) => i);
  const [x0, y0] = centroid(p, all);
  const k = 0.25;
  net.setTransform({ k, x: SIZE / 2 - x0 * k, y: SIZE / 2 - y0 * k });
  const m1 = f.top(1);
  net.interactive({ draggable: true, selectable: { multi: true } });
  net.select("nodes", m1);
  const [x1, y1] = centroid(p, m1);
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const before = Array.from({ length: TOPS }, (_, t) => centroid(p, f.top(t + 1)));
  const gx = p[m1[0]! * 2]! * k + SIZE / 2 - x0 * k;
  const gy = p[m1[0]! * 2 + 1]! * k + SIZE / 2 - y0 * k;
  const shift = 12 * SPACING * k; // px
  pointer(h, "pointerdown", gx, gy);
  const frames = 30;
  for (let frame = 1; frame <= frames; frame++) {
    const t = frame / frames;
    pointer(h, "pointermove", gx + t * shift * ux, gy + t * shift * uy);
    await nextFrame();
  }
  const along = (t: number): number => {
    const [x, y] = centroid(p, f.top(t));
    const [bx, by] = before[t - 1]!;
    return ((x - bx) * ux + (y - by) * uy) / SPACING;
  };
  const held = along(1);
  let others = 0;
  for (let t = 3; t <= TOPS; t++) others += along(t) / (TOPS - 2);
  const result = { followed2: along(2), others };
  pointer(h, "pointerup", gx + shift * ux, gy + shift * uy);
  net.destroy();
  expect(held).toBeCloseTo(12, 1); // the held module sits under the cursor
  return result;
}

describe("network flat layouts pull along module links (#455)", () => {
  it("force: a module drag pulls the module linked to it, not the unlinked ones", async () => {
    const linked = await forceDrag(LINKS);
    expect(linked.followed2 - linked.others).toBeGreaterThan(3);
    const plain = await forceDrag(undefined);
    expect(Math.abs(plain.followed2 - plain.others)).toBeLessThan(1.5);
  });

  it("force: without module links the layout is exactly the graph's own", async () => {
    const run = async (withModules: boolean): Promise<Float32Array> => {
      const f = fixture();
      const net = network(host(), { width: SIZE, height: SIZE });
      await net.whenReady();
      net.data(f.graph, withModules ? { modules: f.records } : {}).layout({ backend: "force", iterations: 120 });
      const positions = f.graph.positions.slice();
      net.destroy();
      return positions;
    };
    const plain = await run(false);
    expect(Array.from(await run(true))).toEqual(Array.from(plain));
  });

  it("worker: the run's solve gets the module springs, and none without module links", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage"); // calls through
    for (const links of [LINKS, undefined]) {
      const f = fixture();
      const net = network(host(), { width: SIZE, height: SIZE });
      await net.whenReady();
      net.data(f.graph, { modules: f.records, ...(links ? { moduleLinks: links } : {}) }).layout({ backend: "worker", iterations: 60 });
      await net.whenSettled();
      net.destroy();
    }
    const messages: MainToWorker[] = post.mock.calls.map((call) => call[0]);
    const starts = messages.filter((m): m is StartMessage => m.type === "start");
    expect(starts.length).toBe(2);
    expect(starts[0]?.moduleSprings?.source.length).toBe(LINKS.length);
    expect(starts[1]?.moduleSprings).toBeUndefined();
  });

  it("gpu: the GPU solve runs the module-spring passes, and none without module links", async () => {
    const prepare = vi.spyOn(GpuModuleSprings.prototype, "prepare");
    const run = async (links: ModuleLink[] | undefined): Promise<number> => {
      prepare.mockClear();
      const f = fixture();
      const net = network(host(), { width: SIZE, height: SIZE, backend: "webgl" });
      await net.whenReady();
      net.data(f.graph, { modules: f.records, ...(links ? { moduleLinks: links } : {}) }).layout({ backend: "gpu", iterations: 60 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      net.destroy();
      return prepare.mock.calls.length;
    };
    expect(await run(LINKS)).toBeGreaterThan(0);
    expect(await run(undefined)).toBe(0);
  });

  it("force, warm (#454): the warm layout is the pure warm solve with the module springs", async () => {
    const f = fixture();
    const net = network(host(), { width: SIZE, height: SIZE });
    await net.whenReady();
    net.data(f.graph, { modules: f.records, moduleLinks: LINKS }).layout({ backend: "force", iterations: 120 });
    const from = f.graph.positions.slice();
    net.layout({ backend: "force", warm: true, iterations: 120 });
    const want = { ...f.graph, positions: from.slice(), moduleSprings: springsOf(f, LINKS) };
    new ForceLayout(want).run(120, "cool");
    expect(Array.from(f.graph.positions)).toEqual(Array.from(want.positions));
    const plain = { ...f.graph, positions: from.slice() };
    new ForceLayout(plain).run(120, "cool");
    expect(Array.from(plain.positions), "non-vacuity: the springs move the warm solve").not.toEqual(Array.from(want.positions));
    net.destroy();
  });

  it("worker, warm (#454): the warm run's solve gets the module springs, as the cold run's does", async () => {
    const f = fixture();
    const net = network(host(), { width: SIZE, height: SIZE });
    await net.whenReady();
    net.data(f.graph, { modules: f.records, moduleLinks: LINKS }).layout({ backend: "worker", iterations: 60 });
    await net.whenSettled();
    const post = vi.spyOn(Worker.prototype, "postMessage"); // calls through
    net.layout({ backend: "worker", warm: true, iterations: 60 });
    await net.whenSettled();
    net.destroy();
    const starts = post.mock.calls.map((call): MainToWorker => call[0]).filter((m): m is StartMessage => m.type === "start");
    expect(starts.length).toBe(1);
    expect(starts[0]?.warm, "not a warm run").toBeDefined();
    expect(starts[0]?.moduleSprings?.source.length).toBe(LINKS.length);
  });

  it("gpu, warm (#454): the warm GPU solve runs the module-spring passes, as the cold one does", async () => {
    const f = fixture();
    const net = network(host(), { width: SIZE, height: SIZE, backend: "webgl" });
    await net.whenReady();
    net.data(f.graph, { modules: f.records, moduleLinks: LINKS }).layout({ backend: "gpu", iterations: 60 });
    await net.whenSettled();
    const prepare = vi.spyOn(GpuModuleSprings.prototype, "prepare");
    net.layout({ backend: "gpu", warm: true, iterations: 60 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");
    net.destroy();
    expect(prepare.mock.calls.length).toBeGreaterThan(0);
  });
});
