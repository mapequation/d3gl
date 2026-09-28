/**
 * GPU-backed layout handle — mirrors {@link startWorkerLayout}'s call shape and return type so
 * `network.ts` treats both symmetrically. Falls back to the worker path when the GPU path is
 * unavailable for the device or the graph (#351): no device (Canvas/SVG render backend, SSR), no float
 * render targets, no float blending, a texture limit too small for the graph, or a failed functional
 * probe (`gpuLayoutSupport` over `gpuCaps`). The fallback is a full worker run: it keeps every layout
 * option (`multilevel`, `lod`, `coarsen`, `frameEvery`) and streams the LOD tree through `onLODTree`,
 * exactly as `layout({ backend: "worker" })` would (#312), and one `console.warn` names the reason.
 * `layout({ backend: "auto" })` (#375) runs the same code with {@link GpuLayoutOptions.warnUnsupported}
 * off: there the worker is an expected outcome, so an unsupported device or graph falls back silently.
 *
 * The GPU run seeds with a **multilevel seed** unless `multilevel: false` (#312, #353): from the module tree
 * when one is provided (N8.2, #180), else from the graph's coarsening hierarchy, which a layout worker builds
 * (heavy-edge matching, the worker backend's own seed) while this thread builds the solver. The seed runs on
 * the one GPU solver, level by level, inside the streamed frame loop (see {@link GpuStream}), with every
 * level at the force equilibrium's scale; a seeded run then cools over the iteration budget like the worker
 * (#124). With `multilevel: false`, an edge-less graph or no worker, it starts cold from a disc at the
 * equilibrium's scale, at full heat. It streams through {@link GpuStream} (#352):
 * each animation frame harvests positions a fenced PBO copy delivered, repaints (throttled, in the same
 * frame), and encodes as many work items — tick prep, force-pass row bands, integrate — as fit a GPU
 * budget of `min(10 ms, 0.6 × the frame interval)`. The main thread never waits for the GPU: no
 * synchronous `readPixels` on the frame path. On convergence the loop goes **idle** (the solver stays
 * alive) and `pin`/`unpin` hold nodes and resume it so the rest reflows (#183), as on the worker.
 *
 * With `lod` on, the GPU run keeps the LOD tree off the main thread as the worker
 * backend does (#377): a layout worker coarsens the graph (`coarsen`) while the solver is built, and refits
 * the tree's geometry to every harvested frame before it is painted ({@link LODRelay}); the tree reaches
 * `onLODTree` once, with geometry, and `onLODTree(null)` withdraws it if that worker fails (the caller then
 * builds its own). The same worker builds the multilevel seed's plan from the same coarsening, so the graph
 * is coarsened once.
 */
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { gpuLayoutNeed, gpuLayoutSupport } from "./device-caps.js";
import { gpuCaps } from "./device-probe.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { GpuStream } from "./gpu-stream.js";
import { moduleSeedPlan, type SeedPlan, type SeedPlanOptions } from "./seed-plan.js";
import { SeedWorker } from "./seed-worker.js";
import { LODRelay, type SeedRequest } from "./lod-relay.js";
import { spawnLayoutWorker, startWorkerLayout, type WorkerLayoutHandle, type WorkerLayoutOptions } from "../worker-transport.js";
import { seedPositions, DEFAULT_FORCE } from "../force.js";
import type { LODTopology, LODTree } from "../lod.js";
import type { NetworkGraph } from "../graph.js";

/**
 * GPU layout options — the worker options plus an optional provided module hierarchy (N8.2). When
 * present (and it carries super-edges), the GPU backend's multilevel seed is **module-aware**, laying the
 * layout out top-down over the module tree so modules read as coherent regions; otherwise it seeds from the
 * graph's coarsening. The worker options are all honoured, by the GPU run and by the worker fallback.
 */
export interface GpuLayoutOptions extends WorkerLayoutOptions {
  /** The provided module tree topology (from `lod({ modules })`), for the module-aware multilevel seed. */
  moduleTopology?: LODTopology;
  /**
   * Warn when the device or the graph is unsupported and the layout falls back to the worker (default
   * `true`: `layout({ backend: "gpu" })` asked for the GPU). `layout({ backend: "auto" })` passes `false`
   * (#375), because there the worker is an expected outcome. A GPU run that fails rather than being
   * unsupported (its device promise rejects, or it throws while starting) warns either way, with the error.
   */
  warnUnsupported?: boolean;
}

/** The transport a GPU layout resolved to: the GPU solve, or the worker fallback. */
export type GpuLayoutTransport = "gpu" | "worker";

