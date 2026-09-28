/**
 * The GPU layout's streaming run (#352, spec §6.5): one animation frame at a time, the solver's work
 * items are encoded within a GPU time budget and positions come back through a fenced PBO — the main
 * thread never waits for the GPU.
 *
 * Each frame runs, in this order:
 *
 * 1. **Harvest + repaint (throttled).** Poll the budget fences ({@link FrameBudget.beginFrame}). If the
 *    frame that copied the last readback has completed *and* the {@link RepaintThrottle} says the repaint
 *    is due (`max(minFrameMs, 2 × max(repaint main-thread ms, the GPU stall it caused))` since the previous
 *    one), `getBufferSubData` the copy into `graph.positions` and run `onFrame` right away — in this same
 *    frame, so the engine repaints the harvested positions with no extra frame of delay, its draw calls
 *    reach the GPU before this frame's layout work, and `graph.positions` only ever changes right before a
 *    repaint (a finished copy waits in its PBO until the repaint is due). A read that is not ready is never
 *    forced, and it happens before any encode, so nothing it could wait on is freshly queued. A hidden page
 *    pauses the throttle's stall sampling, so the time a tab spent hidden never delays the next repaint.
 * 2. **Encode.** Work items while the {@link FrameBudget} admits them: at most 33 ms of frames of layout
 *    work in flight (`framesInFlight`: 2 frames at 60 Hz, 4 at 120 Hz), a GPU budget of `min(10 ms,
 *    0.6 × rAF interval)` per frame, and at most 2 ms of encode time. A tick is a sequence of passes
 *    (`stream-schedule.ts`) — the solver's, or a step of the multilevel seed, which the stream supplies
 *    itself (below) — and every pass is cut into row bands sized to the budget (at most half of it, or all
 *    of it for a pass whose every band pays a long fixed cost; #382), each band one item. So a frame's
 *    *estimated* layout GPU work stays within the budget, save a first item that alone passes it: a band
 *    whose fixed cost alone passes three quarters of the budget; the flat layout's P and I, which run whole
 *    (P's estimate passes the 120 Hz budget above ~1M nodes, #429); and a band of a pass already cut into
 *    its rows or its 64 bands (`MAX_BANDS`). A tick may span frames; its result does not depend on how it
 *    was sliced.
 * 3. **Readback + copy + fence.** On the repaint's cadence (reading back more often than repainting is
 *    waste), and when the one PBO is free, the solver's readback passes run as items too (the nested
 *    layout's composition), exclusively — no tick item runs until the copy — over as many frames as the
 *    budget needs; then the positions are copied into the PBO. Every frame ends with its single budget
 *    fence, which doubles as the fence of a copy issued in it. The copy carries the reductions' stats, and
 *    they always describe the copied positions: for the flat layout, positions change only at a tick's
 *    integrate and at its prep (where a drag's held positions are written, never mid-tick), so a copy
 *    after a prep reuses that prep's stats and a copy between ticks re-runs the reductions first
 *    ({@link GpuForceLayout.refreshSegmentStats}); the nested layout's readback passes reduce the positions
 *    they compose.
 *
 * **Where a harvest goes** is the stream's {@link FrameSink}. By default ({@link DirectSink}) it lands in
 * `graph.positions` and is painted in the same frame. With LOD on (#377) the `LODRelay` (`lod-relay.ts`)
 * takes it instead: the LOD worker refits the tree's geometry to the harvested positions, and the frame is
 * painted — positions and geometry put on the graph together — in the first frame after the worker replied
 * and the repaint is due; with the spatial source (#343) the worker rebuilds the tree for the harvested
 * positions instead, and the commit hands it to the engine with them. The throttle harvests one round trip
 * early for it, so the repaint cadence holds.
 *
 * **A multilevel seed** (#353, spec §6.4) runs first when the stream is `seeded`: once its plan arrives
 * ({@link GpuStream.seed}; the layout worker builds it), the seed's levels are work items of the same loop,
 * under the same budget: the stream is the schedule's stage source and wraps the solver's ticks with the
 * seed's steps — each level's placement (`setLevel`, one item), then its ticks (the solver's passes over the
 * level's slots and rows, its force pass sliced by the level's own cost; a tick that fits half the budget
 * whole is one item), and finally the placement of the graph's nodes (`endSeed`). Nothing is read back during the seed
 * (the solver's slots hold coarse levels, not node positions): the first copy is the **seed frame** (tick
 * 0), and until it is painted the disc the transport seeded stays on screen. A drag's pins wait for the
 * graph's level; `stop()` during the seed drops its fences and frees its resources; with no iterations the
 * seed frame is the final one. Without a plan (the worker failed) the run starts cold from that disc. The seed's
 * textures are created when the plan arrives, outside the frame loop (its programs were compiled with the
 * solver); if that fails the run starts cold as well, and a seed step that throws mid-seed frees the seed and
 * settles with the disc on screen, one warning each, so `settled` always resolves.
 *
 * **Convergence stop (#376).** A run and a post-drag re-cool stop once the layout has converged, by the
 * CPU's rule, decided on the GPU once per tick: the solver's stop latch (`stop-latch.ts`) freezes the
 * integrate at the stop tick, and every copy carries the latch's texel with the stats. The stream arms the
 * latch in `run` and `cool` mode and disarms it in `drag`, as the worker checks `converged` only there,
 * and it keeps encoding (frozen) ticks until a harvest shows the stop in the current schedule: those
 * positions are the stop tick's, so the run finishes on them (with LOD on, once the relayed frame is
 * painted). The stop tick does not depend on frame timing, band count or when the copies happened. The
 * latch reads the graph's level only: a multilevel seed's levels never stop it (#353).
 *
 * `settled` resolves only after positions from the final tick — the stop tick, or the last of the budget —
 * have been harvested and painted (with LOD on, together with the LOD tree's geometry for them), so the
 * engine's settle handler sees them. The run then goes **idle** (the layout stays alive for a drag reheat,
 * #183).
 * A non-finite layout (NaN / ∞ in the reductions' stats) stops the run, keeping the last finite positions —
 * the harvest checks the stats before it touches `graph.positions`. A lost context (`isContextLost`, a
 * failed fence wait, `webglcontextlost`) stops it without touching GL again (a fence wait that failed on a
 * context that is still alive frees the run's GPU objects as it stops). Either way the run tells its
 * owner (`onInterrupt` with its cause, or `onFailure` — the nested layout lays the map out on the worker
 * instead, #355), or warns once. Each copy records where the run stands at its positions — mode,
 * ticks left, heat — and the frame painted from it keeps that record ({@link GpuStream.runState}), so a
 * stopped run can continue elsewhere from the positions on screen (#311): after a render-backend swap, a
 * lost context, or a non-finite layout.
 */
