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
  /**
   * Whether this run streams positions **zero-copy** via a `SharedArrayBuffer` (cross-origin-isolated
   * page) rather than per-frame postMessage copies. `false` in copy mode and on the synchronous
   * fallback (no live worker). Mirrors {@link sharedMemoryAvailable} for an active worker run.
   */
  shared: boolean;
  /**
   * `"gpu"` when the handle was created by `startGpuLayout` and the GPU path was successfully taken
   * (a real WebGL device was available). `undefined` for worker and synchronous-fallback handles.
   * Used by {@link Network.layoutTransport} to distinguish a real GPU run from a silent worker fallback.
   */
  transport?: "gpu";
  /** Resolves when the layout first converges or is stopped. The worker stays **alive** after
   *  convergence (idle, not terminated) so a node-drag can reheat it (#140); only {@link stop} tears it down. */
  settled: Promise<void>;
  /** Cancel the run and tear the worker down (resolves `settled`). */
  stop(): void;
  /**
   * Hold `ids` and reheat the layout so the rest reflows around them (#140). In copy mode pass the
   * held nodes' `positions` (interleaved `[x, y, …]` in `ids` order); in shared mode write them into
   * the position SAB instead and omit `positions`. No-op on the synchronous fallback (no live worker).
   */
  pin(ids: Uint32Array, positions?: Float32Array): void;
  /** Release every pin and let the layout re-cool, then idle (#140). No-op on the fallback. */
  unpin(): void;
}

/** Handle for the synchronous fallback (no live worker) — reheat is a no-op there. */
const NOOP_DRAG = { pin() {}, unpin() {} };

const TARGET_FRAMES = 60;

/**
 * Whether this environment can use the `SharedArrayBuffer` zero-copy position transport: `SharedArrayBuffer`
 * exists and the page is cross-origin isolated (served with `Cross-Origin-Opener-Policy: same-origin` +
 * `Cross-Origin-Embedder-Policy: require-corp`). When false, the worker posts per-frame position snapshots
 * instead. This reports the environment's *capability*; whether a given run actually used it is
 * {@link WorkerLayoutHandle.shared} (they differ when the worker is unavailable and the layout falls back
 * to a synchronous main-thread solve).
 */
export function sharedMemoryAvailable(): boolean {
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
    return { shared: false, settled: Promise.resolve(), stop() {}, ...NOOP_DRAG };
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

  const shared = sharedMemoryAvailable();
  let sharedPositions: SharedArrayBuffer | undefined;
  if (shared) {
    sharedPositions = new SharedArrayBuffer(graph.nodeCount * 2 * Float32Array.BYTES_PER_ELEMENT);
    const view = new Float32Array(sharedPositions);
    view.set(graph.positions); // carry over the seed
    graph.positions = view; // renderer now reads the shared buffer live
  }

  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  // `settled` resolves once (initial convergence); the worker then stays ALIVE, idle, so a node-drag
  // can reheat it (#140). `terminate` is the real teardown (stop / worker error); it also settles.
  let terminated = false;
  let settledOnce = false;
  const settle = (): void => { if (settledOnce) return; settledOnce = true; resolveSettled(); };
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    worker.terminate();
    settle();
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
    // `done` = the layout (initial run, or a drag re-cool) reached rest. Resolve `settled` the first
    // time; keep the worker alive either way so a later drag can reheat it.
    if (msg.type === "done") settle();
  };
  worker.onerror = (): void => {
    if (terminated) return;
    // Worker failed mid-run — fall back to a synchronous solve so the user still gets a layout.
    if (multilevel) multilevelLayout(graph, syncOpts);
    else {
      seedPositions(graph, width, height);
      new ForceLayout(graph, opts.force).run(iterations);
    }
    onFrame();
    terminate();
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
    shared,
    settled,
    stop() {
      if (terminated) return;
      const stop: MainToWorker = { type: "stop" };
      worker.postMessage(stop);
      terminate();
    },
    pin(ids: Uint32Array, positions?: Float32Array) {
      if (terminated) return;
      // Shared mode: the main thread already wrote the held positions into the SAB the worker reads,
      // so send only the ids. Copy mode: the worker has its own buffer — send the positions too.
      const pin: MainToWorker = shared ? { type: "pin", ids } : { type: "pin", ids, positions };
      worker.postMessage(pin);
    },
    unpin() {
      if (terminated) return;
      const unpin: MainToWorker = { type: "unpin" };
      worker.postMessage(unpin);
    },
  };
}
