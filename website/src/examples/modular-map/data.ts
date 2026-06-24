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
  /** Infomap-shape module records for `lod({ modules })`: one level, 1-based community as the path. */
  modulePaths: { id: number; path: number[] }[];
}

export function loadModularMap(): ModularMapData {
  const community = Int32Array.from(fixture.community);
  // Infomap path shape: the module level(s) then the node's rank within its module. One level here, so
  // path = [community, rank] — the community is the enclosing module (its colour + LOD aggregate) and
  // the per-community rank distinguishes the leaves. (A bare [community] would read as "rank under the
  // root" — no module at all.)
  const rank = new Map<number, number>();
  const modulePaths = Array.from(community, (c, id) => {
    const r = (rank.get(c) ?? 0) + 1;
    rank.set(c, r);
    return { id, path: [c + 1, r] };
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
