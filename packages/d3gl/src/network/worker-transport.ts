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
import type { Device } from "@luma.gl/core";
import { multilevelLayout, type CoarsenOptions } from "./coarsen.js";
import { ForceLayout, seedPositions, type ForceParams, type LayoutGraph } from "./force.js";
import type { ModuleSprings } from "./module-springs.js";
import { lodTreeFromTopology, type BoundaryDiscs, type LODTopology, type LODTree } from "./lod.js";
import type { FitBox } from "./fit.js";
import type { FlatModuleLinks, FlatModuleRecords } from "./module-topology.js";
import { nestedLayout, nestedBoundaryDiscs, nestedRootBounds, type NestedLayoutParams, type NestedLayoutTopology } from "./nested-layout.js";
import {
  lodGeometryViews,
  lodGeometryByteLength,
  transferList,
  type MainToWorker,
  type NestedPrepReply,
  type WorkerToMain,
} from "./worker-protocol.js";
import { nestedSolverTopology, type NestedSolverTopology } from "./gpu/nested-topology.js";
import { lodTreeFromSpatialFrame, type LeafStyle, type LODView, type SpatialFrameHeader } from "./lod-frame.js";

export interface WorkerLayoutOptions {
  width: number;
  height: number;
  iterations: number;
  force?: Partial<ForceParams>;
  coarsen?: CoarsenOptions;
  /** Seed via multilevel coarsening (default) or a plain disc cold start. */
  multilevel?: boolean;
  /** Fixed ticks per progress frame. Omitted (the default), the worker streams by time — about one
   *  frame per display frame, and one after any longer tick. */
  frameEvery?: number;
  /**
   * Build the structural LOD tree on the worker and stream it (#103). When set, the worker coarsens
   * once (reused for seeding), posts the tree topology via `onLODTree`, and refreshes its geometry
   * each frame — so the main thread never coarsens or runs the O(N) geometry pass. No effect on the
   * synchronous fallback (the caller builds the tree on the main thread there).
   */
  lod?: boolean;
  /**
   * Which tree to stream with `lod` (#343): `"structure"` (default) — the coarsening tree, posted once and
   * refit per frame — or `"spatial"`: a Morton tree rebuilt every streamed frame and handed to `onLODTree`
   * with each frame (its style already aggregated from {@link lodStyle}).
   */
  lodSource?: "structure" | "spatial";
  /** The leaf style a spatial stream aggregates per rebuild (#343), and its version (echoed per tree). */
  lodStyle?: LeafStyle;
  lodStyleVersion?: number;
  /** The view whose kept glyphs' super-edge rows a spatial stream builds with each tree (#433). */
  lodView?: LODView;
  /**
   * Continue the layout `graph.positions` holds instead of seeding one (#311): no disc, no multilevel
   * seed, and its heat schedule resumed — `cool(iterations, heat)` when it was decaying, else
   * `hold(heat)` — over `iterations`, the ticks it had left. `iterations: 0` starts the worker idle, alive
   * for a drag reheat. How a GPU layout goes on after its render backend is swapped away or its context is
   * lost. `multilevel` is ignored; `lod` still streams the tree. `recool`: the ticks are a re-cool's tail
   * after a drag, resumed as one (a pin then reheats at the drag heat at once).
   */
  warm?: { heat: number; decaying: boolean; recool?: boolean };
  /**
   * The module links as springs between their endpoints' member centroids (#455), for a graph whose module
   * hierarchy has module links: the run's refinement and every drag reheat pull along them too — on the
   * worker, its synchronous fallback, and the GPU solve.
   */
  moduleSprings?: ModuleSprings;
}

/**
 * A spatial tree streamed with a frame (#343): its header (the style version it was aggregated with, the
 * frame it was built for) and `release`, which hands its buffer back to the worker for reuse — call it once
 * nothing reads the tree any more (its arrays are detached after).
 */
export interface StreamedLODTree {
  header: SpatialFrameHeader;
  release: () => void;
}

