import type { Device, Texture } from "@luma.gl/core";
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

  constructor(device: Device, graph: LayoutGraph, params: ForceParams) {
    this.device = device;
    this.count = graph.nodeCount;
    this.params = params;

    const width = atlasWidth(this.count);
    const height = Math.ceil(this.count / width);
    this.width = width;
    this.height = height;

    // Build padded position data (same layout as packPositionsTexture).
    const posData = new Float32Array(width * height * 2);
    posData.set(graph.positions);

    // Create position ping-pong. Seed the A (read) side with the initial
    // positions by constructing a pair where readTex is pre-loaded with data.
    // We use a bespoke seeded pair rather than pingPong() so we can supply data
    // to the read side without an additional GPU blit pass.
    this.pos = buildSeededPingPong(device, width, height, posData);

    // Velocity starts at zero (no initial velocity). pingPong() creates both
    // textures zeroed, so the A side is already the correct zero state.
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

    this.pass = new IntegratePass(device);
  }

  /** Execute `ticks` integrate steps on the GPU. */
  runFrame(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this._tick();
    }
  }

  private _tick(): void {
    // MRT framebuffer: attachment location 0 → new positions, 1 → new velocities.
    const writeFbo = this.device.createFramebuffer({
      width: this.width,
      height: this.height,
      colorAttachments: [this.pos.writeTex, this.vel.writeTex],
    });

    const renderPass = this.device.beginRenderPass({
      framebuffer: writeFbo,
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
    writeFbo.destroy();

    // Swap both ping-pongs: the freshly-written textures become the read sources
    // for the next tick.
    this.pos.swap();
    this.vel.swap();
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
    this.pass.destroy();
  }
}

/**
 * Like {@link pingPong} but seeds the read (A) side with `data`.
 * The write (B) side starts zeroed.
 */
function buildSeededPingPong(
  device: Device,
  width: number,
  height: number,
  data: Float32Array,
): ReturnType<typeof pingPong> {
  const makeEmpty = (): Texture =>
    device.createTexture({
      width,
      height,
      format: "rg32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

  let texA = device.createTexture({
    width,
    height,
    format: "rg32float",
    data,
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  let texB = makeEmpty();

  return {
    get readTex() { return texA; },
    get writeTex() { return texB; },
    swap() { const tmp = texA; texA = texB; texB = tmp; },
    destroy() { texA.destroy(); texB.destroy(); },
  };
}
