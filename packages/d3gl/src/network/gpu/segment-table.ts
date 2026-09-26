import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { SlotRange } from "./segments.js";
import { atlasWidth } from "./textures.js";

/** Per-segment force parameters — the `segParam` texel, constant for a topology. */
export interface SegmentParam {
  /** Repulsion strength inside the segment. */
  repulsion: number;
  /** Centering strength toward the segment's centroid. */
  centering: number;
  /** Repulsion softening ε added to d² (the flat layout's absolute 1e-2). */
  softening: number;
  /** Starting heat of the segment's schedule (1 for a cold start). */
  alpha0: number;
}

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

/**
 * The segment table (spec §5.2): S texels per texture in an atlas of width `atlasWidth(S)`, read
 * with `texelFetch`. Segment `s` lives at texel `slotTexel(s, width)` of every texture.
 *
 * | texture | format | channels | written |
 * |---|---|---|---|
 * | `info`  | `rgba32uint`  | start, count, (reserved: tile origin, root level \| flags) | once |
 * | `param` | `rgba32float` | repulsion, centering, softening, alpha0 | once |
 * | `stats` | `rgba32float` | Σx, Σy, Σ\|v\|, count | per tick, by the range query |
 * | `box`   | `rgba32float` | maxX, maxY, −minX, −minY | per tick, by the range query |
 *
 * Consumers divide by `max(count, 1)`, so an empty segment yields a zero centroid and a zero mean
 * step, never NaN. The flat layout is S = 1: every texture is 1×1 and the shaders read texel (0, 0).
 * Everything is created here, once — never per tick.
 */
export class SegmentTable {
  /** Number of segments, S. */
  readonly size: number;
  /** Atlas width of every table texture. */
  readonly width: number;
  /** `(start, count, reserved, reserved)` per segment. */
  readonly info: Texture;
  /** `(repulsion, centering, softening, alpha0)` per segment. */
  readonly param: Texture;
  /** `(Σx, Σy, Σ|v|, count)` per segment — the range query's first output. */
  readonly stats: Texture;
  /** `(maxX, maxY, −minX, −minY)` per segment — the range query's second output. */
  readonly box: Texture;
  /** MRT framebuffer `[stats, box]` the range query renders into. */
  readonly target: Framebuffer;

  constructor(device: Device, segments: readonly SlotRange[], param: SegmentParam) {
    const size = segments.length;
    if (size === 0) throw new Error("SegmentTable: at least one segment is required");
    const width = atlasWidth(size);
    const height = Math.ceil(size / width);
    this.size = size;
    this.width = width;

    const info = new Uint32Array(width * height * 4);
    const params = new Float32Array(width * height * 4);
    segments.forEach((seg, s) => {
      info[s * 4] = seg.start;
      info[s * 4 + 1] = seg.count;
      params[s * 4] = param.repulsion;
      params[s * 4 + 1] = param.centering;
      params[s * 4 + 2] = param.softening;
      params[s * 4 + 3] = param.alpha0;
    });
    this.info = device.createTexture({ width, height, format: "rgba32uint", data: info, mipLevels: 1, sampler: NEAREST });
    this.param = device.createTexture({ width, height, format: "rgba32float", data: params, mipLevels: 1, sampler: NEAREST });
    this.stats = device.createTexture({ width, height, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    this.box = device.createTexture({ width, height, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    this.target = device.createFramebuffer({ width, height, colorAttachments: [this.stats, this.box] });
  }

  destroy(): void {
    this.target.destroy();
    this.info.destroy();
    this.param.destroy();
    this.stats.destroy();
    this.box.destroy();
  }
}
