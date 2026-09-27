// ─────────────────────────────────────────────────────────────────────────────
// Which bands of which passes one animation frame of the streaming layout encodes (#352, #382,
// spec §6.5.3) — pure.
// ─────────────────────────────────────────────────────────────────────────────
//
// A solver's tick is a sequence of passes (stages), and so is the preparation of a readback (the nested
// layout's composition). Every pass is cut into row bands of at most half the frame budget
// ({@link FrameBudget.bandsFor}), and each band is one work item, so the budget holds at any N: no item is
// estimated above half of it, and the budget admits a frame's items while their sum fits. A tick's items
// may span frames; a readback's run exclusively (no tick item between its first pass and its copy), then
// the copy — frames after the readback started, when the budget holds its passes back, which is why the
// repaint throttle times a readback from its start.
//
// `GpuStream` owns the GL side (fences, the copy, the harvest); this schedule only walks the stages, so
// node tests can drive it with fake stages and a fake-fence {@link FrameBudget}.

/** What the schedule needs to know of a pass: its cost model and how finely it can be cut. */
export interface StageCost {
  /** Estimated GPU time of the whole pass that slicing divides, ms. */
  readonly costMs: number;
  /** Estimated GPU time each band pays whatever its size (its passes' setup), ms. */
  readonly fixedMs: number;
  /** The most bands it can be cut into — its output rows; 1: it always runs whole. */
  readonly rows: number;
}

/**
 * One pass of a streamed tick, or of a readback's preparation. The schedule encodes `run(b, B)` for
 * `b = 0 … B − 1` in order, B fixed from the first band to the last and sized by the frame budget. Its
 * result must not depend on B — each band writes its own rows, or scatters its own slots in submission
 * order.
 */
export interface StreamStage extends StageCost {
  /** Encode band `band` of `bands`. */
  run(band: number, bands: number): void;
}

/** Where a schedule's stages come from: the solver's tick, and its readback's preparation. */
export interface StageSource {
  /**
   * The passes of the tick about to start, in order — read once, before its first band; the last band
   * of the last pass completes the tick. The array may be the solver's own, reused.
   */
  tickStages(): readonly StreamStage[];
  /**
   * The passes a readback needs before its copy; none by default. They run as work items, exclusively:
   * no tick item runs between the first of them and the copy. They may start between any two items of a
   * tick, so they read the positions and write only their own state.
   */
  readbackStages?(): readonly StreamStage[];
}

/** The frame budget as the schedule uses it ({@link FrameBudget} is one). */
export interface ScheduleBudget {
  readonly budgetMs: number;
  bandsFor(costMs: number, rows: number, fixedMs?: number): number;
  admit(costMs: number): boolean;
  spent(costMs: number, sliceable?: boolean): void;
}

/** What the schedule's owner does at a tick's boundaries and around a readback. */
export interface ScheduleHooks {
  /** A tick is about to encode its first band (the flat layout writes a drag's held positions here). */
  tickStart(): void;
  /** A tick's last band was encoded. */
  tickEnd(): void;
  /**
   * A readback starts: its passes follow, as items, and then the copy — in this frame, or frames later when
   * the budget holds them back (the repaint throttle times a readback's latency from here).
   */
  readbackStart(): void;
  /** A readback's passes are all encoded: copy now. `betweenTicks`: no tick is under way. */
  copy(betweenTicks: boolean): void;
}

/** No stages: a readback that needs no passes of its own copies at once. */
const NO_STAGES: readonly StreamStage[] = [];

/**
 * Where the next work item starts in a sequence of stages — a tick's or a readback's: the stage, the
 * band, and the stage's band count (fixed at its first band).
 */
class StageCursor {
  stages: readonly StreamStage[] = NO_STAGES;
  stage = 0;
  band = 0;
  bands = 1;

  /** Whether stages are left. */
  get pending(): boolean {
    return this.stage < this.stages.length;
  }

  start(stages: readonly StreamStage[]): void {
    this.stages = stages;
    this.stage = 0;
    this.band = 0;
    this.bands = 1;
  }
}

/**
 * The streaming layout's work items, frame by frame (see the file header). Per animation frame its owner
 * calls {@link frame} between the frame budget's `open()` and `endFrame()`. Allocates nothing per frame.
 */
