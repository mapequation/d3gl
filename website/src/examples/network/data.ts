export interface GeneratedNetwork {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Node → community id (planted ground truth; handy for colouring or validation). */
  community: Int32Array;
}

export interface LFROptions {
  /** Mixing: fraction of each node's edges that go *outside* its community (0..1). Default 0.1. */
  mu?: number;
  /** Target mean degree. Default 12. */
  avgDegree?: number;
  /** Max degree. Default ≈ 3·√n. */
  maxDegree?: number;
  /** Degree power-law exponent τ₁. Default 2.5. */
  degreeExponent?: number;
  /** Community-size power-law exponent τ₂. Default 1.5. */
  communityExponent?: number;
  /** Smallest community. Default 20. */
  minCommunity?: number;
  /** Largest community. Default ≈ n/8. */
  maxCommunity?: number;
  /** PRNG seed (deterministic output across re-renders). Default 1. */
  seed?: number;
}

/** Tiny deterministic PRNG (mulberry32) — keeps the generated network stable across re-renders. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample an integer in [min,max] from a power law p(x) ∝ x^(−exponent) via inverse-CDF. */
function powerLaw(rand: () => number, min: number, max: number, exponent: number): number {
  if (max <= min) return min;
  const e = 1 - exponent;
  const lo = Math.pow(min, e);
  const hi = Math.pow(max, e);
  const x = Math.round(Math.pow(lo + rand() * (hi - lo), 1 / e));
  return x < min ? min : x > max ? max : x;
}

/** Fisher–Yates shuffle of `arr[from..to)` in place. */
function shuffle(arr: Uint32Array, from: number, to: number, rand: () => number): void {
  for (let i = to - 1; i > from; i--) {
    const j = from + Math.floor(rand() * (i - from + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/**
 * A clean-room **LFR-style benchmark network** (Lancichinetti–Fortunato–Radicchi): power-law node
 * degrees and power-law community sizes, with a mixing parameter `mu` controlling the fraction of
 * inter-community edges. Edges are wired with a configuration model — intra-community stubs paired
 * within each community, inter-community stubs paired globally across communities — so the planted
 * communities are real, nested structure the force layout resolves and LOD coarsening can recover.
 *
 * This is an approximation tuned for visualization (it allows the occasional multi-edge and skips
 * the reference algorithm's exact degree-sequence rewiring), not a bit-faithful reproduction of the
 * published LFR generator.
 */
export function generateLFR(n: number, opts: LFROptions = {}): GeneratedNetwork {
  const mu = opts.mu ?? 0.1;
  const avgDegree = opts.avgDegree ?? 12;
  const degExp = opts.degreeExponent ?? 2.5;
  const comExp = opts.communityExponent ?? 1.5;
  const maxDeg = Math.min(n - 1, opts.maxDegree ?? Math.round(3 * Math.sqrt(n)));
  // Mean of a bounded power law ≈ minDeg·(γ−1)/(γ−2); invert to hit the target average degree.
  const minDeg = Math.max(2, Math.round((avgDegree * (degExp - 2)) / (degExp - 1)));
  const minCom = Math.max(2, Math.min(opts.minCommunity ?? 20, n));
  const maxCom = Math.max(minCom, Math.min(opts.maxCommunity ?? Math.round(n / 8), n));
  const rand = mulberry32(opts.seed ?? 1);

  // 1) Planted communities as contiguous node ranges with power-law sizes covering all n nodes.
  const community = new Int32Array(n);
  const comStart: number[] = [];
  let assigned = 0;
  for (let c = 0; assigned < n; c++) {
    let size = powerLaw(rand, minCom, maxCom, comExp);
    if (assigned + size > n) size = n - assigned;
    comStart.push(assigned);
    community.fill(c, assigned, assigned + size);
    assigned += size;
  }
  comStart.push(n); // sentinel end

  // 2) Per-node degree (power law), split into intra/inter targets. Intra is capped at the
  //    community size so a small community can satisfy it without excessive multi-edges.
  const intra = new Uint32Array(n);
  const inter = new Uint32Array(n);
  let sumIntra = 0;
  let sumInter = 0;
  for (let c = 0; c + 1 < comStart.length; c++) {
    const start = comStart[c]!;
    const end = comStart[c + 1]!;
    const cap = end - start - 1; // most intra-neighbours available
    for (let u = start; u < end; u++) {
      const deg = powerLaw(rand, minDeg, maxDeg, degExp);
      let ai = Math.round((1 - mu) * deg);
      if (ai > cap) ai = cap < 0 ? 0 : cap;
      intra[u] = ai;
      inter[u] = deg - ai;
      sumIntra += ai;
      sumInter += inter[u]!;
    }
  }

  // Edge buffers, sized at the stub-pair upper bound (each undirected edge consumes two stubs).
  const cap = Math.ceil(sumIntra / 2) + Math.ceil(sumInter / 2) + 1;
  const source = new Uint32Array(cap);
  const target = new Uint32Array(cap);
  let ne = 0;

  // 3) Intra-community edges: pair shuffled intra-stubs within each community (configuration model).
  const intraStubs = new Uint32Array(sumIntra);
  {
    let p = 0;
    for (let u = 0; u < n; u++) for (let k = 0; k < intra[u]!; k++) intraStubs[p++] = u;
  }
  let seg = 0; // running start of the current community's stub segment (stubs are in node-id order)
  for (let c = 0; c + 1 < comStart.length; c++) {
    let segEnd = seg;
    for (let u = comStart[c]!; u < comStart[c + 1]!; u++) segEnd += intra[u]!;
    shuffle(intraStubs, seg, segEnd, rand);
    for (let i = seg; i + 1 < segEnd; i += 2) {
      const a = intraStubs[i]!;
      const b = intraStubs[i + 1]!;
      if (a !== b) {
        source[ne] = a;
        target[ne] = b;
        ne++;
      }
    }
    seg = segEnd;
  }

  // 4) Inter-community edges: pair shuffled inter-stubs globally, skipping same-community/self pairs.
  const interStubs = new Uint32Array(sumInter);
  {
    let p = 0;
    for (let u = 0; u < n; u++) for (let k = 0; k < inter[u]!; k++) interStubs[p++] = u;
  }
  shuffle(interStubs, 0, sumInter, rand);
  for (let i = 0; i + 1 < sumInter; i += 2) {
    const a = interStubs[i]!;
    const b = interStubs[i + 1]!;
    if (a !== b && community[a] !== community[b]) {
      source[ne] = a;
      target[ne] = b;
      ne++;
    }
  }

  return { nodeCount: n, source: source.subarray(0, ne), target: target.subarray(0, ne), community };
}
