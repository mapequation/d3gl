// ─────────────────────────────────────────────────────────────────────────────
// GPU time budget per animation frame for the streaming layout (#352, spec §6.5.3) — pure.
// ─────────────────────────────────────────────────────────────────────────────
//
// The GPU layout shares one GL context with the renderer, and the GPU does not preempt a draw. So a
// frame that queues a whole tick (13-17 ms at 325k, 45-55 ms at 1M) makes the next rendered frame wait
// behind it. The transport therefore encodes a tick as **work items**: a tick is a sequence of passes
// (the flat layout's P, force and I; the nested layout's reductions, pyramid, springs, collision, …),
// each cut into row bands, and each band is one item (`stream-schedule.ts`).
// This controller sizes the bands and decides, per frame, how many items to encode:
//
// - **Gate: at most 2 frames in flight** at 60 Hz — stated in time, 33 ms, so 4 frames at 120 Hz (a
//   frame's layout work is at most its budget, so the queued layout work stays ≤ ~20 ms at any rate;
//   2 frames of 8.3 ms would block behind any render longer than 17 ms). Every frame ends with one
//   *budget fence*. A frame encodes only if the fence of frame f−n has signalled; otherwise the GPU is
//   behind, so it encodes nothing, halves `k` (to half of what the late frame — the oldest in flight —
//   encoded, never above the current `k`: a frame queued before an earlier cut may hold more) and holds it
//   for 30 frames. Only that frame's lateness counts: the GPU runs work in order,
//   so nothing queued after its fence can have delayed it. A miss changes nothing, and only blocks, when
//   no lever can shorten the late frame — it encoded no item, or one item that cannot be cut finer (a pass
//   bound by its fixed cost, a whole one-row pass or a band of a pass bound by its slowest fragment: fewer
//   items per frame cannot shorten it, and would only slow every other pass; #382) — or when it is not the layout's own: an engine repaint
//   ran on the GPU ahead of its items, in the late frame itself or in a frame that completed within the
//   last n frames before it. Repaint draws are not layout work, and the repaint throttle already bounds
//   them.
// - **`k` counts items**, not ticks, so a tick may span frames. It grows by one per frame while it is
//   the binding limit and no hold is active.
// - **Budget.** `min(budgetMs, 0.6 × median rAF interval)`: 10 ms at 60 Hz, 5 ms at 120 Hz. The items
//   of one frame are admitted while their *estimated* GPU time fits it; the first item always runs, so a
//   run always progresses. The bound is on the estimates: a pass that runs above its cost model makes the
//   frame's real GPU time exceed the budget by as much, and the gate above bounds what queues up.
// - **Bands.** Every pass of a tick is sliceable into row bands (#382): a pass whose estimated GPU time
//   is c, plus f that each band pays whatever its size, is cut into `⌈c / (budget / 2 − f)⌉` bands
//   ({@link stageBands}; into bands of the whole budget when a half-budget band would carry more fixed
//   than divisible work, f > budget / 4), so no band is estimated above half the budget — or above the
//   budget, for such a pass. Past f > 0.75 · budget no band fits the budget whatever the slicing, and that
//   band alone overruns it (no pass of the GPU layout comes near: the nested collision's work items, bound
//   by their longest item, pay ≤ 0.9 ms a band, #380).
// - **Band growth.** `g` is one factor shared by every pass, for a GPU slower than the estimates: it
//   scales the divisible estimate (`⌈g · c / (budget / 2 − f)⌉`), so a pass far below half the budget
//   stays one band however slow the GPU, and it never cuts a pass into more bands than carry their fixed
//   cost in divisible work (B·f ≤ c: past that a thinner band only pays f again). It doubles, up to 8×,
//   when one item per frame still misses the gate — `k` is 1 and the late frame held one item — *and that
//   item was a band cut at the current growth that twice the growth would cut finer*. It halves — with `k`
//   halved alongside — once 30 frames that held two consecutive bands of a pass, together at least one band
//   of half the growth, have each finished before the gate had to wait on them (their fence seen before
//   frame f+n, where a miss would be decided): at half the growth those two bands are one band of the same
//   work, and it kept up as well. Evidence counts only for the growth it is about: a pass keeps
//   the bands it started with, so a band of a pass cut at another growth (one that outlived a change), or a
//   frame queued before a change, says nothing about the current one. (Growing on such a band once took the
//   flat 1M force pass at 120 Hz to growth 8, whose 64 bands, MAX_BANDS, are growth 4's too: no frame could
//   then hold two bands that half the growth cuts coarser, and it stayed there ~3,150 frames on the real
//   GPU.) The 30 frames are counted since the last miss that acted and need not be consecutive: a frame
//   without such a pair, or one whose fence is seen late, neither counts nor resets them, and a miss that
//   only blocks (a band that cannot be cut finer, an engine repaint) says nothing about a band twice the
//   size. Grow on a frame the gate blocked on, shrink on frames it never had to wait on: the frame between
//   (seen exactly at f+n) is a dead band, so the growth does not chatter at the gate's edge. At 60 Hz that
//   is "seen by the next frame"; at 120 Hz it tolerates the browser's sync status trailing the GPU by up to
//   two frames (on an M1 Max 35-45% of full frames' fences were first seen a frame late; requiring the next
//   frame, a transport that sees every one late never halved). (The spec's first draft halved only when a
//   whole tick fit in one frame; that can never happen again once B is large, so one transient stall — a
//   first-use shader compile — ratcheted B up for good: measured 64 bands and 0.4 ticks/s. #382's first
//   version counted any frame of two items, which in a nested tick — tens of small passes beside one large
//   band — nearly every frame is, so the growth fell back and missed again.)
// - **Main-thread cap.** Items are also admitted only while the measured encode time of the frame stays
//   within `encodeCapMs` (2 ms) — the binding limit at small N, where the GPU work is tiny.
//
// WebGL sync status only changes between tasks, so a fence is never seen signalled in the task that
// inserted it: the controller reasons in frames. Every frame inserts its fence, a blocked one too (it may
// carry a readback copy), so while the GPU stays behind the queue grows by one empty sync object per
// frame: the gate bounds the queued layout *work*, not the number of fences. Fences signal in submission order, so "frame f's fence
// signalled" also means every earlier frame's work (and any readback copied in it) has completed —
// {@link FrameBudget.completedFrame} is what the readback harvest keys on. No timer queries: the
// estimate is static per device class and the fences correct it (spec §16 lists the follow-up).