export class StreamSchedule {
  private readonly budget: ScheduleBudget;
  private readonly source: StageSource;
  private readonly hooks: ScheduleHooks;
  private readonly tick = new StageCursor();
  private started = false;
  private preparing = false;
  private readonly readback = new StageCursor();
  private copiedNow = false;
  /** The next item's estimated GPU time, and whether its pass has rows to slice further. */
  private itemMs = 0;
  private itemSliceable = false;
  private sliced = 1;
  private frameMs = 0;

  constructor(budget: ScheduleBudget, source: StageSource, hooks: ScheduleHooks) {
    this.budget = budget;
    this.source = source;
    this.hooks = hooks;
  }

  /** Whether a tick is under way (its first band encoded, its last not). */
  get tickStarted(): boolean {
    return this.started;
  }

  /** Whether a readback is being prepared: its passes started, the copy not issued yet. */
  get reading(): boolean {
    return this.preparing;
  }

  /** Whether the last {@link frame} issued a copy. */
  get copied(): boolean {
    return this.copiedNow;
  }

  /** The band count of the last sliced pass (of more than one row) that started. */
  get lastBands(): number {
    return this.sliced;
  }

  /** The estimated GPU time of the items the last {@link frame} encoded, ms. */
  get frameCostMs(): number {
    return this.frameMs;
  }

  /**
   * Encode one frame's items and return how many. A readback being prepared goes first — nothing may move
   * the positions before its copy — then ticks while `hasWork()` says ticks are left, then, when
   * `copyDue()` says so (asked once, after the ticks), a new readback: its passes as items, then the copy.
   * A readback with no passes copies at once, even in a frame the gate kept closed (`open` false).
   */
  frame(open: boolean, hasWork: () => boolean, copyDue: () => boolean): number {
    this.copiedNow = false;
    this.frameMs = 0;
    let items = this.preparing ? this.readbackItems(open) : 0;
    if (open && !this.preparing) {
      while (hasWork()) {
        if (!this.started) this.tick.start(this.source.tickStages());
        if (!this.admitNext(this.tick)) break;
        if (!this.started) {
          this.hooks.tickStart();
          this.started = true;
        }
        this.encode(this.tick);
        items++;
        if (this.tick.pending) continue;
        this.started = false;
        this.hooks.tickEnd();
      }
    }
    if (!this.preparing && !this.copiedNow && copyDue()) {
      this.preparing = true;
      this.hooks.readbackStart();
      this.readback.start(this.source.readbackStages?.() ?? NO_STAGES);
      items += this.readbackItems(open);
    }
    return items;
  }

  /** Forget a readback being prepared (the run stopped). */
  abandon(): void {
    this.preparing = false;
  }

  /** Encode the readback's remaining passes while the budget admits them; all encoded, copy. */
  private readbackItems(open: boolean): number {
    let items = 0;
    const cursor = this.readback;
    while (cursor.pending) {
      if (!open || !this.admitNext(cursor)) return items;
      this.encode(cursor);
      items++;
    }
    this.preparing = false;
    this.copiedNow = true;
    this.hooks.copy(!this.started);
    return items;
  }

  private bandsOf(stage: StageCost): number {
    return this.budget.bandsFor(stage.costMs, stage.rows, stage.fixedMs);
  }

  /**
   * Ask the budget to admit the next band of `cursor` as an item. A stage not yet started gets the band
   * count it would get now, which is what {@link encode} fixes.
   */
  private admitNext(cursor: StageCursor): boolean {
    const stage = cursor.stages[cursor.stage];
    if (!stage) return false;
    const bands = cursor.band === 0 ? this.bandsOf(stage) : cursor.bands;
    this.itemMs = stage.fixedMs + stage.costMs / bands;
    this.itemSliceable = stage.rows > 1;
    return this.budget.admit(this.itemMs);
  }

  /** Encode the admitted band, advancing `cursor`; a stage's band count is fixed at its first band. */
  private encode(cursor: StageCursor): void {
    const stage = cursor.stages[cursor.stage];
    if (!stage) return;
    if (cursor.band === 0) {
      cursor.bands = this.bandsOf(stage);
      if (stage.rows > 1) this.sliced = cursor.bands;
    }
    stage.run(cursor.band, cursor.bands);
    if (++cursor.band >= cursor.bands) {
      cursor.band = 0;
      cursor.stage++;
    }
    this.budget.spent(this.itemMs, this.itemSliceable);
    this.frameMs += this.itemMs;
  }
}