import { WebGLDevice } from "@luma.gl/webgl";
import { DRAG_HEAT, RECOOL_TICKS } from "../force.js";
import type { NetworkGraph } from "../graph.js";
import { deleteSync, insertSync, pollSync } from "../../webgl/fence.js";
import { AsyncPositionReadback, READBACK_STATS_FLOATS, READBACK_STOP_OFFSET, type ReadbackSource } from "./async-readback.js";
import { FrameBudget, flatPassCostMs, type FenceSource } from "./frame-budget.js";
import { NO_STAGES, StreamSchedule, type EstimatedStage, type StageSource, type StreamStage } from "./stream-schedule.js";
import { MIN_FRAME_MS, RepaintThrottle } from "./repaint-throttle.js";
import { reportUncaught } from "./report-uncaught.js";
import type { SeedPlan } from "./seed-plan.js";
import { STOP_NONFINITE, STOP_STOPPED } from "./stop-latch.js";

/**
 * A solver the stream drives, and its own {@link ReadbackSource}: a tick is a sequence of passes
 * ({@link StageSource.tickStages}), each sliced into bands (`stream-schedule.ts`). The flat
 * {@link GpuForceLayout} (prep, force, integrate) and the nested layout's batched solve (#355) are both one.
 * Each work item — a band of a pass — that encodes a render pass ends with one `device.submit()`, and nothing
 * below it submits (#402); a readback copy is one item too — {@link prepareReadback} encodes, and the
 * readback's `issue` submits.
 */
export interface StreamSolver extends ReadbackSource, StageSource {
  /**
   * The last step right before a copy, after any {@link StageSource.readbackStages}: make the readback
   * source's stats describe the current positions. `betweenTicks`: the copy follows a tick's last pass (the
   * next has not started); the flat layout then re-runs its reductions, whose last run was that tick's prep.
   * Encodes without submitting: the copy's `AsyncPositionReadback.issue` submits the whole copy once.
   */
  prepareReadback(betweenTicks: boolean): void;
  destroy(): void;
}

/** A solver that can hold nodes under a drag and reheat (#183) — the flat layout; the nested one cannot. */
export interface DragSolver {
  setPinned(ids: Uint32Array | null): void;
  setHeldPositions(ids: Uint32Array, positions: Float32Array): void;
  hold(heat: number): void;
  cool(ticks: number, from?: number): void;
}

/**
 * The flat layout's own contract with the stream ({@link GpuForceLayout}), on top of a {@link StreamSolver}
 * that drags: the level its ticks run on and its multilevel seed (#353), its stop latch (#376), and its heat
 * schedule, which a moved run continues (#311). A solver without it (the nested one) is never seeded, never
 * stops early and is never moved.
 */
export interface FlatStreamSolver extends StreamSolver, DragSolver {
  /** Slots of the level the ticks run on: the graph's, or a seed level's (its passes cut the level's rows). */
  readonly levelSlots: number;
  /** One whole tick, unsliced: a seed level's tick that fits half the frame budget is one work item. */
  runFrame(ticks: number): void;
  beginSeed(plan: SeedPlan): void;
  setLevel(k: number): void;
  endSeed(): void;
  cancelSeed(): void;
  stopOnConvergence: boolean;
  readonly scheduleEpoch: number;
  readonly heat: number;
  readonly heatDecaying: boolean;
}

function isFlat(solver: StreamSolver): solver is FlatStreamSolver {
  return "beginSeed" in solver && "scheduleEpoch" in solver;
}

/** What one streamed frame did — the argument of a {@link observeGpuLayoutFrames} observer. */
export interface GpuFrameSample {
  /** The frame's rAF timestamp. */
  now: number;
  /** Main-thread ms polling fences, harvesting positions and putting a frame on the graph ({@link commitMs}). */
  harvestMs: number;
  /**
   * Main-thread ms putting the painted frame on the graph (part of {@link harvestMs}): 0 when it was
   * harvested there; with LOD on (#377), copying the relayed positions and their LOD geometry in — or, with
   * the spatial source (#343), the positions and the O(1) adoption of the tree rebuilt for them.
   */
  commitMs: number;
  /** Whether the engine repainted this frame. */
  repainted: boolean;
  /** Main-thread ms inside `onFrame` (the engine's repaint); 0 when this frame did not repaint. */
  repaintMs: number;
  /** Main-thread ms encoding work items, the readback copy and the budget fence. */
  encodeMs: number;
  /** Work items encoded this frame. */
  items: number;
  /**
   * Their estimated GPU time, ms — within `budgetMs` whenever more than one item ran (#382): the budget admits
   * a second item only while the sum fits.
   */
  itemsMs: number;
  /** Ticks completed so far in this run. */
  ticksDone: number;
  /** Whether a readback was harvested this frame. */
  harvested: boolean;
  /**
   * Ticks encoded when the positions harvested this frame were copied (−1 when nothing was harvested). After
   * a convergence stop the ticks encoded before the stream learned of it are frozen: the positions are the
   * {@link stopTick}'s.
   */
  harvestedTicks: number;
  /**
   * The tick the current run's or re-cool's convergence stop latched at, once a harvest has shown it; −1
   * before (#376). A new schedule (a drag) resets it.
   */
  stopTick: number;
  /** Whether a readback copy was issued this frame. */
  copied: boolean;
  /** Whether the gate blocked this frame (the frames `framesInFlight` allows were already in flight). */
  blocked: boolean;
  /** The controller's item cap after this frame, the band count of the last sliced pass started, and the budget. */
  k: number;
  bands: number;
  budgetMs: number;
}

const observers = new Set<(sample: Readonly<GpuFrameSample>) => void>();

/**
 * Observe every streamed GPU layout frame (tests and benchmarks). The sample object is reused across
 * frames — copy what you keep. Returns the unsubscribe function. Costs nothing while nobody observes.
 */
