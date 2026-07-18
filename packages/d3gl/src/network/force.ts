import { BarnesHutTree } from "./quadtree.js";

/**
 * Minimal graph view the force core needs: node count, a directed edge list (used as undirected
 * springs), and the positions buffer it mutates. {@link NetworkGraph} satisfies this structurally,
 * and so does a synthetic coarse level (see {@link ./coarsen.js}) — so one force core lays out the
 * full graph *and* every coarsening level without casts.
 */
export interface LayoutGraph {
  nodeCount: number;
  edgeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  /** Interleaved `[x, y, …]`, length `2 * nodeCount`; mutated in place by the layout. */
  positions: Float32Array;
}

/**
 * Force-directed layout core (sub-issue #102, epic #98). Operates directly on a
 * {@link LayoutGraph}'s positions buffer + edge list — pure typed-array math, no DOM, so it runs
 * unchanged on the main thread or inside a Web Worker (the worker + SharedArrayBuffer transport
 * land in a later slice). Repulsion is Barnes-Hut O(n log n) via {@link BarnesHutTree}.
 */
export interface ForceParams {
  /** Repulsion (charge) strength between all node pairs. */
  repulsion: number;
  /** Spring attraction strength along edges. */
  attraction: number;
  /**
   * Positional gravity: each node is pulled toward the layout centroid ∝ its distance. Besides
   * keeping the layout from drifting, this is the main knob against loosely-connected clusters
   * flying far apart — unbounded pairwise repulsion otherwise pushes whole clusters out of frame
   * (a single bridge edge can't pull them back). Higher = tighter inter-cluster spacing.
   */
  centering: number;
  /** Integration step size. */
  alpha: number;
  /** Barnes-Hut opening angle θ — 0 is exact O(n²); ~0.9 trades a little accuracy for speed. */
  theta: number;
}

export const DEFAULT_FORCE: ForceParams = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.2, theta: 0.9 };

/** Velocity damping applied each integration step (shared with the GPU integrate pass). */
export const DAMPING = 0.9;

/**
 * Per-node spring-stiffness stabilizer (#203). A node with per-tick spring gain
 * `K̃ = damping·alpha·attraction·degree` integrates its spring force explicitly; for
 * `K̃ ≳ 2` the damped integrator's spring mode turns oscillatory-unstable (amplitude grows
 * every tick), so a high-degree hub — e.g. LFR max degree 3√n, doubled by reciprocal
 * directed edge pairs — ejects itself and its cluster ballistically ("square layout"
 * runaway, #203). Dividing the velocity update by `1 + K̃` treats the node's aggregate
 * spring semi-implicitly: the linearised mode is stable for EVERY `K̃ ≥ 0` (trace/det
 * check: |T| = 1.9/(1+K̃) ≤ 1 + 0.9/(1+K̃) ⇔ K̃ ≥ 0), equilibria are unchanged (the
 * factor scales velocity, not the force balance), and low-degree nodes are barely
 * touched (deg 10 at defaults → factor 1/1.009). Effectively hubs get "heavier"
 * (ForceAtlas2-style degree mass) exactly in proportion to their spring stiffness.
 */
export function springStabilizers(nodeCount: number, source: Uint32Array, target: Uint32Array, edgeCount: number, params: ForceParams): Float32Array {
  const deg = new Float32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    deg[source[e]!]! += 1;
    deg[target[e]!]! += 1;
  }
  const k = DAMPING * params.alpha * params.attraction;
  const stab = deg; // reuse in place: deg → 1 / (1 + K̃)
  for (let i = 0; i < nodeCount; i++) stab[i] = 1 / (1 + k * deg[i]!);
  return stab;
}

export class ForceLayout {
  private readonly params: ForceParams;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly fx: Float32Array;
  private readonly fy: Float32Array;
  /** Per-node `1/(1+K̃)` spring-stiffness stabilizer (see {@link springStabilizers}). */
  private readonly stab: Float32Array;
  private readonly tree = new BarnesHutTree();
  /** Reference layout span captured on the first tick; bounds the per-tick step (see {@link tick}). */
  private span0 = 0;
  /**
   * Per-node pinned flag (1 = held). A pinned node is **skipped by integration** — its position is
   * owned externally (the drag session sets it to the cursor each frame, #140) — but it still acts as
   * a fixed obstacle (it's in the Barnes-Hut tree, so it repels) and its springs still pull neighbours
   * toward it. `null` until {@link setPinned} is first called, so the common no-drag run allocates nothing.
   */
  private pinned: Uint8Array | null = null;

