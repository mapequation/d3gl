/**
 * The nested GPU solve's per-frame GPU budget at 1M leaves (#382) — node, deterministic. The plan of a
 * 1,000,000-leaf synthetic Infomap-like map (the sizes its textures would have, `nestedPlanSizes`) is
 * streamed through the real {@link StreamSchedule} and {@link FrameBudget} (fake fences that always keep
 * up) for a whole cold layout with readbacks on the real {@link RepaintThrottle}'s cadence, and every frame's
 * estimated GPU work — the solve's bands and the composition's alike — is summed from the band counts and
 * the cost model. The bound is on the estimates (`nested-plan.ts` has how they compare with measured costs).
 *
 * The composition's passes are work items, so a readback often waits a frame for budget before its copy;
 * the throttle times a readback from its start, so the repaints still land on their cadence (timed from the
 * copy, 60 of 80 repaints at 1M came a frame late at 60 Hz, a median 67 ms apart instead of 50, and 89 of 97
 * at 120 Hz, 58 ms apart).
 *
 * Before #382 two items could not be cut: compact step 1's prep (predict, springs, integrate, the
 * reductions, the collision cells and scatters) and the composition a copy frame added before its copy,
 * so a copy frame carried up to ~17 ms of layout GPU work at 1M against a 10 ms budget (5 ms at 120 Hz).
 */
import { describe, expect, it } from "vitest";
import { infomapLikeTree } from "../../__tests__/nested-fixtures.js";
import { FrameBudget, bandTargetMs, type FenceSource, type FenceStatus } from "../frame-budget.js";
import { nestedPlan, nestedPlanSizes, type NestedPlan, type NestedStep } from "../nested-plan.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { StreamSchedule, type StreamStage } from "../stream-schedule.js";
import { COLLISION_STEPS } from "../passes/collision.js";
import { MIN_FRAME_MS, RepaintThrottle } from "../repaint-throttle.js";
import { NESTED } from "../../nested-layout.js";

/** Fences a GPU that always keeps up: every fence has signalled by the next frame. */
class KeepUp implements FenceSource<number> {
  private inserted = 0;
  insert(): number {
    return ++this.inserted;
  }
  poll(): FenceStatus {
    return "signaled";
  }
  drop(): void {}
}

type Event = { kind: "tick" | "readback"; ms: number } | { kind: "copy" };

interface Run {
  /** Per frame: the estimated GPU time of what it encoded, its items, and whether it copied. */
  frames: { ms: number; items: number; copied: boolean }[];
  events: Event[];
  /**
   * The largest estimate of a single band, and of a band of a pass whose fixed cost is at most a quarter of
   * the budget — each scaled to the steady budget from the budget of its frame.
   */
  maxBandMs: number;
  maxSmallBandMs: number;
  ticks: number;
  copies: number;
  /** The rAF times of the repaints (harvests), the final one included. */
  repaints: number[];
}

/**
 * Stream a cold nested layout of `plan` at `hz` through the real schedule and budget (see the file header),
 * with readbacks on the real repaint throttle's cadence, wired as `GpuStream` wires it.
 */
