import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import type { ForceParams, LayoutGraph } from "../force.js";
import { buildCSR } from "../graph.js";
import { atlasWidth, pingPong, readbackFloatFbo, packUintTexture } from "./textures.js";
import { IntegratePass } from "./passes/integrate.js";
import { AttractionPass } from "./passes/attraction.js";
import { RepulsionAllPairsPass } from "./passes/repulsion-allpairs.js";

/** Damping applied to velocity each integration step (mirrors CPU force.ts). */
const DAMPING = 0.9;

/**
 * GPU-side force-directed layout. Mirrors {@link ForceLayout} semantics but runs
 * the integration step entirely on the GPU via a ping-pong compute-in-raster loop.
 *
 * Force accumulation (Tasks 2–4): each tick begins by clearing `forceTex` to zero
 * via a dedicated `forceFbo`, then each force pass draws into it with additive
 * blending (ONE, ONE) so contributions accumulate.  Finally the integrate pass reads
 * the summed force texture.  All FBOs are pre-created in the constructor — no
 * `createFramebuffer` on the hot path.
 */
export class GpuForceLayout {
  private readonly device: Device;
  private readonly count: number;
  private readonly width: number;
  private readonly height: number;
  private readonly params: ForceParams;
  private readonly integratePass: IntegratePass;
  private readonly attractionPass: AttractionPass;
  private readonly repulsionPass: RepulsionAllPairsPass;

  /**
   * Position ping-pong pair. `readTex` = current positions; `writeTex` = render
   * target for the next tick's positions.
   */
  private readonly pos: ReturnType<typeof pingPong>;
  /** Velocity ping-pong pair — same structure as pos. */
  private readonly vel: ReturnType<typeof pingPong>;
  /**
   * Force accumulation texture (rg32float).  Cleared to zero at the start of
   * each tick; each force pass additively blends its per-node contribution into
   * it; the integrate pass reads it once.
   */
  private readonly forceTex: Texture;
  /**
   * Pre-created FBO wrapping `forceTex` — used only for the clear-at-tick-start
   * step (beginRenderPass with clearColor:[0,0,0,0]).  Force passes render into
   * it with additive blend.  Pre-created in the constructor per the no-per-tick-
   * alloc rule.
   */
  private readonly forceFbo: Framebuffer;

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

  /** CSR offset texture (r32uint): offsets[0..nodeCount] packed into an atlas. */
  private readonly offsetsTex: Texture;
  /** CSR neighbors texture (r32uint): the flat neighbor list packed into an atlas. */
  private readonly neighborsTex: Texture;
  /** Atlas width of the offsets texture. */
  private readonly offWidth: number;
  /** Atlas width of the neighbors texture. */
  private readonly nbrWidth: number;

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

    // Force accumulation texture — cleared each tick, written by force passes.
    this.forceTex = device.createTexture({
      width,
      height,
      format: "rg32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    // Pre-create the FBO wrapping forceTex for the per-tick clear step.
    this.forceFbo = device.createFramebuffer({
      width,
      height,
      colorAttachments: [this.forceTex],
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

    // Build symmetric (undirected) CSR from the graph's directed edge list.
    // LayoutGraph has source/target; buildCSR inserts both directions, so the
    // GPU gather over csr.neighbors reproduces force.ts's attraction exactly.
    const csr = buildCSR(graph.nodeCount, graph.source, graph.target);

    // Upload CSR offset and neighbor arrays as r32uint textures — done ONCE in
    // the constructor, reused every tick.
    const offResult = packUintTexture(device, csr.offsets);
    this.offsetsTex = offResult.texture;
    this.offWidth = offResult.width;

    // neighbors may be empty (no edges) — packUintTexture handles length 0 by
    // creating a 1×1 zeroed texture, which is never actually fetched.
    const nbrData = csr.neighbors.length > 0
      ? csr.neighbors
      : new Uint32Array(1);
    const nbrResult = packUintTexture(device, nbrData);
    this.neighborsTex = nbrResult.texture;
    this.nbrWidth = nbrResult.width;

    this.integratePass = new IntegratePass(device);
    this.attractionPass = new AttractionPass(device);
    this.repulsionPass = new RepulsionAllPairsPass(device);
  }

  /** Execute `ticks` integrate steps on the GPU. */
  runFrame(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this._tick();
    }
  }

  private _tick(): void {
    // ── 1. Clear force texture to zero ────────────────────────────────────────
    // Open a render pass on the force FBO with clearColor:[0,0,0,0] — this zeros
    // all texels so each force pass starts from a known blank slate.
    const forcePass = this.device.beginRenderPass({
      framebuffer: this.forceFbo,
      clearColor: [0, 0, 0, 0],
    });

    // ── 2. Force passes (additive blend, write into forceTex) ─────────────────
    // Order among force passes doesn't matter — additive blend accumulates them.

    // Attraction (spring gather over CSR neighbors).
    this.attractionPass.run(
      forcePass,
      this.pos.readTex,
      this.offsetsTex,
      this.neighborsTex,
      {
        count: this.count,
        width: this.width,
        offWidth: this.offWidth,
        nbrWidth: this.nbrWidth,
        attraction: this.params.attraction,
      },
    );

    // Repulsion (all-pairs O(n²) correctness baseline; Task 5 replaces with BH).
    this.repulsionPass.run(forcePass, this.pos.readTex, {
      count: this.count,
      width: this.width,
      repulsion: this.params.repulsion,
    });

    forcePass.end();
    this.device.submit();

    // ── 3. Integrate pass (reads force, writes pos+vel MRT) ───────────────────
    // Select the pre-created MRT framebuffer whose attachments are the current
    // write textures — no per-tick createFramebuffer.
    const fbo = this.fbos[this.parity]!;

    const renderPass = this.device.beginRenderPass({
      framebuffer: fbo,
      // Don't clear — every texel is written by the shader (padded texels get
      // vec2(0) from the `id >= u_count` branch).
      clearColor: false,
    });

    this.integratePass.run(renderPass, this.pos.readTex, this.vel.readTex, this.forceTex, {
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
    this.forceFbo.destroy();
    this.fbos[0].destroy();
    this.fbos[1].destroy();
    this.offsetsTex.destroy();
    this.neighborsTex.destroy();
    this.integratePass.destroy();
    this.attractionPass.destroy();
    this.repulsionPass.destroy();
  }
}
