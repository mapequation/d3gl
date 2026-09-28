/**
 * The GPU layout's LOD relay (#377), node: the main thread's half of the worker LOD refit, driven against an
 * in-process worker that runs the real worker half (`lod-refit.ts`) and moves buffers the way `postMessage`
 * transfers them (the sender's copy detaches). Pinned here:
 *
 * - the tree is adopted only with geometry refit to the positions on screen, and `settled` is held until then;
 * - a streamed harvest reaches the graph only at commit, together with the tree's geometry for it — never
 *   positions without their geometry, or geometry without its positions;
 * - the two buffers go back and forth (the geometry buffer is handed back on every request after the first),
 *   so a streamed frame allocates nothing;
 * - a failed worker withdraws the tree, passes harvests straight through, and reports a frame it took with it
 *   as lost; a destroyed relay terminates the worker and ignores late replies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { computeLODPositions, lodTreeFromTopology, type LODTree } from "../../lod.js";
import type { WorkerToMain } from "../../worker-protocol.js";
import { LODRelay } from "../lod-relay.js";
import { SeedWorker } from "../seed-worker.js";
import type { SeedPlan } from "../seed-plan.js";
import { InProcessLODWorker } from "./_in-process-lod-worker.js";

/** `ErrorEvent` is not a Node global: the fields a worker `error` event carries. */
class WorkerError extends Event implements ErrorEvent {
  readonly colno = 0;
  readonly error: unknown = null;
  readonly filename = "";
  readonly lineno = 0;
  readonly message = "boom";
  constructor() {
    super("error");
  }
}

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function clustered(n: number): NetworkGraph {
  const rng = makePrng(17);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push(Math.floor(rng() * n));
  }
  const g = buildGraph({ nodeCount: n, source, target });
  for (let i = 0; i < 2 * n; i++) g.positions[i] = (rng() - 0.5) * 500;
  return g;
}

/** The geometry the worker backend would compute for `tree`'s topology at `positions`. */
function expectedGeometry(tree: LODTree, positions: Float32Array): { cx: Float32Array; cy: Float32Array; extent: Float32Array } {
  const reference = lodTreeFromTopology(tree);
  computeLODPositions(reference, positions);
  return { cx: reference.cx, cy: reference.cy, extent: reference.extent };
}

/** A relay over a fresh graph, with the tree it hands the engine. */
function start(n = 1200): { graph: NetworkGraph; worker: InProcessLODWorker; relay: LODRelay; trees: (LODTree | null)[]; wakes: () => number } {
  const graph = clustered(n);
  const worker = new InProcessLODWorker();
  const trees: (LODTree | null)[] = [];
  const relay = new LODRelay(worker, graph, { minNodes: 4 }, (tree) => trees.push(tree));
  let woken = 0;
  relay.listen(() => {
    woken++;
  });
  return { graph, worker, relay, trees, wakes: () => woken };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LOD relay: coarsen and adopt (#377)", () => {
  it("passes harvests straight through and holds settled while the worker builds the tree", () => {
    const { graph, worker, relay, trees } = start();
    expect(worker.received.map((m) => m.type)).toEqual(["coarsen"]);
    expect(relay.holding).toBe(true);
    expect(relay.relays).toBe(false);
    expect(relay.target()).toBe(graph.positions);
    relay.submit();
    expect(relay.ready).toBe(true);
    expect(relay.commit()).toBe(true);
    expect(trees).toHaveLength(0);
  });

  it("adopts the tree only with geometry refit to the positions on screen, then paints it", () => {
    const { graph, worker, relay, trees, wakes } = start();
    const onScreen = graph.positions.slice();
    worker.flush();
    expect(trees).toHaveLength(1);
    const tree = trees[0];
    if (!tree) throw new Error("no tree");
    const want = expectedGeometry(tree, onScreen);
    expect(tree.cx).toEqual(want.cx);
    expect(tree.cy).toEqual(want.cy);
    expect(tree.extent).toEqual(want.extent);
    // The adoption frame: nothing moves, the stream repaints with the tree.
    expect(relay.holding).toBe(false);
    expect(relay.relays).toBe(true);
    expect(relay.ready).toBe(true);
    expect(wakes()).toBe(1);
    expect(relay.commit()).toBe(true);
    expect(graph.positions).toEqual(onScreen);
  });

  it("takes no harvest while the adoption refit is out, so the positions stay the ones it refits", () => {
    const { worker, relay, trees } = start();
    // Hold the adoption refit's reply back: the topology has arrived, its first geometry has not.
    const deliver = worker.onmessage;
    let held: MessageEvent<WorkerToMain> | null = null;
    worker.onmessage = (event) => {
      if (event.data.type === "lod-geometry" && !held) held = event;
      else deliver?.(event);
    };
    worker.flush();
    expect(relay.holding).toBe(true);
    expect(relay.target()).toBeNull();
    expect(trees).toHaveLength(0); // no tree without its geometry
    if (!held) throw new Error("no adoption refit");
    deliver?.(held);
    expect(trees).toHaveLength(1);
    expect(relay.holding).toBe(false);
  });
});

