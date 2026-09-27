/**
 * The streaming GPU run's contract at small N (#352, spec §6.5): `settled` only after the final tick's
 * positions were harvested, an explicit `frameEvery` caps `onFrame` to once per that many ticks, and a
 * layout that turns non-finite stops with one warning and keeps its last finite positions — whether the
 * NaN came in through a drag's held positions or out of a tick's integrate, which a copy between ticks
 * catches by re-running the reductions. A drag's held positions are written at the start of a tick, never
 * mid-tick. The at-scale per-frame guard is `gpu-stream-perf.browser.test.ts`; context loss is in
 * `gpu-backend-integration`.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";
import { startGpuLayout } from "../gpu-transport.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { GpuStream, observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { DEFAULT_FORCE, seedPositions } from "../../force.js";

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

  /** A seeded solver over `g` and a stream over it, built directly (not through the transport). */
  function streamOver(g: NetworkGraph, iterations: number, onFrame: () => void): { layout: GpuForceLayout; stream: GpuStream } {
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    seedPositions(g, 400, 300, { force: DEFAULT_FORCE });
    const layout = new GpuForceLayout(device, g, DEFAULT_FORCE);
    layout.hold(1);
    return { layout, stream: new GpuStream(device, layout, g, { iterations }, onFrame) };
  }

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

  it("an engine repaint that throws is reported as uncaught and does not wedge the layout's loop", async () => {
    const g = ring(300);
    const reported = vi.spyOn(globalThis, "reportError").mockImplementation(() => {});
    let calls = 0;
    const handle = startGpuLayout(device, g, { width: 400, height: 300, iterations: 40 }, () => {
      if (++calls === 1) throw new Error("a style accessor threw");
    });
    try {
      await handle.settled; // a wedged loop never settles
      expect(reported).toHaveBeenCalledTimes(1);
      expect(calls, "the layout stopped repainting after the exception").toBeGreaterThan(1);
    } finally {
      reported.mockRestore();
      handle.stop();
    }
  });

  it("refuses positions that went non-finite in a tick's integrate: a copy between ticks re-runs the reductions", async () => {
    const g = ring(300);
    let frames = 0;
    // One tick: its final copy goes out right after the integrate, whose prep reduced the (finite) seed.
    const { layout, stream } = streamOver(g, 1, () => { frames++; });
    const seed = g.positions.slice();
    const integrate = layout.integrate.bind(layout);
    vi.spyOn(layout, "integrate").mockImplementation(() => {
      integrate();
      // Stands in for an integrate that overflowed: the new positions hold a NaN its prep never saw.
      layout.setHeldPositions(Uint32Array.of(7), new Float32Array([Number.NaN, Number.NaN]));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stream.start();
      await stream.settled;
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("non-finite"))).toHaveLength(1);
      expect(frames, "non-finite positions were painted").toBe(0);
      expect(Array.from(g.positions), "the harvest overwrote the last finite positions").toEqual(Array.from(seed));
    } finally {
      warn.mockRestore();
      stream.stop();
    }
  });

  it("writes a drag's held positions at the start of a tick, never mid-tick", async () => {
    const g = ring(300);
    const { layout, stream } = streamOver(g, 100_000, () => {});
    const calls: string[] = [];
    const beginTick = layout.beginTick.bind(layout);
    vi.spyOn(layout, "beginTick").mockImplementation(() => { calls.push("P"); beginTick(); });
    const forceBand = layout.forceBand.bind(layout);
    vi.spyOn(layout, "forceBand").mockImplementation((band, bands) => { calls.push("F"); forceBand(band, bands); });
    const integrate = layout.integrate.bind(layout);
    vi.spyOn(layout, "integrate").mockImplementation(() => { calls.push("I"); integrate(); });
    const setHeld = layout.setHeldPositions.bind(layout);
    vi.spyOn(layout, "setHeldPositions").mockImplementation((ids, positions) => { calls.push("H"); setHeld(ids, positions); });
    try {
      stream.start();
      const held = new Float32Array(2);
      for (let f = 0; f < 16; f++) {
        held[0] = f;
        held[1] = -f;
        stream.pin(Uint32Array.of(3), held);
        calls.push("pin");
        await nextFrame();
      }
      // Not vacuous: some pins arrived mid-tick (after a prep or a band, before the integrate).
      const midTick = calls.filter((c, i) => {
        const last = calls.slice(0, i).filter((x) => x !== "pin" && x !== "H").pop();
        return c === "pin" && (last === "P" || last === "F");
      });
      expect(midTick.length).toBeGreaterThan(0);
      const writes = calls.flatMap((c, i) => (c === "H" ? [calls[i + 1]] : []));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((next) => next === "P"), `held positions written mid-tick: ${calls.join(" ")}`).toBe(true);
    } finally {
      stream.stop();
    }
  });

  it("keeps a drag that starts and ends while the run finishes: the GPU learns the drop, the harvest keeps it", async () => {
    // The window: after the final integrate, before the final harvest — no prep of the run is left to
    // write the held positions, so the drag must carry on as a reheat that does.
    const g = ring(300);
    const iterations = 30;
    let samples = 0;
    let dropped = false;
    const { layout, stream } = streamOver(g, iterations, () => {});
    const writes: [number, number][] = [];
    const setHeld = layout.setHeldPositions.bind(layout);
    vi.spyOn(layout, "setHeldPositions").mockImplementation((ids, positions) => {
      if (ids[0] === 3) writes.push([positions[0] ?? Number.NaN, positions[1] ?? Number.NaN]);
      setHeld(ids, positions);
    });
    let before: [number, number] = [0, 0];
    const drop = new Float32Array(2);
    const unobserve = observeGpuLayoutFrames((s) => {
      samples++;
      if (dropped || s.ticksDone < iterations) return;
      dropped = true;
      queueMicrotask(() => {
        // What the engine's drag does: hold the node under the cursor in graph.positions, pin it, release.
        before = [g.positions[6] ?? 0, g.positions[7] ?? 0];
        drop[0] = before[0] + 50;
        drop[1] = before[1] - 50;
        g.positions[6] = drop[0];
        g.positions[7] = drop[1];
        stream.pin(Uint32Array.of(3), drop);
        stream.unpin();
      });
    });
    try {
      stream.start();
      await stream.settled;
      // Let the loop go idle: no streamed frame for 5 animation frames.
      for (let i = 0, quiet = 0, last = samples; i < 2000 && quiet < 5; i++) {
        await nextFrame();
        quiet = samples === last ? quiet + 1 : 0;
        last = samples;
      }
      expect(dropped).toBe(true);
      expect(writes, "the drop position never reached the GPU").toContainEqual([drop[0], drop[1]]);
      const gpu = new Float32Array(g.positions.length);
      layout.readPositions(gpu);
      expect(Array.from(g.positions), "the last harvest does not show what the GPU holds").toEqual(Array.from(gpu));
      expect([g.positions[6], g.positions[7]], "the dropped node snapped back").not.toEqual(before);
    } finally {
      unobserve();
      stream.stop();
    }
  });
});