export interface WorkerLayoutHandle {
  /**
   * Whether this run streams positions **zero-copy** via a `SharedArrayBuffer` (cross-origin-isolated
   * page) rather than per-frame postMessage copies. `false` in copy mode and on the synchronous
   * fallback (no live worker). Mirrors {@link sharedMemoryAvailable} for an active worker run. Read
   * live (#297): it turns `false` when a worker error falls back to a synchronous solve.
   */
  readonly shared: boolean;
  /**
   * Set by `startGpuLayout` only, read live (#297): `"pending"` while its device promise is unsettled,
   * then `"gpu"` (the GPU solve runs) or `"worker"` (it fell back to {@link startWorkerLayout}). Unset on
   * the worker transports' own handles, which always run the worker. {@link Network.layoutTransport}
   * reports `"gpu"` from it, and the engine's LOD guards treat a `"worker"` fallback as a worker run.
   */
  readonly transport?: "gpu" | "worker" | "pending";
  /**
   * `true` when the handle runs no layout transport at all — a main-thread position transition of an
   * already-computed layout (#328) — so {@link Network.layoutTransport} reports `"none"`.
   */
  mainThread?: boolean;
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
  /** Send a spatial LOD stream a new leaf style (#343, after `style()`); later frames aggregate it. Absent
   *  when the run streams no spatial tree. */
  setLODStyle?(style: LeafStyle, version: number): void;
  /** Send a spatial LOD stream the main thread's new view (#433); later trees carry the super-edge rows of its
   *  covers. Absent when the run streams no spatial tree. */
  setLODView?(view: LODView): void;
  /**
   * Set by `startGpuLayout` only (#311): the render backend that owns this layout's WebGL device is about
   * to be replaced — call it while that device is still alive. A GPU run stops and frees its GPU
   * resources now, then continues **warm** on whatever `next` resolves to (a GPU run on a new WebGL
   * device, else the CPU worker): from its last harvested positions, with the ticks left of its budget
   * and its current heat. A settled layout continues as an idle run, so a drag still reflows. The handle
   * stays the same object. No-op while the layout runs on the worker (not bound to a device) or waits
   * for a device.
   */
  moveDevice?(next: Promise<Device | null | undefined>): void;
}

/** Handle for the synchronous fallback (no live worker) — reheat is a no-op there. */
const NOOP_DRAG = { pin() {}, unpin() {} };

/**
 * The solver's view of `graph` with the module links as springs (#455) — `graph` itself without them. The view
 * shares the graph's arrays, positions included, so a solve on it writes the graph's positions: take it where
 * the solve starts, since `graph.positions` can be replaced (a shared-memory worker's view, #311).
 */
export function withModuleSprings(graph: NetworkGraph, moduleSprings: ModuleSprings | undefined): NetworkGraph & Pick<LayoutGraph, "moduleSprings"> {
  return moduleSprings ? { ...graph, moduleSprings } : graph;
}

/**
 * A handle for a layout that can start only once `ready` resolves (#428) — a nested layout waiting for
 * its module tree to be built off the main thread. `start` runs then, unless the handle was stopped
 * first; `settled` resolves when the started run settles, at once if `start` declines (returns null),
 * or on {@link WorkerLayoutHandle.stop}. It rejects with the error if `ready` rejects, if `start` throws,
 * or if the run's own `settled` rejects, so `whenSettled()` reports a failed start instead of never
 * settling. Pins reach the run once it is live, and so do its `shared`, `transport` and `mainThread`
 * reports: a copy-mode default until then, as `startGpuLayout`'s handle reports while it waits for
 * its device — with `waiting` as the transport meanwhile (`"pending"` for a GPU start, which the LOD
 * guards read as a streaming transport still resolving).
 */
