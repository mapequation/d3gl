/**
 * The GPU nested module layout (#355, spec §11.1) as a layout handle — the `layout({ backend: "gpu",
 * nested })` / `layout({ backend: "auto", nested })` (#375) counterpart of {@link startNestedWorkerLayout},
 * with the same call shape and delivery options.
 *
 * 1. The device settles (a promise, so the `"auto"` → WebGL upgrade is seen). Without GPU support for
 *    this tree — no WebGL2 device, no float render targets or float blending, a slot atlas past the device
 *    limit or more slots than the solve indexes ({@link gpuNestedSlotNeed}, from the tree's size alone) —
 *    the worker lays it out, exactly as `backend: "worker"` would: after one warning naming the reason
 *    for `"gpu"`, silently for `"auto"` (`warnUnsupported: false`), which expects the worker there.
 * 2. A layout worker builds the solve's data ({@link prepareNestedSolve}: slots, segments, radii, seeds,
 *    links), so the main thread spends nothing on it. With the segments and links known, every texture
 *    the solve allocates is checked against the device ({@link gpuNestedLayoutNeed} of the
 *    {@link nestedLayoutPlan} the layout then allocates: the springs, the tile atlas, the collision
 *    table and the collision grid's own textures) — an unsupported tree, as in step 1.
 * 3. {@link GpuNestedLayout} solves every module at every depth at once, streamed by {@link GpuStream}:
 *    work items within the frame budget, positions composed on the GPU and read back through a fenced PBO.
 *    A **cold** layout streams as one animation of all depths converging together (decided, §15 Q5); a
 *    warm start or a transition (`stream: false` / `onResult`, #328) reads back only the final layout,
 *    in one frame, without the main thread ever waiting for the GPU.
 * 4. The final layout's module discs come back with it: a warm start is placed over the current map
 *    (float64, on the CPU, as the CPU layout does), the boundary discs (#329) go to `onBoundaries`, then
 *    the positions land. The GPU resources are freed once it settles — a nested layout has no reheat.
 *
 * A solve that stops before its final harvest — a non-finite layout, a lost context — lands none of it
 * (a one-frame layout's arrays were never filled): one warning names the reason, and the worker lays the
 * map out with the same delivery options, as it does when the device cannot run the solve. That is a
 * fault, not an unsupported device, so it warns under `"auto"` too — as does a device promise or a prep
 * that rejects, or a solve that throws while starting ({@link warnGpuFallback}).
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
import { gpuLayoutSupport, gpuNestedSlotNeed } from "./device-caps.js";
import { gpuCaps } from "./device-probe.js";
import { GpuNestedLayout, gpuNestedLayoutNeed, nestedLayoutPlan } from "./gpu-nested-layout.js";
import { GpuStream } from "./gpu-stream.js";
import { nestedSolverResult, type NestedSolverTopology } from "./nested-topology.js";
import { warnGpuFallback, type GpuLayoutFailure, type GpuLayoutTransport } from "./gpu-transport.js";

/** Delivery options of a GPU nested layout — the worker's, plus the transport report and whether an unsupported device warns. */
export interface GpuNestedOptions extends NestedWorkerOptions {
  /** Called once the run resolved to the GPU solve or the worker fallback, before any frame. */
  onTransport?: (transport: GpuLayoutTransport) => void;
  /** Test hook: at most one readback per this many ticks, in place of the repaint throttle. */
  frameEvery?: number;
  /**
   * Warn when the device or the module tree is unsupported and the layout falls back to the worker
   * (default `true`), as `GpuLayoutOptions.warnUnsupported` does for the flat layout:
   * `layout({ backend: "auto", nested })` passes `false` (#375). A solve that fails rather than being
   * unsupported warns either way (see the file header).
   */
  warnUnsupported?: boolean;
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

  const fallBack = (reason: string, failure?: GpuLayoutFailure): void => {
    if (stopped) return;
    warnGpuFallback(`[d3gl] the GPU nested layout fell back to the CPU worker: ${reason}.`, opts.warnUnsupported, failure);
    report("worker");
    const worker = startNestedWorkerLayout(graph, tree, params, onFrame, opts);
    inner = worker;
    worker.settled.then(resolveSettled, resolveSettled);
  };

  const run = (device: WebGLDevice, solver: NestedSolverTopology): void => {
    if (stopped) return;
    // Now that the segments and links are known, every texture the solve allocates must fit the device:
    // the plan the verdict checks is the one the layout allocates.
    const plan = nestedLayoutPlan(solver);
    const verdict = gpuLayoutSupport(gpuCaps(device), gpuNestedLayoutNeed(plan));
    if (!verdict.ok) {
      fallBack(verdict.reason);
      return;
    }
    const layout = new GpuNestedLayout(device, plan); // frees what it created if it throws
    const oneFrame = opts.onResult !== undefined || opts.stream === false;
    const modules = solver.treeSize - solver.leafCount;
    const discs = new Float32Array(4 * modules);
    // A one-frame layout harvests into its own array: `graph.positions` stays as it is until it lands.
    const into = oneFrame ? new Float32Array(2 * solver.leafCount) : undefined;
    let failure: string | null = null;
    let s: GpuStream;
    try {
      s = new GpuStream(device, layout, graph, {
        iterations: layout.streamTicks,
        stream: !oneFrame,
        extra: discs,
        ...(into ? { into } : {}),
        ...(opts.frameEvery !== undefined ? { frameEvery: opts.frameEvery } : {}),
        onFailure: (reason) => {
          failure = reason;
        },
      }, oneFrame ? () => {} : onFrame);
    } catch (error) {
      layout.destroy();
      throw error;
    }
    stream = s;
    report("gpu");
    s.settled.then(() => {
      if (stopped || stream !== s) return;
      if (failure !== null) {
        // Stopped before its final harvest: nothing of it lands. Free it (no GL call on a lost context)
        // and lay the map out on the worker.
        stream = null;
        s.stop();
        fallBack(`the GPU solve stopped: ${failure}`, { kind: "failure" });
        return;
      }
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
    try {
      s.start();
    } catch (error) {
      stream = null; // its settle must not land anything
      s.stop();
      throw error;
    }
  };

  const begin = (device: Device | null | undefined): void => {
    if (stopped) return;
    if (tree.size < 2 || graph.nodeCount === 0) {
      fallBack("the module tree has no node below its root");
      return;
    }
    // What the slot count alone decides (the slot atlas, the CSR offsets, the slot limit), before the prep.
    const verdict = gpuLayoutSupport(gpuCaps(device), gpuNestedSlotNeed(tree.size - 1));
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
          // A fault — a driver that rejects a shader, an allocation that fails: the worker lays it out.
          fallBack("the GPU nested layout failed to start", { kind: "failure", cause: error });
        }
      },
      (error: unknown) => fallBack("its solve could not be prepared", { kind: "failure", cause: error }),
    );
  };

  if (deviceOrPromise instanceof Promise) {
    deviceOrPromise.then(begin, (error: unknown) => fallBack("the device promise rejected", { kind: "failure", cause: error }));
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
