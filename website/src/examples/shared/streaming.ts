/**
 * Drives a streaming source (an async batch generator) into a consumer, with
 * run/pause and restart — the plumbing shared by the streaming examples so each
 * `draw.ts` only has to say HOW to append a batch (the d3gl-specific part).
 */

export interface StreamSourceOpts {
  /** Re-read every batch (the controller may resize it adaptively). */
  batchSize: () => number;
  delayMs: number;
  seed: number;
  signal: { aborted: boolean };
}

export interface StreamControllerOpts<T> {
  /** Build a fresh source generator for a (re)started session. */
  source: (o: StreamSourceOpts) => AsyncGenerator<T[]>;
  /** Consume one freshly-arrived batch (append it to the layer + retain it). */
  onBatch: (batch: T[]) => void;
  /** Clear retained state + the layer at the start of a (re)started session. */
  onReset: () => void;
}

/**
 * One streaming session at a time. `restart(seed)` resets and starts a new
 * session (superseding any running one); `setRunning(false)` pauses the pump;
 * `dispose()` stops everything for good.
 *
 * Adaptive mode (`adaptive = true`): after each batch the controller times how long
 * `onBatch` (build + append + paint) took and nudges `batchSize` toward the number
 * of features that fit `frameBudgetMs` — so the stream runs as fast as the backend
 * allows while staying responsive (the old Bioregions "fit ~30fps" trick). The source
 * re-reads `batchSize` every batch via the getter passed in `restart`.
 */
export class StreamController<T> {
  batchSize = 1000;
  delayMs = 0;
  /** When true, `batchSize` is auto-tuned each batch to fit `frameBudgetMs`. */
  adaptive = false;
  /** Per-batch time budget for adaptive mode (≈30fps). */
  frameBudgetMs = 32;
  private session = 0;
  private running = true;
  private disposed = false;

  constructor(private readonly opts: StreamControllerOpts<T>) {}

  setRunning(v: boolean): void {
    this.running = v;
  }

  /** Reset + start a fresh session (supersedes any in flight). */
  restart(seed: number): void {
    if (this.disposed) return;
    this.opts.onReset();
    void this.pump(seed);
  }

  /** Stop the current session permanently (call from the example's dispose). */
  dispose(): void {
    this.disposed = true;
    this.session++;
  }

  private async pump(seed: number): Promise<void> {
    const my = ++this.session;
    const signal = { aborted: false };
    // Getter so adaptive resizes take effect on the very next batch the source pulls.
    const gen = this.opts.source({ batchSize: () => this.batchSize, delayMs: this.delayMs, seed, signal });
    for await (const batch of gen) {
      // Superseded (restart) or disposed → abort this session.
      if (this.disposed || my !== this.session) {
        signal.aborted = true;
        return;
      }
      // Paused → idle without consuming, until resumed / superseded / disposed.
      while (!this.running && !this.disposed && my === this.session) {
        await new Promise((r) => setTimeout(r, 60));
      }
      if (this.disposed || my !== this.session) {
        signal.aborted = true;
        return;
      }
      const t0 = performance.now();
      this.opts.onBatch(batch);
      if (this.adaptive) {
        // Steer toward the budget: scale by budget/elapsed, clamped to ≤2× per step so
        // it ramps quickly but doesn't oscillate. Bounded to [1, 1_000_000].
        const dt = Math.max(0.5, performance.now() - t0);
        const factor = Math.max(0.5, Math.min(2, this.frameBudgetMs / dt));
        this.batchSize = Math.max(1, Math.min(1_000_000, Math.round(this.batchSize * factor)));
      }
    }
  }
}

/** A random vivid color (used by the "randomize colors" button). Pass `alpha` < 1
 *  for translucent fills (e.g. overlapping polygon ranges). */
export function randomHsl(alpha = 1): string {
  const h = Math.floor(Math.random() * 360);
  return alpha >= 1 ? `hsl(${h}, 70%, 55%)` : `hsla(${h}, 70%, 55%, ${alpha})`;
}

/** The batch-size choices offered by the streaming examples' control. "adaptive"
 *  auto-tunes the batch to fit a frame budget (see StreamController.adaptive). */
export const BATCH_SIZES = ["adaptive", "1", "10", "100", "1000", "100000", "1000000"];
/** Seed batch size when adaptive mode starts, before it converges. */
export const ADAPTIVE_SEED_BATCH = 256;
/** The artificial per-batch delay choices (ms) — mirrors loading from a file. */
export const RATES_MS = ["0", "16", "100", "500"];
/** Data-size choices (total features to stream) and their numeric totals. */
export const DATA_SIZES = ["100k", "1M", "10M"];
export const DATA_SIZE_TOTALS: Record<string, number> = {
  "100k": 100_000,
  "1M": 1_000_000,
  "10M": 10_000_000,
};