export function deferredLayoutHandle<T>(ready: Promise<T>, start: (value: T) => WorkerLayoutHandle | null, waiting?: "pending"): WorkerLayoutHandle {
  let run: WorkerLayoutHandle | null = null;
  let stopped = false;
  let resolveSettled: () => void = () => {};
  let rejectSettled: (error: unknown) => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  void ready.then((value) => {
    if (stopped) return;
    try {
      run = start(value);
    } catch (error) {
      rejectSettled(error);
      return;
    }
    if (run) run.settled.then(resolveSettled, rejectSettled);
    else resolveSettled();
  }, rejectSettled);
  return {
    get shared() {
      return run?.shared ?? false;
    },
    get transport() {
      return run ? run.transport : waiting;
    },
    get mainThread() {
      return run?.mainThread;
    },
    settled,
    stop() {
      stopped = true;
      run?.stop();
      resolveSettled();
    },
    pin(ids, positions) {
      run?.pin(ids, positions);
    },
    unpin() {
      run?.unpin();
    },
    setLODStyle(style, version) {
      run?.setLODStyle?.(style, version);
    },
    setLODView(view) {
      run?.setLODView?.(view);
    },
    moveDevice(next) {
      run?.moveDevice?.(next);
    },
  };
}

/** A module tree being built on a worker ({@link buildModuleTopologyOffThread}). */
export interface ModuleTopologyJob {
  /** The built topology — or null when the worker failed (an error, or a message that could not be
   *  deserialized), so the caller builds it itself. Never settles once {@link cancel}led. */
  topology: Promise<LODTopology | null>;
  /** Stop the build and tear its worker down. */
  cancel(): void;
}

/** What {@link buildModuleTopologyOffThread} posts: the flat records and, when there are any, module links. */
export interface ModuleTopologyInput {
  records: FlatModuleRecords;
  links?: FlatModuleLinks;
}

/**
 * Build a module hierarchy's {@link LODTopology} on a Web Worker (#428), off the main thread — what
 * `buildModuleTopology(nodeCount, records, edges, links)` computes. Returns null, having run nothing, when
 * no worker can be created (no `Worker`, or its construction throws): the caller builds the tree itself,
 * synchronously. Otherwise `input` runs once the worker exists; its records and links are **transferred**
 * (the caller flattens them for this and must not use them afterwards), and the edge buffers are copied,
 * so the graph keeps its own. The main thread's share is that copy and the post; the tree's buffers come
 * back transferred, so receiving it costs no copy either.
 */
