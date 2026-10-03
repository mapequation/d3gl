/**
 * Module links as springs in the flat force layouts (#455).
 *
 * A module link (`data(graph, { modules, moduleLinks })`, #199) stands for the leaf links between its two
 * endpoints' members that the input does not carry one by one — an Infomap `.ftree` keeps leaf links only
 * inside bottom modules and every coarser link once, aggregated. The flat solvers pull along the graph's
 * leaf edges only, so without this such a map has no force between its modules at all.
 *
 * Each module link is one spring between the **centroids** of its endpoints' leaves (a leaf endpoint is
 * itself), with the leaf springs' law and `attraction`: a zero-rest linear pull `k · w · (c_b − c_a)`. The
 * force on an endpoint is spread over its members by mass, so each member of a module gets the same
 * acceleration `F / M` and the module moves as one body — the rule a multilevel coarse level applies to a
 * supernode standing for its members (`coarsen.ts`). The weight `w` is the link's flow in leaf-spring units:
 * the multilevel seed's rule for an aggregated spring (`edges / Σ weight` of the graph, see
 * {@link moduleSpringScale}), so a link counts as the leaf links of mean flow it stands for.
 *
 * Module links combine with the graph as the super-edges combine them: both are summed, a link into its own
 * endpoint's ancestor is left out (it lies inside one subtree), and a caller must not repeat links the graph
 * already has (`ModuleLink`). The springs are read off the module tree's own module-link rows
 * (`LODTopology.moduleLinkOffset`, #329), which hold every such link with a module endpoint; a module link
 * between two leaves is in no row, so it is no spring (pass it as a graph edge).
 *
 * Per tick: O(leaves + modules + module links) — one pass up the tree for the centroid sums, one over the
 * springs, one down the tree to hand each module's acceleration to its members. Memory: 5 doubles per module.
 */
import type { LODTopology } from "./lod.js";

/**
 * The module links of a module tree as springs (#455). Tree ids: the leaves (the graph's nodes) are
 * `[0, leafCount)`, the modules `[leafCount, parent.length)`, and every node's parent has a larger id than
 * it (the module tree's id order, `module-topology.ts`), so one ascending pass visits children before their
 * parents. Spring `e` joins tree ids `source[e]` and `target[e]` with weight `weight[e]` (leaf-spring units).
 */
export interface ModuleSprings {
  readonly leafCount: number;
  /** Tree parent per tree id, `-1` for the root. */
  readonly parent: Int32Array;
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  readonly weight: Float32Array;
}

/** The module tree fields the springs are read from. */
export type ModuleLinkTopology = Pick<
  LODTopology,
  "size" | "leafCount" | "parent" | "moduleLinkOffset" | "moduleLinkTarget" | "moduleLinkFlow" | "moduleLinkInOffset" | "moduleLinkInSource" | "moduleLinkInFlow"
>;

/** The graph edges a spring weight is scaled against. */
export interface SpringScaleEdges {
  readonly source: ArrayLike<number>;
  readonly target: ArrayLike<number>;
  readonly weight: ArrayLike<number>;
}

/**
 * Leaf springs per unit of weight: `edges / Σ weight` over `edges`, self-loops left out (they aggregate to
 * nothing), or 0 when they carry no weight. For an unweighted graph an aggregated weight times this is exactly
 * the number of edges it stands for; for a weighted one, that count on average. The multilevel seed normalises
 * its coarse springs by it (`coarseAttractionScale`) and the module springs their flows ({@link moduleSpringScale}).
 */
export function edgeSpringUnit(edges: SpringScaleEdges): number {
  let count = 0;
  let sum = 0;
  for (let e = 0; e < edges.source.length; e++) {
    if (edges.source[e] === edges.target[e]) continue;
    count++;
    sum += edges.weight[e] ?? 0;
  }
  return sum > 0 ? count / sum : 0;
}

/**
 * Leaf-spring units per unit of module-link flow: the graph's {@link edgeSpringUnit}, so a module link of the
 * mean leaf link's flow is one leaf spring. A graph whose edges carry no weight (none at all, or all zero) has
 * no such unit; then the module links' own `count / Σ flow` is used, so a link of their mean flow is one
 * spring. 1 when neither has any weight.
 */
export function moduleSpringScale(edges: SpringScaleEdges, flow: ArrayLike<number>): number {
  const unit = edgeSpringUnit(edges);
  if (unit > 0) return unit;
  let flowSum = 0;
  for (let l = 0; l < flow.length; l++) flowSum += flow[l] ?? 0;
  return flowSum > 0 ? flow.length / flowSum : 1;
}

