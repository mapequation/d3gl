/**
 * GPU-backed layout handle — mirrors {@link startWorkerLayout}'s call shape and return type so
 * `network.ts` treats both symmetrically. Falls back to the worker path when the GPU path is
 * unavailable for the device or the graph (#351): no device (Canvas/SVG render backend, SSR), no float
 * render targets, no float blending, a texture limit too small for the graph, or a failed functional
 * probe (`gpuLayoutSupport` over `gpuCaps`). The fallback is a full worker run: it keeps every layout
 * option (`multilevel`, `lod`, `coarsen`, `frameEvery`) and streams the LOD tree through `onLODTree`,
 * exactly as `layout({ backend: "worker" })` would (#312), and one `console.warn` names the reason.
 *
 * Milestone A (N8.1): plain disc seed (at the force equilibrium's scale) + streaming rAF loop, cooled
 * over the iteration budget like the worker (#124). N8.5 (#183) adds drag/reheat parity:
 * on convergence the loop goes **idle** (keeps the {@link GpuForceLayout} alive, doesn't destroy it),
 * and `pin`/`unpin` hold nodes + resume the loop so the rest reflows — mirroring the CPU worker
 * (layout-worker.ts). The GPU run itself ignores `multilevel`, `lod` and `coarsen` (a structural GPU
 * seed and GPU-side LOD streaming are later milestones); only its fallback uses them.
 */
import type { Device } from "@luma.gl/core";
import { gpuLayoutNeed, gpuLayoutSupport } from "./device-caps.js";
import { gpuCaps } from "./device-probe.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { canModuleSeed, gpuMultilevelSeed } from "./gpu-multilevel-seed.js";
import { startWorkerLayout, type WorkerLayoutHandle, type WorkerLayoutOptions } from "../worker-transport.js";
import { seedPositions, DEFAULT_FORCE, DRAG_HEAT, RECOOL_TICKS } from "../force.js";
import type { LODTopology, LODTree } from "../lod.js";
import type { NetworkGraph } from "../graph.js";

/**
 * GPU layout options — the worker options plus an optional provided module hierarchy (N8.2). When
 * present (and it carries super-edges), the GPU backend seeds **module-aware**, laying the layout out
 * top-down over the module tree so modules read as coherent regions; otherwise it uses the disc seed.
 * The worker options are all honoured by the worker fallback.
 */
export interface GpuLayoutOptions extends WorkerLayoutOptions {
  /** The provided module tree topology (from `lod({ modules })`), for the module-aware multilevel seed. */
  moduleTopology?: LODTopology;
}

/** The transport a GPU layout resolved to: the GPU solve, or the worker fallback. */
export type GpuLayoutTransport = "gpu" | "worker";

const TARGET_FRAMES = 60;

/** Ticks per streamed frame while reheating (drag / cool) — small batches keep the stream responsive. */
const REHEAT_BATCH = 3;

/**
 * Start a GPU-accelerated layout run. Returns a {@link WorkerLayoutHandle}-shaped object so the
 * engine treats it identically to the worker backend.
 *
 * Accepts a `Device | null | Promise<Device | null>` so `network.ts` can pass a **device promise**
 * that resolves after the backend settles (including the `"auto"` → WebGL background upgrade).
 * When passed a plain `Device | null` value it resolves synchronously.
 *
 * - If `gpuLayoutSupport` rejects the device for this graph → one warning with the reason, then
 *   {@link startWorkerLayout} with the same options and `onLODTree` (it has its own sync fallback).
 * - Otherwise: seeds positions, constructs {@link GpuForceLayout}, and runs a streaming rAF loop
 *   until `iterations` are done, calling `onFrame` after each batch.
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
  onLODTree?: (tree: LODTree) => void,
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
      if (!stopped) adopt(fallBackToWorker("the device promise rejected", graph, opts, onFrame, onLODTree, onTransport, e));
    },
  ).catch((e: unknown) => {
    // The GPU run failed to start (e.g. a driver rejected a shader): the worker still lays it out.
    if (!stopped && !inner) adopt(fallBackToWorker("the GPU layout failed to start", graph, opts, onFrame, onLODTree, onTransport, e));
  });

  return wrapper;
}

/**
 * The fallback: a worker run with the GPU layout's options and LOD-tree callback, reported as the
 * `"worker"` transport. `shared` reads the worker handle live (it flips on a worker error, #297).
 */
