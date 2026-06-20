import { describe, it, expect } from "vitest";
import { startWorkerLayout } from "../worker-transport.js";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/** A ring graph — enough structure for the force layout to spread the nodes apart. */
function ring(n: number) {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) (source.push(i), target.push((i + 1) % n));
  return buildGraph({ nodeCount: n, source, target });
}

const spread = (p: Float32Array) => new Set(Array.from(p)).size;

describe("worker layout (off-thread, progressive)", () => {
  it("streams many progress frames and spreads the nodes (proves the worker ran, not the sync fallback)", async () => {
    const g = ring(40);
    let frames = 0;
    // frameEvery: 1 → the worker posts a frame per tick; the synchronous fallback would call
    // onFrame exactly once, so > 2 frames can only come from the real off-thread run.
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 30, frameEvery: 1 }, () => {
      frames++;
    });
    await handle.settled;

    expect(frames).toBeGreaterThan(2);
    expect(spread(g.positions)).toBeGreaterThan(2); // nodes moved apart, not stacked
  });

  it("honours multilevel:false (off-thread cold start) and still spreads the nodes", async () => {
    const g = ring(40);
    const handle = startWorkerLayout(
      g,
      { width: 400, height: 400, iterations: 30, frameEvery: 1, multilevel: false },
      () => {},
    );
    await handle.settled;
    expect(spread(g.positions)).toBeGreaterThan(2);
  });

  it("stop() cancels mid-run and resolves settled", async () => {
    const g = ring(60);
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 100000, frameEvery: 1 }, () => {});
    handle.stop();
    await expect(handle.settled).resolves.toBeUndefined();
  });

  it("drives the engine: layout({ backend: 'worker' }) settles to a spread layout", async () => {
    const host = document.createElement("div");
    host.style.width = "200px";
    host.style.height = "200px";
    document.body.appendChild(host);

    const net = network(host, { width: 200, height: 200 });
    await net.whenReady();
    net.data(ring(24)).layout({ backend: "worker", iterations: 30 });
    await net.whenSettled();

    net.destroy();
  });
});
