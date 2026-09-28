/**
 * The GPU layout's per-tick convergence stop (#376, the GPU part of #124; spec §6.5.5) — the pure model.
 *
 * The CPU layout checks {@link ForceLayout.converged} after every tick and stops the loop there. The
 * GPU transport cannot: the mean step lives on the GPU and comes back with a readback several frames
 * later, so a stop decided on the CPU from lagged stats would land a frame-timing-dependent number of
 * ticks late, and the final layout would differ run to run. So the decision is made **on the GPU, once
 * per tick**: a one-texel *latch* pass at the start of tick t + 1 reads the reductions' `Σ|v|` — the
 * mean clamped step of tick t, because the velocity texture stores the clamped step — and applies the
 * CPU's rule. Once it has latched, the integrate pass passes positions and velocities through
 * unchanged, so whatever the CPU encodes before it learns of the stop leaves the stop tick's layout.
 *
 * The rule is split where the data is ({@link stopArmed} / {@link stepSettled}, `force.ts`): whether a
 * stop is allowed at all — the mode (a run or a re-cool, never a drag), the model has a spacing, the
 * schedule is at least `MIN_SETTLE_TICKS` old — is known on the CPU and arrives as one flag; the step
 * comparisons run on the GPU against `CONVERGED_STEP · spacing`.
 *
 * **The latch texel** is `(prevStep, stopTick, epoch, flags)`:
 * - `prevStep` — the step the last evaluation saw: the CPU's `prevStep` for the next one. The first
 *   boundary of a solver (no tick integrated) records 0, as the CPU's `step` starts at ∞ and becomes
 *   `prevStep = 0` after its first tick.
 * - `stopTick` — ticks integrated when it latched (the CPU's tick count at its stop), −1 before.
 * - `epoch` — the heat schedule it belongs to. Every `cool` / `hold` starts a new epoch; a stop of an
 *   older epoch is released (the step history is kept, as `ForceLayout.cool` keeps it), and the CPU
 *   ignores a harvested stop whose epoch is not the current one — it may have read it frames after a
 *   drag started a new schedule.
 * - `flags` — {@link STOP_STOPPED}, {@link STOP_NONFINITE}.
 *
 * **Non-finite stats** (`Σx`, `Σy` or `Σ|v|` NaN or ∞) set {@link STOP_NONFINITE}, which freezes the
 * integrate for good (whatever the epoch) and is never a convergence.
 *
 * **Once per boundary.** The reductions can run twice between two integrates — a readback copy between
 * ticks re-runs them so its stats describe the copied positions, and the next tick's prep runs them again
 * after writing a drag's held positions. The latch runs after each, but only the first run at a boundary
 * evaluates the rule (`evaluate`); a later one only adds a non-finite flag. The velocities do not change
 * in between, so the result does not depend on whether a copy happened.
 *
 * `passes/stop-latch.ts` is the GLSL twin of {@link latchStop}; keep the two in step.
 */
import { stepSettled } from "../force.js";

/** Flag: the latch has recorded a convergence stop in its epoch. */
export const STOP_STOPPED = 1;
/** Flag: the reductions came back non-finite — integration is frozen. */
export const STOP_NONFINITE = 2;

/** The latch texel `(prevStep, stopTick, epoch, flags)` as a record. */
export interface StopState {
  prevStep: number;
  stopTick: number;
  epoch: number;
  flags: number;
}

/** The latch texel a solver starts from: no history, no stop, epoch 0 (before any schedule). */
export const INITIAL_STOP_STATE: Readonly<StopState> = { prevStep: 0, stopTick: -1, epoch: 0, flags: 0 };

/** What one latch evaluation reads: the segment's stats and the CPU-side half of the rule. */
export interface StopInput {
  /** The segment's `Σx` and `Σy` — checked for finiteness only. */
  sumX: number;
  sumY: number;
  /** The segment's `Σ|v|`: the summed clamped steps of the last tick. */
  stepSum: number;
  /** Slots of the segment (the step is `stepSum / max(count, 1)`). */
  count: number;
  /** The first evaluation at this tick boundary (a repeat only adds the non-finite flag). */
  evaluate: boolean;
  /** At least one tick has been integrated, so the step is a real sample. */
  sample: boolean;
  /** The mode allows a stop and {@link stopArmed} holds for the schedule. */
  armed: boolean;
  /** The force model's equilibrium spacing (the GPU pass takes `CONVERGED_STEP · spacing` as a uniform). */
  spacing: number;
  /** Ticks integrated so far — the stop tick if this evaluation latches. */
  tick: number;
  /** The current schedule's epoch. */
  epoch: number;
}

/**
 * One latch evaluation — the CPU model of the GLSL pass (`passes/stop-latch.ts`). Pure; returns the new
 * texel. The step comparisons are the CPU's own {@link stepSettled}.
 */
export function latchStop(state: Readonly<StopState>, input: Readonly<StopInput>): StopState {
  const same = state.epoch === input.epoch;
  let flags = same ? state.flags : state.flags & STOP_NONFINITE;
  let stopTick = same ? state.stopTick : -1;
  let prevStep = state.prevStep;
  if (!Number.isFinite(input.sumX) || !Number.isFinite(input.sumY) || !Number.isFinite(input.stepSum)) {
    flags |= STOP_NONFINITE;
  } else if (input.evaluate) {
    const step = input.stepSum / Math.max(input.count, 1);
    if (!input.sample) {
      prevStep = 0;
    } else {
      if ((flags & STOP_STOPPED) === 0 && input.armed && stepSettled(step, prevStep, input.spacing)) {
        flags |= STOP_STOPPED;
        stopTick = input.tick;
      }
      prevStep = step;
    }
  }
  return { prevStep, stopTick, epoch: input.epoch, flags };
}