export function observeGpuLayoutFrames(observer: (sample: Readonly<GpuFrameSample>) => void): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/** Options of a streaming run. */
export interface GpuStreamOptions {
  /** Ticks of the initial run. 0 paints the seed and settles at once. */
  iterations: number;
  /**
   * At most one readback (so one `onFrame`) per this many completed ticks, in place of the time
   * throttle — deterministic frame counts for tests. Omitted: the repaint throttle alone sets the cadence.
   */
  frameEvery?: number;
  /** GPU budget per frame before the rAF clamp, ms. Default 10. */
  budgetMs?: number;
  /** Minimum time between repaints, ms. Default {@link MIN_FRAME_MS}. */
  minFrameMs?: number;
  /** Where harvests go before they are painted. Default: a {@link DirectSink} into `graph.positions`. */
  sink?: FrameSink;
  /**
   * Run a multilevel seed first (#353): the stream waits for its plan ({@link GpuStream.seed}) before it
   * ticks, and cools the run over its iterations once the graph's nodes are placed. The layout must be built
   * with `multilevel`.
   */
  seeded?: boolean;
  /**
   * Called in place of the warning when the run stops by itself (#311): its WebGL context was lost or a
   * fence wait failed (the run has then freed its GPU objects, or on a lost context dropped them without a
   * GL call) or its layout turned non-finite (it has stopped encoding). `graph.positions` still holds the last finite harvest, and {@link GpuStream.runState}
   * says where the run stood at it, so the owner can continue the layout elsewhere; it then calls
   * {@link GpuStream.stop}, which frees whatever is left.
   */
  onInterrupt?: (reason: string, cause: "lost" | "non-finite") => void;
  /**
   * The run continues a layout that moved here (#311), from positions already on screen: `iterations` of a
   * re-cool's tail after a drag are resumed as a re-cool (a pin reheats at the drag heat at once, instead of
   * riding the tail as a drag during the initial run does), and an idle start paints nothing.
   */
  resumed?: { recool: boolean };
  /**
   * The solver's drag interface; without one, `pin` / `unpin` do nothing (the nested layout, #355). Default:
   * the solver itself when it drags (the flat layout).
   */
  drag?: DragSolver;
  /**
   * `false`: no intermediate copies — only the final positions are read back and harvested, in one
   * frame (a nested warm start or transition, #328). Default `true`: stream on the repaint cadence.
   */
  stream?: boolean;
  /** Where harvests land instead of `graph.positions` (a caller that eases to the result, #328). */
  into?: Float32Array;
  /** Where a packed source's extra floats land on each harvest (the nested layout's module discs, #355). */
  extra?: Float32Array;
  /**
   * Called once, instead of the warning, when the run stops on a non-finite layout or a lost context —
   * right before `settled` resolves, so the owner can tell a failed run from a finished one (#355). Its
   * argument names the reason. {@link onInterrupt}, when given, is called instead.
   */
  onFailure?: (reason: string) => void;
}

/**
 * Where a harvested readback goes before it is painted (#377). The stream harvests into {@link target},
 * {@link submit}s it, and once the sink is {@link ready} and the repaint is due, {@link commit}s it (puts it
 * on the graph) and runs `onFrame`. The {@link DirectSink} harvests straight into `graph.positions`, ready at
 * once, so a frame is painted where it was harvested. The `LODRelay` (`lod-relay.ts`) harvests into its own
 * buffer and is ready once the LOD worker has refit the LOD tree to it, so positions and their geometry reach
 * the graph together, one worker round trip later.
 */
export interface FrameSink {
  /** Whether a submitted frame is painted after a round trip, not in the frame it was harvested. */
  readonly relays: boolean;
  /** The array the next harvest writes into (2 floats per node), or null while the sink cannot take one. */
  target(): Float32Array | null;
  /** The harvest landed in {@link target}; `ticks` is the ticks it holds (its frame id). */
  submit(ticks: number): void;
  /** A frame can be painted: the submitted one, or one the sink produced (the LOD tree's first geometry). */
  readonly ready: boolean;
  /**
   * Put the ready frame on the graph, just before its repaint. `false` when the frame was lost on its way (the
   * LOD worker failed with it): nothing changed, and the stream copies those ticks again.
   */
  commit(): boolean;
  /** Whether `settled` must wait for the sink (the LOD tree is still being built). */
  readonly holding: boolean;
  /** Call `wake` whenever the sink becomes ready, or stops holding, outside the stream's frame. */
  listen(wake: () => void): void;
  /** Free what the sink owns. */
  destroy(): void;
}

/**
 * The default {@link FrameSink}: harvests land in `graph.positions` — or in `into`, for a caller that eases to
 * the result (#328, #355) — painted in the frame they were harvested.
 */
export class DirectSink implements FrameSink {
  readonly relays = false;
  readonly holding = false;
  private readonly graph: NetworkGraph;
  private readonly into: Float32Array | null;
  private submitted = false;

  constructor(graph: NetworkGraph, into: Float32Array | null = null) {
    this.graph = graph;
    this.into = into;
  }

  target(): Float32Array {
    return this.into ?? this.graph.positions; // `graph.positions` read live: a shared-memory start swaps it
  }

  submit(): void {
    this.submitted = true;
  }

  get ready(): boolean {
    return this.submitted;
  }

  commit(): boolean {
    this.submitted = false;
    return true;
  }

  listen(): void {}

  destroy(): void {}
}

type Mode = "idle" | "run" | "drag" | "cool";

/** What the tick the schedule is running is: the solver's, or a step or a whole level tick of the seed (#353). */
type TickKind = "solver" | "seed-step" | "seed-tick";

/**
 * Where a run stood at a set of positions (#311): those a readback copy holds, then the last ones harvested
 * into `graph.positions`. A run stopped mid-way continues elsewhere from exactly there.
 */
export interface GpuRunState {
  /** What the run was doing. */
  mode: Mode;
  /** Ticks left of that mode's budget: the initial run's, or a re-cool's tail (0 in `drag` and `idle`). */
  ticksLeft: number;
  /** The heat of the next tick. */
  heat: number;
  /** Whether that heat decays (`cool`) or is held (`hold`). */
  decaying: boolean;
}

/** GL sync objects as the frame budget's fences. */
function glFences(gl: WebGL2RenderingContext): FenceSource<WebGLSync | null> {
  return {
    insert: () => insertSync(gl),
    poll: (sync) => pollSync(gl, sync),
    drop: (sync) => deleteSync(gl, sync),
  };
}

/**
 * A running GPU layout: the handle methods (`pin` / `unpin` / `stop`) and `settled`. Owns the solver,
 * the readback and the frame budget, and destroys them on {@link stop}.
 */
export class GpuStream {
  /** Resolves once the initial run's final positions have been harvested, or the run stopped. */
  readonly settled: Promise<void>;

  private readonly gl: WebGL2RenderingContext;
  private readonly layout: StreamSolver;
  /** The flat layout's extras (#353 seed, #376 stop, #311 heat), or null (the nested solve, #355). */
  private readonly flat: FlatStreamSolver | null;
  private readonly drag: DragSolver | null;
  private readonly streaming: boolean;
  private readonly onFailure: ((reason: string) => void) | undefined;
  private readonly graph: NetworkGraph;
  private readonly onFrame: () => void;
  private readonly iterations: number;
  private readonly frameEvery: number | undefined;
  private readonly budget: FrameBudget<WebGLSync | null>;
  private readonly throttle: RepaintThrottle;
  private readonly readback: AsyncPositionReadback;
  private readonly stats = new Float32Array(READBACK_STATS_FLOATS);
  private readonly sink: FrameSink;
  private readonly sample: GpuFrameSample = {
    now: 0, harvestMs: 0, commitMs: 0, repainted: false, repaintMs: 0, encodeMs: 0, items: 0, itemsMs: 0, ticksDone: 0,
    harvested: false, harvestedTicks: -1, stopTick: -1, copied: false, blocked: false, k: 1, bands: 1, budgetMs: 0,
  };
  private readonly canvas: EventTarget | null;
  /** The page, whose `visibilitychange` pauses the throttle's stall sampling (null outside a document). */
  private readonly page: Document | null;
  private resolveSettled: () => void = () => {};
  private settledOnce = false;
  /** The run is done, but `settled` waits for the sink (the LOD tree is still being built, #377). */
  private settlePending = false;

