import { describe, expect, it } from "vitest";
import { buildSuperEdges, type SuperEdgeInput } from "../lod.js";

/**
 * `buildSuperEdges` correctness + scale (#177).
 *
 * The bug: the build accumulated directed super-edge flow in a JS `Map` keyed by `a * size + b`.
 * V8 caps a `Map` at 2²⁴ (16 777 216) entries, so a hierarchy with more distinct (ancestor-a,
 * ancestor-b) pairs than that died with `RangeError: Map maximum size exceeded` before LOD could
 * initialise. `coarsen.ts` `coarsenLevel` had already hit — and solved — exactly this, by bucketing
 * with a counting sort into flat typed arrays; this build now mirrors that.
 *
 * Two legs:
 *  1. **Equivalence (always on).** Randomised trees + graphs, checked against a straightforward
 *     `Map`-based reference. This is what actually pins the semantics: the CSR pair set, the flow
 *     sums, and the out/in transpose must match exactly.
 *  2. **Cap crossing (`BENCH_SUPER_EDGES_BUILD`, auto-enrolled in the CI perf tier).** Builds a
 *     hierarchy whose distinct-pair count exceeds 2²⁴ — the input that used to throw. Gated because
 *     crossing the cap costs ~17M pairs however you construct it (~1 GB, tens of seconds); there is
 *     no small input that reaches a 16.7M-entry ceiling.
 */

// ---- reference implementation (the pre-#177 Map version, kept as the oracle) -------------------

interface SuperEdgeCSR {
  superEdgeOffset: Uint32Array;
  superEdgeTarget: Uint32Array;
  superEdgeFlow: Float32Array;
  superEdgeInOffset: Uint32Array;
  superEdgeInSource: Uint32Array;
  superEdgeInFlow: Float32Array;
}

function referenceSuperEdges(size: number, parent: Int32Array, edges: SuperEdgeInput): SuperEdgeCSR {
  const depth = new Int32Array(size);
  for (let g = size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;

  const flowByPair = new Map<number, number>();
  const m = edges.source.length;
  for (let e = 0; e < m; e++) {
    let a = edges.source[e]!;
    let b = edges.target[e]!;
    if (a === b) continue;
    const w = edges.weight[e]!;
    while (depth[a]! > depth[b]!) a = parent[a]!;
    while (depth[b]! > depth[a]!) b = parent[b]!;
    while (a !== b) {
      const key = a * size + b;
      flowByPair.set(key, (flowByPair.get(key) ?? 0) + w);
      a = parent[a]!;
      b = parent[b]!;
    }
  }

  const superEdgeOffset = new Uint32Array(size + 1);
  for (const key of flowByPair.keys()) superEdgeOffset[Math.floor(key / size) + 1]!++;
  for (let g = 0; g < size; g++) superEdgeOffset[g + 1] = superEdgeOffset[g + 1]! + superEdgeOffset[g]!;
  const total = superEdgeOffset[size]!;
  const superEdgeTarget = new Uint32Array(total);
  const superEdgeFlow = new Float32Array(total);
  const cursor = superEdgeOffset.slice(0, size);
  for (const [key, flow] of flowByPair) {
    const a = Math.floor(key / size);
    const pos = cursor[a]!;
    superEdgeTarget[pos] = key - a * size;
    superEdgeFlow[pos] = flow;
    cursor[a] = pos + 1;
  }

  const superEdgeInOffset = new Uint32Array(size + 1);
  for (const key of flowByPair.keys()) superEdgeInOffset[(key % size) + 1]!++;
  for (let g = 0; g < size; g++) superEdgeInOffset[g + 1] = superEdgeInOffset[g + 1]! + superEdgeInOffset[g]!;
  const superEdgeInSource = new Uint32Array(total);
  const superEdgeInFlow = new Float32Array(total);
  const inCursor = superEdgeInOffset.slice(0, size);
  for (const [key, flow] of flowByPair) {
    const a = Math.floor(key / size);
    const b = key - a * size;
    const pos = inCursor[b]!;
    superEdgeInSource[pos] = a;
    superEdgeInFlow[pos] = flow;
    inCursor[b] = pos + 1;
  }
  return { superEdgeOffset, superEdgeTarget, superEdgeFlow, superEdgeInOffset, superEdgeInSource, superEdgeInFlow };
}

// ---- fixtures ----------------------------------------------------------------------------------

/** Deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * A random coarsening tree: `leafCount` leaves, then each level groups the previous level into
 * buckets of `fanout` until one root remains. Parent ids are always greater than child ids, which
 * is the invariant `buildSuperEdges` relies on for its single descending depth pass.
 */
function randomTree(leafCount: number, fanout: number): { size: number; parent: Int32Array; leafCount: number } {
  const parent: number[] = [];
  let levelStart = 0;
  let levelSize = leafCount;
  for (let i = 0; i < leafCount; i++) parent.push(-1);
  while (levelSize > 1) {
    const nextSize = Math.max(1, Math.ceil(levelSize / fanout));
    const nextStart = levelStart + levelSize;
    for (let i = 0; i < levelSize; i++) parent[levelStart + i] = nextStart + Math.floor(i / fanout);
    for (let i = 0; i < nextSize; i++) parent.push(-1);
    levelStart = nextStart;
    levelSize = nextSize;
  }
  const size = parent.length;
  parent[size - 1] = size - 1; // root: self-parent, never walked past (a === b terminates first)
  return { size, parent: Int32Array.from(parent), leafCount };
}

function randomEdges(leafCount: number, m: number, seed: number): SuperEdgeInput {
  const r = rng(seed);
  const source = new Uint32Array(m);
  const target = new Uint32Array(m);
  const weight = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    source[e] = Math.floor(r() * leafCount);
    target[e] = Math.floor(r() * leafCount);
    weight[e] = Math.round(r() * 100) / 4; // exactly representable in f32 — no summation-order drift
  }
  return { source, target, weight };
}

