import { describe, it, expect } from "vitest";
import { PairIndex } from "../pair-index.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** The caller's side of a {@link PairIndex}: rows of keys, appended as the index hands out new rows. */
class Rows {
  ka = new Int32Array(8);
  kb = new Int32Array(8);
  count = 0;
  /** `findOrAdd` a pair, writing a new row's keys the way the super-edge gather does. */
  add(index: PairIndex, a: number, b: number): number {
    const row = index.findOrAdd(a, b, this.count, this.ka, this.kb);
    if (row !== this.count) return row;
    if (this.count === this.ka.length) {
      const na = new Int32Array(this.count * 2);
      na.set(this.ka);
      this.ka = na;
      const nb = new Int32Array(this.count * 2);
      nb.set(this.kb);
      this.kb = nb;
    }
    this.ka[this.count] = a;
    this.kb[this.count] = b;
    return this.count++;
  }
  find(index: PairIndex, a: number, b: number): number {
    return index.find(a, b, this.ka, this.kb);
  }
}

describe("#364 PairIndex", () => {
  it("findOrAdd returns the first row a pair was recorded at, and find agrees with a Map reference", () => {
    const index = new PairIndex();
    const rows = new Rows();
    const ref = new Map<string, number>();
    const r = rng(3);
    index.reset();
    for (let i = 0; i < 20_000; i++) {
      // Few distinct values per side, so pairs repeat; a and b swapped is a different (directed) pair.
      const a = Math.floor(r() * 300);
      const b = Math.floor(r() * 300);
      const before = rows.count;
      const got = rows.add(index, a, b);
      const want = ref.get(`${a},${b}`);
      if (want === undefined) {
        expect(got).toBe(before);
        ref.set(`${a},${b}`, got);
      } else {
        expect(got).toBe(want);
      }
    }
    expect(index.size).toBe(ref.size);
    for (let a = 0; a < 300; a += 7) {
      for (let b = 0; b < 300; b += 5) expect(rows.find(index, a, b)).toBe(ref.get(`${a},${b}`) ?? -1);
    }
  });

  it("set points a pair at its latest row (a row holding the same pair)", () => {
    const index = new PairIndex();
    const ka = Int32Array.from([4, 9, 4]);
    const kb = Int32Array.from([9, 4, 9]);
    index.reset();
    index.set(4, 9, 0, ka, kb);
    index.set(9, 4, 1, ka, kb);
    index.set(4, 9, 2, ka, kb);
    expect(index.find(4, 9, ka, kb)).toBe(2);
    expect(index.find(9, 4, ka, kb)).toBe(1);
    expect(index.size).toBe(2);
  });

  it("reset empties it in O(1) and it stays exact across many generations", () => {
    const index = new PairIndex();
    const r = rng(11);
    for (let gen = 0; gen < 200; gen++) {
      index.reset(gen % 3 === 0 ? 0 : 50);
      const rows = new Rows();
      const ref = new Map<string, number>();
      const n = 1 + Math.floor(r() * 120);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(r() * 40);
        const b = Math.floor(r() * 40);
        if (ref.has(`${a},${b}`)) continue;
        expect(rows.add(index, a, b)).toBe(ref.size);
        ref.set(`${a},${b}`, ref.size);
      }
      for (const [key, row] of ref) {
        const [a, b] = key.split(",").map(Number) as [number, number];
        expect(rows.find(index, a, b)).toBe(row);
      }
      expect(index.size).toBe(ref.size);
    }
  });

  it("forgets the previous generation's pairs", () => {
    const index = new PairIndex();
    const rows = new Rows();
    index.reset();
    for (let i = 0; i < 40; i++) rows.add(index, i, 2 * i);
    index.reset();
    for (let i = 0; i < 40; i++) expect(rows.find(index, i, 2 * i)).toBe(-1);
    expect(index.size).toBe(0);
    expect(new Rows().add(index, 7, 14)).toBe(0); // recorded afresh at the new row
  });

  it("grows by doubling at load ½, keeps its high-water capacity, and reset(expected) pre-sizes it", () => {
    const index = new PairIndex();
    const rows = new Rows();
    index.reset();
    const start = index.capacity;
    for (let i = 0; i < 1000; i++) rows.add(index, i, i + 1);
    expect(index.capacity).toBeGreaterThanOrEqual(2 * 1000);
    expect(index.capacity).toBeLessThan(4 * 1000 + start);
    expect(index.byteLength).toBe(8 * index.capacity);
    for (let i = 0; i < 1000; i++) expect(rows.find(index, i, i + 1)).toBe(i); // exact after the rehashes
    const high = index.capacity;
    index.reset(10);
    expect(index.capacity).toBe(high); // never shrinks: the per-frame steady state reallocates nothing
    index.reset(5000);
    expect(index.capacity).toBeGreaterThanOrEqual(2 * 5000);
    const sized = index.capacity;
    const big = new Rows();
    for (let i = 0; i < 5000; i++) big.add(index, i, -i);
    expect(index.capacity).toBe(sized); // pre-sized: no growth while filling up to `expected`
    expect(index.size).toBe(5000);
  });

  it("handles the full Int32 id range and negative ids", () => {
    const index = new PairIndex();
    const rows = new Rows();
    index.reset();
    const pairs: [number, number][] = [[0, 0], [2147483647, 0], [0, 2147483647], [-1, -1], [-2147483648, 5], [123456789, 987654321]];
    pairs.forEach(([a, b], i) => expect(rows.add(index, a, b)).toBe(i));
    pairs.forEach(([a, b], i) => expect(rows.find(index, a, b)).toBe(i));
    expect(rows.find(index, 5, -2147483648)).toBe(-1);
  });
});
