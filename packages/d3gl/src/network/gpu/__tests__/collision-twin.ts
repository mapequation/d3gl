/**
 * A CPU twin of one collision step's pair search on the radius-class grid (#380): the cell pass's
 * binning, the bucket hash, the K-occupant rounds and the gather's visits, in the same order as
 * `passes/collision.ts`. It reports what the GPU gather would do — the cells it visits, the occupants it
 * reads, the pairs it tests and which slots fall back to the exact loop — and each slot's touching
 * partners, so a node test can check the search is complete against brute force. Test helper only.
 */
import {
  COLLISION_EXACT,
  COLLISION_F_MAX,
  COLLISION_LIST_MAX,
  cellHash,
  searchCellsPerAxis,
  searchReach,
  planClassCount,
  planFirstBinned,
  planHasClass,
  type CollisionPlan,
} from "../collision-plan.js";

/** The slots' segments and radii, as `NestedSolverTopology` holds them. */
export interface TwinTopology {
  readonly slotCount: number;
  readonly segStart: Uint32Array;
  readonly segCount: Uint32Array;
  readonly radius: Float32Array;
}

/** What one collision step's search does, summed over every slot. */
export interface TwinStats {
  /** Slots binned into a bucket (every grid slot but the listed ones). */
  binned: number;
  /** Buckets looked up by grid searches. */
  lookups: number;
  /** Bucket occupants read (before the class / cell match). */
  occupants: number;
  /** Pair tests: matched occupants, list entries and exact-loop partners. */
  pairTests: number;
  /** Slots that take the exact loop because the plan says so (a large disc among small ones, or a small segment). */
  exactSlots: number;
  /** Grid slots sent to the exact loop by a bucket with more than K occupants. */
  overflowSlots: number;
  /** The largest bucket, and buckets above K. */
  maxBucket: number;
  overflowBuckets: number;
  /** The most pair tests plus lookups of any one slot. */
  maxSlotWork: number;
}

/** A slot's finest-cell coordinates, packed `x | y << 16` (the GPU key's first word). */
function finestCell(x: number, y: number, ox: number, oy: number, side: number): [number, number] {
  const fx = Math.min(COLLISION_F_MAX, Math.max(0, Math.floor(Math.fround(Math.fround(x - ox) / side))));
  const fy = Math.min(COLLISION_F_MAX, Math.max(0, Math.floor(Math.fround(Math.fround(y - oy) / side))));
  return [fx, fy];
}

/**
 * Run the pair search of one collision step at positions `pos` (`2 · slots`, float32 local positions)
 * with `rounds` occupant rounds. `partners`, when given, receives every slot's partners found touching
 * (distance below `(r_i + r_j) · pad`), for a completeness check against brute force.
 */
