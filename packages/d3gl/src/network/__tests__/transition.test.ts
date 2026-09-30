import { describe, it, expect } from "vitest";
import { easeCubicInOut, easeCubicOut, lerpPositions, positionTransition, type PositionTransitionOptions } from "../transition.js";

/** A hand-cranked clock + frame queue: `step(ms)` advances time and runs the pending frame. */
function manualFrames(): { opts: Pick<PositionTransitionOptions, "now" | "requestFrame" | "cancelFrame">; step(ms: number): void; pending(): number } {
  let time = 0;
  let nextId = 1;
  const queue = new Map<number, () => void>();
  return {
    opts: {
      now: () => time,
      requestFrame: (cb) => {
        const id = nextId++;
        queue.set(id, cb);
        return id;
      },
      cancelFrame: (id) => {
        queue.delete(id);
      },
    },
    step(ms) {
      time += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb();
    },
    pending: () => queue.size,
  };
}

describe("position transitions (#328)", () => {
  it("eases slow–fast–slow from 0 to 1", () => {
    expect(easeCubicInOut(0)).toBe(0);
    expect(easeCubicInOut(0.5)).toBe(0.5);
    expect(easeCubicInOut(1)).toBe(1);
    expect(easeCubicInOut(0.1)).toBeLessThan(0.1);
    expect(easeCubicInOut(0.9)).toBeGreaterThan(0.9);
  });

  it("interpolates every coordinate in place", () => {
    const out = new Float32Array(4);
    lerpPositions(out, new Float32Array([0, 0, 10, 10]), new Float32Array([10, 20, 10, 0]), 0.25);
    expect(Array.from(out)).toEqual([2.5, 5, 10, 7.5]);
  });

  it("waits for its target, eases on each frame, and ends exactly on the target", async () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0, 100, 100]);
    let frames = 0;
    const t = positionTransition(positions, { ...f.opts, duration: 100, onFrame: () => frames++ });
    expect(Array.from(t.from)).toEqual([0, 0, 100, 100]);
    expect(t.running).toBe(false);
    expect(f.pending()).toBe(0); // nothing scheduled before `to`

    const target = new Float32Array([100, 50, 0, 100]);
    t.to(target);
    expect(t.running).toBe(true);
    f.step(50); // halfway: the ease is at 0.5
    expect(Array.from(positions)).toEqual([50, 25, 50, 100]);
    f.step(25);
    expect(positions[0]).toBeCloseTo(100 * easeCubicInOut(0.75), 4);
    f.step(1000); // past the end: exactly the target, then no more frames
    expect(Array.from(positions)).toEqual([100, 50, 0, 100]);
    expect(frames).toBe(3);
    expect(t.running).toBe(false);
    expect(f.pending()).toBe(0);
    await t.settled;
    expect(t.from).toHaveLength(0); // a settled transition holds no per-node memory
  });

  it("hands each frame its eased progress — what the positions moved by — and exactly 1 on the last (#427)", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    const seen: number[] = [];
    const moved: number[] = [];
    const t = positionTransition(positions, {
      ...f.opts,
      duration: 100,
      onFrame: (progress) => {
        seen.push(progress);
        moved.push((positions[0] ?? NaN) / 100);
      },
    });
    t.to(new Float32Array([100, 100]));
    f.step(25);
    f.step(50);
    f.step(1000);
    expect(seen).toEqual([easeCubicInOut(0.25), easeCubicInOut(0.75), 1]);
    moved.forEach((m, i) => expect(m).toBeCloseTo(seen[i] ?? NaN, 6)); // the same ease, the same frame
  });

  it("stops where it is", async () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, onFrame: () => {} });
    t.to(new Float32Array([100, 100]));
    f.step(50);
    t.stop();
    f.step(100);
    expect(Array.from(positions)).toEqual([50, 50]);
    expect(f.pending()).toBe(0);
    await t.settled;
    t.to(new Float32Array([7, 7])); // ignored once ended
    expect(f.pending()).toBe(0);
  });

  it("finishes on the target without another frame", async () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    let frames = 0;
    const t = positionTransition(positions, { ...f.opts, duration: 100, onFrame: () => frames++ });
    t.to(new Float32Array([100, 100]));
    f.step(10);
    t.finish();
    expect(Array.from(positions)).toEqual([100, 100]);
    expect(frames).toBe(1);
    expect(f.pending()).toBe(0);
    await t.settled;
  });

  it("settles when stopped before it has a target, leaving the positions untouched", async () => {
    const f = manualFrames();
    const positions = new Float32Array([3, 4]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, onFrame: () => {} });
    t.finish();
    await t.settled;
    expect(Array.from(positions)).toEqual([3, 4]);
  });

  it("keeps a node where it was dropped — while running, and when dropped before the target arrived", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0, 10, 10, 20, 20]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, onFrame: () => {} });
    positions[0] = 7; // node 0 dragged to (7, 8) while the target is being computed
    positions[1] = 8;
    t.keep([0]);
    const target = new Float32Array([100, 100, 110, 110, 120, 120]);
    t.to(target);
    f.step(50);
    expect([positions[0], positions[1]]).toEqual([7, 8]); // stays at the drop, not eased from (0, 0)
    expect(positions[2]).toBeCloseTo(60, 4); // the others ease
    positions[4] = -5; // node 2 dragged mid-ease and dropped at (-5, -6)
    positions[5] = -6;
    t.keep([2]);
    f.step(1000);
    expect(Array.from(positions)).toEqual([7, 8, 110, 110, -5, -6]);
    t.keep([1]); // ended: ignored
    expect(Array.from(positions)).toEqual([7, 8, 110, 110, -5, -6]);
  });

  it("jumps on the first frame when the duration is not positive", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    let frames = 0;
    const t = positionTransition(positions, { ...f.opts, duration: Number.NaN, onFrame: () => frames++ });
    t.to(new Float32Array([5, 6]));
    f.step(0);
    expect(Array.from(positions)).toEqual([5, 6]);
    expect(frames).toBe(1);
    expect(t.running).toBe(false);
  });
});