/**
 * Start a GPU-accelerated layout run. Returns a {@link WorkerLayoutHandle}-shaped object so the
 * engine treats it identically to the worker backend. `onFrame` runs inside the transport's animation
 * frame, right after positions reached the graph and at most once per frame, so a caller may repaint
 * synchronously there (the transport times it to size its repaint throttle); the worker fallback calls it
 * per worker message. `onLODTree` gets the LOD tree streamed by a worker — the fallback's, or with `lod` on
 * the GPU run's LOD worker (#377) — and, from the GPU run only, `null` if that worker fails.
 *
 * Accepts a `Device | null | Promise<Device | null>` so `network.ts` can pass a **device promise**
 * that resolves after the backend settles (including the `"auto"` → WebGL background upgrade).
 * When passed a plain `Device | null` value it resolves synchronously.
 *
 * - If `gpuLayoutSupport` rejects the device for this graph → one warning with the reason (none with
 *   `warnUnsupported: false`), then {@link startWorkerLayout} with the same options and `onLODTree` (it
 *   has its own sync fallback).
 * - Otherwise: seeds a disc (on screen until the multilevel seed's first frame), constructs
 *   {@link GpuForceLayout}, starts the seed's coarsening worker, and streams the run ({@link GpuStream})
 *   until `iterations` are done; `settled` resolves once the final positions have been harvested.
 *
 * `onTransport` reports the resolution before the run starts — so before any frame or LOD tree
 * arrives — and the handle's `transport` / `shared` read the live state (#297): `"pending"` until the
 * device settles, then `"gpu"` or `"worker"`.
 */
export function startGpuLayout(
  deviceOrPromise: Device | null | undefined | Promise<Device | null | undefined>,
  graph: NetworkGraph,
  opts: GpuLayoutOptions,
  onFrame: () => void,
  onLODTree?: (tree: LODTree | null) => void,
  onTransport?: (transport: GpuLayoutTransport) => void,
): WorkerLayoutHandle {
  if (!(deviceOrPromise instanceof Promise)) {
    return startGpuLayoutSync(deviceOrPromise, graph, opts, onFrame, onLODTree, onTransport);
  }

  // Async path: the device resolves later (e.g. after the "auto" → WebGL upgrade).
  // Return a wrapper handle synchronously; resolve it once the device promise settles.
  if (graph.nodeCount === 0) {
    onFrame();
    return { shared: false, settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} };
  }

  let stopped = false;
  let inner: WorkerLayoutHandle | null = null;

  let resolveSettled: () => void = () => {};
  let rejectSettled: (e: unknown) => void = () => {};
  const settled = new Promise<void>((res, rej) => { resolveSettled = res; rejectSettled = rej; });

  const wrapper: WorkerLayoutHandle = {
    // Live (#297): whatever the resolved run reports now, not a value copied when it started.
    get shared() { return inner?.shared ?? false; },
    get transport() { return inner ? inner.transport : "pending"; },
    settled,
    stop() {
      if (stopped) return;
      stopped = true;
      if (inner) {
        inner.stop();
      } else {
        // stopped before the device resolved — nothing to tear down, just settle
        resolveSettled();
      }
    },
    pin(ids: Uint32Array, positions?: Float32Array) { inner?.pin(ids, positions); },
    unpin() { inner?.unpin(); },
  };

  const adopt = (handle: WorkerLayoutHandle): void => {
    inner = handle;
    handle.settled.then(resolveSettled, rejectSettled);
  };
  deviceOrPromise.then(
    (device) => {
      if (!stopped) adopt(startGpuLayoutSync(device, graph, opts, onFrame, onLODTree, onTransport));
    },
    (e: unknown) => {
      if (!stopped) adopt(fallBackToWorker("the device promise rejected", graph, opts, onFrame, onLODTree, onTransport, { cause: e }));
    },
  ).catch((e: unknown) => {
    // The GPU run failed to start (e.g. a driver rejected a shader): the worker still lays it out.
    if (!stopped && !inner) adopt(fallBackToWorker("the GPU layout failed to start", graph, opts, onFrame, onLODTree, onTransport, { cause: e }));
  });

  return wrapper;
}

/**
 * The fallback: a worker run with the GPU layout's options and LOD-tree callback, reported as the
 * `"worker"` transport. `shared` reads the worker handle live (it flips on a worker error, #297). It
 * warns once with `reason`: always for a `failure` (the device promise rejected or the GPU run threw,
 * passing the error when there is one), and for an unsupported device or graph unless the caller expects
 * the fallback (`warnUnsupported: false`). The call site says which it is, never the error value: a
 * rejection or throw with `undefined` is still a failure.
 */
