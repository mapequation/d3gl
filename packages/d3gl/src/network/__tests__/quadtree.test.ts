import { describe, it, expect, vi, afterEach } from "vitest";
import { BarnesHutTree } from "../quadtree.js";
import { referenceRepulsion } from "./bh-reference.js";

const SOFTENING = 1e-2; // mirrors quadtree.ts: f = rep / (d² + SOFTENING)

/** Direct O(n²) softened repulsion on node `i` — the ground truth a θ=0 tree must reproduce. */
function directForce(pos: Float32Array, n: number, i: number, rep: number): [number, number] {
  let fx = 0;
  let fy = 0;
  const xi = pos[i * 2]!;
  const yi = pos[i * 2 + 1]!;
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const dx = xi - pos[j * 2]!;
    const dy = yi - pos[j * 2 + 1]!;
    const d2 = dx * dx + dy * dy;
    const f = rep / (d2 + SOFTENING);
    fx += f * dx;
    fy += f * dy;
  }
  return [fx, fy];
}

/** Deterministic clustered layout: Gaussian clumps of very different spread over a sparse background. */
function clustered(n: number, seed = 1): Float32Array {
  let s = seed >>> 0;
  const rng = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const gauss = (): number => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
  const centres = Array.from({ length: 12 }, () => [rng() * 2000 - 1000, rng() * 2000 - 1000, 2 + rng() * 120] as const);
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const c = centres[i % 13]; // every 13th body falls in the background
    pos[i * 2] = c ? c[0] + c[2] * gauss() : rng() * 3000 - 1500;
    pos[i * 2 + 1] = c ? c[1] + c[2] * gauss() : rng() * 3000 - 1500;
  }
  return pos;
}

/** Phyllotaxis disc: consecutive ids sit ~137.5° apart, so id order has no spatial locality at all. */
function sunflower(n: number, spacing = 10): Float32Array {
  const pos = new Float32Array(n * 2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = spacing * Math.sqrt(i + 0.5);
    pos[i * 2] = r * Math.cos(i * golden);
    pos[i * 2 + 1] = r * Math.sin(i * golden);
  }
  return pos;
}

