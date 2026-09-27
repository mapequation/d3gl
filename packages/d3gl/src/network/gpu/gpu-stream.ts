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
 *    0.6 × rAF interval)` per frame, and at most 2 ms of encode time. A tick is the solver's sequence of
 *    passes (`stream-schedule.ts`); every pass is cut into row bands sized to the budget (at most half of
 *    it, or all of it for a pass whose every band waits on a long fragment; #382), and each band is an
 *    item — so a frame's *estimated* layout GPU work stays within the budget, save a first item that alone
 *    passes it: a band whose fixed cost alone passes three quarters of the budget (the nested gather of a
 *    module past ~12,000 children at 120 Hz, #380); the flat layout's P and I, which run whole (P's estimate
 *    passes the 120 Hz budget above ~1M nodes, #429); and a band of a pass already cut into its 64 bands
 *    (`MAX_BANDS`; at 120 Hz the flat force pass above ~8M nodes, the nested gather above ~20M leaves). A
 *    tick may span frames; its result does not depend on how it was sliced.
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
 * `settled` resolves only after positions from the final tick have been harvested, so the engine's
 * settle handler sees them. The run then goes **idle** (the layout stays alive for a drag reheat, #183).
 * A non-finite layout (NaN / ∞ in the reductions' stats) stops the run with one warning, keeping the last
 * finite positions — the harvest checks the stats before it touches `graph.positions`. A lost context
 * (`isContextLost`, a failed fence wait, `webglcontextlost`) stops it without touching GL again, with one
 * warning. An owner that handles a failure itself passes `onFailure`, which replaces the warning (the
 * nested layout lays the map out on the worker instead, #355).
 */
import { WebGLDevice } from "@luma.gl/webgl";
import { DRAG_HEAT, RECOOL_TICKS } from "../force.js";
import type { NetworkGraph } from "../graph.js";
import { deleteSync, insertSync, pollSync } from "../../webgl/fence.js";
import { AsyncPositionReadback, READBACK_STATS_FLOATS, type ReadbackSource } from "./async-readback.js";
import { FrameBudget, type FenceSource } from "./frame-budget.js";
import { StreamSchedule, type StageSource } from "./stream-schedule.js";
import { MIN_FRAME_MS, RepaintThrottle } from "./repaint-throttle.js";
import { reportUncaught } from "./report-uncaught.js";

/**
 * A solver the stream drives, and its own {@link ReadbackSource}: a tick is a sequence of passes
 * ({@link StageSource.tickStages}), each sliced into bands (`stream-schedule.ts`). The flat
 * {@link GpuForceLayout} (prep, force, integrate) and the nested layout's batched solve (#355) are both one.
 */
export interface StreamSolver extends ReadbackSource, StageSource {
  /**
   * The last step right before a copy, after any {@link StageSource.readbackStages}: make the readback
   * source's stats describe the current positions. `betweenTicks`: the copy follows a tick's last pass (the
   * next has not started); the flat layout then re-runs its reductions, whose last run was that tick's prep.
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

/** What one streamed frame did — the argument of a {@link observeGpuLayoutFrames} observer. */
export interface GpuFrameSample {
  /** The frame's rAF timestamp. */
  now: number;
  /** Main-thread ms polling fences and harvesting positions. */
  harvestMs: number;
  /** Main-thread ms inside `onFrame` (the engine's repaint); 0 when this frame did not repaint. */
  repaintMs: number;
  /** Main-thread ms encoding work items, the readback copy and the budget fence. */
  encodeMs: number;
  /** Work items encoded this frame. */
  items: number;
  /** Their estimated GPU time, ms — within `budgetMs` whenever more than one item ran (#382): the budget admits a second item only while the sum fits. */
  itemsMs: number;
  /** Ticks completed so far in this run. */
  ticksDone: number;
  /** Whether a readback was harvested this frame. */
  harvested: boolean;
  /** Ticks the positions harvested this frame are the result of (−1 when nothing was harvested). */
  harvestedTicks: number;
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
  /** The solver's drag interface; without one, `pin` / `unpin` do nothing (the nested layout, #355). */
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
   * right before `settled` resolves, so the owner can tell a failed run from a finished one. Its argument
   * names the reason. Default: warn and keep the last finite positions.
   */
  onFailure?: (reason: string) => void;
}

type Mode = "idle" | "run" | "drag" | "cool";

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
  private readonly drag: DragSolver | null;
  private readonly graph: NetworkGraph;
  private readonly into: Float32Array | null;
  private readonly extra: Float32Array | undefined;
  private readonly streaming: boolean;
  private readonly onFrame: () => void;
  private readonly onFailure: ((reason: string) => void) | undefined;
  private readonly iterations: number;
  private readonly frameEvery: number | undefined;
  private readonly budget: FrameBudget<WebGLSync | null>;
  private readonly throttle: RepaintThrottle;
  private readonly readback: AsyncPositionReadback;
  private readonly stats = new Float32Array(READBACK_STATS_FLOATS);
  private readonly sample: GpuFrameSample = {
    now: 0, harvestMs: 0, repaintMs: 0, encodeMs: 0, items: 0, itemsMs: 0, ticksDone: 0,
    harvested: false, harvestedTicks: -1, copied: false, blocked: false, k: 1, bands: 1, budgetMs: 0,
  };
  private readonly canvas: EventTarget | null;
  /** The page, whose `visibilitychange` pauses the throttle's stall sampling (null outside a document). */
  private readonly page: Document | null;
  private resolveSettled: () => void = () => {};
  private settledOnce = false;

  private mode: Mode;
  private stopped = false;
  private lost = false;
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

  /** Ticks completed in this run (all modes). */
  private ticksDone = 0;
  /** Which bands of which passes each frame encodes, the readback's passes included (#382). */
  private readonly schedule: StreamSchedule;
  /** The current frame's rAF timestamp (the copy hook reads it). */
  private now = 0;
  /** The current mode's ticks are done: copy once more (unthrottled), harvest, then {@link finish}. */
  private finishing = false;

  /** Frame whose budget fence covers the pending copy, the ticks it holds, and whether it is the final one. */
  private copyFrame = 0;
  private copyTicks = 0;
  private copyFinal = false;
  /** Ticks of the last copy issued. */
  private copiedTicks = 0;
  /** Whether the pending copy's frame has completed. */
  private copyReady = false;

  constructor(device: WebGLDevice, layout: StreamSolver, graph: NetworkGraph, opts: GpuStreamOptions, onFrame: () => void) {
    this.gl = device.gl;
    this.layout = layout;
    this.drag = opts.drag ?? null;
    this.graph = graph;
    this.into = opts.into ?? null;
    this.extra = opts.extra;
    this.streaming = opts.stream ?? true;
    this.onFrame = onFrame;
    this.onFailure = opts.onFailure;
    this.iterations = opts.iterations;
    this.frameEvery = opts.frameEvery;
    this.throttle = new RepaintThrottle(opts.minFrameMs ?? MIN_FRAME_MS);
    this.budget = new FrameBudget(glFences(this.gl), () => performance.now(), opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {});
    this.readback = new AsyncPositionReadback(device, layout);
    this.schedule = new StreamSchedule(this.budget, layout, {
      tickStart: () => this.writeHeld(),
      tickEnd: () => {
        this.ticksDone++;
        this.tickDone();
      },
      // The throttle times a readback from here: its passes may wait frames for budget before the copy.
      readbackStart: () => this.throttle.readbackStarted(this.now),
      copy: (betweenTicks) => this.issueCopy(betweenTicks),
    });
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    const canvas = this.gl.canvas;
    this.canvas = canvas instanceof EventTarget ? canvas : null;
    this.canvas?.addEventListener("webglcontextlost", this.onContextLost);
    this.page = typeof document === "undefined" ? null : document;
    this.page?.addEventListener("visibilitychange", this.onVisibilityChange);
    this.mode = this.iterations > 0 ? "run" : "idle";
  }

  /** Start the initial run — or, with no iterations, paint the seed and settle at once. */
  start(): void {
    if (this.mode === "run") this.resume();
    else {
      this.onFrame();
      this.settle();
    }
  }

  /**
   * Hold `ids` and reheat: the rest reflows around them. Their `positions` are written into the position
   * texture at the start of the next tick, never mid-tick (the latest ones, if several pins arrive first).
   * Resumes the loop in `drag` mode, or lets an initial run with ticks left turn into it when they end.
   * A run whose ticks are all encoded (its final copy not yet harvested) has no tick left to write the
   * held positions, so it turns into a drag now, as an idle layout does.
   */
  pin(ids: Uint32Array, positions?: Float32Array): void {
    const drag = this.drag;
    if (this.stopped || this.failed || !drag) return;
    drag.setPinned(ids);
    if (positions) {
      this.heldIds = ids;
      this.heldPositions = positions;
    }
    this.dragging = true;
    if (this.mode === "idle" || this.mode === "cool" || (this.mode === "run" && this.finishing)) {
      this.mode = "drag";
      drag.hold(DRAG_HEAT);
      this.finishing = false;
      this.copyFinal = false; // a final copy in flight is harvested as an ordinary frame
    }
    this.resume();
  }

  /** Release every pin and re-cool over a short tail, then idle. */
  unpin(): void {
    const drag = this.drag;
    if (this.stopped || this.failed || !drag) return;
    drag.setPinned(null);
    this.dragging = false;
    if (this.mode === "drag") {
      this.mode = "cool";
      this.coolLeft = RECOOL_TICKS;
      drag.cool(RECOOL_TICKS, DRAG_HEAT);
    }
    this.resume();
  }

  /** Cancel the run and free every GPU resource (none on a lost context); resolves `settled`. */
  stop(): void {
    if (this.stopped) return;
    this.halt();
    if (!this.lost) {
      this.budget.dispose(true);
      this.readback.destroy(true);
      this.layout.destroy();
    }
    this.settle();
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
    // A finished copy is harvested — and repainted — once the repaint is due; the final one at once.
    let harvested = false;
    // Ticks of the copy harvested here — read now: a copy issued later in this frame overwrites copyTicks.
    let harvestedTicks = -1;
    let repaintMs = 0;
    const t1 = performance.now();
    if (
      this.readback.pending &&
      this.copyReady &&
      (this.copyFinal || this.frameEvery !== undefined || this.throttle.due(now))
    ) {
      harvested = true;
      harvestedTicks = this.copyTicks;
      if (!this.readback.harvest(this.into ?? this.graph.positions, this.stats, this.extra)) {
        this.fail();
        return;
      }
      const final = this.copyFinal;
      if (this.copyTicks >= this.iterations && this.mode !== "run") this.settle();
      const r0 = performance.now();
      try {
        this.onFrame();
      } catch (error) {
        // The engine's repaint threw (a style accessor, say): report it as uncaught, as a repaint in its
        // own animation frame would, and keep the layout's loop and its state intact.
        reportUncaught(error);
      }
      repaintMs = performance.now() - r0;
      this.throttle.repainted(now, repaintMs);
      if (this.stopped) return; // the repaint superseded this layout
      if (final) this.finish();
    }
    const harvestMs = performance.now() - t0 - repaintMs;

    // 2. Encode work items within the budget — a readback being prepared first (nothing may move the
    // positions before its copy), then the ticks — and 3. a readback on the repaint cadence: its passes as
    // items, then the copy. Then the frame's one budget fence.
    const t2 = performance.now();
    this.now = now;
    const open = this.budget.open();
    const items = this.schedule.frame(open, this.hasWork, this.copyDue);
    const copied = this.schedule.copied;
    // `harvested` ⇔ onFrame ran (a failed harvest returned above). Not `repaintMs > 0`: a clamped clock
    // (~1 ms in Firefox and Safari without cross-origin isolation) measures a cheap repaint as 0.
    const frame = this.budget.endFrame(harvested);
    if (copied) this.copyFrame = frame;
    const t3 = performance.now();

    if (observers.size > 0) {
      sample.now = now;
      sample.harvestMs = harvestMs;
      sample.repaintMs = repaintMs;
      sample.encodeMs = t3 - t2;
      sample.items = items;
      sample.itemsMs = this.schedule.frameCostMs;
      sample.ticksDone = this.ticksDone;
      sample.harvested = harvested;
      sample.harvestedTicks = harvestedTicks;
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

  /** Whether the loop still has something to do: ticks to encode, a readback to prepare, or a copy to harvest. */
  private active(): boolean {
    return (this.mode !== "idle" && !this.failed) || this.finishing || this.schedule.reading || this.readback.pending;
  }

  /** Whether the current mode has ticks left to encode (a started tick is always finished). */
  private readonly hasWork = (): boolean => this.mode !== "idle" && !this.finishing && !this.failed;

  /** A tick's first band is next: write a drag's latest held positions, so the whole tick sees one set. */
  private writeHeld(): void {
    if (this.heldIds && this.heldPositions && this.drag) {
      this.drag.setHeldPositions(this.heldIds, this.heldPositions);
      this.heldIds = null;
      this.heldPositions = null;
    }
  }

  /**
   * Copy the positions into the PBO, fenced by this frame's budget fence. Between ticks the flat layout's
   * stats describe the previous positions, so {@link StreamSolver.prepareReadback} re-runs its reductions
   * first; after a prep they already describe these (positions change only at integrate and at the prep's
   * held-position write).
   */
  private issueCopy(betweenTicks: boolean): void {
    this.layout.prepareReadback(betweenTicks);
    this.readback.issue(this.layout);
    this.copyTicks = this.ticksDone;
    this.copyFinal = this.finishing;
    this.copiedTicks = this.ticksDone;
    this.copyReady = false;
  }

  /** A tick was completed: advance the mode's schedule. */
  private tickDone(): void {
    if (this.mode === "run" && this.ticksDone >= this.iterations) {
      if (this.dragging) {
        // The run's budget is spent with a drag live: keep reflowing at the drag heat. The next harvest
        // carries ticks ≥ iterations and settles.
        this.mode = "drag";
        this.drag?.hold(DRAG_HEAT);
      } else {
        this.finishing = true;
      }
    } else if (this.mode === "cool" && --this.coolLeft <= 0) {
      this.finishing = true;
    }
  }

  /** The final positions of a run (or a re-cool) were harvested and painted. */
  private finish(): void {
    this.finishing = false;
    if (this.mode === "run") {
      this.settle();
      if (this.dragging) {
        this.mode = "drag";
        this.drag?.hold(DRAG_HEAT);
      } else {
        this.mode = "idle";
      }
    } else if (this.mode === "cool") {
      this.mode = "idle";
      this.settle();
    }
  }

  /**
   * Whether to start a readback this frame: the PBO is free, there are new ticks, and the copy would be
   * ready (after the usual latency from a readback's start — its passes' wait for budget included — to its
   * copy's completion) when the next repaint is due — so a harvested frame is about one frame old, not a
   * whole repaint interval.
   */
  private readonly copyDue = (): boolean => {
    if (this.readback.pending) return false;
    // The final copy goes out as soon as the PBO is free; its harvest clears `finishing` (finish()).
    if (this.finishing) return true;
    if (!this.streaming) return false;
    const fresh = this.ticksDone - this.copiedTicks;
    if (fresh <= 0) return false;
    if (this.frameEvery !== undefined) return fresh >= this.frameEvery;
    return this.throttle.copyDue(this.now);
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private resume(): void {
    if (this.looping || this.stopped) return;
    this.looping = true;
    this.budget.resume();
    this.throttle.pause(); // the idle gap is not a stall
    this.raf = requestAnimationFrame(this.frame);
  }

  private settle(): void {
    if (this.settledOnce) return;
    this.settledOnce = true;
    this.resolveSettled();
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

  /** The context is gone: stop without another GL call, keep the last harvested positions, settle. */
  private lose(reason: string): void {
    if (this.stopped) return;
    this.lost = true;
    this.halt();
    this.budget.dispose(false);
    this.readback.destroy(false);
    this.reportFailure(reason, "");
    this.settle();
  }

  /** The reductions came back non-finite: stop encoding, keep the last finite positions, settle. */
  private fail(): void {
    this.failed = true;
    this.mode = "idle";
    this.finishing = false;
    this.looping = false;
    const [sx, sy, sv, count, maxX, maxY, negMinX, negMinY] = this.stats;
    this.reportFailure(
      "the layout became non-finite " +
        `(Σx=${sx}, Σy=${sy}, Σ|v|=${sv}, count=${count}, box=[${negMinX === undefined ? "" : -negMinX}, ` +
        `${negMinY === undefined ? "" : -negMinY}, ${maxX}, ${maxY}])`,
      "; keeping the last finite positions",
    );
    this.settle();
  }

  /** A failed run: to the owner's `onFailure` when it has one (it decides what follows), else one warning. */
  private reportFailure(reason: string, consequence: string): void {
    if (this.onFailure) this.onFailure(reason);
    else console.warn(`[d3gl] network layout({ backend: 'gpu' }) stopped: ${reason}${consequence}.`);
  }
}