import type { StageCost } from "./stream-schedule.js";

/** What a non-blocking fence poll found. */
export type FenceStatus = "signaled" | "pending" | "lost";

/** The fences a {@link FrameBudget} inserts and polls: GL sync objects in the transport, fakes in tests. */
export interface FenceSource<F> {
  /** Insert a fence after every command encoded so far, flushed so that it can signal. */
  insert(): F;
  /** Poll without blocking; `"lost"` when the context is gone (the poll failed). */
  poll(fence: F): FenceStatus;
  /** Delete a fence that has signalled, or every fence when the run stops. */
  drop(fence: F): void;
}

/** The passes of a flat tick: P, the force pass (in bands), I. */
export type FlatPass = "prep" | "force" | "integrate";

/** Default GPU budget per frame, ms (spec §15 Q4: fixed for now). */
export const DEFAULT_BUDGET_MS = 10;
/** The layout's share of a frame interval the budget never exceeds. */
export const BUDGET_SHARE = 0.6;
/** Main-thread encode time per frame, ms. */
export const ENCODE_CAP_MS = 2;
/** Frames `k` is held after a miss, and frames of two bands each that must keep up before the band growth halves. */
export const HOLD_FRAMES = 30;
/** Frames of layout work that may be in flight on the GPU, at 60 Hz. */
export const MAX_FRAMES_IN_FLIGHT = 2;
/** The same bound in time, so higher refresh rates keep the latency it allows (2 frames at 60 Hz). */
const MAX_IN_FLIGHT_MS = MAX_FRAMES_IN_FLIGHT * (1000 / 60);
/** Never more frames than this in flight, whatever the refresh rate. */
const MAX_IN_FLIGHT_FRAMES = 8;
/** Upper bound on the row bands of one force pass (≥ 9 rows each at 325k's 571 rows). */
export const MAX_BANDS = 64;
/**
 * Adaptive slicing stops at this multiple of the cost estimate: room for a GPU 8× slower than the
 * calibration device. Past it a thinner band stops paying for itself — each band re-runs the pass's
 * fixed setup (measured on SwiftShader at 100k: a 1/16 force band costs 22% of the whole pass, not 6%).
 */
