/**
 * The deterministic signature of #377: while the GPU layout streams with LOD on, the **main thread never
 * builds the LOD tree (`buildLODTree`) and never runs a geometry pass over it (`computeLODGeometry`,
 * `computeLODPositions`)** — not in `lod()`, not per streamed repaint, not during a node drag or its re-cool,
 * not on pan/zoom. Before #377 it built the tree once (~0.2 s at 325k nodes) and refit it on every repaint.
 *
 * The passes are counted by mocking `lod.js`. A real layout worker imports that module too, and vitest would
 * serve it the mock, which cannot run in a worker — so here the LOD worker is the in-process one
 * (`_in-process-lod-worker.ts`: the worker's real code, on a timer). Its refits call `computeLODPositions`
 * once each, and those are subtracted: what is left is the engine's own. The real worker is exercised,
 * unmocked, in `gpu-lod-relay.browser.test.ts` and the T7 guard.
 */
import { describe, it, expect, vi } from "vitest";
import { network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { InProcessLODWorker } from "./_in-process-lod-worker.js";

const calls = vi.hoisted(() => ({ build: 0, geometry: 0, positions: 0, workers: [] as { refits: number }[] }));

vi.mock("../../lod.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lod.js")>();
  return {
    ...mod,
    buildLODTree: (...args: Parameters<typeof mod.buildLODTree>) => {
      calls.build++;
      return mod.buildLODTree(...args);
    },
    computeLODGeometry: (...args: Parameters<typeof mod.computeLODGeometry>) => {
      calls.geometry++;
      return mod.computeLODGeometry(...args);
    },
    computeLODPositions: (...args: Parameters<typeof mod.computeLODPositions>) => {
      calls.positions++;
      return mod.computeLODPositions(...args);
    },
  };
});

vi.mock("../../worker-transport.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../worker-transport.js")>();
  return {
    ...mod,
    spawnLayoutWorker: () => {
      const worker = new InProcessLODWorker({ auto: true });
      calls.workers.push(worker);
      return worker;
    },
  };
});

const W = 400;
const H = 300;

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function clustered(n: number, seed: number): NetworkGraph {
  const rng = makePrng(seed);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push((i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  return buildGraph({ nodeCount: n, source, target });
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** The in-process LOD workers' refits: each ran `computeLODPositions` once. */
function workerRefits(): number {
  return calls.workers.reduce((n, w) => n + w.refits, 0);
}

describe("GPU layout with LOD on (#377): no LOD tree work on the main thread", () => {
  it("lod(), the streamed repaints, a node drag with its re-cool, and pan/zoom build and refit nothing", async () => {
    const host = document.createElement("div");
    host.style.width = `${W}px`;
    host.style.height = `${H}px`;
    document.body.appendChild(host);
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    net.interactive({ draggable: true });
    try {
      // An earlier GPU layout: the next lod() runs with the GPU backend already chosen (data() stops it).
      net.data(clustered(400, 1)).layout({ backend: "gpu", iterations: 5 });
      await net.whenSettled();
      calls.build = 0;
      calls.geometry = 0;
      calls.positions = 0;
      calls.workers.length = 0;

      const g = clustered(6000, 2);
      net.data(g).style({ sizeMode: "screen" }).lod({ expandPx: 48 }).layout({ backend: "gpu", iterations: 80 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      expect(net.lodSource).toBe("worker");
      expect(calls.workers).toHaveLength(1);
      expect(workerRefits(), "no frame went through the LOD worker").toBeGreaterThan(2);

      // A node drag of the settled layout (a per-frame interaction path) and its re-cool.
      const id = 0;
      const k = 4;
      net.setTransform({ k, x: W / 2 - (g.positions[id * 2] ?? 0) * k, y: H / 2 - (g.positions[id * 2 + 1] ?? 0) * k });
      await nextFrame();
      const rect = host.getBoundingClientRect();
      const pointer = (type: string, x: number, y: number): void => {
        host.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, button: 0, pointerId: 1 }));
      };
      const refitsBeforeDrag = workerRefits();
      pointer("pointerdown", W / 2, H / 2);
      pointer("pointermove", W / 2 + 8, H / 2);
      for (let f = 1; f <= 20; f++) {
        pointer("pointermove", W / 2 + 8 + 3 * f, H / 2 - 2 * f);
        await nextFrame();
      }
      pointer("pointerup", W / 2 + 68, H / 2 - 40);
      for (let f = 0; f < 30; f++) await nextFrame();
      expect(workerRefits(), "the drag's reflow did not go through the LOD worker").toBeGreaterThan(refitsBeforeDrag);

      net.setTransform({ k: 0.5, x: W / 2, y: H / 2 });
      await nextFrame();

      expect(calls.build, "buildLODTree on the main thread").toBe(0);
      expect(calls.geometry, "computeLODGeometry on the main thread").toBe(0);
      expect(calls.positions - workerRefits(), "computeLODPositions on the main thread").toBe(0);
      expect(net.lodSource).toBe("worker");
    } finally {
      net.destroy();
      host.remove();
    }
  });
});