function stream(plan: NestedPlan, hz: number, iterations: number): Run {
  const organise = Math.ceil(iterations * NESTED.ORGANISE);
  const total = organise + COLLISION_STEPS * (iterations - organise);
  const run: Run = { frames: [], events: [], maxBandMs: 0, maxSmallBandMs: 0, ticks: 0, copies: 0, repaints: [] };
  let clock = 0;
  const budget = new FrameBudget(new KeepUp(), () => clock);
  let frameMs = 0;
  let sizedFor = budget.budgetMs;
  const bind = (steps: readonly NestedStep[], kind: "tick" | "readback"): StreamStage[] =>
    steps.map((step) => ({
      costMs: step.costMs,
      fixedMs: step.fixedMs,
      rows: step.rows,
      run: (band: number, bands: number) => {
        expect(band).toBeLessThan(bands);
        expect(bands).toBeLessThanOrEqual(step.rows);
        const ms = step.fixedMs + step.costMs / bands;
        frameMs += ms;
        // Relative to the budget the pass's bands were sized for, at its first band: the first frame
        // assumes 60 Hz (10 ms) until the rAF interval is known, and a pass keeps its bands to its end.
        if (band === 0) sizedFor = budget.budgetMs;
        const scale = (hz === 60 ? 10 : 5) / sizedFor;
        run.maxBandMs = Math.max(run.maxBandMs, ms * scale);
        if (step.fixedMs <= sizedFor / 4) run.maxSmallBandMs = Math.max(run.maxSmallBandMs, ms * scale);
        run.events.push({ kind, ms });
      },
    }));
  const organiseStages = bind(plan.organise, "tick");
  const compactStages = [bind(plan.compact[0], "tick"), bind(plan.compact[1], "tick")];
  const readbackStages = bind(plan.readback, "readback");
  const source = {
    tickStages: (): readonly StreamStage[] => {
      if (run.ticks < organise) return organiseStages;
      return compactStages[(run.ticks - organise) % COLLISION_STEPS] ?? organiseStages;
    },
    readbackStages: (): readonly StreamStage[] => readbackStages,
  };
  // The stream's readback state: a copy in the PBO (`pending`), the frame whose fence covers it, and whether
  // that fence was seen signalled; the ticks it holds, and those of the last harvest.
  const throttle = new RepaintThrottle();
  let now = 0;
  let frame = 0;
  let pending = false;
  let ready = false;
  let copyFrame = 0;
  let copiedTicks = 0;
  let harvestedTicks = 0;
  const schedule = new StreamSchedule(budget, source, {
    tickStart: () => {},
    tickEnd: () => {
      run.ticks++;
    },
    readbackStart: () => throttle.readbackStarted(now),
    copy: () => {
      run.copies++;
      pending = true;
      ready = false;
      copyFrame = frame;
      copiedTicks = run.ticks;
      run.events.push({ kind: "copy" });
    },
  });
  const hasWork = (): boolean => run.ticks < total;
  // GpuStream's copyDue: the PBO is free, there are new ticks, and the repaint throttle says the copy would
  // be ready when the next repaint is due — or, once every tick is encoded, the final copy at once.
  const copyDue = (): boolean => !pending && run.ticks > copiedTicks && (run.ticks >= total || throttle.copyDue(now));
  while ((run.ticks < total || harvestedTicks < total) && frame < 100_000) {
    frame++;
    frameMs = 0;
    now = frame * (1000 / hz);
    budget.beginFrame(now);
    throttle.beginFrame(now, budget.intervalMs);
    if (pending && !ready && copyFrame <= budget.completedFrame) {
      ready = true;
      throttle.copyCompleted(now);
    }
    // A finished copy is harvested — and repainted — once the repaint is due; the final one at once.
    const harvest = pending && ready && (copiedTicks >= total || throttle.due(now));
    if (harvest) {
      pending = false;
      harvestedTicks = copiedTicks;
      throttle.repainted(now, 0);
      run.repaints.push(now);
    }
    const open = budget.open();
    const items = schedule.frame(open, hasWork, copyDue);
    clock += 0.01; // a cheap encode: the main-thread cap never binds here
    expect(schedule.frameCostMs).toBeCloseTo(frameMs, 9);
    run.frames.push({ ms: frameMs, items, copied: schedule.copied });
    budget.endFrame(harvest);
  }
  return run;
}

