/**
 * Can this device run the GPU force layout for this graph? (#351, spec §6.6.)
 *
 * The decision is a pure function over a typed {@link GpuCaps} record, so every failure mode is
 * node-testable without faking a luma `Device`. The record is extracted from a live device in one place,
 * `gpuCaps` (`device-probe.ts`), which also runs the read-format and functional probes.
 */
import { atlasWidth } from "./textures.js";
import { chooseGrid } from "./passes/grid-pyramid.js";

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
   *  guarantees. Informational: it never rejects a device. */
  readRG: boolean;
  /** Result of the functional probe (two ADD-blended points summed in an `rg32f` target and read back), or
   *  `null` when it did not run (a prerequisite above is missing). It catches drivers that advertise the
   *  extensions but blend wrongly. */
  blendProbe: boolean | null;
}

/** The texture sides the GPU layout allocates for one graph. */
export interface GpuLayoutNeed {
  /** Position / velocity / force atlas: one texel per node, ⌈√N⌉ wide. */
  positionSide: number;
  /** Spring (CSR neighbour) atlas: one texel per half-edge, ⌈√2E⌉ wide. */
  springSide: number;
  /** Finest grid-pyramid level: next power of two ≥ √N, clamped to [16, 1024]. */
  pyramidSide: number;
}

/** The GPU layout's verdict for one device and graph. */
export type GpuLayoutSupport = { ok: true } | { ok: false; reason: string };

/**
 * The texture sides {@link GpuForceLayout} allocates for a graph of `nodeCount` nodes and `edgeCount`
 * edges. `buildCSR` stores every edge in both endpoints' rows, so the spring atlas holds 2E texels.
 * O(1).
 */
export function gpuLayoutNeed(nodeCount: number, edgeCount: number): GpuLayoutNeed {
  return {
    positionSide: atlasWidth(nodeCount),
    springSide: atlasWidth(2 * edgeCount),
    pyramidSide: chooseGrid(nodeCount),
  };
}

/**
 * Whether the GPU layout can run for `need` on a device with `caps`; `caps` is `null` when there is no
 * device (a Canvas/SVG render backend, SSR). The checks run in the order a user can act on them; the
 * first failure names its reason, which the caller logs before it falls back to the worker.
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
  const limit = caps.maxTextureDimension2D;
  const sides: [string, number][] = [
    ["position", need.positionSide],
    ["spring", need.springSide],
    ["grid pyramid", need.pyramidSide],
  ];
  for (const [name, side] of sides) {
    if (side > limit) {
      return { ok: false, reason: `the graph needs a ${side}-texel ${name} texture, past the device's ${limit}-texel limit` };
    }
  }
  if (caps.blendProbe === false) {
    return { ok: false, reason: "float blending gave a wrong sum in the functional probe (driver bug)" };
  }
  return { ok: true };
}
