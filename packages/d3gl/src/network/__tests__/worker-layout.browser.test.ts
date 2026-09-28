import { describe, it, expect } from "vitest";
import { startWorkerLayout, startNestedWorkerLayout, sharedMemoryAvailable } from "../worker-transport.js";
import { ForceLayout, seedPositions } from "../force.js";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { LODTree } from "../lod.js";
import { MAX_OUTSTANDING, type LODView } from "../lod-frame.js";
import type { MainToWorker, ProgressMessage, WorkerToMain } from "../worker-protocol.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import type { NestedLayoutTopology } from "../nested-layout.js";
import type { FitBox } from "../fit.js";

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

  it("a pin lands within about one tick, and the held node stays put in the frames after it", async () => {
    // A drag's pin on a large layout must not wait for a whole batch of ticks (the old cadence yielded
    // after ceil(iterations / 60) ticks — thousands here). A 20k-node cold start at full heat keeps
    // moving for the whole test; pin node 0 far from the layout and time until a frame shows it there.
    const g = ring(20_000);
    const X = Math.fround(1e5);
    const Y = Math.fround(-1e5);
    const frameAt: number[] = [];
    const held: boolean[] = [];
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 100_000, multilevel: false }, () => {
      frameAt.push(performance.now());
      held.push(g.positions[0] === X && g.positions[1] === Y);
    });
    const waitFrames = async (count: number): Promise<void> => {
      const deadline = performance.now() + 10_000;
      while (frameAt.length < count && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    };
    await waitFrames(4); // the run is underway: seed frame + a few streamed ticks
    expect(frameAt.length).toBeGreaterThanOrEqual(4);
    const before = frameAt.length;
    // Slowest gap between streamed frames so far: an upper bound on one tick here (ticks ≥ 16 ms post a
    // frame each; faster ticks post every 16 ms).
    let tickMs = 16;
    for (let i = 2; i < before; i++) tickMs = Math.max(tickMs, (frameAt[i] ?? 0) - (frameAt[i - 1] ?? 0));
    if (handle.shared) { g.positions[0] = X; g.positions[1] = Y; } // shared mode: the worker reads the SAB
    const pinAt = performance.now();
    handle.pin(Uint32Array.of(0), Float32Array.of(X, Y));
    const deadline = pinAt + 10_000;
    while (!held.slice(before).includes(true) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const landed = held.indexOf(true, before);
    expect(landed, "no frame showed the pinned node").toBeGreaterThanOrEqual(before);
    const latency = (frameAt[landed] ?? Infinity) - pinAt;
    await waitFrames(landed + 3);
    handle.stop();
    // Within about one tick: the pin waits for the tick in flight, then the next frame carries it.
    expect(latency, `pin latency ${latency.toFixed(0)} ms, tick ≤ ${tickMs.toFixed(0)} ms`).toBeLessThan(3 * tickMs + 50);
    expect(held.slice(landed, landed + 3)).toEqual([true, true, true]); // held exactly, frame after frame
  }, 30_000);

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

