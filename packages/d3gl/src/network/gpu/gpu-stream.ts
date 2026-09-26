/**
 * The GPU layout's streaming run (#352, spec §6.5): one animation frame at a time, the solver's work
 * items are encoded within a GPU time budget and positions come back through a fenced PBO — the main
 * thread never waits for the GPU.
 *
 * Each frame runs, in this order:
 *
 * 1. **Harvest.** Poll the budget fences ({@link FrameBudget.beginFrame}); if the frame that copied the
 *    last readback has completed, `getBufferSubData` it into `graph.positions`. A read that is not ready
 *    is never forced, and it happens before any encode, so nothing it could wait on is freshly queued.
 * 2. **Repaint (throttled).** When a harvest has landed and at least `max(minFrameMs, 2 × repaint cost)`
 *    has passed since the previous one, `onFrame` runs — in this same frame, so the engine repaints the
 *    harvested positions with no extra frame of delay, and its draw calls reach the GPU before this
 *    frame's layout work. The repaint cost is the larger of its main-thread time and the **stall** it
 *    caused: the browser holds the next animation frame until the GPU has drawn the canvas, so the rAF
 *    gap after a repaint frame, less the usual interval, is what the render cost the GPU. Twice that caps
 *    the time spent on layout repaints at about 50% on both sides — the main thread and the GPU the
 *    layout shares with the renderer. A cheap render causes no stall and the term is inert.
 * 3. **Encode.** Work items (P, F_0 … F_{B−1}, I) while the {@link FrameBudget} admits them: at most 2
 *    frames of layout work in flight, a GPU budget of `min(10 ms, 0.6 × rAF interval)` per frame, and at
 *    most 2 ms of encode time. A tick may span frames; its result does not depend on how it was sliced.
 * 4. **Copy + fence.** On the repaint's cadence (reading back more often than repainting is waste), and
 *    when the one PBO is free, copy the positions into it; then insert the frame's single budget fence,
 *    which doubles as the copy's fence.
 *
 * `settled` resolves only after positions from the final tick have been harvested, so the engine's
 * settle handler sees them. The run then goes **idle** (the layout stays alive for a drag reheat, #183).
 * A non-finite layout (NaN / ∞ in the reductions' stats) stops the run with one warning, keeping the last
 * finite positions. A lost context (`isContextLost`, a failed fence wait, `webglcontextlost`) stops it
 * without touching GL again, with one warning.
 */
import { WebGLDevice } from "@luma.gl/webgl";
import { DRAG_HEAT, RECOOL_TICKS } from "../force.js";
import type { NetworkGraph } from "../graph.js";
import { deleteSync, insertSync, pollSync } from "../../webgl/fence.js";
import { AsyncPositionReadback, READBACK_STATS_FLOATS } from "./async-readback.js";
import { FrameBudget, itemCostMs, type FenceSource } from "./frame-budget.js";
import type { GpuForceLayout } from "./gpu-force-layout.js";

/** Minimum time between two layout repaints, ms: at most 20 per second (spec §15 Q4). */
export const MIN_FRAME_MS = 50;

/**
 * rAF timestamps land on vsync, so "50 ms since the last repaint" is 3 frames at 60 Hz, which a jittered
 * timestamp can report as 49.9 ms. Within this slack of the interval the repaint counts as due, so the
 * cadence stays 3 frames rather than slipping to 4.
 */
