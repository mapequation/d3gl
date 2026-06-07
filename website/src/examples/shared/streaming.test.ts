import { describe, it, expect } from "vitest";
import { StreamController } from "./streaming.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A tiny finite source: yields `count` batches of [seed, i, size]. `batchSize` is a
 *  getter (re-read each batch) so adaptive resizing is observable. */
async function* source(
  o: { batchSize: () => number; seed: number; signal: { aborted: boolean } },
  count = 5,
) {
  for (let i = 0; i < count; i++) {
    if (o.signal.aborted) return;
    yield [{ seed: o.seed, i, size: o.batchSize() }];
    await tick(0);
  }
}

describe("StreamController", () => {
  it("pumps batches into onBatch after restart, and resets first", async () => {
    const seen: number[] = [];
    let resets = 0;
    const ctrl = new StreamController<{ i: number }>({
      source: (o) => source(o),
      onBatch: (b) => seen.push(...b.map((x) => x.i)),
      onReset: () => resets++,
    });
    ctrl.restart(1);
    await tick(60);
    expect(resets).toBe(1);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("pauses (no new batches) while not running, then resumes", async () => {
    const seen: number[] = [];
    const ctrl = new StreamController<{ i: number }>({
      source: (o) => source(o, 50),
      onBatch: (b) => seen.push(...b.map((x) => x.i)),
      onReset: () => {},
    });
    ctrl.restart(1);
    await tick(30);
    ctrl.setRunning(false);
    const countAtPause = seen.length;
    await tick(150);
    expect(seen.length).toBe(countAtPause); // no progress while paused
    ctrl.setRunning(true);
    await tick(60);
    expect(seen.length).toBeGreaterThan(countAtPause); // resumed
    ctrl.dispose();
  });

  it("restart supersedes the previous session (no interleaving)", async () => {
    const seeds: number[] = [];
    const ctrl = new StreamController<{ seed: number }>({
      source: (o) => source(o, 50),
      onBatch: (b) => seeds.push(...b.map((x) => x.seed)),
      onReset: () => {},
    });
    ctrl.restart(1);
    await tick(20);
    ctrl.restart(2); // supersede session 1
    await tick(120);
    // Once session 2 started, no more seed-1 batches should arrive.
    const lastSeed1 = seeds.lastIndexOf(1);
    const firstSeed2 = seeds.indexOf(2);
    expect(firstSeed2).toBeGreaterThan(-1);
    if (lastSeed1 > -1) expect(firstSeed2).toBeGreaterThan(lastSeed1);
    ctrl.dispose();
  });

  it("dispose stops the pump", async () => {
    const seen: number[] = [];
    const ctrl = new StreamController<{ i: number }>({
      source: (o) => source(o, 50),
      onBatch: (b) => seen.push(...b.map((x) => x.i)),
      onReset: () => {},
    });
    ctrl.restart(1);
    await tick(20);
    ctrl.dispose();
    const n = seen.length;
    await tick(120);
    expect(seen.length).toBe(n); // no batches after dispose
  });

  it("adaptive mode grows the batch size when onBatch is well under budget", async () => {
    const seenSizes: number[] = [];
    const ctrl = new StreamController<{ size: number }>({
      source: (o) => source(o, 50),
      onBatch: (b) => seenSizes.push(b[0]!.size), // trivial/instant work → under budget
      onReset: () => {},
    });
    ctrl.adaptive = true;
    ctrl.batchSize = 256; // seed
    ctrl.restart(1);
    await tick(120); // several batches
    ctrl.dispose();
    // Fast onBatch (dt < frameBudget) → batch grows (≤2× per step), bounded at 1e6.
    expect(ctrl.batchSize).toBeGreaterThan(256);
    expect(ctrl.batchSize).toBeLessThanOrEqual(1_000_000);
    // The source observed the growth live (later batches larger than the first).
    expect(seenSizes[seenSizes.length - 1]!).toBeGreaterThan(seenSizes[0]!);
  });

  it("non-adaptive mode keeps the batch size fixed", async () => {
    const seenSizes: number[] = [];
    const ctrl = new StreamController<{ size: number }>({
      source: (o) => source(o, 20),
      onBatch: (b) => seenSizes.push(b[0]!.size),
      onReset: () => {},
    });
    ctrl.adaptive = false;
    ctrl.batchSize = 100;
    ctrl.restart(1);
    await tick(80);
    ctrl.dispose();
    expect(ctrl.batchSize).toBe(100);
    expect(seenSizes.every((s) => s === 100)).toBe(true);
  });
});