/** Compare two CSRs as sets of (a → b, flow), independent of within-row ordering. */
function csrPairs(offset: Uint32Array, other: Uint32Array, flow: Float32Array, size: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let g = 0; g < size; g++) {
    for (let p = offset[g]!; p < offset[g + 1]!; p++) out.set(`${g}:${other[p]!}`, flow[p]!);
  }
  return out;
}

/**
 * The out-CSR is **byte-identical** to the Map reference — offsets, targets and flow, in order.
 * Both emit a row in first-encounter order, so this is a real equality, not a set comparison.
 *
 * The in-CSR (transpose) matches on offsets and on each row's contents, but **not** on within-row
 * order: the reference emitted a row in V8 `Map` insertion order, the typed-array build emits it in
 * ascending source. Row order was never contractual — the sole consumer
 * (`glyphs.ts` `frontierLayers`, the off-screen in-edge walk) scans a row and filters, never
 * indexing positionally or pairing it against the out-CSR — and ascending-source is the more
 * canonical of the two (deterministic, and better locality than a hash-insertion permutation).
 */
function expectSameCSR(got: SuperEdgeCSR, want: SuperEdgeCSR, size: number): void {
  expect(Array.from(got.superEdgeOffset)).toEqual(Array.from(want.superEdgeOffset));
  expect(Array.from(got.superEdgeTarget)).toEqual(Array.from(want.superEdgeTarget));
  expect(Array.from(got.superEdgeFlow)).toEqual(Array.from(want.superEdgeFlow));

  expect(Array.from(got.superEdgeInOffset)).toEqual(Array.from(want.superEdgeInOffset));
  expect(csrPairs(got.superEdgeInOffset, got.superEdgeInSource, got.superEdgeInFlow, size)).toEqual(
    csrPairs(want.superEdgeInOffset, want.superEdgeInSource, want.superEdgeInFlow, size),
  );
  // …and the transpose really is the out-CSR's transpose, row by row.
  expect(csrPairs(got.superEdgeInOffset, got.superEdgeInSource, got.superEdgeInFlow, size)).toEqual(
    new Map(
      Array.from(csrPairs(got.superEdgeOffset, got.superEdgeTarget, got.superEdgeFlow, size)).map(([k, v]) => {
        const [a, b] = k.split(":");
        return [`${b}:${a}`, v] as const;
      }),
    ),
  );
}

// ---- 1. equivalence ----------------------------------------------------------------------------