  private mode: Mode;
  private stopped = false;
  private failed = false;
  private raf = 0;
  private looping = false;
  private dragging = false;
  private coolLeft = 0;
  /**
   * The latest held positions of a drag, written into the position texture at the start of the next tick
   * (just before its reductions) rather than mid-tick, so every tick — and every readback's stats — sees
   * one consistent set of positions. The engine reuses these arrays, so the write takes the newest values.
   */
  private heldIds: Uint32Array | null = null;
  private heldPositions: Float32Array | null = null;

  /** Ticks integrated in this run (all modes; frozen ticks after a stop included). */
  private ticksDone = 0;
  /** The stop tick a harvest showed for the current schedule, −1 before (#376). */
  private stopTick = -1;
  /**
   * Which bands of which passes each frame encodes, the readback's passes included (#382). The stream is its
   * stage source: the solver's ticks, wrapped with the multilevel seed's steps (#353).
   */
  private readonly schedule: StreamSchedule;
  /** The current frame's rAF timestamp (the schedule's copy hooks read it). */
  private now = 0;
  /** What the tick the schedule last started (or is about to start) is. */
  private tickKind: TickKind = "solver";
  /** The seed's placement step (`setLevel` / `endSeed`) and a whole seed-level tick, as one-pass ticks (#353). */
  private readonly seedStep: EstimatedStage;
  private readonly seedTick: EstimatedStage;
  private readonly seedStepStages: readonly StreamStage[];
  private readonly seedTickStages: readonly StreamStage[];
  /** The current mode's ticks are done: copy once more (unthrottled), harvest, then {@link finish}. */
  private finishing = false;
  /**
   * A harvested convergence stop is on its way to the screen (#376) — with LOD on, out with the LOD worker
   * for a round trip (#377): encode and copy nothing more until it is painted ({@link finish}), so no copy of
   * the frozen ticks after it is harvested and repainted once the run has settled.
   */
  private stopping = false;

  /** Frame whose budget fence covers the pending copy, the ticks it holds, and whether it is the final one. */
  private copyFrame = 0;
  private copyTicks = 0;
  private copyFinal = false;
  /** Ticks of the last copy issued. */
  private copiedTicks = 0;
  /** Whether the pending copy's frame has completed. */
  private copyReady = false;
  /** A harvest was submitted to the sink and not painted yet: the ticks it holds, and whether it is the final one. */
  private frameSubmitted = false;
  private frameTicks = 0;
  private frameFinal = false;
  /** The submitted harvest has not been seen ready yet (the throttle samples its round trip then). */
  private frameAway = false;

  /** The multilevel seed (#353): none (or done), waiting for its plan, or running its levels. */
  private seedState: "none" | "waiting" | "running";
  private seedPlan: SeedPlan | null = null;
  /** The next seed level to place; `levels.length` means the graph's nodes are next. */
  private seedNext = 0;
  /** Ticks left on the current seed level. */
  private seedTicksLeft = 0;
  /** The seed placed the graph's nodes: copy them once, as the run's first frame (tick 0). */
  private seedFrame = false;
  /** A drag's pins while the seed runs: applied once the graph's nodes are placed. */
  private pendingPinIds: Uint32Array | null = null;
  private pendingPinPositions: Float32Array | null = null;
  /**
   * Where the run stood at the pending copy's positions, at the frame harvested from it and not painted yet
   * (#377: out with the LOD worker), and at the positions last painted — those in `graph.positions` (#311).
   */
  private readonly copyState: GpuRunState;
  private readonly frameState: GpuRunState;
  private readonly harvestState: GpuRunState;
  /**
   * Nothing of a seeded run has been painted yet (#353): `graph.positions` holds the transport's placeholder
   * disc, not positions of the run, so {@link runState} has none to continue from.
   */
  private placeholder: boolean;
  private readonly onInterrupt: ((reason: string, cause: "lost" | "non-finite") => void) | undefined;
  /** The run continues a moved layout whose positions are already on screen (#311). */
  private readonly resumed: boolean;

  constructor(device: WebGLDevice, layout: StreamSolver, graph: NetworkGraph, opts: GpuStreamOptions, onFrame: () => void) {
    const flat = isFlat(layout) ? layout : null;
    if (opts.seeded && !flat) throw new Error("GpuStream: only the flat layout runs a multilevel seed");
    this.gl = device.gl;
    this.layout = layout;
    this.flat = flat;
    this.drag = opts.drag ?? flat;
    this.graph = graph;
    this.streaming = opts.stream ?? true;
    this.onFrame = onFrame;
    this.iterations = opts.iterations;
    this.frameEvery = opts.frameEvery;
    this.onInterrupt = opts.onInterrupt;
    this.onFailure = opts.onFailure;
    this.throttle = new RepaintThrottle(opts.minFrameMs ?? MIN_FRAME_MS);
    this.budget = new FrameBudget(glFences(this.gl), () => performance.now(), opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {});
    this.readback = new AsyncPositionReadback(device, layout, opts.extra);
    this.seedStep = { costMs: 0, fixedMs: 0, rows: 1, run: () => this.runSeedStep() };
    this.seedTick = { costMs: 0, fixedMs: 0, rows: 1, run: () => this.requireFlat().runFrame(1) };
    this.seedStepStages = [this.seedStep];
    this.seedTickStages = [this.seedTick];
    const source: StageSource = {
      tickStages: () => this.nextTickStages(),
      readbackStages: () => layout.readbackStages?.() ?? NO_STAGES,
    };
    this.schedule = new StreamSchedule(this.budget, source, {
      tickStart: () => this.tickStarted(),
      tickEnd: () => this.tickEnded(),
      // The throttle times a readback from here: its passes may wait frames for budget before the copy.
      readbackStart: () => this.throttle.readbackStarted(this.now),
      copy: (betweenTicks) => this.issueCopy(betweenTicks),
    });
    this.sink = opts.sink ?? new DirectSink(graph, opts.into ?? null);
    this.sink.listen(() => this.resume());
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    const canvas = this.gl.canvas;
    this.canvas = canvas instanceof EventTarget ? canvas : null;
    this.canvas?.addEventListener("webglcontextlost", this.onContextLost);
    this.page = typeof document === "undefined" ? null : document;
    this.page?.addEventListener("visibilitychange", this.onVisibilityChange);
    this.seedState = opts.seeded ? "waiting" : "none";
    this.resumed = opts.resumed !== undefined;
    this.mode = this.iterations > 0 || opts.seeded ? (opts.resumed?.recool ? "cool" : "run") : "idle";
    if (this.mode === "cool") this.coolLeft = this.iterations;
    // Nothing painted yet: `graph.positions` holds the seed the solver started from — or, for a seeded run,
    // the transport's placeholder disc.
    const start: GpuRunState = {
      mode: this.mode, ticksLeft: this.iterations, heat: flat?.heat ?? 1, decaying: flat?.heatDecaying ?? false,
    };
    this.copyState = { ...start };
    this.frameState = { ...start };
    this.harvestState = start;
    this.placeholder = opts.seeded === true;
  }

