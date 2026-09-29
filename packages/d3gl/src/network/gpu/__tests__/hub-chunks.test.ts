import { describe, it, expect } from "vitest";
import { buildHubChunks, hasHubRows, HUB_CHUNK, SPRING_CHUNK } from "../hub-chunks.js";
import { buildCSR } from "../../graph.js";

/** CSR offsets for rows of the given lengths (the builder only reads offsets). */
function offsetsFor(degrees: readonly number[]): Uint32Array {
  const off = new Uint32Array(degrees.length + 1);
  for (let i = 0; i < degrees.length; i++) off[i + 1] = (off[i] ?? 0) + (degrees[i] ?? 0);
  return off;
}

/** One chunk as a plain record, read from the packed `(row, start, end, 0)` table. */
function chunkAt(table: Uint32Array, k: number): { row: number; start: number; end: number } {
  return { row: table[k * 4] ?? -1, start: table[k * 4 + 1] ?? -1, end: table[k * 4 + 2] ?? -1 };
}

describe("buildHubChunks (spec §6.3: rows > C split into chunks of ≤ C entries)", () => {
  it("splits hub rows finer than the row threshold, so a hub's partial loop stays ≤ C up to degree C · HUB_CHUNK", () => {
    // The chunk pass is latency-bound (K fragments cannot fill the GPU), so its cost is one chunk's
    // serial loop: the split size, not the threshold, sets it.
    expect(HUB_CHUNK).toBeLessThan(SPRING_CHUNK);
    expect(SPRING_CHUNK % HUB_CHUNK).toBe(0);
    expect(Math.ceil(10_721 / HUB_CHUNK)).toBeLessThanOrEqual(SPRING_CHUNK); // web-NotreDame's maximum
  });

  it("gives rows of at most C entries no chunks: they keep the one-fragment row gather", () => {
    const hub = buildHubChunks(offsetsFor([0, 1, 7, SPRING_CHUNK, SPRING_CHUNK]));
    expect(hub.count).toBe(0);
    expect(hub.table.length).toBe(0);
  });

  it("splits a row just over C into ceil(deg / HUB_CHUNK) chunks, the last one short", () => {
    const degrees = [SPRING_CHUNK + 1, 3, 2 * SPRING_CHUNK, 2 * SPRING_CHUNK + 1];
    const off = offsetsFor(degrees);
    const hub = buildHubChunks(off);
    const per = SPRING_CHUNK / HUB_CHUNK; // full chunks in C entries
    expect(hub.count).toBe((per + 1) + 2 * per + (2 * per + 1));
    // Row 0: `per` full chunks, then a 1-entry tail.
    expect(chunkAt(hub.table, 0)).toEqual({ row: 0, start: 0, end: HUB_CHUNK });
    expect(chunkAt(hub.table, per - 1)).toEqual({ row: 0, start: SPRING_CHUNK - HUB_CHUNK, end: SPRING_CHUNK });
    expect(chunkAt(hub.table, per)).toEqual({ row: 0, start: SPRING_CHUNK, end: SPRING_CHUNK + 1 });
    // Row 2 starts after row 1's three entries; row 1 (3 entries) has no chunk.
    const s2 = off[2] ?? -1;
    expect(chunkAt(hub.table, per + 1)).toEqual({ row: 2, start: s2, end: s2 + HUB_CHUNK });
    expect(chunkAt(hub.table, 3 * per)).toEqual({ row: 2, start: s2 + 2 * SPRING_CHUNK - HUB_CHUNK, end: s2 + 2 * SPRING_CHUNK });
    expect(chunkAt(hub.table, hub.count - 1)).toEqual({ row: 3, start: (off[3] ?? 0) + 2 * SPRING_CHUNK, end: off[4] });
  });

  it("covers every CSR entry exactly once (rows ≤ C by the row gather, the rest by chunks), no gather over C", () => {
    // web-NotreDame's shape in miniature: a heavy-tailed degree sequence with hubs far above C
    // (10,721 is its maximum) next to rows right at the C boundary.
    const degrees = [10_721, 1, 0, SPRING_CHUNK, SPRING_CHUNK + 1, 4283, 5, 999, 2, 7636];
    const off = offsetsFor(degrees);
    const total = off[degrees.length] ?? 0;
    const hub = buildHubChunks(off);

    const hits = new Uint8Array(total);
    // Row gather: rows with ≤ C entries (the shader skips the loop for a longer row).
    for (let i = 0; i < degrees.length; i++) {
      const s = off[i] ?? 0, e = off[i + 1] ?? 0;
      if (e - s <= SPRING_CHUNK) for (let p = s; p < e; p++) hits[p] = (hits[p] ?? 0) + 1;
    }
    for (let k = 0; k < hub.count; k++) {
      const c = chunkAt(hub.table, k);
      expect(c.end - c.start).toBeGreaterThan(0);
      expect(c.end - c.start).toBeLessThanOrEqual(HUB_CHUNK);
      // A chunk stays inside its own row.
      expect(c.start).toBeGreaterThanOrEqual(off[c.row] ?? -1);
      expect(c.end).toBeLessThanOrEqual(off[c.row + 1] ?? -1);
      for (let p = c.start; p < c.end; p++) hits[p] = (hits[p] ?? 0) + 1;
    }
    expect(hits.every((h) => h === 1)).toBe(true);
    // Σ_{deg > C} ceil(deg / HUB_CHUNK) — the spec's chunk count, at the finer split.
    const expected = degrees.reduce((n, d) => n + (d > SPRING_CHUNK ? Math.ceil(d / HUB_CHUNK) : 0), 0);
    expect(hub.count).toBe(expected);
  });

  it("lays chunk k of a hub row at entry start + k·HUB_CHUNK, with entry starts strictly ascending (the gather's search key)", () => {
    // The force pass finds a hub row's first chunk by binary search on the entry start and then reads
    // ceil(deg / HUB_CHUNK) consecutive partials, so both properties are load-bearing.
    const degrees = [300, 2, 10_721, 0, 4283];
    const off = offsetsFor(degrees);
    const hub = buildHubChunks(off);
    let prev = -1;
    for (let k = 0; k < hub.count; k++) {
      const c = chunkAt(hub.table, k);
      expect(c.start).toBeGreaterThan(prev);
      prev = c.start;
      expect((c.start - (off[c.row] ?? 0)) % HUB_CHUNK).toBe(0);
    }
    for (let i = 0; i < degrees.length; i++) {
      const s = off[i] ?? 0, e = off[i + 1] ?? 0;
      if (e - s <= SPRING_CHUNK) continue;
      const first = lowerBound(hub.table, hub.count, s);
      const n = Math.ceil((e - s) / HUB_CHUNK);
      for (let k = 0; k < n; k++) expect(chunkAt(hub.table, first + k).row).toBe(i);
      if (first + n < hub.count) expect(chunkAt(hub.table, first + n).row).not.toBe(i);
    }
  });

  it("handles an empty graph and a real star built through buildCSR", () => {
    expect(buildHubChunks(new Uint32Array([0])).count).toBe(0);
    const leaves = 20_000;
    const src = new Uint32Array(leaves);
    const tgt = Uint32Array.from({ length: leaves }, (_, i) => i + 1);
    const csr = buildCSR(leaves + 1, src, tgt);
    const hub = buildHubChunks(csr.offsets);
    expect(hub.count).toBe(Math.ceil(leaves / HUB_CHUNK));
    for (let k = 0; k < hub.count; k++) expect(chunkAt(hub.table, k).row).toBe(0);
  });
});

