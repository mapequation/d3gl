import { randomWalkFlow } from "@mapequation/d3gl/network";
import { generateLFR } from "../network/data.js";

/**
 * A **directed modular map** generated at runtime (so the Nodes slider can resize it): a directed LFR
 * planted-partition network with authoritative random-walk **flow** (matched to Infomap's convention).
 * Each undirected LFR edge is split into a reciprocal a→b / b→a pair with **asymmetric** weights, so a
 * half-arrow pair carries genuinely different flow each way.
 *
 * - `linkFlow` — per directed edge → half-arrow width + colour (used as the graph's edge weight, so LOD
 *   super-edges accumulate flow automatically).
 * - `nodeFlow` — per-node visit rate → node radius (and a flow read-out).
 * - `enterExit` — per-node flow crossing its module boundary → the flow-border ring.
 * - `community` — the planted partition → the (ragged) module hierarchy (see {@link raggedModulePrefix}).
 */
export interface ModularMapData {
  nodeCount: number;
  communities: number;
  source: Uint32Array;
  target: Uint32Array;
  linkFlow: Float32Array;
  nodeFlow: Float32Array;
  enterExit: Float32Array;
  community: Int32Array;
  /** Infomap-shape module records for `lod({ modules })`: a **ragged** hierarchy — see {@link raggedModulePrefix}. */
  modulePaths: { id: number; path: number[] }[];
}

/**
 * Ragged module prefix for community `c` — the ancestor chain above its leaf-module (the module's own
 * child-index + the node rank are appended by {@link makeModularMap}). Instead of a flat one-level
 * partition (every community a top module, every leaf at depth 1), a few communities are promoted into
 * **super-modules** so branches reach different depths — the ragged hierarchy the module-aware GPU seed
 * (#180 N8.2) resolves top-down. Grouping is by `super = ⌊c / 4⌋`; a community's position within its
 * group sets its depth:
 *  - position 0 → a **top-level** community (depth 1): `[10000 + c]`
 *  - positions 1–2 → nested one level under the super-module (depth 2): `[1 + super, 100 + c]`
 *  - position 3 → nested two levels (depth 3): `[1 + super, 500 + super, 200 + c]`
 * The value ranges are disjoint so sibling child-indices never collide; every community stays a single
 * coherent leaf-module (its nodes share the full prefix), just at a varying depth.
 */
function raggedModulePrefix(c: number): number[] {
  const GROUP = 4;
  const superId = Math.floor(c / GROUP);
  switch (c % GROUP) {
    case 0:
      return [10000 + c]; // top-level community (depth 1)
    case 3:
      return [1 + superId, 500 + superId, 200 + c]; // super → sub-group → community (depth 3)
    default:
      return [1 + superId, 100 + c]; // super → community (depth 2)
  }
}

/** Deterministic PRNG (mulberry32) for reproducible asymmetric edge weights across re-renders. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a directed modular map with `nodeCount` nodes. Deterministic (seeded), so resizing via the Nodes
 * slider and back gives the same map. Flow is computed at runtime with {@link randomWalkFlow} — cheap at
 * the sizes the slider offers, and it keeps the example a true *flow* map at every size.
 */
export function makeModularMap(nodeCount: number): ModularMapData {
  const lfr = generateLFR(nodeCount, { mu: 0.1, avgDegree: 10, minCommunity: 18, seed: 42 });
  const n = lfr.nodeCount;

  // Directed: each undirected edge → a reciprocal pair with **asymmetric** weights, so the two half-arrows
  // of a pair carry genuinely different flow (a→b ≠ b→a) and the map reads as directed.
  const rng = mulberry32(7);
  const draw = () => 0.3 + 4 * rng() * rng(); // skewed [0.3, ~4.3): most light, some heavy
  const m = lfr.source.length;
  const source = new Uint32Array(2 * m);
  const target = new Uint32Array(2 * m);
  const weight = new Float32Array(2 * m);
  for (let e = 0; e < m; e++) {
    const a = lfr.source[e]!;
    const b = lfr.target[e]!;
    source[2 * e] = a;
    target[2 * e] = b;
    weight[2 * e] = draw();
    source[2 * e + 1] = b;
    target[2 * e + 1] = a;
    weight[2 * e + 1] = draw();
  }

  // Authoritative random-walk flow (Infomap convention), then per-node boundary (enter/exit) flow.
  const { nodeFlow, linkFlow } = randomWalkFlow({ nodeCount: n, source, target, weight }, { tau: 0.15 });
  const community = lfr.community;
  const enterExit = new Float32Array(n);
  for (let e = 0; e < source.length; e++) {
    const a = source[e]!;
    const b = target[e]!;
    if (community[a] !== community[b]) {
      enterExit[a]! += linkFlow[e]!; // exit flow from a
      enterExit[b]! += linkFlow[e]!; // enter flow to b
    }
  }

  // Infomap path shape: the enclosing module's (ragged) ancestor chain, then the node's rank within its
  // module. The community is always the leaf-module (its colour + LOD aggregate); the per-community rank
  // distinguishes leaves. Depths vary 1–3 (see {@link raggedModulePrefix}).
  const rank = new Map<number, number>();
  const modulePaths = Array.from(community, (c, id) => {
    const r = (rank.get(c) ?? 0) + 1;
    rank.set(c, r);
    return { id, path: [...raggedModulePrefix(c), r] };
  });

  const communities = new Set(Array.from(community)).size;
  return { nodeCount: n, communities, source, target, linkFlow, nodeFlow, enterExit, community, modulePaths };
}