  /**
   * Where the run stood at the positions last painted into `graph.positions` — or at its seed, before the
   * first frame (#311). A layout moved elsewhere continues from there: those positions, the ticks left, the
   * heat. Null while a seeded run (#353) has painted nothing: the disc on screen is a placeholder, so a move
   * then starts the layout afresh. The object is the stream's own, updated at each painted frame; read it,
   * don't keep it.
   */
  runState(): Readonly<GpuRunState> | null {
    return this.placeholder ? null : this.harvestState;
  }

  /**
   * Start the initial run (or a resumed re-cool) — or, with no iterations and no seed to wait for, paint the
   * seed and settle at once (a resumed idle run paints nothing: its positions are already on screen). A seeded
   * stream waits for its plan ({@link seed}) before it encodes anything.
   */
  start(): void {
    if (this.mode !== "idle") {
      if (this.seedState !== "waiting") this.resume(); // a seeded stream starts when its plan arrives
    } else {
      if (!this.resumed) this.onFrame();
      this.settle();
    }
  }

  /**
   * Hand a seeded stream its multilevel seed plan (#353) — or `null` when none could be built (the layout
   * worker failed): the run then starts cold from the transport's disc, at full heat. The seed's textures are
   * created here, when the plan arrives, outside the frame loop (its programs were compiled with the solver);
   * if that fails, one warning, and the run starts cold as without a plan. The plan's levels run as work
   * items from the next frame on. Ignored unless the stream is waiting for one.
   */
  seed(plan: SeedPlan | null): void {
    if (this.stopped || this.seedState !== "waiting") return;
    if (plan && !this.startSeed(plan)) plan = null;
    if (plan) {
      this.seedPlan = plan;
      this.seedNext = 0;
      this.seedTicksLeft = 0;
      this.seedState = "running";
      this.resume();
      return;
    }
    this.seedState = "none";
    this.requireFlat().hold(1); // a cold disc start untangles at full heat (ForceLayout.run)
    this.applyPendingPin();
    if (this.iterations > 0) {
      this.resume();
    } else {
      this.mode = "idle";
      this.onFrame();
      this.settle();
    }
  }

  /**
   * Hold `ids` and reheat: the rest reflows around them. Their `positions` are written into the position
   * texture at the start of the next tick, never mid-tick (the latest ones, if several pins arrive first).
   * Resumes the loop in `drag` mode, or lets an initial run with ticks left turn into it when they end.
   * A run whose ticks are all encoded (its final copy not yet harvested) has no tick left to write the
   * held positions, so it turns into a drag now, as an idle layout does. A run with ticks left keeps its
   * schedule, as on the worker; if it converges during the drag, the frozen integrate holds every node but
   * the held ones until a harvest shows the stop and the run turns into the drag (#376) — one copy-to-harvest
   * latency, about a repaint interval, after the worker, which turns at its stop tick.
   */
  pin(ids: Uint32Array, positions?: Float32Array): void {
    const drag = this.drag;
    if (this.stopped || this.failed || !drag) return; // a solver without a drag interface ignores it (#355)
    if (this.seedState !== "none") {
      // The solver's slots are a seed level's, not nodes: hold the pins until the nodes are placed.
      this.pendingPinIds = ids;
      if (positions) this.pendingPinPositions = positions;
      this.dragging = true;
      return;
    }
    drag.setPinned(ids);
    if (positions) {
      this.heldIds = ids;
      this.heldPositions = positions;
    }
    this.dragging = true;
    if (this.mode === "idle" || this.mode === "cool" || (this.mode === "run" && this.finishing)) {
      this.mode = "drag";
      this.hold(DRAG_HEAT);
      this.finishing = false;
      this.copyFinal = false; // a final copy in flight is harvested as an ordinary frame
      this.frameFinal = false; // so is a final frame the LOD worker is refitting
      this.stopping = false; // and a harvested stop of the schedule the drag replaced
    }
    this.resume();
  }

  /** Release every pin and re-cool over a short tail, then idle. */
  unpin(): void {
    const drag = this.drag;
    if (this.stopped || this.failed || !drag) return;
    if (this.seedState !== "none") {
      this.pendingPinIds = null;
      this.pendingPinPositions = null;
      this.dragging = false;
      return;
    }
    drag.setPinned(null);
    this.dragging = false;
    if (this.mode === "drag") {
      this.mode = "cool";
      this.coolLeft = RECOOL_TICKS;
      drag.cool(RECOOL_TICKS, DRAG_HEAT);
      this.stopTick = -1;
    }
    this.resume();
  }

  /**
   * Cancel the run and free every GPU resource and the sink; resolves `settled`. On a lost context — noticed
   * or not yet (its event is still queued) — it makes no GL call and only drops its handles (#311). A luma
   * device that was destroyed while its context lives on is freed normally: `WebGLDevice.destroy()` only
   * detaches the device from the context, so the deletes still release the memory.
   */
  stop(): void {
    if (this.stopped) return;
    this.halt();
    this.release();
    this.sink.destroy();
    this.settle(true);
  }

  // ── The frame ──────────────────────────────────────────────────────────────

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (this.stopped) return;
    if (this.gl.isContextLost()) {
      this.lose("the WebGL context was lost");
      return;
    }
    const sample = this.sample;
    const t0 = performance.now();

