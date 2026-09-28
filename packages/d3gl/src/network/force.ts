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
  /**
   * Per-node mass, default 1 each. A node of mass `m` repels and is centred like `m` unit nodes
   * standing in its place and accelerates as force ÷ `m` — a multilevel coarse level uses it so a
   * supernode standing for `m` finest nodes claims their equilibrium area (see {@link ./coarsen.js}).
   * Only a coarse level sets it; a {@link NetworkGraph} has none.
   */
  mass?: Float32Array;
  /** Per-edge spring multiplier, parallel to `source`/`target`, default 1 each (a coarse level's aggregated edges). */
  springWeight?: Float32Array;
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
 * Per-tick step ceiling in equilibrium spacings (see {@link stepCap}). Measured on web-NotreDame: a
 * multilevel-seeded run barely touches it (4 or 16 converge alike), while a cold disc start needs the
 * room to untangle — mean edge 631 at 4 spacings vs 599 at 16 after 300 ticks (853 vs 2079 at tick 100).
 */
export const STEP_CAP = 16;
/**
 * Convergence threshold (#124): a layout has converged once its mean per-node step falls below this
 * fraction of the equilibrium spacing (and is not growing). Chosen on web-NotreDame (325k nodes) and
 * LFR 1k / 10k: it stops the large graph within ~120 ticks at better quality than the old fixed 300
 * ticks, and small graphs once their nearest-neighbour spacing has settled.
 */
export const CONVERGED_STEP = 0.06;
/**
 * Ticks a schedule runs before it may count as converged: three velocity relaxation times
 * (`1 / (1 − DAMPING)` ticks each), so a layout that starts close to its equilibrium — a small graph
 * after its multilevel seed — finishes its approach instead of stopping on its first slow ticks.
 */
export const MIN_SETTLE_TICKS = Math.round(3 / (1 - DAMPING));
/** Heat a {@link Cooling.cool} schedule ends its tick budget at. */
export const MIN_HEAT = 0.02;

/**
 * Nearest-neighbour spacing of the force model's equilibrium, `√(π·repulsion/centering)`: 1/d
 * repulsion balanced by linear centering settles into a uniform disc with this much area per node
 * (virial estimate — springs only tighten it). Independent of the node count and the viewport, so it
 * is the natural unit for a seed, the per-tick step cap and the convergence test. `0` when the model
 * has no equilibrium scale (no repulsion or no centering).
 */
