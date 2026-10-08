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
 * equilibrium's scale, at full heat. Either way it **stops once it has converged**, by the worker's rule,
 * decided on the GPU once per tick (#124, #376), so `iterations` is a cap, as on the worker. It streams
 * through {@link GpuStream} (#352):
 * each animation frame harvests positions a fenced PBO copy delivered, repaints (throttled, in the same
 * frame), and encodes as many work items — tick prep, force-pass row bands, integrate — as fit a GPU
 * budget of `min(10 ms, 0.6 × the frame interval)`. The main thread never waits for the GPU: no
 * synchronous `readPixels` on the frame path. On convergence the loop goes **idle** (the solver stays
 * alive) and `pin`/`unpin` hold nodes and resume it so the rest reflows (#183) — at the drag heat, then a
 * re-cool that stops once converged, at most `RECOOL_TICKS` — as on the worker.
 *
 * With `lod` on, the GPU run keeps the LOD tree off the main thread as the worker
 * backend does (#377): a layout worker coarsens the graph (`coarsen`) while the solver is built, and refits
 * the tree's geometry to every harvested frame before it is painted ({@link LODRelay}); the tree reaches
 * `onLODTree` once, with geometry, and `onLODTree(null)` withdraws it if that worker fails (the caller then
 * builds its own). The same worker builds the multilevel seed's plan from the same coarsening, so the graph
 * is coarsened once. With `lodSource: "spatial"` (#343) that worker rebuilds the spatial tree for every
 * harvested frame instead — the worker backend's per-frame step — and each painted frame hands its tree to
 * `onLODTree` with a streamed handle, as the worker backend's frames do; it coarsens only for the seed's plan.
 *
 * **Startup (#385).** Once the device has passed the checks its features and limits decide (or, probed for an
 * earlier layout, its whole cached record, so a failed probe falls back at once), the run starts its coarsening
 * worker (with LOD on, the LOD relay's, unarmed: it holds its tree until the stream exists), seeds the disc, and
 * compiles every program it will build — the float-blend probe's, the solver's (its stop latch and its seed's
 * passes too) and the readback's — at once and in parallel (`compilePrograms`, `KHR_parallel_shader_compile`),
 * polled once per animation frame. It reports `"gpu"` then; the probe runs and the solver is built in the frame
 * all of them have linked, so no program links on the main thread in the click's task. A link that fails falls
 * back to the worker, a render-backend swap during the compile abandons it and starts again on the next device,
 * a lost context continues on the worker, and a stop frees it; a drag meanwhile is replayed onto the run once it
 * exists. Programs the device built for an earlier layout are not compiled again, and without the extension the
 * solver is built at once, as before. The nested layout (`gpu-nested-transport.ts`) takes the same step once its
 * prep is back.
 *
 * **A GPU run's lifetime is its device's (#311).** When the render backend that owns the device is about
 * to be swapped out, the engine calls the handle's `moveDevice` while the device is still alive: the run
 * stops and frees its GPU resources (and its LOD and seed workers), then continues **warm** on the next
 * backend — a GPU run on a new WebGL device, else the CPU worker (Canvas/SVG) — from the positions on
 * screen, with the ticks left of its budget and its current heat, so a swap never reruns the whole budget.
 * A settled layout continues as an idle run, so a drag still reflows. A lost WebGL context, or a layout that
 * turned non-finite, continues the same way on the worker. A seeded run that has painted nothing yet (#353)
 * starts afresh there instead: the disc on screen is only its placeholder. The handle stays the same object
 * throughout, so the engine's settle handler and a live drag keep working, and the drag is replayed onto
 * the new run.
 */
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { gpuLayoutNeed, gpuLayoutSupport } from "./device-caps.js";
import { blendProbeProgram, cachedGpuCaps, gpuCaps, gpuStaticCaps } from "./device-probe.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { DirectSink, GpuStream, type GpuRunState } from "./gpu-stream.js";
import { AsyncPositionReadback } from "./async-readback.js";
import { compilePrograms, type CompileOutcome, type ProgramCompile } from "./programs.js";
import { moduleSeedPlan, type SeedPlan, type SeedPlanOptions } from "./seed-plan.js";
import { SeedWorker } from "./seed-worker.js";
import { LODRelay, type OnLODTree, type SeedRequest } from "./lod-relay.js";
import { spawnLayoutWorker, startWorkerLayout, withModuleSprings, type WorkerLayoutHandle, type WorkerLayoutOptions } from "../worker-transport.js";
import { seedPositions, DEFAULT_FORCE, DRAG_HEAT, RECOOL_TICKS } from "../force.js";
import type { LODTopology } from "../lod.js";
import type { LeafStyle, LODView } from "../lod-frame.js";
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
  /**
   * Warn when the device or the graph is unsupported and the layout falls back to the worker (default
   * `true`: `layout({ backend: "gpu" })` asked for the GPU). `layout({ backend: "auto" })` passes `false`
   * (#375), because there the worker is an expected outcome — also when a render-backend swap moves the
   * layout to the worker (#311). A GPU run that fails rather than being unsupported (its device promise
   * rejects, it throws while starting, its context is lost or its layout turns non-finite) warns either way.
   */
  warnUnsupported?: boolean;
}

/** The transport a GPU layout resolved to: the GPU solve, or the worker fallback. */
export type GpuLayoutTransport = "gpu" | "worker";

/** A device now, or one that resolves once the render backend has settled. */
type DeviceSource = Device | null | undefined | Promise<Device | null | undefined>;

/**
 * How a moved layout continues (#311): the ticks it runs and the heat schedule it resumes. `iterations: 0`
 * is an idle run, alive for a drag reheat. `warm.recool`: the ticks are a re-cool's tail after a drag, resumed
 * as one, so a pin reheats at the drag heat at once (in the initial run a drag rides on the run's schedule).
 */
export interface Continuation {
  iterations: number;
  warm: { heat: number; decaying: boolean; recool?: boolean };
}

/**
 * Where a stopped GPU run continues, from where it stood at its last painted positions and whether a drag
 * is live now (#311). Pure, so the policy is node-tested:
 *
 * - the initial run goes on over the ticks it had left, on its own heat schedule (a live drag rides on
 *   it, as it does on the GPU and the worker);
 * - a live drag otherwise gets an idle run, which the replayed pin reheats at the drag heat;
 * - a drag released since the last harvest — or while the move waited for its device (`released`) — gets the
 *   whole re-cool its release started;
 * - a re-cool after a drag goes on over its tail, as a re-cool;
 * - a settled layout gets an idle run, alive for a later drag (spec §15 Q3).
 */
export function continuationOf(state: Readonly<GpuRunState>, dragging: boolean, released = false): Continuation {
  const warm = { heat: state.heat, decaying: state.decaying };
  if (state.mode === "run" && state.ticksLeft > 0) return { iterations: state.ticksLeft, warm };
  if (dragging) return { iterations: 0, warm };
  if (state.mode === "drag" || released) return { iterations: RECOOL_TICKS, warm: { heat: DRAG_HEAT, decaying: true, recool: true } };
  if (state.mode === "cool") return { iterations: state.ticksLeft, warm: { ...warm, recool: true } };
  return { iterations: 0, warm };
}

/**
 * A GPU layout's fallback to the worker that is a fault rather than an unsupported device or graph
 * (#375): its device promise rejected, or its run threw or stopped. `cause` is the error, when there is
 * one; a fault without one (a solve that stopped) is `{ kind: "failure" }`.
 */
export interface GpuLayoutFailure {
  readonly kind: "failure";
  readonly cause?: unknown;
}

/**
 * Print a GPU layout's fallback warning — the one rule the flat run and the nested solve (#355) share
 * (#375): a `failure` always warns, passing its `cause` when there is one; an unsupported device or
 * graph warns unless the caller expects the worker (`warnUnsupported: false`, `layout({ backend: "auto" })`).
 * The call site says which it is, never the error value: a rejection or throw with `undefined` is still
 * a failure.
 */
export function warnGpuFallback(message: string, warnUnsupported: boolean | undefined, failure?: GpuLayoutFailure): void {
  if (failure) {
    if (failure.cause === undefined) console.warn(message);
    else console.warn(message, failure.cause);
  } else if (warnUnsupported !== false) {
    console.warn(message);
  }
}

/**
 * Start a GPU-accelerated layout run. Returns a {@link WorkerLayoutHandle}-shaped object so the
 * engine treats it identically to the worker backend. `onFrame` runs inside the transport's animation
 * frame, right after positions reached the graph and at most once per frame, so a caller may repaint
 * synchronously there (the transport times it to size its repaint throttle); the worker fallback calls it
 * per worker message. `onLODTree` gets the LOD tree streamed by a worker — the fallback's, or with `lod` on
 * the GPU run's LOD worker (#377): the structure tree once, or every rebuilt spatial tree with its streamed
 * handle (#343) — and, from the GPU run only, `null` if that worker fails.
 *
 * Accepts a `Device | null | Promise<Device | null>` so `network.ts` can pass a **device promise**
 * that resolves after the backend settles (including the `"auto"` → WebGL background upgrade).
 * When passed a plain `Device | null` value it resolves synchronously.
 *
 * - If `gpuLayoutSupport` rejects the device for this graph → one warning with the reason (none with
 *   `warnUnsupported: false`), then {@link startWorkerLayout} with the same options and `onLODTree` (it
 *   has its own sync fallback).
 * - Otherwise: starts the seed's coarsening worker, seeds a disc (on screen until the multilevel seed's first
 *   frame), compiles the run's programs (see the module header), constructs {@link GpuForceLayout}, and streams
 *   the run ({@link GpuStream})
 *   until it has converged or `iterations` are done; `settled` resolves once the final positions have been
 *   harvested.
 *
 * `onTransport` reports each resolution before its run starts — so before any frame or LOD tree
 * arrives — and again when the layout moves (#311). A run whose programs compile first reports `"gpu"` when the
 * compile starts; should a link or the probe then fail, it moves to `"worker"` (a second report). The handle's `transport` / `shared` read the live
 * state (#297): `"pending"` while waiting for a device, then `"gpu"` or `"worker"`. `moveDevice`
 * continues a GPU run on another device (see the module header).
 */
export function startGpuLayout(
  deviceOrPromise: DeviceSource,
  graph: NetworkGraph,
  opts: GpuLayoutOptions,
  onFrame: () => void,
  onLODTree?: OnLODTree,
  onTransport?: (transport: GpuLayoutTransport) => void,
): WorkerLayoutHandle {
  // Nothing to lay out: one paint, without waiting for a device promise.
  if (deviceOrPromise instanceof Promise && graph.nodeCount === 0) {
    onFrame();
    return { shared: false, settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} };
  }
  const run = new GpuLayoutRun(graph, opts, onFrame, onLODTree, onTransport);
  // A warm start (`opts.warm`) continues the current positions on either transport, as the worker does.
  const { warm } = opts;
  run.begin(deviceOrPromise, warm && (() => ({ iterations: opts.iterations, warm })), (reason) => `fell back to the CPU worker: ${reason}`, true);
  return run;
}

/** What a start produced: the run's handle, and its GPU stream when it runs on the GPU. */
interface Launched {
  handle: WorkerLayoutHandle;
  stream: GpuStream | null;
}

/**
 * The handle `startGpuLayout` returns: one object for the layout's whole life, whatever runs it — a GPU
 * stream, a worker, or nothing while it waits for a device — so the engine's references to it (its settle
 * handler, a live drag) survive a move to another device (#311).
 */
class GpuLayoutRun implements WorkerLayoutHandle {
  /** Resolves once the layout first converges (on whichever transport), or on {@link stop}. */
  readonly settled: Promise<void>;
  private resolveSettled: () => void = () => {};
  private rejectSettled: (e: unknown) => void = () => {};

  /** The run in progress — a GPU stream's handle or a worker's — null while waiting for a device. */
  private inner: WorkerLayoutHandle | null = null;
  /** The GPU stream behind {@link inner}, while the layout runs on the GPU: what a move stops. */
  private stream: GpuStream | null = null;
  /** Bumped by every start and by {@link stop}: a device that resolves for an older one starts nothing. */
  private generation = 0;
  private stopped = false;
  /**
   * The live drag, replayed onto the run a move starts: the engine's held ids and positions (arrays it
   * reuses across pointer moves, so these references always carry the newest values).
   */
  private heldIds: Uint32Array | null = null;
  private heldPositions: Float32Array | undefined = undefined;
  private dragging = false;
  /** A drag was live when the GPU run last moved, or began while the move waited for its device (#311). */
  private dragSinceMove = false;
  /** The leaf style `style()` last sent a spatial LOD stream (#343); a run started after it gets it too. */
  private lodStyle: { style: LeafStyle; version: number } | null = null;
  /** The view the engine last sent a spatial LOD stream (#433); likewise. */
  private lodView: LODView | null = null;
  /** The run whose programs are compiling (#385): {@link inner} is its placeholder handle meanwhile. */
  private compiling: Compiling | null = null;

  constructor(
    private readonly graph: NetworkGraph,
    private readonly opts: GpuLayoutOptions,
    private readonly onFrame: () => void,
    private readonly onLODTree: OnLODTree | undefined,
    private readonly onTransport: ((transport: GpuLayoutTransport) => void) | undefined,
  ) {
    this.settled = new Promise<void>((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
  }

  // Live (#297): whatever the current run reports now, not a value copied when it started.
  get shared(): boolean {
    return this.inner?.shared ?? false;
  }

  get transport(): "gpu" | "worker" | "pending" {
    return this.inner ? (this.inner.transport ?? "worker") : "pending";
  }

  /**
   * Start a run on `device` — at once for a value, once it resolves for a promise — continuing where
   * `resume` says when the layout moved: asked when the run starts, so a drag that ends while the device is
   * pending still counts. `fallback` words the warning for a device the GPU path cannot use; `failure` makes
   * that warning unconditional (a lost context or a non-finite layout is a fault, not an unsupported
   * device, #375); `replay` re-applies a live drag to the new run.
   */
  begin(device: DeviceSource, resume: (() => Continuation) | undefined, fallback: (reason: string) => string, replay: boolean, failure = false): void {
    const generation = ++this.generation;
    const start = (d: Device | null | undefined): void => {
      if (this.generation === generation) this.adopt(this.launch(d, resume?.(), fallback, failure, replay), replay);
    };
    if (!(device instanceof Promise)) {
      start(device);
      return;
    }
    const toWorker = (reason: string, cause: unknown): void => {
      if (this.generation !== generation || this.inner) return;
      this.adopt({ handle: this.fallBackToWorker(fallback(reason), resume?.(), { kind: "failure", cause }), stream: null }, replay);
    };
    device
      .then(start, (e: unknown) => toWorker("the device promise rejected", e))
      // The GPU run failed to start (e.g. a driver rejected a shader): the worker still lays it out.
      .catch((e: unknown) => toWorker("the GPU layout failed to start", e));
  }

  moveDevice(next: Promise<Device | null | undefined>): void {
    if (this.stopped) return;
    const swapped = (reason: string): string => `continues on the CPU worker after a render-backend swap: ${reason}`;
    const compiling = this.compiling;
    if (compiling && compiling.handle && this.inner === compiling.handle) {
      // Its programs were compiling on the device that goes away (#385): abandon them and start again on `next`,
      // afresh (nothing was painted) or with the continuation it was started with.
      const { cont } = compiling;
      this.inner = null;
      compiling.handle.stop();
      this.dragSinceMove = this.dragging;
      this.begin(next, cont ? () => cont : undefined, swapped, true, false);
      return;
    }
    const stream = this.stream;
    if (!stream) return; // a worker run is not bound to a device; a pending one waits for `next` anyway
    this.move(stream, next, swapped, true, false);
  }

  pin(ids: Uint32Array, positions?: Float32Array): void {
    this.heldIds = ids;
    this.heldPositions = positions;
    this.dragging = true;
    this.dragSinceMove = true;
    this.inner?.pin(ids, positions);
  }

  unpin(): void {
    this.dragging = false;
    this.inner?.unpin();
  }

  /**
   * A new leaf style for a spatial LOD stream (#343, after `style()`): the current run's — its LOD worker's,
   * or the worker fallback's — and the one a move or a pending device starts, which is launched with it.
   */
  readonly setLODStyle = (style: LeafStyle, version: number): void => {
    this.lodStyle = { style, version };
    this.inner?.setLODStyle?.(style, version);
  };

  /**
   * The engine's new view for a spatial LOD stream's super-edge rows (#433): the current run's, and a later
   * one's. (Both are bound: the engine may call them detached from the handle, as it does a worker handle's.)
   */
  readonly setLODView = (view: LODView): void => {
    this.lodView = view;
    this.inner?.setLODView?.(view);
  };

  /** The options a run starts with: the layout's, with the latest spatial leaf style and view (#343, #433). */
  private get runOpts(): GpuLayoutOptions {
    const style = this.lodStyle;
    const view = this.lodView;
    return {
      ...this.opts,
      ...(style ? { lodStyle: style.style, lodStyleVersion: style.version } : {}),
      ...(view ? { lodView: view } : {}),
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.stream = null;
    // `inner` stays, so `transport` keeps reporting what ran (a GPU stream stops through its handle).
    this.inner?.stop();
    this.resolveSettled();
  }

  /**
   * Stop the GPU run (freeing its GPU resources, or on a lost context only dropping them, and its LOD and
   * seed workers) and continue the layout on `next` from where the run stood at its last painted positions
   * (#311) — or afresh, when a seeded run has painted nothing yet (#353: the disc on screen is a placeholder).
   */
  private move(stream: GpuStream, next: DeviceSource, fallback: (reason: string) => string, replay: boolean, failure: boolean): void {
    const painted = stream.runState();
    const state: GpuRunState | null = painted ? { ...painted } : null;
    this.dragSinceMove = this.dragging;
    const inner = this.inner;
    this.inner = null;
    this.stream = null;
    inner?.stop();
    // Decided when the next run starts: a drag released while `next` was pending gets its re-cool.
    const resume = state ? () => continuationOf(state, this.dragging, this.dragSinceMove && !this.dragging) : undefined;
    this.begin(next, resume, fallback, replay, failure);
  }

  /** The GPU run stopped by itself: its context was lost, or its layout turned non-finite. */
  private interrupted(stream: GpuStream, reason: string, cause: "lost" | "non-finite"): void {
    if (this.stream !== stream || this.stopped) return;
    const detail = cause === "non-finite" ? " from the last finite positions" : "";
    // A drag that fed the layout a non-finite position would only poison the worker too: the drag's next
    // pointer move pins again.
    this.move(stream, null, () => `continues on the CPU worker${detail}: ${reason}`, cause !== "non-finite", true);
  }

  private adopt(launched: Launched, replay: boolean): void {
    const { handle } = launched;
    this.inner = handle;
    this.stream = launched.stream;
    handle.settled.then(
      () => {
        if (this.inner === handle) this.resolveSettled();
      },
      (e: unknown) => {
        if (this.inner === handle) this.rejectSettled(e);
      },
    );
    if (replay && this.dragging && this.heldIds) handle.pin(this.heldIds, this.heldPositions);
  }

  /**
   * The worker run for a device the GPU path cannot use, continuing `cont` when the layout moved. It warns
   * once with `message` under {@link warnGpuFallback}'s rule: always for a `failure` (the device promise
   * rejected, the GPU run threw, its context was lost or its layout turned non-finite), and for an
   * unsupported device or graph unless the caller expects the worker (`warnUnsupported: false`, #375).
   */
  private fallBackToWorker(message: string, cont: Continuation | undefined, failure?: GpuLayoutFailure): WorkerLayoutHandle {
    warnGpuFallback(`[d3gl] the GPU network layout ${message}.`, this.opts.warnUnsupported, failure);
    this.onTransport?.("worker");
    const opts = cont ? { ...this.runOpts, iterations: cont.iterations, warm: cont.warm } : this.runOpts;
    const worker = startWorkerLayout(this.graph, opts, this.onFrame, this.onLODTree);
    const setLODStyle = worker.setLODStyle;
    const setLODView = worker.setLODView;
    return {
      get shared() { return worker.shared; }, // live: it flips on a worker error (#297)
      transport: "worker",
      settled: worker.settled,
      stop: () => worker.stop(),
      pin: (ids, positions) => worker.pin(ids, positions),
      unpin: () => worker.unpin(),
      ...(setLODStyle ? { setLODStyle } : {}),
      ...(setLODView ? { setLODView } : {}),
    };
  }

  /**
   * Decide GPU vs worker for this graph on `device`, and start that run (#385): on the device's features and
   * limits — or, probed for an earlier layout, its whole cached record, so a failed probe falls back at once —
   * start the coarsening and seed the disc, then compile every program the run builds in parallel
   * ({@link compilePrograms}); the probe runs and the solver is built once they have linked, in a later frame
   * ({@link compiled}). Without anything to compile ahead, it builds at once.
   */
  private launch(device: Device | null | undefined, cont: Continuation | undefined, fallback: (reason: string) => string, failure: boolean, replay: boolean): Launched {
    const { graph, onLODTree } = this;
    const opts = this.runOpts;
    const fault: GpuLayoutFailure | undefined = failure ? { kind: "failure" } : undefined;
    const need = gpuLayoutNeed(graph.nodeCount, graph.edgeCount);
    const verdict = gpuLayoutSupport(cachedGpuCaps(device) ?? gpuStaticCaps(device), need);
    if (!verdict.ok || !device) {
      // (`!device` never reaches here with `ok`: no device has no caps, which never pass.)
      return { handle: this.fallBackToWorker(fallback(verdict.ok ? "no WebGL device" : verdict.reason), cont, fault), stream: null };
    }
    // The checks passed, so this is a WebGL2 device: the streaming readback needs its raw context.
    if (!(device instanceof WebGLDevice)) {
      return { handle: this.fallBackToWorker(fallback("no WebGL2 device"), cont, fault), stream: null };
    }

    // 0-node graph: GpuForceLayout would create a zero-height texture (crash).
    // Return a no-op handle immediately — there is nothing to lay out.
    if (graph.nodeCount === 0) {
      const probed = gpuLayoutSupport(gpuCaps(device), need);
      if (!probed.ok) return { handle: this.fallBackToWorker(fallback(probed.reason), cont, fault), stream: null };
      this.onTransport?.("gpu");
      this.onFrame();
      return { handle: { shared: false, transport: "gpu", settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} }, stream: null };
    }

    const coarsening = startCoarsening(graph, opts, onLODTree, cont);
    // The disc at the force equilibrium's scale: on screen until the seed's first frame (the same scale, so
    // that frame rearranges the layout without zooming), and a cold start's seed — unless the layout moved
    // here (#311), when `graph.positions` holds where it left off.
    if (!cont) seedPositions(graph, opts.width, opts.height, { force: opts.force });
    // Every program the run builds — the probe's, the solver's (its seed's too) and the readback's — compiled at
    // once and in parallel (#385), while the coarsening worker boots; null: nothing to compile ahead, build now.
    const programs = [blendProbeProgram(), ...GpuForceLayout.programs(withModuleSprings(graph, opts.moduleSprings), { multilevel: coarsening.seeded }), ...AsyncPositionReadback.programs(device, false)];
    const record: Compiling = { device, cont, fallback, fault, replay, coarsening, handle: null, compile: null };
    let compile: ProgramCompile | null;
    try {
      compile = compilePrograms(device, programs, (outcome) => this.compiled(record, outcome));
    } catch (error) {
      releaseCoarsening(coarsening); // the caller falls back to a worker run, which streams its own tree
      throw error;
    }
    if (!compile) return this.build(record, false);
    record.compile = compile;
    // Resolved to the GPU: reported now, not a compile later, so the engine builds no LOD tree of its own
    // while one is coming — or, with no LOD worker, builds it now. A failed link or probe moves it to the worker.
    this.onTransport?.("gpu");
    if (opts.lod && !coarsening.relay) onLODTree?.(null);
    const { relay } = coarsening;
    const handle: WorkerLayoutHandle = {
      shared: false,
      transport: "gpu",
      settled: new Promise<void>(() => {}), // the built run's settles the layout
      stop: () => {
        if (this.compiling === record) this.compiling = null;
        compile.cancel();
        releaseCoarsening(coarsening);
      },
      // A drag during the compile is replayed onto the run once it exists (see {@link adopt}).
      pin() {},
      unpin() {},
      ...(relay && streamsSpatial(opts) ? { setLODStyle: (style: LeafStyle, version: number) => relay.setStyle(style, version) } : {}),
      ...(relay && streamsSpatial(opts) ? { setLODView: (view: LODView) => relay.setView(view) } : {}),
    };
    record.handle = handle;
    this.compiling = record;
    return { handle, stream: null };
  }

  /**
   * The run's programs finished compiling (#385): build it once every one has linked; fall back to the worker
   * with one warning if one failed to link or the build throws; continue on the worker if the context was lost
   * meanwhile, as a lost context does during a run (#311).
   */
  private compiled(record: Compiling, outcome: CompileOutcome): void {
    if (this.compiling !== record || this.stopped || !record.handle || this.inner !== record.handle) return;
    this.compiling = null;
    const { cont, fallback, replay, coarsening } = record;
    if (outcome.status === "lost") {
      releaseCoarsening(coarsening);
      this.inner = null;
      this.begin(null, cont ? () => cont : undefined, () => "fell back to the CPU worker: the WebGL context was lost while the layout's programs compiled", replay, true);
      return;
    }
    let launched: Launched;
    if (outcome.status === "failed") {
      releaseCoarsening(coarsening);
      launched = { handle: this.fallBackToWorker(fallback("a GPU layout program failed to link"), cont, { kind: "failure", cause: outcome.reason }), stream: null };
    } else {
      try {
        launched = this.build(record, true);
      } catch (error) {
        // A driver rejected a program, or a resource could not be created: the worker still lays it out.
        launched = { handle: this.fallBackToWorker(fallback("the GPU layout failed to start"), cont, { kind: "failure", cause: error }), stream: null };
      }
    }
    this.adopt(launched, replay);
  }

  /**
   * Run the float-blend probe (its program compiled by now) and build the solver and the stream, and start the
   * run. `reported`: the transport was reported when the compile started. Throws, with the coarsening freed, when
   * the solver or the stream cannot be built.
   */
  private build(record: Compiling, reported: boolean): Launched {
    const { graph, onLODTree } = this;
    const opts = this.runOpts;
    const { device, cont, fallback, fault, coarsening } = record;
    const probed = gpuLayoutSupport(gpuCaps(device), gpuLayoutNeed(graph.nodeCount, graph.edgeCount));
    if (!probed.ok) {
      releaseCoarsening(coarsening);
      return { handle: this.fallBackToWorker(fallback(probed.reason), cont, fault), stream: null };
    }
    const { modulePlan, relay, seedWorker, seeded } = coarsening;
    const { force } = opts;
    const iterations = cont ? cont.iterations : (opts.iterations ?? 300);
    let layout: GpuForceLayout;
    try {
      // The module links pull too (#455): the solver's view of the graph carries them as springs.
      layout = new GpuForceLayout(device, withModuleSprings(graph, opts.moduleSprings), { ...DEFAULT_FORCE, ...force }, { multilevel: seeded });
    } catch (error) {
      releaseCoarsening(coarsening); // the caller falls back to a worker run, which streams its own tree
      throw error;
    }
    // As the CPU worker (#124): a cold disc start keeps full heat to untangle (see ForceLayout.run); a seeded
    // run cools over the iteration budget once the seed has placed the nodes (the stream sets it); a moved
    // layout resumes its own schedule (#311). Either way the stream stops the run once it has converged (the
    // solver's per-tick stop latch, #376), or when the budget is spent.
    if (cont) {
      if (cont.warm.decaying) layout.cool(iterations, cont.warm.heat);
      else layout.hold(cont.warm.heat);
    } else if (!seeded) layout.hold(1);

    // A followed stream (#454) — never with the LOD relay, whose tree geometry is the solve's — reads each frame
    // back into the array its follower asks for, and paints it itself once the follower hands it back.
    const follow = relay ? undefined : opts.follow;
    const onFrame = follow ? (): void => void (follow.onFrame(follow.target()) || this.onFrame()) : this.onFrame;
    let started: GpuStream;
    try {
      started = new GpuStream(device, layout, graph, {
        iterations,
        ...(opts.frameEvery !== undefined ? { frameEvery: opts.frameEvery } : {}),
        ...(relay ? { sink: relay } : follow ? { sink: new DirectSink(graph, () => follow.target()) } : {}),
        seeded,
        ...(cont ? { resumed: { recool: cont.warm.recool === true } } : {}),
        onInterrupt: (reason, cause) => this.interrupted(started, reason, cause),
      }, onFrame);
    } catch (error) {
      // The readback's programs or buffers failed: free the solver before the caller falls back.
      layout.destroy();
      releaseCoarsening(coarsening);
      throw error;
    }
    coarsening.stream = started;
    if (!reported) {
      // Reported once every GPU resource exists, so a failed start reports only the fallback's "worker";
      // still before the first frame, and before the LOD tree (a later task).
      this.onTransport?.("gpu");
      // LOD on but no worker to build the tree (or an edge-less graph's structure tree, which does not coarsen):
      // the caller builds it.
      if (opts.lod && !relay) onLODTree?.(null);
    }
    // The run goes ahead on the GPU: only now is a coarsening worker that could not start worth a warning (a
    // fallback would have run the worker's own layout instead), and the relay prints a failure it held (#385).
    const warning = coarsening.warning;
    if (warning?.cause !== undefined) console.warn(warning.message, warning.cause);
    else if (warning) console.warn(warning.message);
    relay?.arm();
    if (modulePlan) started.seed(modulePlan);
    else if (coarsening.earlyPlan !== undefined) started.seed(coarsening.earlyPlan);
    started.start();

    return {
      handle: {
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
        /** A new leaf style for the spatial tree the LOD worker rebuilds per frame (#343). */
        ...(relay && streamsSpatial(opts) ? { setLODStyle: (style: LeafStyle, version: number) => relay.setStyle(style, version) } : {}),
        /** The engine's new view, whose kept glyphs' super-edge rows the LOD worker builds with each tree (#433). */
        ...(relay && streamsSpatial(opts) ? { setLODView: (view: LODView) => relay.setView(view) } : {}),
      },
      stream: started,
    };
  }
}

/** A deferred `console.warn`. */
interface Warning {
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * What a GPU run's multilevel seed and LOD tree come from, started before its programs compile (#385), and the
 * stream the seed plan goes to once it exists.
 */
interface Coarsening {
  /** A provided module tree's plan (built on this thread), or null. */
  readonly modulePlan: SeedPlan | null;
  /** The LOD relay (LOD on), unarmed until the stream exists; it builds the seed's plan too. */
  readonly relay: LODRelay | null;
  /** The seed-only coarsening worker (LOD off). */
  readonly seedWorker: SeedWorker | null;
  /** Whether the run seeds multilevel (a plan will come) — the solver is then built `multilevel`. */
  readonly seeded: boolean;
  /** A warning about a worker that could not start, printed only once the GPU run's stream exists (#385). */
  readonly warning: Warning | null;
  /** A seed plan that arrived before the stream (null: the worker could not build one). */
  earlyPlan: SeedPlan | null | undefined;
  /** The run's stream, once it exists: the worker's plan goes straight to it. */
  stream: GpuStream | null;
}

/** A run whose programs are compiling (#385): what its build needs, and the placeholder handle it runs under. */
interface Compiling {
  readonly device: WebGLDevice;
  readonly cont: Continuation | undefined;
  readonly fallback: (reason: string) => string;
  readonly fault: GpuLayoutFailure | undefined;
  readonly replay: boolean;
  readonly coarsening: Coarsening;
  handle: WorkerLayoutHandle | null;
  compile: ProgramCompile | null;
}

/**
 * Start the multilevel seed's coarsening (#312, #353) — not for a layout that moved here (#311), whose positions
 * are on screen: from the provided module tree when there is one (its plan is built here, as the module seed
 * always was), else from the graph's coarsening, which a layout worker builds — the LOD relay's worker with LOD
 * on (one coarsening for the tree and the seed; or, for the spatial tree, #343, standing ready to rebuild it per
 * frame, coarsening only for the seed's plan), else a seed-only worker. The relay starts unarmed: its tree waits
 * until the stream exists (#385: the solver may be built frames later).
 */
function startCoarsening(graph: NetworkGraph, opts: GpuLayoutOptions, onLODTree: OnLODTree | undefined, cont: Continuation | undefined): Coarsening {
  const { width, height, force } = opts;
  const multilevel = !cont && (opts.multilevel ?? true) && graph.edgeCount > 0;
  const planOptions: SeedPlanOptions = { width, height, ...(force ? { force } : {}) };
  const modulePlan = multilevel && opts.moduleTopology ? moduleSeedPlan(opts.moduleTopology, graph, planOptions) : null;
  const coarsenSeed = multilevel && !modulePlan;
  // The worker's plan may only be handed to the stream once it exists (#385: frames later when the programs
  // compile first); until then it waits here.
  let coarsening: Coarsening | null = null;
  let earlyPlan: SeedPlan | null | undefined;
  const seedRequest: SeedRequest = {
    options: planOptions,
    onPlan: (plan) => {
      if (coarsening?.stream) coarsening.stream.seed(plan);
      else if (coarsening) coarsening.earlyPlan = plan;
      else earlyPlan = plan;
    },
  };
  // With LOD on, the LOD worker coarsens for both the tree and the seed (#377). If it cannot start, no second
  // worker is tried for the seed: the relay's one warning covers both.
  const lodWorker = opts.lod === true && onLODTree !== undefined;
  const lod = lodWorker && onLODTree ? startLODRelay(graph, opts, onLODTree, coarsenSeed ? seedRequest : null) : null;
  const seed = coarsenSeed && !lodWorker ? startSeedWorker(graph, opts, seedRequest) : null;
  const relay = lod?.relay ?? null;
  const seedWorker = seed?.worker ?? null;
  coarsening = {
    modulePlan,
    relay,
    seedWorker,
    seeded: modulePlan !== null || (coarsenSeed && (relay !== null || seedWorker !== null)),
    warning: lod?.warning ?? seed?.warning ?? null,
    earlyPlan,
    stream: null,
  };
  return coarsening;
}

/** Free a coarsening a stream never took over: its workers (the run fell back, stopped or moved). */
function releaseCoarsening(coarsening: Coarsening): void {
  coarsening.relay?.destroy();
  coarsening.seedWorker?.destroy();
}

/** Whether a run with these options streams the spatial LOD tree (#343), whose style it aggregates itself. */
function streamsSpatial(opts: GpuLayoutOptions): boolean {
  return opts.lod === true && opts.lodSource === "spatial";
}

/**
 * The GPU run's LOD tree, built and refit in a layout worker (#377) — or, for the spatial source (#343),
 * rebuilt there for every harvested frame — started unarmed (#385: it precedes its stream), or none where no
 * worker can run, with the warning the run prints if it goes ahead on the GPU. An edge-less graph's structure
 * tree is none, and no warning: it does not coarsen (the engine asks for the spatial tree there anyway).
 */
function startLODRelay(graph: NetworkGraph, opts: GpuLayoutOptions, onLODTree: OnLODTree, seed: SeedRequest | null): { relay: LODRelay | null; warning: Warning | null } {
  const spatial = streamsSpatial(opts);
  if (graph.edgeCount === 0 && !spatial) return { relay: null, warning: null };
  const instead = seed
    ? "the LOD tree is built on the main thread and the layout starts from a disc instead of its multilevel seed"
    : "the LOD tree is built on the main thread instead";
  const worker = spawnLayoutWorker();
  if (!worker) {
    return { relay: null, warning: { message: `[d3gl] network layout({ backend: 'gpu' }): no LOD worker could start; ${instead}.` } };
  }
  try {
    const source = spatial ? { source: "spatial" as const, style: opts.lodStyle, styleVersion: opts.lodStyleVersion, view: opts.lodView } : {};
    return { relay: new LODRelay(worker, graph, { coarsen: opts.coarsen, ...source }, onLODTree, seed, false), warning: null };
  } catch (error) {
    // The coarsen request could not be posted; the relay freed its worker. The run withdraws the tree once it
    // has reported the transport.
    return { relay: null, warning: { message: `[d3gl] network layout({ backend: 'gpu' }): a message to the LOD worker failed; ${instead}.`, cause: error } };
  }
}

/**
 * The multilevel seed's coarsening worker with LOD off (#353), or none where no worker can run — with the
 * warning the run prints if it goes ahead (the layout starts from its disc).
 */
function startSeedWorker(graph: NetworkGraph, opts: GpuLayoutOptions, seed: SeedRequest): { worker: SeedWorker | null; warning: Warning | null } {
  const port = spawnLayoutWorker();
  if (!port) {
    return { worker: null, warning: { message: "[d3gl] network layout({ backend: 'gpu' }): no layout worker could start to coarsen the graph; the layout starts from a disc instead of its multilevel seed." } };
  }
  try {
    return { worker: new SeedWorker(port, graph, opts.coarsen, seed.options, seed.onPlan), warning: null };
  } catch (error) {
    return { worker: null, warning: { message: "[d3gl] network layout({ backend: 'gpu' }): a message to the layout worker failed; the layout starts from a disc instead of its multilevel seed.", cause: error } };
  }
}
