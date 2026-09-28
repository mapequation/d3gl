/**
 * Can this device run the GPU force layout for this graph? (#351, spec §6.6.)
 *
 * The decision is a pure function over a typed {@link GpuCaps} record, so every failure mode is
 * node-testable without faking a luma `Device`. The record is extracted from a live device in one place,
 * `gpuCaps` (`device-probe.ts`), which also runs the read-format and functional probes.
 */
import { atlasWidth } from "./textures.js";
import { chooseGrid } from "./passes/grid-pyramid.js";
import { TILE_ATLAS_MAX_SIDE } from "./segments.js";

/** Outcome of the functional float-blend probe: the exact sum (`"pass"`), a wrong one (`"wrong-sum"`, a
 *  driver that blends wrongly or at half precision), or no verdict because the probe could not build or
 *  run on the device (`"error"`). */
export type BlendProbe = "pass" | "wrong-sum" | "error";

/** What the GPU layout needs to know about a device. */
export interface GpuCaps {
  /** The luma device type; the layout runs on WebGL2 only. */
  type: string;
  /** `float32-renderable-webgl` (`EXT_color_buffer_float`): `r32f`/`rg32f`/`rgba32f` render targets and
   *  `RGBA/FLOAT` readback. */
  floatRenderable: boolean;
  /** `texture-blend-float-webgl` (`EXT_float_blend`): blending into 32-bit float targets. Every force pass
   *  accumulates with ADD (and the pyramid box with MAX) blending into `rg32f`/`rgba32f` targets. */
  floatBlend: boolean;
  /** `limits.maxTextureDimension2D`: the largest texture side the device allocates. WebGL2 guarantees 2048. */
  maxTextureDimension2D: number;
  /** Whether `RG/FLOAT` is the implementation read format of an `rg32f` attachment, so positions read back
   *  at 8 bytes per node. When false the readback uses `RGBA/FLOAT`, which `EXT_color_buffer_float`
   *  guarantees. The same cached value `PositionReadback` reads (`deviceReadsRG`). Informational: it never
   *  rejects a device. */
  readRG: boolean;
  /** Result of the functional probe (two ADD-blended points summed in an `rg32f` target and read back), or
   *  `null` when it did not run (a prerequisite above is missing). It catches drivers that advertise the
   *  extensions but blend wrongly. */
  blendProbe: BlendProbe | null;
}

/** Slots the GPU nested layout can index (#355): its passes read slot ids as float32, exact below 2^24. */
export const NESTED_MAX_SLOTS = 1 << 24;

/** The texture sides the GPU layout allocates for one graph. */
export interface GpuLayoutNeed {
  /** Position / velocity / force atlas: one texel per node, ⌈√N⌉ wide. */
  positionSide: number;
  /** CSR offsets atlas: `buildCSR` stores N + 1 offsets, so ⌈√(N + 1)⌉ wide (one wider than the position
   *  atlas when N is a perfect square). */
  offsetsSide: number;
  /** Spring (CSR neighbour) atlas: one texel per half-edge, ⌈√2E⌉ wide. */
  springSide: number;
  /** Finest grid-pyramid level: next power of two ≥ √N, clamped to [16, 1024]. For the nested layout, the
   *  larger side of its segments' tile atlas (the pyramid's level 0, `packTiles`; 0 without tiles). */
  pyramidSide: number;
  /** What only the nested layout needs ({@link GpuNestedNeed}); absent for the flat layout. */
  nested?: GpuNestedNeed;
}

/**
 * The GPU nested layout's needs past the four sides above (#355, `gpuNestedLayoutNeed`): the limits its
 * constructor enforces, so the verdict — not a throw — finds a tree the device cannot run.
 */
export interface GpuNestedNeed {
  /** Slots (tree nodes below the root), below {@link NESTED_MAX_SLOTS}. */
  slots: number;
  /** The per-segment collision table: 3 texels per segment (its list and its grid) and the whole range, ⌈√(3(S + 1))⌉ wide. */
  collideSide: number;
  /** The collision grid's largest texture side past the slot atlas: its hash tables, work items and binned-slot list. */
  gridSide: number;
}