export function equilibriumSpacing(params: ForceParams): number {
  const s = Math.sqrt((Math.PI * params.repulsion) / params.centering);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/**
 * The spacing a seed for `n` nodes is laid out at: the force model's {@link equilibriumSpacing}, or —
 * for a model without one — the spacing of a disc filling the viewport.
 */
export function seedSpacing(n: number, width: number, height: number, params: ForceParams): number {
  return equilibriumSpacing(params) || (Math.sqrt(Math.PI) * Math.min(width, height)) / (2 * Math.sqrt(Math.max(n, 1)));
}

/**
 * Per-tick step ceiling: {@link STEP_CAP} equilibrium spacings — a bound in the layout's own units,
 * however dense the start and whatever its extent — or, for a model without a spacing, 4× the
 * starting span.
 */
export function stepCap(spacing: number, span0: number): number {
  return spacing > 0 ? STEP_CAP * spacing : span0 * 4;
}

/** Heat a drag reflows at (every backend): a fraction of a fresh run's, so a large layout doesn't boil. */
export const DRAG_HEAT = 0.3;
/** Tick budget of the re-cool after a drag releases (it stops earlier once converged). */
export const RECOOL_TICKS = 120;

/**
 * The cooling schedule both integrators share (#124): a heat in (0, 1] multiplying `alpha` each
 * tick. {@link cool} decays it geometrically to the floor over a tick budget — a fresh run, a
 * post-drag re-cool — so late ticks settle instead of jittering; {@link hold} keeps it constant (a
 * drag reflow). A new schedule starts at full heat and holds until one is set.
 */
export class Cooling {
  /** Current multiplier on `alpha`. */
  heat = 1;
  private decay = 1;
  private floor = 1;

  /** Decay from `from` to the floor over `ticks` ticks, then stay there. */
  cool(ticks: number, from = 1): void {
    this.heat = from;
    this.floor = Math.min(from, MIN_HEAT);
    this.decay = ticks > 0 ? Math.pow(this.floor / from, 1 / ticks) : 1;
  }

  /** Hold `heat` constant. */
  hold(heat: number): void {
    this.heat = heat;
    this.floor = heat;
    this.decay = 1;
  }

  /** Step the schedule by one tick. */
  next(): void {
    this.heat = Math.max(this.floor, this.heat * this.decay);
  }
}

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
export function springStabilizers(
  nodeCount: number,
  source: Uint32Array,
  target: Uint32Array,
  edgeCount: number,
  params: ForceParams,
  mass?: Float32Array,
  springWeight?: Float32Array,
): Float32Array {
  // Weighted degree ÷ mass: a coarse supernode's spring gain is its summed spring weight per unit mass.
  const deg = new Float32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const w = springWeight ? springWeight[e]! : 1;
    deg[source[e]!]! += w;
    deg[target[e]!]! += w;
  }
  const k = DAMPING * params.alpha * params.attraction;
  const stab = deg; // reuse in place: deg → 1 / (1 + K̃)
  for (let i = 0; i < nodeCount; i++) stab[i] = 1 / (1 + (k * deg[i]!) / (mass ? mass[i]! : 1));
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
  /**
   * The force model's {@link equilibriumSpacing} — the unit of the per-tick step cap and of the
   * convergence test. `0` for a model without one.
   */
  readonly spacing: number;
  /** Reference layout span captured on the first tick; bounds the step only when there is no spacing. */
  private span0 = 0;
  /** Heat schedule multiplying `alpha` (#124). Holds full heat until {@link cool} or {@link run} sets one. */
  private readonly cooling = new Cooling();
  /** Mean per-node step of the last tick (world units); `Infinity` before the first. */
  private step = Infinity;
  /** Mean per-node step of the tick before; 0 before the second (a fresh layout starts at rest). */
  private prevStep = 0;
  /** Ticks since the heat schedule was last set ({@link cool} / {@link hold}). */
  private settleTicks = 0;
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
    this.stab = springStabilizers(n, graph.source, graph.target, graph.edgeCount, this.params, graph.mass, graph.springWeight);
    this.spacing = equilibriumSpacing(this.params);
  }

  /** Mean per-node step of the last tick, in world units (`Infinity` before the first tick). */
  get meanStep(): number {
    return this.step;
  }

  /**
   * Whether the layout has converged (#124): its last tick moved nodes by less than
   * {@link CONVERGED_STEP} of the {@link spacing} on average, and by no more than the tick before (a
   * layout accelerating from rest has small first steps without being settled), at least
   * {@link MIN_SETTLE_TICKS} ticks into the current heat schedule. Always `false` for a model without
   * an equilibrium spacing — that one runs its whole tick budget.
   */
  get converged(): boolean {
    return (
      this.spacing > 0 &&
      this.settleTicks >= MIN_SETTLE_TICKS &&
      this.step < CONVERGED_STEP * this.spacing &&
      this.step <= this.prevStep
    );
  }

  /**
   * Start a cooling schedule: heat `from` (a fraction of `alpha`) decaying geometrically to
   * {@link MIN_HEAT} over `ticks` ticks (see {@link Cooling.cool}). {@link run} calls it; a caller
   * driving {@link tick} itself (the worker's streamed loop, a drag's re-cool) sets it up front.
   */
  cool(ticks: number, from = 1): void {
    this.cooling.cool(ticks, from);
    this.settleTicks = 0;
  }

  /** Hold a constant heat, e.g. {@link DRAG_HEAT} while a drag reflows the layout (see {@link Cooling.hold}). */
  hold(heat: number): void {
    this.cooling.hold(heat);
    this.settleTicks = 0;
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

  /** Advance the simulation one step at the current heat, mutating `graph.positions`. */
  tick(): void {
    const { positions, source, target, nodeCount, edgeCount, mass, springWeight } = this.graph;
    const { repulsion, attraction, centering, theta } = this.params;
    const alpha = this.params.alpha * this.cooling.heat; // the cooled step (#124)
    const { fx, fy, vx, vy, tree } = this;
    fx.fill(0);
    fy.fill(0);

    // Repulsion via Barnes-Hut (O(n log n)): build the tree on the current positions, then
    // accumulate each node's repulsion through the θ-approximated traversal. With masses the tree
    // aggregates them, so each node's repulsion arrives as an acceleration (force ÷ its own mass).
    tree.build(positions, nodeCount, mass);
    // Capture the initial layout span once; it bounds the step for a model without a spacing.
    if (this.span0 === 0) this.span0 = Math.max(2 * tree.rootHalf(), 1);
    for (let i = 0; i < nodeCount; i++) tree.applyForce(i, repulsion, theta, fx, fy);

    // Attraction: a spring along each directed edge pulling its endpoints together.
    if (mass) {
      // Coarse level: an aggregated spring of weight w, as an acceleration on each endpoint's mass.
      for (let e = 0; e < edgeCount; e++) {
        const a = source[e]!;
        const b = target[e]!;
        const k = springWeight ? attraction * springWeight[e]! : attraction;
        const dx = positions[b * 2]! - positions[a * 2]!;
        const dy = positions[b * 2 + 1]! - positions[a * 2 + 1]!;
        const ka = k / mass[a]!;
        const kb = k / mass[b]!;
        fx[a]! += ka * dx;
        fy[a]! += ka * dy;
        fx[b]! -= kb * dx;
        fy[b]! -= kb * dy;
      }
    } else if (springWeight) {
      // Weighted springs on unit-mass nodes (a caller's own LayoutGraph).
      for (let e = 0; e < edgeCount; e++) {
        const a = source[e]!;
        const b = target[e]!;
        const k = attraction * springWeight[e]!;
        const dx = positions[b * 2]! - positions[a * 2]!;
        const dy = positions[b * 2 + 1]! - positions[a * 2 + 1]!;
        fx[a]! += k * dx;
        fy[a]! += k * dy;
        fx[b]! -= k * dx;
        fy[b]! -= k * dy;
      }
    } else {
      // Unit springs: the finest level's loop (also the main-thread drag's per-frame tick), kept free of
      // any per-edge mass / weight lookup.
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
    }

    // Centering: pull every node toward the (mass-weighted) centroid.
    if (nodeCount > 0) {
      let cx = 0;
      let cy = 0;
      if (mass) {
        let total = 0;
        for (let i = 0; i < nodeCount; i++) {
          const m = mass[i]!;
          cx += m * positions[i * 2]!;
          cy += m * positions[i * 2 + 1]!;
          total += m;
        }
        cx /= total;
        cy /= total;
      } else {
        for (let i = 0; i < nodeCount; i++) {
          cx += positions[i * 2]!;
          cy += positions[i * 2 + 1]!;
        }
        cx /= nodeCount;
        cy /= nodeCount;
      }
      for (let i = 0; i < nodeCount; i++) {
        fx[i]! += centering * (cx - positions[i * 2]!);
        fy[i]! += centering * (cy - positions[i * 2 + 1]!);
      }
    }

    // Integrate with velocity Verlet-ish damping (cools toward equilibrium). The per-tick step is
    // clamped to STEP_CAP equilibrium spacings ({@link stepCap}) so a dense start can't fling a node
    // across the layout (or to ±∞ → NaN); far above a settling layout's steps.
    const maxStep = stepCap(this.spacing, this.span0);
    const maxStep2 = maxStep * maxStep;
    const pinned = this.pinned;
    const stab = this.stab;
    let moved = 0; // Σ step lengths, for the convergence test
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
        moved += maxStep;
      } else {
        moved += Math.sqrt(len2);
      }
      vx[i] = sx;
      vy[i] = sy;
      positions[i * 2] = positions[i * 2]! + sx;
      positions[i * 2 + 1] = positions[i * 2 + 1]! + sy;
    }
    this.prevStep = Number.isFinite(this.step) ? this.step : 0;
    this.step = nodeCount > 0 ? moved / nodeCount : 0;
    this.settleTicks++;
    this.cooling.next();
  }

  /**
   * Solve for at most `iterations` ticks, stopping as soon as the layout has {@link converged} (#124)
   * — `iterations` is the maximum, not a fixed count. Returns the ticks run.
   *
   * `"hot"` (the default, as before #124) keeps full heat, which a cold disc start needs to untangle —
   * cooling a random start freezes it half-way (web-NotreDame: mean edge 968 vs 599 after 300 ticks)
   * — so it stops only once the layout settles on its own. A call shorter than
   * {@link MIN_SETTLE_TICKS} never counts as converged, so batched `run(n)` calls tick exactly `n`
   * times at full heat each. `"cool"` decays the heat over the budget: for a seeded layout
   * (multilevel, or a drag's re-cool) that already has its global arrangement.
   */
  run(iterations: number, schedule: "cool" | "hot" = "hot"): number {
    if (schedule === "cool") this.cool(iterations);
    else this.hold(1);
    let ticks = 0;
    while (ticks < iterations) {
      this.tick();
      ticks++;
      if (this.converged) break;
    }
    return ticks;
  }
}

