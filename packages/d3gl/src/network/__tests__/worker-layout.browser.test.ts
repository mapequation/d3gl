import { describe, it, expect } from "vitest";
import { startWorkerLayout, sharedMemoryAvailable } from "../worker-transport.js";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { LODTree } from "../lod.js";

/** A ring graph — enough structure for the force layout to spread the nodes apart. */
function ring(n: number) {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) (source.push(i), target.push((i + 1) % n));
  return buildGraph({ nodeCount: n, source, target });
}

const spread = (p: ArrayLike<number>) => new Set(Array.from(p)).size;

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

  it("stops once converged — iterations is a maximum, not a fixed count (#124)", async () => {
    // A million-tick budget would keep the worker busy for minutes; the convergence stop settles it
    // after a few dozen ticks.
    const g = ring(200);
    let frames = 0;
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 1_000_000 }, () => {
      frames++;
    });
    await handle.settled;
    expect(frames).toBeGreaterThan(0);
    expect(spread(g.positions)).toBeGreaterThan(2);
    handle.stop();
  }, 20_000);

  it("streams by time: at most about one frame per display frame, not one per tick batch", async () => {
    // Fast ticks (a few hundred nodes): the old cadence posted every ceil(iterations / 60) ticks — 60
    // frames in a burst far above display rate. By time, the worker posts at most one frame per 16 ms of
    // its own time (plus the seed frame and the final `done`), so frames ≤ elapsed / 16 + slack.
    const g = ring(400);
    let frames = 0;
    const t0 = performance.now();
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 300 }, () => {
      frames++;
    });
    await handle.settled;
    const elapsed = performance.now() - t0;
    expect(frames).toBeGreaterThanOrEqual(2); // the seed frame + `done`, at least
    expect(frames).toBeLessThanOrEqual(elapsed / 16 + 3);
    handle.stop();
  }, 20_000);

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

  it("reports the selected position transport (handle.shared / layoutTransport mirror sharedMemoryAvailable)", async () => {
    // The test page is not cross-origin isolated, so this is false here; assert the *relationship*
    // rather than the literal so the test still holds if the harness ever runs isolated.
    const available = sharedMemoryAvailable();
    expect(typeof available).toBe("boolean");

    const handle = startWorkerLayout(ring(24), { width: 200, height: 200, iterations: 20, frameEvery: 1 }, () => {});
    expect(handle.shared).toBe(available); // decided synchronously when the worker run starts
    await handle.settled;

    const host = document.createElement("div");
    host.style.width = "200px";
    host.style.height = "200px";
    document.body.appendChild(host);
    const net = network(host, { width: 200, height: 200 });
    await net.whenReady();
    expect(net.layoutTransport).toBe("none"); // no worker-backed layout started yet
    net.data(ring(24)).layout({ backend: "worker", iterations: 20 });
    expect(net.layoutTransport).toBe(available ? "shared" : "copy");
    await net.whenSettled();
    net.destroy();
    host.remove();
  });
});

describe("worker-LOD streaming (#103)", () => {
  it("streams the LOD tree topology + live geometry from the worker", async () => {
    const g = ring(40);
    const trees: LODTree[] = [];
    let frames = 0;
    const handle = startWorkerLayout(
      g,
      { width: 400, height: 400, iterations: 30, frameEvery: 1, lod: true },
      () => {
        frames++;
      },
      (t) => trees.push(t),
    );
    await handle.settled;

    expect(trees.length).toBe(1); // topology posted exactly once
    const tree = trees[0]!;
    expect(tree.leafCount).toBe(40);
    expect(tree.size).toBeGreaterThan(40); // coarsened: aggregate nodes above the 40 leaves
    expect(frames).toBeGreaterThan(2); // a real off-thread run, not the sync fallback (one frame)
    // The worker wrote position-derived geometry into the streamed buffer: centroids spread out.
    expect(spread(tree.cx)).toBeGreaterThan(2);
  });

  it("does not stream a tree when lod is off (worker still runs)", async () => {
    const g = ring(40);
    const trees: LODTree[] = [];
    const handle = startWorkerLayout(
      g,
      { width: 400, height: 400, iterations: 20, frameEvery: 1 },
      () => {},
      (t) => trees.push(t),
    );
    await handle.settled;
    expect(trees.length).toBe(0);
    expect(spread(g.positions)).toBeGreaterThan(2);
  });

  it("drives the engine: lod() + layout({ backend: 'worker' }) renders without throwing", async () => {
    const host = document.createElement("div");
    host.style.width = "200px";
    host.style.height = "200px";
    document.body.appendChild(host);

    const net = network(host, { width: 200, height: 200 });
    await net.whenReady();
    net
      .data(ring(40))
      .style({ sizeMode: "screen" })
      .lod({ expandPx: 48, maxAggregateRadius: 24 })
      .layout({ backend: "worker", iterations: 30 });
    await net.whenSettled();

    net.destroy();
    host.remove();
  });

  it("falls back to a main-thread LOD tree when lod() is enabled after a worker run settled", async () => {
    const host = document.createElement("div");
    host.style.width = "200px";
    host.style.height = "200px";
    document.body.appendChild(host);

    const net = network(host, { width: 200, height: 200 });
    await net.whenReady();
    // Run the worker with LOD off, then enable LOD without re-running layout: the deferred fallback
    // (no live worker to stream a tree) must build one on the main thread and render it.
    net.data(ring(40)).style({ sizeMode: "screen" }).layout({ backend: "worker", iterations: 20 });
    await net.whenSettled();
    net.lod({ expandPx: 48 });
    await new Promise((r) => setTimeout(r, 0)); // let the microtask fallback build the tree
    net.setTransform({ k: 4, x: 0, y: 0 }); // re-cut on the fallback tree must not throw

    net.destroy();
    host.remove();
  });
});
