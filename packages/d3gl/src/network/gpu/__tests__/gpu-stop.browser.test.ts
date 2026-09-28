/**
 * T9 — the GPU layout's per-tick convergence stop (#376, spec §6.5.5, §13 T9).
 *
 * - The latch pass is the GLSL twin of `latchStop` (`stop-latch.ts`, whose node test pins it against
 *   `ForceLayout.converged`): fed the same stats, it writes the same texel, step by step.
 * - A solver with the stop armed stops where the CPU rule stops (±1 tick: float32 exact all-pairs vs the
 *   CPU's float64), and a stopped layout stays bitwise frozen: it equals the same solve run for exactly the
 *   stop tick's ticks.
 * - Streamed runs stop at the same tick with bitwise-equal positions whatever the frame timing: a generous
 *   and a tiny GPU budget (one item per frame, many row bands) with fence polls randomly reported pending,
 *   against the synchronous solve.
 * - Through the transport, the stop tick equals the worker rule's (±1) and `settled` follows the harvest of
 *   the stop tick's positions.
 * - Non-finite stats set the flag and freeze the integrate; the stream stops and settles.
 * - Reheat: a drag never stops, and its re-cool stops once converged — no earlier than `MIN_SETTLE_TICKS`
 *   into it, before `RECOOL_TICKS`.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device, Texture } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { GpuStream, observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { startGpuLayout } from "../gpu-transport.js";
import { StopLatchPass } from "../passes/stop-latch.js";
import { INITIAL_STOP_STATE, STOP_NONFINITE, STOP_STOPPED, latchStop, type StopInput, type StopState } from "../stop-latch.js";
import { CONVERGED_STEP, DEFAULT_FORCE, ForceLayout, MIN_SETTLE_TICKS, RECOOL_TICKS, equilibriumSpacing, seedPositions, type ForceParams, type LayoutGraph } from "../../force.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Minimal seeded LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A ring with chords: connected, and settling well inside a 300-tick budget at small N. */
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

/** A clustered graph at ~2.3 edges per node (the GPU guards' fixture shape). */
function clustered(n: number, seed: number): NetworkGraph {
  const rng = makePrng(seed);
  const communities = Math.max(1, Math.round(n / 400));
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.floor((i / n) * communities);
    const c0 = Math.floor((c / communities) * n);
    const c1 = Math.floor(((c + 1) / communities) * n);
    source.push(i);
    target.push(c0 + Math.floor(rng() * Math.max(1, c1 - c0)));
    if (rng() < 0.3) {
      source.push(i);
      target.push(Math.floor(rng() * n));
    }
  }
  return buildGraph({ nodeCount: n, source, target });
}

const view = (g: LayoutGraph, positions: Float32Array): LayoutGraph => ({
  nodeCount: g.nodeCount,
  edgeCount: g.edgeCount,
  source: g.source,
  target: g.target,
  positions,
});

/** The latch texel `out[0..4)` as a record. */
const asState = (out: Float32Array): StopState => ({ prevStep: out[0] ?? 0, stopTick: out[1] ?? 0, epoch: out[2] ?? 0, flags: out[3] ?? 0 });

function meanEdge(g: LayoutGraph, p: Float32Array): number {
  let total = 0;
  for (let e = 0; e < g.edgeCount; e++) {
    const a = g.source[e] ?? 0;
    const b = g.target[e] ?? 0;
    total += Math.hypot((p[a * 2] ?? 0) - (p[b * 2] ?? 0), (p[a * 2 + 1] ?? 0) - (p[b * 2 + 1] ?? 0));
  }
  return total / Math.max(1, g.edgeCount);
}

