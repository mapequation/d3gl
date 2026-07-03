import fixture from "./modular-map.json";

/**
 * The baked **LFR modular map** fixture (see `generate.ts`): a directed planted-partition network with
 * authoritative random-walk **flow** (matched to Infomap). Each undirected LFR edge was split into a
 * reciprocal a→b / b→a pair, so a half-arrow pair carries genuinely different flow each way.
 *
 * - `linkFlow` — per directed edge → half-arrow width + colour (stored as the graph's edge weight, so
 *   LOD super-edges accumulate flow automatically).
 * - `nodeFlow` — per-node visit rate → node radius (and a flow read-out).
 * - `enterExit` — per-node flow crossing its module boundary → the flow-border ring.
 * - `community` — the planted partition → a one-level module hierarchy (`path = [community + 1]`).
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
 * child-index + the node rank are appended by {@link loadModularMap}). Instead of a flat one-level
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

export function loadModularMap(): ModularMapData {
  const community = Int32Array.from(fixture.community);
  // Infomap path shape: the enclosing module's ancestor chain, then the node's rank within its module.
  // The chain is ragged (see {@link raggedModulePrefix}) so branches reach depths 1–3; the community is
  // always the leaf-module (its colour + LOD aggregate) and the per-community rank distinguishes leaves.
  const rank = new Map<number, number>();
  const modulePaths = Array.from(community, (c, id) => {
    const r = (rank.get(c) ?? 0) + 1;
    rank.set(c, r);
    return { id, path: [...raggedModulePrefix(c), r] };
  });
  return {
    nodeCount: fixture.nodeCount,
    communities: fixture.communities,
    source: Uint32Array.from(fixture.source),
    target: Uint32Array.from(fixture.target),
    linkFlow: Float32Array.from(fixture.linkFlow),
    nodeFlow: Float32Array.from(fixture.nodeFlow),
    enterExit: Float32Array.from(fixture.enterExit),
    community,
    modulePaths,
  };
}