function fallBackToWorker(
  reason: string,
  graph: NetworkGraph,
  opts: GpuLayoutOptions,
  onFrame: () => void,
  onLODTree: ((tree: LODTree | null) => void) | undefined,
  onTransport: ((transport: GpuLayoutTransport) => void) | undefined,
  failure?: { cause: unknown },
): WorkerLayoutHandle {
  const message = `[d3gl] the GPU network layout fell back to the CPU worker: ${reason}.`;
  if (failure) {
    if (failure.cause === undefined) console.warn(message);
    else console.warn(message, failure.cause);
  } else if (opts.warnUnsupported !== false) {
    console.warn(message);
  }
  onTransport?.("worker");
  const worker = startWorkerLayout(graph, opts, onFrame, onLODTree);
  return {
    get shared() { return worker.shared; },
    transport: "worker",
    settled: worker.settled,
    stop: () => worker.stop(),
    pin: (ids, positions) => worker.pin(ids, positions),
    unpin: () => worker.unpin(),
  };
}

/**
 * Synchronous variant: accepts a resolved `Device | null | undefined` value, decides GPU vs worker
 * for this graph, and starts that run.
 */
function startGpuLayoutSync(
  device: Device | null | undefined,
  graph: NetworkGraph,
  opts: GpuLayoutOptions,
  onFrame: () => void,
  onLODTree: ((tree: LODTree | null) => void) | undefined,
  onTransport: ((transport: GpuLayoutTransport) => void) | undefined,
): WorkerLayoutHandle {
  const verdict = gpuLayoutSupport(gpuCaps(device), gpuLayoutNeed(graph.nodeCount, graph.edgeCount));
  if (!verdict.ok || !device) {
    // (`!device` never reaches here with `ok`: no device has no caps, which never pass.)
    return fallBackToWorker(verdict.ok ? "no WebGL device" : verdict.reason, graph, opts, onFrame, onLODTree, onTransport);
  }
  // gpuLayoutSupport passed, so this is a WebGL2 device: the streaming readback needs its raw context.
  if (!(device instanceof WebGLDevice)) {
    return fallBackToWorker("no WebGL2 device", graph, opts, onFrame, onLODTree, onTransport);
  }

  // 0-node graph: GpuForceLayout would create a zero-height texture (crash).
  // Return a no-op handle immediately — there is nothing to lay out.
  if (graph.nodeCount === 0) {
    onTransport?.("gpu");
    onFrame();
    return { shared: false, transport: "gpu", settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} };
  }

  const { width, height, force, iterations: rawIterations } = opts;
  const iterations = rawIterations ?? 300;

  // The multilevel seed (#312, #353): from the provided module tree when there is one (its plan is built
  // here, as the module seed always was), else from the graph's coarsening, which a layout worker builds —
  // the LOD relay's worker with LOD on (one coarsening for the tree and the seed), else a seed-only worker.
  const multilevel = (opts.multilevel ?? true) && graph.edgeCount > 0;
  const planOptions: SeedPlanOptions = { width, height, ...(force ? { force } : {}) };
  const modulePlan = multilevel && opts.moduleTopology ? moduleSeedPlan(opts.moduleTopology, graph, planOptions) : null;
  const coarsenSeed = multilevel && !modulePlan;
  // The worker's plan may only be handed to the stream once it exists; a reply is a later task, so this
  // buffers nothing in practice, but it keeps the order explicit.
  let stream: GpuStream | null = null;
  let earlyPlan: SeedPlan | null | undefined;
  const seedRequest: SeedRequest = {
    options: planOptions,
    onPlan: (plan) => {
      if (stream) stream.seed(plan);
      else earlyPlan = plan;
    },
  };

  // With LOD on, the LOD worker starts coarsening now, while this thread seeds and builds the solver (#377).
  // If it cannot start, no second worker is tried for the seed: the relay's one warning covers both.
  const lodWorker = opts.lod === true && onLODTree !== undefined;
  const relay = lodWorker ? startLODRelay(graph, opts, onLODTree, coarsenSeed ? seedRequest : null) : null;
  const seedWorker = coarsenSeed && !lodWorker ? startSeedWorker(graph, opts, seedRequest) : null;
  const seeded = modulePlan !== null || (coarsenSeed && (relay !== null || seedWorker !== null));

  // The disc at the force equilibrium's scale: on screen until the seed's first frame (the same scale, so that
  // frame rearranges the layout without zooming), and a cold start's seed.
  seedPositions(graph, width, height, { force });
  let layout: GpuForceLayout;
  try {
    layout = new GpuForceLayout(device, graph, { ...DEFAULT_FORCE, ...force }, { multilevel: seeded });
  } catch (error) {
    relay?.destroy(); // the caller falls back to a worker run, which streams its own tree
    seedWorker?.destroy();
    throw error;
  }
  // As the CPU worker (#124): a cold disc start keeps full heat to untangle (see ForceLayout.run); a seeded
  // run cools over the iteration budget once the seed has placed the nodes (the stream sets it). The GPU run
  // has no early stop yet — the per-tick stop latch reads the mean step back with the positions (#124, spec
  // §6.5.5) — so it runs the whole budget.
  if (!seeded) layout.hold(1);

  let started: GpuStream;
  try {
    started = new GpuStream(device, layout, graph, {
      iterations,
      ...(opts.frameEvery !== undefined ? { frameEvery: opts.frameEvery } : {}),
      ...(relay ? { sink: relay } : {}),
      seeded,
    }, onFrame);
  } catch (error) {
    // The readback's programs or buffers failed: free the solver before the caller falls back.
    layout.destroy();
    relay?.destroy();
    seedWorker?.destroy();
    throw error;
  }
  stream = started;
  // Reported once every GPU resource exists, so a failed start reports only the fallback's "worker";
  // still before the first frame, and before the LOD tree (a later task).
  onTransport?.("gpu");
  // LOD on but no worker to build the tree (or an edge-less graph, which does not coarsen): the caller builds it.
  if (opts.lod && !relay) onLODTree?.(null);
  if (modulePlan) started.seed(modulePlan);
  else if (earlyPlan !== undefined) started.seed(earlyPlan);
  started.start();

  return {
    shared: false,
    transport: "gpu",
    settled: started.settled,
    stop: () => {
      started.stop();
      seedWorker?.destroy();
    },
    /** Hold `ids` (writing their `positions` into the position texture) and reheat — the rest reflows
     *  around them. Mirrors the worker's `pin`. */
    pin: (ids: Uint32Array, positions?: Float32Array) => started.pin(ids, positions),
    /** Release every pin and re-cool over a short tail, then idle. Mirrors the worker's `unpin`. */
    unpin: () => started.unpin(),
  };
}

