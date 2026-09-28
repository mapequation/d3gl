/**
 * The streaming GPU layout's repaint throttle (#352, spec §6.5.4) — node, pure, driven by hand-made rAF
 * timestamps. A layout repaint is due once `max(minFrameMs, 2 × max(repaint main-thread ms, GPU stall))`
 * has passed since the previous one; the GPU stall is the rAF gap after a repaint frame beyond the usual
 * interval. What this file pins beyond the formula: a gap that is **not** a render cost — a hidden tab, a
 * long task after a repaint frame — never stalls the layout's repaints for that long afterwards; and a
 * frame that takes a round trip to the LOD worker before it can be painted (#377) is harvested that much
 * earlier, so the repaints keep their cadence.
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
    t.readbackStarted(10);
    t.copyCompleted(30);
    expect(t.copyDue(MIN_FRAME_MS - 20 - 2 - 1, false)).toBe(false);
    expect(t.copyDue(MIN_FRAME_MS - 20, false)).toBe(true);
    // A copy in flight across a hidden-page gap: its "latency" is the gap, not the copy.
    t.readbackStarted(100);
    t.pause();
    t.copyCompleted(60_100);
    expect(t.copyDue(MIN_FRAME_MS - 20 - 2 - 1, false)).toBe(false);
  });

  it("a relayed frame (#377) is harvested one round trip early, so repaints keep the interval", () => {
    const t = new RepaintThrottle();
    const ROUND_TRIP = 25; // the LOD worker's refit: 1.5 frames at 60 Hz
    let now = 1000;
    let sentAt = Number.NaN;
    let inFlight = false;
    let ready = false;
    const repaints: number[] = [];
    for (let f = 0; f < 600; f++, now += FRAME) {
      t.beginFrame(now, FRAME);
      if (inFlight && now - sentAt >= ROUND_TRIP) {
        inFlight = false;
        ready = true;
        t.returned(now);
      }
      if (ready && t.due(now)) {
        ready = false;
        t.repainted(now, 1);
        repaints.push(now);
      }
      if (!inFlight && !ready && t.harvestDue(now, true)) {
        inFlight = true;
        sentAt = now;
        t.submitted(now);
      }
    }
    const gaps = repaints.slice(3).map((r, i) => r - (repaints[i + 2] ?? r));
    // Harvesting only once the repaint is due would space them by 50 ms + the round trip (4-5 frames).
    for (const g of gaps) expect(g).toBeLessThan(MIN_FRAME_MS + FRAME);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(MIN_FRAME_MS - 2);
  });

  it("a frame painted where it was harvested has no round trip: harvests are due with the repaint", () => {
    const t = new RepaintThrottle();
    t.beginFrame(0, FRAME);
    t.submitted(0);
    t.returned(0);
    t.repainted(0, 1);
    expect(t.harvestDue(MIN_FRAME_MS - 3, true)).toBe(false);
    expect(t.harvestDue(MIN_FRAME_MS - 2, true)).toBe(true);
    expect(t.harvestDue(MIN_FRAME_MS - 2, true)).toBe(t.due(MIN_FRAME_MS - 2));
  });

  it("a pause drops a round-trip sample spanning it", () => {
    const t = new RepaintThrottle();
    t.beginFrame(0, FRAME);
    t.repainted(0, 1);
    t.submitted(10);
    t.pause(); // a hidden tab while the worker refits
    t.returned(60_010);
    expect(t.harvestDue(MIN_FRAME_MS - 3, true)).toBe(false);
    // Copies lead by the copy latency and the round trip together (a round trip is honoured once it repeats).
    t.submitted(100);
    t.returned(120);
    t.submitted(130);
    t.returned(150);
    t.readbackStarted(160);
    t.copyCompleted(170);
    expect(t.copyDue(MIN_FRAME_MS - 20 - 10 - 3, true)).toBe(false);
    expect(t.copyDue(MIN_FRAME_MS - 20 - 10 - 2, true)).toBe(true);
  });

  it("a round trip must repeat to count: one reply that waited out a long task does not advance the harvests", () => {
    const t = new RepaintThrottle();
    t.beginFrame(0, FRAME);
    t.repainted(0, 1);
    for (const at of [100, 200]) {
      t.submitted(at);
      t.returned(at + 20); // the worker's refit
    }
    t.submitted(300);
    t.returned(900); // the reply landed during a 600 ms task
    // Harvests lead by the repeated 20 ms, not 600 ms (which would harvest right after every repaint).
    expect(t.harvestDue(MIN_FRAME_MS - 20 - 3, true)).toBe(false);
    expect(t.harvestDue(MIN_FRAME_MS - 20 - 2, true)).toBe(true);
    // And a repeated long round trip is honoured: the latency is real.
    t.submitted(1000);
    t.returned(1600);
    expect(t.harvestDue(MIN_FRAME_MS - 600, true)).toBe(true);
  });

  it("frames painted where they are harvested lead by no round trip, whatever the last relayed one was", () => {
    const t = new RepaintThrottle();
    t.beginFrame(0, FRAME);
    t.repainted(0, 1);
    for (const at of [100, 200]) {
      t.submitted(at);
      t.returned(at + 30); // relayed, before the LOD worker failed
    }
    t.readbackStarted(300);
    t.copyCompleted(310);
    // The sink no longer relays: copies and harvests lead by the copy latency alone.
    expect(t.copyDue(MIN_FRAME_MS - 10 - 3, false)).toBe(false);
    expect(t.copyDue(MIN_FRAME_MS - 10 - 2, false)).toBe(true);
    expect(t.harvestDue(MIN_FRAME_MS - 3, false)).toBe(false);
    expect(t.harvestDue(MIN_FRAME_MS - 2, false)).toBe(true);
  });

  it("times a readback from its start, so the frames its passes wait for budget before the copy count (#382)", () => {
    // A readback started at 0 whose passes ran in the next frame, copied there (≈ 17 ms), and whose copy was
    // seen complete a frame after that: 33 ms from the start. The next one is started 33 ms before the
    // repaint is due, so its copy lands in time even though it too waits a frame.
    const t = new RepaintThrottle();
    t.beginFrame(0, FRAME);
    t.repainted(0, 1);
    t.readbackStarted(0);
    t.copyCompleted(2 * FRAME);
    expect(t.copyDue(MIN_FRAME_MS - 2 * FRAME - 2 - 1, false)).toBe(false);
    expect(t.copyDue(MIN_FRAME_MS - 2 * FRAME, false)).toBe(true);
  });
});