function fallBackToWorker(
  reason: string,
  graph: NetworkGraph,
  opts: GpuLayoutOptions,
  onFrame: () => void,
  onLODTree: ((tree: LODTree) => void) | undefined,
  onTransport: ((transport: GpuLayoutTransport) => void) | undefined,
  cause?: unknown,
): WorkerLayoutHandle {
  const message = `[d3gl] network layout({ backend: 'gpu' }) fell back to the CPU worker: ${reason}.`;
  if (cause === undefined) console.warn(message);
  else console.warn(message, cause);
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
  onLODTree: ((tree: LODTree) => void) | undefined,
  onTransport: ((transport: GpuLayoutTransport) => void) | undefined,
): WorkerLayoutHandle {
  const verdict = gpuLayoutSupport(gpuCaps(device), gpuLayoutNeed(graph.nodeCount, graph.edgeCount));
  if (!verdict.ok || !device) {
    // (`!device` never reaches here with `ok`: no device has no caps, which never pass.)
    return fallBackToWorker(verdict.ok ? "no WebGL device" : verdict.reason, graph, opts, onFrame, onLODTree, onTransport);
  }
  onTransport?.("gpu");

  // 0-node graph: GpuForceLayout would create a zero-height texture (crash).
  // Return a no-op handle immediately — there is nothing to lay out.
  if (graph.nodeCount === 0) {
    onFrame();
    return { shared: false, transport: "gpu", settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} };
  }

  const { width, height, force, iterations: rawIterations } = opts;
  const iterations = rawIterations ?? 300;
  const frameEvery = opts.frameEvery ?? Math.max(1, Math.ceil(iterations / TARGET_FRAMES));

  // Seed positions. Module-aware multilevel seed (N8.2) when a provided module tree with super-edges
  // is available — lays out top-down over the module hierarchy so modules read as coherent regions —
  // else the plain phyllotaxis disc. The finest-level refine below (real edges) polishes either seed.
  const topo = opts.moduleTopology;
  const moduleSeeded = !!topo && canModuleSeed(topo, graph.nodeCount);
  if (topo && moduleSeeded) {
    gpuMultilevelSeed(device, topo, graph, { width, height, force });
  } else {
    seedPositions(graph, width, height, { force });
  }

  const layout = new GpuForceLayout(device, graph, { ...DEFAULT_FORCE, ...force });
  // As the CPU worker (#124): a module-seeded layout cools over the iteration budget, a cold disc start
  // keeps full heat to untangle (see ForceLayout.run). The GPU run has no early stop yet — that needs a
  // per-frame mean-step reduction read back from the GPU, which belongs with the async (fenced)
  // readback — so it runs the whole budget.
  if (moduleSeeded) layout.cool(iterations);
  else layout.hold(1);

  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  // `settled` resolves once, at first convergence; the layout then stays ALIVE (idle) so a node-drag
  // can reheat it (#183). `stop()` is the real teardown; it also settles if we never converged.
  let settledOnce = false;
  const settle = (): void => { if (settledOnce) return; settledOnce = true; resolveSettled(); };

  let stopped = false;
  let rafHandle = 0;
  let ticksDone = 0;
  // Loop activity, mirroring the worker (layout-worker.ts): `run` (initial cooled run over the
  // iteration budget), `drag` (held nodes pinned, reflow indefinitely), `cool` (post-release settling
  // tail), `idle` (at rest — loop paused, layout kept alive for a later reheat).
  let mode: "idle" | "run" | "drag" | "cool" = iterations > 0 ? "run" : "idle";
  let looping = false;
  let coolLeft = 0;
  let dragging = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    layout.destroy();
    settle();
  };

  const step = (): void => {
    rafHandle = 0;
    if (stopped) { looping = false; return; }

    // The initial run clamps its last batch to the iterations remaining; reheat (drag/cool)
    // streams small fixed batches for responsiveness.
    const batch = mode === "run" ? Math.min(frameEvery, iterations - ticksDone) : REHEAT_BATCH;
    layout.runFrame(batch);
    ticksDone += batch;
    layout.readPositions(graph.positions);
    onFrame();

    if (mode === "run") {
      if (ticksDone >= iterations) {
        settle();
        // Converged → keep reflowing at the drag heat if a drag is live.
        if (dragging) { mode = "drag"; layout.hold(DRAG_HEAT); } else mode = "idle";
      }
    } else if (mode === "cool") {
      coolLeft -= batch;
      if (coolLeft <= 0) mode = "idle";
    }

    if (mode === "idle") { looping = false; settle(); return; } // reached rest — pause; layout stays alive
    // Schedule next batch. The support check above ensured a WebGL device, so requestAnimationFrame exists.
    rafHandle = requestAnimationFrame(step);
  };

  // Resume the rAF loop if it isn't already running and there's work to do. Re-entrant-safe via
  // `looping` so pin/unpin can't spin up a second loop.
  const resume = (): void => {
    if (looping || stopped || mode === "idle") return;
    looping = true;
    rafHandle = requestAnimationFrame(step);
  };

  // Kick off the initial run (or, with no iterations, paint the seed + settle immediately).
  if (mode === "run") resume();
  else { onFrame(); settle(); }

  return {
    shared: false,
    transport: "gpu",
    settled,
    stop,
    /** Hold `ids` (writing their `positions` into the position texture) and reheat — the rest reflows
     *  around them. Resumes the loop in "drag" mode (or lets a still-running initial run transition to
     *  it on convergence). Mirrors the worker's `pin`. */
    pin(ids: Uint32Array, positions?: Float32Array) {
      if (stopped) return;
      layout.setPinned(ids);
      if (positions) layout.setHeldPositions(ids, positions);
      dragging = true;
      // During the initial run the drag rides on the run's schedule until its budget ends (then DRAG_HEAT).
      if (mode === "idle" || mode === "cool") { mode = "drag"; layout.hold(DRAG_HEAT); }
      resume();
    },
    /** Release every pin and re-cool over a short tail, then idle. Mirrors the worker's `unpin`. */
    unpin() {
      if (stopped) return;
      layout.setPinned(null);
      dragging = false;
      if (mode === "drag") { mode = "cool"; coolLeft = RECOOL_TICKS; layout.cool(RECOOL_TICKS, DRAG_HEAT); }
      resume();
    },
  };
}
