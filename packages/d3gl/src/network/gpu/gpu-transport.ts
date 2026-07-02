/**
 * GPU-backed layout handle — mirrors {@link startWorkerLayout}'s call shape and return type so
 * `network.ts` treats both symmetrically. Falls back to the worker path when the GPU path is
 * unavailable (no device, non-WebGL backend, SSR).
 *
 * Milestone A (N8.1): plain disc seed + streaming rAF loop. N8.5 (#183) adds drag/reheat parity:
 * on convergence the loop goes **idle** (keeps the {@link GpuForceLayout} alive, doesn't destroy it),
 * and `pin`/`unpin` hold nodes + resume the loop so the rest reflows — mirroring the CPU worker
 * (layout-worker.ts). Multilevel GPU seeding (N8.2) is still a later milestone.
 */
import type { Device } from "@luma.gl/core";
import { gpuLayoutSupported } from "./device-caps.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { startWorkerLayout, type WorkerLayoutHandle, type WorkerLayoutOptions } from "../worker-transport.js";
import { seedPositions, DEFAULT_FORCE } from "../force.js";
import type { NetworkGraph } from "../graph.js";

const TARGET_FRAMES = 60;

/** Ticks per streamed frame while reheating (drag / cool) — small batches keep the stream responsive
 *  (mirrors the worker's REHEAT_BATCH in layout-worker.ts). */
const REHEAT_BATCH = 3;
/** Tail of refinement ticks after a drag releases, so the layout re-cools instead of freezing
 *  mid-reflow (mirrors the worker's COOL_TICKS). */
const COOL_TICKS = 120;

/**
 * Start a GPU-accelerated layout run. Returns a {@link WorkerLayoutHandle}-shaped object so the
 * engine treats it identically to the worker backend.
 *
 * Accepts a `Device | null | Promise<Device | null>` so `network.ts` can pass a **device promise**
 * that resolves after the backend settles (including the `"auto"` → WebGL background upgrade).
 * When passed a plain `Device | null` value it behaves synchronously as before.
 *
 * - If `gpuLayoutSupported(device)` is false (null device, Canvas/SVG backend, SSR, no float RTT)
 *   → delegates transparently to {@link startWorkerLayout} (which has its own sync fallback).
 * - Otherwise: seeds positions, constructs {@link GpuForceLayout}, and runs a streaming rAF loop
 *   until `iterations` are done, calling `onFrame` after each batch.
 */
export function startGpuLayout(
  deviceOrPromise: Device | null | undefined | Promise<Device | null | undefined>,
  graph: NetworkGraph,
  opts: WorkerLayoutOptions,
  onFrame: () => void,
): WorkerLayoutHandle {
  // Fast path: plain value (not a Promise). Preserves backward compatibility.
  if (
    deviceOrPromise === null ||
    deviceOrPromise === undefined ||
    !("then" in (deviceOrPromise as object))
  ) {
    return startGpuLayoutSync(
      deviceOrPromise as Device | null | undefined,
      graph,
      opts,
      onFrame,
    );
  }

  // Async path: the device resolves later (e.g. after the "auto" → WebGL upgrade).
  // Return a wrapper handle synchronously; resolve it once the device promise settles.
  if (graph.nodeCount === 0) {
    onFrame();
    return { shared: false, settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} };
  }

  let stopped = false;
  let inner: WorkerLayoutHandle | null = null;

  let resolveSettled!: () => void;
  let rejectSettled!: (e: unknown) => void;
  const settled = new Promise<void>((res, rej) => { resolveSettled = res; rejectSettled = rej; });

  const wrapper: WorkerLayoutHandle = {
    shared: false,
    transport: undefined,
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

  Promise.resolve(deviceOrPromise).then((device) => {
    if (stopped) return;
    inner = startGpuLayoutSync(device, graph, opts, onFrame);
    // Mirror transport and shared from the resolved inner handle.
    wrapper.transport = inner.transport;
    wrapper.shared = inner.shared;
    // Forward inner.settled to our outer settled promise.
    inner.settled.then(resolveSettled, rejectSettled);
  }).catch((e: unknown) => {
    if (!stopped) {
      console.warn("[d3gl] network layout({ backend: 'gpu' }): device promise rejected, falling back to worker.", e);
      inner = startWorkerLayout(graph, opts, onFrame);
      wrapper.shared = inner.shared;
      inner.settled.then(resolveSettled, rejectSettled);
    }
  });

  return wrapper;
}

/**
 * Synchronous variant: accepts a resolved `Device | null | undefined` value.
 * This is the original `startGpuLayout` logic, now a named helper.
 */
function startGpuLayoutSync(
  device: Device | null | undefined,
  graph: NetworkGraph,
  opts: WorkerLayoutOptions,
  onFrame: () => void,
): WorkerLayoutHandle {
  if (!gpuLayoutSupported(device)) {
    // Warn so the silent fallback is observable (the bug this fix addresses).
    if (device === null || device === undefined) {
      console.warn(
        "[d3gl] network layout({ backend: 'gpu' }) fell back to the CPU worker: no WebGL device available" +
        " (non-WebGL backend, or called before the backend settled — use an async device promise).",
      );
    }
    return startWorkerLayout(graph, opts, onFrame);
  }

  // 0-node graph: GpuForceLayout would create a zero-height texture (crash).
  // Return a no-op handle immediately — there is nothing to lay out.
  if (graph.nodeCount === 0) {
    onFrame();
    return { shared: false, settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} };
  }

  const { width, height, force, iterations: rawIterations } = opts;
  const iterations = rawIterations ?? 300;
  const frameEvery = opts.frameEvery ?? Math.max(1, Math.ceil(iterations / TARGET_FRAMES));

  // Seed positions with a plain disc (multilevel GPU seeding is N8.2).
  seedPositions(graph, width, height);

  const layout = new GpuForceLayout(device, graph, { ...DEFAULT_FORCE, ...force });

  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  // `settled` resolves once, at first convergence; the layout then stays ALIVE (idle) so a node-drag
  // can reheat it (#183). `stop()` is the real teardown; it also settles if we never converged.
  let settledOnce = false;
  const settle = (): void => { if (settledOnce) return; settledOnce = true; resolveSettled(); };

  let stopped = false;
  let rafHandle = 0;
  let ticksDone = 0;
  // Loop activity, mirroring the worker (layout-worker.ts): `run` (initial fixed-iteration
  // convergence), `drag` (held nodes pinned, reflow indefinitely), `cool` (post-release settling
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
      if (ticksDone >= iterations) { settle(); mode = dragging ? "drag" : "idle"; } // converged → keep reflowing if a drag is live
    } else if (mode === "cool") {
      coolLeft -= batch;
      if (coolLeft <= 0) mode = "idle";
    }

    if (mode === "idle") { looping = false; settle(); return; } // reached rest — pause; layout stays alive
    // Schedule next batch. gpuLayoutSupported already ensured requestAnimationFrame exists.
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
      if (mode === "idle" || mode === "cool") mode = "drag";
      resume();
    },
    /** Release every pin and re-cool over a short tail, then idle. Mirrors the worker's `unpin`. */
    unpin() {
      if (stopped) return;
      layout.setPinned(null);
      dragging = false;
      if (mode === "drag") { mode = "cool"; coolLeft = COOL_TICKS; }
      resume();
    },
  };
}