export const MAX_BAND_GROWTH = 8;
/** Upper bound on `k`: a guard, not a tuning knob (the budget and the encode cap bind first). */
const MAX_ITEMS = 256;
/** rAF intervals the median is taken over. */
const INTERVAL_SAMPLES = 15;
/** The interval assumed before any frame has been seen. */
const DEFAULT_INTERVAL_MS = 1000 / 60;

/**
 * GPU time per node of each pass of the flat layout's tick, in ns — measured on an M1 Max (ANGLE Metal)
 * at 325k and 1M nodes after #349/#350: the force pass (springs + Barnes-Hut repulsion + centering) is the
 * bulk. Other devices are unmeasured (spec §15 Q7); on a slower GPU the fence gate halves `k` and grows
 * the bands instead. (The nested layout's model is `nested-plan.ts`'s.)
 */
export const FLAT_NS_PER_NODE: Readonly<Record<FlatPass, number>> = { prep: 5, force: 40, integrate: 1 };

/** The estimated GPU time of a whole pass of the flat tick over `nodes` nodes, ms (the schedule divides it into bands). */
export function flatPassCostMs(pass: FlatPass, nodes: number): number {
  return (FLAT_NS_PER_NODE[pass] * nodes) / 1e6;
}

/** Frames that may be in flight at a frame interval: 33 ms worth, at least 2 (60 Hz: 2, 120 Hz: 4). */
export function framesInFlight(intervalMs: number): number {
  return Math.max(MAX_FRAMES_IN_FLIGHT, Math.min(MAX_IN_FLIGHT_FRAMES, Math.round(MAX_IN_FLIGHT_MS / intervalMs)));
}

/** The GPU budget of one frame: `min(limitMs, 0.6 × intervalMs)`. */
export function frameBudgetMs(limitMs: number, intervalMs: number): number {
  return Math.min(limitMs, BUDGET_SHARE * intervalMs);
}

/** The GPU time a band aims at: half the frame budget, so two fit a frame and the first never overruns it. */
export function bandTargetMs(budgetMs: number): number {
  return budgetMs / 2;
}

/**
 * The bands a pass is cut into (#382). `costMs` is the pass's estimated GPU time that slicing divides,
 * `fixedMs` what every band pays whatever its size (its render passes' setup, or the longest single
 * fragment, which every band may have to wait for), and `growth` the fence controller's band growth.
 *
 * One rule decides both how the budget cuts a pass and how far the growth may: **a band should carry at
 * least as much divisible work as fixed cost** — past that, more than half of every band is `fixedMs` paid
 * again, and the tick costs more than twice its work.
 *
 * - A band aims at half the budget ({@link bandTargetMs}), so two fit a frame: `⌈costMs / (target −
 *   fixedMs)⌉` bands, each with `target − fixedMs` of work. That holds the rule while `fixedMs ≤ target /
 *   2`, a quarter of the budget.
 * - Past that, a half-budget band would carry more fixed than divisible work, so the bands aim at the whole
 *   budget instead (one per frame): `⌈costMs / (budget − fixedMs)⌉`. (At the switch, half-budget bands
 *   would cost the tick `2 · costMs`, whole-budget ones `4/3 · costMs`.) Either way a band gets at least half
 *   a target of divisible work — past `fixedMs ≥ 0.75 · budget` no band count keeps it within the budget.
 * - The growth scales the divisible estimate (`⌈growth · costMs / room⌉`), but adds bands only while each
 *   carries its fixed cost in work (`bands · fixedMs ≤ costMs`); it never takes away the bands the budget
 *   needs. A pass with no fixed cost (the flat force pass) grows up to {@link MAX_BAND_GROWTH}×.
 *
 * At least 1 band, at most `rows` (a pass cannot be cut finer than its rows) and {@link MAX_BANDS}. The flat
 * force pass at a 10 ms budget: 325k → 3 bands, 1M → 8; at 5 ms (120 Hz), 1M → 16. The nested collision's
 * work items at 1M (7.2 ms of work, 0.42 ms per band): 2 bands at 10 ms, 4 at 5 ms.
 */
