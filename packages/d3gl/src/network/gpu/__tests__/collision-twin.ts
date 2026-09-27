/**
 * A CPU twin of one collision step's pair search on the radius-class grid (#380): the cell pass's
 * binning, the bucket hashes of class cells and of the dense cells' sub-cells, the K-occupant rounds and
 * the gather's visits, in the same order as `passes/collision.ts`. It reports what the GPU gather would
 * do — the cells it visits, the occupants it reads, the pairs it tests and which slots fall back to an
 * exact loop — and each slot's touching partners, so a node test can check the search is complete against
 * brute force. Test helper only.
 */
import {
  COLLISION_EXACT,
  COLLISION_F_MAX,
  COLLISION_LIST_MAX,
  COLLISION_SUB_SHIFT,
  cellHash,
  planClassCount,
  planFirstBinned,
  planHasClass,
  planSubBuckets,
  searchCellsPerAxis,
  searchReach,
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
  /** Class cells visited by grid searches, and the sub-cells of dense ones among them. */
  visits: number;
  subVisits: number;
  /** Pair tests: bucket occupants read, list entries and exact-loop partners. */
  pairTests: number;
  /** Slots that take the exact loop because the plan says so (a large disc among small ones, or a small segment). */
  exactSlots: number;
  /** Grid slots sent to an exact loop by a sub-cell with more than K occupants. */
  overflowSlots: number;
  /** Class-cell buckets with more than K occupants (refined into sub-cells), and the largest one. */
  denseBuckets: number;
  maxBucket: number;
  /** The largest sub-cell bucket. */
  maxSubBucket: number;
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
  const stats: TwinStats = { binned: 0, visits: 0, subVisits: 0, pairTests: 0, exactSlots: 0, overflowSlots: 0, denseBuckets: 0, maxBucket: 0, maxSubBucket: 0 };
  const refine = plan.refine;
  const touching = (i: number, j: number): boolean => {
    const dx = (pos[2 * i] ?? 0) - (pos[2 * j] ?? 0);
    const dy = (pos[2 * i + 1] ?? 0) - (pos[2 * j + 1] ?? 0);
    const min = ((topo.radius[i] ?? 0) + (topo.radius[j] ?? 0)) * pad;
    return dx * dx + dy * dy < min * min;
  };
  const push = (map: Map<number, number[]>, b: number, j: number): void => {
    const list = map.get(b) ?? [];
    list.push(j); // ascending slot order: the order the MIN rounds enumerate
    map.set(b, list);
  };
  topo.segStart.forEach((start, s) => {
    const k = topo.segCount[s] ?? 0;
    const word = plan.segClasses[s] ?? 0;
    const exactLoop = (i: number): void => {
      for (let j = start; j < start + k; j++) if (j !== i && touching(i, j)) partners?.[i]?.push(j);
      stats.pairTests += k - 1;
    };
    if (word === 0) {
      for (let i = start; i < start + k; i++) {
        stats.exactSlots++;
        exactLoop(i);
      }
      return;
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
    // The cell pass: every slot's finest sub-cell F (its class cell is F >> shift, its sub-cell F >> shift − SUB).
    const F = new Int32Array(2 * k);
    for (let i = start; i < start + k; i++) {
      F[2 * (i - start)] = Math.min(COLLISION_F_MAX, Math.max(0, Math.floor(Math.fround(Math.fround((pos[2 * i] ?? 0) - ox) / side))));
      F[2 * (i - start) + 1] = Math.min(COLLISION_F_MAX, Math.max(0, Math.floor(Math.fround(Math.fround((pos[2 * i + 1] ?? 0) - oy) / side))));
    }
    const fx = (i: number): number => F[2 * (i - start)] ?? 0;
    const fy = (i: number): number => F[2 * (i - start) + 1] ?? 0;
    const classOf = (i: number): number => (plan.slotCollide[i] ?? 0) & 15;
    const shiftOf = (c: number): number => C - 1 - c + COLLISION_SUB_SHIFT;
    const base = plan.segBucketBase[s] ?? 0;
    const mask = plan.segBucketMask[s] ?? 0;
    const subBase = plan.segSubBase[s] ?? 0;
    const subMask = planSubBuckets(word) - 1;
    const bucketOf = (c: number, x: number, y: number): number => base + ((cellHash(c, x, y) & mask) >>> 0);
    const subBucketOf = (c: number, x: number, y: number): number => subBase + ((cellHash(c + 16, x, y) & subMask) >>> 0);
    const cells = new Map<number, number[]>();
    for (let i = start; i < start + k; i++) {
      const c = classOf(i);
      if (c < L) continue;
      push(cells, bucketOf(c, fx(i) >> shiftOf(c), fy(i) >> shiftOf(c)), i);
      stats.binned++;
    }
    // Dense class-cell buckets: their occupants are binned again by sub-cell.
    const subCells = new Map<number, number[]>();
    for (const occ of cells.values()) {
      stats.maxBucket = Math.max(stats.maxBucket, occ.length);
      if (occ.length <= rounds) continue;
      stats.denseBuckets++;
      for (const j of occ) {
        const c = classOf(j);
        const sub = shiftOf(c) - COLLISION_SUB_SHIFT;
        push(subCells, subBucketOf(c, fx(j) >> sub, fy(j) >> sub), j);
      }
    }
    for (const occ of subCells.values()) stats.maxSubBucket = Math.max(stats.maxSubBucket, occ.length);
    const list: number[] = [];
    for (let q = 0; q < COLLISION_LIST_MAX; q++) {
      const j = plan.segList[s * COLLISION_LIST_MAX + q] ?? -1;
      if (j >= 0) list.push(j);
    }
    const padOverSide = pad / side;
    for (let i = start; i < start + k; i++) {
      if (((plan.slotCollide[i] ?? 0) & COLLISION_EXACT) !== 0) {
        stats.exactSlots++;
        exactLoop(i);
        continue;
      }
      const found: number[] = [];
      let overflow = false;
      for (const j of list) {
        if (j === i) continue;
        stats.pairTests++;
        if (touching(i, j)) found.push(j);
      }
      for (let c = L; c < C && !overflow; c++) {
        if (!planHasClass(word, c)) continue;
        const shift = shiftOf(c);
        const sub = shift - COLLISION_SUB_SHIFT;
        const h = searchReach(topo.radius[i] ?? 0, padOverSide, shift + refine);
        const x0 = Math.max(fx(i) - Math.ceil(h), 0) >> shift;
        const y0 = Math.max(fy(i) - Math.ceil(h), 0) >> shift;
        const x1 = Math.min(fx(i) + 1 + Math.floor(h), COLLISION_F_MAX) >> shift;
        const y1 = Math.min(fy(i) + 1 + Math.floor(h), COLLISION_F_MAX) >> shift;
        if (x1 - x0 + 1 > searchCellsPerAxis(h, shift)) throw new Error("collisionTwin: a search wider than its bound");
        const keep = (j: number, at: number, x: number, y: number): void => {
          stats.pairTests++;
          if (j === i || classOf(j) !== c || fx(j) >> at !== x || fy(j) >> at !== y) return;
          if (touching(i, j)) found.push(j);
        };
        for (let cy = y0; cy <= y1 && !overflow; cy++) {
          for (let cx = x0; cx <= x1 && !overflow; cx++) {
            stats.visits++;
            const occ = cells.get(bucketOf(c, cx, cy)) ?? [];
            if (occ.length <= rounds) {
              for (const j of occ) keep(j, shift, cx, cy);
              continue;
            }
            // A dense cell: its sub-cells, in the sub-cell table.
            const n = 1 << COLLISION_SUB_SHIFT;
            for (let sy = 0; sy < n && !overflow; sy++) {
              for (let sx = 0; sx < n; sx++) {
                stats.subVisits++;
                const x = cx * n + sx;
                const y = cy * n + sy;
                const subOcc = subCells.get(subBucketOf(c, x, y)) ?? [];
                if (subOcc.length > rounds) {
                  overflow = true;
                  break;
                }
                for (const j of subOcc) keep(j, sub, x, y);
              }
            }
          }
        }
      }
      if (overflow) {
        stats.overflowSlots++;
        exactLoop(i);
      } else {
        partners?.[i]?.push(...found);
      }
    }
  });
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