/**
 * The GPU run's LOD tree, built and refit in a layout worker (#377), or null where no worker can run (with
 * one warning). An edge-less graph gets none: it does not coarsen, and its caller builds a spatial tree.
 */
function startLODRelay(
  graph: NetworkGraph,
  opts: GpuLayoutOptions,
  onLODTree: (tree: LODTree | null) => void,
  seed: SeedRequest | null,
): LODRelay | null {
  if (graph.edgeCount === 0) return null;
  const instead = seed
    ? "the LOD tree is built on the main thread and the layout starts from a disc instead of its multilevel seed"
    : "the LOD tree is built on the main thread instead";
  const worker = spawnLayoutWorker();
  if (!worker) {
    console.warn(`[d3gl] network layout({ backend: 'gpu' }): no LOD worker could start; ${instead}.`);
    return null;
  }
  try {
    return new LODRelay(worker, graph, opts.coarsen, onLODTree, seed);
  } catch (error) {
    // The coarsen request could not be posted; the relay freed its worker. The caller withdraws the tree once
    // it has reported the transport.
    console.warn(`[d3gl] network layout({ backend: 'gpu' }): a message to the LOD worker failed; ${instead}.`, error);
    return null;
  }
}

/**
 * The multilevel seed's coarsening worker with LOD off (#353), or null where no worker can run (with one
 * warning: the layout starts from its disc).
 */
function startSeedWorker(graph: NetworkGraph, opts: GpuLayoutOptions, seed: SeedRequest): SeedWorker | null {
  const worker = spawnLayoutWorker();
  if (!worker) {
    console.warn("[d3gl] network layout({ backend: 'gpu' }): no layout worker could start to coarsen the graph; the layout starts from a disc instead of its multilevel seed.");
    return null;
  }
  try {
    return new SeedWorker(worker, graph, opts.coarsen, seed.options, seed.onPlan);
  } catch (error) {
    console.warn("[d3gl] network layout({ backend: 'gpu' }): a message to the layout worker failed; the layout starts from a disc instead of its multilevel seed.", error);
    return null;
  }
}
