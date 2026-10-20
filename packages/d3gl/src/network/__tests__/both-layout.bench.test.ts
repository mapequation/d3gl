import { appendFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { packStateNodes } from "../both-layout.js";
import { areaBoundRatio, csrOf, enclosureExcess, flowRadii, overlaps, pairSizes, paretoSizes, seeded } from "./_both-pack.js";

/**
 * The both view's packing at scale (#509, decision D2): `packStateNodes` over ≈1M state nodes, which runs once
 * per style or data change (not per frame), in three shapes of physical node:
 *   - pairs: physical nodes of 1–2 state nodes (560k physical nodes at 1,008,000 state nodes);
 *   - pareto: physical-node sizes from a Pareto law, up to 5,000 (about 218k physical nodes at 1,008,000);
 *   - one: a single physical node of 100k state nodes (fixed: the sort's and the grid's worst case).
 * Radii are flow-like, 2–20 size units. The issue's prototype phyllotaxis took 80–115 ms at 1M (M1 Max).
 *
 *   BENCH_BOTH_PACK=1 pnpm exec vitest run packages/d3gl/src/network/__tests__/both-layout.bench.test.ts
 *
 * Each run appends a labelled line per shape to /tmp/both-pack-perf.txt (BENCH_BOTH_PACK_LABEL). The signature,
 * no overlapping pair and every state node enclosed, is asserted whenever the bench runs; the wall-clock ceilings
 * only under PERF_ASSERT (the CI perf tier, single-threaded).
 */
const BENCH = !!process.env.BENCH_BOTH_PACK;
const BENCH_N = Number(process.env.BENCH_BOTH_PACK_N) || 1_008_000;
const ASSERT = !!process.env.PERF_ASSERT;
// Calibration at N = 1,008,000 on an M1 Max, under a load average of 14–100 (so upper bounds): pairs ≈33 ms,
// pareto ≈195–280 ms, one ≈45–50 ms. The ceilings are about 4–5× those, split into a constant and a per-state-node
// term so they hold at the tier's PERF_N; an O(s²) packing of a large physical node would take seconds.
const PAIRS_MS = Number(process.env.PERF_BOTH_PACK_PAIRS_MS) || 20 + (180 * BENCH_N) / 1_008_000;
const PARETO_MS = Number(process.env.PERF_BOTH_PACK_PARETO_MS) || 50 + (1_000 * BENCH_N) / 1_008_000;
const ONE_MS = Number(process.env.PERF_BOTH_PACK_ONE_MS) || 300;
const REPS = 5;

describe("#509 both-view packing at scale", () => {
  (BENCH ? it : it.skip)(
    `bench: packStateNodes at ${BENCH_N.toLocaleString()} state nodes`,
    () => {
      const rng = seeded(509);
      const shapes = [
        { name: "pairs", sizes: pairSizes(BENCH_N), ceiling: PAIRS_MS },
        { name: "pareto", sizes: paretoSizes(BENCH_N, 1.18, 5_000, rng), ceiling: PARETO_MS },
        { name: "one", sizes: Uint32Array.of(100_000), ceiling: ONE_MS },
      ];
      for (const shape of shapes) {
        const csr = csrOf(shape.sizes);
        const stateCount = csr.states.length;
        const radii = flowRadii(stateCount, rng);
        const out = { offsets: new Float32Array(2 * stateCount), radii: new Float32Array(shape.sizes.length) };
        packStateNodes(radii, csr, out); // warm up the JIT
        const ts: number[] = [];
        for (let rep = 0; rep < REPS; rep++) {
          const t0 = performance.now();
          packStateNodes(radii, csr, out);
          ts.push(performance.now() - t0);
        }
        ts.sort((a, b) => a - b);
        const median = ts[REPS >> 1] ?? 0;

        // --- signature (always, whenever the bench runs) ----------------------------------------------------
        const report = overlaps(out.offsets, radii, csr);
        const excess = enclosureExcess(out.offsets, radii, out.radii, csr, 0);
        // Physical nodes of exactly 2: the smallest enclosing disc of the pair has radius r₀ + r₁.
        let pairRatio = 0;
        let pairCount = 0;
        for (let p = 0; p < shape.sizes.length; p++) {
          if (shape.sizes[p] !== 2) continue;
          const start = csr.offsets[p] ?? 0;
          const a = csr.states[start] ?? 0;
          const b = csr.states[start + 1] ?? 0;
          pairRatio += (out.radii[p] ?? 0) / ((radii[a] ?? 0) + (radii[b] ?? 0));
          pairCount++;
        }
        const line =
          `${shape.name}  physical=${shape.sizes.length.toLocaleString()}  state=${stateCount.toLocaleString()}  ` +
          `median=${median.toFixed(1)}ms  min=${(ts[0] ?? 0).toFixed(1)}ms  overlaps=${report.pairs}  excess=${excess.toExponential(1)}  ` +
          `radius/pair-enclosure=${pairCount ? (pairRatio / pairCount).toFixed(3) : "-"}  ` +
          `radius/area-bound(≥3)=${areaBoundRatio(radii, out.radii, csr, 3).toFixed(3)}\n`;
        console.log(line);
        appendFileSync("/tmp/both-pack-perf.txt", `[${process.env.BENCH_BOTH_PACK_LABEL ?? "run"}] ${line}`);
        expect(report.pairs, `${shape.name}: overlapping pairs (worst ${report.worst})`).toBe(0);
        expect(excess, `${shape.name}: a state node reaches past its physical node`).toBeLessThanOrEqual(0);

        // --- wall-clock (uncontended runs only) ---------------------------------------------------------------
        if (ASSERT) {
          expect(median, `${shape.name}: median ${median.toFixed(1)}ms exceeds ${shape.ceiling.toFixed(0)}ms`).toBeLessThan(shape.ceiling);
        }
      }
    },
    600_000,
  );
});