export function stageBands(costMs: number, budgetMs: number, rows: number, growth = 1, fixedMs = 0): number {
  const target = bandTargetMs(budgetMs);
  const room = target - fixedMs >= fixedMs ? target - fixedMs : budgetMs - fixedMs;
  const perBand = Math.max(room, target / 2);
  const needed = Math.ceil(costMs / perBand);
  const paying = fixedMs > 0 ? Math.floor(costMs / fixedMs) : MAX_BANDS;
  const b = Math.max(needed, Math.min(Math.ceil((growth * costMs) / perBand), paying));
  return Math.max(1, Math.min(b, rows, MAX_BANDS));
}

/** Sizing inputs of a {@link FrameBudget}. */
export interface FrameBudgetOptions {
  /** GPU budget per frame before the rAF clamp. Default {@link DEFAULT_BUDGET_MS}. */
  budgetMs?: number;
  /** Main-thread encode time per frame. Default {@link ENCODE_CAP_MS}. */
  encodeCapMs?: number;
}

/**
 * The fence controller. Per animation frame the transport calls, in order: {@link beginFrame} (poll
 * fences — before the harvest), {@link open} (the gate), then {@link admit} / {@link spent} around each
 * item it encodes, and {@link endFrame} (insert the frame's budget fence — after any readback copy, so
 * it doubles as the readback fence). Allocates nothing per frame beyond the fence it inserts (the median
 * interval is sorted in a fixed scratch array, once per frame).
 */
export class FrameBudget<F> {
  private readonly fences: FenceSource<F>;
  private readonly clock: () => number;
  private readonly limitMs: number;
  private readonly encodeCapMs: number;
  /** Pending fences, oldest first, and the frame each one closed (parallel queues). */
  private readonly queue: F[] = [];
  private readonly queueFrames: number[] = [];
  /**
   * The band growth at which each queued frame held a band cut at that growth that twice the growth would
   * cut finer (so a miss on it is one slicing can help); 0 when it held none.
   */
  private readonly queueFiner: number[] = [];
  /**
   * The band growth at which each queued frame held two consecutive bands of a pass that half the growth
   * would cut coarser; 0 when it held none. Such a frame that kept up (seen before the gate waited on it) is evidence for halving.
   */
  private readonly queuePair: number[] = [];
  /** Whether each queued frame also carried the engine's repaint (so a miss on it is not the layout's). */
  private readonly queueRepaint: boolean[] = [];
  /** Work items each queued frame encoded (a miss halves `k` from the late frame's count). */
  private readonly queueItems: number[] = [];
  /** The newest completed frame that carried the engine's repaint (−∞ before any). */
  private repaintDone = Number.NEGATIVE_INFINITY;
  /** Ring of the last rAF intervals, and how many are valid. */
  private readonly intervals = new Float64Array(INTERVAL_SAMPLES);
  private readonly sorted = new Float64Array(INTERVAL_SAMPLES);
  private intervalCount = 0;
  private intervalNext = 0;
  /** The median of {@link intervals}, recomputed once per frame in {@link beginFrame}. */
  private median = DEFAULT_INTERVAL_MS;
  private lastNow = Number.NaN;
  /** This frame's budget, fixed at {@link beginFrame} (the median moves only between frames). */
  private frameBudget: number;
  /** Frames that may be in flight, fixed at {@link beginFrame} from the median interval. */
  private maxInFlight = MAX_FRAMES_IN_FLIGHT;

