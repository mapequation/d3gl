import { describe, it, expect } from "vitest";
import {
  makeStreamingPoints,
  makeStreamingPolygons,
  DEFAULT_STREAM_COLOR,
  type StreamPoint,
} from "./geo-data.js";

async function collect<T>(gen: AsyncGenerator<T[]>): Promise<T[]> {
  const out: T[] = [];
  for await (const batch of gen) out.push(...batch);
  return out;
}

describe("makeStreamingPoints", () => {
  it("emits exactly `total` points in `batchSize` batches with continuing ids", async () => {
    const batches: number[] = [];
    const all = [];
    for await (const b of makeStreamingPoints({ total: 25, batchSize: 10 })) {
      batches.push(b.length);
      all.push(...b);
    }
    expect(batches).toEqual([10, 10, 5]); // 25 total, batches of 10
    expect(all).toHaveLength(25);
    expect(all.map((f) => f.properties.id)).toEqual([...Array(25).keys()]); // 0..24, continuing
  });

  it("places points in lon/lat range and starts with the default color", async () => {
    const all = await collect(makeStreamingPoints({ total: 50, batchSize: 50 }));
    for (const f of all) {
      const [lon, lat] = f.geometry.coordinates;
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
      expect(f.properties.color).toBe(DEFAULT_STREAM_COLOR);
    }
  });

  it("is deterministic for a given seed and differs across seeds", async () => {
    const a = await collect(makeStreamingPoints({ total: 20, seed: 7 }));
    const b = await collect(makeStreamingPoints({ total: 20, seed: 7 }));
    const c = await collect(makeStreamingPoints({ total: 20, seed: 8 }));
    expect(a.map((f) => f.geometry.coordinates)).toEqual(b.map((f) => f.geometry.coordinates));
    expect(a.map((f) => f.geometry.coordinates)).not.toEqual(c.map((f) => f.geometry.coordinates));
  });

  it("re-reads a batchSize function each batch (enables adaptive resizing)", async () => {
    let size = 5;
    const sizes: number[] = [];
    for await (const b of makeStreamingPoints({ total: 30, batchSize: () => size })) {
      sizes.push(b.length);
      size += 5; // grow between batches — the source must pick this up
    }
    expect(sizes).toEqual([5, 10, 15]); // 5 + 10 + 15 = 30, sizes reflect the live getter
  });

  it("stops early when the signal is aborted", async () => {
    const signal = { aborted: false };
    const seen: StreamPoint[] = [];
    for await (const b of makeStreamingPoints({ total: 1000, batchSize: 10, signal })) {
      seen.push(...b);
      if (seen.length >= 30) signal.aborted = true; // abort after a few batches
    }
    // The batch in flight completes, then the next iteration sees the abort and returns.
    expect(seen.length).toBeGreaterThanOrEqual(30);
    expect(seen.length).toBeLessThan(1000);
  });
});

describe("makeStreamingPolygons", () => {
  it("emits irregular closed rings (3–10 vertices) with continuing ids and a color", async () => {
    const all = await collect(makeStreamingPolygons({ total: 40, batchSize: 5, size: 8 }));
    expect(all).toHaveLength(40);
    expect(all.map((f) => f.properties.id)).toEqual([...Array(40).keys()]);
    const ringLengths = new Set<number>();
    for (const f of all) {
      const ring = f.geometry.coordinates[0]!;
      ringLengths.add(ring.length);
      expect(ring.length).toBeGreaterThanOrEqual(4); // 3 verts + close
      expect(ring.length).toBeLessThanOrEqual(11); // 10 verts + close
      expect(ring[0]).toEqual(ring[ring.length - 1]!); // closed
      for (const [lon, lat] of ring) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
      expect(f.properties.color).toBe(DEFAULT_STREAM_COLOR);
    }
    expect(ringLengths.size).toBeGreaterThan(1); // genuinely varied vertex counts
  });
});