describe("LOD relay: streaming (#377)", () => {
  it("puts a harvest on the graph only at commit, together with the tree's geometry for it", () => {
    const { graph, worker, relay, trees } = start();
    worker.flush();
    relay.commit(); // the adoption frame
    const tree = trees[0];
    if (!tree) throw new Error("no tree");
    const before = graph.positions.slice();
    const geometryBefore = tree.cx.slice();

    const target = relay.target();
    if (!target) throw new Error("no target");
    expect(target).not.toBe(graph.positions);
    for (let i = 0; i < target.length; i++) target[i] = (before[i] ?? 0) + 25;
    const harvested = target.slice();
    relay.submit();
    expect(relay.ready).toBe(false);
    expect(relay.target()).toBeNull(); // one frame out at a time

    worker.flush();
    expect(relay.ready).toBe(true);
    // Back, but not on the graph yet: neither the positions nor the geometry moved.
    expect(graph.positions).toEqual(before);
    expect(tree.cx).toEqual(geometryBefore);

    expect(relay.commit()).toBe(true);
    expect(graph.positions).toEqual(harvested);
    const want = expectedGeometry(tree, harvested);
    expect(tree.cx).toEqual(want.cx);
    expect(tree.cy).toEqual(want.cy);
    expect(tree.extent).toEqual(want.extent);
  });

  it("hands the geometry buffer back on every request after the first: a streamed frame allocates nothing", () => {
    const { worker, relay, trees } = start();
    worker.flush();
    relay.commit();
    const size = trees[0]?.size ?? 0;
    for (let f = 0; f < 5; f++) {
      const target = relay.target();
      if (!target) throw new Error("no target");
      target[0] = f;
      relay.submit();
      worker.flush();
      relay.commit();
    }
    // The adoption refit has no buffer to hand back; each of the 5 frames hands back the previous reply's.
    expect(worker.refitGeometry).toEqual([-1, ...Array.from({ length: 5 }, () => 3 * size)]);
  });

  it("wakes the stream when a frame is back", () => {
    const { worker, relay, wakes } = start();
    worker.flush();
    relay.commit();
    const woken = wakes();
    relay.target();
    relay.submit();
    worker.flush();
    expect(wakes()).toBe(woken + 1);
  });
});