  private frameIndex = 0;
  private done = 0;
  private items = 1;
  private hold = 0;
  /** The band growth `g` (1, 2, 4 or 8): the factor every pass's cost estimate is sliced by. */
  private bandGrowth = 1;
  /** Frames that held two consecutive bands of a pass the growth cut finer and kept up, since the last miss that acted or growth change. */
  private fitStreak = 0;
  private blockedPrev = false;
  private encodeAvgMs = 0;

  // Per frame.
  private opened = false;
  private frameItems = 0;
  private frameCostMs = 0;
  private frameFiner = false;
  private framePair = false;
  /** The pass and band of the frame's last item (null: none yet). */
  private lastPass: StageCost | null = null;
  private lastBand = 0;
  private openedAt = 0;
  private itemStart = 0;

  constructor(fences: FenceSource<F>, clock: () => number, opts: FrameBudgetOptions = {}) {
    this.fences = fences;
    this.clock = clock;
    this.limitMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    this.encodeCapMs = opts.encodeCapMs ?? ENCODE_CAP_MS;
    this.frameBudget = frameBudgetMs(this.limitMs, DEFAULT_INTERVAL_MS);
  }

  /** Items the current frame may encode at most. */
  get k(): number {
    return this.items;
  }

  /** The GPU budget of a frame: `min(budgetMs, 0.6 × median rAF interval)`. */
  get budgetMs(): number {
    return this.frameBudget;
  }

  /** The median rAF interval over the last frames (60 Hz before any). */
  get intervalMs(): number {
    return this.median;
  }

  /** The band growth `g`: 1 until one item per frame misses, then up to {@link MAX_BAND_GROWTH}. */
  get growth(): number {
    return this.bandGrowth;
  }

  /**
   * The row bands of a pass that starts now ({@link stageBands} at this frame's budget and the current
   * growth): `costMs` its estimated GPU time, `rows` the most bands it can be cut into, `fixedMs` what
   * each band pays whatever its size.
   */
  bandsFor(costMs: number, rows: number, fixedMs = 0): number {
    return stageBands(costMs, this.frameBudget, rows, this.bandGrowth, fixedMs);
  }

  /** The last frame whose budget fence has signalled: all its GPU work, readback copy included, is done. */
  get completedFrame(): number {
    return this.done;
  }

  /** Index of the current frame (1 for the first). */
  get frame(): number {
    return this.frameIndex;
  }

  /** Budget fences still pending. */
  get inFlight(): number {
    return this.queue.length;
  }

  /**
   * Start frame `now` (the rAF timestamp): record the interval and drop every fence that has signalled,
   * oldest first. `"lost"` when a poll failed — the context is gone and the run must stop without GL.
   * A frame that held two consecutive bands of a pass the growth cut finer, and whose fence is seen before
   * frame f+n (n from {@link framesInFlight}: before the gate had to wait on it), kept up: after
   * {@link HOLD_FRAMES} of them since the last miss that acted, the growth halves, and `k` with it.
   */
  beginFrame(now: number): "ok" | "lost" {
    if (!Number.isNaN(this.lastNow)) {
      this.pushInterval(now - this.lastNow);
      this.median = this.medianInterval();
      this.frameBudget = frameBudgetMs(this.limitMs, this.median);
      this.maxInFlight = framesInFlight(this.median);
    }
    this.lastNow = now;
    this.frameIndex++;
    this.opened = false;
    this.frameItems = 0;
    this.frameCostMs = 0;
    this.frameFiner = false;
    this.framePair = false;
    this.lastPass = null;
    while (this.queue.length > 0) {
      const fence = this.queue[0];
      const frame = this.queueFrames[0];
      if (fence === undefined || frame === undefined) break;
      const status = this.fences.poll(fence);
      if (status === "lost") return "lost";
      if (status === "pending") break;
      this.fences.drop(fence);
      this.done = frame;
      if (this.queueRepaint[0] === true) this.repaintDone = frame;
      if (this.queuePair[0] === this.bandGrowth && this.frameIndex - frame < this.maxInFlight) this.pairFit();
      this.queue.shift();
      this.queueFrames.shift();
      this.queueFiner.shift();
      this.queuePair.shift();
      this.queueRepaint.shift();
      this.queueItems.shift();
    }
    return "ok";
  }

