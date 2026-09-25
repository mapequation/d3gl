/**
 * **Position transitions** (#328): ease a layout's node positions from where they are to a new layout
 * on the main thread, one animation frame at a time, instead of jumping.
 *
 * A transition snapshots the positions when it is created (the layout's solve may still be running,
 * e.g. in a worker), then {@link PositionTransition.to} starts it. Each frame writes
 * `from + (to − from) · ease(t)` into the live position buffer and calls `onFrame` (the engine's
 * positions-only repaint). The last frame writes `to` exactly.
 *
 * Per-frame cost: one O(nodes) pass over the interleaved buffer, allocation-free. Memory: the `from`
 * snapshot (2 floats per node), plus the caller's `to`, for the transition's lifetime — both released
 * when it ends.
 */

/** d3-ease's `easeCubicInOut`: slow–fast–slow on `[0, 1]`. */
export function easeCubicInOut(t: number): number {
  return ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2;
}

/**
 * One transition frame: `out[i] = from[i] + (to[i] − from[i]) · k` over the buffers' common length
 * (interleaved `[x, y, …]`). O(length), allocation-free.
 */
export function lerpPositions(out: Float32Array, from: Float32Array, to: Float32Array, k: number): void {
  const n = Math.min(out.length, from.length, to.length);
  for (let i = 0; i < n; i++) {
    const a = from[i]!;
    out[i] = a + (to[i]! - a) * k;
  }
}

export interface PositionTransitionOptions {
  /** Length in milliseconds. A non-positive or non-finite value jumps to the target on the first frame. */
  duration: number;
  /** Called after each frame's write, the last one included — repaint here. */
  onFrame: () => void;
  /** Easing on `[0, 1]`. Default {@link easeCubicInOut}. */
  ease?: (t: number) => number;
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
  /** Frame scheduler. Default `requestAnimationFrame` (a 16 ms timeout where there is none). */
  requestFrame?: (cb: () => void) => number;
  /** Cancels a {@link requestFrame} id. Default `cancelAnimationFrame` (`clearTimeout`). */
  cancelFrame?: (id: number) => void;
}

export interface PositionTransition {
  /** The positions when the transition was created — where it eases from. Released (empty) once the
   *  transition has ended, like its target: a settled transition holds no per-node memory. */
  readonly from: Float32Array;
  /** Resolves when the transition reaches its target, or is stopped or finished. */
  readonly settled: Promise<void>;
  /** Whether it has started ({@link to}) and not yet ended. */
  readonly running: boolean;
  /**
   * Start easing towards `target` (interleaved, the positions' length), from the next frame on. The
   * transition reads `target` every frame, so don't mutate it until {@link settled}. Only the first
   * call counts; a call after {@link stop} is ignored.
   */
  to(target: Float32Array): void;
  /** Stop where it is: the positions keep the last frame's values. Resolves {@link settled}. */
  stop(): void;
  /** Jump to the end now: the positions take the target's values, without a further `onFrame`.
   *  Resolves {@link settled}. Before {@link to} it only stops. */
  finish(): void;
  /**
   * Keep nodes `ids` where they are now for the rest of the transition: their start and target both take
   * their current positions, so its frames leave them there — for nodes the user dropped while it ran, or
   * while its target was still being computed. Before {@link to}, it applies when the target arrives
   * (overwriting their entries in it). O(ids); ignored once the transition has ended.
   */
  keep(ids: ArrayLike<number>): void;
}

/**
 * Create a transition of `positions` (the live buffer, written in place each frame) from its current
 * values. It waits for {@link PositionTransition.to}. @see the module docs above.
 */
export function positionTransition(positions: Float32Array, opts: PositionTransitionOptions): PositionTransition {
  const ease = opts.ease ?? easeCubicInOut;
  const now = opts.now ?? (() => performance.now());
  const requestFrame =
    opts.requestFrame ??
    (typeof requestAnimationFrame === "function"
      ? (cb: () => void) => requestAnimationFrame(cb)
      : (cb: () => void) => setTimeout(cb, 16));
  const cancelFrame =
    opts.cancelFrame ?? (typeof cancelAnimationFrame === "function" ? (id: number) => cancelAnimationFrame(id) : (id: number) => clearTimeout(id));
  const duration = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : 0;
  let from = positions.slice();

  let resolve: () => void = () => {};
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  let target: Float32Array | null = null;
  let start = 0;
  let raf = 0;
  let ended = false;
  let kept: number[] = []; // node ids to keep in place once the target arrives ({@link PositionTransition.keep})
  const pin = (ids: ArrayLike<number>, to: Float32Array): void => {
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k]! * 2;
      from[i] = to[i] = positions[i]!;
      from[i + 1] = to[i + 1] = positions[i + 1]!;
    }
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    if (raf) cancelFrame(raf);
    raf = 0;
    from = new Float32Array(0); // release both per-node buffers
    target = null;
    kept = [];
    resolve();
  };
  const frame = (): void => {
    raf = 0;
    if (ended || !target) return;
    const t = duration > 0 ? (now() - start) / duration : 1;
    if (t >= 1) {
      positions.set(target);
      opts.onFrame();
      end();
      return;
    }
    lerpPositions(positions, from, target, ease(Math.max(0, t)));
    opts.onFrame();
    raf = requestFrame(frame);
  };

  return {
    get from() {
      return from;
    },
    settled,
    get running() {
      return target !== null && !ended;
    },
    to(next) {
      if (ended || target) return;
      target = next;
      pin(kept, next);
      kept = [];
      start = now();
      raf = requestFrame(frame);
    },
    stop: end,
    finish() {
      if (target && !ended) positions.set(target);
      end();
    },
    keep(ids) {
      if (ended) return;
      if (target) pin(ids, target);
      else for (let k = 0; k < ids.length; k++) kept.push(ids[k]!);
    },
  };
}