  constructor(
    private readonly graph: LayoutGraph,
    params: Partial<ForceParams> = {},
  ) {
    this.params = { ...DEFAULT_FORCE, ...params };
    const n = graph.nodeCount;
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.stab = springStabilizers(n, graph.source, graph.target, graph.edgeCount, this.params);
  }

  /**
   * Set the held (pinned) node set for an interactive drag (#140), replacing any previous one. Pinned
   * nodes are left where the caller put them — {@link tick} won't move them — so the drag session can
   * hold them exactly under the cursor while the rest of the layout reheats around them. Pass `null`
   * (or an empty iterable) to release every pin. Allocates the flag array lazily on first use.
   */
  setPinned(ids: Iterable<number> | null): void {
    if (!ids) { this.pinned?.fill(0); return; }
    const flags = (this.pinned ??= new Uint8Array(this.graph.nodeCount));
    flags.fill(0);
    for (const id of ids) if (id >= 0 && id < flags.length) flags[id] = 1;
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
    // Capture the initial layout span once; it scales the per-tick displacement clamp below.
    if (this.span0 === 0) this.span0 = Math.max(2 * tree.rootHalf(), 1);
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

    // Integrate with velocity Verlet-ish damping (cools toward equilibrium). The per-tick step is
    // clamped to a multiple of the initial span so a pathological force (e.g. a dense coarse level)
    // can't fling a node to ±∞ and poison the layout with NaN; far above any normal displacement.
    const maxStep = this.span0 * 4;
    const maxStep2 = maxStep * maxStep;
    const pinned = this.pinned;
    const stab = this.stab;
    for (let i = 0; i < nodeCount; i++) {
      // Held nodes (#140) are positioned externally each frame — don't integrate them (and drop any
      // velocity so they don't lurch when released). They still repel + anchor springs via the passes above.
      if (pinned && pinned[i]) { vx[i] = 0; vy[i] = 0; continue; }
      // Per-node semi-implicit spring stabilizer (#203): divide by 1 + K̃ so a hub's aggregate
      // spring stiffness can never turn the integration oscillatory-unstable. See springStabilizers.
      const s = stab[i]!;
      let sx = (vx[i]! + fx[i]! * alpha) * DAMPING * s;
      let sy = (vy[i]! + fy[i]! * alpha) * DAMPING * s;
      // Isotropic per-tick step clamp (#203): scale the step VECTOR, never each axis — a
      // component-wise clamp maps every large step onto the boundary of a square, so runaway
      // nodes travel at exactly ±45° and pile up in the four corners of an axis-aligned box.
      const len2 = sx * sx + sy * sy;
      if (len2 > maxStep2) {
        const k = maxStep / Math.sqrt(len2);
        sx *= k;
        sy *= k;
      }
      vx[i] = sx;
      vy[i] = sy;
      positions[i * 2] = positions[i * 2]! + sx;
      positions[i * 2 + 1] = positions[i * 2 + 1]! + sy;
    }
  }

  /** Run `iterations` ticks. */
  run(iterations: number): void {
    for (let i = 0; i < iterations; i++) this.tick();
  }
}

/**
 * Seed node positions deterministically as a phyllotaxis ("sunflower") disc centred on the
 * viewport — a good, reproducible starting distribution for {@link ForceLayout} when a graph
 * arrives without coordinates (no two nodes coincident, no RNG).
 */
export function seedPositions(graph: LayoutGraph, width: number, height: number): void {
  const n = graph.nodeCount;
  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height) / (2 * Math.sqrt(Math.max(n, 1)));
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = scale * Math.sqrt(i + 0.5);
    const a = i * golden;
    graph.positions[i * 2] = cx + r * Math.cos(a);
    graph.positions[i * 2 + 1] = cy + r * Math.sin(a);
  }
}