describe("the nested GPU solve's frame budget at 1M leaves (#382)", () => {
  const LEAVES = 1_000_000;
  const { topo, flow } = infomapLikeTree(LEAVES);
  const solver = nestedSolverTopology(topo, { size: flow, radius: 10 * Math.sqrt(LEAVES) });
  const sizes = nestedPlanSizes(solver);
  const plan = nestedPlan(sizes);
  const passMs = (step: NestedStep): number => step.fixedMs + step.costMs;

  it("needs slicing there: whole passes, and a copy frame's composition, exceed the budget", () => {
    expect(solver.slotCount).toBeGreaterThan(LEAVES);
    // The repulsion and the collision gather alone are past a 5 ms budget (120 Hz); so is compact step 1's
    // work before its gather — the old unsliceable prep — and with the composition a copy frame added, by
    // half as much again.
    for (const pass of ["repulsion", "gather"] as const) {
      const step = [...plan.organise, ...plan.compact[0]].find((s) => s.pass === pass);
      expect(step && passMs(step), pass).toBeGreaterThan(5);
    }
    const prep = plan.compact[0].filter((s) => s.pass !== "gather").reduce((a, s) => a + passMs(s), 0);
    expect(prep).toBeGreaterThan(5);
    const compose = plan.readback.reduce((a, s) => a + passMs(s), 0);
    expect(prep + compose).toBeGreaterThan(7.5);
    // The gather's bands wait for its longest fragment: a loop over the largest module.
    expect(sizes.largestModule).toBeGreaterThan(5_000);
  });

  for (const hz of [60, 120]) {
    it(`keeps every frame within the budget at ${hz} Hz, copy frames included, with no tick between a readback's passes and its copy`, () => {
      const budgetMs = hz === 60 ? 10 : 5;
      const run = stream(plan, hz, solver.iterations);
      const target = bandTargetMs(budgetMs);
      // Every band within half the budget — or, for a pass whose fixed cost per band is past a quarter of
      // the budget (the gather waits for its longest fragment), within the budget; every frame within it.
      expect(run.maxBandMs).toBeLessThanOrEqual(budgetMs + 1e-9);
      expect(run.maxSmallBandMs).toBeLessThanOrEqual(target + 1e-9);
      const worst = Math.max(...run.frames.map((f) => f.ms));
      expect(worst).toBeLessThanOrEqual(budgetMs + 1e-9);
      const copyFrames = run.frames.filter((f) => f.copied);
      expect(copyFrames.length).toBe(run.copies);
      expect(Math.max(...copyFrames.map((f) => f.ms))).toBeLessThanOrEqual(budgetMs + 1e-9);
      // The whole layout ran, and the budget was used: most frames carry more than half of it.
      expect(run.ticks).toBe(Math.ceil(solver.iterations * NESTED.ORGANISE) + COLLISION_STEPS * (solver.iterations - Math.ceil(solver.iterations * NESTED.ORGANISE)));
      expect(run.copies).toBeGreaterThan(10);
      const busy = run.frames.filter((f) => f.ms > target).length;
      expect(busy / run.frames.length).toBeGreaterThan(0.8);
      // A readback runs exclusively: from its first pass to its copy, no band of a tick.
      let reading = false;
      for (const e of run.events) {
        if (e.kind === "readback") reading = true;
        else if (e.kind === "copy") reading = false;
        else expect(reading, "a tick band ran between a readback's passes and its copy").toBe(false);
      }
      // The repaints land on the throttle's cadence (MIN_FRAME_MS: 3 frames at 60 Hz, 6 at 120 Hz): a
      // readback that waits a frame for budget was started a frame earlier. Only when that wait changes
      // from one readback to the next does a repaint come a frame late.
      const gaps = run.repaints.slice(1, -1).map((t, i) => t - (run.repaints[i] ?? 0));
      const sorted = gaps.slice().sort((a, b) => a - b);
      const late = gaps.filter((g) => g > MIN_FRAME_MS + 1000 / hz / 2).length;
      expect(sorted[sorted.length >> 1] ?? 0).toBeLessThanOrEqual(MIN_FRAME_MS + 1);
      expect(late / gaps.length, `${late} of ${gaps.length} repaints a frame late`).toBeLessThan(0.25);
      const totalMs = run.frames.reduce((a, f) => a + f.ms, 0);
      console.log(
        `nested plan at ${LEAVES} leaves, ${hz} Hz: ${run.frames.length} frames (${((run.frames.length * 1000) / hz / 1000).toFixed(1)} s), ` +
          `worst frame ${worst.toFixed(2)} ms of ${budgetMs}, worst band ${run.maxBandMs.toFixed(2)} ms ` +
          `(${run.maxSmallBandMs.toFixed(2)} ms but the gather's), ` +
          `${run.copies} copies (${late} of ${gaps.length} repaints a frame late), ${totalMs.toFixed(0)} ms of estimated GPU work`,
      );
    }, 60_000);
  }
});