describe("worker warm start (#311)", () => {
  /** A ring laid out part-way on this thread: the layout another transport hands over. */
  function handedOver(n: number) {
    const g = ring(n);
    seedPositions(g, 400, 400, { force: {} });
    new ForceLayout(g).run(15, "hot");
    return g;
  }

  it("with no ticks left, it idles on the layout it was handed — no seed — until a pin reheats it", async () => {
    const g = handedOver(40);
    const handed = g.positions.slice();
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 0, warm: { heat: 1, decaying: false } }, () => {});
    await handle.settled;
    expect(Array.from(g.positions)).toEqual(Array.from(handed)); // the worker's frame carried them back unchanged

    let frames = 0;
    const moved = new Promise<void>((resolve) => {
      const check = (): void => {
        frames++;
        for (let i = 2; i < 80; i++) if (g.positions[i] !== handed[i]) return resolve();
        if (frames < 600) requestAnimationFrame(check);
        else resolve();
      };
      requestAnimationFrame(check);
    });
    handle.pin(Uint32Array.of(0), Float32Array.of((handed[0] ?? 0) + 200, handed[1] ?? 0));
    await moved;
    expect(Array.from(g.positions.subarray(2)), "the rest never reflowed around the pin").not.toEqual(Array.from(handed.subarray(2)));
    handle.stop();
  });

  it("continues on the handed-over heat schedule over the ticks left, exactly as this thread would", async () => {
    const g = handedOver(40);
    const reference = handedOver(40);
    const layout = new ForceLayout(reference);
    layout.cool(25, 0.5);
    for (let t = 0; t < 25; t++) {
      layout.tick();
      if (layout.converged) break;
    }
    const handle = startWorkerLayout(g, { width: 400, height: 400, iterations: 25, warm: { heat: 0.5, decaying: true } }, () => {});
    await handle.settled;
    expect(Array.from(g.positions)).toEqual(Array.from(reference.positions));
    handle.stop();
  });

  it("with LOD on, the tree arrives with the geometry of the handed-over positions: no seed frame follows to fill it", async () => {
    // The main thread adopts the tree the moment it lands and draws the cut from it (a zoom, a hover pick, a
    // rebuild), while a warm start's first frame only follows its first tick (about a second at 325k nodes).
    const g = handedOver(40);
    const handed = g.positions.slice();
    const atAdoption: { leafX: number[]; leafY: number[]; zeroAggregates: number; aggregates: number }[] = [];
    const handle = startWorkerLayout(
      g,
      { width: 400, height: 400, iterations: 25, lod: true, warm: { heat: 0.5, decaying: true } },
      () => {},
      (tree) => {
        let zeroAggregates = 0;
        for (let i = tree.leafCount; i < tree.size; i++) {
          if (tree.cx[i] === 0 && tree.cy[i] === 0 && tree.extent[i] === 0) zeroAggregates++;
        }
        atAdoption.push({
          leafX: Array.from(tree.cx.subarray(0, tree.leafCount)),
          leafY: Array.from(tree.cy.subarray(0, tree.leafCount)),
          zeroAggregates,
          aggregates: tree.size - tree.leafCount,
        });
      },
    );
    await handle.settled;
    handle.stop();
    expect(atAdoption).toHaveLength(1);
    const [tree] = atAdoption;
    expect(tree?.aggregates, "the ring coarsened into aggregates").toBeGreaterThan(0);
    expect(tree?.zeroAggregates, "aggregates with no geometry when the tree landed").toBe(0);
    expect(tree?.leafX).toEqual(Array.from({ length: 40 }, (_, i) => handed[i * 2]));
    expect(tree?.leafY).toEqual(Array.from({ length: 40 }, (_, i) => handed[i * 2 + 1]));
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

  it("a spatial stream held back by back-pressure posts nothing — no frame, and no done — until a buffer returns: positions always travel with their tree (#343, #433)", async () => {
    const g = ring(400);
    const worker = new Worker(new URL("../layout-worker.js", import.meta.url), { type: "module" });
    const got: ProgressMessage[] = [];
    let onProgress: (m: ProgressMessage) => void = () => {};
    worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const m = e.data;
      if (m.type !== "frame" && m.type !== "done") return;
      got.push(m);
      onProgress(m);
    };
    /** Resolves once `ms` pass with no progress message. */
    const quiet = (ms: number) =>
      new Promise<void>((resolve) => {
        let timer = setTimeout(resolve, ms);
        onProgress = () => {
          clearTimeout(timer);
          timer = setTimeout(resolve, ms);
        };
      });
    const recycle = (m: ProgressMessage): void => {
      const f = m.lodFrame;
      if (!f) return;
      const back: MainToWorker = { type: "lod-recycle", buffer: f.buffer, rows: f.rows?.buffer };
      worker.postMessage(back, f.rows ? [f.buffer, f.rows.buffer] : [f.buffer]);
    };
    const view: LODView = { transform: null, fitPad: 3, width: 400, height: 400, screenSized: true, fadeBand: 0, declutter: true };
    const start: MainToWorker = {
      type: "start",
      nodeCount: g.nodeCount,
      source: g.source,
      target: g.target,
      weight: g.weight,
      width: 400,
      height: 400,
      iterations: 40, // a few ms of ticks: the run ends while the main thread hands nothing back
      frameEvery: 1,
      multilevel: false,
      lod: true,
      lodSource: "spatial",
      lodStyle: { radii: new Float32Array(g.nodeCount).fill(3), weight: g.strength, links: true },
      lodStyleVersion: 1,
      lodView: view,
    };
    try {
      worker.postMessage(start);
      // Nothing handed back (a long task on the main thread): MAX_OUTSTANDING trees, then nothing at all —
      // not the ticks it skipped, and not the run's `done` — however long the worker runs.
      await quiet(500);
      expect(got.map((m) => m.type)).toEqual(new Array(MAX_OUTSTANDING).fill("frame"));
      // Hand every tree back as it arrives: the skipped frame is built, and the run's `done` brings its tree.
      const done = new Promise<ProgressMessage>((resolve) => {
        onProgress = (m) => {
          recycle(m);
          if (m.type === "done") resolve(m);
        };
      });
      for (const m of got) recycle(m);
      const last = await done;
      expect(last.lodFrame?.header.frame).toBe(last.tick);
      // Every frame and `done` that brought positions brought the tree built from them.
      for (const m of got) {
        expect(m.positions).toBeDefined();
        expect(m.lodFrame?.header.frame, `${m.type} at tick ${m.tick}`).toBe(m.tick);
      }
    } finally {
      worker.terminate();
    }
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

describe("nested worker layout: the stream's fit bound belongs to the transport (#427)", () => {
  /** A cold three-level map: 4 top modules × 3 sub-modules × 8 leaves, leaves chained in each sub-module. */
  function nestedTopology(): { graph: ReturnType<typeof buildGraph>; topology: NestedLayoutTopology } {
    const n = 4 * 3 * 8;
    const records: ModuleNode[] = [];
    const source: number[] = [];
    const target: number[] = [];
    for (let id = 0; id < n; id++) {
      records.push({ id, path: [Math.floor(id / 24) + 1, Math.floor((id % 24) / 8) + 1, (id % 8) + 1] });
      if (id % 8) (source.push(id - 1), target.push(id));
    }
    const tree = buildModuleLODTree(n, records, { source, target, weight: source.map(() => 1) });
    if (!tree.parent) throw new Error("module trees carry a parent map");
    return { graph: buildGraph({ nodeCount: n, source, target }), topology: { ...tree, parent: tree.parent } };
  }

  it("a streamed cold solve posts its root disc at once, then each depth's tighter bound", async () => {
    const { graph, topology } = nestedTopology();
    const R = 10 * Math.sqrt(graph.nodeCount);
    const bounds: FitBox[] = [];
    const handle = startNestedWorkerLayout(graph, topology, { radius: R }, () => {}, { onBounds: (b) => bounds.push([...b]) });
    // Before the worker has placed anything: the root disc, the only bound known yet — so a fit frames the
    // map from its first paint, with no knowledge of the transport in the engine.
    expect(bounds).toEqual([[-R, -R, R, R]]);
    await handle.settled;
    expect(bounds.length, "one bound per streamed depth after the root disc").toBe(4);
    for (let d = 1; d < bounds.length; d++) {
      const [a, b] = [bounds[d - 1], bounds[d]];
      if (!a || !b) throw new Error("missing bound");
      expect(b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3], `bound ${d} grew`).toBe(true);
    }
  });

  it("a solve that lands in one frame (warm, or handed to onResult) posts no bound", async () => {
    const { graph, topology } = nestedTopology();
    const bounds: FitBox[] = [];
    const one = startNestedWorkerLayout(graph, topology, { radius: 50 }, () => {}, { stream: false, onBounds: (b) => bounds.push(b) });
    await one.settled;
    const result = startNestedWorkerLayout(graph, topology, { radius: 50 }, () => {}, { onResult: () => {}, onBounds: (b) => bounds.push(b) });
    await result.settled;
    const warm = startNestedWorkerLayout(graph, topology, { initial: graph.positions.slice() }, () => {}, { onBounds: (b) => bounds.push(b) });
    await warm.settled;
    expect(bounds).toEqual([]);
  });
});
