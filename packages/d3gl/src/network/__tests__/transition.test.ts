import { describe, it, expect } from "vitest";
import { easeCubicInOut, lerpPositions, positionTransition, type PositionTransitionOptions } from "../transition.js";

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
