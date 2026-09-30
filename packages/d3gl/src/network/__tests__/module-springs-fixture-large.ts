/**
 * A large `.ftree`-shaped graph with module springs (#455), for the per-tick guards: `n` leaves in bottom
 * modules of 10, ten bottom modules per middle module, ten middle modules per top module, one root. The graph's
 * edges are rings inside the bottom modules (n edges, as an `.ftree` keeps only those); every module is linked to
 * its next two siblings (both ways), so there are about 4 module links per module — ≈ 0.44·n at every scale.
 * The springs are built straight into {@link ModuleSprings} (the per-tick path reads nothing else), so a
 * 1M-leaf fixture costs no module-tree build.
 */
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleSprings } from "../module-springs.js";

export interface LargeModuleFixture {
  graph: NetworkGraph;
  springs: ModuleSprings;
  /** Leaves of top module `t` (0-based). */
  topLeaves: (t: number) => number[];
}

const FAN = 10;

export function largeModuleFixture(n: number): LargeModuleFixture {
  const bottoms = Math.ceil(n / FAN);
  const mids = Math.ceil(bottoms / FAN);
  const tops = Math.ceil(mids / FAN);
  const bottom0 = n;
  const mid0 = bottom0 + bottoms;
  const top0 = mid0 + mids;
  const root = top0 + tops;
  const parent = new Int32Array(root + 1);
  for (let i = 0; i < n; i++) parent[i] = bottom0 + Math.floor(i / FAN);
  for (let b = 0; b < bottoms; b++) parent[bottom0 + b] = mid0 + Math.floor(b / FAN);
  for (let m = 0; m < mids; m++) parent[mid0 + m] = top0 + Math.floor(m / FAN);
  for (let t = 0; t < tops; t++) parent[top0 + t] = root;
  parent[root] = -1;

  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  const link = (first: number, count: number): void => {
    // Siblings share a parent: `count` consecutive modules from `first`, in groups of FAN.
    for (let k = 0; k < count; k++) {
      const group = Math.floor(k / FAN) * FAN;
      const size = Math.min(FAN, count - group);
      for (const step of [1, 2]) {
        if (step >= size) continue;
        const other = group + ((k - group + step) % size);
        const w = 1 + ((k * 7 + step) % 5);
        source.push(first + k, first + other);
        target.push(first + other, first + k);
        weight.push(w, w);
      }
    }
  };
  link(bottom0, bottoms);
  link(mid0, mids);
  link(top0, tops);
  const springs: ModuleSprings = {
    leafCount: n,
    parent,
    source: Uint32Array.from(source),
    target: Uint32Array.from(target),
    weight: Float32Array.from(weight),
  };

  const es = new Uint32Array(n);
  const et = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / FAN) * FAN;
    const size = Math.min(FAN, n - b);
    es[i] = i;
    et[i] = b + ((i - b + 1) % size);
  }
  const graph = buildGraph({ nodeCount: n, source: es, target: et });
  const perTop = FAN * FAN * FAN;
  const topLeaves = (t: number): number[] => {
    const out: number[] = [];
    for (let i = t * perTop; i < Math.min(n, (t + 1) * perTop); i++) out.push(i);
    return out;
  };
  return { graph, springs, topLeaves };
}
