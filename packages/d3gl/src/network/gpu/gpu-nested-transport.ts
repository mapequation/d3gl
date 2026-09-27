/**
 * The GPU nested module layout (#355, spec §11.1) as a layout handle — the `layout({ backend: "gpu",
 * nested })` counterpart of {@link startNestedWorkerLayout}, with the same call shape and delivery options.
 *
 * 1. The device settles (a promise, so the `"auto"` → WebGL upgrade is seen). Without GPU support for
 *    this tree — no WebGL2 device, no float render targets or float blending, textures past the device
 *    limit — one warning names the reason and the worker lays it out, exactly as `backend: "worker"`
 *    would.
 * 2. A layout worker builds the solve's data ({@link prepareNestedSolve}: slots, segments, radii, seeds,
 *    links), so the main thread spends nothing on it.
 * 3. {@link GpuNestedLayout} solves every module at every depth at once, streamed by {@link GpuStream}:
 *    work items within the frame budget, positions composed on the GPU and read back through a fenced PBO.
 *    A **cold** layout streams as one animation of all depths converging together (decided, §15 Q5); a
 *    warm start or a transition (`stream: false` / `onResult`, #328) reads back only the final layout,
 *    in one frame, without the main thread ever waiting for the GPU.
 * 4. The final layout's module discs come back with it: a warm start is placed over the current map
 *    (float64, on the CPU, as the CPU layout does), the boundary discs (#329) go to `onBoundaries`, then
 *    the positions land. The GPU resources are freed once it settles — a nested layout has no reheat.
 */
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import type { NetworkGraph } from "../graph.js";
import { nestedBoundaryDiscs, type NestedLayoutParams, type NestedLayoutTopology } from "../nested-layout.js";
import {
  prepareNestedSolve,
  startNestedWorkerLayout,
  type NestedPrep,
  type NestedWorkerOptions,
  type WorkerLayoutHandle,
} from "../worker-transport.js";
import { gpuLayoutNeed, gpuLayoutSupport } from "./device-caps.js";
import { gpuCaps } from "./device-probe.js";
import { GpuNestedLayout } from "./gpu-nested-layout.js";
import { GpuStream } from "./gpu-stream.js";
import { nestedSolverResult, type NestedSolverTopology } from "./nested-topology.js";
import type { GpuLayoutTransport } from "./gpu-transport.js";

/** Delivery options of a GPU nested layout — the worker's, plus the transport report. */
export interface GpuNestedOptions extends NestedWorkerOptions {
  /** Called once the run resolved to the GPU solve or the worker fallback, before any frame. */
  onTransport?: (transport: GpuLayoutTransport) => void;
  /** Test hook: at most one readback per this many ticks, in place of the repaint throttle. */
  frameEvery?: number;
}

/**
 * Start a GPU nested layout of `tree` (see the file header). Returns a {@link WorkerLayoutHandle}: its
 * `transport` reads `"pending"` until the device and the prep settle, then `"gpu"` or `"worker"`.
 * `pin` / `unpin` do nothing (drag is translate-only on a nested layout, as on the worker).
 */
export function startGpuNestedLayout(
  deviceOrPromise: Device | null | undefined | Promise<Device | null | undefined>,
  graph: NetworkGraph,
  tree: NestedLayoutTopology,
  params: NestedLayoutParams,
  onFrame: () => void,
  opts: GpuNestedOptions = {},
): WorkerLayoutHandle {
  let stopped = false;
  let transport: GpuLayoutTransport | "pending" = "pending";
  let inner: WorkerLayoutHandle | null = null;
  let prep: NestedPrep | null = null;
  let stream: GpuStream | null = null;
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const report = (t: GpuLayoutTransport): void => {
    transport = t;
    opts.onTransport?.(t);
  };

  const fallBack = (reason: string, cause?: unknown): void => {
    if (stopped) return;
    const message = `[d3gl] network layout({ backend: 'gpu', nested }) fell back to the CPU worker: ${reason}.`;
    if (cause === undefined) console.warn(message);
    else console.warn(message, cause);
    report("worker");
    const worker = startNestedWorkerLayout(graph, tree, params, onFrame, opts);
    inner = worker;
    worker.settled.then(resolveSettled, resolveSettled);
  };

  const run = (device: WebGLDevice, solver: NestedSolverTopology): void => {
    if (stopped) return;
    const layout = new GpuNestedLayout(device, solver);
    const oneFrame = opts.onResult !== undefined || opts.stream === false;
    const modules = solver.treeSize - solver.leafCount;
    const discs = new Float32Array(4 * modules);
    // A one-frame layout harvests into its own array: `graph.positions` stays as it is until it lands.
    const into = oneFrame ? new Float32Array(2 * solver.leafCount) : undefined;
    let s: GpuStream;
    try {
      s = new GpuStream(device, layout, graph, {
        iterations: layout.streamTicks,
        stream: !oneFrame,
        extra: discs,
        ...(into ? { into } : {}),
        ...(opts.frameEvery !== undefined ? { frameEvery: opts.frameEvery } : {}),
      }, oneFrame ? () => {} : onFrame);
    } catch (error) {
      layout.destroy();
      throw error;
    }
    stream = s;
    report("gpu");
    s.settled.then(() => {
      if (stopped) return;
      // The final harvest has landed (in `graph.positions`, or `into`): place a warm start, record the
      // boundary discs, then deliver the positions (a streamed layout's are already painted).
      const positions = into ?? graph.positions.subarray(0, 2 * solver.leafCount);
      const result = nestedSolverResult(solver, positions, discs, params.initial, params.radius === undefined);
      opts.onBoundaries?.(nestedBoundaryDiscs(tree, result));
      if (opts.onResult) opts.onResult(result.positions);
      else if (oneFrame) {
        graph.positions.set(result.positions);
        onFrame();
      }
      s.stop(); // no reheat: free the GPU resources now
      resolveSettled();
    }, resolveSettled);
    s.start();
  };

  const begin = (device: Device | null | undefined): void => {
    if (stopped) return;
    if (tree.size < 2 || graph.nodeCount === 0) {
      fallBack("the module tree has no node below its root");
      return;
    }
    const verdict = gpuLayoutSupport(gpuCaps(device), gpuLayoutNeed(tree.size - 1, 0));
    if (!verdict.ok) {
      fallBack(verdict.reason);
      return;
    }
    if (!(device instanceof WebGLDevice)) {
      fallBack("no WebGL2 device");
      return;
    }
    const p = prepareNestedSolve(tree, params);
    prep = p;
    p.solver.then(
      (solver) => {
        prep = null;
        try {
          run(device, solver);
        } catch (error) {
          // A tile atlas past the device limit, a driver that rejects a shader: the worker lays it out.
          fallBack("the GPU nested layout failed to start", error);
        }
      },
      (error: unknown) => fallBack("its solve could not be prepared", error),
    );
  };

  if (deviceOrPromise instanceof Promise) {
    deviceOrPromise.then(begin, (error: unknown) => fallBack("the device promise rejected", error));
  } else {
    begin(deviceOrPromise);
  }

  return {
    shared: false,
    get transport() {
      return transport;
    },
    settled,
    stop() {
      if (stopped) return;
      stopped = true;
      prep?.cancel();
      stream?.stop();
      inner?.stop();
      resolveSettled();
    },
    pin() {},
    unpin() {},
  };
}