/** Options for {@link seedPositions}. */
export interface SeedOptions {
  /**
   * Size the disc to this force model's equilibrium (merged over {@link DEFAULT_FORCE}): radius
   * `√(repulsion·N/centering)`, the scale {@link ForceLayout} converges to, so a layout started from
   * the seed neither explodes nor collapses. Still centred on the viewport. A model without an
   * equilibrium scale (no repulsion or no centering) falls back to the viewport disc.
   */
  force?: Partial<ForceParams>;
}

/**
 * Seed node positions deterministically as a phyllotaxis ("sunflower") disc centred on the
 * viewport — a good, reproducible starting distribution for {@link ForceLayout} when a graph
 * arrives without coordinates (no two nodes coincident, no RNG). Without `opts` the disc fills the
 * viewport (radius `min(width, height) / 2`); with `opts` it is sized to the force model's
 * equilibrium (see {@link SeedOptions.force}).
 */
export function seedPositions(graph: LayoutGraph, width: number, height: number, opts?: SeedOptions): void {
  const n = graph.nodeCount;
  const cx = width / 2;
  const cy = height / 2;
  // A phyllotaxis disc with radius step `scale·√i` gives each node an area of π·scale²; the seed
  // spacing is √π·scale (the viewport disc's own spacing when there is no equilibrium).
  const scale = opts
    ? seedSpacing(n, width, height, { ...DEFAULT_FORCE, ...opts.force }) / Math.sqrt(Math.PI)
    : Math.min(width, height) / (2 * Math.sqrt(Math.max(n, 1)));
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = scale * Math.sqrt(i + 0.5);
    const a = i * golden;
    graph.positions[i * 2] = cx + r * Math.cos(a);
    graph.positions[i * 2 + 1] = cy + r * Math.sin(a);
  }
}
