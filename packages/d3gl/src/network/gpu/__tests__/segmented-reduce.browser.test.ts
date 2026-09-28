/**
 * T1 — the contention-free segmented reduction (16-ary gather tree + canonical-cover range query)
 * against a float64 reference.
 *
 * Contract (spec §6.1 / §9):
 *   - `segBox` (maxX, maxY, −minX, −minY) is BITWISE equal to the CPU min/max — min/max are exact;
 *   - `count` is exact (a sum of 1.0s below 2²⁴);
 *   - Σx, Σy are within 2·D·ε·Σ|term| of the float64 sum, D = the term's add depth (4 per tree level
 *     + the query's sequential adds, {@link coverDepth}), ε = 2⁻²³. Σ|v| gets two more roundings per
 *     term for the level-0 map's `length(v)`;
 *   - an empty range yields finite zeros (and the box identity), never NaN;
 *   - two runs over the same inputs are bitwise identical (one program, fixed fetch + add order).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Device, Texture } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { SegmentedReduce } from "../passes/segmented-reduce.js";
import { SegmentTable } from "../segment-table.js";
import { canonicalCover, coverDepth, type SlotRange } from "../segments.js";
import { atlasWidth, readbackRgbaFbo } from "../textures.js";

const EPS = 2 ** -23;

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface SlotData {
  count: number;
  width: number;
  pos: Float32Array;
  vel: Float32Array;
}

/** Upload one rg32float per-slot texture at the solver's atlas width. */
function slotTexture(device: Device, data: Float32Array, width: number, count: number): Texture {
  const height = Math.max(1, Math.ceil(count / width));
  const padded = new Float32Array(width * height * 2);
  padded.set(data);
  return device.createTexture({
    width,
    height,
    format: "rg32float",
    data: padded,
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
}

interface Reduced {
  stats: Float32Array;
  box: Float32Array;
}

/** Run the reduction once over `slots` for every range; read segStats and segBox back. */
function reduceOnGpu(device: Device, slots: SlotData, ranges: readonly SlotRange[]): Reduced {
  const posTex = slotTexture(device, slots.pos, slots.width, slots.count);
  const velTex = slotTexture(device, slots.vel, slots.width, slots.count);
  const param = { repulsion: 0, centering: 0, softening: 0, alpha0: 1 };
  const table = new SegmentTable(device, ranges.map((r) => ({ ...r, tile: null, param })));
  const reduce = new SegmentedReduce(device, slots.count);
  reduce.run({ pos: posTex, vel: velTex, posWidth: slots.width, count: slots.count }, table);
  const out = { stats: readbackRgbaFbo(device, table.stats), box: readbackRgbaFbo(device, table.box) };
  reduce.destroy();
  table.destroy();
  posTex.destroy();
  velTex.destroy();
  return out;
}

interface Reference {
  sum: [number, number, number, number];
  abs: [number, number, number];
  box: [number, number, number, number];
}

/** float64 reference over one range (the float32 inputs, summed exactly enough). */
function reference(slots: SlotData, r: SlotRange): Reference {
  let sx = 0, sy = 0, sv = 0, ax = 0, ay = 0;
  let maxX = -1e30, maxY = -1e30, nMinX = -1e30, nMinY = -1e30;
  for (let s = r.start; s < r.start + r.count; s++) {
    const x = slots.pos[s * 2] ?? 0;
    const y = slots.pos[s * 2 + 1] ?? 0;
    const v = Math.hypot(slots.vel[s * 2] ?? 0, slots.vel[s * 2 + 1] ?? 0);
    sx += x; sy += y; sv += v;
    ax += Math.abs(x); ay += Math.abs(y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    nMinX = Math.max(nMinX, -x); nMinY = Math.max(nMinY, -y);
  }
  return { sum: [sx, sy, sv, r.count], abs: [ax, ay, sv], box: [maxX, maxY, nMinX, nMinY] };
}

/** Worst observed |error| / bound over the ranges, per channel — reported and asserted ≤ 1. */
function checkAgainstReference(slots: SlotData, ranges: readonly SlotRange[], got: Reduced, label: string): void {
  let worst = 0;
  ranges.forEach((r, k) => {
    const ref = reference(slots, r);
    const d = coverDepth(canonicalCover(r.start, r.count));
    const st = got.stats.subarray(k * 4, k * 4 + 4);
    const bx = got.box.subarray(k * 4, k * 4 + 4);
    // Count is exact.
    expect(st[3], `${label} range ${k} count`).toBe(r.count);
    if (r.count === 0) {
      for (let c = 0; c < 4; c++) {
        expect(Number.isFinite(st[c] ?? NaN), `${label} empty range stays finite`).toBe(true);
        expect(st[c], `${label} empty range sums to zero`).toBe(0);
        expect(bx[c] ?? 0, `${label} empty range box is the identity`).toBeLessThanOrEqual(-1e29);
      }
      return;
    }
    // Box: bitwise (min/max of float32 values are exact).
    ref.box.forEach((b, c) => expect(bx[c], `${label} range ${k} box[${c}]`).toBe(Math.fround(b)));
    // Sums: within the add-tree bound.
    ref.abs.forEach((abs, c) => {
      const depth = c === 2 ? d + 2 : d;
      const bound = 2 * depth * EPS * abs;
      const err = Math.abs((st[c] ?? NaN) - (ref.sum[c] ?? NaN));
      expect(err, `${label} range ${k} [${r.start}, +${r.count}) channel ${c}: |Δ|=${err} bound=${bound}`).toBeLessThanOrEqual(bound);
      if (bound > 0) worst = Math.max(worst, err / bound);
    });
  });
  console.log(`  ${label}: ${ranges.length} ranges, worst |Δ|/bound = ${worst.toExponential(2)}`);
}

/**
 * Segments of sizes {0, 1, 2, 31, 32, 33, 4097, 100k}, laid out from an UNALIGNED start with a
 * 3-slot padded tail after each one. The tails hold decoys (far-away positions, huge velocities)
 * that must not leak into any segment's statistics.
 */
function segmentFixture(center: number, spread: number, seed: number): { slots: SlotData; segments: SlotRange[] } {
  const sizes = [0, 1, 2, 31, 32, 33, 4097, 100_000];
  const rng = makePrng(seed);
  const segments: SlotRange[] = [];
  let cursor = 5;
  for (const size of sizes) {
    segments.push({ start: cursor, count: size });
    cursor += size + 3;
  }
  const count = cursor;
  const pos = new Float32Array(count * 2).fill(1e6);
  const vel = new Float32Array(count * 2).fill(1e3);
  for (const seg of segments) {
    for (let s = seg.start; s < seg.start + seg.count; s++) {
      pos[s * 2] = center + (rng() - 0.5) * 2 * spread;
      pos[s * 2 + 1] = -center + (rng() - 0.5) * 2 * spread;
      vel[s * 2] = (rng() - 0.5) * 40;
      vel[s * 2 + 1] = (rng() - 0.5) * 40;
    }
  }
  return { slots: { count, width: atlasWidth(count), pos, vel }, segments };
}

/** Ranges straddling 16^ℓ boundaries (and a few long ones), over the same slots. */
function straddlingRanges(count: number): SlotRange[] {
  const out: SlotRange[] = [];
  for (const b of [16, 256, 4096, 65_536]) {
    for (const [before, len] of [[1, 2], [3, 7], [17, 40], [b >> 1, b]] as const) {
      if (b - before >= 0 && b - before + len <= count) out.push({ start: b - before, count: len });
    }
  }
  out.push({ start: 0, count });
  out.push({ start: 1, count: count - 2 });
  return out;
}

describe("segmented reduction vs a float64 reference (T1)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("segments {0, 1, 2, 31, 32, 33, 4097, 100k}: box bitwise, sums within the bound, empty = zeros", () => {
    const { slots, segments } = segmentFixture(0, 2e4, 0x5e9);
    checkAgainstReference(slots, segments, reduceOnGpu(device, slots, segments), "segments, spread 2e4");
  });

  it("an offset distribution (centre 1e4, spread 1) stays within the bound despite cancellation", () => {
    const { slots, segments } = segmentFixture(1e4, 1, 0x0ff5e7);
    checkAgainstReference(slots, segments, reduceOnGpu(device, slots, segments), "segments, offset 1e4 ± 1");
  });

  it("ranges straddling 16^ℓ boundaries", () => {
    const { slots } = segmentFixture(3e3, 5e3, 0x16);
    const ranges = straddlingRanges(slots.count);
    checkAgainstReference(slots, ranges, reduceOnGpu(device, slots, ranges), "straddling ranges");
  });

  it("two runs over the same inputs are bitwise identical", () => {
    const { slots, segments } = segmentFixture(1e4, 50, 0xd37);
    const ranges = [...segments, ...straddlingRanges(slots.count)];
    const a = reduceOnGpu(device, slots, ranges);
    const b = reduceOnGpu(device, slots, ranges);
    expect(Array.from(b.stats)).toEqual(Array.from(a.stats));
    expect(Array.from(b.box)).toEqual(Array.from(a.box));
  });

  it("1M slots, one flat range: the centroid of an offset layout stays within the bound", () => {
    const count = 1_000_000;
    const rng = makePrng(0x1e6);
    const pos = new Float32Array(count * 2);
    const vel = new Float32Array(count * 2);
    for (let s = 0; s < count; s++) {
      pos[s * 2] = 1e4 + (rng() - 0.5) * 2;
      pos[s * 2 + 1] = -1e4 + (rng() - 0.5) * 2;
      vel[s * 2] = (rng() - 0.5) * 4;
      vel[s * 2 + 1] = (rng() - 0.5) * 4;
    }
    const slots: SlotData = { count, width: atlasWidth(count), pos, vel };
    const ranges: SlotRange[] = [{ start: 0, count }];
    const got = reduceOnGpu(device, slots, ranges);
    checkAgainstReference(slots, ranges, got, "1M flat, offset 1e4 ± 1");
    // Report the centroid error against the one a serial float32 chain (today's 1-px blend) makes.
    const ref = reference(slots, { start: 0, count });
    let serial = 0;
    for (let s = 0; s < count; s++) serial = Math.fround(serial + (pos[s * 2] ?? 0));
    console.log(
      `  1M centroid x: |Δ| tree=${Math.abs((got.stats[0] ?? NaN) / count - ref.sum[0] / count).toExponential(2)}` +
      ` serial-f32=${Math.abs(serial / count - ref.sum[0] / count).toExponential(2)} (world units)`,
    );
  });
});
