import { describe, it, expect, vi, afterEach } from "vitest";
import { network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { DEFAULT_FORCE } from "../force.js";
import { InstancedLane } from "../../core/instanced-lane.js";
import type { MainToWorker, ProgressMessage, WorkerToMain } from "../worker-protocol.js";

// NB: no `vi.mock` of a module the layout worker imports (lod.js, force.js, …): vitest's browser
// mocker intercepts the worker's imports too and the worker dies on load ("getFactoryModule").
// Main-thread work is counted through class prototypes the worker never loads instead.

/**
 * The worker streams the multilevel seed as it forms (#368): on a graph whose seed takes a while, it
 * posts progress frames — every node, prolongated from the coarse level being solved — before the seed
 * frame and the refinement, and a pin or stop lands mid-seed. Driven through a real layout worker.
 */

/** A ring with deterministic chords: coarsens by about half per level, so a 30k graph's seed solves a
 *  dozen levels (a few hundred ms in headless Chromium) — long enough to stream. */
function clustered(n: number): NetworkGraph {
  let s = 99 >>> 0;
  const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  return buildGraph({ nodeCount: n, source, target });
}

const N = 30_000;
const W = 400;
const H = 400;

interface Received {
  msg: WorkerToMain;
  at: number;
}

/** A layout worker run on `g`, recording every message with its arrival time. */
function startRun(g: NetworkGraph, iterations: number, lod = false) {
  const worker = new Worker(new URL("../layout-worker.js", import.meta.url), { type: "module" });
  const received: Received[] = [];
  worker.onmessage = (e: MessageEvent<WorkerToMain>) => received.push({ msg: e.data, at: performance.now() });
  const start: MainToWorker = {
    type: "start",
    nodeCount: g.nodeCount,
    source: g.source,
    target: g.target,
    weight: g.weight,
    width: W,
    height: H,
    iterations,
    multilevel: true,
    lod,
  };
  const t0 = performance.now();
  worker.postMessage(start);
  const frames = (): ProgressMessage[] => received.flatMap((r) => (r.msg.type === "frame" || r.msg.type === "done" ? [r.msg] : []));
  const waitFor = async (done: () => boolean, ms = 20_000): Promise<void> => {
    const deadline = performance.now() + ms;
    while (!done() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  };
  const send = (msg: MainToWorker): void => worker.postMessage(msg);
  return { worker, received, frames, waitFor, send, start, t0 };
}

/** Index of the first refinement frame (tick ≥ 1), or -1. */
const refinementStart = (frames: ProgressMessage[]): number => frames.findIndex((f) => f.tick >= 1);

function r95(p: Float32Array, n: number): { r: number; cx: number; cy: number } {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) (cx += p[i * 2] ?? 0, cy += p[i * 2 + 1] ?? 0);
  cx /= n;
  cy /= n;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.hypot((p[i * 2] ?? 0) - cx, (p[i * 2 + 1] ?? 0) - cy);
  d.sort();
  return { r: d[Math.floor(0.95 * (n - 1))] ?? 0, cx, cy };
}

describe("worker seed progress frames (#368)", () => {
  const workers: Worker[] = [];
  afterEach(() => {
    for (const w of workers.splice(0)) w.terminate();
  });

  it("posts progress frames before the seed frame: every node, finite, at the finished seed's extent", async () => {
    const g = clustered(N);
    const run = startRun(g, 20, true);
    workers.push(run.worker);
    await run.waitFor(() => refinementStart(run.frames()) >= 0);
    const frames = run.frames();
    const first = refinementStart(frames);
    expect(first, "no refinement frame arrived").toBeGreaterThan(0);
    // Frames before the first refinement tick all carry tick 0: the progress frames, then the seed frame.
    const seedFrames = frames.slice(0, first);
    expect(seedFrames.every((f) => f.tick === 0)).toBe(true);
    expect(seedFrames.length, "no progress frame before the seed frame").toBeGreaterThanOrEqual(2);

    // The LOD topology comes first, so the main thread can draw the very first progress frame.
    expect(run.received[0]?.msg.type).toBe("lod-topology");

    const R95 = Math.sqrt(0.95) * Math.sqrt((DEFAULT_FORCE.repulsion * N) / DEFAULT_FORCE.centering);
    const seedP = seedFrames[seedFrames.length - 1]?.positions;
    expect(seedP).toBeDefined();
    const seed = r95(seedP ?? new Float32Array(2 * N), N);
    expect(seed.r / R95).toBeGreaterThan(0.75); // the finished seed is at the force equilibrium
    expect(seed.r / R95).toBeLessThan(1.25);
    for (const f of seedFrames) {
      const p = f.positions;
      expect(p?.length).toBe(2 * N); // copy mode: every node in every frame
      if (!p) continue;
      expect(p.every(Number.isFinite)).toBe(true);
      // The LOD geometry streams with it: `[cx, cy, extent]` finite; the crowding after them (#426, the 4th
      // quarter) is Infinity where members only clear past the footprint horizon, never NaN.
      const g = f.geometry ?? new Float32Array(0);
      expect(g.length).toBeGreaterThan(0);
      expect(g.subarray(0, (3 * g.length) / 4).every(Number.isFinite)).toBe(true);
      expect(g.subarray((3 * g.length) / 4).every((z) => !Number.isNaN(z))).toBe(true);
      // At the finished seed's extent and centre from the first progress frame: a fitted view and the
      // LOD extents hold still into the refinement (no zoom-out on a coarse level and back in).
      const { r, cx, cy } = r95(p, N);
      expect(r / seed.r).toBeGreaterThan(0.85);
      expect(r / seed.r).toBeLessThan(1.15);
      expect(Math.hypot(cx - seed.cx, cy - seed.cy)).toBeLessThan(0.05 * seed.r);
    }

    // Paced by time: never more than one progress frame per 16 ms of seed.
    const topologyAt = run.received[0]?.at ?? run.t0;
    const seedAt = run.received.find((r) => r.msg === seedFrames[seedFrames.length - 1])?.at ?? Infinity;
    expect(seedFrames.length - 1).toBeLessThanOrEqual((seedAt - topologyAt) / 16 + 1);
  }, 60_000);

  it("holds a pin that lands mid-seed: in the progress frames after it, the seed frame and every refinement tick", async () => {
    const g = clustered(N);
    const run = startRun(g, 20);
    workers.push(run.worker);
    await run.waitFor(() => run.frames().length >= 1);
    expect(refinementStart(run.frames()), "the seed finished before the pin could land mid-seed").toBe(-1);
    const X = Math.fround(1e5);
    const Y = Math.fround(-1e5);
    run.send({ type: "pin", ids: Uint32Array.of(0), positions: Float32Array.of(X, Y) });
    await run.waitFor(() => refinementStart(run.frames()) >= 0 && run.frames().length >= refinementStart(run.frames()) + 3);
    const frames = run.frames();
    const first = refinementStart(frames);
    expect(first).toBeGreaterThan(0);
    const held = (f: ProgressMessage | undefined): boolean => f?.positions?.[0] === X && f.positions[1] === Y;
    // The seed frame already shows the node where the drag put it (its positions, and the LOD geometry
    // derived from them), and so does every progress frame from the first one posted after the pin landed.
    expect(held(frames[first - 1]), "the seed frame lost the held node").toBe(true);
    const since = frames.findIndex(held);
    expect(frames.slice(since, first).every(held), "a progress frame after the pin dropped the held node").toBe(true);
    // Every refinement frame holds the node exactly where the drag put it (not lost while there was no layout).
    for (const f of frames.slice(first)) expect([f.positions?.[0], f.positions?.[1]]).toEqual([X, Y]);
  }, 60_000);

  it("ignores a second start that lands mid-seed: one run, one LOD topology", async () => {
    const g = clustered(N);
    const run = startRun(g, 20, true);
    workers.push(run.worker);
    await run.waitFor(() => run.frames().length >= 1);
    expect(refinementStart(run.frames()), "the seed finished before the second start could land mid-seed").toBe(-1);
    run.send(run.start);
    await run.waitFor(() => run.frames().some((f) => f.type === "done"));
    await new Promise((r) => setTimeout(r, 300)); // room for a second run's messages to arrive
    // A second concurrent run would coarsen again and post its own topology, then share the first run's
    // module state (the cancel flag, the pending pin, the layout).
    expect(run.received.filter((r) => r.msg.type === "lod-topology").length).toBe(1);
    expect(run.frames().filter((f) => f.type === "done").length).toBe(1);
  }, 60_000);

  it("drops a pin released mid-seed: the run still settles with done", async () => {
    const g = clustered(N);
    const run = startRun(g, 20);
    workers.push(run.worker);
    await run.waitFor(() => run.frames().length >= 1);
    expect(refinementStart(run.frames())).toBe(-1);
    run.send({ type: "pin", ids: Uint32Array.of(0), positions: Float32Array.of(1e5, -1e5) });
    run.send({ type: "unpin" });
    await run.waitFor(() => run.frames().some((f) => f.type === "done"));
    // A pin left pending would hold the run in drag mode forever (no `done`).
    expect(run.frames().some((f) => f.type === "done")).toBe(true);
  }, 60_000);

  it("ends on a stop that lands mid-seed: no seed frame, no refinement", async () => {
    const g = clustered(N);
    const run = startRun(g, 20);
    workers.push(run.worker);
    await run.waitFor(() => run.frames().length >= 1);
    expect(refinementStart(run.frames())).toBe(-1);
    run.send({ type: "stop" });
    const stoppedAt = run.frames().length;
    await new Promise((r) => setTimeout(r, 1500)); // longer than the rest of this seed takes
    const after = run.frames().slice(stoppedAt);
    expect(after.length).toBeLessThanOrEqual(1); // at most the one posted before the stop landed
    expect(after.every((f) => f.tick === 0 && f.type === "frame")).toBe(true);
  }, 60_000);
});

describe("engine: each seed progress frame costs one repaint, LOD on and off (#368)", () => {
  it("draws each delivered frame with one lane emit — one LOD cut on the worker tree, or one full-detail emit", async () => {
    // Every frame the worker posts (progress, seed, refinement, done) funnels through the same coalesced
    // repaint: one rebuild, one lane emit. LOD ON: the emit runs one cut on the worker's tree
    // (InstancedLane.update → select → computeFrontier → cut), and the main thread never builds a tree.
    // LOD OFF: the emit is the full-detail draw, O(nodes + edges), exactly as for a refinement frame.
    // Both legs share one engine (a second WebGL engine after a large one stalls, #287).
    const delivered = { frames: 0, seedFrames: 0, lodSources: new Set<string>() };
    let net: ReturnType<typeof network> | null = null;
    class CountingWorker extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // Runs before the transport handles the message, so it sees the tree the frames before this one
        // were cut on. Not at the topology message: that still sees the tree `lod({})` built before the
        // layout started.
        this.addEventListener("message", (e: MessageEvent<WorkerToMain>) => {
          if (e.data.type === "lod-topology") return;
          delivered.frames++;
          if (e.data.type === "frame" && e.data.tick === 0) delivered.seedFrames++;
          if (net) delivered.lodSources.add(net.lodSource);
        });
      }
    }
    vi.stubGlobal("Worker", CountingWorker);
    const emits = vi.spyOn(InstancedLane.prototype, "update");
    const host = document.createElement("div");
    host.style.width = `${W}px`;
    host.style.height = `${H}px`;
    document.body.appendChild(host);
    const nextFrame = (): Promise<unknown> => new Promise((r) => requestAnimationFrame(() => r(null)));
    net = network(host, { width: W, height: H });
    try {
      await net.whenReady();
      net.data(clustered(N)).style({ sizeMode: "screen" });
      const run = async (engine: ReturnType<typeof network>): Promise<number> => {
        await nextFrame();
        delivered.frames = 0;
        delivered.seedFrames = 0;
        delivered.lodSources.clear();
        const before = emits.mock.calls.length;
        engine.layout({ backend: "worker", iterations: 20, fit: true });
        await engine.whenSettled();
        await nextFrame(); // the last coalesced repaint
        return emits.mock.calls.length - before;
      };
      for (const lod of [true, false]) {
        const leg = lod ? "LOD ON" : "LOD OFF";
        net.lod(lod ? {} : false);
        const laneEmits = await run(net);
        if (lod) {
          expect(net.lodSource).toBe("worker");
          // Never a main-thread tree (build + O(tree) geometry pass) at any point of the stream.
          expect([...delivered.lodSources].filter((s) => s !== "worker" && s !== "none"), leg).toEqual([]);
        } else expect([...delivered.lodSources], leg).toEqual(["none"]);
        expect(delivered.seedFrames, `${leg} non-vacuity: progress frames + the seed frame`).toBeGreaterThanOrEqual(2);
        expect(delivered.frames, `${leg} non-vacuity: progress frames + seed + refinement + done`).toBeGreaterThanOrEqual(4);
        // At most one repaint per delivered frame (coalesced per animation frame), plus layout()'s own
        // rebuild and the settle rebuild — each one lane emit.
        expect(laneEmits, leg).toBeGreaterThan(0);
        expect(laneEmits, `${leg}: ${laneEmits} lane emits for ${delivered.frames} frames`).toBeLessThanOrEqual(delivered.frames + 2);
      }
    } finally {
      emits.mockRestore();
      net.destroy();
      host.remove();
      vi.unstubAllGlobals();
    }
  }, 90_000);
});
