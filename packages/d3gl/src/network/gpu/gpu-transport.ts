/**
 * GPU-backed layout handle — mirrors {@link startWorkerLayout}'s call shape and return type so
 * `network.ts` treats both symmetrically. Falls back to the worker path when the GPU path is
 * unavailable (no device, non-WebGL backend, SSR).
 *
 * Milestone A (N8.1): plain disc seed + streaming rAF loop. Multilevel GPU seeding (N8.2) and
 * drag/reheat parity (N8.5) are later milestones; pin/unpin are no-ops here.
 */
import type { Device } from "@luma.gl/core";
import { gpuLayoutSupported } from "./device-caps.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { startWorkerLayout, type WorkerLayoutHandle, type WorkerLayoutOptions } from "../worker-transport.js";
import { seedPositions, DEFAULT_FORCE } from "../force.js";
import type { NetworkGraph } from "../graph.js";

const TARGET_FRAMES = 60;

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

  let stopped = false;
  let rafHandle = 0;
  let done = false;
  let ticksDone = 0;

  // TEMP(n8-perf): remove before merge — per-frame timing to localize 100k bottleneck
  const PERF_LOG_FRAMES = 20;
  let perfFrameCount = 0;
  let perfFirstFrameAt = 0;
  let perfTotalSubmit = 0;
  let perfTotalReadback = 0;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    layout.destroy();
    resolveSettled();
  };

  const step = (): void => {
    if (stopped || done) return;

    const remaining = iterations - ticksDone;
    const batch = Math.min(frameEvery, remaining);

    // TEMP(n8-perf): remove before merge
    const perfLogging = perfFrameCount < PERF_LOG_FRAMES;
    if (perfLogging && perfFrameCount === 0) perfFirstFrameAt = performance.now();

    const t0 = perfLogging ? performance.now() : 0;
    layout.runFrame(batch);
    const t1 = perfLogging ? performance.now() : 0;
    ticksDone += batch;
    layout.readPositions(graph.positions);
    const t2 = perfLogging ? performance.now() : 0;

    if (perfLogging) {
      const tSubmit = t1 - t0;
      const tReadback = t2 - t1;
      perfTotalSubmit += tSubmit;
      perfTotalReadback += tReadback;
      perfFrameCount++;
      console.info(
        `[n8-perf] gpu frame ${perfFrameCount}: submit ${tSubmit.toFixed(2)}ms, readback ${tReadback.toFixed(2)}ms` +
        ` (frameEvery=${batch}, count=${ticksDone})`,
      );
      if (perfFrameCount === PERF_LOG_FRAMES) {
        const totalWall = performance.now() - perfFirstFrameAt;
        const n = PERF_LOG_FRAMES;
        console.info(
          `[n8-perf] gpu summary (${n} frames): wall=${totalWall.toFixed(1)}ms,` +
          ` avg submit=${(perfTotalSubmit / n).toFixed(2)}ms,` +
          ` avg readback=${(perfTotalReadback / n).toFixed(2)}ms`,
        );
      }
    }
    // END TEMP(n8-perf)

    onFrame();

    if (ticksDone >= iterations) {
      done = true;
      // Layout converged: resolve settled, then idle (drag parity is N8.5).
      resolveSettled();
      layout.destroy();
      return;
    }

    // Schedule next batch. gpuLayoutSupported already ensured we're in a browser
    // context where requestAnimationFrame is available.
    rafHandle = requestAnimationFrame(step);
  };

  // Kick off on the next frame so the caller can set up state before the first onFrame fires.
  rafHandle = requestAnimationFrame(step);

  return {
    shared: false,
    transport: "gpu",
    settled,
    stop,
    pin() {}, // drag parity is N8.5
    unpin() {},
  };
}