  /**
   * The gate: whether this frame may encode items (the fence of frame f−n has signalled, n from
   * {@link framesInFlight}). A blocked frame starting a miss that is the layout's own ({@link layoutMiss})
   * halves `k` to half of what the late frame encoded (never raising it) — and doubles the band growth when
   * `k` was already 1, the late frame held one item, and it was a band cut at the current growth that twice
   * the growth would cut finer — then holds `k`. A late frame of one item that cannot be cut finer (or whose
   * evidence is about another growth), and any other miss, only block: no lever shortens such an item, and
   * fewer items per frame would only slow every other pass (#382).
   */
  open(): boolean {
    const blocked = this.queue.length >= this.maxInFlight;
    if (blocked) {
      const late = this.queueItems[0] ?? 0;
      const finer = this.queueFiner[0] === this.bandGrowth;
      if (!this.blockedPrev && this.layoutMiss() && (late >= 2 || finer)) {
        if (this.items === 1 && late === 1 && finer) {
          this.bandGrowth = Math.min(MAX_BAND_GROWTH, this.bandGrowth * 2);
        }
        this.items = Math.max(1, Math.min(this.items, Math.floor(late / 2)));
        this.hold = HOLD_FRAMES;
        this.fitStreak = 0;
      } else if (this.hold > 0) {
        this.hold--;
      }
      this.blockedPrev = true;
      return false;
    }
    this.blockedPrev = false;
    if (this.hold > 0) this.hold--;
    this.opened = true;
    this.openedAt = this.clock();
    return true;
  }

  /**
   * Whether one more item of estimated GPU time `costMs` may be encoded this frame: the gate is open,
   * fewer than `k` items went out, and — after the first — the estimated GPU time stays within the budget
   * and the measured encode time within the cap. Starts the item's encode clock.
   */
  admit(costMs: number): boolean {
    if (!this.opened || this.frameItems >= this.items) return false;
    if (this.frameItems > 0) {
      if (this.frameCostMs + costMs > this.budgetMs) return false;
      if (this.clock() - this.openedAt + this.encodeAvgMs > this.encodeCapMs) return false;
    }
    this.itemStart = this.clock();
    return true;
  }

  /**
   * Record that the admitted item was encoded (its measured encode time feeds the cap): band `band` of
   * `bands` of `pass` (a pass of one row runs whole, as its band 0 of 1). The band growth reads it, always
   * about the current growth g: whether the band is no larger than g cuts it and 2g would cut it finer (a
   * miss on this frame is then one slicing can help), and whether it follows the pass's previous band in
   * this frame while g/2 would cut the pass coarser and the two carry at least one band of g/2 (they are
   * then that band's work).
   */
  spent(costMs: number, pass: StageCost, band: number, bands: number): void {
    const dt = this.clock() - this.itemStart;
    this.encodeAvgMs = this.encodeAvgMs === 0 ? dt : this.encodeAvgMs * 0.8 + dt * 0.2;
    this.frameItems++;
    this.frameCostMs += costMs;
    const g = this.bandGrowth;
    if (g < MAX_BAND_GROWTH && bands >= this.bandsAt(pass, g) && this.bandsAt(pass, 2 * g) > bands) this.frameFiner = true;
    if (g > 1 && pass === this.lastPass && band === this.lastBand + 1) {
      const half = this.bandsAt(pass, g / 2);
      if (half < bands && bands <= 2 * half) this.framePair = true;
    }
    this.lastPass = pass;
    this.lastBand = band;
  }

