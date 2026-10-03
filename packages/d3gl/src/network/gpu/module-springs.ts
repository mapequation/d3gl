import type { Device, Framebuffer, RenderPass, SamplerProps, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import type { ModuleSprings } from "../module-springs.js";
import { SegmentedReduce, segmentedReducePrograms, type ReduceMap } from "./passes/segmented-reduce.js";
import { SegmentTable, type SegmentRow } from "./segment-table.js";
import { GpuSprings, springPrograms, type SpringEdges } from "./springs.js";
import { hasHubRows } from "./hub-chunks.js";
import { ADDITIVE_BLEND, NO_BLEND, beginPass, fullScreenProgram, layoutModel, type PassUniforms } from "./passes/fullscreen.js";
import { SLOT_TEXEL_GLSL, atlasWidth } from "./textures.js";
import type { LayoutProgram } from "./programs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Module-link springs on the GPU (#455) — the flat solver's twin of the CPU `ModuleSpringForce`.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every module link is a spring between its endpoints' member centroids; each endpoint's members share its
// acceleration. Per tick, four small passes (none of them allocates):
//
// 1. Centroids — the #349 segmented reduction, over the leaves in **tree order** (a leaf order in which
//    every module's leaves are contiguous): its level-0 map fetches leaf `order[s]`'s position, and one
//    range per spring endpoint (a module's leaf range; a leaf endpoint's single slot) sums `(Σx, Σy, ·, n)`.
// 2. `stats → centroid` per endpoint (one fragment each).
// 3. The springs between the endpoints — the flat springs' CSR gather (#350, with its hub chunks) over the
//    endpoint graph, each row scaled by `1 / n` once at build, so an endpoint's sum is its acceleration.
// 4. Onto the leaves — in the force pass, after centering: each leaf adds the acceleration of every endpoint
//    that is it or encloses it, walking the chain of enclosing endpoints (at most `maxChain` of them).
//
// The finest level has unit masses, so an endpoint's mass is its leaf count, as on the CPU.

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };
/** "No endpoint" in the chain textures. */
const NONE = 0xffffffff;

/**
 * The GPU layout of a graph's {@link ModuleSprings} — pure, so it is node-tested. Endpoints are the tree ids
 * a spring touches, indexed in first-seen order.
 */
export interface ModuleSpringPlan {
  /** Leaves (the graph's nodes). */
  readonly leafCount: number;
  /** Leaf ids in tree order: every module's leaves are contiguous. */
  readonly order: Uint32Array;
  /** Per endpoint: its first slot in {@link order} and its leaf count (its mass). */
  readonly rangeStart: Uint32Array;
  readonly rangeCount: Uint32Array;
  /** The springs between endpoints: endpoint indices and weights. */
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  readonly weight: Float32Array;
  /** Per endpoint: `1 / leaf count` — its CSR row's scale, so the row's sum is an acceleration. */
  readonly rowScale: Float32Array;
  /** Per endpoint: its springs' count (its CSR row length). */
  readonly degree: Uint32Array;
  /** Per leaf: the innermost endpoint that is it or encloses it, or {@link NONE}. */
  readonly leafEndpoint: Uint32Array;
  /** Per endpoint: the innermost endpoint strictly enclosing it, or {@link NONE}. */
  readonly endpointParent: Uint32Array;
  /** The most endpoints on any leaf's chain — the distribution pass's loop bound. */
  readonly maxChain: number;
}