export function collisionTwin(
  topo: TwinTopology,
  plan: CollisionPlan,
  pos: Float32Array,
  rounds: number,
  pad: number,
  partners?: number[][],
): TwinStats {
  const refine = plan.refine;
  const stats: TwinStats = { binned: 0, lookups: 0, occupants: 0, pairTests: 0, exactSlots: 0, overflowSlots: 0, maxBucket: 0, overflowBuckets: 0, maxSlotWork: 0 };
  const touching = (i: number, j: number): boolean => {
    const dx = (pos[2 * i] ?? 0) - (pos[2 * j] ?? 0);
    const dy = (pos[2 * i + 1] ?? 0) - (pos[2 * j + 1] ?? 0);
    const min = ((topo.radius[i] ?? 0) + (topo.radius[j] ?? 0)) * pad;
    return dx * dx + dy * dy < min * min;
  };
  const S = topo.segStart.length;
  for (let s = 0; s < S; s++) {
    const start = topo.segStart[s] ?? 0;
    const k = topo.segCount[s] ?? 0;
    const word = plan.segClasses[s] ?? 0;
    const exactLoop = (i: number): number => {
      for (let j = start; j < start + k; j++) if (j !== i && touching(i, j)) partners?.[i]?.push(j);
      return k - 1;
    };
    if (word === 0) {
      for (let i = start; i < start + k; i++) {
        stats.exactSlots++;
        stats.pairTests += exactLoop(i);
      }
      continue;
    }
    const C = planClassCount(word);
    const L = planFirstBinned(word);
    const side = plan.segCellSide[s] ?? 1;
    let ox = Infinity;
    let oy = Infinity;
    for (let i = start; i < start + k; i++) {
      ox = Math.min(ox, pos[2 * i] ?? 0);
      oy = Math.min(oy, pos[2 * i + 1] ?? 0);
    }
    const F = new Int32Array(2 * k);
    for (let i = start; i < start + k; i++) {
      const [fx, fy] = finestCell(pos[2 * i] ?? 0, pos[2 * i + 1] ?? 0, ox, oy, side);
      F[2 * (i - start)] = fx;
      F[2 * (i - start) + 1] = fy;
    }
    const base = plan.segBucketBase[s] ?? 0;
    const mask = plan.segBucketMask[s] ?? 0;
    const bucketOf = (c: number, x: number, y: number): number => base + ((cellHash(c, x, y) & mask) >>> 0);
    const occupants = new Map<number, number[]>();
    for (let i = start; i < start + k; i++) {
      const c = (plan.slotCollide[i] ?? 0) & 15;
      if (c < L) continue;
      const d = C - 1 - c;
      const b = bucketOf(c, (F[2 * (i - start)] ?? 0) >> d, (F[2 * (i - start) + 1] ?? 0) >> d);
      const list = occupants.get(b) ?? [];
      list.push(i); // ascending slot order: the order the MIN rounds enumerate
      occupants.set(b, list);
      stats.binned++;
    }
    for (const list of occupants.values()) {
      stats.maxBucket = Math.max(stats.maxBucket, list.length);
      if (list.length > rounds) stats.overflowBuckets++;
    }
    const list: number[] = [];
    for (let q = 0; q < COLLISION_LIST_MAX; q++) {
      const j = plan.segList[s * COLLISION_LIST_MAX + q] ?? -1;
      if (j >= 0) list.push(j);
    }
    const padOverSide = pad / side;
    for (let i = start; i < start + k; i++) {
      const code = plan.slotCollide[i] ?? 0;
      if ((code & COLLISION_EXACT) !== 0) {
        stats.exactSlots++;
        stats.pairTests += exactLoop(i);
        stats.maxSlotWork = Math.max(stats.maxSlotWork, k - 1);
        continue;
      }
      const fx = F[2 * (i - start)] ?? 0;
      const fy = F[2 * (i - start) + 1] ?? 0;
      const found: number[] = [];
      let lookups = 0;
      let tests = 0;
      let overflow = false;
      for (const j of list) {
        if (j === i) continue;
        tests++;
        if (touching(i, j)) found.push(j);
      }
      for (let c = L; c < C && !overflow; c++) {
        if (!planHasClass(word, c)) continue;
        const d = C - 1 - c;
        const h = searchReach(topo.radius[i] ?? 0, padOverSide, d + refine);
        const x0 = Math.max(fx - Math.ceil(h), 0) >> d;
        const y0 = Math.max(fy - Math.ceil(h), 0) >> d;
        const x1 = Math.min(fx + 1 + Math.floor(h), COLLISION_F_MAX) >> d;
        const y1 = Math.min(fy + 1 + Math.floor(h), COLLISION_F_MAX) >> d;
        if (x1 - x0 + 1 > searchCellsPerAxis(h, d)) throw new Error("collisionTwin: a search wider than its bound");
        for (let cy = y0; cy <= y1 && !overflow; cy++) {
          for (let cx = x0; cx <= x1; cx++) {
            lookups++;
            const occ = occupants.get(bucketOf(c, cx, cy)) ?? [];
            if (occ.length > rounds) {
              overflow = true;
              break;
            }
            for (const j of occ) {
              stats.occupants++;
              const cj = (plan.slotCollide[j] ?? 0) & 15;
              const dj = C - 1 - cj;
              if (cj !== c || (F[2 * (j - start)] ?? 0) >> dj !== cx || (F[2 * (j - start) + 1] ?? 0) >> dj !== cy || j === i) continue;
              tests++;
              if (touching(i, j)) found.push(j);
            }
          }
        }
      }
      stats.lookups += lookups;
      if (overflow) {
        stats.overflowSlots++;
        tests = exactLoop(i);
      } else {
        partners?.[i]?.push(...found);
      }
      stats.pairTests += tests;
      stats.maxSlotWork = Math.max(stats.maxSlotWork, tests + lookups);
    }
  }
  return stats;
}

/** Every slot's touching siblings by brute force (the reference the twin's partners must equal). */
export function bruteForcePartners(topo: TwinTopology, pos: Float32Array, pad: number): number[][] {
  const out: number[][] = Array.from({ length: topo.slotCount }, () => []);
  topo.segStart.forEach((start, s) => {
    const k = topo.segCount[s] ?? 0;
    for (let i = start; i < start + k; i++) {
      for (let j = start; j < start + k; j++) {
        if (i === j) continue;
        const dx = (pos[2 * i] ?? 0) - (pos[2 * j] ?? 0);
        const dy = (pos[2 * i + 1] ?? 0) - (pos[2 * j + 1] ?? 0);
        const min = ((topo.radius[i] ?? 0) + (topo.radius[j] ?? 0)) * pad;
        if (dx * dx + dy * dy < min * min) out[i]?.push(j);
      }
    }
  });
  return out;
}