export function buildModuleTopologyOffThread(
  nodeCount: number,
  input: () => ModuleTopologyInput,
  edges: { source: Uint32Array; target: Uint32Array; weight: Float32Array },
): ModuleTopologyJob | null {
  if (typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  let resolveTopology: (topology: LODTopology | null) => void = () => {};
  const topology = new Promise<LODTopology | null>((resolve) => {
    resolveTopology = resolve;
  });
  const cancel = (): void => {
    worker.terminate();
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  };
  /** The worker cannot deliver the tree: tear it down and let the caller build it. */
  const fail = (): void => {
    cancel();
    resolveTopology(null);
  };
  worker.onmessage = (e: MessageEvent<WorkerToMain>): void => {
    const msg = e.data;
    if (msg.type !== "module-tree") return;
    cancel();
    resolveTopology(msg.topology);
  };
  worker.onerror = fail;
  worker.onmessageerror = fail; // the tree arrived but could not be deserialized
  let payload: ModuleTopologyInput;
  try {
    payload = input();
  } catch (error) {
    cancel(); // invalid records: no build, and no worker left behind
    throw error;
  }
  const { records, links } = payload;
  const message: MainToWorker = { type: "build-module-tree", nodeCount, records, links, source: edges.source, target: edges.target, weight: edges.weight };
  worker.postMessage(message, transferList([records.id, records.offset, records.entries, links?.sourceOffset, links?.source, links?.targetOffset, links?.target, links?.flow]));
  return { topology, cancel };
}

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

/**
 * A fresh layout worker, or null where none can run: no `Worker` (SSR), or the bundler / runtime cannot
 * construct one. Every layout worker starts here — the flat and nested worker layouts and the GPU layout's
 * LOD relay (#377) — because the URL is resolved relative to this module, which the published build keeps
 * next to `layout-worker.js`.
 */
export function spawnLayoutWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

export function startWorkerLayout(
  graph: NetworkGraph,
  opts: WorkerLayoutOptions,
  onFrame: () => void,
  /**
   * Called once when the worker streams the LOD tree (only when `opts.lod` is on and a real worker
   * runs). The tree's `cx`/`cy`/`extent` track the worker's layout live; the caller fills
   * `radius`/`weight` once via `computeLODStyle`. With `lodSource: "spatial"` it is called with every
   * frame that moved the layout, with the rebuilt tree (style aggregated) and its `streamed` handle (#343).
   */
  onLODTree?: (tree: LODTree, streamed?: StreamedLODTree) => void,
): WorkerLayoutHandle {
  const { width, height, iterations, warm, moduleSprings } = opts;
  const multilevel = opts.multilevel ?? true;
  const syncOpts = { width, height, iterations, force: opts.force, coarsen: opts.coarsen };

  /** Solve on this thread (converging early, like the worker): the fallback when no worker runs. */
  const solveHere = (): void => {
    // The solver's view of the graph, with its module springs (#455): read at solve time, since a worker
    // error lands here after `graph.positions` became the shared buffer's view.
    const solved = withModuleSprings(graph, moduleSprings);
    if (warm) {
      // Continue from the current positions on the handed-over schedule, until converged (#311).
      const layout = new ForceLayout(solved, opts.force);
      if (warm.decaying) layout.cool(iterations, warm.heat);
      else layout.hold(warm.heat);
      for (let t = 0; t < iterations; t++) {
        layout.tick();
        if (layout.converged) break;
      }
    } else if (multilevel) multilevelLayout(solved, syncOpts);
    else {
      seedPositions(solved, width, height, { force: opts.force });
      new ForceLayout(solved, opts.force).run(iterations, "hot"); // a cold start untangles at full heat
    }
  };
  // No Worker available (SSR / unsupported) or construction fails: solve synchronously so the
  // layout still happens, then signal one frame + completion. LOD (if requested) is left to the
  // caller's main-thread path — `onLODTree` is never called in the fallback.
  const fallback = (): WorkerLayoutHandle => {
    solveHere();
    onFrame();
    return { shared: false, settled: Promise.resolve(), stop() {}, ...NOOP_DRAG };
  };
  const worker = spawnLayoutWorker();
  if (!worker) return fallback();

  // Give the very first paint a spread disc instead of a pile at the origin while the worker's seed
  // frame is in flight — at the force model's equilibrium scale, the scale that seed arrives at, so
  // a fitted view doesn't jump. NetworkGraph satisfies the force core's LayoutGraph view. A warm start
  // continues the positions already on screen (#311).
  if (!warm) seedPositions(graph, width, height, { force: opts.force });

  // Live (#297): a worker error below falls back to a synchronous solve, after which no worker shares it.
  let shared = sharedMemoryAvailable();
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
      if (!sharedGeometry) {
        lodGeomFlat = new Float32Array(buffer);
        if (msg.geometry) lodGeomFlat.set(msg.geometry); // a warm start's geometry, before the tree is drawn (#311)
      }
      onLODTree?.(lodTreeFromTopology(topology, lodGeometryViews(buffer, topology.size)));
      return;
    }
    if (msg.type === "lod-geometry" || msg.type === "seed-plan" || msg.type === "module-tree") return; // only the GPU layout's coarsening worker (#377, #353) or a module-tree build (#428) sends these
    // frame | done
    if (msg.positions && !shared) graph.positions.set(msg.positions);
    if (msg.geometry && lodGeomFlat) lodGeomFlat.set(msg.geometry); // copy-mode geometry snapshot
    const frame = msg.lodFrame;
    if (frame) {
      // A spatial tree rebuilt for this frame (#343): hand it over with a way to return its buffer.
      let released = false;
      const release = (): void => {
        if (released || terminated) return;
        released = true;
        const rows = frame.rows?.buffer;
        const back: MainToWorker = { type: "lod-recycle", buffer: frame.buffer, rows };
        worker.postMessage(back, rows ? [frame.buffer, rows] : [frame.buffer]);
      };
      if (onLODTree) onLODTree(lodTreeFromSpatialFrame(frame), { header: frame.header, release });
      else release();
    }
    onFrame();
    // `done` = the layout (initial run, or a drag re-cool) reached rest. Resolve `settled` the first
    // time; keep the worker alive either way so a later drag can reheat it.
    if (msg.type === "done") settle();
  };
  worker.onerror = (): void => {
    if (terminated) return;
    // Worker failed mid-run — fall back to a synchronous solve so the user still gets a layout.
    shared = false;
    solveHere();
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
    frameEvery: opts.frameEvery,
    lod: opts.lod,
    lodSource: opts.lodSource,
    lodStyle: opts.lodStyle,
    lodStyleVersion: opts.lodStyleVersion,
    lodView: opts.lodView,
    // Copy mode clones the positions into the message (at post time); shared mode carried them into the SAB.
    warm: warm && { ...warm, ...(shared ? {} : { positions: graph.positions }) },
    ...(moduleSprings ? { moduleSprings } : {}),
  };
  worker.postMessage(start);

  return {
    get shared() { return shared; },
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
    setLODStyle: opts.lod && opts.lodSource === "spatial"
      ? (style: LeafStyle, version: number) => {
          if (terminated) return;
          const msg: MainToWorker = { type: "lod-style", style, version };
          worker.postMessage(msg);
        }
      : undefined,
    setLODView: opts.lod && opts.lodSource === "spatial"
      ? (view: LODView) => {
          if (terminated) return;
          const msg: MainToWorker = { type: "lod-view", view };
          worker.postMessage(msg);
        }
      : undefined,
  };
}