const THROTTLE_SLACK_MS = 2;

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
  /** Ticks completed so far in this run. */
  ticksDone: number;
  /** Whether a readback was harvested this frame. */
  harvested: boolean;
  /** Ticks the positions harvested this frame are the result of (−1 when nothing was harvested). */
  harvestedTicks: number;
  /** Whether a readback copy was issued this frame. */
  copied: boolean;
  /** Whether the gate blocked this frame (2 frames already in flight). */
  blocked: boolean;
  /** The controller's item cap and band count after this frame, and its budget. */
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
  private readonly layout: GpuForceLayout;
  private readonly graph: NetworkGraph;
  private readonly onFrame: () => void;
  private readonly iterations: number;
  private readonly frameEvery: number | undefined;
  private readonly minFrameMs: number;
  private readonly budget: FrameBudget<WebGLSync | null>;
  private readonly readback: AsyncPositionReadback;
  private readonly stats = new Float32Array(READBACK_STATS_FLOATS);
  private readonly sample: GpuFrameSample = {
    now: 0, harvestMs: 0, repaintMs: 0, encodeMs: 0, items: 0, ticksDone: 0,
    harvested: false, harvestedTicks: -1, copied: false, blocked: false, k: 1, bands: 1, budgetMs: 0,
  };
  private readonly canvas: EventTarget | null;
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

  /** Ticks integrated in this run (all modes). */
  private ticksDone = 0;
  /** Next item of the current tick: 0 = P, 1 … bands = F_{phase−1}, bands + 1 = I. */
  private phase = 0;
  /** Bands of the current tick, fixed when its P is encoded. */
  private tickBands = 1;
  /** The current mode's ticks are done: copy once more (unthrottled), harvest, then {@link finish}. */
  private finishing = false;

  /** Frame whose budget fence covers the pending copy, the ticks it holds, and whether it is the final one. */
  private copyFrame = 0;
  private copyTicks = 0;
  private copyFinal = false;
  /** Ticks of the last copy issued, and when it was issued (rAF time). */
  private copiedTicks = 0;
  private lastCopyAt = Number.NEGATIVE_INFINITY;
  /** A harvest is waiting for its repaint, and whether it is the final one. */
  private repaintDue = false;
  private repaintFinal = false;
  private lastRepaintAt = Number.NEGATIVE_INFINITY;
  private lastRepaintMs = 0;
  /** The rAF gap after the last repaint frame, less the median interval: what the render cost the GPU. */
  private lastStallMs = 0;
  /** The previous frame's rAF time, and whether that frame repainted. */
  private prevNow = Number.NaN;
  private repaintedPrev = false;

  constructor(device: WebGLDevice, layout: GpuForceLayout, graph: NetworkGraph, opts: GpuStreamOptions, onFrame: () => void) {
    this.gl = device.gl;
    this.layout = layout;
    this.graph = graph;
    this.onFrame = onFrame;
    this.iterations = opts.iterations;
    this.frameEvery = opts.frameEvery;
    this.minFrameMs = opts.minFrameMs ?? MIN_FRAME_MS;
    this.budget = new FrameBudget(glFences(this.gl), () => performance.now(), {
      nodes: layout.nodeCount,
      rows: layout.atlasRows,
      ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    });
    this.readback = new AsyncPositionReadback(device, layout);
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    const canvas = this.gl.canvas;
    this.canvas = canvas instanceof EventTarget ? canvas : null;
    this.canvas?.addEventListener("webglcontextlost", this.onContextLost);
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
   * Hold `ids` (writing their `positions` into the position texture) and reheat: the rest reflows around
   * them. Resumes the loop in `drag` mode, or lets a still-running initial run turn into it when it ends.
   */
  pin(ids: Uint32Array, positions?: Float32Array): void {
    if (this.stopped || this.failed) return;
    this.layout.setPinned(ids);
    if (positions) this.layout.setHeldPositions(ids, positions);
    this.dragging = true;
    if (this.mode === "idle" || this.mode === "cool") {
      this.mode = "drag";
      this.layout.hold(DRAG_HEAT);
      this.finishing = false;
      this.copyFinal = false; // a final copy in flight is harvested as an ordinary frame
    }
    this.resume();
  }

  /** Release every pin and re-cool over a short tail, then idle. */
  unpin(): void {
    if (this.stopped || this.failed) return;
    this.layout.setPinned(null);
    this.dragging = false;
    if (this.mode === "drag") {
      this.mode = "cool";
      this.coolLeft = RECOOL_TICKS;
      this.layout.cool(RECOOL_TICKS, DRAG_HEAT);
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
    if (this.repaintedPrev) this.lastStallMs = Math.max(0, now - this.prevNow - this.budget.intervalMs);
    this.prevNow = now;
    this.repaintedPrev = false;
    let harvested = false;
    if (this.readback.pending && this.copyFrame <= this.budget.completedFrame) {
      harvested = true;
      if (!this.readback.harvest(this.graph.positions, this.stats)) {
        this.fail();
        return;
      }
      this.repaintDue = true;
      this.repaintFinal = this.copyFinal;
      if (this.copyTicks >= this.iterations && this.mode !== "run") this.settle();
    }
    const t1 = performance.now();

    // 2. Repaint — throttled; the final positions always paint.
    let repaintMs = 0;
    if (this.repaintDue && (this.repaintFinal || this.frameEvery !== undefined || this.throttleOpen(now, this.lastRepaintAt))) {
      const final = this.repaintFinal;
      this.repaintDue = false;
      this.repaintFinal = false;
      this.lastRepaintAt = now;
      this.onFrame();
      repaintMs = performance.now() - t1;
      this.lastRepaintMs = repaintMs;
      this.repaintedPrev = true;
      if (this.stopped) return; // the repaint superseded this layout
      if (final) this.finish();
    }

    // 3. Encode work items within the budget.
    const t2 = performance.now();
    let items = 0;
    const open = this.budget.open();
    if (open) {
      while (this.hasWork()) {
        const cost = this.nextItemCost();
        if (!this.budget.admit(cost)) break;
        const band = this.phase > 0 && this.phase <= this.tickBands;
        this.encodeItem();
        this.budget.spent(cost, band);
        items++;
      }
    }

    // 4. The readback copy (on the repaint cadence), then the frame's one budget fence.
    const copied = this.copyDue(now);
    if (copied) {
      this.readback.issue(this.layout);
      this.copyTicks = this.ticksDone;
      this.copyFinal = this.finishing;
      this.copiedTicks = this.ticksDone;
      this.lastCopyAt = now;
    }
    const frame = this.budget.endFrame(repaintMs > 0);
    if (copied) this.copyFrame = frame;
    const t3 = performance.now();

    if (observers.size > 0) {
      sample.now = now;
      sample.harvestMs = t1 - t0;
      sample.repaintMs = repaintMs;
      sample.encodeMs = t3 - t2;
      sample.items = items;
      sample.ticksDone = this.ticksDone;
      sample.harvested = harvested;
      sample.harvestedTicks = harvested ? this.copyTicks : -1;
      sample.copied = copied;
      sample.blocked = !open;
      sample.k = this.budget.k;
      sample.bands = this.budget.bands;
      sample.budgetMs = this.budget.budgetMs;
      for (const observer of observers) observer(sample);
    }

    if (this.active()) this.raf = requestAnimationFrame(this.frame);
    else this.looping = false;
  };

  /** Whether the loop still has something to do: ticks to encode, a copy to harvest, a repaint due. */
  private active(): boolean {
    return (this.mode !== "idle" && !this.failed) || this.finishing || this.readback.pending || this.repaintDue;
  }

  /** Whether the current mode has ticks left to encode (a started tick is always finished). */
  private hasWork(): boolean {
    return this.mode !== "idle" && !this.finishing && !this.failed;
  }

  /** The estimated GPU time of the next item. */
  private nextItemCost(): number {
    const n = this.layout.nodeCount;
    if (this.phase === 0) return itemCostMs("prep", n, 1);
    if (this.phase <= this.tickBands) return itemCostMs("force", n, this.tickBands);
    return itemCostMs("integrate", n, 1);
  }

  /** Encode the next work item of the current tick. */
  private encodeItem(): void {
    if (this.phase === 0) {
      this.tickBands = Math.min(this.budget.bands, this.layout.atlasRows);
      this.layout.beginTick();
      this.phase = 1;
    } else if (this.phase <= this.tickBands) {
      this.layout.forceBand(this.phase - 1, this.tickBands);
      this.phase++;
    } else {
      this.layout.integrate();
      this.phase = 0;
      this.ticksDone++;
      this.tickDone();
    }
  }

  /** A tick was integrated: advance the mode's schedule. */
  private tickDone(): void {
    if (this.mode === "run" && this.ticksDone >= this.iterations) {
      if (this.dragging) {
        // The run's budget is spent with a drag live: keep reflowing at the drag heat. The next harvest
        // carries ticks ≥ iterations and settles.
        this.mode = "drag";
        this.layout.hold(DRAG_HEAT);
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
        this.layout.hold(DRAG_HEAT);
      } else {
        this.mode = "idle";
      }
    } else if (this.mode === "cool") {
      this.mode = "idle";
      this.settle();
    }
  }

  /** Whether to copy positions this frame: the PBO is free and a repaint's worth of time (or ticks) passed. */
  private copyDue(now: number): boolean {
    if (this.readback.pending) return false;
    // The final copy goes out as soon as the PBO is free; its harvest clears `finishing` (finish()).
    if (this.finishing) return true;
    if (this.ticksDone <= this.copiedTicks) return false;
    if (this.frameEvery !== undefined) return this.ticksDone - this.copiedTicks >= this.frameEvery;
    return this.throttleOpen(now, this.lastCopyAt);
  }

  /**
   * Whether the repaint interval `max(minFrameMs, 2 × max(last repaint's main thread, its GPU stall))` has
   * passed since `since`.
   */
  private throttleOpen(now: number, since: number): boolean {
    const interval = Math.max(this.minFrameMs, 2 * Math.max(this.lastRepaintMs, this.lastStallMs));
    return now - since >= interval - THROTTLE_SLACK_MS;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private resume(): void {
    if (this.looping || this.stopped) return;
    this.looping = true;
    this.budget.resume();
    this.repaintedPrev = false; // the idle gap is not a stall
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
    this.readback.abandon();
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
  }

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
    console.warn(`[d3gl] network layout({ backend: 'gpu' }) stopped: ${reason}.`);
    this.settle();
  }

  /** The reductions came back non-finite: stop encoding, keep the last finite positions, settle. */
  private fail(): void {
    this.failed = true;
    this.mode = "idle";
    this.finishing = false;
    this.repaintDue = false;
    this.looping = false;
    const [sx, sy, sv, count, maxX, maxY, negMinX, negMinY] = this.stats;
    console.warn(
      "[d3gl] network layout({ backend: 'gpu' }) stopped: the layout became non-finite " +
        `(Σx=${sx}, Σy=${sy}, Σ|v|=${sv}, count=${count}, box=[${negMinX === undefined ? "" : -negMinX}, ` +
        `${negMinY === undefined ? "" : -negMinY}, ${maxX}, ${maxY}]); keeping the last finite positions.`,
    );
    this.settle();
  }
}