/** The GPU layout's verdict for one device and graph. */
export type GpuLayoutSupport = { ok: true } | { ok: false; reason: string };

/**
 * The texture sides {@link GpuForceLayout} allocates for a graph of `nodeCount` nodes and `edgeCount`
 * edges. `buildCSR` stores every edge in both endpoints' rows, so the spring atlas holds 2E texels, and
 * N + 1 row offsets. O(1).
 */
export function gpuLayoutNeed(nodeCount: number, edgeCount: number): GpuLayoutNeed {
  return {
    positionSide: atlasWidth(nodeCount),
    offsetsSide: atlasWidth(nodeCount + 1),
    springSide: atlasWidth(2 * edgeCount),
    pyramidSide: chooseGrid(nodeCount),
  };
}

/**
 * The part of a GPU nested layout's need its slot count alone decides (#355, #375), for the check before
 * the prep builds the segments and links: the slot atlas (every per-slot texture), the CSR offsets and
 * the slot count. It names no grid pyramid, which the nested solve never allocates; the springs, the tile
 * atlas, the collision table and the collision grid are 0 until the prep sizes them (`gpuNestedLayoutNeed`,
 * which extends this one). O(1).
 */
export function gpuNestedSlotNeed(slots: number): GpuLayoutNeed {
  return {
    positionSide: atlasWidth(slots),
    offsetsSide: atlasWidth(slots + 1),
    springSide: 0,
    pyramidSide: 0,
    nested: { slots, collideSide: 0, gridSide: 0 },
  };
}

/**
 * Whether the GPU layout can run for `need` on a device with `caps`; `caps` is `null` when there is no
 * device (a Canvas/SVG render backend, SSR). The checks run in the order a user can act on them; the
 * first failure names its reason, which the caller logs before it falls back to the worker. A nested
 * `need` also checks the tree against the nested layout's own limits: its slot count, its tile atlas
 * against the 16-bit tile origin, its collision table and its collision grid.
 */
export function gpuLayoutSupport(caps: GpuCaps | null, need: GpuLayoutNeed): GpuLayoutSupport {
  if (!caps) return { ok: false, reason: "no WebGL device (a Canvas/SVG render backend, or SSR)" };
  if (caps.type !== "webgl") return { ok: false, reason: `the render device is ${caps.type}, not WebGL2` };
  if (!caps.floatRenderable) {
    return { ok: false, reason: "the device cannot render to float textures (EXT_color_buffer_float)" };
  }
  if (!caps.floatBlend) {
    return { ok: false, reason: "the device cannot blend into float textures (EXT_float_blend)" };
  }
  const nested = need.nested;
  if (nested && nested.slots >= NESTED_MAX_SLOTS) {
    return { ok: false, reason: `the module tree has ${nested.slots} nodes below its root, past the ${NESTED_MAX_SLOTS} slots the GPU nested layout indexes` };
  }
  const limit = caps.maxTextureDimension2D;
  const sides: [string, number][] = [
    ["position", need.positionSide],
    ["CSR offsets", need.offsetsSide],
    ["spring", need.springSide],
    [nested ? "tile atlas" : "grid pyramid", need.pyramidSide],
  ];
  if (nested) sides.push(["collision table", nested.collideSide], ["collision grid", nested.gridSide]);
  for (const [name, side] of sides) {
    if (side > limit) {
      return { ok: false, reason: `the graph needs a ${side}-texel ${name} texture, past the device's ${limit}-texel limit` };
    }
  }
  if (nested && need.pyramidSide > TILE_ATLAS_MAX_SIDE) {
    return { ok: false, reason: `the graph needs a ${need.pyramidSide}-texel tile atlas, past the ${TILE_ATLAS_MAX_SIDE} texels a tile origin addresses` };
  }
  if (caps.blendProbe === "wrong-sum") {
    return { ok: false, reason: "float blending gave a wrong sum in the functional probe (driver bug)" };
  }
  if (caps.blendProbe === "error") {
    return { ok: false, reason: "the functional float-blend probe could not run on this device (a lost context, or it failed to build the probe)" };
  }
  return { ok: true };
}
