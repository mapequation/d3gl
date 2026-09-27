// ─────────────────────────────────────────────────────────────────────────────
// GPU time budget per animation frame for the streaming layout (#352, spec §6.5.3) — pure.
// ─────────────────────────────────────────────────────────────────────────────
//
// The GPU layout shares one GL context with the renderer, and the GPU does not preempt a draw. So a
// frame that queues a whole tick (13-17 ms at 325k, 45-55 ms at 1M) makes the next rendered frame wait
// behind it. The transport therefore encodes a tick as **work items** — P (prep: reductions, pyramid,
// hub chunks, force clear), F_b (the force pass over row band b of B) and I (integrate) — and this
// controller decides, per frame, how many of them to encode:
//
// - **Gate: at most 2 frames in flight** at 60 Hz — stated in time, 33 ms, so 4 frames at 120 Hz (a
//   frame's layout work is at most its budget, so the queued layout work stays ≤ ~20 ms at any rate;
//   2 frames of 8.3 ms would block behind any render longer than 17 ms). Every frame ends with one
//   *budget fence*. A frame encodes only if the fence of frame f−n has signalled; otherwise the GPU is
//   behind, so it encodes nothing, halves `k` (to half of what the late frame — the oldest in flight —
//   encoded) and holds it for 30 frames. Only that frame's lateness counts: the GPU runs work in order,
//   so nothing queued after its fence can have delayed it. A miss is not the layout's own, and only
//   blocks without resizing `k` or B, when the late frame encoded no item, or when an engine repaint
//   ran on the GPU ahead of its items — in the late frame itself, or in a frame that completed within
//   the last n frames before it. Repaint draws are not layout work, and the repaint throttle already
//   bounds them.
// - **`k` counts items**, not ticks, so a tick may span frames. It grows by one per frame while it is
//   the binding limit and no hold is active.
// - **Budget.** `min(budgetMs, 0.6 × median rAF interval)`: 10 ms at 60 Hz, 5 ms at 120 Hz. The items
//   of one frame are admitted while their *estimated* GPU time ({@link itemCostMs}) fits it; the first
//   item always runs, so a run always progresses.
// - **Bands.** B starts from the static estimate (a band ≈ half the budget); it doubles when one item
//   per frame still misses the gate *and a force band was among the late items* (slicing cannot shrink
//   P or I), up to 8× the static estimate, and halves — with `k` halved alongside, so a frame's GPU work stays the same — once two or
//   more items per frame have fit for 30 frames without a miss. (The spec's first draft halved only when
//   a whole tick fit in one frame; that can never happen again once B is large, so one transient stall —
//   a first-use shader compile — ratcheted B up for good: measured 64 bands and 0.4 ticks/s.)
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

/** A tick's work items: P, F_b, I. */
export type ItemKind = "prep" | "force" | "integrate";

/** Default GPU budget per frame, ms (spec §15 Q4: fixed for now). */
export const DEFAULT_BUDGET_MS = 10;
/** The layout's share of a frame interval the budget never exceeds. */
export const BUDGET_SHARE = 0.6;
/** Main-thread encode time per frame, ms. */
export const ENCODE_CAP_MS = 2;
/** Frames `k` is held after a miss, and frames of ≥ 2 items each that must fit before B halves. */
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
 * Adaptive slicing stops at this multiple of the static estimate: room for a GPU 8× slower than the
 * calibration device. Past it a thinner band stops paying for itself — each band re-runs the force
 * pass's fixed setup (measured on SwiftShader at 100k: a 1/16 band costs 22% of the whole pass, not 6%).
 */
export const MAX_BAND_GROWTH = 8;
/** Upper bound on `k`: a guard, not a tuning knob (the budget and the encode cap bind first). */
const MAX_ITEMS = 256;
/** rAF intervals the median is taken over. */
const INTERVAL_SAMPLES = 15;
/** The interval assumed before any frame has been seen. */
const DEFAULT_INTERVAL_MS = 1000 / 60;