/**
 * The springs of `topo`'s module links (#455), weighted in leaf-spring units against `edges` (the graph's own,
 * see {@link moduleSpringScale}), or `null` when the tree has none. Each ordered endpoint pair of the rows is
 * one spring (a reciprocal pair is two, as two directed leaf edges are). O(size + module links).
 */
export function moduleSpringsOf(topo: ModuleLinkTopology, edges: SpringScaleEdges): ModuleSprings | null {
  const { size, leafCount, parent } = topo;
  const outOffset = topo.moduleLinkOffset;
  const outTarget = topo.moduleLinkTarget;
  const outFlow = topo.moduleLinkFlow;
  const inOffset = topo.moduleLinkInOffset;
  const inSource = topo.moduleLinkInSource;
  const inFlow = topo.moduleLinkInFlow;
  if (!parent || !outOffset || !outTarget || !outFlow || !inOffset || !inSource || !inFlow) return null;
  // Every row entry is a link with a module endpoint: an out-row entry has a module source; an in-row entry
  // with a leaf source is the rest (one with a module source is that source's out-row entry again).
  let fromLeaves = 0;
  for (let p = 0; p < inSource.length; p++) if (inSource[p]! < leafCount) fromLeaves++;
  const count = outTarget.length + fromLeaves;
  if (count === 0) return null;
  const source = new Uint32Array(count);
  const target = new Uint32Array(count);
  const weight = new Float32Array(count);
  let w = 0;
  const rows = size - leafCount;
  for (let r = 0; r < rows; r++) {
    for (let p = outOffset[r]!; p < outOffset[r + 1]!; p++) {
      source[w] = leafCount + r;
      target[w] = outTarget[p]!;
      weight[w++] = outFlow[p]!;
    }
    for (let p = inOffset[r]!; p < inOffset[r + 1]!; p++) {
      const s = inSource[p]!;
      if (s >= leafCount) continue;
      source[w] = s;
      target[w] = leafCount + r;
      weight[w++] = inFlow[p]!;
    }
  }
  const scale = moduleSpringScale(edges, weight);
  for (let e = 0; e < count; e++) weight[e] = weight[e]! * scale;
  return { leafCount, parent, source, target, weight };
}

/** Throw unless `springs` is for a graph of `nodeCount` nodes. */
export function checkModuleSprings(springs: ModuleSprings, nodeCount: number, who: string): void {
  if (springs.leafCount !== nodeCount) {
    throw new Error(`${who}: module springs are for ${springs.leafCount} leaves, the graph has ${nodeCount} nodes`);
  }
}

/** Each module's summed member mass (`Σ m`, unit masses without `mass`), by module index `g − leafCount`. */
function moduleMasses(springs: ModuleSprings, mass: Float32Array | undefined): Float64Array {
  const { leafCount: n, parent } = springs;
  const total = new Float64Array(parent.length - n);
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    if (p >= n) total[p - n] = total[p - n]! + (mass ? mass[i]! : 1);
  }
  for (let m = 0; m < total.length; m++) {
    const p = parent[n + m]!;
    if (p >= n) total[p - n] = total[p - n]! + total[m]!;
  }
  return total;
}

/**
 * Per leaf, the module springs' stiffness per unit mass it takes part in (#203, #455): `Σ W_A / M_A` over
 * every endpoint `A` that is the leaf or one of its modules, `W_A` the summed weight of `A`'s springs and
 * `M_A` its mass. A module's springs move its members as one body of mass `M_A`, so this is that body's
 * spring gain per unit `attraction` — what {@link springStabilizers} adds to a leaf's own spring degree so a
 * light module on a heavy link cannot integrate oscillatory-unstable. O(leaves + modules + springs).
 */
export function moduleSpringGain(springs: ModuleSprings, mass?: Float32Array): Float32Array {
  const { leafCount: n, parent, source, target, weight } = springs;
  const moduleMass = moduleMasses(springs, mass);
  const moduleGain = new Float64Array(moduleMass.length);
  const gain = new Float32Array(n);
  const add = (g: number, w: number): void => {
    if (g < n) gain[g] = gain[g]! + w / (mass ? mass[g]! : 1);
    else moduleGain[g - n] = moduleGain[g - n]! + w;
  };
  for (let e = 0; e < source.length; e++) {
    add(source[e]!, weight[e]!);
    add(target[e]!, weight[e]!);
  }
  for (let m = 0; m < moduleGain.length; m++) {
    const total = moduleMass[m]!;
    moduleGain[m] = total > 0 ? moduleGain[m]! / total : 0;
  }
  // Down the tree (descending ids: every parent before its children), then onto the leaves.
  for (let m = moduleGain.length - 1; m >= 0; m--) {
    const p = parent[n + m]!;
    if (p >= n) moduleGain[m] = moduleGain[m]! + moduleGain[p - n]!;
  }
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    if (p >= n) gain[i] = gain[i]! + moduleGain[p - n]!;
  }
  return gain;
}

