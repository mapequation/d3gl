import { describe, it, expect } from "vitest";
import { BarnesHutTree } from "../quadtree.js";

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

describe("BarnesHutTree", () => {
  it("root mass = node count and root COM = centroid", () => {
    const pos = new Float32Array([0, 0, 10, 0, 0, 10, 10, 10]);
    const tree = new BarnesHutTree();
    tree.build(pos, 4);

    expect(tree.rootMass()).toBe(4);
    const [cx, cy] = tree.rootCom();
    expect(cx).toBeCloseTo(5);
    expect(cy).toBeCloseTo(5);
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
});
