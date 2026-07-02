/**
 * Integration test: `network.layout({ backend: "gpu" })` must take the real GPU path (not silently
 * fall back to the CPU worker) when the engine is created on a WebGL backend.
 *
 * This is the regression test for the bug where `gpuDevice()` returned null at layout() call time
 * because the luma.gl Device was created asynchronously — even on a `"webgl"` backend, `swapBackend`
 * is async — and the old code called `this.gpuDevice()` synchronously before `whenBackendSettled()`
 * resolved.
 *
 * Fix: `network.ts` now passes `this.whenBackendSettled().then(() => this.gpuDevice())` — a device
 * promise — to `startGpuLayout`, which waits for it before running the GPU or worker path.
 */

import { describe, it, expect, afterEach } from "vitest";
import { network } from "../../network.js";

const W = 400;
const H = 300;

/** Build a minimal 10-node ring graph for a lightweight layout run. */
function makeRingGraph() {
  const nodeCount = 10;
  const source = new Uint32Array(nodeCount);
  const target = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    source[i] = i;
    target[i] = (i + 1) % nodeCount;
  }
  return { nodeCount, source, target };
}

const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  document.body.appendChild(host);
  hosts.push(host);
  return host;
}

afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

describe("network layout backend:'gpu' integration", () => {
  it("GPU path is taken (layoutTransport === 'gpu') on a WebGL engine", async () => {
    const host = makeHost();
    // Create a real network engine on the webgl backend. swapBackend is async, so the
    // device is NOT ready immediately — this is exactly the scenario the bug triggered.
    const net = network(host, { width: W, height: H, backend: "webgl" });

    const { buildGraph } = await import("../../graph.js");
    const g = buildGraph(makeRingGraph());

    net.data(g).style({ nodeRadius: 4 }).layout({ backend: "gpu", iterations: 5 });

    // Wait for the layout to settle (the device promise must have resolved and either the
    // GPU loop or the worker fallback must have converged).
    await net.whenSettled();

    // The transport MUST be "gpu" — not "copy" (worker) or anything else.
    expect(net.layoutTransport).toBe("gpu");

    net.destroy();
  });

  it("falls back gracefully (no throw, layoutTransport !== 'gpu') on a Canvas engine", async () => {
    const host = makeHost();
    // Canvas backend has no WebGL device; the GPU layout should fall back to the worker.
    const net = network(host, { width: W, height: H, backend: "canvas" });

    const { buildGraph } = await import("../../graph.js");
    const g = buildGraph(makeRingGraph());

    let threw = false;
    try {
      net.data(g).style({ nodeRadius: 4 }).layout({ backend: "gpu", iterations: 5 });
      await net.whenSettled();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // Should have fallen back to worker — not gpu
    expect(net.layoutTransport).not.toBe("gpu");
    // And it should report some transport (not "none") — the fallback ran and settled
    expect(net.layoutTransport).not.toBe("none");

    net.destroy();
  });
});