    // 1. Harvest — before any encode.
    if (this.budget.beginFrame(now) === "lost") {
      this.lose("a GPU fence wait failed");
      return;
    }
    this.throttle.beginFrame(now, this.budget.intervalMs);
    if (this.readback.pending && !this.copyReady && this.copyFrame <= this.budget.completedFrame) {
      this.copyReady = true;
      this.throttle.copyCompleted(now);
    }
    // A finished copy is harvested once the repaint is due — one round trip earlier when the sink relays it
    // (#377) — and the final one at once; into the sink's buffer, and only while the sink can take it.
    let harvested = false;
    let harvestedTicks = -1;
    const harvestDue = this.throttle.harvestDue(now, this.sink.relays);
    if (this.readback.pending && this.copyReady && (this.copyFinal || this.frameEvery !== undefined || harvestDue)) {
      const target = this.sink.target();
      if (target) {
        harvested = true;
        harvestedTicks = this.copyTicks; // before this frame's copy, if any, moves copyTicks on
        if (!this.readback.harvest(target, this.stats) || (this.stopFlags() & STOP_NONFINITE) !== 0) {
          this.fail();
          return;
        }
        this.frameSubmitted = true;
        this.frameTicks = this.copyTicks;
        copyRunState(this.copyState, this.frameState);
        // A convergence stop of the current schedule (#376): these are the stop tick's positions — the final
        // ones, decided now, from the stats copied with them, and finished once the frame is painted. (Read
        // the stop even from a final copy: it records the stop tick.)
        const stopped = this.harvestedStop();
        this.frameFinal = this.copyFinal || stopped;
        if (stopped) this.stopping = true;
        this.frameAway = true;
        this.sink.submit(this.copyTicks);
        this.throttle.submitted(now);
      }
    }
    // A ready frame is put on the graph and repainted once the repaint is due (the final one at once): in
    // the frame it was harvested, or — relayed through the LOD worker — the first due frame after it returned.
    let repainted = false;
    let repaintMs = 0;
    let commitMs = 0;
    if (this.sink.ready) {
      if (this.frameAway) {
        this.frameAway = false;
        this.throttle.returned(now);
      }
      const own = this.frameSubmitted; // else a frame the sink produced: the LOD tree's first geometry
      const final = own && this.frameFinal;
      if (final || this.frameEvery !== undefined || this.throttle.due(now)) {
        const c0 = performance.now();
        const applied = this.sink.commit();
        commitMs = performance.now() - c0;
        this.frameSubmitted = false;
        if (!applied) {
          // Lost with the LOD worker: nothing changed on the graph. Copy those ticks again (the final copy
          // too — `finishing` still holds; a stop's copy shows the latched stop again), now straight into
          // the graph.
          if (own) this.copiedTicks = Math.min(this.copiedTicks, this.frameTicks - 1);
          this.stopping = false;
        } else {
          if (own) {
            // These positions are on the graph now: a move continues from where the run stood at them (#311).
            copyRunState(this.frameState, this.harvestState);
            this.placeholder = false;
          }
          if (own && this.frameTicks >= this.iterations && this.mode !== "run") this.settle();
          const r0 = performance.now();
          try {
            this.onFrame();
          } catch (error) {
            // The engine's repaint threw (a style accessor, say): report it as uncaught, as a repaint in its
            // own animation frame would, and keep the layout's loop and its state intact.
            reportUncaught(error);
          }
          repaintMs = performance.now() - r0;
          repainted = true;
          this.throttle.repainted(now, repaintMs);
          if (this.stopped) return; // the repaint superseded this layout
          if (final) this.finish();
        }
      }
    }
    if (this.settlePending && !this.sink.holding) this.settle();
    const harvestMs = performance.now() - t0 - repaintMs;

    // 2. Encode work items within the budget — a readback being prepared first (nothing may move the
    // positions before its copy), then the ticks — and 3. a readback on the repaint cadence: its passes as
    // items, then the copy (#382). Then the frame's one budget fence.
    const t2 = performance.now();
    this.now = now;
    const open = this.budget.open();
    const items = this.schedule.frame(open, this.hasWork, this.copyDue);
    const copied = this.schedule.copied;
    // `repainted` ⇔ onFrame ran. Not `repaintMs > 0`: a clamped clock (~1 ms in Firefox and Safari without
    // cross-origin isolation) measures a cheap repaint as 0. Not `harvested`: a relayed frame is painted
    // in a later frame than the one that harvested it (#377).
    const frame = this.budget.endFrame(repainted);
    if (copied) this.copyFrame = frame;
    const t3 = performance.now();

    if (observers.size > 0) {
      sample.now = now;
      sample.harvestMs = harvestMs;
      sample.commitMs = commitMs;
      sample.repainted = repainted;
      sample.repaintMs = repaintMs;
      sample.encodeMs = t3 - t2;
      sample.items = items;
      sample.itemsMs = this.schedule.frameCostMs;
      sample.ticksDone = this.ticksDone;
      sample.harvested = harvested;
      sample.harvestedTicks = harvestedTicks;
      sample.stopTick = this.stopTick;
      sample.copied = copied;
      sample.blocked = !open;
      sample.k = this.budget.k;
      sample.bands = this.schedule.lastBands;
      sample.budgetMs = this.budget.budgetMs;
      for (const observer of observers) observer(sample);
    }

