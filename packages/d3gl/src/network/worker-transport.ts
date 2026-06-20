/**
 * Main-thread controller for the layout Web Worker (sub-issue #102, epic #98).
 *
 * Spawns the worker, picks the position transport at runtime — SharedArrayBuffer zero-copy on a
 * cross-origin-isolated page, transferable-free postMessage copies otherwise — and repaints via the
 * supplied callback on each progress frame. Degrades to a synchronous main-thread solve when Web
 * Workers are unavailable (SSR) or the bundler/runtime can't construct one.
 */
import type { NetworkGraph } from "./graph.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import type { MainToWorker, WorkerToMain } from "./worker-protocol.js";

export interface WorkerLayoutOptions {
  width: number;
  height: number;
  iterations: number;
  force?: Partial<ForceParams>;
  coarsen?: CoarsenOptions;
  /** Seed via multilevel coarsening (default) or a plain disc cold start. */
  multilevel?: boolean;
  /** Ticks per progress frame; defaults to ~60 frames across the run. */
  frameEvery?: number;
}

export interface WorkerLayoutHandle {
  /** Resolves when the layout converges or is stopped. */
  settled: Promise<void>;
  /** Cancel the run and tear the worker down (resolves `settled`). */
  stop(): void;
}

const TARGET_FRAMES = 60;

/** Whether SharedArrayBuffer zero-copy transport is usable (cross-origin-isolated page). */
function canShareMemory(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
}

export function startWorkerLayout(
  graph: NetworkGraph,
  opts: WorkerLayoutOptions,
  onFrame: () => void,
): WorkerLayoutHandle {
  const { width, height, iterations } = opts;
  const multilevel = opts.multilevel ?? true;
  const frameEvery = opts.frameEvery ?? Math.max(1, Math.ceil(iterations / TARGET_FRAMES));
  const syncOpts = { width, height, iterations, force: opts.force, coarsen: opts.coarsen };

  // No Worker available (SSR / unsupported) or construction fails: solve synchronously so the
  // layout still happens, then signal one frame + completion.
  const fallback = (): WorkerLayoutHandle => {
    if (multilevel) multilevelLayout(graph, syncOpts);
    else {
      seedPositions(graph, width, height);
      new ForceLayout(graph, opts.force).run(iterations);
    }
    onFrame();
    return { settled: Promise.resolve(), stop() {} };
  };
  if (typeof Worker === "undefined") return fallback();

  let worker: Worker;
  try {
    worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
  } catch {
    return fallback();
  }

  // Give the very first paint a spread disc instead of a pile at the origin while the worker's seed
  // frame is in flight. NetworkGraph satisfies the force core's LayoutGraph view.
  seedPositions(graph, width, height);

  const shared = canShareMemory();
  let sharedPositions: SharedArrayBuffer | undefined;
  if (shared) {
    sharedPositions = new SharedArrayBuffer(graph.nodeCount * 2 * Float32Array.BYTES_PER_ELEMENT);
    const view = new Float32Array(sharedPositions);
    view.set(graph.positions); // carry over the seed
    graph.positions = view; // renderer now reads the shared buffer live
  }

  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    worker.terminate();
    resolveSettled();
  };

  worker.onmessage = (e: MessageEvent<WorkerToMain>): void => {
    const msg = e.data;
    if (msg.positions && !shared) graph.positions.set(msg.positions);
    onFrame();
    if (msg.type === "done") finish();
  };
  worker.onerror = (): void => {
    if (finished) return;
    // Worker failed mid-run — fall back to a synchronous solve so the user still gets a layout.
    if (multilevel) multilevelLayout(graph, syncOpts);
    else {
      seedPositions(graph, width, height);
      new ForceLayout(graph, opts.force).run(iterations);
    }
    onFrame();
    finish();
  };

  const start: MainToWorker = {
    type: "start",
    nodeCount: graph.nodeCount,
    source: graph.source,
    target: graph.target,
    weight: graph.weight,
    sharedPositions,
    width,
    height,
    iterations,
    force: opts.force,
    coarsen: opts.coarsen,
    multilevel,
    frameEvery,
  };
  worker.postMessage(start);

  return {
    settled,
    stop() {
      if (finished) return;
      const stop: MainToWorker = { type: "stop" };
      worker.postMessage(stop);
      finish();
    },
  };
}
