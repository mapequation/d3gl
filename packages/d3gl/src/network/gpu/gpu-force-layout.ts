import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import type { ForceParams, LayoutGraph } from "../force.js";
import { atlasWidth, pingPong, readbackFloatFbo } from "./textures.js";
import { IntegratePass } from "./passes/integrate.js";

/** Damping applied to velocity each integration step (mirrors CPU force.ts). */
const DAMPING = 0.9;

/**
 * GPU-side force-directed layout. Mirrors {@link ForceLayout} semantics but runs
 * the integration step entirely on the GPU via a ping-pong compute-in-raster loop.
 *
 * Task 1 provides position + velocity textures and the integrate pass with a
 * zeroed force texture. With all force strengths set to 0, positions are invariant
 * after any number of ticks (zero force → zero step → positions unchanged).
 */
export class GpuForceLayout {
  private readonly device: Device;
  private readonly count: number;
  private readonly width: number;
  private readonly height: number;
  private readonly params: ForceParams;
  private readonly pass: IntegratePass;

  /**
   * Position ping-pong pair. `readTex` = current positions; `writeTex` = render
   * target for the next tick's positions.
   */
  private readonly pos: ReturnType<typeof pingPong>;
  /** Velocity ping-pong pair — same structure as pos. */
  private readonly vel: ReturnType<typeof pingPong>;
  /**
   * Force accumulation texture (rg32float, all-zeros — Task 2 will accumulate
   * repulsion + attraction + centering here before each integrate step).
   */
  private readonly forceTex: Texture;

  /**
   * The two MRT framebuffer configurations, pre-created once. `swap()` only ever
   * alternates between two fixed texture pairs, so there are exactly two possible
   * `[posWrite, velWrite]` attachment sets. `fbos[0]` wraps the initial write
   * textures, `fbos[1]` wraps the post-swap ones. A per-tick `parity` selects the
   * one whose attachments currently match the write side — NO `createFramebuffer`
   * on the hot path (AGENTS.md: "buffers updated in place, not recreated per frame").
   */
  private readonly fbos: readonly [Framebuffer, Framebuffer];
  /** Selects which pre-created FBO this tick writes into; flipped each tick alongside swap(). */
  private parity = 0;

  constructor(device: Device, graph: LayoutGraph, params: ForceParams) {
    this.device = device;
    this.count = graph.nodeCount;
    this.params = params;

    const width = atlasWidth(this.count);
    const height = Math.ceil(this.count / width);
    this.width = width;
    this.height = height;

    // Build padded position data (same layout as packPositionsTexture) and seed
    // the position read (A) side with it. Velocity starts zeroed (no seed).
    const posData = new Float32Array(width * height * 2);
    posData.set(graph.positions);
    this.pos = pingPong(device, width, height, posData);
    this.vel = pingPong(device, width, height);

    // Zero force texture (device.createTexture with no data defaults to zeros
    // in the WebGL adapter).
    this.forceTex = device.createTexture({
      width,
      height,
      format: "rg32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    // Pre-create BOTH MRT framebuffer configurations once. fbos[0] wraps the
    // initial write textures; swap both ping-pongs and fbos[1] wraps the other
    // pair; swap back to restore the initial read/write orientation. At any tick
    // the read textures are the ones NOT attached to fbos[parity], so there is no
    // read/write hazard.
    const makeFbo = (): Framebuffer =>
      device.createFramebuffer({
        width,
        height,
        colorAttachments: [this.pos.writeTex, this.vel.writeTex],
      });
    const fbo0 = makeFbo();
    this.pos.swap();
    this.vel.swap();
    const fbo1 = makeFbo();
    this.pos.swap();
    this.vel.swap();
    this.fbos = [fbo0, fbo1];

    this.pass = new IntegratePass(device);
  }

  /** Execute `ticks` integrate steps on the GPU. */
  runFrame(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this._tick();
    }
  }

  private _tick(): void {
    // Select the pre-created MRT framebuffer whose attachments are the current
    // write textures — no per-tick createFramebuffer.
    const fbo = this.fbos[this.parity]!;

    const renderPass = this.device.beginRenderPass({
      framebuffer: fbo,
      // Don't clear — every texel is written by the shader (padded texels get
      // vec2(0) from the `id >= u_count` branch).
      clearColor: false,
    });

    this.pass.run(renderPass, this.pos.readTex, this.vel.readTex, this.forceTex, {
      count: this.count,
      width: this.width,
      alpha: this.params.alpha,
      damping: DAMPING,
      maxStep: 1e9,
    });

    renderPass.end();
    this.device.submit();

    // Swap both ping-pongs so the freshly-written textures become the read
    // sources for the next tick, and flip parity so the next tick writes into
    // the OTHER pre-created FBO (which wraps those next write textures).
    this.pos.swap();
    this.vel.swap();
    this.parity ^= 1;
  }

  /**
   * Read the current node positions back to the CPU.
   * Writes `count * 2` floats into `out` starting at index 0.
   */
  readPositions(out: Float32Array): void {
    const pixels = readbackFloatFbo(this.device, this.pos.readTex, this.width, this.count);
    out.set(pixels);
  }

  destroy(): void {
    this.pos.destroy();
    this.vel.destroy();
    this.forceTex.destroy();
    this.fbos[0].destroy();
    this.fbos[1].destroy();
    this.pass.destroy();
  }
}
