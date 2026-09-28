import type { Device, Framebuffer, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL, atlasWidth } from "../textures.js";
import { NO_BLEND, beginPass, fullScreenModel, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// Readback pack passes (#352, spec §6.5.2)
// ─────────────────────────────────────────────────────────────────────────────
//
// Chrome serves `getBufferSubData` from a readback shadow copy only when the READ buffer was written
// once and then fenced: a second write before the harvest discards the copy ("written again before
// being read back") and the harvest becomes a pipeline stall. So each readback PBO takes exactly one
// `readPixels` per copy, and whatever it carries is packed into one texture first.
//
// PackPositionsPass — only for a device that does not read `rg32f` attachments as `RG/FLOAT` (the RG read probe of #351
// fails): WebGL2 guarantees `RGBA/FLOAT` from an `rgba32f` attachment, so one fragment per output texel t
// writes nodes 2t and 2t + 1 as `(x0, y0, x1, y1)` into a staging `rgba32f` texture of ⌈N/2⌉ texels, in
// node order. Read back row-major, that is exactly the interleaved `[x, y, …]` positions array, so the
// harvest copies it straight into `graph.positions` with no compaction loop. Where the probe passes (ANGLE
// Metal) none of this is allocated: the readback copies the position texture itself.

const PACK_FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform highp sampler2D u_pos;
uniform int u_count;
uniform int u_posWidth;
uniform int u_outWidth;
layout(location = 0) out vec4 o_pair;
${SLOT_TEXEL_GLSL}

void main() {
  int a = 2 * texelSlot(ivec2(gl_FragCoord.xy), u_outWidth);
  int b = a + 1;
  // Past the last node the pair is (0, 0) — never fetched outside the position atlas.
  vec2 pa = a < u_count ? texelFetch(u_pos, slotTexel(a, u_posWidth), 0).xy : vec2(0.0);
  vec2 pb = b < u_count ? texelFetch(u_pos, slotTexel(b, u_posWidth), 0).xy : vec2(0.0);
  o_pair = vec4(pa, pb);
}
`;

const STATS_FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp sampler2D;

uniform highp sampler2D u_stats; // the range table's sum chain, e.g. (Σx, Σy, Σ|v|, count) per segment
uniform highp sampler2D u_box;   // its max chain, (maxX, maxY, −minX, −minY) per segment
uniform highp sampler2D u_stop;  // the stop latch (prevStep, stopTick, epoch, flags), #376; zeros without one
uniform ivec2 u_texel;           // the range whose stats are copied (the flat layout's one segment: (0, 0))
layout(location = 0) out vec4 o_stat;

void main() {
  float x = gl_FragCoord.x;
  o_stat = x < 1.0 ? texelFetch(u_stats, u_texel, 0) : x < 2.0 ? texelFetch(u_box, u_texel, 0) : texelFetch(u_stop, ivec2(0), 0);
}
`;

/** Texels of the stats staging row: `stats`, `box`, the stop latch. */
export const STATS_TEXELS = 3;

/**
 * One range's `stats` and `box` texels — the flat segment table's only segment, or the nested solve's
 * whole-slot range (#355) — and the stop latch's texel (#376) side by side in one 3×1 `rgba32float` staging
 * texture, so the stats readback is one `readPixels` into its own PBO. One 3-fragment draw per copy. A solve
 * without a stop latch (the nested one: a fixed tick count) copies a zero texel there: no stop, no flag.
 */
export class PackStatsPass {
  /** The 3×1 ({@link STATS_TEXELS}) staging framebuffer the readback copies from. */
  readonly framebuffer: Framebuffer;
  private readonly device: Device;
  private readonly texture: Texture;
  private readonly model: Model;
  private readonly uniforms: PassUniforms;
  /** The zero texel copied as the stop latch of a solve without one. */
  private readonly noStop: Texture;

  constructor(device: Device) {
    this.device = device;
    this.texture = device.createTexture({
      width: STATS_TEXELS,
      height: 1,
      format: "rgba32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    this.framebuffer = device.createFramebuffer({ width: STATS_TEXELS, height: 1, colorAttachments: [this.texture] });
    this.noStop = device.createTexture({
      width: 1,
      height: 1,
      format: "rgba32float",
      data: new Float32Array(4),
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    this.uniforms = { u_texel: new Int32Array(2) };
    this.model = fullScreenModel(device, STATS_FS, this.uniforms, NO_BLEND);
  }

  /**
   * Copy `stats` (staging texel 0) and `box` (staging texel 1) of the range at table texel `(x, y)`, and the
   * stop latch (texel 2; zeros for a solve without one), into the staging texture.
   */
  run(stats: Texture, box: Texture, stop: Texture | null, x = 0, y = 0): void {
    const texel = this.uniforms["u_texel"];
    if (texel instanceof Int32Array) {
      texel[0] = x;
      texel[1] = y;
    }
    this.model.setBindings({ u_stats: stats, u_box: box, u_stop: stop ?? this.noStop });
    const pass = beginPass(this.device, { framebuffer: this.framebuffer, clear: false });
    this.model.draw(pass);
    pass.end();
  }

  destroy(): void {
    this.model.destroy();
    this.framebuffer.destroy();
    this.texture.destroy();
    this.noStop.destroy();
  }
}

/**
 * The staging texture (`rgba32float`, ⌈count/2⌉ texels in an atlas of width `atlasWidth(⌈count/2⌉)`), its
 * framebuffer and the pack model — all created once, for a fixed node count.
 */
export class PackPositionsPass {
  /** Width of the staging atlas, in texels. */
  readonly width: number;
  /** Height of the staging atlas, in rows. */
  readonly height: number;
  /** The staging framebuffer the pass renders into and the readback copies from. */
  readonly framebuffer: Framebuffer;
  private readonly device: Device;
  private readonly texture: Texture;
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device, count: number) {
    this.device = device;
    const pairs = Math.max(1, Math.ceil(count / 2));
    this.width = atlasWidth(pairs);
    this.height = Math.ceil(pairs / this.width);
    this.texture = device.createTexture({
      width: this.width,
      height: this.height,
      format: "rgba32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    this.framebuffer = device.createFramebuffer({ width: this.width, height: this.height, colorAttachments: [this.texture] });
    this.uniforms = { u_count: count, u_posWidth: 1, u_outWidth: this.width };
    this.model = fullScreenModel(device, PACK_FS, this.uniforms, NO_BLEND);
  }

  /** Pack the `rg32f` positions `pos` (atlas width `posWidth`) into the staging texture, in node order. */
  run(pos: Texture, posWidth: number): void {
    this.uniforms["u_posWidth"] = posWidth;
    this.model.setBindings({ u_pos: pos });
    // Every staging texel is written, so nothing needs clearing.
    const pass = beginPass(this.device, { framebuffer: this.framebuffer, clear: false });
    this.model.draw(pass);
    pass.end();
  }

  destroy(): void {
    this.model.destroy();
    this.framebuffer.destroy();
    this.texture.destroy();
  }
}