/** Plan `springs` for the GPU (#455). O(tree size + springs). */
export function moduleSpringPlan(springs: ModuleSprings): ModuleSpringPlan {
  const { leafCount: n, parent, source: treeSource, target: treeTarget, weight } = springs;
  const size = parent.length;
  // Leaves per tree node, up the tree (ascending ids: children before parents).
  const leaves = new Uint32Array(size);
  for (let g = 0; g < size; g++) {
    if (g < n) leaves[g] = 1;
    const p = parent[g]!;
    if (p >= 0) leaves[p] = leaves[p]! + leaves[g]!;
  }
  // First slot per tree node, down the tree (descending ids: parents before children): each node takes the
  // next range of its parent's, and a root the next range after the roots before it.
  const first = new Uint32Array(size);
  const cursor = new Uint32Array(size);
  let rootCursor = 0;
  for (let g = size - 1; g >= 0; g--) {
    const p = parent[g]!;
    if (p >= 0) {
      first[g] = cursor[p]!;
      cursor[p] = cursor[p]! + leaves[g]!;
    } else {
      first[g] = rootCursor;
      rootCursor += leaves[g]!;
    }
    cursor[g] = first[g]!;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[first[i]!] = i;

  // Endpoints, in first-seen order, and the springs between them.
  const endpointOf = new Int32Array(size).fill(-1);
  const endpoints: number[] = [];
  const endpoint = (g: number): number => {
    let e = endpointOf[g]!;
    if (e < 0) {
      e = endpoints.length;
      endpointOf[g] = e;
      endpoints.push(g);
    }
    return e;
  };
  const m = treeSource.length;
  const source = new Uint32Array(m);
  const target = new Uint32Array(m);
  for (let e = 0; e < m; e++) {
    source[e] = endpoint(treeSource[e]!);
    target[e] = endpoint(treeTarget[e]!);
  }
  const count = endpoints.length;
  const rangeStart = new Uint32Array(count);
  const rangeCount = new Uint32Array(count);
  const rowScale = new Float32Array(count);
  const degree = new Uint32Array(count);
  endpoints.forEach((g, e) => {
    rangeStart[e] = first[g]!;
    rangeCount[e] = leaves[g]!;
    rowScale[e] = 1 / Math.max(1, leaves[g]!);
  });
  for (let e = 0; e < m; e++) {
    degree[source[e]!] = degree[source[e]!]! + 1;
    degree[target[e]!] = degree[target[e]!]! + 1;
  }

  // The innermost endpoint at or above every tree node, down the tree; then each endpoint's enclosing one
  // and the longest chain.
  const nearest = new Uint32Array(size).fill(NONE);
  for (let g = size - 1; g >= 0; g--) {
    const e = endpointOf[g]!;
    const p = parent[g]!;
    nearest[g] = e >= 0 ? e : p >= 0 ? nearest[p]! : NONE;
  }
  const leafEndpoint = nearest.slice(0, n);
  const endpointParent = new Uint32Array(count);
  const chain = new Uint32Array(count);
  let maxChain = 0;
  // Enclosing endpoints have larger tree ids, so descending tree id visits them first.
  for (let g = size - 1; g >= 0; g--) {
    const e = endpointOf[g]!;
    if (e < 0) continue;
    const p = parent[g]!;
    const up = p >= 0 ? nearest[p]! : NONE;
    endpointParent[e] = up;
    chain[e] = up === NONE ? 1 : chain[up]! + 1;
    if (chain[e]! > maxChain) maxChain = chain[e]!;
  }
  return { leafCount: n, order, rangeStart, rangeCount, source, target, weight, rowScale, degree, leafEndpoint, endpointParent, maxChain };
}

/** The centroid reduction's level-0 map: slot s → leaf `order[s]`'s `(x, y, 0, 1)` and box term. */
const MODULE_REDUCE_MAP: ReduceMap = {
  glsl: /* glsl */ `\
uniform highp usampler2D u_order; // leaf id per slot, in tree order (the slot atlas)
void mapSlot(int s, out vec4 sum, out vec4 box) {
  if (s >= u_count) { sum = vec4(0.0); box = BOX_IDENTITY; return; }
  int leaf = int(texelFetch(u_order, slotTexel(s, u_posWidth), 0).r);
  vec2 p = texelFetch(u_pos, slotTexel(leaf, u_posWidth), 0).xy;
  sum = vec4(p, 0.0, 1.0);
  box = vec4(p, -p);
}
`,
};

/** Endpoint stats → centroid (one fragment per endpoint, no blend). */
const CENTROID_FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_stats; // (Σx, Σy, ·, n) per endpoint
uniform int u_count;
uniform int u_width;
layout(location = 0) out vec2 o_centre;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (texelSlot(c, u_width) >= u_count) { o_centre = vec2(0.0); return; }
  vec4 s = texelFetch(u_stats, c, 0);
  o_centre = s.xy / max(s.w, 1.0);
}
`;

/**
 * Each leaf's module-spring acceleration: the sum over the endpoints on its chain (additive, into the force
 * pass). Padded texels return 0 (no-op under the blend): the loop reads the chain textures.
 */
const DISTRIBUTE_FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp usampler2D u_leafEndpoint; // slot atlas
uniform highp usampler2D u_endpointParent; // endpoint atlas
uniform highp sampler2D u_accel;          // endpoint atlas
uniform int u_count;
uniform int u_width;
uniform int u_endpointWidth;
uniform int u_maxChain;
layout(location = 0) out vec2 o_force;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (texelSlot(c, u_width) >= u_count) { o_force = vec2(0.0); return; }
  uint e = texelFetch(u_leafEndpoint, c, 0).r;
  vec2 f = vec2(0.0);
  for (int k = 0; k < u_maxChain && e != ${NONE}u; k++) {
    ivec2 t = slotTexel(int(e), u_endpointWidth);
    f += texelFetch(u_accel, t, 0).xy;
    e = texelFetch(u_endpointParent, t, 0).r;
  }
  o_force = f;
}
`;