/** How {@link startNestedWorkerLayout} delivers the layout (#328). */
export interface NestedWorkerOptions {
  /** Post a frame per finished depth, top modules first (default `true`); else only the final layout. */
  stream?: boolean;
  /**
   * Receive the final positions instead of having them copied into `graph.positions` (no `onFrame`
   * for them) — for a caller that eases to them (#328). Implies `stream: false`.
   */
  onResult?: (positions: Float32Array) => void;
  /** Receive the final layout's module boundary discs (#329), just before its positions land. */
  onBoundaries?: (discs: BoundaryDiscs) => void;
  /**
   * Receive the streamed layout's bound on its final extent (#427), for a streaming fit to frame the map on:
   * the root disc ({@link nestedRootBounds}) synchronously when a cold stream starts, then each depth's
   * tighter bound (the `bounds` of `nestedLayout`'s `onDepth`) just before that depth's positions land.
   * Never called for a solve that lands in one frame (warm, `stream: false` or `onResult`), nor by the
   * main-thread fallback, whose layout lands at once.
   */
  onBounds?: (bounds: FitBox) => void;
}

/**
 * Run the nested module layout (#324) off-thread: the worker streams one frame per finished depth (top
 * modules first), each copied into `graph.positions` — or, per `opts`, posts only the final layout,
 * optionally handed to `opts.onResult` instead (#328). Falls back to a synchronous main-thread solve
 * when Workers are unavailable. The worker exits with the layout — there is no reheat (drag is
 * translate-only on a nested layout, as on caller-supplied positions).
 */