/**
 * GPU time per node of each work item, in ns — measured on an M1 Max (ANGLE Metal) at 325k and 1M
 * nodes after #349/#350: the force pass (springs + Barnes-Hut repulsion + centering) is the bulk. Other
 * devices are unmeasured (spec §15 Q7); on a slower GPU the fence gate halves `k` and doubles B instead.
 */
export const ITEM_NS_PER_NODE: Readonly<Record<ItemKind, number>> = { prep: 5, force: 40, integrate: 1 };

/** GPU time per node of each work item, ns — a solver's cost model ({@link ITEM_NS_PER_NODE} for the flat layout). */
export type ItemCosts = Readonly<Record<ItemKind, number>>;

/**
 * The estimated GPU time of one work item, ms: a force band is 1/B of the force pass. `costs`: the
 * solver's model, default the flat layout's {@link ITEM_NS_PER_NODE}.
 */
export function itemCostMs(kind: ItemKind, nodes: number, bands: number, costs: ItemCosts = ITEM_NS_PER_NODE): number {
  const ms = (costs[kind] * nodes) / 1e6;
  return kind === "force" ? ms / Math.max(1, bands) : ms;
}

/** Frames that may be in flight at a frame interval: 33 ms worth, at least 2 (60 Hz: 2, 120 Hz: 4). */
export function framesInFlight(intervalMs: number): number {
  return Math.max(MAX_FRAMES_IN_FLIGHT, Math.min(MAX_IN_FLIGHT_FRAMES, Math.round(MAX_IN_FLIGHT_MS / intervalMs)));
}

/** The GPU budget of one frame: `min(limitMs, 0.6 × intervalMs)`. */
export function frameBudgetMs(limitMs: number, intervalMs: number): number {
  return Math.min(limitMs, BUDGET_SHARE * intervalMs);
}

/**
 * The static band count: bands of about half the budget, at least 1 and at most the atlas rows (and
 * {@link MAX_BANDS}). 325k at 10 ms → 3; 1M → 8.
 */
export function staticBands(nodes: number, budgetMs: number, rows: number, costs: ItemCosts = ITEM_NS_PER_NODE): number {
  const b = Math.ceil(itemCostMs("force", nodes, 1, costs) / (budgetMs / 2));
  return Math.max(1, Math.min(b, rows, MAX_BANDS));
}

/** Sizing inputs of a {@link FrameBudget}. */
export interface FrameBudgetOptions {
  /** Nodes the solver processes per item (every node, whatever the LOD state). */
  nodes: number;
  /** Rows of the position atlas: the most bands a force pass can be cut into. */
  rows: number;
  /** GPU budget per frame before the rAF clamp. Default {@link DEFAULT_BUDGET_MS}. */
  budgetMs?: number;
  /** Main-thread encode time per frame. Default {@link ENCODE_CAP_MS}. */
  encodeCapMs?: number;
  /** The solver's cost model. Default the flat layout's {@link ITEM_NS_PER_NODE}. */
  costs?: ItemCosts;
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
  private readonly nodes: number;
  private readonly costs: ItemCosts;
  private readonly maxBands: number;
  private readonly limitMs: number;
  private readonly encodeCapMs: number;
  /** Pending fences, oldest first, and the frame each one closed (parallel queues). */
  private readonly queue: F[] = [];
  private readonly queueFrames: number[] = [];
  /** Whether each queued frame encoded a force band (so a miss on it is one slicing can help). */
  private readonly queueForce: boolean[] = [];
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
  private adaptiveBands = 1;
  /** Consecutive open frames that absorbed ≥ 2 items with no miss. */
  private fitStreak = 0;
  private blockedPrev = false;
  private encodeAvgMs = 0;

  // Per frame.
  private opened = false;
  private frameItems = 0;
  private frameCostMs = 0;
  private frameForce = false;
  private openedAt = 0;
  private itemStart = 0;

