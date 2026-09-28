/**
 * The GPU stop latch's CPU model (#376, spec §6.5.5, §13 `stop-latch.test.ts`), against the CPU rule
 * it must reproduce: {@link ForceLayout.converged}, checked after every tick of `ForceLayout.run`.
 *
 * The latch is evaluated at the start of tick t + 1, where the reductions give the mean clamped step of
 * tick t (the velocity texture holds the clamped step). So the model is fed, at each tick boundary t,
 * the CPU's `meanStep` after tick t — 0 at t = 0, where every velocity is still zero — and must latch at
 * exactly the boundary where `converged` first turns true. `passes/stop-latch.ts` is its GLSL twin;
 * `gpu-stop.browser.test.ts` checks the two against each other.
 */
import { describe, expect, it } from "vitest";
import { CONVERGED_STEP, DEFAULT_FORCE, ForceLayout, MIN_SETTLE_TICKS, equilibriumSpacing, seedPositions, stopArmed } from "../../force.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { INITIAL_STOP_STATE, STOP_NONFINITE, STOP_STOPPED, latchStop, type StopInput, type StopState } from "../stop-latch.js";

const SPACING = equilibriumSpacing(DEFAULT_FORCE);
const THRESHOLD = CONVERGED_STEP * SPACING;

/** A ring with chords: small, connected, and settling well inside a 300-tick budget. */
function ringWithChords(n: number): NetworkGraph {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    if (i % 7 === 0) {
      source.push(i);
      target.push((i * 13 + 5) % n);
    }
  }
  return buildGraph({ nodeCount: n, source, target });
}

/** One evaluation's input at tick boundary `tick` of a schedule set `settle` ticks ago. */
function input(step: number, tick: number, settle: number, overrides: Partial<StopInput> = {}): StopInput {
  return {
    sumX: 0,
    sumY: 0,
    stepSum: step,
    count: 1,
    evaluate: true,
    sample: tick > 0,
    armed: stopArmed(SPACING, settle),
    spacing: SPACING,
    tick,
    epoch: 1,
    ...overrides,
  };
}

/**
 * Drive `cpu` for at most `iterations` ticks of its current schedule (set just before), feeding the model at
 * every boundary; return the tick the CPU rule stops at and the tick the model latched at.
 */
function race(cpu: ForceLayout, iterations: number): { cpuStop: number; latched: number; state: StopState } {
  let state: StopState = { ...INITIAL_STOP_STATE };
  let cpuStop = -1;
  // Boundary 0: no tick integrated yet, every velocity zero.
  state = latchStop(state, input(0, 0, 0));
  for (let t = 1; t <= iterations; t++) {
    cpu.tick();
    // Boundary t: the reductions see tick t's mean clamped step.
    state = latchStop(state, input(cpu.meanStep, t, t));
    if (cpu.converged) {
      cpuStop = t;
      break;
    }
    expect(state.flags & STOP_STOPPED, `the model latched at tick ${t}, before the CPU rule`).toBe(0);
  }
  return { cpuStop, latched: state.flags & STOP_STOPPED ? state.stopTick : -1, state };
}

