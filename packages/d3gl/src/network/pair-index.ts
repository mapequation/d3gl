/** Slots a {@link PairIndex} starts with (512 B). */
const MIN_SLOTS = 1 << 6;
/** The stamp before it wraps: {@link PairIndex.reset} then clears the stamps once (every 2^31 resets). */
const MAX_GEN = 0x7fffffff;

/**
 * Hash index from a directed pair `(a, b)` of Int32 ids to a **row** of key arrays its caller owns (#364):
 * row `r` is the pair `(ka[r], kb[r])`, so the index stores only rows and a probe compares
 * `ka[row] === a && kb[row] === b`. The super-edge gather hands it its own `aS`/`bS` gather arrays, so the
 * flow a pair carries stays in the gather's `wS[row]` and nothing is copied. It replaces a `Map` keyed by
 * `a · size + b`: no key or value is boxed and no entry is an object, so a lookup allocates nothing.
 *
 * Open addressing with linear probing over ONE `Int32Array` of `[stamp, row]` slots. A slot is live when
 * its stamp equals the current generation, so {@link reset} empties the index in O(1). It doubles at load
 * ½ (a rehash through the caller's key arrays) and keeps its high-water capacity, so a per-frame caller
 * reallocates nothing once warm: 8 B per slot, 16-32 B per pair of the largest set it has held.
 */
export class PairIndex {
  private slots = new Int32Array(2 * MIN_SLOTS);
  private gen = 1;
  private live = 0;

  /** Pairs recorded since the last {@link reset}. */
  get size(): number {
    return this.live;
  }

  /** Slots allocated (a power of two). */
  get capacity(): number {
    return this.slots.length >> 1;
  }

  /** Bytes it retains (8 per slot). */
  get byteLength(): number {
    return this.slots.byteLength;
  }

  /** Empty the index in O(1), with room for `expected` pairs before it grows. Never shrinks. */
  reset(expected = 0): void {
    if (this.gen === MAX_GEN) {
      for (let s = 0; s < this.slots.length; s += 2) this.slots[s] = 0;
      this.gen = 0;
    }
    this.gen++;
    this.live = 0;
    let slots = this.capacity;
    while (slots < 2 * expected) slots *= 2;
    if (slots > this.capacity) this.slots = new Int32Array(2 * slots); // zero stamps: never the generation
  }

  /** The row recorded for `(a, b)`, or −1. */
  find(a: number, b: number, ka: Int32Array, kb: Int32Array): number {
    const slots = this.slots;
    const mask = (slots.length >> 1) - 1;
    const gen = this.gen;
    for (let s = pairHash(a, b) & mask; slots[2 * s] === gen; s = (s + 1) & mask) {
      const row = slots[2 * s + 1] ?? -1;
      if (ka[row] === a && kb[row] === b) return row;
    }
    return -1;
  }

  /**
   * The row recorded for `(a, b)`; when there is none, record `row` for it and return `row` — the caller
   * then writes `(a, b)` to that row of `ka`/`kb` before its next call.
   */
  findOrAdd(a: number, b: number, row: number, ka: Int32Array, kb: Int32Array): number {
    const s = this.probe(a, b, ka, kb);
    const slots = this.slots;
    if (slots[2 * s] === this.gen) return slots[2 * s + 1] ?? -1;
    slots[2 * s] = this.gen;
    slots[2 * s + 1] = row;
    this.live++;
    return row;
  }

  /** Record `row` for `(a, b)`, replacing the row recorded for it before; `ka`/`kb` hold `(a, b)` at `row`. */
  set(a: number, b: number, row: number, ka: Int32Array, kb: Int32Array): void {
    const s = this.probe(a, b, ka, kb);
    const slots = this.slots;
    if (slots[2 * s] !== this.gen) {
      slots[2 * s] = this.gen;
      this.live++;
    }
    slots[2 * s + 1] = row;
  }

  /** The slot holding `(a, b)`, or the empty slot it goes in (growing first if one more would pass load ½). */
  private probe(a: number, b: number, ka: Int32Array, kb: Int32Array): number {
    if (2 * (this.live + 1) > this.capacity) this.grow(ka, kb);
    const slots = this.slots;
    const mask = (slots.length >> 1) - 1;
    const gen = this.gen;
    let s = pairHash(a, b) & mask;
    for (; slots[2 * s] === gen; s = (s + 1) & mask) {
      const row = slots[2 * s + 1] ?? -1;
      if (ka[row] === a && kb[row] === b) break;
    }
    return s;
  }

  /** Double the slots and re-insert the live rows (their keys read back from `ka`/`kb`). */
  private grow(ka: Int32Array, kb: Int32Array): void {
    const old = this.slots;
    const gen = this.gen;
    const slots = new Int32Array(old.length * 2);
    const mask = (slots.length >> 1) - 1;
    for (let o = 0; o < old.length; o += 2) {
      if (old[o] !== gen) continue;
      const row = old[o + 1] ?? -1;
      let s = pairHash(ka[row] ?? 0, kb[row] ?? 0) & mask;
      while (slots[2 * s] === gen) s = (s + 1) & mask;
      slots[2 * s] = gen;
      slots[2 * s + 1] = row;
    }
    this.slots = slots;
  }
}

/** Hash of a directed pair of Int32 ids: murmur3's 32-bit finaliser over `a · φ ⊕ b` (full avalanche,
 *  so consecutive ids — tree nodes of one subtree — spread over the slots). */
function pairHash(a: number, b: number): number {
  let h = Math.imul(a, 0x9e3779b1) ^ b;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}