/** Every body's repulsion from one tree, via the all-bodies traversal the force layout runs. */
function forces(tree: BarnesHutTree, n: number, rep: number, theta: number): { fx: Float32Array; fy: Float32Array } {
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  tree.applyForces(rep, theta, fx, fy);
  return { fx, fy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BarnesHutTree", () => {
  it("root mass = node count and root COM = centroid", () => {
    const pos = new Float32Array([0, 0, 10, 0, 0, 10, 10, 10]);
    const tree = new BarnesHutTree();
    tree.build(pos, 4);

    expect(tree.rootMass()).toBe(4);
    expect(tree.rootComX()).toBeCloseTo(5);
    expect(tree.rootComY()).toBeCloseTo(5);
  });

  it("θ=0 reproduces direct pairwise repulsion (exact traversal to leaves)", () => {
    const pos = new Float32Array([1, 2, 8, 3, 4, 9, 6, 1, 2, 7]);
    const n = 5;
    const rep = 100;
    const tree = new BarnesHutTree();
    tree.build(pos, n);

    const fx = new Float32Array(n);
    const fy = new Float32Array(n);
    tree.applyForce(0, rep, 0, fx, fy);

    const [dx, dy] = directForce(pos, n, 0, rep);
    expect(fx[0]!).toBeCloseTo(dx, 2);
    expect(fy[0]!).toBeCloseTo(dy, 2);
  });

  it("θ=0.9 repulsion is bit-identical to the pointer-quadtree reference (unit bodies)", () => {
    // Same cells, same opening test, same summation order: the flat preorder layout changes where
    // the tree lives in memory, not one bit of the approximation.
    const n = 4000;
    const pos = clustered(n);
    const tree = new BarnesHutTree();
    tree.build(pos, n);
    const { fx, fy } = forces(tree, n, 200, 0.9);
    const ref = referenceRepulsion(pos, n, 200, 0.9);
    let differing = 0;
    for (let i = 0; i < n; i++) {
      if (fx[i] !== Math.fround(ref.fx[i] ?? NaN) || fy[i] !== Math.fround(ref.fy[i] ?? NaN)) differing++;
    }
    expect(differing).toBe(0);
    expect(tree.rootMass()).toBe(ref.rootMass);
    expect([tree.rootComX(), tree.rootComY()]).toEqual(ref.rootCom);
  });

  it("weighted bodies match the reference to rounding (a multilevel coarse level)", () => {
    const n = 3000;
    const pos = clustered(n, 7);
    const mass = new Float32Array(n).map((_, i) => 1 + (i % 17));
    const tree = new BarnesHutTree();
    tree.build(pos, n, mass);
    const { fx, fy } = forces(tree, n, 200, 0.9);
    const ref = referenceRepulsion(pos, n, 200, 0.9, mass);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const scale = Math.hypot(ref.fx[i] ?? 0, ref.fy[i] ?? 0) + 1e-9;
      worst = Math.max(worst, Math.abs((fx[i] ?? 0) - (ref.fx[i] ?? 0)) / scale, Math.abs((fy[i] ?? 0) - (ref.fy[i] ?? 0)) / scale);
    }
    expect(worst).toBeLessThan(1e-5); // Float32 output rounding; the approximation itself is unchanged
    expect(tree.rootMass()).toBe(ref.rootMass);
  });

  it("applyForces traverses every body exactly once, in the tree's spatial (Z) order", () => {
    // The locality the flat tree is laid out for: consecutive traversals start from neighbouring
    // bodies and open the same cells. Id order on a sunflower disc hops across the whole disc.
    const n = 5000;
    const spacing = 10;
    const pos = sunflower(n, spacing);
    const tree = new BarnesHutTree();
    tree.build(pos, n);
    const visit = vi.spyOn(BarnesHutTree.prototype, "applyForce");
    forces(tree, n, 200, 0.9);
    const order = visit.mock.calls.map((call) => call[0]);
    expect(order.length).toBe(n);
    expect(new Set(order).size).toBe(n);
    const hop = (ids: number[]): number => {
      let sum = 0;
      for (let k = 1; k < ids.length; k++) {
        const a = ids[k - 1] ?? 0;
        const b = ids[k] ?? 0;
        sum += Math.hypot((pos[b * 2] ?? 0) - (pos[a * 2] ?? 0), (pos[b * 2 + 1] ?? 0) - (pos[a * 2 + 1] ?? 0));
      }
      return sum / (ids.length - 1);
    };
    const idHop = hop(Array.from({ length: n }, (_, i) => i));
    // A Z curve steps to a neighbour (~1.8 spacings on this disc) with rare long jumps between quadrants.
    expect(hop(order)).toBeLessThan(4 * spacing);
    expect(hop(order)).toBeLessThan(idHop / 20);
  });

  it("forces do not depend on the body order kept from earlier builds (deterministic)", () => {
    const n = 3000;
    const before = clustered(n, 3);
    const after = clustered(n, 3).map((v, k) => v + 25 * Math.sin(k)); // every body moved
    const warm = new BarnesHutTree();
    warm.build(sunflower(n), n); // an unrelated earlier layout leaves its order behind
    warm.build(before, n);
    warm.build(after, n);
    const cold = new BarnesHutTree();
    cold.build(after, n);
    expect(forces(warm, n, 200, 0.9)).toEqual(forces(cold, n, 200, 0.9));
    expect([warm.rootComX(), warm.rootComY()]).toEqual([cold.rootComX(), cold.rootComY()]);
  });

  it("one tree reused across builds of different sizes matches a fresh tree each time", () => {
    const tree = new BarnesHutTree();
    for (const n of [2000, 150, 2000, 1]) {
      const pos = clustered(n, n);
      tree.build(pos, n);
      const fresh = new BarnesHutTree();
      fresh.build(pos, n);
      expect(forces(tree, n, 200, 0.9)).toEqual(forces(fresh, n, 200, 0.9));
      expect(tree.rootMass()).toBe(n);
    }
  });

  it("coincident bodies (the depth-capped bucket) repel the rest but not each other", () => {
    const n = 46;
    const pos = new Float32Array(n * 2);
    pos.set(clustered(40, 11));
    for (let i = 40; i < n; i++) {
      pos[i * 2] = 5;
      pos[i * 2 + 1] = 5;
    }
    const tree = new BarnesHutTree();
    tree.build(pos, n);
    const { fx, fy } = forces(tree, n, 100, 0);
    for (let i = 0; i < n; i++) {
      const [dx, dy] = directForce(pos, n, i, 100);
      expect(fx[i]).toBeCloseTo(dx, 3);
      expect(fy[i]).toBeCloseTo(dy, 3);
    }
    expect(tree.rootMass()).toBe(n);
  });

  it("near-coincident bodies in depth-capped buckets match the reference, whatever earlier builds left", () => {
    // Clumps of 5 bodies 3-5e-9 apart in a layout ~1 across: closer than a depth-24 cell (~6e-8), yet
    // distinct Float32 positions (the clumps sit below 1e-3, where Float32 resolves ~1e-10), so each
    // bucket really sums different terms. A bucket sums its bodies in the slot order its build left
    // behind (the old tree: newest first); this pins that the order moves the forces by rounding at
    // most, on a fresh tree and on one whose earlier builds left an unrelated order.
    const clumps = 300;
    const per = 5;
    const n = clumps * per;
    let s = 5;
    const rng = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const pos = new Float32Array(n * 2);
    for (let c = 0; c < clumps; c++) {
      const cx = c === 0 ? 1 : rng() * 1e-3;
      const cy = c === 0 ? 1 : rng() * 1e-3;
      for (let j = 0; j < per; j++) {
        pos[(c * per + j) * 2] = cx + j * 3e-9;
        pos[(c * per + j) * 2 + 1] = cy + j * 5e-9;
      }
    }
    const ref = referenceRepulsion(pos, n, 200, 0.9);
    expect(ref.buckets, "the fixture really buckets its clumps").toBeGreaterThan(clumps / 2);
    const cold = new BarnesHutTree();
    cold.build(pos, n);
    const warm = new BarnesHutTree();
    warm.build(sunflower(n), n);
    warm.build(clustered(n, 9), n);
    warm.build(pos, n);
    for (const tree of [cold, warm]) {
      const { fx, fy } = forces(tree, n, 200, 0.9);
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const scale = Math.hypot(ref.fx[i] ?? 0, ref.fy[i] ?? 0) + 1e-9;
        worst = Math.max(worst, Math.abs((fx[i] ?? 0) - (ref.fx[i] ?? 0)) / scale, Math.abs((fy[i] ?? 0) - (ref.fy[i] ?? 0)) / scale);
      }
      expect(worst).toBeLessThan(1e-6);
      expect(tree.rootMass()).toBe(n);
      expect(tree.rootComX()).toBeCloseTo(ref.rootCom[0], 12);
      expect(tree.rootComY()).toBeCloseTo(ref.rootCom[1], 12);
    }
  });

  it("an empty tree and a single body are well defined", () => {
    const tree = new BarnesHutTree();
    tree.build(new Float32Array(0), 0);
    expect(tree.rootMass()).toBe(0);
    expect([tree.rootComX(), tree.rootComY()]).toEqual([0, 0]);
    expect(tree.rootHalf()).toBe(1);
    expect(forces(tree, 0, 200, 0.9).fx.length).toBe(0);

    tree.build(new Float32Array([3, -4]), 1);
    expect(tree.rootMass()).toBe(1);
    expect([tree.rootComX(), tree.rootComY()]).toEqual([3, -4]);
    const { fx, fy } = forces(tree, 1, 200, 0.9);
    expect([fx[0], fy[0]]).toEqual([0, 0]);
  });
});
