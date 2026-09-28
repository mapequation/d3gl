/**
 * The GPU nested layout's per-frame guard on a module of very uneven child sizes (#380; a single-scale
 * grid made its gather quadratic, 157 ms frames at 60,000 children), through the real trigger: the same
 * transport bounds, streaming signatures and throughput floor as the Infomap-shaped stream in
 * `gpu-nested-perf.browser.test.ts`, whose header lists what they pin. A file of its own: at CI's scale
 * this leg alone takes about 185 s of the browser perf tier's 300 s per file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { network, type Network } from "../../network.js";
import type { NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import { H, W, ZIPF_BIG, assertSignatures, gpuOnlyRate, median, quantile, report, streamLeg, zipfLike } from "./_nested-perf.js";

describe("GPU nested layout per frame on a module of very uneven child sizes (#380)", () => {
  const BIG = ZIPF_BIG;
  let host: HTMLElement;
  let net: Network;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let gpuOnlyTicksPerSec = 0;

  beforeAll(async () => {
    fixture = zipfLike(BIG);
    gpuOnlyTicksPerSec = await gpuOnlyRate(fixture);
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const warm = zipfLike(2_000);
    net.data(warm.graph, { modules: warm.modules }).layout({ backend: "gpu", nested: { iterations: 5 } });
    await net.whenSettled();
  }, perfBudget(300_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  const TRANSPORT_P95_MS = perfBudget(4 + 2 * ((BIG + 800) / 100_000));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

  it("LOD off: bounded transport main thread, the async readback signatures, throughput", async () => {
    const leg = await streamLeg(net, fixture.graph, fixture.modules, false);
    const { transport, encode, ticksPerSec } = report("Zipf, LOD off", leg);
    console.log(`  GPU-only nested solve (Zipf ${BIG}): ${gpuOnlyTicksPerSec.toFixed(1)} stream ticks/s`);
    assertSignatures(leg);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    expect(ticksPerSec).toBeGreaterThan(0.25 * gpuOnlyTicksPerSec * 0.6);
  }, perfBudget(600_000));
});
