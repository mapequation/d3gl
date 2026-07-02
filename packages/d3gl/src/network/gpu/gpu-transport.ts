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
 * - If `gpuLayoutSupported(device)` is false (null device, Canvas/SVG backend, SSR, no float RTT)
 *   → delegates transparently to {@link startWorkerLayout} (which has its own sync fallback).
 * - Otherwise: seeds positions, constructs {@link GpuForceLayout}, and runs a streaming rAF loop
 *   until `iterations` are done, calling `onFrame` after each batch.
 */
export function startGpuLayout(
  device: Device | null | undefined,
  graph: NetworkGraph,
  opts: WorkerLayoutOptions,
  onFrame: () => void,
): WorkerLayoutHandle {
  if (!gpuLayoutSupported(device)) {
    return startWorkerLayout(graph, opts, onFrame);
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

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (rafHandle) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
      else clearTimeout(rafHandle);
      rafHandle = 0;
    }
    layout.destroy();
    resolveSettled();
  };

  const step = (): void => {
    if (stopped || done) return;

    const remaining = iterations - ticksDone;
    const batch = Math.min(frameEvery, remaining);
    layout.runFrame(batch);
    ticksDone += batch;
    layout.readPositions(graph.positions);
    onFrame();

    if (ticksDone >= iterations) {
      done = true;
      // Layout converged: resolve settled, then idle (drag parity is N8.5).
      resolveSettled();
      layout.destroy();
      return;
    }

    // Schedule next batch.
    if (typeof requestAnimationFrame === "function") {
      rafHandle = requestAnimationFrame(step);
    } else {
      // SSR / non-browser: shouldn't reach here since gpuLayoutSupported guards against it,
      // but guard defensively anyway.
      rafHandle = setTimeout(step, 16) as unknown as number;
    }
  };

  // Kick off on the next frame so the caller can set up state before the first onFrame fires.
  if (typeof requestAnimationFrame === "function") {
    rafHandle = requestAnimationFrame(step);
  } else {
    rafHandle = setTimeout(step, 16) as unknown as number;
  }

  return {
    shared: false,
    settled,
    stop,
    pin() {}, // drag parity is N8.5
    unpin() {},
  };
}
