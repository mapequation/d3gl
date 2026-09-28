/**
 * Timing bench of the batched GPU nested layout at scale (#355, spec §13 stage 2: "a 1M-leaf nested timing
 * bench"). Report-only, and skipped unless a size is asked for — run it on a hardware-GL Chromium, where
 * the numbers mean something (SwiftShader measures the CPU):
 *
 *   PERF_BROWSER_N=1000000 pnpm --filter @mapequation/d3gl test:browser src/network/gpu/__tests__/gpu-nested-bench.browser.test.ts
 *
 * with the Playwright launch args `--enable-gpu --ignore-gpu-blocklist --use-angle=metal` (or the
 * platform's hardware ANGLE backend). On the synthetic Infomap-like map ({@link infomapLikeTree}) it logs:
 * the CPU prep, the construction, the GPU time of an organise tick, a compact tick and a composition (each
 * fenced by reading one texel of the texture its last pass wrote — `gl.finish` does not wait on ANGLE
 * Metal), and the wall clock of a cold streamed layout and a warm one-frame layout through the streaming
 * transport. It asserts only that both settle with finite positions.
 */
import { describe, expect, it } from "vitest";
import type { Device, Texture, TextureProps } from "@luma.gl/core";
import { buildGraph } from "../../graph.js";
import { infomapLikeTree } from "../../__tests__/nested-fixtures.js";
import { perfNOverride } from "../../../__tests__/perf-budget.js";
import { GpuNestedLayout } from "../gpu-nested-layout.js";
import { startGpuNestedLayout } from "../gpu-nested-transport.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { makeTestDevice } from "./_device.js";

const N = perfNOverride;

/** Read one texel of `layout`'s positions: every pass queued before it completes first. */
function fence(device: Device, layout: GpuNestedLayout): void {
  device.readPixelsToArrayWebGL(layout.positionFramebuffer, { sourceWidth: 1, sourceHeight: 1 });
}

/** Bytes per texel of the texture formats the nested solve allocates. */
const TEXEL_BYTES: Readonly<Record<string, number>> = {
  r32float: 4,
  r32uint: 4,
  r32sint: 4,
  rg32float: 8,
  rgba32float: 16,
  rgba32uint: 16,
};

/** Run `build`, summing the bytes of every texture it creates on `device` (all of its GPU memory but PBOs). */
function textureBytes<T>(device: Device, build: () => T): { value: T; bytes: number } {
  const create = device.createTexture.bind(device);
  let bytes = 0;
  device.createTexture = (props: TextureProps): Texture => {
    const texel = TEXEL_BYTES[props.format ?? "rgba8unorm"];
    if (texel === undefined) throw new Error(`gpu-nested-bench: no byte size for texture format ${props.format}`);
    bytes += (props.width ?? 1) * (props.height ?? 1) * texel;
    return create(props);
  };
  try {
    return { value: build(), bytes };
  } finally {
    device.createTexture = create;
  }
}

function allFinite(a: Float32Array): boolean {
  for (const v of a) if (!Number.isFinite(v)) return false;
  return true;
}

describe.skipIf(N === 0)(`GPU nested layout timing bench (#355), ${N} leaves`, () => {
  it("lays out a synthetic Infomap-like map cold and warm", async () => {
    const device = await makeTestDevice();
    const { topo, flow } = infomapLikeTree(N);
    const radius = 10 * Math.sqrt(N);

    let t0 = performance.now();
    const solver = nestedSolverTopology(topo, { size: flow, radius });
    const prepMs = performance.now() - t0;
    t0 = performance.now();
    const { value: layout, bytes } = textureBytes(device, () => new GpuNestedLayout(device, solver));
    fence(device, layout);
    const buildMs = performance.now() - t0;
    const pboBytes = layout.packed.width * layout.packed.height * 16; // the stream's readback PBO

    // GPU time per solve tick in each phase (a compact tick ends on the swap to the collided positions).
    const organise = Math.ceil(0.6 * solver.iterations);
    layout.runTicks(1);
    fence(device, layout);
    t0 = performance.now();
    layout.runTicks(10);
    fence(device, layout);
    const organiseMs = (performance.now() - t0) / 10;
    layout.runTicks(organise - layout.ticks);
    fence(device, layout);
    t0 = performance.now();
    layout.runTicks(10);
    fence(device, layout);
    const compactMs = (performance.now() - t0) / 10;
    t0 = performance.now();
    layout.prepareReadback();
    device.readPixelsToArrayWebGL(layout.packed.framebuffer, { sourceWidth: 1, sourceHeight: 1 });
    const composeMs = performance.now() - t0;
    layout.destroy();

    // Through the streaming transport, as `layout({ backend: "gpu", nested })` runs it (prep in a worker).
    const graph = buildGraph({ nodeCount: N, source: [], target: [] });
    let frames = 0;
    t0 = performance.now();
    await startGpuNestedLayout(device, graph, topo, { size: flow, radius }, () => frames++).settled;
    const coldMs = performance.now() - t0;
    const cold = graph.positions.slice(0, 2 * N);
    const landed: { positions: Float32Array | null } = { positions: null };
    t0 = performance.now();
    await startGpuNestedLayout(device, graph, topo, { size: flow, initial: cold }, () => {}, {
      onResult: (positions) => {
        landed.positions = positions;
      },
    }).settled;
    const warmMs = performance.now() - t0;

    console.log(
      `GPU nested bench, ${N} leaves (${solver.slotCount} slots, ${solver.segStart.length} segments, ` +
        `${solver.linkSource.length} links): prep ${prepMs.toFixed(0)} ms, construction ${buildMs.toFixed(0)} ms, ` +
        `GPU memory ${(bytes / 1e6).toFixed(1)} MB in textures + ${(pboBytes / 1e6).toFixed(1)} MB readback PBO; ` +
        `GPU per organise tick ${organiseMs.toFixed(2)} ms, per compact tick ${compactMs.toFixed(2)} ms, ` +
        `per composition ${composeMs.toFixed(2)} ms; streamed cold ${coldMs.toFixed(0)} ms (${frames} frames), ` +
        `warm ${warmMs.toFixed(0)} ms (one landing)`,
    );
    expect(allFinite(cold)).toBe(true);
    expect(landed.positions !== null && allFinite(landed.positions)).toBe(true);
  }, 600_000);
});