/** The endpoint graph a plan's springs are gathered over (the `GpuSprings` input). */
function endpointGraph(plan: ModuleSpringPlan): SpringEdges {
  return { nodeCount: plan.rangeStart.length, edgeCount: plan.source.length, source: plan.source, target: plan.target, springWeight: plan.weight };
}

/**
 * Every program {@link GpuModuleSprings} compiles for `plan` (#385): the centroid reduction's three, the
 * centroid pass, the endpoint springs' (weighted; the hub pass too when an endpoint has more springs than a
 * row gathers) and the distribution pass.
 */
export function moduleSpringPrograms(springs: ModuleSprings): LayoutProgram[] {
  const reduce = segmentedReducePrograms(MODULE_REDUCE_MAP);
  return [
    reduce.level1,
    reduce.level,
    reduce.query,
    fullScreenProgram(CENTROID_FS),
    ...springPrograms({ hubs: hasHubRows(endpointDegrees(springs)), weighted: true }),
    fullScreenProgram(DISTRIBUTE_FS),
  ];
}

/** Springs per tree id — an endpoint's CSR row length (the plan's `degree`, by tree id). O(tree size + springs). */
function endpointDegrees(springs: ModuleSprings): Uint32Array {
  const degree = new Uint32Array(springs.parent.length);
  for (let e = 0; e < springs.source.length; e++) {
    degree[springs.source[e]!] = degree[springs.source[e]!]! + 1;
    degree[springs.target[e]!] = degree[springs.target[e]!]! + 1;
  }
  return degree;
}

/** A texture of `data` (padded to `width` columns) in `format`. */
function atlasTexture(device: Device, data: Uint32Array, width: number): Texture {
  const height = Math.max(1, Math.ceil(data.length / width));
  const padded = new Uint32Array(width * height);
  padded.set(data);
  return device.createTexture({ width, height, format: "r32uint", data: padded, mipLevels: 1, sampler: NEAREST });
}

/**
 * The GPU module springs of a flat solver (#455): built once for the graph's {@link ModuleSprings}; per
 * tick {@link prepare} (before the force pass) and {@link draw} (inside it) add them to the force texture.
 * Memory: the tree order and the leaf chain (8 B per node), the reduction tree over the nodes (≈ 2 × N/15
 * texels × 32 B, 2.1 MB at 1M), and per endpoint its table row, centroid, acceleration and chain link
 * (≈ 90 B), plus the endpoint springs' CSR (16 B per module link).
 */
export class GpuModuleSprings {
  private readonly device: Device;
  private readonly count: number;
  private readonly posWidth: number;
  private readonly endpointWidth: number;
  private readonly endpointCount: number;
  private readonly maxChain: number;
  private readonly order: Texture;
  private readonly leafEndpoint: Texture;
  private readonly endpointParent: Texture;
  private readonly table: SegmentTable;
  private readonly reduce: SegmentedReduce;
  private readonly centroids: Texture;
  private readonly centroidFbo: Framebuffer;
  private readonly accel: Texture;
  private readonly accelFbo: Framebuffer;
  private readonly springs: GpuSprings;
  private readonly centroidModel: Model;
  private readonly centroidUniforms: PassUniforms;
  private readonly distributeModel: Model;
  private readonly distributeUniforms: PassUniforms;
  private readonly bindings: Readonly<Record<string, Texture>>;