/** The shader's search, in TS: the first chunk whose entry start is ≥ `start`. */
function lowerBound(table: Uint32Array, count: number, start: number): number {
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((table[mid * 4 + 1] ?? 0) < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

describe("hasHubRows (#385: the springs' program variant from the graph's degrees, known before the solver)", () => {
  /** A star of `leaves` leaves on node 0 (degree `leaves`), plus `extra` self-loops on node 1 (each adds 2). */
  function star(leaves: number, loops = 0): { n: number; source: number[]; target: number[] } {
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 0; i < leaves; i++) {
      source.push(0);
      target.push(2 + i);
    }
    for (let i = 0; i < loops; i++) {
      source.push(1);
      target.push(1);
    }
    return { n: 2 + leaves, source, target };
  }

  it("agrees with buildHubChunks over buildCSR at the threshold, above it, and on self-loops", () => {
    const cases = [star(SPRING_CHUNK), star(SPRING_CHUNK + 1), star(3, SPRING_CHUNK / 2), star(3, SPRING_CHUNK / 2 + 1), star(0)];
    for (const c of cases) {
      const csr = buildCSR(c.n, c.source, c.target);
      const expected = buildHubChunks(csr.offsets).count > 0;
      expect(hasHubRows(csr.degree), `${c.source.length} edges`).toBe(expected);
    }
    const degrees = (s: { n: number; source: number[]; target: number[] }): Uint32Array => buildCSR(s.n, s.source, s.target).degree;
    expect(hasHubRows(degrees(star(SPRING_CHUNK)))).toBe(false);
    expect(hasHubRows(degrees(star(SPRING_CHUNK + 1)))).toBe(true);
  });

  it("agrees with buildHubChunks on random graphs with hubs, self-loops and repeated edges", () => {
    let seed = 0x385;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 40; trial++) {
      const n = 50 + Math.floor(rand() * 400);
      const edges = Math.floor(rand() * 3000);
      const hub = Math.floor(rand() * n);
      const source: number[] = [];
      const target: number[] = [];
      for (let e = 0; e < edges; e++) {
        // A third of the edges on one node, so some trials cross the threshold and some do not.
        source.push(rand() < 0.33 ? hub : Math.floor(rand() * n));
        target.push(Math.floor(rand() * n));
      }
      const csr = buildCSR(n, source, target);
      expect(hasHubRows(csr.degree), `trial ${trial}`).toBe(buildHubChunks(csr.offsets).count > 0);
    }
  });
});
