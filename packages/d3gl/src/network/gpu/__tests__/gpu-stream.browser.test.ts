/**
 * The streaming GPU run's contract at small N (#352, spec §6.5): `settled` only after the final tick's
 * positions were harvested, an explicit `frameEvery` caps `onFrame` to once per that many ticks, and a
 * layout that turns non-finite stops with one warning and keeps its last finite positions. The at-scale
 * per-frame guard is `gpu-stream-perf.browser.test.ts`; context loss is in `gpu-backend-integration`.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { startGpuLayout } from "../gpu-transport.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function ring(n: number): NetworkGraph {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
  }
  return buildGraph({ nodeCount: n, source, target });
}

describe("GPU streaming run (#352)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("settles only after the final tick's positions were harvested, and repaints them", async () => {
    const g = ring(300);
    const samples: GpuFrameSample[] = [];
    const unobserve = observeGpuLayoutFrames((s) => samples.push({ ...s }));
    let frames = 0;
    let framesAtSettle = -1;
    const handle = startGpuLayout(device, g, { width: 400, height: 300, iterations: 40 }, () => { frames++; });
    await handle.settled.then(() => { framesAtSettle = frames; });
    unobserve();
    const final = samples.findIndex((s) => s.harvestedTicks === 40);
    expect(final).toBeGreaterThanOrEqual(0);
    expect(samples[final]?.repaintMs).toBeGreaterThanOrEqual(0);
    // The final harvest was painted before settle resolved.
    expect(framesAtSettle).toBeGreaterThan(0);
    expect(samples.slice(final + 1).every((s) => !s.harvested)).toBe(true);
    for (let i = 0; i < 300 * 2; i++) expect(Number.isFinite(g.positions[i] ?? Number.NaN)).toBe(true);
    handle.stop();
  });

  it("an explicit frameEvery allows at most one onFrame per that many ticks", async () => {
    const g = ring(300);
    let frames = 0;
    const handle = startGpuLayout(device, g, { width: 400, height: 300, iterations: 60, frameEvery: 20 }, () => { frames++; });
    await handle.settled;
    expect(frames).toBeGreaterThanOrEqual(1);
    expect(frames).toBeLessThanOrEqual(60 / 20 + 1); // + the final harvest, which always paints
    handle.stop();
  });

  it("stops with one warning and keeps the last finite positions when the layout turns non-finite", async () => {
    const g = ring(300);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let frames = 0;
    const handle = startGpuLayout(device, g, { width: 400, height: 300, iterations: 100_000 }, () => { frames++; });
    try {
      for (let i = 0; i < 200 && frames < 2; i++) await nextFrame();
      expect(frames).toBeGreaterThanOrEqual(2);
      // Hold one node at NaN: the next tick's reductions (Σx, the box) go non-finite.
      handle.pin(Uint32Array.of(7), new Float32Array([Number.NaN, Number.NaN]));
      await handle.settled;
      const nonFinite = warn.mock.calls.filter((c) => String(c[0]).includes("non-finite"));
      expect(nonFinite).toHaveLength(1);
      for (let i = 0; i < 300 * 2; i++) expect(Number.isFinite(g.positions[i] ?? Number.NaN)).toBe(true);
      // The loop has stopped, and a later drag does not restart it.
      const after = frames;
      handle.pin(Uint32Array.of(1), new Float32Array([0, 0]));
      for (let i = 0; i < 10; i++) await nextFrame();
      expect(frames).toBe(after);
    } finally {
      warn.mockRestore();
      handle.stop();
    }
  });
});
