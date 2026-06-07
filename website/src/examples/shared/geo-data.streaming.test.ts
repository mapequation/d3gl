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
  it("emits closed `size`° boxes with continuing ids and a color", async () => {
    const all = await collect(makeStreamingPolygons({ total: 12, batchSize: 5, size: 2 }));
    expect(all).toHaveLength(12);
    expect(all.map((f) => f.properties.id)).toEqual([...Array(12).keys()]);
    for (const f of all) {
      const ring = f.geometry.coordinates[0]!;
      expect(ring).toHaveLength(5); // closed quad: 5 coords
      expect(ring[0]).toEqual(ring[4]); // closed
      const [lon, lat] = ring[0]!;
      // box corner stays in-range so lon+size / lat+size don't exceed the sphere
      expect(lon).toBeLessThanOrEqual(180 - 2);
      expect(lat).toBeLessThanOrEqual(90 - 2);
      expect(f.properties.color).toBe(DEFAULT_STREAM_COLOR);
    }
  });
});