describe("GPU stop latch (#376)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("the latch pass writes latchStop's texel, step by step: first sample, growth, stop, stickiness, a new schedule, non-finite", () => {
    const spacing = equilibriumSpacing(DEFAULT_FORCE);
    const threshold = CONVERGED_STEP * spacing; // ≈ 3.36; every step below is far from it
    const stats: Texture = device.createTexture({ width: 1, height: 1, format: "rgba32float", mipLevels: 1, sampler: { minFilter: "nearest", magFilter: "nearest" } });
    const pass = new StopLatchPass(device);
    const out = new Float32Array(4);
    const texel = new Float32Array(4);
    // [Σx, Σy, Σ|v|, count, tick, epoch, armed, evaluate]
    const script: [number, number, number, number, number, number, boolean, boolean][] = [
      [5, -3, 0, 100, 0, 1, false, true], // boundary 0: no sample, prevStep 0
      [5, -3, 800, 100, 1, 1, false, true], // step 8, unarmed (too early)
      [5, -3, 400, 100, 2, 1, true, true], // step 4 ≥ threshold
      [5, -3, 200, 100, 3, 1, true, true], // step 2 < threshold, ≤ 4: stops at tick 3
      [7, -3, 200, 100, 3, 1, true, false], // a repeat at the same boundary (a copy, then the prep)
      [7, -3, 200, 100, 4, 1, true, true], // a frozen tick: still stopped at 3
      [7, -3, 200, 100, 5, 2, false, true], // a new schedule (a drag): released, history kept
      [7, -3, 300, 100, 6, 2, true, true], // step 3 > prevStep 2: growing, no stop
      [7, -3, 100, 100, 7, 2, true, true], // step 1: stops at tick 7
      [Number.NaN, -3, 100, 100, 8, 2, true, true], // non-finite Σx
      [7, -3, 100, 100, 9, 3, true, true], // a new schedule keeps NONFINITE, drops STOPPED
      [7, -3, Number.POSITIVE_INFINITY, 100, 10, 3, true, true],
      [0, 0, 0, 0, 11, 4, true, true], // an empty segment: step 0, no NaN
      [7, -3, 100, 100, 12, 5, false, true], // step 1, unarmed
      [7, -3, 100, 100, 13, 5, true, true], // an equal step stops (step ≤ prevStep)
    ];
    let model: StopState = { ...INITIAL_STOP_STATE };
    try {
      for (const [sumX, sumY, stepSum, count, tick, epoch, armed, evaluate] of script) {
        texel.set([sumX, sumY, stepSum, count]);
        stats.writeData(texel, { x: 0, y: 0, width: 1, height: 1 });
        const input: StopInput = { sumX, sumY, stepSum, count, evaluate, sample: tick > 0, armed, spacing, tick, epoch };
        pass.run(stats, { evaluate, sample: tick > 0, armed, threshold, tick, epoch });
        pass.read(out);
        model = latchStop(model, input);
        const gpu = asState(out);
        expect(gpu, `tick ${tick}`).toEqual({ ...model, prevStep: Math.fround(model.prevStep) });
      }
      // Not vacuous: the script latched twice and flagged non-finite.
      expect(model.flags & STOP_NONFINITE).toBe(STOP_NONFINITE);
    } finally {
      pass.destroy();
      stats.destroy();
    }
  });

  it("a solver with the stop armed stops where ForceLayout.run stops (±1), cooled and hot, and stays bitwise frozen", () => {
    for (const schedule of ["cool", "hot"] as const) {
      const g = ringWithChords(schedule === "cool" ? 300 : 200);
      seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
      const params: ForceParams = { ...DEFAULT_FORCE, theta: 0 }; // the CPU exact, as the GPU all-pairs
      const cpuPos = g.positions.slice();
      const cpuTicks = new ForceLayout(view(g, cpuPos), params).run(300, schedule);

      const gpu = new GpuForceLayout(device, view(g, g.positions.slice()), params);
      gpu.stopOnConvergence = true;
      if (schedule === "cool") gpu.cool(300);
      else gpu.hold(1);
      gpu.runFrame(300);
      const state = new Float32Array(4);
      gpu.readStopState(state);
      const stopped = asState(state);
      const frozen = new Float32Array(g.nodeCount * 2);
      gpu.readPositions(frozen);
      gpu.destroy();
      console.log(`  [${schedule}] N=${g.nodeCount}: CPU stops at ${cpuTicks}, GPU at ${stopped.stopTick}; mean edge CPU ${meanEdge(g, cpuPos).toFixed(2)} GPU ${meanEdge(g, frozen).toFixed(2)}`);
      expect(cpuTicks).toBeLessThan(300);
      expect(stopped.flags).toBe(STOP_STOPPED);
      expect(Math.abs(stopped.stopTick - cpuTicks)).toBeLessThanOrEqual(1);
      expect(Math.abs(meanEdge(g, frozen) / meanEdge(g, cpuPos) - 1)).toBeLessThan(0.02);

      // The frozen layout is the stop tick's: the same solve, unarmed, for exactly that many ticks.
      const again = new GpuForceLayout(device, view(g, g.positions.slice()), params);
      if (schedule === "cool") again.cool(300);
      else again.hold(1);
      again.runFrame(stopped.stopTick);
      const reference = new Float32Array(g.nodeCount * 2);
      again.readPositions(reference);
      again.destroy();
      expect(Array.from(frozen)).toEqual(Array.from(reference));
    }
  });

  it("the rule runs once per tick boundary: a copy's extra reduction between ticks cannot stop a growing step", () => {
    // The streaming readback re-runs the reductions between ticks and the next prep runs them again, so the
    // latch sees one boundary twice. Only the first run may evaluate: a second would compare the step with
    // itself (step ≤ step) and stop a layout whose step just grew. Set that up: a settled layout, a kick
    // that makes the next step larger (still far below the threshold), then arm the stop.
    const g = ringWithChords(300);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const gpu = new GpuForceLayout(device, g, DEFAULT_FORCE);
    const state = new Float32Array(4);
    try {
      gpu.cool(500);
      gpu.runFrame(200);
      const kicked = new Float32Array(g.nodeCount * 2);
      gpu.readPositions(kicked);
      const ids = Uint32Array.from({ length: 10 }, (_, k) => k * 30);
      const moved = new Float32Array(ids.length * 2);
      ids.forEach((id, k) => {
        moved[k * 2] = (kicked[id * 2] ?? 0) + 2_000;
        moved[k * 2 + 1] = kicked[id * 2 + 1] ?? 0;
      });
      gpu.setHeldPositions(ids, moved); // not pinned: they spring back, so the next step grows
      gpu.runFrame(1);
      gpu.readStopState(state);
      const before = asState(state).prevStep;
      gpu.stopOnConvergence = true; // 201 ticks into the schedule: armed
      gpu.refreshSegmentStats(); // a copy between ticks: evaluates this boundary
      gpu.readStopState(state);
      const grown = asState(state);
      expect(grown.prevStep, "the kick did not grow the step").toBeGreaterThan(before);
      expect(grown.prevStep).toBeLessThan(CONVERGED_STEP * equilibriumSpacing(DEFAULT_FORCE));
      expect(grown.flags).toBe(0);
      gpu.beginTick(); // the prep at the same boundary: reduces again, must not evaluate again
      gpu.readStopState(state);
      expect(asState(state)).toEqual(grown);
    } finally {
      gpu.destroy();
    }
  });

  it("a non-finite reduction sets the flag and freezes the integrate: every other node stays bitwise put", () => {
    const g = ringWithChords(300);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const gpu = new GpuForceLayout(device, g, DEFAULT_FORCE);
    try {
      gpu.hold(1);
      gpu.runFrame(5);
      const before = new Float32Array(g.nodeCount * 2);
      gpu.readPositions(before);
      // A NaN position (not held): the next reduction's Σx is NaN, and so is every force it touches.
      gpu.setHeldPositions(Uint32Array.of(7), new Float32Array([Number.NaN, Number.NaN]));
      gpu.runFrame(3);
      const state = new Float32Array(4);
      gpu.readStopState(state);
      expect(asState(state).flags & STOP_NONFINITE).toBe(STOP_NONFINITE);
      const after = new Float32Array(g.nodeCount * 2);
      gpu.readPositions(after);
      for (let i = 0; i < g.nodeCount; i++) {
        if (i === 7) continue;
        expect(after[i * 2]).toBe(before[i * 2]);
        expect(after[i * 2 + 1]).toBe(before[i * 2 + 1]);
      }
      // A new schedule does not thaw it.
      gpu.hold(0.3);
      gpu.runFrame(2);
      gpu.readPositions(after);
      expect(after[0]).toBe(before[0]);
    } finally {
      gpu.destroy();
    }
  });

  it("streamed runs stop at the same tick with the synchronous solve's positions, whatever the budget and fence timing", async () => {
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    const webgl = device;
    // The Barnes-Hut pyramid path (forced; small enough to stream quickly under SwiftShader).
    const g = clustered(2_000, 0x57011);
    const pyramid = { repulsionMode: "pyramid" } as const;
    seedPositions(g, 800, 600, { force: DEFAULT_FORCE });
    const seed = g.positions.slice();
    const ITERATIONS = 300;

    // The reference: the synchronous solve with the stop armed.
    const sync = new GpuForceLayout(device, view(g, seed.slice()), DEFAULT_FORCE, pyramid);
    sync.stopOnConvergence = true;
    sync.cool(ITERATIONS);
    sync.runFrame(ITERATIONS);
    const state = new Float32Array(4);
    sync.readStopState(state);
    const reference = new Float32Array(g.nodeCount * 2);
    sync.readPositions(reference);
    sync.destroy();
    const refStop = asState(state);
    expect(refStop.flags).toBe(STOP_STOPPED);
    expect(refStop.stopTick).toBeLessThan(ITERATIONS);

    /**
     * One streamed run from the seed. `lagMs` delays each fence: it reports pending until `lagMs()` after
     * it was inserted, even when the GPU has finished (after that, what the GPU says) — a GPU that
     * completes frames late by a random amount, still in order.
     */
    async function streamed(budgetMs: number, lagMs: () => number): Promise<{ positions: Float32Array; stopTick: number; frames: GpuFrameSample[] }> {
      const graph = { ...g, positions: seed.slice() };
      const layout = new GpuForceLayout(webgl, graph, DEFAULT_FORCE, pyramid);
      layout.cool(ITERATIONS);
      const stream = new GpuStream(webgl, layout, graph, { iterations: ITERATIONS, budgetMs }, () => {});
      const frames: GpuFrameSample[] = [];
      const unobserve = observeGpuLayoutFrames((s) => frames.push({ ...s }));
      const visibleAt = new Map<WebGLSync, number>();
      let lastVisible = 0;
      const insert = WebGL2RenderingContext.prototype.fenceSync;
      const wait = WebGL2RenderingContext.prototype.clientWaitSync;
      const inserts = vi.spyOn(WebGL2RenderingContext.prototype, "fenceSync").mockImplementation(function (this: WebGL2RenderingContext, condition, flags) {
        const sync = insert.call(this, condition, flags);
        lastVisible = Math.max(lastVisible, performance.now() + lagMs());
        if (sync) visibleAt.set(sync, lastVisible);
        return sync;
      });
      const waits = vi.spyOn(WebGL2RenderingContext.prototype, "clientWaitSync").mockImplementation(function (this: WebGL2RenderingContext, sync, flags, timeout) {
        return performance.now() < (visibleAt.get(sync) ?? 0) ? this.TIMEOUT_EXPIRED : wait.call(this, sync, flags, timeout);
      });
      try {
        stream.start();
        await stream.settled;
      } finally {
        inserts.mockRestore();
        waits.mockRestore();
        unobserve();
      }
      const stopTick = frames[frames.length - 1]?.stopTick ?? -1;
      stream.stop();
      return { positions: graph.positions, stopTick, frames };
    }

    const rng = makePrng(0x7e57);
    const generous = await streamed(10, () => 0);
    const tiny = await streamed(0.05, () => (rng() < 0.03 ? 60 : 10 * rng()));
    const bands = (r: { frames: GpuFrameSample[] }): number => Math.max(...r.frames.map((s) => s.bands));
    const ticksPerFrame = (r: { frames: GpuFrameSample[] }): number[] => r.frames.slice(1).map((s, i) => s.ticksDone - (r.frames[i]?.ticksDone ?? 0));
    console.log(
      `  stop tick: sync ${refStop.stopTick}, generous ${generous.stopTick} (${generous.frames.length} frames, ≤ ${Math.max(...ticksPerFrame(generous))} ticks per frame, ≤ ${bands(generous)} bands), ` +
        `tiny + lagging fences ${tiny.stopTick} (${tiny.frames.length} frames, ≤ ${bands(tiny)} bands, ${tiny.frames.filter((s) => s.blocked).length} blocked)`,
    );
    // Not vacuous: the generous run encoded several ticks in a frame, the tiny one spread a tick over
    // frames in more row bands, and the lagging fences blocked some of its frames.
    expect(Math.max(...ticksPerFrame(generous))).toBeGreaterThan(1);
    expect(tiny.frames.some((s, i) => s.items > 0 && i > 0 && s.ticksDone === tiny.frames[i - 1]?.ticksDone)).toBe(true);
    expect(bands(tiny)).toBeGreaterThan(bands(generous));
    expect(tiny.frames.some((s) => s.blocked)).toBe(true);

    for (const run of [generous, tiny]) {
      expect(run.stopTick).toBe(refStop.stopTick);
      expect(Array.from(run.positions)).toEqual(Array.from(reference));
    }
  }, 120_000);

  it("through the transport: the worker rule's stop tick (±1), and settled after the stop tick's harvest", async () => {
    const g = ringWithChords(200);
    // The worker's cold start: the equilibrium disc at full heat, stopping once converged.
    const seeded = { ...g, positions: g.positions.slice() };
    seedPositions(seeded, 400, 300, { force: DEFAULT_FORCE });
    const workerTicks = new ForceLayout(seeded, { ...DEFAULT_FORCE, theta: 0 }).run(300, "hot");

    const frames: GpuFrameSample[] = [];
    const unobserve = observeGpuLayoutFrames((s) => frames.push({ ...s }));
    let framesAtSettle = -1;
    // The worker's cold start above, so the GPU's too: no multilevel seed (#353).
    const handle = startGpuLayout(device, g, { width: 400, height: 300, iterations: 300, multilevel: false }, () => {});
    try {
      await handle.settled;
      framesAtSettle = frames.length;
    } finally {
      unobserve();
    }
    const stopTick = frames[frames.length - 1]?.stopTick ?? -1;
    console.log(`  transport: worker rule stops at ${workerTicks}, GPU at ${stopTick}`);
    expect(workerTicks).toBeLessThan(300);
    expect(Math.abs(stopTick - workerTicks)).toBeLessThanOrEqual(1);
    // The stop was learned from a harvest, which settled the run; the loop then went idle.
    const learned = frames.findIndex((s) => s.stopTick >= 0);
    expect(learned).toBeGreaterThanOrEqual(0);
    expect(frames[learned]?.harvested).toBe(true);
    expect(learned).toBeLessThan(framesAtSettle);
    expect(frames.slice(learned + 1).every((s) => !s.harvested && s.items === 0)).toBe(true);
    // It stopped encoding within a few frames of the stop, not at the 300-tick budget.
    expect(frames[frames.length - 1]?.ticksDone ?? 300).toBeLessThan(300);
    handle.stop();
  }, 60_000);

  it("a non-finite layout stops the stream with one warning and settles", async () => {
    const g = ringWithChords(300);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let frames = 0;
    // A cold start: at full heat it is still running when the NaN arrives (a seeded run, #353, could have
    // converged and settled already).
    const handle = startGpuLayout(device, g, { width: 400, height: 300, iterations: 100_000, multilevel: false }, () => { frames++; });
    try {
      for (let i = 0; i < 200 && frames < 2; i++) await nextFrame();
      handle.pin(Uint32Array.of(7), new Float32Array([Number.NaN, Number.NaN]));
      await handle.settled;
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("non-finite"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      handle.stop();
    }
  });

  it("a stop harvested after a newer schedule began is stale: it does not end that schedule", async () => {
    // The stream learns of a stop frames after the GPU latched it. Copies here are rare (frameEvery), so a
    // re-cool's only copy is its final one, which carries the latch of that re-cool. If a drag starts and
    // ends (a new re-cool) after that copy was issued but before it is harvested, the harvested stop belongs
    // to the previous schedule and must be ignored: the new re-cool runs on and stops by its own latch.
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    const g = ringWithChords(300);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const layout = new GpuForceLayout(device, g, DEFAULT_FORCE);
    layout.cool(300);
    const stream = new GpuStream(device, layout, g, { iterations: 300, frameEvery: 100_000 }, () => {});
    const frames: GpuFrameSample[] = [];
    let ticksAtUnpin = Number.POSITIVE_INFINITY;
    let secondUnpin = -1;
    const held = new Float32Array([g.positions[0] ?? 0, g.positions[1] ?? 0]);
    const unobserve = observeGpuLayoutFrames((s) => {
      frames.push({ ...s });
      // The re-cool's final copy has just been issued (it is harvested in a later frame): drag and release.
      if (secondUnpin < 0 && s.copied && s.ticksDone >= ticksAtUnpin + RECOOL_TICKS) {
        secondUnpin = s.ticksDone;
        stream.pin(Uint32Array.of(0), held);
        stream.unpin();
      }
    });
    try {
      stream.start();
      await stream.settled;
      expect(frames[frames.length - 1]?.stopTick ?? -1).toBeGreaterThan(0);
      // A re-cool: a drag released at once.
      ticksAtUnpin = frames[frames.length - 1]?.ticksDone ?? 0;
      stream.pin(Uint32Array.of(0), held);
      stream.unpin();
      let idle = 0;
      for (let f = 0; f < 3_000 && idle < 10; f++) {
        const n = frames.length;
        await nextFrame();
        idle = frames.length === n ? idle + 1 : 0;
      }
      expect(secondUnpin, "the first re-cool never issued its final copy").toBeGreaterThan(0);
      const stopTick = frames[frames.length - 1]?.stopTick ?? -1;
      console.log(`  re-cool from ${ticksAtUnpin}, final copy at ${secondUnpin}; the second re-cool stops at ${stopTick}`);
      expect(stopTick).toBeGreaterThanOrEqual(secondUnpin + MIN_SETTLE_TICKS);
    } finally {
      unobserve();
      stream.stop();
    }
  }, 120_000);

  it("reheat: a drag never stops; its re-cool stops once converged, MIN_SETTLE_TICKS to RECOOL_TICKS into it", async () => {
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    const g = ringWithChords(300);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const layout = new GpuForceLayout(device, g, DEFAULT_FORCE);
    layout.cool(300);
    const stream = new GpuStream(device, layout, g, { iterations: 300 }, () => {});
    const frames: GpuFrameSample[] = [];
    const unobserve = observeGpuLayoutFrames((s) => frames.push({ ...s }));
    try {
      stream.start();
      await stream.settled;
      const runStop = frames[frames.length - 1]?.stopTick ?? -1;
      expect(runStop).toBeGreaterThanOrEqual(MIN_SETTLE_TICKS);
      expect(runStop).toBeLessThan(300);

      // Drag node 0 far off for a while: ticks run, no stop is ever reported while held.
      const held = new Float32Array([(g.positions[0] ?? 0) + 300, g.positions[1] ?? 0]);
      const dragFrom = frames.length;
      stream.pin(Uint32Array.of(0), held);
      for (let f = 0; f < 60; f++) {
        held[0] = (held[0] ?? 0) + 1;
        stream.pin(Uint32Array.of(0), held);
        await nextFrame();
      }
      const drag = frames.slice(dragFrom);
      expect((drag[drag.length - 1]?.ticksDone ?? 0) - (drag[0]?.ticksDone ?? 0)).toBeGreaterThan(0);
      expect(drag.every((s) => s.stopTick === -1)).toBe(true);

      // Release: the re-cool stops by convergence, not at its RECOOL_TICKS cap.
      const coolFrom = frames.length;
      const ticksAtRelease = frames[frames.length - 1]?.ticksDone ?? 0;
      stream.unpin();
      let idle = 0;
      for (let f = 0; f < 2_000 && idle < 10; f++) {
        const n = frames.length;
        await nextFrame();
        idle = frames.length === n ? idle + 1 : 0;
      }
      const cool = frames.slice(coolFrom);
      const coolStop = cool[cool.length - 1]?.stopTick ?? -1;
      console.log(`  run stops at ${runStop}; re-cool released at tick ${ticksAtRelease}, stops at ${coolStop}`);
      expect(coolStop - ticksAtRelease).toBeGreaterThanOrEqual(MIN_SETTLE_TICKS);
      expect(coolStop - ticksAtRelease).toBeLessThan(RECOOL_TICKS);
    } finally {
      unobserve();
      stream.stop();
    }
  }, 120_000);

  /**
   * A stream whose run stops at its first tick, with a copy after every tick, and a copy harvested two or
   * more frames after it was issued. The layout was held at zero heat for `MIN_SETTLE_TICKS` ticks, so
   * nothing moves, every step is 0 and the stop latches at the stream's first prep. Every copy's fence
   * reports pending for 40 ms (the GPU has finished; the fence lags), so the gate lets the frame after a
   * copy encode layout work and blocks the next ones until the copy is harvested. `budgetMs` sets the
   * items per frame. Call `restore` when done.
   */
  function stopReadyStream(budgetMs: number): { g: NetworkGraph; stream: GpuStream; frames: GpuFrameSample[]; restore: () => void } {
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    const g = ringWithChords(300);
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const layout = new GpuForceLayout(device, g, DEFAULT_FORCE);
    layout.hold(0);
    layout.runFrame(MIN_SETTLE_TICKS);
    const stream = new GpuStream(device, layout, g, { iterations: 300, frameEvery: 1, budgetMs }, () => {});
    const frames: GpuFrameSample[] = [];
    const lagging = new Map<WebGLSync, number>();
    let lastFence: WebGLSync | null = null;
    const insert = WebGL2RenderingContext.prototype.fenceSync;
    const wait = WebGL2RenderingContext.prototype.clientWaitSync;
    const inserts = vi.spyOn(WebGL2RenderingContext.prototype, "fenceSync").mockImplementation(function (this: WebGL2RenderingContext, condition, flags) {
      lastFence = insert.call(this, condition, flags);
      return lastFence;
    });
    const waits = vi.spyOn(WebGL2RenderingContext.prototype, "clientWaitSync").mockImplementation(function (this: WebGL2RenderingContext, sync, flags, timeout) {
      return performance.now() < (lagging.get(sync) ?? 0) ? this.TIMEOUT_EXPIRED : wait.call(this, sync, flags, timeout);
    });
    const unobserve = observeGpuLayoutFrames((s) => {
      frames.push({ ...s });
      // The frame's budget fence, just inserted, is the copy's fence.
      if (s.copied && lastFence) lagging.set(lastFence, performance.now() + 40);
    });
    return {
      g, stream, frames,
      restore: () => {
        unobserve();
        inserts.mockRestore();
        waits.mockRestore();
        stream.stop();
      },
    };
  }

  it("a drag after a stop that was harvested part-way into a tick starts from the held position", async () => {
    // One item per frame (a budget below any item) in many row bands: the stop's harvest lands part-way
    // into the next — frozen — tick, and the stream goes idle there. A pin must start a fresh tick, whose
    // prep writes the held position, not finish the half tick from the old prep with the node where it was.
    const { g, stream, frames, restore } = stopReadyStream(1e-4);
    try {
      stream.start();
      await stream.settled;
      const learned = frames.findIndex((s) => s.stopTick >= 0);
      expect(learned).toBeGreaterThan(0);
      expect(frames[learned]?.stopTick).toBe(MIN_SETTLE_TICKS);
      // Not vacuous: after the copy that carried the stop, items were encoded and no tick completed, so
      // the harvest found a tick part-way encoded.
      let copy = learned - 1;
      while (copy > 0 && !frames[copy]?.copied) copy--;
      const between = frames.slice(copy + 1, learned);
      expect(between.reduce((sum, s) => sum + s.items, 0)).toBeGreaterThan(0);
      expect(frames[learned - 1]?.ticksDone).toBe(frames[copy]?.ticksDone);
      expect(Math.max(...frames.map((s) => s.items))).toBe(1);

      const held = new Float32Array([(g.positions[0] ?? 0) + 300, (g.positions[1] ?? 0) - 200]);
      const pinFrom = frames.length;
      stream.pin(Uint32Array.of(0), held);
      for (let f = 0; f < 600 && !frames.slice(pinFrom).some((s) => s.harvested); f++) await nextFrame();
      const first = frames.slice(pinFrom).find((s) => s.harvested);
      expect(first, "no harvest after the pin").toBeDefined();
      // The first drag tick's copy has the node at its held position.
      expect([g.positions[0], g.positions[1]]).toEqual([held[0], held[1]]);
    } finally {
      restore();
    }
  }, 60_000);

  it("once a harvested stop has ended the run, the stream copies and repaints nothing more", async () => {
    // A generous budget: frozen ticks complete between the stop's copy and its harvest, so ticks have
    // advanced past the last copy. Their positions are the stop tick's; copying them again is waste.
    const { stream, frames, restore } = stopReadyStream(10);
    try {
      stream.start();
      await stream.settled;
      for (let f = 0; f < 10; f++) await nextFrame();
      const learned = frames.findIndex((s) => s.stopTick >= 0);
      expect(learned).toBeGreaterThan(0);
      let copy = learned - 1;
      while (copy > 0 && !frames[copy]?.copied) copy--;
      // Not vacuous: frozen ticks completed after the copy the stop was learned from.
      expect(frames[learned]?.ticksDone ?? 0).toBeGreaterThan(frames[copy]?.ticksDone ?? 0);
      expect(frames[learned]?.copied).toBe(false);
      expect(frames.slice(learned + 1).every((s) => !s.copied && !s.harvested)).toBe(true);
    } finally {
      restore();
    }
  }, 60_000);
});
