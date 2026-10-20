/**
 * Fixtures and checks for the both view's packing (#509), shared by `both-layout.test.ts` and its bench: seeded
 * radii and physical-node sizes, the CSR from those sizes, and grid checks for overlaps and enclosure.
 */
import type { PhysicalToState } from "../state-graph.js";

/** A seeded PRNG (mulberry32): the fixtures are the same on every run. */
export function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The physical → state CSR of physical nodes of the given sizes, state ids in order. */
export function csrOf(sizes: ArrayLike<number>): PhysicalToState {
  const offsets = new Uint32Array(sizes.length + 1);
  for (let p = 0; p < sizes.length; p++) offsets[p + 1] = (offsets[p] ?? 0) + (sizes[p] ?? 0);
  const states = new Uint32Array(offsets[sizes.length] ?? 0);
  for (let s = 0; s < states.length; s++) states[s] = s;
  return { offsets, states };
}

/** Flow-like radii between 2 and 20 size units, most of them small (`2 + 18·u³`). */
export function flowRadii(count: number, rng: () => number): Float32Array {
  const radii = new Float32Array(count);
  for (let s = 0; s < count; s++) radii[s] = 2 + 18 * rng() ** 3;
  return radii;
}

/** Physical-node sizes from a Pareto law of exponent `alpha` (sizes ≥ 1, capped), until they hold `total` state
 *  nodes. At `alpha` 1.18 and cap 5,000 a total of 1,008,000 makes about 218k physical nodes. */
export function paretoSizes(total: number, alpha: number, cap: number, rng: () => number): Uint32Array {
  const sizes: number[] = [];
  let sum = 0;
  while (sum < total) {
    const size = Math.min(cap, total - sum, Math.floor((1 - rng()) ** (-1 / alpha)));
    sizes.push(size);
    sum += size;
  }
  return Uint32Array.from(sizes);
}

/** Physical nodes of 1 or 2 state nodes in the issue's ratio (560k physical nodes for 1,008,000 state nodes). */
export function pairSizes(total: number): Uint32Array {
  const sizes: number[] = [];
  let sum = 0;
  for (let p = 0; sum < total; p++) {
    const size = p % 5 === 0 || sum + 1 === total ? 1 : 2;
    sizes.push(size);
    sum += size;
  }
  return Uint32Array.from(sizes);
}

/** A radius as the packing takes it: a negative or NaN radius is 0. */
function radiusAt(nodeRadii: Float32Array, s: number): number {
  const r = nodeRadii[s] ?? 0;
  return r > 0 ? r : 0;
}

export interface OverlapReport {
  /** Pairs of state nodes in one physical node closer than the sum of their radii. */
  pairs: number;
  /** The largest overlap, `r_i + r_j − distance`, over those pairs. */
  worst: number;
}

/** Count overlapping pairs within each physical node, from the stored float32 offsets: a uniform grid per physical
 *  node of cells twice its largest radius, each state node checked against the 3 × 3 cells round it. */
export function overlaps(offsets: Float32Array, nodeRadii: Float32Array, csr: PhysicalToState): OverlapReport {
  let pairs = 0;
  let worst = 0;
  const cells = new Map<number, number[]>();
  for (let p = 0; p + 1 < csr.offsets.length; p++) {
    const start = csr.offsets[p] ?? 0;
    const end = csr.offsets[p + 1] ?? 0;
    if (end - start < 2) continue;
    let rMax = 0;
    for (let k = start; k < end; k++) rMax = Math.max(rMax, radiusAt(nodeRadii, csr.states[k] ?? 0));
    if (rMax === 0) continue;
    const side = 2 * rMax;
    cells.clear();
    const key = (cx: number, cy: number): number => (cx + 1_048_576) * 2_097_152 + (cy + 1_048_576);
    for (let k = start; k < end; k++) {
      const s = csr.states[k] ?? 0;
      const x = offsets[2 * s] ?? 0;
      const y = offsets[2 * s + 1] ?? 0;
      const r = radiusAt(nodeRadii, s);
      const cx = Math.floor(x / side);
      const cy = Math.floor(y / side);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const o of cells.get(key(cx + dx, cy + dy)) ?? []) {
            const gap = Math.hypot(x - (offsets[2 * o] ?? 0), y - (offsets[2 * o + 1] ?? 0)) - r - radiusAt(nodeRadii, o);
            if (gap < 0) {
              pairs++;
              worst = Math.max(worst, -gap);
            }
          }
        }
      }
      const own = cells.get(key(cx, cy));
      if (own) own.push(s);
      else cells.set(key(cx, cy), [s]);
    }
  }
  return { pairs, worst };
}

/** The largest amount by which a state node reaches past its physical node's radius minus the padding (≤ 0 when
 *  every state node is enclosed). */
export function enclosureExcess(
  offsets: Float32Array,
  nodeRadii: Float32Array,
  physicalRadii: Float32Array,
  csr: PhysicalToState,
  padding: number,
): number {
  let excess = Number.NEGATIVE_INFINITY;
  for (let p = 0; p + 1 < csr.offsets.length; p++) {
    const inner = (physicalRadii[p] ?? 0) - padding;
    for (let k = csr.offsets[p] ?? 0; k < (csr.offsets[p + 1] ?? 0); k++) {
      const s = csr.states[k] ?? 0;
      const reach = Math.hypot(offsets[2 * s] ?? 0, offsets[2 * s + 1] ?? 0) + radiusAt(nodeRadii, s);
      excess = Math.max(excess, reach - inner);
    }
  }
  return excess;
}

/** Each physical node's radius (padding 0) over the radius of a disc holding its state nodes' area at the densest
 *  packing of equal discs (π/√12 ≈ 0.907): a lower bound on any packing's radius, so the ratio bounds the waste.
 *  Mean over the physical nodes of at least `minCount` state nodes, area-weighted. */
export function areaBoundRatio(
  nodeRadii: Float32Array,
  physicalRadii: Float32Array,
  csr: PhysicalToState,
  minCount: number,
): number {
  const density = Math.PI / Math.sqrt(12);
  let weighted = 0;
  let weight = 0;
  for (let p = 0; p + 1 < csr.offsets.length; p++) {
    const start = csr.offsets[p] ?? 0;
    const end = csr.offsets[p + 1] ?? 0;
    if (end - start < minCount) continue;
    let area = 0;
    for (let k = start; k < end; k++) area += radiusAt(nodeRadii, csr.states[k] ?? 0) ** 2;
    if (area === 0) continue;
    weighted += ((physicalRadii[p] ?? 0) / Math.sqrt(area / density)) * area;
    weight += area;
  }
  return weight === 0 ? Number.NaN : weighted / weight;
}
