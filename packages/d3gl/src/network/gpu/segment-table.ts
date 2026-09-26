import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import { SEGMENT_HAS_TILE, segmentInfo, type SlotRange, type Tile } from "./segments.js";
import { atlasWidth } from "./textures.js";

/** Per-segment force parameters — the `segParam` texel, constant for a topology. */
export interface SegmentParam {
  /** Repulsion strength inside the segment. */
  repulsion: number;
  /** Centering strength toward the segment's centroid. */
  centering: number;
  /** Repulsion softening ε added to d² ({@link segmentSoftening}: 1e-2 for the flat layout). */
  softening: number;
  /** Starting heat of the segment's schedule (1 for a cold start). */
  alpha0: number;
}

/** One row of the segment table: a segment's slots, its tile (or `null`: the exact loop) and parameters. */
export interface SegmentRow extends SlotRange {
  readonly tile: Tile | null;
  readonly param: SegmentParam;
}

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

/**
 * The segment table (spec §5.2): S texels per texture in an atlas of width `atlasWidth(S)`, read
 * with `texelFetch`. Segment `s` lives at texel `slotTexel(s, width)` of every texture.
 *
 * | texture | format | channels | written |
 * |---|---|---|---|
 * | `info`  | `rgba32uint`  | start, count, tile `x \| y << 16`, `rootLevel \| flags << 8` ({@link segmentInfo}) | once |
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
  /** `(start, count, x | y << 16, rootLevel | flags << 8)` per segment. */
  readonly info: Texture;
  /** `(repulsion, centering, softening, alpha0)` per segment. */
  readonly param: Texture;
  /** `(Σx, Σy, Σ|v|, count)` per segment — the range query's first output. */
  readonly stats: Texture;
  /** `(maxX, maxY, −minX, −minY)` per segment — the range query's second output. */
  readonly box: Texture;
  /** MRT framebuffer `[stats, box]` the range query renders into. */
  readonly target: Framebuffer;

  constructor(device: Device, rows: readonly SegmentRow[]) {
    const size = rows.length;
    if (size === 0) throw new Error("SegmentTable: at least one segment is required");
    const width = atlasWidth(size);
    const height = Math.ceil(size / width);
    this.size = size;
    this.width = width;

    const info = new Uint32Array(width * height * 4);
    const params = new Float32Array(width * height * 4);
    rows.forEach((row, s) => {
      info.set(segmentInfo(row, row.tile), s * 4);
      params[s * 4] = row.param.repulsion;
      params[s * 4 + 1] = row.param.centering;
      params[s * 4 + 2] = row.param.softening;
      params[s * 4 + 3] = row.param.alpha0;
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

/**
 * The shader defines of a segment layout, spliced after `#version`: `SINGLE_SEGMENT` when S = 1 (the
 * flat layout), so the segment id is the constant 0 and no `slotSeg` texture exists (spec §5.3: flat
 * pays nothing for segments), plus the `segInfo` flag the passes branch on ({@link SEGMENT_HAS_TILE}).
 */
export function segmentDefines(singleSegment: boolean): string {
  return `${singleSegment ? "#define SINGLE_SEGMENT\n" : ""}#define SEGMENT_HAS_TILE ${SEGMENT_HAS_TILE}u\n`;
}

/**
 * GLSL: `segmentTexelOf(t)` — the segment-table texel of the slot at slot-atlas texel `t`. With
 * `SINGLE_SEGMENT` it is the constant (0, 0); otherwise it reads the slot's id from `u_slotSeg`
 * (`r32uint`, the slot atlas) and maps it through `slotTexel` at the table's width `u_tableWidth`.
 * Needs {@link segmentDefines} and `SLOT_TEXEL_GLSL` before it.
 */
export const SEGMENT_OF_GLSL = /* glsl */ `\
#ifdef SINGLE_SEGMENT
ivec2 segmentTexelOf(ivec2 t) { return ivec2(0); }
#else
uniform highp usampler2D u_slotSeg; // segment id per slot
uniform int u_tableWidth;           // segment-table atlas width
ivec2 segmentTexelOf(ivec2 t) { return slotTexel(int(texelFetch(u_slotSeg, t, 0).r), u_tableWidth); }
#endif
`;