describe("latchStop — the GPU stop latch's CPU model (#376)", () => {
  it("latches at the tick ForceLayout.run stops at: a cooled schedule", () => {
    const g = ringWithChords(300);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const ref = new ForceLayout({ ...g, positions: g.positions.slice() });
    const refTicks = ref.run(300, "cool");
    const cpu = new ForceLayout({ ...g, positions: g.positions.slice() });
    cpu.cool(300);
    const { cpuStop, latched } = race(cpu, 300);
    expect(refTicks).toBeLessThan(300); // not vacuous: it converged inside the budget
    expect(cpuStop).toBe(refTicks);
    expect(latched).toBe(refTicks);
  });

  it("latches at the tick ForceLayout.run stops at: a hot cold start", () => {
    const g = ringWithChords(200);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const ref = new ForceLayout({ ...g, positions: g.positions.slice() });
    const refTicks = ref.run(300, "hot");
    const cpu = new ForceLayout({ ...g, positions: g.positions.slice() });
    cpu.hold(1);
    const { cpuStop, latched } = race(cpu, 300);
    expect(refTicks).toBeLessThan(300);
    expect(cpuStop).toBe(refTicks);
    expect(latched).toBe(refTicks);
  });

  it("a zero step from the first sample on: stops at exactly MIN_SETTLE_TICKS, as the CPU does", () => {
    // One node: no repulsion partner, centering toward itself — every step is 0, and 0 ≤ prevStep = 0.
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    const cpu = new ForceLayout(g);
    cpu.hold(1);
    const { cpuStop, latched } = race(cpu, 100);
    expect(cpuStop).toBe(MIN_SETTLE_TICKS);
    expect(latched).toBe(MIN_SETTLE_TICKS);
  });

  it("the first sample compares against prevStep 0 (the CPU's step starts at ∞)", () => {
    // Armed from the start and a step below the threshold: the first sample still cannot stop unless it is 0.
    let s = latchStop({ ...INITIAL_STOP_STATE }, input(0, 0, 100, { armed: true }));
    expect(s.prevStep).toBe(0);
    s = latchStop(s, input(0.5 * THRESHOLD, 1, 100, { armed: true }));
    expect(s.flags & STOP_STOPPED).toBe(0);
    // Once the history holds that sample, an equal or smaller step stops.
    s = latchStop(s, input(0.5 * THRESHOLD, 2, 100, { armed: true }));
    expect(s.flags & STOP_STOPPED).toBe(STOP_STOPPED);
    expect(s.stopTick).toBe(2);
  });

  it("a growing step never stops, however small; a step at or above the threshold never stops", () => {
    let s = latchStop({ ...INITIAL_STOP_STATE }, input(0.1 * THRESHOLD, 5, 100, { armed: true }));
    s = latchStop(s, input(0.2 * THRESHOLD, 6, 100, { armed: true }));
    expect(s.flags & STOP_STOPPED).toBe(0);
    s = latchStop(s, input(2 * THRESHOLD, 7, 100, { armed: true }));
    s = latchStop(s, input(THRESHOLD, 8, 100, { armed: true }));
    expect(s.flags & STOP_STOPPED).toBe(0);
    expect(s.prevStep).toBe(THRESHOLD);
  });

  it("unarmed (a drag, or too early in the schedule) records the history but never stops", () => {
    let s = latchStop({ ...INITIAL_STOP_STATE }, input(1, 1, 100, { armed: false }));
    s = latchStop(s, input(0.5, 2, 100, { armed: false }));
    expect(s.flags & STOP_STOPPED).toBe(0);
    expect(s.prevStep).toBe(0.5);
    // Armed again (a re-cool): the history carries over, so the next smaller step stops at once.
    s = latchStop(s, input(0.4, 3, 100, { armed: true }));
    expect(s.flags & STOP_STOPPED).toBe(STOP_STOPPED);
    expect(s.stopTick).toBe(3);
  });

  it("a stop is sticky within its schedule and released by the next one, which keeps the step history", () => {
    let s = latchStop({ ...INITIAL_STOP_STATE }, input(0.3, 1, 100, { armed: true }));
    s = latchStop(s, input(0.2, 2, 100, { armed: true }));
    expect(s.stopTick).toBe(2);
    // Later boundaries of the same schedule (pass-through ticks: the step stays the stop tick's) keep it.
    s = latchStop(s, input(0.9, 3, 100, { armed: true }));
    expect(s.flags & STOP_STOPPED).toBe(STOP_STOPPED);
    expect(s.stopTick).toBe(2);
    // A new schedule (epoch 2, e.g. a drag's hold): released, and the history is the last step seen.
    s = latchStop(s, input(0.9, 4, 0, { epoch: 2 }));
    expect(s.flags & STOP_STOPPED).toBe(0);
    expect(s.stopTick).toBe(-1);
    expect(s.epoch).toBe(2);
    expect(s.prevStep).toBe(0.9);
  });

  it("a repeated evaluation at one boundary (evaluate = false) changes nothing but the non-finite flag", () => {
    const a = latchStop({ ...INITIAL_STOP_STATE }, input(0.3, 1, 100, { armed: true }));
    const b = latchStop(a, input(0.3, 1, 100, { armed: true, evaluate: false }));
    expect(b).toEqual(a);
    const c = latchStop(a, input(Number.NaN, 1, 100, { armed: true, evaluate: false }));
    expect(c.flags & STOP_NONFINITE).toBe(STOP_NONFINITE);
    expect(c.prevStep).toBe(a.prevStep);
  });

  it("non-finite stats set NONFINITE, never STOPPED, keep the state finite, and the flag outlives a new schedule", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let s = latchStop({ ...INITIAL_STOP_STATE }, input(0.3, 1, 100, { armed: true }));
      s = latchStop(s, input(bad, 2, 100, { armed: true }));
      expect(s.flags).toBe(STOP_NONFINITE);
      expect(Number.isFinite(s.prevStep) && Number.isFinite(s.stopTick) && Number.isFinite(s.epoch)).toBe(true);
      // Σx or Σy alone non-finite (a NaN position whose velocity is still finite) flags it too.
      const t = latchStop({ ...INITIAL_STOP_STATE }, input(0.3, 1, 100, { armed: true, sumX: bad }));
      expect(t.flags & STOP_NONFINITE).toBe(STOP_NONFINITE);
      s = latchStop(s, input(0.1, 3, 0, { epoch: 2 }));
      expect(s.flags & STOP_NONFINITE).toBe(STOP_NONFINITE);
    }
    // The CPU rule never reports convergence on a non-finite layout either.
    const g = ringWithChords(50);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    g.positions[14] = Number.NaN;
    const cpu = new ForceLayout(g);
    cpu.hold(1);
    for (let t = 0; t < MIN_SETTLE_TICKS + 5; t++) cpu.tick();
    expect(cpu.converged).toBe(false);
  });

  it("an empty segment divides by max(count, 1): a zero step, never NaN", () => {
    const s = latchStop({ ...INITIAL_STOP_STATE }, input(0, 1, 100, { armed: true, count: 0 }));
    expect(s.flags & STOP_NONFINITE).toBe(0);
    expect(s.prevStep).toBe(0);
  });
});
