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
 *
 * With the spatial source (#343) the worker rebuilds the Morton tree for each relayed frame (`lodFrameStep`, the
 * worker backend's per-frame step), so the relay relays from the first harvest: each committed frame hands the
 * engine its rebuilt tree with a `release` that sends the buffer back; a frame id the worker already built
 * brings no tree (converged); and while `MAX_OUTSTANDING` trees are unreleased the relay takes no harvest, so
 * the worker never has to skip one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { buildMortonLODTree, computeLODPositions, lodTreeFromTopology, type LODTree } from "../../lod.js";
import { MAX_OUTSTANDING, type LeafStyle, type LODView } from "../../lod-frame.js";
import type { StreamedLODTree } from "../../worker-transport.js";
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
  const relay = new LODRelay(worker, graph, { coarsen: { minNodes: 4 } }, (tree) => trees.push(tree));
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
    relay.submit(1);
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
    relay.submit(3);
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
      relay.submit(f + 1);
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
    relay.submit(1);
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
    relay.submit(1); // out with the worker
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
    expect(() => new LODRelay(worker, clustered(200), {}, (tree) => trees.push(tree))).toThrow("refused");
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
    const relay = new LODRelay(worker, graph, { coarsen: { minNodes: 4 } }, (tree) => trees.push(tree), { options, onPlan: (plan) => plans.push(plan) });
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
    const relay = new LODRelay(worker, graph, {}, () => {}, { options, onPlan: (plan) => plans.push(plan) });
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

/** A spatial relay (#343) over a fresh graph, with the trees and streamed handles it hands the engine. */
function startSpatial(n = 1500, seed: { options: { width: number; height: number }; onPlan: () => void } | null = null, view?: LODView) {
  const graph = clustered(n);
  const worker = new InProcessLODWorker();
  const style: LeafStyle = { radii: new Float32Array(n).fill(2), weight: new Float32Array(n).fill(1) };
  const trees: (LODTree | null)[] = [];
  const handles: StreamedLODTree[] = [];
  const relay = new LODRelay(
    worker,
    graph,
    { source: "spatial", style, styleVersion: 3, view },
    (tree, streamed) => {
      trees.push(tree);
      if (streamed) handles.push(streamed);
    },
    seed,
  );
  let woken = 0;
  relay.listen(() => {
    woken++;
  });
  /** Harvest `positions` (or a shifted copy of the graph's) as tick `ticks`, and have the worker answer. */
  const frame = (ticks: number, positions?: Float32Array): Float32Array => {
    const target = relay.target();
    if (!target) throw new Error("no target");
    const harvested = positions ?? graph.positions.map((v) => v + ticks);
    target.set(harvested);
    relay.submit(ticks);
    worker.flush();
    return harvested;
  };
  return { graph, worker, relay, trees, handles, frame, wakes: () => woken };
}

describe("LOD relay: the spatial source (#343)", () => {
  it("relays from the first harvest into its own buffer; nothing holds settled, no topology is asked for", () => {
    const { graph, worker, relay } = startSpatial();
    const request = worker.received[0];
    expect(request?.type === "coarsen" && request.lod && request.lodSource).toBe("spatial");
    expect(request?.type === "coarsen" && request.lodStyleVersion).toBe(3);
    worker.flush();
    expect(worker.stream?.kind).toBe("spatial");
    expect(relay.holding).toBe(false);
    expect(relay.relays).toBe(true);
    const target = relay.target();
    expect(target).not.toBeNull();
    expect(target).not.toBe(graph.positions);
    expect(target?.length).toBe(graph.positions.length);
  });

  it("puts a harvest on the graph at commit, with the spatial tree the worker rebuilt for exactly it", () => {
    const { graph, relay, trees, handles, frame, wakes } = startSpatial();
    const before = graph.positions.slice();
    const harvested = frame(5);
    expect(relay.ready).toBe(true);
    expect(wakes()).toBe(1);
    // Back, but not on the graph yet, and not handed to the engine.
    expect(graph.positions).toEqual(before);
    expect(trees).toHaveLength(0);
    expect(relay.commit()).toBe(true);
    expect(graph.positions).toEqual(harvested);
    expect(trees).toHaveLength(1);
    expect(handles).toHaveLength(1);
    const tree = trees[0];
    if (!tree?.morton) throw new Error("no spatial tree");
    expect(handles[0]?.header.frame).toBe(5);
    expect(handles[0]?.header.styleVersion).toBe(3);
    const want = buildMortonLODTree(harvested, graph.nodeCount, { box: tree.morton.box });
    computeLODPositions(want, harvested);
    expect(tree.size).toBe(want.size);
    expect(tree.cx).toEqual(want.cx);
    expect(tree.extent).toEqual(want.extent);
  });

  it("a released tree's buffer goes back to the worker, which rebuilds the next frame into it", () => {
    const { worker, relay, handles, frame } = startSpatial();
    frame(1);
    relay.commit();
    frame(2);
    relay.commit();
    expect(handles).toHaveLength(2);
    handles[0]?.release();
    handles[0]?.release(); // once only
    expect(worker.received.filter((m) => m.type === "lod-recycle")).toHaveLength(1);
    worker.flush();
    const stream = worker.stream;
    if (stream?.kind !== "spatial") throw new Error("no spatial stream");
    expect(stream.outstanding).toBe(1);
    expect(stream.pool).toHaveLength(1);
    frame(3);
    expect(stream.pool).toHaveLength(0); // the rebuild took the returned buffer
  });

  it("stops at convergence: the same ticks again bring positions and no tree", () => {
    const { graph, relay, trees, frame } = startSpatial();
    const at = graph.positions.map((v) => v * 1.5);
    frame(9, at);
    relay.commit();
    frame(9, at);
    expect(relay.ready).toBe(true);
    expect(relay.commit()).toBe(true);
    expect(trees).toHaveLength(1); // no rebuild for a frame id already built
    frame(10);
    relay.commit();
    expect(trees).toHaveLength(2);
  });

  it(`takes no harvest while ${MAX_OUTSTANDING} trees are unreleased, and wakes the stream once one is released`, () => {
    const { worker, relay, trees, handles, frame, wakes } = startSpatial();
    for (let f = 1; f <= MAX_OUTSTANDING; f++) {
      frame(f);
      relay.commit();
    }
    expect(trees).toHaveLength(MAX_OUTSTANDING);
    expect(relay.target()).toBeNull(); // the engine holds them all: the next harvest waits
    const woken = wakes();
    handles[0]?.release();
    expect(wakes()).toBe(woken + 1);
    worker.flush();
    frame(MAX_OUTSTANDING + 1);
    relay.commit();
    // The worker never had to skip a frame for back-pressure: every relayed frame brought its tree.
    expect(trees).toHaveLength(MAX_OUTSTANDING + 1);
    const stream = worker.stream;
    expect(stream?.kind === "spatial" && stream.pending).toBe(false);
  });

  it("a new style reaches the worker, and later trees carry its version", () => {
    const { graph, worker, relay, handles, frame } = startSpatial();
    frame(1);
    relay.commit();
    const n = graph.nodeCount;
    relay.setStyle({ radii: new Float32Array(n).fill(4), weight: new Float32Array(n).fill(2) }, 8);
    frame(2);
    relay.commit();
    expect(worker.received.filter((m) => m.type === "lod-style")).toHaveLength(1);
    expect(handles.map((h) => h.header.styleVersion)).toEqual([3, 8]);
  });

  it("posts the edges, with or without a seed request: the spatial tree's super-edge rows are summed from them (#433)", () => {
    const { graph, worker } = startSpatial();
    const bare = worker.received[0];
    expect(bare?.type === "coarsen" && [bare.source.length, bare.target.length, bare.weight.length]).toEqual([graph.edgeCount, graph.edgeCount, graph.edgeCount]);
    expect(bare?.type === "coarsen" && bare.nodeCount).toBe(graph.nodeCount);
    const seeded = startSpatial(1500, { options: { width: 800, height: 600 }, onPlan: () => {} });
    const withSeed = seeded.worker.received[0];
    expect(withSeed?.type === "coarsen" && withSeed.source.length).toBe(seeded.graph.edgeCount);
  });

  it("with a view, every relayed tree carries the super-edge rows of the glyphs that view keeps (#433); a new view is posted", () => {
    const view: LODView = { transform: { k: 0.5, x: 400, y: 300 }, fitPad: 2, width: 800, height: 600, maxAggregateRadius: 20, screenSized: true, fadeBand: 0, declutter: true };
    const { worker, relay, trees, handles, frame } = startSpatial(1500, null, view);
    const request = worker.received[0];
    expect(request?.type === "coarsen" && request.lodView).toEqual(view);
    frame(1);
    relay.commit();
    const tree = trees[0];
    if (!tree?.rows) throw new Error("no super-edge rows with the relayed tree");
    expect(tree.rows.cell.length).toBeGreaterThan(0);
    // The released tree hands its rows buffer back with its frame buffer.
    handles[0]?.release();
    const recycle = worker.received.find((m) => m.type === "lod-recycle");
    expect(recycle?.type === "lod-recycle" && recycle.rows?.byteLength).toBeGreaterThan(0);
    worker.flush();
    const stream = worker.stream;
    if (stream?.kind !== "spatial" || !stream.links) throw new Error("no spatial stream with edges");
    expect(stream.links.pool).toHaveLength(1);
    // A new view reaches the worker's stream.
    const moved: LODView = { ...view, transform: { k: 2, x: -100, y: 50 } };
    relay.setView(moved);
    worker.flush();
    expect(stream.view).toEqual(moved);
  });

  it("with a seed request, the worker coarsens for the plan only: the plan arrives, no topology", () => {
    const plans: number[] = [];
    const { worker, relay, trees } = startSpatial(1500, { options: { width: 800, height: 600 }, onPlan: () => plans.push(1) });
    worker.flush();
    expect(plans).toEqual([1]);
    expect(trees).toHaveLength(0);
    expect(relay.relays).toBe(true);
  });

  it("a failed worker withdraws the tree; a release after it posts nothing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { worker, relay, trees, handles, frame } = startSpatial();
    frame(1);
    relay.commit();
    worker.onerror?.(new WorkerError());
    expect(trees).toEqual([expect.anything(), null]);
    const posts = worker.received.length;
    handles[0]?.release();
    expect(worker.received.length).toBe(posts);
    expect(relay.relays).toBe(false);
  });
});
