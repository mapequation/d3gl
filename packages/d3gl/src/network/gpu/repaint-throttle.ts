// ─────────────────────────────────────────────────────────────────────────────
// The streaming GPU layout's repaint throttle (#352, spec §6.5.4) — pure.
// ─────────────────────────────────────────────────────────────────────────────
//
// A harvest is not a repaint. The throttle spaces the engine's layout repaints so they take at most about
// half of the time, on the main thread and on the GPU the layout shares with the renderer:
//
//     interval = max(minFrameMs, 2 × max(last repaint's main-thread ms, its GPU stall))
//
// The **GPU stall** is the rAF gap after a repaint frame, less the usual interval: where the browser holds
// the next animation frame until the canvas is drawn (SwiftShader: seconds per 100k-node render), that gap
// is what the render cost the GPU. A cheap render causes no stall and the term is inert.
//
// Not every gap is a render cost. A hidden page pauses rAF; a long task (GC, the app's own work) delays
// it. Taken at face value, one such gap after a repaint frame would space the next repaint by twice the
// gap — a tab hidden for 60 s would show no layout frame for another 60 s. Two rules keep that out:
//
// - **A pause is not sampled.** {@link RepaintThrottle.pause} (the stream calls it on `visibilitychange`
//   and when an idle loop resumes) drops the pending stall sample and any copy-latency sample spanning it.
// - **A stall must repeat.** The throttle uses the smaller of the last two stall samples. A render that
//   really costs GPU time stalls the frame after *every* repaint, so it is honoured from its second repaint
//   on; a one-off gap is a single sample and never widens the throttle. It also recovers at once: the first
//   repaint that does not stall brings the term back to 0.
//
// The **copy latency** the throttle plans with runs from the start of a readback — the frame the stream
// decided to copy — to the frame its copy is seen complete. A readback whose passes wait for frame budget
// (the nested layout's composition, #382) copies a frame or more after it started, and that wait is part of
// how long the positions take to be ready: timed from the copy instead, the throttle would start each such
// readback a frame too late, and every repaint would slip a frame behind its cadence.

/** Minimum time between two layout repaints, ms: at most 20 per second (spec §15 Q4). */
export const MIN_FRAME_MS = 50;

/**
 * rAF timestamps land on vsync, so "50 ms since the last repaint" is 3 frames at 60 Hz, which a jittered
 * timestamp can report as 49.9 ms. Within this slack of the interval the repaint counts as due, so the
 * cadence stays 3 frames rather than slipping to 4.
 */
const THROTTLE_SLACK_MS = 2;

/**
 * When the next layout repaint — and the readback copy that feeds it — is due. The stream calls, per
 * frame: {@link beginFrame}, then {@link due} before harvesting, {@link repainted} after the engine's
 * repaint, and {@link copyDue} / {@link readbackStarted} / {@link copyCompleted} around its readbacks.
 * Allocates nothing.
 */
export class RepaintThrottle {
  private readonly minFrameMs: number;
  private lastRepaintAt = Number.NEGATIVE_INFINITY;
  private lastRepaintMs = 0;
  /** The last two GPU stall samples, newest first. */
  private stall0 = 0;
  private stall1 = 0;
  /** The previous frame's rAF time, and whether that frame repainted (so this frame's gap is its stall). */
  private prevNow = Number.NaN;
  private repaintedPrev = false;
  /**
   * rAF time from starting a readback to seeing its copy's frame complete, and when the pending readback
   * started (NaN: none, or a pause intervened since).
   */
  private copyLatencyMs = 1000 / 60;
  private copyAt = Number.NaN;

  constructor(minFrameMs = MIN_FRAME_MS) {
    this.minFrameMs = minFrameMs;
  }

  /** The current repaint interval, ms: `max(minFrameMs, 2 × max(repaint main-thread ms, repeated stall))`. */
  get intervalMs(): number {
    return Math.max(this.minFrameMs, 2 * Math.max(this.lastRepaintMs, Math.min(this.stall0, this.stall1)));
  }

  /**
   * Start frame `now` (rAF time), `intervalMs` being the median frame interval: if the previous frame
   * repainted, the gap beyond the interval is that repaint's stall.
   */
  beginFrame(now: number, intervalMs: number): void {
    if (this.repaintedPrev && !Number.isNaN(this.prevNow)) {
      this.stall1 = this.stall0;
      this.stall0 = Math.max(0, now - this.prevNow - intervalMs);
    }
    this.prevNow = now;
    this.repaintedPrev = false;
  }

  /** The engine repainted in frame `now`, taking `mainThreadMs`. */
  repainted(now: number, mainThreadMs: number): void {
    this.lastRepaintAt = now;
    this.lastRepaintMs = mainThreadMs;
    this.repaintedPrev = true;
  }

  /** Whether a repaint is due at `now`. */
  due(now: number): boolean {
    return now - this.lastRepaintAt >= this.intervalMs - THROTTLE_SLACK_MS;
  }

  /**
   * Whether to start a readback at `now`: its copy would be complete (after the usual latency from a
   * readback's start) when the next repaint is due, so a harvested frame is about one frame old, not a
   * whole repaint interval.
   */
  copyDue(now: number): boolean {
    return this.due(now + this.copyLatencyMs);
  }

  /** A readback started in frame `now` (its copy follows once its passes are encoded, maybe frames later). */
  readbackStarted(now: number): void {
    this.copyAt = now;
  }

  /** The pending copy's frame was seen complete in frame `now`: sample the latency since its readback started. */
  copyCompleted(now: number): void {
    if (!Number.isNaN(this.copyAt)) this.copyLatencyMs = now - this.copyAt;
    this.copyAt = Number.NaN;
  }

  /** The loop paused (a hidden page, an idle resume): the gap to the next frame is not a render or copy cost. */
  pause(): void {
    this.repaintedPrev = false;
    this.copyAt = Number.NaN;
  }
}
