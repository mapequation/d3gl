/**
 * Random-walk **flow** for directed networks (#104 N6) — the visit-rate model behind a "map of
 * networks". d3gl doesn't invent flow; this is an optional helper an app can use to derive it (the
 * same quantity Infomap computes), to drive node size/fill, the enter/exit ring, and half-arrow link
 * width.
 *
 * It is a personalized PageRank whose convention is **cross-checked against `@mapequation/infomap`**
 * (the C++/WASM reference) by a committed test — matched to ~4e-7 on a directed network under
 * Infomap's default `--directed --two-level`. Empirically that flow is:
 * - teleportation lands proportional to each node's **in-strength** (`v`) — i.e. "teleport to links"
 *   lands on link *targets*; not out-strength as a loose reading might suggest;
 * - **dangling** nodes (no out-links) redistribute their flow the same way (via `v`);
 * - the node flow reported is the **recorded** steady state of that chain.
 *
 * The `personalization` / `unrecorded` options expose the other flow-model variants; the defaults are
 * the Infomap-matching ones.
 */

/** Minimal directed-graph shape (a {@link NetworkGraph} satisfies it; raw arrays work too). */
export interface FlowGraph {
  nodeCount: number;
  source: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Per-edge weight; defaults to 1 each. */
  weight?: ArrayLike<number>;
}

export interface FlowOptions {
  /** Teleportation probability (Infomap default 0.15). */
  tau?: number;
  /** Convergence tolerance on the L1 change between iterations. Default 1e-12. */
  tol?: number;
  /** Iteration cap. Default 2000. */
  maxIter?: number;
  /** Teleportation target distribution. Default `"in"` (matches Infomap's directed flow). */
  personalization?: "out" | "in" | "uniform";
  /** Take a final unrecorded step instead of reporting the recorded steady state. Default `false` (Infomap). */
  unrecorded?: boolean;
}

export interface FlowResult {
  /** Per-node unrecorded visit rate, length `nodeCount`, summing to 1. */
  nodeFlow: Float32Array;
  /** Per-edge flow (aligned with `source`/`target`): node flow split along out-links by weight. */
  linkFlow: Float32Array;
}

/**
 * Compute the random-walk {@link FlowResult} for a directed graph. O(iterations · edges); a handful of
 * milliseconds for the thousands-of-nodes scale this is meant for. Run it offline to bake a fixture.
 */
export function randomWalkFlow(graph: FlowGraph, opts: FlowOptions = {}): FlowResult {
  const n = graph.nodeCount;
  const m = graph.source.length;
  const tau = opts.tau ?? 0.15;
  const tol = opts.tol ?? 1e-12;
  const maxIter = opts.maxIter ?? 2000;
  const weightAt = (e: number): number => (graph.weight ? graph.weight[e]! : 1);

  const personalization = opts.personalization ?? "in";
  const unrecorded = opts.unrecorded ?? false;
  // Out-strength per node and the personalization vector v.
  const outStr = new Float64Array(n);
  const inStr = new Float64Array(n);
  for (let e = 0; e < m; e++) {
    const si = graph.source[e]!;
    const ti = graph.target[e]!;
    outStr[si] = outStr[si]! + weightAt(e);
    inStr[ti] = inStr[ti]! + weightAt(e);
  }
  const base = personalization === "in" ? inStr : personalization === "uniform" ? null : outStr;
  const v = new Float64Array(n);
  let totalBase = 0;
  if (base) for (let i = 0; i < n; i++) totalBase += base[i]!;
  if (base && totalBase > 0) for (let i = 0; i < n; i++) v[i] = base[i]! / totalBase;
  else v.fill(1 / n);
  const dangling = new Uint8Array(n);
  for (let i = 0; i < n; i++) dangling[i] = outStr[i]! > 0 ? 0 : 1;

  // One recorded power step: p' = (1-τ)·walk(p) + (τ + (1-τ)·danglingMass)·v.
  let p = new Float64Array(n).fill(1 / n);
  const step = (src: Float64Array, recordTeleport: boolean) => {
    const walk = new Float64Array(n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) if (dangling[i]) danglingMass += src[i]!;
    for (let e = 0; e < m; e++) {
      const i = graph.source[e]!;
      const j = graph.target[e]!;
      walk[j] = walk[j]! + (src[i]! * weightAt(e)) / outStr[i]!;
    }
    const out = new Float64Array(n);
    // Teleportation + dangling redistribution share v. The final (unrecorded) step omits the τ
    // teleport term so node flow counts walk arrivals only; both steps spread dangling via v.
    const teleMass = (recordTeleport ? tau : 0) + (1 - tau) * danglingMass;
    for (let j = 0; j < n; j++) out[j] = (1 - tau) * walk[j]! + teleMass * v[j]!;
    return out;
  };

  // Iterate the recorded chain to steady state.
  for (let it = 0; it < maxIter; it++) {
    const next = step(p, true);
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i]! - p[i]!);
    p = next;
    if (diff < tol) break;
  }

  // Final unrecorded step (default), then renormalize to a distribution; or the recorded steady state.
  const pf = unrecorded ? step(p, false) : p;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += pf[i]!;
  const nodeFlow = new Float32Array(n);
  if (sum > 0) for (let i = 0; i < n; i++) nodeFlow[i] = pf[i]! / sum;

  // Per-edge flow: a node's (recorded steady-state) flow split along its out-links by weight.
  const linkFlow = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    const i = graph.source[e]!;
    linkFlow[e] = outStr[i]! > 0 ? (p[i]! * weightAt(e)) / outStr[i]! : 0;
  }
  return { nodeFlow, linkFlow };
}