describe("buildSuperEdges — equivalence with the Map reference (#177)", () => {
  const cases: Array<[string, number, number, number, number]> = [
    // label, leafCount, fanout, edgeCount, seed
    ["binary tree, sparse", 64, 2, 128, 1],
    ["binary tree, dense", 64, 2, 2000, 2],
    ["fanout 4", 200, 4, 1500, 3],
    ["fanout 8, deep-ish", 500, 8, 4000, 4],
    ["wide fanout (shallow)", 1000, 32, 5000, 5],
    ["single level (all leaves under root)", 50, 64, 600, 6],
  ];
  for (const [label, leafCount, fanout, m, seed] of cases) {
    it(`matches the reference: ${label}`, () => {
      const { size, parent } = randomTree(leafCount, fanout);
      const edges = randomEdges(leafCount, m, seed);
      expectSameCSR(buildSuperEdges(size, parent, edges), referenceSuperEdges(size, parent, edges), size);
    });
  }

  it("handles degenerate inputs identically: no edges, all self-loops, single leaf", () => {
    const { size, parent } = randomTree(32, 2);
    const empty: SuperEdgeInput = { source: new Uint32Array(0), target: new Uint32Array(0), weight: new Float32Array(0) };
    expectSameCSR(buildSuperEdges(size, parent, empty), referenceSuperEdges(size, parent, empty), size);

    const loops: SuperEdgeInput = {
      source: Uint32Array.from([0, 5, 31, 12]),
      target: Uint32Array.from([0, 5, 31, 12]),
      weight: Float32Array.from([1, 2, 3, 4]),
    };
    expectSameCSR(buildSuperEdges(size, parent, loops), referenceSuperEdges(size, parent, loops), size);

    const one = randomTree(1, 2);
    const none: SuperEdgeInput = { source: new Uint32Array(0), target: new Uint32Array(0), weight: new Float32Array(0) };
    expect(() => buildSuperEdges(one.size, one.parent, none)).not.toThrow();
  });

  it("sums parallel edges and keeps direction distinct (a→b and b→a are separate pairs)", () => {
    const { size, parent } = randomTree(4, 4); // 4 leaves directly under a root
    const edges: SuperEdgeInput = {
      source: Uint32Array.from([0, 0, 1]),
      target: Uint32Array.from([1, 1, 0]),
      weight: Float32Array.from([1.5, 2.5, 10]),
    };
    const got = buildSuperEdges(size, parent, edges);
    expectSameCSR(got, referenceSuperEdges(size, parent, edges), size);
    // 0→1 summed to 4, 1→0 held separately at 10.
    const pairs = csrPairs(got.superEdgeOffset, got.superEdgeTarget, got.superEdgeFlow, size);
    expect(pairs.get("0:1")).toBe(4);
    expect(pairs.get("1:0")).toBe(10);
  });
});

// ---- 2. cap crossing ---------------------------------------------------------------------------

/**
 * Distinct pairs must exceed 2²⁴ for this to be the regression's actual input. Construction:
 * `W` leaves 1:1 under `W` aggregates under a root, with edges covering distinct (a,b) aggregate
 * pairs. Each edge contributes a distinct **leaf** pair *and* a distinct **aggregate** pair, so
 * `m` edges yield `2m` distinct pairs — the cheapest route to 16.7M+ that exists.
 */
function capCrossingFixture(W: number, m: number) {
  const size = 2 * W + 1;
  const parent = new Int32Array(size);
  for (let i = 0; i < W; i++) parent[i] = W + i; // leaf i → aggregate W+i
  for (let i = 0; i < W; i++) parent[W + i] = 2 * W; // aggregate → root
  parent[2 * W] = 2 * W;

  const source = new Uint32Array(m);
  const target = new Uint32Array(m);
  const weight = new Float32Array(m);
  let e = 0;
  outer: for (let a = 0; a < W; a++) {
    for (let b = 0; b < W; b++) {
      if (a === b) continue;
      source[e] = a;
      target[e] = b;
      weight[e] = 1;
      if (++e >= m) break outer;
    }
  }
  return { size, parent, edges: { source, target, weight } satisfies SuperEdgeInput, distinctPairs: 2 * e };
}

describe("buildSuperEdges — beyond V8's Map ceiling (#177)", () => {
  it.runIf(process.env.BENCH_SUPER_EDGES_BUILD)(
    "builds a hierarchy with more than 2^24 distinct super-edge pairs without throwing",
    { timeout: 600_000 },
    () => {
      const W = Number(process.env.BENCH_SUPER_EDGES_BUILD_N) || 4096;
      // 2 * m distinct pairs; we need > 2^24, so m > 8_388_608.
      const m = Math.min(W * (W - 1), 8_600_000);
      const { size, parent, edges, distinctPairs } = capCrossingFixture(W, m);
      expect(distinctPairs).toBeGreaterThan(2 ** 24); // otherwise this leg proves nothing

      const t0 = performance.now();
      const got = buildSuperEdges(size, parent, edges);
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[super-edges-build] ${distinctPairs} distinct pairs in ${ms.toFixed(0)}ms`);

      expect(got.superEdgeOffset[size]).toBe(distinctPairs);
      expect(got.superEdgeTarget.length).toBe(distinctPairs);
      expect(got.superEdgeInSource.length).toBe(distinctPairs);
      // Flow is conserved: every edge contributed weight 1 at exactly two levels.
      let sum = 0;
      for (let i = 0; i < got.superEdgeFlow.length; i++) sum += got.superEdgeFlow[i]!;
      expect(sum).toBe(2 * m);

      if (process.env.PERF_ASSERT) {
        const ceiling = Number(process.env.PERF_SUPER_EDGES_BUILD_MS) || 120_000;
        expect(ms).toBeLessThan(ceiling);
      }
    },
  );
});
