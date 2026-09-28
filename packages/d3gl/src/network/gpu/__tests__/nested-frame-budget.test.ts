/**
 * The GPU layout's per-frame GPU budget at scale (#382) — node, deterministic. A layout's passes, with the
 * sizes its textures would have and its cost model, are streamed through the real {@link StreamSchedule} and
 * {@link FrameBudget} (fake fences that always keep up) for a whole cold layout, with readbacks on the real
 * {@link RepaintThrottle}'s cadence, and every frame's estimated GPU work — the solve's bands and the
 * composition's alike — is summed from the band counts and the cost model. The bound is on the estimates
 * (`nested-plan.ts` has how they compare with measured costs).
 *
 * - **The nested solve** (`nestedPlan` over `nestedPlanSizes`, the plan `GpuNestedLayout` binds — a browser
 *   test pins that the two agree): the synthetic Infomap-like maps of 1,000,000 and 325,729 leaves, and
 *   one-module Zipf maps of 20,000 and 60,000 children (#380's heavy-tailed radii: the collision's work items
 *   dominate there).
 * - **The flat layout** (`GpuForceLayout.tickStages`: P and I whole, the force pass in bands of the atlas
 *   rows, the flat cost model) at 325,729 and 1,000,000 nodes: its P and I run whole (#429), and at 1M its P
 *   is estimated at the whole 120 Hz budget.
 *
 * The composition's passes are work items, so a readback often waits a frame for budget before its copy;
 * the throttle times a readback from its start, so the repaints still land on their cadence.
 *
 * Before #382 two items of the nested solve could not be cut: compact step 1's prep (predict, springs,
 * integrate, the reductions, the collision cells and scatters) and the composition a copy frame added before
 * its copy, so a copy frame carried a whole prep and composition whatever the budget.
 */
import { describe, expect, it } from "vitest";
import { infomapLikeTree, zipfModuleTree } from "../../__tests__/nested-fixtures.js";
import { FrameBudget, bandTargetMs, itemCostMs, type FenceSource, type FenceStatus } from "../frame-budget.js";
import { NESTED_COST, nestedPlan, nestedPlanSizes, type NestedPlan, type NestedStep } from "../nested-plan.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { StreamSchedule, type StageCost, type StreamStage } from "../stream-schedule.js";
import { COLLISION_STEPS } from "../passes/collision.js";
import { MIN_FRAME_MS, RepaintThrottle } from "../repaint-throttle.js";
import { atlasWidth } from "../textures.js";
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

/** A layout as the stream sees it: the passes of its next tick, and of a readback. */
interface Layout {
  /** The passes of stream tick `tick` (0-based). */
  tickStages(tick: number): readonly StageCost[];
  readbackStages: readonly StageCost[];
  /** Stream ticks of the whole layout. */
  ticks: number;
}

interface Run {
  /** Per frame: the estimated GPU time of what it encoded, its items, and whether it copied. */
  frames: { ms: number; items: number; copied: boolean }[];
  events: Event[];
  /**
   * The largest estimate of a single band, and of a band of a pass whose fixed cost is at most a quarter of
   * the budget — each scaled to the steady budget from the budget it was sized for.
   */
  maxBandMs: number;
  maxSmallBandMs: number;
  /** Bands of every pass kind the last time it ran, by the pass's position in its tick. */
  ticks: number;
  copies: number;
  /** The rAF times of the repaints (harvests), the final one included. */
  repaints: number[];
}

/**
 * Stream `layout` cold at `hz` through the real schedule and budget (see the file header), with readbacks on
 * the real repaint throttle's cadence, wired as `GpuStream` wires it.
 */