/** `ease` stretched over the rest of a schedule from a retarget at eased progress `base` (#454). */
const rest = (ease: number, base: number): number => (ease - base) / (1 - base);

describe("chasing a moving target: retarget (#454)", () => {
  it("eases out: moves at once, then slows to rest", () => {
    expect(easeCubicOut(0)).toBe(0);
    expect(easeCubicOut(1)).toBe(1);
    expect(easeCubicOut(0.1)).toBeGreaterThan(0.25); // a quarter of the way after a tenth of the time
    for (let t = 0; t < 1; t += 0.05) expect(easeCubicOut(t + 0.05)).toBeGreaterThan(easeCubicOut(t));
  });

  it("before `to`, it is `to` from where the positions are now", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, onFrame: () => {}, ease: (x) => x });
    positions.set([10, 10]); // moved since the transition was created (a drag while the solve ran)
    expect(t.retarget(new Float32Array([20, 30]))).toBe(true);
    expect(t.running).toBe(true);
    f.step(50);
    expect(Array.from(positions)).toEqual([15, 20]);
  });

  it("moves on from where the positions are, without a jump, and still ends on schedule on the newest target", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0, 100, 0]);
    const eased: number[] = [];
    const t = positionTransition(positions, { ...f.opts, duration: 100, ease: easeCubicOut, onFrame: (p) => eased.push(p) });
    t.to(new Float32Array([100, 0, 100, 100]));
    f.step(20);
    const at = Array.from(positions);
    const base = easeCubicOut(0.2);
    expect(at[0]).toBeCloseTo(100 * base, 4);
    // A newer frame lands: ease from here to it over the 80 ms left.
    const next = new Float32Array([0, 100, 0, 100]);
    expect(t.retarget(next)).toBe(true);
    expect(Array.from(t.from)).toEqual(at); // it moves on from the positions on screen
    f.step(10);
    const k = rest(easeCubicOut(0.3), base);
    expect(positions[0]).toBeCloseTo(at[0]! + (0 - at[0]!) * k, 4);
    expect(positions[1]).toBeCloseTo(at[1]! + (100 - at[1]!) * k, 4);
    // No jump: the first frame after the retarget moves no farther than the eased share of one frame.
    expect(Math.abs(positions[0]! - at[0]!)).toBeLessThan(Math.abs(at[0]!) * (easeCubicOut(0.3) - base) / (1 - base) + 1e-3);
    f.step(70); // the schedule's end: exactly on the newest target
    expect(Array.from(positions)).toEqual([0, 100, 0, 100]);
    expect(t.running).toBe(false);
    expect(t.ended).toBe(true);
    expect(eased[eased.length - 1]).toBe(1);
  });

  it("follows a target rewritten in place before each retarget (a frame read back into one buffer)", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    const buffer = new Float32Array([10, 0]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, ease: (x) => x, onFrame: () => {} });
    t.retarget(buffer);
    f.step(50);
    expect(Array.from(positions)).toEqual([5, 0]);
    buffer.set([10, 10]);
    t.retarget(buffer);
    f.step(25); // half the time left: halfway from (5, 0) to (10, 10)
    expect(positions[0]).toBeCloseTo(7.5, 4);
    expect(positions[1]).toBeCloseTo(5, 4);
    f.step(25);
    expect(Array.from(positions)).toEqual([10, 10]);
  });

  it("after the end it declines: the caller puts the frame in place itself", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    const t = positionTransition(positions, { ...f.opts, duration: 10, onFrame: () => {} });
    t.to(new Float32Array([1, 1]));
    f.step(20);
    expect(t.ended).toBe(true);
    expect(t.retarget(new Float32Array([5, 5]))).toBe(false);
    expect(Array.from(positions)).toEqual([1, 1]);
    const stopped = positionTransition(positions, { ...f.opts, duration: 10, onFrame: () => {} });
    stopped.stop();
    expect(stopped.retarget(new Float32Array([5, 5]))).toBe(false);
  });

  it("with maxFrameMs, a stalled frame moves on by at most that much of the schedule — it slows, never leaps", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, ease: (x) => x, maxFrameMs: 10, onFrame: () => {} });
    t.to(new Float32Array([100, 0]));
    f.step(8);
    expect(positions[0]).toBeCloseTo(8, 4);
    f.step(500); // a busy main thread: half a second without a frame
    expect(positions[0]).toBeCloseTo(18, 4);
    f.step(8);
    expect(positions[0]).toBeCloseTo(26, 4);
    for (let i = 0; i < 12; i++) f.step(8);
    expect(Array.from(positions)).toEqual([100, 0]); // still ends exactly on the target
    // Without it the wall clock rules: the same stall ends the transition.
    const g = manualFrames();
    const p2 = new Float32Array([0, 0]);
    positionTransition(p2, { ...g.opts, duration: 100, ease: (x) => x, onFrame: () => {} }).to(new Float32Array([100, 0]));
    g.step(8);
    g.step(500);
    expect(Array.from(p2)).toEqual([100, 0]);
  });

  it("keeps kept nodes kept through every retarget", () => {
    const f = manualFrames();
    const positions = new Float32Array([0, 0, 50, 50]);
    const t = positionTransition(positions, { ...f.opts, duration: 100, ease: (x) => x, onFrame: () => {} });
    t.to(new Float32Array([100, 100, 100, 100]));
    f.step(20);
    t.keep([1]); // node 1 dropped here
    const held = [positions[2], positions[3]];
    t.retarget(new Float32Array([0, 0, 0, 0]));
    f.step(30);
    expect([positions[2], positions[3]]).toEqual(held);
    t.retarget(new Float32Array([7, 7, 9, 9]));
    f.step(50);
    expect([positions[2], positions[3]]).toEqual(held);
    expect([positions[0], positions[1]]).toEqual([7, 7]);
  });
});