describe("LOD relay: failure and teardown (#377)", () => {
  it("a worker error withdraws the tree, reports the frame it took as lost, and passes harvests straight through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { graph, worker, relay, trees } = start();
    worker.flush();
    relay.commit();
    relay.target();
    relay.submit(); // out with the worker
    worker.onerror?.(new WorkerError());
    expect(worker.terminated).toBe(true);
    expect(trees).toEqual([expect.anything(), null]);
    expect(relay.ready).toBe(true);
    expect(relay.commit()).toBe(false); // lost: the stream copies those ticks again
    expect(relay.relays).toBe(false);
    expect(relay.holding).toBe(false);
    expect(relay.target()).toBe(graph.positions);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("an error while coarsening releases the settle hold and withdraws the tree", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { worker, relay, trees, wakes } = start();
    worker.onerror?.(new WorkerError());
    expect(relay.holding).toBe(false);
    expect(trees).toEqual([null]);
    expect(wakes()).toBe(1);
  });

  it("a reply that cannot be deserialized (messageerror) fails the relay as an error does", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { worker, relay, trees } = start();
    worker.onmessageerror?.(new MessageEvent("messageerror"));
    expect(worker.terminated).toBe(true);
    expect(relay.holding).toBe(false);
    expect(trees).toEqual([null]);
  });

  it("a coarsen post that throws: the constructor throws with the worker terminated, and hands the engine nothing", () => {
    const worker = new InProcessLODWorker();
    vi.spyOn(worker, "postMessage").mockImplementation(() => {
      throw new DOMException("refused", "DataCloneError");
    });
    const trees: (LODTree | null)[] = [];
    // The caller reports the transport first and withdraws the tree after it, so no callback runs here.
    expect(() => new LODRelay(worker, clustered(200), undefined, (tree) => trees.push(tree))).toThrow("refused");
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
    expect(trees).toEqual([]);
  });

  it("destroy terminates the worker and ignores its late replies", () => {
    const { worker, relay, trees } = start();
    relay.destroy();
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
    worker.flush();
    expect(trees).toHaveLength(0);
  });
});

describe("the multilevel seed's plan from the coarsening worker (#353)", () => {
  const options = { width: 800, height: 600 };

  it("the relay asks for the plan with its tree and hands it over first, once, before it adopts the tree", () => {
    const graph = clustered(1500);
    const worker = new InProcessLODWorker();
    const plans: (SeedPlan | null)[] = [];
    const trees: (LODTree | null)[] = [];
    const relay = new LODRelay(worker, graph, { minNodes: 4 }, (tree) => trees.push(tree), { options, onPlan: (plan) => plans.push(plan) });
    const request = worker.received[0];
    expect(request?.type === "coarsen" && request.lod && request.seed).toEqual(options);
    worker.flush();
    expect(plans.length).toBe(1);
    expect(plans[0]?.nodeCount).toBe(graph.nodeCount);
    expect(plans[0]?.levels.length).toBeGreaterThan(1);
    expect(trees).toEqual([expect.objectContaining({ size: expect.any(Number) })]); // adopted after the plan
    relay.destroy();
  });

  it("a relay without a seed request asks for no plan", () => {
    const { worker, relay } = start();
    const request = worker.received[0];
    expect(request?.type === "coarsen" && request.seed).toBeUndefined();
    relay.destroy();
  });

  it("the relay hands over null when its worker fails before the plan, and nothing after the plan", () => {
    const graph = clustered(800);
    const worker = new InProcessLODWorker();
    const plans: (SeedPlan | null)[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = new LODRelay(worker, graph, undefined, () => {}, { options, onPlan: (plan) => plans.push(plan) });
    worker.onerror?.(new WorkerError());
    expect(plans).toEqual([null]);
    worker.onerror?.(new WorkerError());
    expect(plans).toEqual([null]);
    relay.destroy();
  });

  it("the seed-only worker (LOD off) asks for the plan without the tree, delivers it once and terminates", () => {
    const graph = clustered(1500);
    const worker = new InProcessLODWorker();
    const plans: (SeedPlan | null)[] = [];
    new SeedWorker(worker, graph, undefined, options, (plan) => plans.push(plan));
    const request = worker.received[0];
    expect(request?.type === "coarsen" && !request.lod && request.seed).toEqual(options);
    worker.flush();
    expect(plans.length).toBe(1);
    expect(plans[0]?.levels.length).toBeGreaterThan(1);
    expect(worker.terminated).toBe(true);
  });

  it("the seed-only worker warns and delivers null when the worker fails; destroyed, it delivers nothing", () => {
    const graph = clustered(800);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new InProcessLODWorker();
    const plans: (SeedPlan | null)[] = [];
    new SeedWorker(failing, graph, undefined, options, (plan) => plans.push(plan));
    failing.onerror?.(new WorkerError());
    expect(plans).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(failing.terminated).toBe(true);

    const stopped = new InProcessLODWorker();
    const late: (SeedPlan | null)[] = [];
    const seedWorker = new SeedWorker(stopped, graph, undefined, options, (plan) => late.push(plan));
    seedWorker.destroy();
    stopped.flush();
    expect(late).toEqual([]);
    expect(stopped.terminated).toBe(true);
  });
});
