/**
 * The streaming GPU layout's repaint throttle (#352, spec §6.5.4) — node, pure, driven by hand-made rAF
 * timestamps. A layout repaint is due once `max(minFrameMs, 2 × max(repaint main-thread ms, GPU stall))`
 * has passed since the previous one; the GPU stall is the rAF gap after a repaint frame beyond the usual
 * interval. What this file pins beyond the formula: a gap that is **not** a render cost — a hidden tab, a
 * long task after a repaint frame — never stalls the layout's repaints for that long afterwards.
 */
import { describe, expect, it } from "vitest";
import { MIN_FRAME_MS, RepaintThrottle } from "../repaint-throttle.js";

const FRAME = 1000 / 60;

/** Drives a throttle frame by frame at 60 Hz, repainting whenever it is due (as the stream does). */
class Driver {
  readonly throttle = new RepaintThrottle();
  now = 1000;
  readonly repaints: number[] = [];

  /** One frame at `now`; repaints (costing `repaintMs` of main thread) when due. */
  frame(repaintMs = 1): boolean {
    this.throttle.beginFrame(this.now, FRAME);
    const due = this.throttle.due(this.now);
    if (due) {
      this.throttle.repainted(this.now, repaintMs);
      this.repaints.push(this.now);
    }
    this.now += FRAME;
    return due;
  }

  /** Frames until the next repaint (inclusive), at most `max`. */
  untilRepaint(max = 10_000, repaintMs = 1): number {
    for (let f = 1; f <= max; f++) if (this.frame(repaintMs)) return f;
    return Infinity;
  }

  /** The previous frame repainted; the next frame arrives `gapMs` late (a stall, a pause, a long task). */
  gap(gapMs: number): void {
    this.now += gapMs;
  }
}

describe("RepaintThrottle (#352)", () => {
  it("cheap repaints: one every minFrameMs (3 frames at 60 Hz), never sooner", () => {
    const d = new Driver();
    d.untilRepaint();
    for (let i = 0; i < 20; i++) d.untilRepaint();
    const gaps = d.repaints.slice(1).map((t, i) => t - (d.repaints[i] ?? t));
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(MIN_FRAME_MS - 2);
      expect(g).toBeLessThan(MIN_FRAME_MS + FRAME);
    }
    expect(d.throttle.intervalMs).toBe(MIN_FRAME_MS);
  });

  it("the main-thread term: a 40 ms repaint spaces repaints by 80 ms", () => {
    const d = new Driver();
    d.untilRepaint(10_000, 40);
    expect(d.throttle.intervalMs).toBe(80);
  });

  it("a render that stalls the next frame every time spaces repaints by twice the stall", () => {
    const d = new Driver();
    // Every repaint frame is followed by a 2 s gap (SwiftShader drawing a 100k-node canvas).
    for (let i = 0; i < 3; i++) {
      d.untilRepaint();
      d.gap(2000);
    }
    d.frame(); // the frame after the third stall samples it
    expect(d.throttle.intervalMs).toBeGreaterThan(2 * 2000 - 1e-6);
  });

  it("one long gap after a repaint frame (a long task, a missed tab switch) does not stall the next repaint", () => {
    const d = new Driver();
    for (let i = 0; i < 5; i++) d.untilRepaint();
    d.gap(60_000); // right after a repaint frame
    const frames = d.untilRepaint();
    // Due again within the usual cadence, not 2 × 60 s later.
    expect(frames * FRAME).toBeLessThanOrEqual(MIN_FRAME_MS + FRAME);
    expect(d.throttle.intervalMs).toBe(MIN_FRAME_MS);
  });

  it("a paused loop (a hidden page, an idle resume) samples no stall across the pause", () => {
    const d = new Driver();
    d.untilRepaint();
    d.gap(5_000);
    d.throttle.pause();
    d.untilRepaint();
    d.gap(5_000);
    d.throttle.pause();
    const frames = d.untilRepaint();
    expect(frames * FRAME).toBeLessThanOrEqual(MIN_FRAME_MS + FRAME);
    expect(d.throttle.intervalMs).toBe(MIN_FRAME_MS);
  });

  it("recovers at once when the render stops stalling", () => {
    const d = new Driver();
    for (let i = 0; i < 3; i++) {
      d.untilRepaint();
      d.gap(1000);
    }
    d.frame();
    expect(d.throttle.intervalMs).toBeGreaterThan(2000 - 1e-6);
    d.untilRepaint(); // the render is cheap again: the frame after it samples no stall
    d.frame();
    expect(d.throttle.intervalMs).toBe(MIN_FRAME_MS);
  });

  it("copies are due one copy latency before the repaint, and a pause drops a latency sample spanning it", () => {
    const t = new RepaintThrottle();
    t.beginFrame(0, FRAME);
    t.repainted(0, 1);
    // A copy that takes 20 ms to be seen complete.
    t.copyIssued(10);
    t.copyCompleted(30);
    expect(t.copyDue(MIN_FRAME_MS - 20 - 2 - 1)).toBe(false);
    expect(t.copyDue(MIN_FRAME_MS - 20)).toBe(true);
    // A copy in flight across a hidden-page gap: its "latency" is the gap, not the copy.
    t.copyIssued(100);
    t.pause();
    t.copyCompleted(60_100);
    expect(t.copyDue(MIN_FRAME_MS - 20 - 2 - 1)).toBe(false);
  });
});
