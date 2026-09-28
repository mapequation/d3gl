/**
 * The GPU nested layout's per-frame guard (#355, AGENTS §5), through the real trigger:
 * `network().data(g, { modules }).lod(…).layout({ backend: "gpu", nested: true })`, real animation frames,
 * one engine for both reduction states (LOD off, then LOD on over the module tree).
 *
 * A cold nested layout streams as one animation of all depths: each frame polls fences, harvests a
 * composed copy the GPU finished earlier (leaf positions and module discs, packed in node order),
 * repaints (throttled), and encodes a budgeted slice of stream ticks — the organise ticks' repulsion and
 * the compact ticks' collision gathers cut into row bands. Pinned here:
 *
 * - **Transport-only main thread per frame** (fence polls + harvest + encode + copy + fence, the repaint
 *   excluded) below a ceiling split into constant and linear terms, and the encode within the
 *   controller's 2 ms cap (N-independent).
 * - **Repaints** at least `minFrameMs` apart (the throttle), and **throughput**: stream ticks per second
 *   above a floor set by the same solve's GPU-only rate on this machine — the one check that sees a
 *   GPU-process stall (a harvest that waits on the GPU does not show in main-thread time).
 * - **Deterministic signatures:** every `readPixels` on the streaming path lands in a bound PBO; every
 *   harvest comes after a fence inserted after its copy was seen signalled; one fence per frame; the
 *   harvest precedes the frame's layout draws; no GPU object created per streamed frame once the stream
 *   runs; `settled` only after the final stream tick's positions were harvested.
 * - **Per tick:** a solve tick allocates nothing, and a compact collision step draws exactly one count
 *   scatter and K round scatters per hash table (the class cells', {@link COLLISION_ROUNDS}; the sub-cells',
 *   {@link COLLISION_SUB_ROUNDS}) of the binned slots (the radius-class grid's fixed passes), never a draw
 *   of N points into a 1×1 viewport (#349). Every work item that encodes a pass submits once, after its
 *   passes, a readback copy too, and no pass only clears (#402): the force clear is the repulsion band's and
 *   the springs' own. Through the real trigger the stream legs count the submits per item and per copy.
 * - **A module of very uneven child sizes** (#380; a single-scale grid made its gather quadratic, 157 ms
 *   frames at 60,000 children): the same per-frame bounds and signatures through the real trigger (in
 *   `gpu-nested-zipf-perf.browser.test.ts`, a file of its own for the tier's 300 s per file), a
 *   collision step's pair work within 3× of the collision plan's estimate with no slot on the exact
 *   fallback, and the gather cut into bands of equal estimated work (the frame budget admits a band by its
 *   share of the estimate; bands of equal rows put the big module's work in the first).
 *
 * The **warm re-layout with a transition** on `"auto"` (#375) has its own file,
 * `gpu-nested-warm-perf.browser.test.ts`, as the Zipf module's stream has.
 *
 * A node drag and a zoom sweep while the nested solve runs have their own guard,
 * `gpu-nested-interaction-perf.browser.test.ts`. The fixtures, the GL call log, the stream leg and the
 * per-frame timer are `_nested-perf.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Device } from "@luma.gl/core";
import { network, type Network } from "../../network.js";
import type { NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import { GpuNestedLayout, nestedLayoutPlan } from "../gpu-nested-layout.js";
import { COLLISION_ROUNDS, COLLISION_SUB_ROUNDS } from "../passes/collision.js";
import { makeTestDevice } from "./_device.js";
import { recordItems, type ItemRecord } from "./_item-recorder.js";
import { AsyncPositionReadback } from "../async-readback.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import {
  GlCallLog,
  H,
  ITERATIONS,
  N,
  W,
  ZIPF_BIG,
  assertSignatures,
  gpuOnlyRate,
  infomapLike,
  median,
  quantile,
  report,
  solverOf,
  streamLeg,
  zipfLike,
} from "./_nested-perf.js";

describe("GPU nested layout per frame (#355) — network().layout({ backend: 'gpu', nested })", () => {
  let host: HTMLElement;
  let net: Network;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let gpuOnlyTicksPerSec = 0;

  beforeAll(async () => {
    fixture = infomapLike(N);
    gpuOnlyTicksPerSec = await gpuOnlyRate(fixture);
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // Warm-up on the same engine: the capability probe, shader compiles and the lane programs.
    const warm = infomapLike(2_000);
    net.data(warm.graph, { modules: warm.modules }).layout({ backend: "gpu", nested: { iterations: 5 } });
    await net.whenSettled();
  }, perfBudget(120_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  // The transport's own main-thread work per frame is fence polls, a memcpy of 8 B per leaf (+ 16 B per
  // module, about 0.4 B per leaf here) on harvest frames and at most 2 ms of encode: the flat guard's
  // ceiling, whose linear term is per 100k nodes (measured at 20k leaves on SwiftShader: p95 2.0 ms, max
  // 2.6 ms, against 4.4 ms). A synchronous read in the frame waits for every queued stream tick.
  const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / 100_000));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

  it("LOD off: bounded transport main thread, the async readback signatures, throughput", async () => {
    const leg = await streamLeg(net, fixture.graph, fixture.modules, false);
    const { transport, encode, ticksPerSec } = report("LOD off", leg);
    console.log(`  GPU-only nested solve: ${gpuOnlyTicksPerSec.toFixed(1)} stream ticks/s`);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    // The layout gets ≤ 60% of each frame's GPU time and the repaints share the main thread: a quarter of
    // that share of the GPU-only rate is a floor a working stream clears with room to spare (the flat guard's).
    expect(ticksPerSec).toBeGreaterThan(0.25 * gpuOnlyTicksPerSec * 0.6);
  }, perfBudget(300_000));

  it("LOD on (the module tree, declutter): the same transport bounds and signatures", async () => {
    const leg = await streamLeg(net, fixture.graph, fixture.modules, true);
    const { transport, encode } = report("LOD on", leg);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
  }, perfBudget(300_000));
});

describe("GPU nested solve per tick (#355, #380)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("allocates nothing per tick or per readback, and a collision step draws its fixed scatters", () => {
    // A Zipf module, so the radius-class grid bins slots (an even map's small modules take the exact loop).
    const solver = solverOf(zipfLike(Math.min(N, 20_000)), 10);
    const binned = solver.collision.binnedSlots.length;
    expect(binned).toBeGreaterThan(0);
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    const log = new GlCallLog();
    try {
      layout.runTicks(6); // organise
      layout.prepareReadback();
      const organiseCreates = log.events.filter((e) => e.kind === "create").length;
      const before = log.events.length;
      layout.beginTick(); // compact, collision step 1: its cells, then each table's counts and rounds
      layout.forceBand(0, 3);
      layout.forceBand(1, 3);
      layout.forceBand(2, 3);
      layout.integrate();
      const step = log.events.slice(before).filter((e) => e.kind === "layout-draw" && e.points);
      layout.runTicks(3);
      layout.prepareReadback();
      expect(organiseCreates, "GPU objects created by organise ticks or a readback").toBe(0);
      expect(log.events.filter((e) => e.kind === "create").length, "GPU objects created by compact ticks").toBe(0);
      // Per table one count scatter and its rounds, each over the binned slots: the grid's fixed pass count.
      expect(step.length).toBe(2 + COLLISION_ROUNDS + COLLISION_SUB_ROUNDS);
      expect(step.every((e) => e.kind === "layout-draw" && e.count === binned)).toBe(true);
      expect(log.events.some((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= solver.slotCount)).toBe(false);
    } finally {
      log.restore();
      layout.destroy();
    }
  });
});

describe("GPU nested solve work items (#402)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it.each([
    ["an Infomap-shaped map", () => solverOf(infomapLike(Math.min(N, 50_000)), 10)],
    ["a Zipf module (binned slots)", () => solverOf(zipfLike(Math.min(N, 20_000)), 10)],
  ] as const)("every work item submits once, after its passes, a copy too, and no pass only clears: %s", (_label, make) => {
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(make()));
    const readback = new AsyncPositionReadback(device, layout);
    const rec = recordItems(device);
    const items: { phase: string; item: string; record: ItemRecord }[] = [];
    const tick = (phase: string): void => {
      items.push({ phase, item: "P", record: rec.record(() => layout.beginTick()) });
      for (let b = 0; b < 3; b++) items.push({ phase, item: `F_${b}`, record: rec.record(() => layout.forceBand(b, 3)) });
      items.push({ phase, item: "I", record: rec.record(() => layout.integrate()) });
    };
    let copy: ItemRecord;
    try {
      layout.runTicks(1); // warm-up
      tick("organise");
      tick("organise");
      layout.runTicks(4); // past the 6 organise ticks of 10: the stream ticks below are collision steps
      for (let s = 0; s < 4; s++) tick(`compact, step ${(s % 2) + 1}`);
      copy = rec.record(() => {
        layout.prepareReadback();
        readback.issue(layout);
      });
    } finally {
      rec.restore();
      readback.abandon();
      readback.destroy();
      layout.destroy();
    }
    expect(copy.submits).toBe(1);
    expect(copy.clearOnly).toBe(0);
    expect(copy.passes).toBeGreaterThan(3); // two reductions and the composition
    // An item submits once if it encodes a pass (the compact swap, and a gather band without rows, encode
    // none), and every pass draws.
    const wrong = items.filter(({ record }) => record.submits !== (record.passes > 0 ? 1 : 0) || record.clearOnly !== 0);
    expect(wrong).toEqual([]);
    const passes = (phase: string, item: string): number[] =>
      items.filter((i) => i.phase === phase && i.item === item).map((i) => i.record.passes);
    // Organise: a band is one pass (its clear, then the repulsion); I is the predict, the springs (their
    // clear) and the integrate, plus a hub chunk pass on a map with hub rows.
    expect(passes("organise", "F_1")).toEqual([1, 1]);
    for (const n of passes("organise", "I")) expect([3, 4]).toContain(n);
    // Compact: P always encodes (the reductions, the cells); the swap nothing.
    for (const n of passes("compact, step 2", "P")) expect(n).toBeGreaterThan(3);
    expect(passes("compact, step 2", "I")).toEqual([0, 0]);
  });
});

describe("GPU nested solve on a module of very uneven child sizes: the collision plan (#380)", () => {
  const BIG = ZIPF_BIG;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let device: Device;

  beforeAll(async () => {
    fixture = zipfLike(BIG);
    device = await makeTestDevice();
  });

  it("a collision step's pair work stays within 3× of the collision plan's estimate, with no slot on the exact fallback", () => {
    const solver = solverOf(fixture, ITERATIONS);
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver), { collisionStats: true });
    try {
      layout.runTicks(Math.ceil(0.6 * ITERATIONS));
      const ratios: number[] = [];
      while (layout.ticks < ITERATIONS) {
        layout.beginTick();
        const stats = layout.collisionStats();
        let work = 0;
        let overflow = 0;
        for (let i = 0; i < solver.slotCount; i++) {
          work += 16 * (stats[4 * i] ?? 0) + (stats[4 * i + 1] ?? 0);
          if (stats[4 * i + 3] === 2) overflow++;
        }
        expect(overflow, `tick ${layout.ticks}: slots sent to the exact fallback`).toBe(0);
        ratios.push(work / solver.collision.gatherWork);
        layout.forceBand(0, 1);
        layout.integrate();
      }
      console.log(`  Zipf ${BIG}: pair work per collision step / plan estimate: ${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)} (single-scale grid at 60,000 children: 36)`);
      expect(Math.max(...ratios)).toBeLessThan(3);
    } finally {
      layout.destroy();
    }
  }, perfBudget(300_000));

  it("cuts the gather into bands of equal estimated work, which rows alone would not", () => {
    // The frame budget admits a band by its share of the gather's estimate; a band must carry that share.
    // Rows alone would not: the big module's slots sit in the first rows.
    const solver = solverOf(fixture, ITERATIONS);
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    try {
      const width = Math.max(1, Math.ceil(Math.sqrt(solver.slotCount)));
      const rows = Math.ceil(solver.slotCount / width);
      const rowWork = (r0: number, r1: number): number => {
        let w = 0;
        for (let i = r0 * width; i < Math.min(solver.slotCount, r1 * width); i++) w += (solver.collision.slotWork[i] ?? 0) + 16;
        return w;
      };
      const total = rowWork(0, rows);
      let widestRow = 0;
      for (let r = 0; r < rows; r++) widestRow = Math.max(widestRow, rowWork(r, r + 1));
      for (const bands of [2, 4, 8]) {
        let next = 0;
        const shares: string[] = [];
        for (let b = 0; b < bands; b++) {
          const [r0, r1] = layout.gatherBandRows(b, bands);
          expect(r0).toBe(next);
          next = r1;
          const share = rowWork(r0, r1) / total;
          shares.push(share.toFixed(3));
          expect(share, `band ${b} of ${bands}`).toBeLessThanOrEqual(1 / bands + widestRow / total);
        }
        expect(next).toBe(rows);
        const firstEqualRows = rowWork(0, Math.floor(rows / bands)) / total;
        console.log(`  Zipf ${BIG}, ${bands} bands: work shares ${shares.join(" / ")} (the first of ${bands} equal-row bands: ${firstEqualRows.toFixed(3)})`);
      }
    } finally {
      layout.destroy();
    }
  });
});