  constructor(fences: FenceSource<F>, clock: () => number, opts: FrameBudgetOptions) {
    this.fences = fences;
    this.clock = clock;
    this.nodes = opts.nodes;
    this.costs = opts.costs ?? ITEM_NS_PER_NODE;
    this.maxBands = Math.max(1, Math.min(opts.rows, MAX_BANDS));
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

  /** Row bands for the next tick's force pass: the adaptive count, never below the static estimate. */
  get bands(): number {
    return Math.min(this.maxBands, Math.max(this.adaptiveBands, staticBands(this.nodes, this.budgetMs, this.maxBands, this.costs)));
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
    this.frameForce = false;
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
      this.queue.shift();
      this.queueFrames.shift();
      this.queueForce.shift();
      this.queueRepaint.shift();
      this.queueItems.shift();
    }
    return "ok";
  }

  /**
   * The gate: whether this frame may encode items (the fence of frame f−n has signalled, n from
   * {@link framesInFlight}). A blocked frame starting a miss that is the layout's own
   * ({@link layoutMiss}) halves `k` to half of what the late frame encoded — and doubles B when `k` was
   * already 1 and the late frame held a force band — then holds `k`; any other miss only blocks.
   */
  open(): boolean {
    const blocked = this.queue.length >= this.maxInFlight;
    if (blocked) {
      if (!this.blockedPrev && this.layoutMiss()) {
        if (this.items === 1 && this.queueForce[0] === true) {
          const cap = MAX_BAND_GROWTH * staticBands(this.nodes, this.frameBudget, this.maxBands, this.costs);
          this.adaptiveBands = Math.min(this.maxBands, cap, this.bands * 2);
        }
        this.items = Math.max(1, Math.floor((this.queueItems[0] ?? 0) / 2));
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
   * Count `ms` of GPU work the transport will add to this frame outside the items — a readback's
   * composition — against its budget. The first item is still always admitted.
   */
  reserve(ms: number): void {
    if (this.opened) this.frameCostMs += ms;
  }

  /**
   * Record that the admitted item was encoded (its measured encode time feeds the cap). `sliceable`:
   * the item is a force band, whose size B controls.
   */
  spent(costMs: number, sliceable = false): void {
    const dt = this.clock() - this.itemStart;
    this.encodeAvgMs = this.encodeAvgMs === 0 ? dt : this.encodeAvgMs * 0.8 + dt * 0.2;
    this.frameItems++;
    this.frameCostMs += costMs;
    if (sliceable) this.frameForce = true;
  }

  /**
   * End the frame: adapt `k` and B from what it encoded, then insert its budget fence — always, with or
   * without items. `repainted`: the engine repainted in this frame, so its render is in the fence too.
   * Returns the frame's index, which {@link completedFrame} reaches once the fence signals.
   */
  endFrame(repainted = false): number {
    if (this.opened) {
      if (this.frameItems >= this.items && this.hold === 0) this.items = Math.min(MAX_ITEMS, this.items + 1);
      // Two items per frame have fit for HOLD_FRAMES frames: one item twice the size fits as well.
      // Halve B (down to the static estimate) and k with it, so the next frames queue the same work.
      if (this.frameItems >= 2) {
        if (++this.fitStreak >= HOLD_FRAMES) {
          this.fitStreak = 0;
          const floor = staticBands(this.nodes, this.frameBudget, this.maxBands, this.costs);
          if (this.adaptiveBands > floor) {
            this.adaptiveBands = Math.max(floor, Math.floor(this.adaptiveBands / 2));
            this.items = Math.max(1, Math.floor(this.items / 2));
          }
        }
      } else {
        this.fitStreak = 0;
      }
    }
    this.queue.push(this.fences.insert());
    this.queueFrames.push(this.frameIndex);
    this.queueForce.push(this.frameForce);
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
    this.queueForce.length = 0;
    this.queueRepaint.length = 0;
    this.queueItems.length = 0;
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
