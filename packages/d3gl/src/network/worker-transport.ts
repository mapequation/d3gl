/**
 * Main-thread controller for the layout Web Worker (sub-issue #102, epic #98).
 *
 * Spawns the worker, picks the position transport at runtime — SharedArrayBuffer zero-copy on a
 * cross-origin-isolated page, transferable-free postMessage copies otherwise — and repaints via the
 * supplied callback on each progress frame. Degrades to a synchronous main-thread solve when Web
 * Workers are unavailable (SSR) or the bundler/runtime can't construct one.
 *
 * With `lod` on (#103) the worker also builds the structural LOD tree and streams it: the topology
 * once (→ `onLODTree`), then position-derived geometry each frame (shared via a SAB, or copied per
 * frame here). The main thread then never coarsens or runs the O(N) geometry pass.
 */
import type { NetworkGraph } from "./graph.js";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { ForceLayout, seedPositions, type ForceParams } from "./force.js";
import { lodTreeFromTopology, type LODTree } from "./lod.js";
import { lodGeometryViews, lodGeometryByteLength, type MainToWorker, type WorkerToMain } from "./worker-protocol.js";

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
  /**
   * Build the structural LOD tree on the worker and stream it (#103). When set, the worker coarsens
   * once (reused for seeding), posts the tree topology via `onLODTree`, and refreshes its geometry
   * each frame — so the main thread never coarsens or runs the O(N) geometry pass. No effect on the
   * synchronous fallback (the caller builds the tree on the main thread there).
   */
  lod?: boolean;
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
  /**
   * Called once when the worker streams the LOD tree (only when `opts.lod` is on and a real worker
   * runs). The tree's `cx`/`cy`/`extent` track the worker's layout live; the caller fills
   * `radius`/`weight` once via `computeLODStyle`.
   */
  onLODTree?: (tree: LODTree) => void,
): WorkerLayoutHandle {
  const { width, height, iterations } = opts;
  const multilevel = opts.multilevel ?? true;
  const frameEvery = opts.frameEvery ?? Math.max(1, Math.ceil(iterations / TARGET_FRAMES));
  const syncOpts = { width, height, iterations, force: opts.force, coarsen: opts.coarsen };

  // No Worker available (SSR / unsupported) or construction fails: solve synchronously so the
  // layout still happens, then signal one frame + completion. LOD (if requested) is left to the
  // caller's main-thread path — `onLODTree` is never called in the fallback.
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

  // Copy-mode only: the full `[cx, cy, extent]` buffer backing the LOD tree, refilled each frame from
  // the message. In shared mode the tree is bound straight to the worker's geometry SAB (no copy).
  let lodGeomFlat: Float32Array | null = null;

  worker.onmessage = (e: MessageEvent<WorkerToMain>): void => {
    const msg = e.data;
    if (msg.type === "lod-topology") {
      const { topology, sharedGeometry } = msg;
      const buffer: ArrayBufferLike = sharedGeometry ?? new ArrayBuffer(lodGeometryByteLength(topology.size));
      if (!sharedGeometry) lodGeomFlat = new Float32Array(buffer);
      onLODTree?.(lodTreeFromTopology(topology, lodGeometryViews(buffer, topology.size)));
      return;
    }
    // frame | done
    if (msg.positions && !shared) graph.positions.set(msg.positions);
    if (msg.geometry && lodGeomFlat) lodGeomFlat.set(msg.geometry); // copy-mode geometry snapshot
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
    lod: opts.lod,
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