    if (this.active()) this.raf = requestAnimationFrame(this.frame);
    else this.looping = false;
  };

  /**
   * Whether the loop still has something to do: ticks to encode, a copy to harvest and repaint, a ready frame
   * to paint, or ticks to copy again after the LOD worker lost a frame. A frame out with the LOD worker needs
   * no loop: the sink wakes the stream when it is back.
   */
  private active(): boolean {
    return (
      (this.mode !== "idle" && !this.failed && this.seedState !== "waiting") ||
      this.finishing ||
      this.schedule.reading ||
      this.readback.pending ||
      this.sink.ready ||
      // Ticks to copy again after the LOD worker lost a frame — never once idle: a convergence stop's frozen
      // ticks after its copy changed nothing, and an idle stream copies nothing (#376).
      (!this.failed && this.mode !== "idle" && this.ticksDone > this.copiedTicks)
    );
  }

  /**
   * Whether the current mode has ticks left to encode. A started tick is finished, except the frozen one a
   * convergence stop sends the stream idle in, which {@link finish} drops. Not in the frame the seed placed
   * the graph's nodes: that frame copies them as tick 0 (#353).
   */
  private readonly hasWork = (): boolean =>
    this.mode !== "idle" &&
    !this.finishing &&
    !this.stopping &&
    !this.failed &&
    this.seedState !== "waiting" &&
    !this.seedFrame;

  /** Whether the next tick is a seed step: placing the next seed level, or the graph's nodes (#353). */
  private seedStepNext(): boolean {
    return this.seedState === "running" && this.seedTicksLeft === 0;
  }

  /**
   * The passes of the tick about to start — the schedule's stage source (#382): a step of the multilevel seed
   * (#353), a whole seed-level tick, or the solver's own tick over the level it is on (a seed level's slots
   * and rows, whose cost sizes its bands, or the graph's).
   */
  private nextTickStages(): readonly StreamStage[] {
    if (this.seedStepNext()) {
      // A placement is one gather over the level's slots, about an integrate's cost.
      const level = this.seedPlan?.levels[this.seedNext];
      this.seedStep.costMs = flatPassCostMs("integrate", level ? level.count : this.layout.nodeCount);
      this.tickKind = "seed-step";
      return this.seedStepStages;
    }
    if (this.wholeSeedTick()) {
      this.seedTick.costMs = this.tickCostMs(this.levelSlots());
      this.tickKind = "seed-tick";
      return this.seedTickStages;
    }
    this.tickKind = "solver";
    return this.layout.tickStages();
  }

  /** Slots of the level the ticks run on: a multilevel seed's level (#353), else every node. */
  private levelSlots(): number {
    return this.flat?.levelSlots ?? this.layout.nodeCount;
  }

  /** The flat layout, which the multilevel seed needs (a seeded stream is only ever built over one). */
  private requireFlat(): FlatStreamSolver {
    if (!this.flat) throw new Error("GpuStream: a multilevel seed step without the flat layout");
    return this.flat;
  }

  /** The estimated GPU time of a whole unsliced flat tick over `n` slots. */
  private tickCostMs(n: number): number {
    return flatPassCostMs("prep", n) + flatPassCostMs("force", n) + flatPassCostMs("integrate", n);
  }

  /**
   * Whether the next tick is a whole tick of a seed level (#353): a level whose unsliced tick fits in half
   * the frame's budget is ticked as one item, not as its passes — most seed levels are a few thousand slots
   * or fewer, so cutting their ticks into P, F and I would only multiply the items the frame budget counts,
   * and the seed frame would wait for them.
   */
  private wholeSeedTick(): boolean {
    return this.seedState === "running" && this.tickCostMs(this.levelSlots()) <= this.budget.budgetMs / 2;
  }

  /** Create the seed's resources for `plan` (#353); false, with one warning, if that fails. */
  private startSeed(plan: SeedPlan): boolean {
    try {
      this.requireFlat().beginSeed(plan);
      return true;
    } catch (error) {
      console.warn("[d3gl] network layout({ backend: 'gpu' }): the multilevel seed could not start; the layout starts from a disc instead.", error);
      return false;
    }
  }

  /** The seed's placement step, as a work item: {@link encodeSeedStep}, freeing the seed if it throws. */
  private runSeedStep(): void {
    try {
      this.encodeSeedStep();
    } catch (error) {
      this.abortSeed(error);
    }
  }

  /**
   * Encode the next seed step (#353): place the next level, or — after the last — place the graph's nodes and
   * end the seed.
   */
  private encodeSeedStep(): void {
    const plan = this.seedPlan;
    if (!plan) throw new Error("GpuStream: a seed step without a plan");
    const level = plan.levels[this.seedNext];
    if (level) {
      this.requireFlat().setLevel(this.seedNext);
      this.seedTicksLeft = level.ticks;
      this.seedNext++;
      return;
    }
    const flat = this.requireFlat();
    flat.endSeed();
    this.seedState = "none";
    this.seedPlan = null;
    this.seedFrame = true;
    // A seeded layout has its global arrangement: cool over the budget, as the CPU worker does (#124).
    flat.cool(this.iterations);
    this.applyPendingPin();
    if (this.iterations === 0) this.finishing = true; // the seed frame is the final one
  }

  /** Apply the pins a drag made while the seed ran (#353), now that the solver's slots are nodes. */
  private applyPendingPin(): void {
    const ids = this.pendingPinIds;
    if (!ids) return;
    this.drag?.setPinned(ids);
    if (this.pendingPinPositions) {
      this.heldIds = ids;
      this.heldPositions = this.pendingPinPositions;
    }
    this.pendingPinIds = null;
    this.pendingPinPositions = null;
  }

  /**
   * A seed step failed mid-seed (#353): its slots hold a coarse level, not the nodes, so the run cannot go on.
   * Free the seed, warn once, and settle as a non-finite layout does, keeping the disc on screen (nothing was
   * harvested yet). The solver stays until {@link stop}, which the engine's next `layout()` or `data()` calls.
   */
  private abortSeed(error: unknown): void {
    this.flat?.cancelSeed();
    this.seedState = "none";
    this.seedPlan = null;
    this.pendingPinIds = null;
    this.pendingPinPositions = null;
    this.failed = true;
    this.mode = "idle";
    this.finishing = false;
    // (The frame this runs in ends the loop once nothing else is left: a frame the LOD worker returns still lands.)
    console.warn("[d3gl] network layout({ backend: 'gpu' }) stopped: a step of the multilevel seed failed; keeping the disc.", error);
    this.settle(true);
  }

  /**
   * A tick is about to encode its first band. A tick of the solver starts with its prep: the drag's latest
   * held positions are written first, so the whole tick sees one set, and the stop latch is armed for the
   * prep's reduction (#376).
   */
  private tickStarted(): void {
    if (this.tickKind !== "solver") return;
    if (this.heldIds && this.heldPositions) {
      this.drag?.setHeldPositions(this.heldIds, this.heldPositions);
      this.heldIds = null;
      this.heldPositions = null;
    }
    this.armStop();
  }

  /** A tick's last band was encoded: advance the seed (#353), or the mode's schedule. */
  private tickEnded(): void {
    if (this.tickKind === "seed-step") return; // its run advanced the seed
    if (this.tickKind === "seed-tick" || this.seedState === "running") {
      this.seedTicksLeft--;
      return;
    }
    this.ticksDone++;
    this.tickDone();
  }

  /**
   * Copy the positions into the PBO, fenced by this frame's budget fence, once the solver's readback passes
   * are encoded. Between ticks the flat layout's stats describe the previous positions, so
   * {@link StreamSolver.prepareReadback} re-runs its reductions — and the stop latch over them, armed here
   * for the tick just integrated (#376); after a prep they already describe these (positions change only at
   * integrate and at the prep's held-position write).
   */
  private issueCopy(betweenTicks: boolean): void {
    if (betweenTicks) this.armStop();
    this.layout.prepareReadback(betweenTicks);
    this.readback.issue(this.layout);
    this.seedFrame = false;
    this.copyTicks = this.ticksDone;
    this.copyFinal = this.finishing;
    this.copiedTicks = this.ticksDone;
    this.recordCopyState();
    this.copyReady = false;
  }

  /** A tick was integrated: advance the mode's schedule. */
  private tickDone(): void {
    if (this.mode === "run" && this.ticksDone >= this.iterations) {
      if (this.dragging) {
        // The run's budget is spent with a drag live: keep reflowing at the drag heat. The next harvest
        // carries ticks ≥ iterations and settles.
        this.mode = "drag";
        this.hold(DRAG_HEAT);
      } else {
        this.finishing = true;
      }
    } else if (this.mode === "cool" && --this.coolLeft <= 0) {
      this.finishing = true;
    }
  }

  /**
   * The final positions of a run (or a re-cool) were harvested and painted. A convergence stop is harvested
   * at any point of a tick, and the ticks after the stop are frozen, so a stream that goes idle drops the
   * tick it is in (#376). A later pin then starts a fresh tick, whose prep writes the held positions and
   * clears the force accumulator, instead of finishing that one from its old prep with the held nodes
   * where they were.
   */
  private finish(): void {
    this.finishing = false;
    this.stopping = false;
    if (this.mode === "run") {
      this.settle();
      if (this.dragging) {
        this.mode = "drag";
        this.hold(DRAG_HEAT);
      } else {
        this.mode = "idle";
        this.schedule.dropTick();
      }
    } else if (this.mode === "cool") {
      this.mode = "idle";
      this.schedule.dropTick();
      this.settle();
    }
    // The painted positions are the run's final ones: a move from here continues from the mode the run is in
    // now (idle, or the drag it turned into), not from the copy's — a convergence stop (#376) ends a run with
    // ticks of its budget left, which a move would otherwise run again (#311).
    this.recordRunState(this.harvestState);
  }

  /**
   * Whether to start a readback this frame (asked after its ticks): the PBO is free, there are new ticks, and
   * the copy would be ready (after the usual latency from a readback's start — its passes' wait for budget
   * included — to its copy's completion) when the next repaint is due — so a harvested frame is about one
   * frame old, not a whole repaint interval.
   */
  private readonly copyDue = (): boolean => {
    if (this.readback.pending) return false;
    if (this.seedState !== "none") return false; // the slots hold a seed level, not the nodes (#353)
    if (this.seedFrame) return true; // the seed frame: tick 0, once
    // An idle stream has shown its final positions, and a harvested stop is on its way to the screen: a
    // stop's frozen ticks after its copy changed nothing (#376).
    if (this.mode === "idle" || this.stopping) return false;
    const fresh = this.ticksDone - this.copiedTicks;
    if (fresh <= 0) return false;
    // The final copy goes out as soon as the PBO is free, once: `finishing` holds until that frame is painted
    // (finish()), which with LOD on is a worker round trip after its harvest (#377), and a frame lost with the
    // worker is copied again because the loss rewinds `copiedTicks`.
    if (this.finishing) return true;
    if (!this.streaming) return false; // only the final positions are read back (#328, #355)
    if (this.frameEvery !== undefined) return fresh >= this.frameEvery;
    return this.throttle.copyDue(this.now, this.sink.relays);
  };

  // ── Convergence stop (#376) ────────────────────────────────────────────────

  /**
   * Arm the solver's stop latch for the next reduction: a run and a re-cool stop at convergence, a drag
   * never does (the worker checks `converged` only in `run` and `cool` mode).
   */
  private armStop(): void {
    if (this.flat) this.flat.stopOnConvergence = this.mode === "run" || this.mode === "cool";
  }

  /** Hold a heat — a new schedule, so the previous one's stop no longer applies. */
  private hold(heat: number): void {
    this.drag?.hold(heat);
    this.stopTick = -1;
  }

  /** The harvested stop latch's flags. */
  private stopFlags(): number {
    return this.stats[READBACK_STOP_OFFSET + 3] ?? 0;
  }

  /**
   * Whether the harvested copy shows a convergence stop that ends the current mode: latched in the current
   * schedule (a stop read after a drag started a new one is stale) while a run or a re-cool is live.
   * Records its tick.
   */
  private harvestedStop(): boolean {
    if ((this.stopFlags() & STOP_STOPPED) === 0) return false;
    if (!this.flat || this.stats[READBACK_STOP_OFFSET + 2] !== this.flat.scheduleEpoch) return false;
    if (this.mode !== "run" && this.mode !== "cool") return false;
    this.stopTick = this.stats[READBACK_STOP_OFFSET + 1] ?? -1;
    return true;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private resume(): void {
    if (this.looping || this.stopped) return;
    this.looping = true;
    this.budget.resume();
    this.throttle.pause(); // the idle gap is not a stall
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Resolve `settled` — unless the sink still holds it (the LOD tree is still being built, #377): then once
   * it lets go, after the frame that paints the tree. `force` (stop, a lost context, a non-finite layout)
   * resolves at once.
   */
  private settle(force = false): void {
    if (this.settledOnce) return;
    if (!force && this.sink.holding) {
      this.settlePending = true;
      return;
    }
    this.settledOnce = true;
    this.settlePending = false;
    this.resolveSettled();
  }

  /**
   * Free the solver, the readback and the fences — or, on a lost context, only drop them: a lost context takes
   * no GL call (#311). Asked of the context itself, because its `webglcontextlost` event is queued.
   */
  private release(): void {
    const touchGl = !this.gl.isContextLost();
    this.budget.dispose(touchGl);
    this.readback.destroy(touchGl);
    if (touchGl) this.layout.destroy();
  }

  /** Stop the loop and forget the pending copy; the caller decides what else to free. */
  private halt(): void {
    this.stopped = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.looping = false;
    this.schedule.abandon();
    this.readback.abandon();
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.page?.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** The page was hidden or shown: rAF paused in between, so the gap is neither a frame interval nor a stall. */
  private readonly onVisibilityChange = (): void => {
    this.budget.resume();
    this.throttle.pause();
  };

  private readonly onContextLost = (): void => {
    this.lose("the WebGL context was lost");
  };

  /** Record where the run stands at the copy just issued: its mode, the ticks left, the next tick's heat. */
  private recordCopyState(): void {
    this.recordRunState(this.copyState);
  }

  /** Where the run stands now — its mode, the ticks left of that mode, the next tick's heat — into `s`. */
  private recordRunState(s: GpuRunState): void {
    s.mode = this.mode;
    s.ticksLeft =
      this.mode === "run" ? Math.max(0, this.iterations - this.ticksDone) : this.mode === "cool" ? Math.max(0, this.coolLeft) : 0;
    s.heat = this.flat?.heat ?? 1;
    s.decaying = this.flat?.heatDecaying ?? false;
  }

  /**
   * The context is gone, or a fence wait failed: stop, keep the last harvested positions, settle — and tell
   * the owner ({@link GpuStreamOptions.onInterrupt}), or warn. A lost context takes no further GL call. A
   * fence wait that failed on a context that is still alive (an invalid sync, not a loss) frees the run's GPU
   * objects here, since the stream is stopped and a later {@link stop} does nothing.
   */
  private lose(reason: string): void {
    if (this.stopped) return;
    this.halt();
    this.release();
    this.sink.destroy();
    if (this.onInterrupt) this.onInterrupt(reason, "lost");
    else this.reportFailure(reason, "");
    this.settle(true);
  }

  /**
   * The reductions came back non-finite: stop encoding, keep the last finite positions, settle — and tell
   * the owner ({@link GpuStreamOptions.onInterrupt}), or warn. The sink stays until {@link stop} (the owner's
   * move, the engine's next `layout()` / `data()`, or `destroy()`), so a frame the LOD worker is refitting,
   * or the tree's first geometry, still lands and is painted (#377).
   */
  private fail(): void {
    this.failed = true;
    this.mode = "idle";
    this.finishing = false;
    this.looping = false;
    const [sx, sy, sv, count, maxX, maxY, negMinX, negMinY] = this.stats;
    const reason =
      "the layout became non-finite " +
      `(Σx=${sx}, Σy=${sy}, Σ|v|=${sv}, count=${count}, box=[${negMinX === undefined ? "" : -negMinX}, ` +
      `${negMinY === undefined ? "" : -negMinY}, ${maxX}, ${maxY}])`;
    if (this.onInterrupt) this.onInterrupt(reason, "non-finite");
    else this.reportFailure(reason, "; keeping the last finite positions");
    this.settle(true);
  }

  /** A failed run: to the owner's `onFailure` when it has one (it decides what follows, #355), else one warning. */
  private reportFailure(reason: string, consequence: string): void {
    if (this.onFailure) this.onFailure(reason);
    else console.warn(`[d3gl] network layout({ backend: 'gpu' }) stopped: ${reason}${consequence}.`);
  }
}

/** Copy one {@link GpuRunState} into another, field by field (no allocation per harvest). */
function copyRunState(from: GpuRunState, to: GpuRunState): void {
  to.mode = from.mode;
  to.ticksLeft = from.ticksLeft;
  to.heat = from.heat;
  to.decaying = from.decaying;
}