function stream(layout: Layout, hz: number): Run {
  const total = layout.ticks;
  const run: Run = { frames: [], events: [], maxBandMs: 0, maxSmallBandMs: 0, ticks: 0, copies: 0, repaints: [] };
  let clock = 0;
  const budget = new FrameBudget(new KeepUp(), () => clock);
  let frameMs = 0;
  let sizedFor = budget.budgetMs;
  const steady = hz === 60 ? 10 : 5;
  const bound = new Map<StageCost, StreamStage>();
  const bind = (step: StageCost, kind: "tick" | "readback"): StreamStage => {
    const known = bound.get(step);
    if (known) return known;
    const stage: StreamStage = {
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
        const scale = steady / sizedFor;
        run.maxBandMs = Math.max(run.maxBandMs, ms * scale);
        if (step.fixedMs <= sizedFor / 4 && step.rows > 1) run.maxSmallBandMs = Math.max(run.maxSmallBandMs, ms * scale);
        run.events.push({ kind, ms });
      },
    };
    bound.set(step, stage);
    return stage;
  };
  const readback = layout.readbackStages.map((s) => bind(s, "readback"));
  const tickLists = new Map<readonly StageCost[], StreamStage[]>();
  const source = {
    tickStages: (): readonly StreamStage[] => {
      const steps = layout.tickStages(run.ticks);
      const known = tickLists.get(steps);
      if (known) return known;
      const list = steps.map((s) => bind(s, "tick"));
      tickLists.set(steps, list);
      return list;
    },
    readbackStages: (): readonly StreamStage[] => readback,
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
  const copyDue = (): boolean => !pending && run.ticks > copiedTicks && (run.ticks >= total || throttle.copyDue(now, false));
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

/** The nested solve of `plan` as the stream sees it: its organise ticks, then its compact ticks' collision steps. */
function nestedLayoutOf(plan: NestedPlan, iterations: number): Layout {
  const organise = Math.ceil(iterations * NESTED.ORGANISE);
  return {
    tickStages: (tick) => (tick < organise ? plan.organise : (plan.compact[(tick - organise) % COLLISION_STEPS] ?? plan.organise)),
    readbackStages: plan.readback,
    ticks: organise + COLLISION_STEPS * (iterations - organise),
  };
}

/** Check a streamed run against the bound; returns its report line. */
function expectWithinBudget(run: Run, hz: number, label: string): string {
  const budgetMs = hz === 60 ? 10 : 5;
  const target = bandTargetMs(budgetMs);
  // Every band of a pass that can be cut within half the budget — or, for a pass whose fixed cost per band
  // is past a quarter of the budget, within the budget; every frame within it, copy frames included.
  expect(run.maxBandMs).toBeLessThanOrEqual(budgetMs + 1e-9);
  expect(run.maxSmallBandMs).toBeLessThanOrEqual(target + 1e-9);
  const worst = Math.max(...run.frames.map((f) => f.ms));
  expect(worst, `${label}: worst frame`).toBeLessThanOrEqual(budgetMs + 1e-9);
  const copyFrames = run.frames.filter((f) => f.copied);
  expect(copyFrames.length).toBe(run.copies);
  expect(Math.max(...copyFrames.map((f) => f.ms))).toBeLessThanOrEqual(budgetMs + 1e-9);
  // A readback runs exclusively: from its first pass to its copy, no band of a tick.
  let reading = false;
  for (const e of run.events) {
    if (e.kind === "readback") reading = true;
    else if (e.kind === "copy") reading = false;
    else expect(reading, "a tick band ran between a readback's passes and its copy").toBe(false);
  }
  // The repaints land on the throttle's cadence (MIN_FRAME_MS: 3 frames at 60 Hz, 6 at 120 Hz) — or, where a
  // tick takes longer than that (the flat 1M layout: 46 ms of work, ~5 frames), on every tick: a copy waits
  // for a new tick. A readback that waits a frame for budget was started a frame earlier. Only when that wait
  // changes from one readback to the next does a repaint come a frame late.
  const cadence = Math.max(MIN_FRAME_MS, (Math.ceil(run.frames.length / run.ticks) * 1000) / hz);
  const gaps = run.repaints.slice(1, -1).map((t, i) => t - (run.repaints[i] ?? 0));
  const sorted = gaps.slice().sort((a, b) => a - b);
  const late = gaps.filter((g) => g > cadence + 1000 / hz / 2).length;
  expect(sorted[sorted.length >> 1] ?? 0).toBeLessThanOrEqual(cadence + 1);
  expect(late / Math.max(1, gaps.length), `${late} of ${gaps.length} repaints a frame late`).toBeLessThan(0.25);
  const totalMs = run.frames.reduce((a, f) => a + f.ms, 0);
  return (
    `${label}, ${hz} Hz: ${run.frames.length} frames (${(run.frames.length / hz).toFixed(1)} s), worst frame ${worst.toFixed(2)} ms of ${budgetMs}, ` +
    `worst band ${run.maxBandMs.toFixed(2)} ms, ${run.copies} copies (${late} of ${gaps.length} repaints a frame late), ` +
    `${totalMs.toFixed(0)} ms of estimated GPU work`
  );
}

describe("the nested GPU solve's frame budget (#382)", () => {
  const maps = [
    { label: "1,000,000 leaves (synthetic Infomap-like)", ...fromInfomapLike(1_000_000) },
    { label: "325,729 leaves (synthetic Infomap-like)", ...fromInfomapLike(325_729) },
    { label: "a 60,000-child Zipf module", ...fromZipf(60_000) },
    { label: "a 20,000-child Zipf module", ...fromZipf(20_000) },
  ];

  it("needs slicing at 1M: whole passes, and a copy frame's composition, exceed the budget", () => {
    const [big] = maps;
    if (!big) throw new Error("no 1M map");
    const passMs = (step: NestedStep): number => step.fixedMs + step.costMs;
    // The repulsion and the collision's work items alone are past a 5 ms budget (120 Hz); so is compact step
    // 1's work before its items — the old unsliceable prep — and with the composition a copy frame added, more.
    for (const pass of ["repulsion", "items"] as const) {
      const step = [...big.plan.organise, ...big.plan.compact[0]].find((s) => s.pass === pass);
      expect(step && passMs(step), pass).toBeGreaterThan(5);
    }
    const prep = big.plan.compact[0].filter((s) => s.pass !== "items" && s.pass !== "resolve").reduce((a, s) => a + passMs(s), 0);
    expect(prep).toBeGreaterThan(5);
    const compose = big.plan.readback.reduce((a, s) => a + passMs(s), 0);
    expect(prep + compose).toBeGreaterThan(7.5);
    // No pass pays so much fixed cost per band that one band alone passes three quarters of the budget:
    // every work item is bounded (32 cell visits or 256 pair tests), so is every slot's resolve (#380).
    for (const cost of Object.values(NESTED_COST)) expect(cost.fixedMs).toBeLessThan(0.75 * 5);
  });

  for (const { label, plan, iterations } of maps) {
    for (const hz of [60, 120]) {
      it(`keeps every frame within the budget at ${hz} Hz on ${label}, copy frames included, with no tick between a readback's passes and its copy`, () => {
        const layout = nestedLayoutOf(plan, iterations);
        const run = stream(layout, hz);
        expect(run.ticks).toBe(layout.ticks);
        expect(run.copies).toBeGreaterThan(10);
        const line = expectWithinBudget(run, hz, `nested plan, ${label}`);
        // The budget is used: most frames carry more than half of it (the small maps' frames are bound by
        // their passes' count, not by the budget, and are not asked to).
        const target = bandTargetMs(hz === 60 ? 10 : 5);
        const busy = run.frames.filter((f) => f.ms > target).length / run.frames.length;
        if (label.startsWith("1,000,000")) expect(busy).toBeGreaterThan(0.8);
        console.log(`${line}; ${(100 * busy).toFixed(0)}% of frames past half the budget`);
      }, 60_000);
    }
  }
});

describe("the flat GPU layout's frame budget (#352, #382)", () => {
  for (const nodes of [325_729, 1_000_000]) {
    // GpuForceLayout.tickStages: P and I whole, the force pass in bands of the atlas rows (the flat cost model).
    const rows = Math.ceil(nodes / atlasWidth(nodes));
    const stages: readonly StageCost[] = [
      { costMs: itemCostMs("prep", nodes), fixedMs: 0, rows: 1 },
      { costMs: itemCostMs("force", nodes), fixedMs: 0, rows },
      { costMs: itemCostMs("integrate", nodes), fixedMs: 0, rows: 1 },
    ];
    const layout: Layout = { tickStages: () => stages, readbackStages: [], ticks: 300 };
    for (const hz of [60, 120]) {
      it(`keeps every frame within the budget at ${hz} Hz at ${nodes.toLocaleString("en")} nodes (P and I whole)`, () => {
        const run = stream(layout, hz);
        expect(run.ticks).toBe(300);
        // P alone is at most the budget here: 1.6 ms at 325k, 5 ms at 1M — the whole 120 Hz budget (#429).
        expect(itemCostMs("prep", nodes)).toBeLessThanOrEqual(5 + 1e-9);
        console.log(expectWithinBudget(run, hz, `flat, ${nodes} nodes`));
      }, 60_000);
    }
  }
});

function fromInfomapLike(leaves: number): { plan: NestedPlan; iterations: number } {
  const { topo, flow } = infomapLikeTree(leaves);
  const solver = nestedSolverTopology(topo, { size: flow, radius: 10 * Math.sqrt(leaves) });
  return { plan: nestedPlan(nestedPlanSizes(solver)), iterations: solver.iterations };
}

function fromZipf(big: number): { plan: NestedPlan; iterations: number } {
  const { topo, flow } = zipfModuleTree(big, 200);
  const solver = nestedSolverTopology(topo, { size: flow, radius: 10 * Math.sqrt(big + 8000) });
  return { plan: nestedPlan(nestedPlanSizes(solver)), iterations: solver.iterations };
}