  /** @param posWidth the solver's slot atlas width (positions, force). */
  constructor(device: Device, plan: ModuleSpringPlan, posWidth: number) {
    this.device = device;
    this.count = plan.leafCount;
    this.posWidth = posWidth;
    this.endpointCount = plan.rangeStart.length;
    this.maxChain = plan.maxChain;
    this.order = atlasTexture(device, plan.order, posWidth);
    this.leafEndpoint = atlasTexture(device, plan.leafEndpoint, posWidth);
    const rows: SegmentRow[] = Array.from(plan.rangeStart, (start, e) => ({
      start,
      count: plan.rangeCount[e]!,
      tile: null,
      param: { repulsion: 0, centering: 0, softening: 0, alpha0: 0 },
    }));
    this.table = new SegmentTable(device, rows);
    this.endpointWidth = this.table.width;
    if (this.endpointWidth !== atlasWidth(this.endpointCount)) throw new Error("GpuModuleSprings: the table's atlas is not the endpoints'");
    this.endpointParent = atlasTexture(device, plan.endpointParent, this.endpointWidth);
    this.reduce = new SegmentedReduce(device, this.count, MODULE_REDUCE_MAP);
    this.bindings = { u_order: this.order };
    const endpointRows = Math.ceil(this.endpointCount / this.endpointWidth);
    const rg = (): Texture =>
      device.createTexture({ width: this.endpointWidth, height: endpointRows, format: "rg32float", mipLevels: 1, sampler: NEAREST });
    this.centroids = rg();
    this.centroidFbo = device.createFramebuffer({ width: this.endpointWidth, height: endpointRows, colorAttachments: [this.centroids] });
    this.accel = rg();
    this.accelFbo = device.createFramebuffer({ width: this.endpointWidth, height: endpointRows, colorAttachments: [this.accel] });
    this.springs = new GpuSprings(device, endpointGraph(plan), { rowScale: plan.rowScale });
    this.centroidUniforms = { u_count: this.endpointCount, u_width: this.endpointWidth };
    this.centroidModel = layoutModel(device, fullScreenProgram(CENTROID_FS), this.centroidUniforms, NO_BLEND);
    this.distributeUniforms = { u_count: this.count, u_width: posWidth, u_endpointWidth: this.endpointWidth, u_maxChain: this.maxChain };
    this.distributeModel = layoutModel(device, fullScreenProgram(DISTRIBUTE_FS), this.distributeUniforms, ADDITIVE_BLEND);
  }

  /**
   * Everything {@link draw} reads, from the current positions: the endpoint centroids (the reduction and its
   * range queries, then the centroid pass), the endpoint springs' hub chunks and their accelerations. Its own
   * render passes, encoded before the force pass; the caller's work item submits.
   */
  prepare(posTex: Texture, attraction: number): void {
    this.reduce.run({ pos: posTex, posWidth: this.posWidth, count: this.count }, this.table, this.bindings);
    const centre = beginPass(this.device, { framebuffer: this.centroidFbo, clear: false });
    this.centroidModel.setBindings({ u_stats: this.table.stats });
    this.centroidModel.draw(centre);
    centre.end();
    this.springs.prepare(this.centroids, this.endpointWidth);
    const accel = beginPass(this.device, { framebuffer: this.accelFbo, clear: [0, 0, 0, 0] });
    this.springs.draw(accel, this.centroids, { count: this.endpointCount, width: this.endpointWidth, attraction });
    accel.end();
  }

  /** Add every leaf's module-spring acceleration into the open additive force pass, after {@link prepare}. */
  draw(pass: RenderPass): void {
    this.distributeModel.setBindings({ u_leafEndpoint: this.leafEndpoint, u_endpointParent: this.endpointParent, u_accel: this.accel });
    this.distributeModel.draw(pass);
  }

  destroy(): void {
    this.order.destroy();
    this.leafEndpoint.destroy();
    this.endpointParent.destroy();
    this.table.destroy();
    this.reduce.destroy();
    this.centroidFbo.destroy();
    this.centroids.destroy();
    this.accelFbo.destroy();
    this.accel.destroy();
    this.springs.destroy();
    this.centroidModel.destroy();
    this.distributeModel.destroy();
  }
}