/**
 * The CPU module-spring force (#455): {@link apply} adds each module link's spring to the leaves' force
 * accumulators, as an acceleration shared by every member of an endpoint. Scratch is allocated once, here.
 */
export class ModuleSpringForce {
  private readonly springs: ModuleSprings;
  private readonly mass: Float32Array | undefined;
  /** Summed member mass per module (static). */
  private readonly moduleMass: Float64Array;
  /** Per module: the centroid sums `Σ m·x`, `Σ m·y`, then its members' shared acceleration. */
  private readonly sx: Float64Array;
  private readonly sy: Float64Array;
  private readonly ax: Float64Array;
  private readonly ay: Float64Array;

  constructor(springs: ModuleSprings, mass?: Float32Array) {
    this.springs = springs;
    this.mass = mass;
    this.moduleMass = moduleMasses(springs, mass);
    const k = this.moduleMass.length;
    this.sx = new Float64Array(k);
    this.sy = new Float64Array(k);
    this.ax = new Float64Array(k);
    this.ay = new Float64Array(k);
  }

  /**
   * Add every module link's spring `attraction · w · (c_b − c_a)` to `fx`/`fy` (accelerations, as the
   * solver's accumulators hold): each endpoint's members get the force ÷ the endpoint's mass. O(leaves +
   * modules + springs).
   */
  apply(positions: Float32Array, attraction: number, fx: Float32Array, fy: Float32Array): void {
    const { leafCount: n, parent, source, target, weight } = this.springs;
    const { mass, moduleMass, sx, sy, ax, ay } = this;
    sx.fill(0);
    sy.fill(0);
    ax.fill(0);
    ay.fill(0);
    // Centroid sums up the tree: the leaves into their modules, then every module into its parent.
    for (let i = 0; i < n; i++) {
      const p = parent[i]! - n;
      if (p < 0) continue;
      const m = mass ? mass[i]! : 1;
      sx[p] = sx[p]! + m * positions[i * 2]!;
      sy[p] = sy[p]! + m * positions[i * 2 + 1]!;
    }
    for (let g = 0; g < sx.length; g++) {
      const p = parent[n + g]! - n;
      if (p < 0) continue;
      sx[p] = sx[p]! + sx[g]!;
      sy[p] = sy[p]! + sy[g]!;
    }
    // The springs, as accelerations: a leaf endpoint's straight into its accumulator, a module's shared.
    for (let e = 0; e < source.length; e++) {
      const a = source[e]!;
      const b = target[e]!;
      let xa: number, ya: number, ma: number, xb: number, yb: number, mb: number;
      if (a < n) {
        xa = positions[a * 2]!;
        ya = positions[a * 2 + 1]!;
        ma = mass ? mass[a]! : 1;
      } else {
        ma = moduleMass[a - n]!;
        xa = sx[a - n]! / ma;
        ya = sy[a - n]! / ma;
      }
      if (b < n) {
        xb = positions[b * 2]!;
        yb = positions[b * 2 + 1]!;
        mb = mass ? mass[b]! : 1;
      } else {
        mb = moduleMass[b - n]!;
        xb = sx[b - n]! / mb;
        yb = sy[b - n]! / mb;
      }
      const k = attraction * weight[e]!;
      const dx = k * (xb - xa);
      const dy = k * (yb - ya);
      if (a < n) {
        fx[a] = fx[a]! + dx / ma;
        fy[a] = fy[a]! + dy / ma;
      } else {
        ax[a - n] = ax[a - n]! + dx / ma;
        ay[a - n] = ay[a - n]! + dy / ma;
      }
      if (b < n) {
        fx[b] = fx[b]! - dx / mb;
        fy[b] = fy[b]! - dy / mb;
      } else {
        ax[b - n] = ax[b - n]! - dx / mb;
        ay[b - n] = ay[b - n]! - dy / mb;
      }
    }
    // Down the tree: a module's members share its acceleration and every enclosing module's.
    for (let g = ax.length - 1; g >= 0; g--) {
      const p = parent[n + g]! - n;
      if (p < 0) continue;
      ax[g] = ax[g]! + ax[p]!;
      ay[g] = ay[g]! + ay[p]!;
    }
    for (let i = 0; i < n; i++) {
      const p = parent[i]! - n;
      if (p < 0) continue;
      fx[i] = fx[i]! + ax[p]!;
      fy[i] = fy[i]! + ay[p]!;
    }
  }
}