export function startNestedWorkerLayout(
  graph: NetworkGraph,
  tree: NestedLayoutTopology,
  params: NestedLayoutParams,
  onFrame: () => void,
  opts: NestedWorkerOptions = {},
): WorkerLayoutHandle {
  const { onResult, onBoundaries } = opts;
  /** The final positions (and the discs, #329): to the caller, or into the graph + a repaint. */
  const land = (positions: Float32Array, discs: BoundaryDiscs | undefined): void => {
    if (discs) onBoundaries?.(discs);
    if (onResult) onResult(positions);
    else {
      graph.positions.set(positions);
      onFrame();
    }
  };
  /** Solve on this thread: a fallback when no worker runs. */
  const solveHere = (): void => {
    const result = nestedLayout(tree, params);
    land(result.positions, onBoundaries ? nestedBoundaryDiscs(tree, result) : undefined);
  };
  const fallback = (): WorkerLayoutHandle => {
    solveHere();
    return { shared: false, settled: Promise.resolve(), stop() {}, ...NOOP_DRAG };
  };
  const worker = spawnLayoutWorker();
  if (!worker) return fallback();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  let terminated = false;
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    worker.terminate();
    // The handlers close over the topology and params (a warm start's `initial`, #328): drop them, so a
    // finished layout's handle — kept until the next layout() — holds no per-node memory.
    worker.onmessage = null;
    worker.onerror = null;
    resolveSettled();
  };
  worker.onmessage = (e: MessageEvent<WorkerToMain>): void => {
    const msg = e.data;
    if (msg.type === "lod-topology" || msg.type === "lod-geometry" || msg.type === "seed-plan" || msg.type === "module-tree" || terminated) return;
    if (msg.type === "done") {
      if (msg.positions) land(msg.positions, msg.boundaries);
      terminate();
      return;
    }
    if (msg.bounds) opts.onBounds?.(msg.bounds);
    if (msg.positions) graph.positions.set(msg.positions);
    onFrame();
  };
  worker.onerror = (): void => {
    if (terminated) return;
    solveHere();
    terminate();
  };
  // Clone only the topology the layout reads — not the LOD tree's geometry/style arrays.
  const topology: NestedLayoutTopology = {
    size: tree.size,
    leafCount: tree.leafCount,
    childOffset: tree.childOffset,
    children: tree.children,
    parent: tree.parent,
    superEdgeOffset: tree.superEdgeOffset,
    superEdgeTarget: tree.superEdgeTarget,
    superEdgeFlow: tree.superEdgeFlow,
  };
  const start: MainToWorker = { type: "start-nested", topology, params, stream: (opts.stream ?? true) && !onResult };
  worker.postMessage(start);
  // A streamed cold solve's first bound (#427): its root disc, known before the worker places a depth, so a
  // fit frames the map from its first paint and only zooms in as the depths' own bounds arrive. A warm
  // solve streams no depths (nestedLayout's rule), and a one-frame solve lands exact.
  if (start.stream && !params.initial) opts.onBounds?.(nestedRootBounds(tree.leafCount, params.radius));
  return {
    shared: false,
    settled,
    stop() {
      terminate();
    },
    ...NOOP_DRAG,
  };
}

/** A pending {@link prepareNestedSolve}: its result, and `cancel` (terminates the worker; the promise never settles). */
export interface NestedPrep {
  readonly solver: Promise<NestedSolverTopology>;
  cancel(): void;
}

/**
 * Build the batched GPU nested layout's solve data (#355, `nestedSolverTopology`) in a layout worker, so
 * the main thread spends nothing on it (150 ms at 325k leaves, 450 ms at 1M, measured in Node): one
 * `nested-prep` message, one reply with its arrays transferred, then the worker exits. Falls back to
 * building it here, in a later task, when Workers are unavailable or the worker fails.
 */
export function prepareNestedSolve(tree: NestedLayoutTopology, params: NestedLayoutParams): NestedPrep {
  let cancelled = false;
  let worker: Worker | null = null;
  const here = (): Promise<NestedSolverTopology> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        if (cancelled) return;
        try {
          resolve(nestedSolverTopology(tree, params));
        } catch (error) {
          reject(error);
        }
      }, 0);
    });
  const solver = new Promise<NestedSolverTopology>((resolve, reject) => {
    if (typeof Worker === "undefined") {
      here().then(resolve, reject);
      return;
    }
    try {
      worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
    } catch {
      here().then(resolve, reject);
      return;
    }
    const w = worker;
    const done = (): void => {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    };
    w.onmessage = (e: MessageEvent<NestedPrepReply>): void => {
      done();
      if (!cancelled) resolve(e.data.solver);
    };
    w.onerror = (): void => {
      done();
      if (!cancelled) here().then(resolve, reject);
    };
    // Clone only the topology the prep reads — not the LOD tree's geometry/style arrays.
    const topology: NestedLayoutTopology = {
      size: tree.size,
      leafCount: tree.leafCount,
      childOffset: tree.childOffset,
      children: tree.children,
      parent: tree.parent,
      superEdgeOffset: tree.superEdgeOffset,
      superEdgeTarget: tree.superEdgeTarget,
      superEdgeFlow: tree.superEdgeFlow,
    };
    const message: MainToWorker = { type: "nested-prep", topology, params };
    w.postMessage(message);
  });
  return {
    solver,
    cancel() {
      cancelled = true;
      worker?.terminate();
    },
  };
}
