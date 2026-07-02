/**
 * GPU drag-reheat parity (#183, N8.5).
 *
 * Mirrors the CPU `ForceLayout.setPinned` test (force.test.ts): a pinned node is held exactly where
 * the drag put it (skipped by integration, velocity zeroed) while the rest of the layout reflows
 * around it — and is released again on unpin. Two layers:
 *
 *   1. GpuForceLayout (deterministic): setPinned + setHeldPositions hold a node; runFrame reflows
 *      neighbours; releasing lets it integrate again. Plus the no-per-frame-alloc signature —
 *      the pinned-flag + held-position writes are sub-uploads into pre-created textures, so a
 *      pin/reheat sequence creates NO framebuffers/textures (AGENTS.md §5).
 *   2. startGpuLayout resumable loop (end-to-end): after convergence the layout is NOT destroyed —
 *      pin() resumes ticking (held node stays put, neighbours reflow), unpin() re-cools + releases.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { startGpuLayout } from "../gpu-transport.js";
import { buildGraph } from "../../graph.js";

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const dist = (out: Float32Array, a: number, b: number): number =>
  Math.hypot(out[a * 2]! - out[b * 2]!, out[a * 2 + 1]! - out[b * 2 + 1]!);

describe("GpuForceLayout pinned hold (#183)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("setPinned + setHeldPositions holds a node in place while a neighbour reflows toward it, releases on unpin", () => {
    // Connected pair far apart: attraction normally contracts BOTH. Pin node 0 and hold it at a
    // point OTHER than its seed (10, 5) → it must sit exactly there while node 1 is pulled toward it
    // (the held node anchors the spring). Exact all-pairs path (2 nodes < 4096), repulsion off.
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 100, 0]);
    const layout = new GpuForceLayout(device, g, { repulsion: 0, attraction: 0.1, centering: 0, alpha: 0.5, theta: 0.9 });

    const held = new Float32Array([10, 5]);
    layout.setPinned(Uint32Array.of(0));
    layout.setHeldPositions(Uint32Array.of(0), held);
    const startDist = Math.hypot(100 - 10, 0 - 5);

    layout.runFrame(60);
    const out = new Float32Array(4);
    layout.readPositions(out);

    // Node 0 held EXACTLY where the drag placed it (skipped by integration, o_pos = p forwarded each tick).
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(5);
    // Node 1 was pulled toward the held node 0 (reflow) — closer than at the start, not past it.
    expect(dist(out, 0, 1)).toBeLessThan(startDist);
    expect(out[2]!).toBeLessThan(100); // moved inward in x
    expect(out[2]!).toBeGreaterThan(10); // ...but not past the held node

    // Release: node 0 integrates again and gets pulled toward node 1 → it leaves the held point.
    layout.setPinned(null);
    layout.runFrame(20);
    layout.readPositions(out);
    expect(out[0]).not.toBe(10);

    layout.destroy();
  });

  it("a pin / reheat / unpin sequence creates no framebuffers or textures (sub-uploads into pre-created textures)", () => {
    // The pinned-flag texture is pre-created in the constructor; setPinned/setHeldPositions are 1×1
    // writeData sub-uploads, and reheat ticks reuse the pre-created FBOs — so ticking + dragging must
    // allocate nothing (AGENTS.md §5 "updated in place, not recreated per frame"). Larger N so the
    // signature holds beyond the trivial case.
    const N = 200;
    const src: number[] = [], tgt: number[] = [];
    for (let i = 1; i < N; i++) { src.push(0); tgt.push(i); } // hub star: node 0 connected to all
    const g = buildGraph({ nodeCount: N, source: src, target: tgt });
    for (let i = 0; i < N; i++) { g.positions[i * 2] = (i % 20) * 30; g.positions[i * 2 + 1] = ((i / 20) | 0) * 30; }
    const layout = new GpuForceLayout(device, g, { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.2, theta: 0.9 });

    layout.runFrame(3); // warm-up post-construction (rule out lazy init)

    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const texSpy = vi.spyOn(device, "createTexture");

    // Simulate several drag "moves": each pins node 0, holds it at a new cursor point, reheats a batch.
    const ids = Uint32Array.of(0);
    const held = new Float32Array(2);
    for (let f = 0; f < 5; f++) {
      held[0] = 300 + f * 10; held[1] = 300 + f * 10;
      layout.setPinned(ids);
      layout.setHeldPositions(ids, held);
      layout.runFrame(3);
      layout.readPositions(g.positions);
    }
    layout.setPinned(null);
    layout.runFrame(3);

    expect(fboSpy).toHaveBeenCalledTimes(0);
    expect(texSpy).toHaveBeenCalledTimes(0);

    fboSpy.mockRestore();
    texSpy.mockRestore();
    layout.destroy();
  });
});

describe("startGpuLayout resumable reheat loop (#183)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("does not destroy on convergence; pin() reflows neighbours while holding the node, unpin() releases it", async () => {
    // Hub star: node 0 connected to 1..5. Converge, then yank node 0 far away and pin it — its
    // neighbours feel the spring and reflow toward the new spot; node 0 itself stays pinned there.
    const g = buildGraph({ nodeCount: 6, source: [0, 0, 0, 0, 0], target: [1, 2, 3, 4, 5] });
    let frames = 0;
    const handle = startGpuLayout(device, g, { width: 400, height: 400, iterations: 80, frameEvery: 40 }, () => { frames++; });
    await handle.settled; // initial convergence — loop goes idle but keeps the layout ALIVE

    const settledPos = g.positions.slice();
    const framesAtSettle = frames;

    // Yank node 0 to a far point and pin it there.
    const heldX = settledPos[0]! + 600, heldY = settledPos[1]! + 600;
    handle.pin(Uint32Array.of(0), new Float32Array([heldX, heldY]));
    for (let i = 0; i < 8; i++) await nextFrame(); // let the drag loop reheat several batches

    // The loop resumed after convergence (proves it did NOT destroy the layout on settle).
    expect(frames).toBeGreaterThan(framesAtSettle);
    // Node 0 is held at the yank point (its texel copied forward each tick, streamed back each frame).
    expect(g.positions[0]!).toBeCloseTo(heldX, 1);
    expect(g.positions[1]!).toBeCloseTo(heldY, 1);
    // At least one neighbour reflowed toward the new node-0 position (moved from its settled spot).
    let neighbourMoved = false;
    for (let n = 1; n <= 5; n++) {
      if (Math.hypot(g.positions[n * 2]! - settledPos[n * 2]!, g.positions[n * 2 + 1]! - settledPos[n * 2 + 1]!) > 1) {
        neighbourMoved = true; break;
      }
    }
    expect(neighbourMoved).toBe(true);

    // Release: node 0 integrates again and is pulled back toward its neighbours (leaves the held point).
    handle.unpin();
    for (let i = 0; i < 8; i++) await nextFrame();
    expect(Math.hypot(g.positions[0]! - heldX, g.positions[1]! - heldY)).toBeGreaterThan(1);

    handle.stop();
  });
});
