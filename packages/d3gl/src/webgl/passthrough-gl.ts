import { Buffer } from "@luma.gl/core";
import type { Device, Framebuffer, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { PointBatch, ViewTransform } from "../core/index.js";
import { GrowBuffer } from "./renderer.js";
import { PT_POINT_VS, POINT_FS, BLIT_VS, BLIT_FS } from "./shaders.js";
import { clipFromView, blitMatrix } from "./transform.js";

const identity3 = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Quad corner offsets (unit local square), matching renderer.ts POINT_CORNERS. */
const PT_CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * Vertex layout for the pass-through point quads.
 *
 * Color note: GrowBuffer only backs Float32Array | Uint32Array (no Uint8Array), so the
 * per-vertex RGBA is packed into a single uint32 (bytes = r,g,b,a, little-endian) in a
 * Uint32Array GrowBuffer, and read by the shader as a normalized vec4 via the unorm8x4
 * format (4 bytes / vertex stride). The GPU interprets those 4 bytes as the vec4 a_color.
 */
const PT_POINT_LAYOUT = [
  { name: "a_center", format: "float32x2" as const },
  { name: "a_corner", format: "float32x2" as const },
  { name: "a_radius", format: "float32" as const },
  { name: "a_color", format: "unorm8x4" as const },
];

const BLIT_LAYOUT = [
  { name: "a_pos", format: "float32x2" as const },
  { name: "a_uv", format: "float32x2" as const },
];

// Standard (non-premultiplied) alpha blending so colored/overlapping points composite
// correctly into the accumulation FBO instead of overwriting opaquely. Mirrors the
// renderer's BLEND so a point with alpha < 1 blends over what is already accumulated.
const BLEND = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

/** Expanded quad attributes for a PointBatch (4 verts + 6 indices per point). */
interface Expanded {
  center: Float32Array;
  corner: Float32Array;
  radius: Float32Array;
  /** Packed RGBA, one uint32 per vertex (read as unorm8x4 vec4). */
  color: Uint32Array;
  index: Uint32Array;
}

/** Pack an RGBA byte tuple into a single little-endian uint32 (bytes = r,g,b,a). */
function packRGBA(r: number, g: number, b: number, a: number): number {
  // >>> 0 keeps it an unsigned 32-bit value for the Uint32Array store.
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Expand a PointBatch into quad geometry starting at vertex `vertexBase`.
 * Each point becomes 4 vertices (the unit-square corners) and 6 indices (two triangles).
 */
function expand(batch: PointBatch, vertexBase: number): Expanded {
  const N = batch.count;
  const center = new Float32Array(N * 4 * 2);
  const corner = new Float32Array(N * 4 * 2);
  const radius = new Float32Array(N * 4);
  const color = new Uint32Array(N * 4);
  const index = new Uint32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const cx = batch.positions[i * 2]!;
    const cy = batch.positions[i * 2 + 1]!;
    const r = batch.radii[i]!;
    const packed = packRGBA(
      batch.colors[i * 4]!,
      batch.colors[i * 4 + 1]!,
      batch.colors[i * 4 + 2]!,
      batch.colors[i * 4 + 3]!,
    );
    for (let v = 0; v < 4; v++) {
      const vi = i * 4 + v;
      center[vi * 2] = cx;
      center[vi * 2 + 1] = cy;
      corner[vi * 2] = PT_CORNERS[v]![0];
      corner[vi * 2 + 1] = PT_CORNERS[v]![1];
      radius[vi] = r;
      color[vi] = packed;
    }
    const base = vertexBase + i * 4;
    const ii = i * 6;
    index[ii] = base;
    index[ii + 1] = base + 1;
    index[ii + 2] = base + 2;
    index[ii + 3] = base;
    index[ii + 4] = base + 2;
    index[ii + 5] = base + 3;
  }
  return { center, corner, radius, color, index };
}

/**
 * One pass-through accumulation surface: rasterizes point batches into an offscreen
 * RGBA8 FBO (the accumulation buffer) and composites that FBO onto a caller-supplied
 * target via a full-screen blit.
 *
 * The accumulation FBO is preserved across draws unless `clear` is requested — so a full
 * repaint clears once then appends, and incremental additions append on top. The blit is
 * a separate step the caller drives into its own render pass (snapshot-pan offsets the
 * accumulated layer with a clip-space matrix instead of re-rasterizing).
 */
export class PassThroughGL {
  private fbo: Framebuffer;
  private pointModel: Model;
  private blitModel: Model;
  /** Scratch grow-buffers refilled per draw (geometry is transient, never retained CPU-side). */
  private center: GrowBuffer;
  private corner: GrowBuffer;
  private radius: GrowBuffer;
  private color: GrowBuffer;
  private index: GrowBuffer;
  /** Static full-screen quad buffers for the blit. */
  private blitPos: Buffer;
  private blitUv: Buffer;
  private blitIndex: Buffer;
  /** Shared uniforms so a mutate-in-place is picked up on the next draw. */
  private pointUniforms: Record<string, unknown>;
  private blitUniforms: Record<string, unknown>;
  /** The view transform the FBO contents were rasterized at (set on the last clear). */
  private fboRef: ViewTransform | null = null;

  constructor(
    private readonly device: Device,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.fbo = device.createFramebuffer({
      width,
      height,
      colorAttachments: ["rgba8unorm"],
    });

    // Seed the scratch buffers empty (count 0); they grow on the first draw.
    this.center = new GrowBuffer(device, Float32Array, new Float32Array(0));
    this.corner = new GrowBuffer(device, Float32Array, new Float32Array(0));
    this.radius = new GrowBuffer(device, Float32Array, new Float32Array(0));
    this.color = new GrowBuffer(device, Uint32Array, new Uint32Array(0));
    this.index = new GrowBuffer(device, Uint32Array, new Uint32Array(0), true);

    this.pointUniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width, height),
      u_pointScreen: 0,
      u_viewport: new Float32Array([width, height]),
    };
    this.pointModel = new Model(device, {
      vs: PT_POINT_VS,
      fs: POINT_FS,
      bufferLayout: PT_POINT_LAYOUT,
      attributes: {
        a_center: this.center.buffer,
        a_corner: this.corner.buffer,
        a_radius: this.radius.buffer,
        a_color: this.color.buffer,
      },
      indexBuffer: this.index.buffer,
      topology: "triangle-list" as const,
      uniforms: this.pointUniforms,
      parameters: BLEND,
      vertexCount: 0,
    });

    // Static full-screen quad (clip-space corners + matching UVs).
    this.blitPos = device.createBuffer({
      data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
    });
    this.blitUv = device.createBuffer({
      data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    });
    this.blitIndex = device.createBuffer({
      data: new Uint32Array([0, 1, 2, 0, 2, 3]),
      usage: Buffer.INDEX,
      indexType: "uint32",
    });
    this.blitUniforms = { u_blit: identity3() };
    this.blitModel = new Model(device, {
      vs: BLIT_VS,
      fs: BLIT_FS,
      bufferLayout: BLIT_LAYOUT,
      attributes: { a_pos: this.blitPos, a_uv: this.blitUv },
      indexBuffer: this.blitIndex,
      topology: "triangle-list" as const,
      bindings: { u_tex: this.colorTexture() },
      uniforms: this.blitUniforms,
      parameters: BLEND,
      vertexCount: 6,
    });
  }

  /** The accumulation FBO's color texture view, bound as u_tex for the blit. */
  private colorTexture() {
    return this.fbo.colorAttachments[0]!;
  }

  /** The view transform the accumulation FBO was rasterized at (null before first draw). */
  get fboTransform(): ViewTransform | null {
    return this.fboRef;
  }

  /**
   * Select the point sizing mode for subsequent draws: `true` = screen mode (constant
   * pixel radius, no zoom scaling), `false` = world mode (radius scales with k). Mutates
   * the shared point uniforms in place, so the next `draw` picks it up.
   */
  setScreenMode(on: boolean): void {
    this.pointUniforms["u_pointScreen"] = on ? 1 : 0;
  }

  /**
   * Rasterize `batch` into the accumulation FBO at `transform`. When `clear` is true the
   * FBO is cleared first (start of a full repaint) and the reference transform is recorded;
   * when false the previous FBO contents are PRESERVED and this batch is drawn ON TOP
   * (append / chunked repaint) — accumulation is the FBO's job, not the geometry's.
   *
   * Only THIS batch's quads are rasterized each call (the scratch buffers are reset and
   * refilled, vertex base 0), so a draw is O(batch), not O(total) — earlier batches live
   * only in the FBO. This is why the clearColor:false preserve below is load-bearing.
   */
  draw(batch: PointBatch, transform: ViewTransform, clear: boolean): void {
    const e = expand(batch, 0);
    // Reset so the scratch buffers are overwritten from the start with only this batch.
    this.center.reset();
    this.corner.reset();
    this.radius.reset();
    this.color.reset();
    this.index.reset();
    const realloc = [
      this.center.append(e.center),
      this.corner.append(e.corner),
      this.radius.append(e.radius),
      this.color.append(e.color),
      this.index.append(e.index),
    ].reduce((a, b) => a || b, false);

    if (realloc) {
      this.pointModel.setAttributes({
        a_center: this.center.buffer,
        a_corner: this.corner.buffer,
        a_radius: this.radius.buffer,
        a_color: this.color.buffer,
      });
      this.pointModel.setIndexBuffer(this.index.buffer);
    }
    this.pointModel.setVertexCount(this.index.length);
    this.pointUniforms["u_transform"] = clipFromView(transform, this.width, this.height);

    // clear===false preserves the existing FBO contents (clearColor:false → no load-clear),
    // so successive draws accumulate. clear===true wipes to transparent first.
    const pass = this.device.beginRenderPass({
      framebuffer: this.fbo,
      clearColor: clear ? [0, 0, 0, 0] : false,
    });
    this.pointModel.draw(pass);
    pass.end();
    this.device.submit();

    if (clear) this.fboRef = { ...transform };
  }

  /**
   * Composite the accumulation FBO into the caller's open render pass. `from` is the
   * transform the FBO was rasterized at, `to` the current view transform; the difference
   * offsets/scales the accumulated layer in clip space (snapshot-pan) without re-drawing.
   * The caller owns the render pass, its target framebuffer, and the submit.
   */
  composite(renderPass: RenderPass, fromTransform: ViewTransform, toTransform: ViewTransform): void {
    this.blitUniforms["u_blit"] = blitMatrix(fromTransform, toTransform, this.width, this.height);
    this.blitModel.setBindings({ u_tex: this.colorTexture() });
    this.blitModel.draw(renderPass);
  }

  destroy(): void {
    this.center.destroy();
    this.corner.destroy();
    this.radius.destroy();
    this.color.destroy();
    this.index.destroy();
    this.blitPos.destroy();
    this.blitUv.destroy();
    this.blitIndex.destroy();
    this.pointModel.destroy();
    this.blitModel.destroy();
    this.fbo.destroy();
  }
}
