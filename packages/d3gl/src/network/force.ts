import type { NetworkGraph } from "./graph.js";
import { BarnesHutTree } from "./quadtree.js";

/**
 * Force-directed layout core (sub-issue #102, epic #98). Operates directly on a
 * {@link NetworkGraph}'s positions buffer + CSR — pure typed-array math, no DOM, so it runs
 * unchanged on the main thread or inside a Web Worker (the worker + SharedArrayBuffer transport
 * land in later slices). This first version uses O(n²) repulsion; a Barnes-Hut quadtree replaces
 * the pairwise loop next.
 */
export interface ForceParams {
  /** Repulsion (charge) strength between all node pairs. */
  repulsion: number;
  /** Spring attraction strength along edges. */
  attraction: number;
  /** Pull toward the centroid (keeps the layout from drifting / flying apart). */
  centering: number;
  /** Integration step size. */
  alpha: number;
  /** Barnes-Hut opening angle θ — 0 is exact O(n²); ~0.9 trades a little accuracy for speed. */
  theta: number;
}

export const DEFAULT_FORCE: ForceParams = { repulsion: 200, attraction: 0.05, centering: 0.01, alpha: 0.2, theta: 0.9 };

export class ForceLayout {
  private readonly params: ForceParams;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly fx: Float32Array;
  private readonly fy: Float32Array;
  private readonly tree = new BarnesHutTree();

  constructor(
    private readonly graph: NetworkGraph,
    params: Partial<ForceParams> = {},
  ) {
    this.params = { ...DEFAULT_FORCE, ...params };
    const n = graph.nodeCount;
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
  }

  /** Advance the simulation one step, mutating `graph.positions`. */
  tick(): void {
    const { positions, source, target, nodeCount, edgeCount } = this.graph;
    const { repulsion, attraction, centering, alpha, theta } = this.params;
    const { fx, fy, vx, vy, tree } = this;
    fx.fill(0);
    fy.fill(0);

    // Repulsion via Barnes-Hut (O(n log n)): build the tree on the current positions, then
    // accumulate each node's repulsion through the θ-approximated traversal.
    tree.build(positions, nodeCount);
    for (let i = 0; i < nodeCount; i++) tree.applyForce(i, repulsion, theta, fx, fy);

    // Attraction: a spring along each directed edge pulling its endpoints together.
    for (let e = 0; e < edgeCount; e++) {
      const a = source[e]!;
      const b = target[e]!;
      const dx = positions[b * 2]! - positions[a * 2]!;
      const dy = positions[b * 2 + 1]! - positions[a * 2 + 1]!;
      fx[a]! += attraction * dx;
      fy[a]! += attraction * dy;
      fx[b]! -= attraction * dx;
      fy[b]! -= attraction * dy;
    }

    // Centering: pull every node toward the centroid.
    if (nodeCount > 0) {
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < nodeCount; i++) {
        cx += positions[i * 2]!;
        cy += positions[i * 2 + 1]!;
      }
      cx /= nodeCount;
      cy /= nodeCount;
      for (let i = 0; i < nodeCount; i++) {
        fx[i]! += centering * (cx - positions[i * 2]!);
        fy[i]! += centering * (cy - positions[i * 2 + 1]!);
      }
    }

    // Integrate with velocity Verlet-ish damping (cools toward equilibrium).
    const damping = 0.9;
    for (let i = 0; i < nodeCount; i++) {
      vx[i] = (vx[i]! + fx[i]! * alpha) * damping;
      vy[i] = (vy[i]! + fy[i]! * alpha) * damping;
      positions[i * 2] = positions[i * 2]! + vx[i]!;
      positions[i * 2 + 1] = positions[i * 2 + 1]! + vy[i]!;
    }
  }

  /** Run `iterations` ticks. */
  run(iterations: number): void {
    for (let i = 0; i < iterations; i++) this.tick();
  }
}