  /**
   * End the frame: grow `k` when it bound, then insert the frame's budget fence — always, with or without
   * items. `repainted`: the engine repainted in this frame, so its render is in the fence too. Returns the
   * frame's index, which {@link completedFrame} reaches once the fence signals.
   */
  endFrame(repainted = false): number {
    if (this.opened && this.frameItems >= this.items && this.hold === 0) this.items = Math.min(MAX_ITEMS, this.items + 1);
    this.queue.push(this.fences.insert());
    this.queueFrames.push(this.frameIndex);
    this.queueFiner.push(this.opened && this.frameFiner ? this.bandGrowth : 0);
    this.queuePair.push(this.opened && this.framePair ? this.bandGrowth : 0);
    this.queueRepaint.push(repainted);
    this.queueItems.push(this.frameItems);
    return this.frameIndex;
  }

  /** A run resumes after idling: the gap since its last frame is not a frame interval. */
  resume(): void {
    this.lastNow = Number.NaN;
  }

  /** Stop: drop every pending fence — or none when the context is lost (no GL calls then). */
  dispose(dropFences: boolean): void {
    if (dropFences) for (const fence of this.queue) this.fences.drop(fence);
    this.queue.length = 0;
    this.queueFrames.length = 0;
    this.queueFiner.length = 0;
    this.queuePair.length = 0;
    this.queueRepaint.length = 0;
    this.queueItems.length = 0;
  }

  /** The bands `pass` would be cut into now at growth `growth`. */
  private bandsAt(pass: StageCost, growth: number): number {
    return stageBands(pass.costMs, this.frameBudget, pass.rows, growth, pass.fixedMs);
  }

  /**
   * A frame that held two consecutive bands of a pass the growth cut finer kept up: at half the growth they
   * are one band of the same work (one fixed cost fewer), which would have kept up too. After
   * {@link HOLD_FRAMES} of them since the last miss that acted, halve the growth (down to 1) and `k` with it.
   */
  private pairFit(): void {
    if (++this.fitStreak < HOLD_FRAMES) return;
    this.fitStreak = 0;
    this.bandGrowth /= 2;
    this.items = Math.max(1, Math.floor(this.items / 2));
  }

  /**
   * Whether a miss on the oldest frame in flight is the layout's own, so `k` or B should shrink: that
   * frame encoded items, and no engine repaint ran ahead of them on the GPU — neither in that frame nor
   * in one that completed within the last {@link maxInFlight} frames before it (a render's GPU time
   * delays every frame queued after it). Frames queued after the late one cannot have delayed its fence.
   */
  private layoutMiss(): boolean {
    const late = this.queueFrames[0];
    if (late === undefined || this.queueRepaint[0] === true || (this.queueItems[0] ?? 0) === 0) return false;
    return late - this.repaintDone >= this.maxInFlight;
  }

  private pushInterval(ms: number): void {
    this.intervals[this.intervalNext] = ms;
    this.intervalNext = (this.intervalNext + 1) % INTERVAL_SAMPLES;
    if (this.intervalCount < INTERVAL_SAMPLES) this.intervalCount++;
  }

  /**
   * The median of the valid samples (indices `[0, intervalCount)` until the ring is full), sorted in a
   * fixed scratch array padded with +∞: no view, no allocation.
   */
  private medianInterval(): number {
    const n = this.intervalCount;
    if (n === 0) return DEFAULT_INTERVAL_MS;
    const s = this.sorted;
    s.set(this.intervals);
    for (let i = n; i < INTERVAL_SAMPLES; i++) s[i] = Number.POSITIVE_INFINITY;
    s.sort();
    return s[n >> 1] ?? DEFAULT_INTERVAL_MS;
  }
}
