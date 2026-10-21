import { describe, it, expect } from "vitest";
import { cullLabels, labelCullScratch, type LabelBox } from "../cull.js";
import { TextMeasurer, trimToWidth } from "../measure.js";

/**
 * Per-frame regression guard for #496 (AGENTS.md lifecycle §5): `network.labels({ maxWidth })` trims every
 * candidate's text, on EVERY placement frame (`refreshLabels`, one `TextMeasurer.trim` per in-view
 * candidate), so the trim must be a memo lookup once a text has been seen, and it must cost no more than
 * the `TextMeasurer.width` lookup it sits beside (the path it adds to). At ≈1M the candidate set is as
 * large as the graph with LOD off, and the visible set of an LOD-aggregated frontier can be as large, so
 * both a text each of N distinct long names (the Navigator's state names) and the collision pass over the
 * trimmed boxes are run at N.
 *
 * Signatures (deterministic first, wall-clock as the order-of-magnitude backstop):
 *   1. A cut costs O(log text length) measurements, never one per character (the probe count of
 *      `trimToWidth`).
 *   2. A second pass over the same N texts returns the SAME strings (`===`): nothing is re-trimmed or
 *      re-allocated per frame; an unchanged `maxWidth` keeps the memo.
 *   3. The warm trim pass costs within a small factor of the warm `width` pass (the Map lookup it adds
 *      to), and under a generous ceiling.
 *   4. Placement over the trimmed boxes stays under a small number of overlap tests per candidate (the
 *      cull's own guard, `label-cull-perf.test.ts`, bounds it for untrimmed boxes), so trimming adds no
 *      cost to placement.
 *
 * N is 200k in the normal suite; the ≈1M leg is env-gated (`BENCH_LABEL_TRIM=1`, `BENCH_LABEL_TRIM_N`).
 */
const BENCH = !!process.env.BENCH_LABEL_TRIM;
const BENCH_N = Number(process.env.BENCH_LABEL_TRIM_N) || 1_000_000;
const N = BENCH ? BENCH_N : 200_000;
const ASSERT = !!process.env.PERF_ASSERT || !BENCH;
const FONT = "600 11px system-ui, sans-serif";
const MAX = 80;
const W = 1280;
const H = 800;
const name = (i: number) => `{Allentown/Bethlehem/Easton,PA:Station${i}}_Albany,NY:AlbanyInternational${i % 97}`;

describe(`label trim per-frame cost (n=${N})`, () => {
  it("a cut costs O(log length) measurements", () => {
    let probes = 0;
    const text = name(123456);
    trimToWidth(text, MAX, (s) => { probes++; return s.length * 6; });
    expect(probes).toBeLessThanOrEqual(Math.ceil(Math.log2(text.length)) + 3);
  });

  it("a warm pass is a memo lookup: the same strings, within a small factor of the width lookup", () => {
    const texts = Array.from({ length: N }, (_, i) => name(i));
    const m = new TextMeasurer(FONT);
    const cold = texts.map((t) => m.trim(t, MAX)); // first frame: trims and measures each text once
    for (const t of texts) m.width(t);
    const timeIt = (fn: () => void): number => { let best = Infinity; for (let r = 0; r < 3; r++) { const t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); } return best; };
    let sink = 0;
    const warmTrim = timeIt(() => { for (let i = 0; i < N; i++) sink += m.trim(texts[i]!, MAX).length; });
    const warmWidth = timeIt(() => { for (let i = 0; i < N; i++) sink += m.width(texts[i]!); });
    expect(sink).toBeGreaterThan(0);
    for (let i = 0; i < N; i += 997) expect(m.trim(texts[i]!, MAX)).toBe(cold[i]); // identity: nothing re-trimmed
    expect(cold.every((t) => t.endsWith("…"))).toBe(true); // non-vacuous: every text really was cut
    // Two Map lookups' worth on top of the width lookup; the ratio is the guard, the ceiling the backstop.
    if (ASSERT) {
      expect(warmTrim, `trim ${warmTrim.toFixed(0)} ms vs width ${warmWidth.toFixed(0)} ms`).toBeLessThan(3 * warmWidth + 50);
      expect(warmTrim).toBeLessThan(150 + 750 * (N / 200_000));
    }
  }, 120_000);

  it("placement over the trimmed boxes stays linear (overlap tests per candidate)", () => {
    const m = new TextMeasurer(FONT);
    let s = 7;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const boxes: LabelBox[] = new Array(N);
    for (let i = 0; i < N; i++) {
      boxes[i] = { id: i, x: r() * W, y: r() * H, width: m.width(m.trim(name(i), MAX)), height: 14, priority: r(), textAnchor: "middle", baseline: "middle" };
    }
    const scratch = labelCullScratch();
    const placed = cullLabels(boxes, { viewport: { width: W, height: H }, scratch });
    expect(placed.length).toBeGreaterThan(0);
    expect(scratch.lastTests / N).toBeLessThanOrEqual(20); // same bound as label-cull-perf's dense field
  }, 120_000);
});
