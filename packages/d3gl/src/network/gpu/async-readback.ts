/**
 * The streaming layout's position readback (#352, spec §6.5.2): a GPU → PBO copy now, harvested into
 * `graph.positions` in a later frame once a fence after the copy has signalled — never a synchronous
 * `readPixels` on the frame path.
 *
 * - **One raw position PBO** (spec §15 Q9), created with `gl.createBuffer()` and sized by the first
 *   copy with `bufferData(…, STREAM_READ)`. luma 9.3.3 cannot make a `*_READ` buffer (its `WEBGLBuffer` emits only `STATIC_DRAW` /
 *   `DYNAMIC_DRAW`), and without a read usage Chrome's `getBufferSubData` cannot use its readback shadow
 *   copy: it falls back to a synchronous round trip to the GPU process. So the PBO is created raw, as
 *   `PickReadback` does, on the `WebGLDevice`'s context (reached by an `instanceof` narrowing, no cast).
 * - **One write per PBO per copy.** Chrome keeps that shadow copy only if the buffer is written once and
 *   then fenced; a second write before the harvest discards it ("written again before being read back")
 *   and the harvest stalls the GPU pipeline — measured on web-NotreDame when the stats rode in the
 *   position PBO as two extra `readPixels`. So the 48 bytes of stats have their own PBO, filled by one
 *   `readPixels` of a 3×1 staging texture ({@link PackStatsPass}).
 * - **The copy reads the position texture itself** where the device reads `rg32f` as `RG/FLOAT` (the #351
 *   probe; ANGLE Metal): 8 bytes per atlas texel, no staging texture. Elsewhere the pack pass writes the
 *   positions into a staging `rgba32f` texture in node order first ({@link PackPositionsPass}) and the
 *   copy reads that as `RGBA/FLOAT`, the format WebGL2 guarantees.
 * - **The stats** are the segment table's `stats` `(Σx, Σy, Σ|v|, count)` and `box`
 *   `(maxX, maxY, −minX, −minY)` from the last tick's reductions, so the harvest can refuse a non-finite
 *   layout without scanning N positions, and the stop latch's texel `(prevStep, stopTick, epoch, flags)`
 *   (#376), so the transport learns of a convergence stop with the positions it froze.
 * - **The harvest allocates nothing**: `getBufferSubData` writes straight into the caller's positions
 *   array and a caller-owned 8-float stats array (luma's `Buffer.readSyncWebGL` would allocate per call).
 *
 * The copy is not fenced here: the caller inserts one fence per frame after it (the frame budget's), and
 * harvests once that frame has completed. Fences signal in submission order, so that is safe.
 */
import type { Device, Framebuffer, Texture } from "@luma.gl/core";
import { WebGLDevice, WEBGLFramebuffer } from "@luma.gl/webgl";
import { deviceReadsRG } from "./device-probe.js";
import { PackPositionsPass, PackStatsPass, STATS_TEXELS } from "./passes/readback-pack.js";

/**
 * Floats of stats a harvest returns: `stats` (Σx, Σy, Σ|v|, count), then `box` (maxX, maxY, −minX, −minY),
 * then the stop latch (prevStep, stopTick, epoch, flags) from {@link READBACK_STOP_OFFSET}.
 */
export const READBACK_STATS_FLOATS = STATS_TEXELS * 4;
/** Where the stop latch's texel starts in the harvested stats (#376). */
export const READBACK_STOP_OFFSET = 8;
const STATS_BYTES = READBACK_STATS_FLOATS * 4;

/**
 * What a readback copies: the solver's current positions and its segment-table stats. Both copy paths
 * assume **slot order is node order** (the flat solver's identity permutation, spec §5.1): the `RG/FLOAT`
 * copy reads the position atlas as it is, and the pack pass addresses slot = node id. A solver with a
 * slot permutation (gpu-nested) must gather through `slotOfNode` in the pack pass and take it on every
 * device (spec §6.5.2).
 */
export interface ReadbackSource {
  /** The current (read-side) `rg32f` position texture — what the pack pass samples. */
  readonly positionTexture: Texture;
  /** A framebuffer with that texture attached — what the fast path copies from. */
  readonly positionFramebuffer: Framebuffer;
  /** Position atlas width, texels. */
  readonly positionWidth: number;
  /** Position atlas rows. */
  readonly atlasRows: number;
  /** Nodes, i.e. positions in node order. */
  readonly nodeCount: number;
  /** The segment table's `stats` and `box` textures (1×1 each for the flat layout). */
  readonly segmentStats: { readonly stats: Texture; readonly box: Texture };
  /** The stop latch's current texel (1×1), from the same reduction as {@link segmentStats} (#376). */
  readonly stopState: Texture;
}

/** The raw WebGL handle behind a luma framebuffer, or an error for a non-WebGL one (never on this path). */
function fboHandle(fbo: Framebuffer): WebGLFramebuffer {
  if (!(fbo instanceof WEBGLFramebuffer) || fbo.handle === null) {
    throw new Error("AsyncPositionReadback: expected an offscreen WebGL framebuffer");
  }
  return fbo.handle;
}

/**
 * A raw pixel-pack buffer. Its `STREAM_READ` storage is sized by the first copy ({@link sizeOnce}), not
 * here: Chrome counts the sizing `bufferData` as a write, so sizing it a frame before the first
 * `readPixels` would leave a fence in between and log "written again before being read back" once.
 */
function packBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const pbo = gl.createBuffer();
  if (pbo === null) throw new Error("AsyncPositionReadback: could not create a readback buffer");
  return pbo;
}

/**
 * The position PBO and the stats PBO, one copy in flight at a time. {@link issue} copies; {@link harvest}
 * (once the caller's fence after the copy has signalled) moves it to the CPU.
 */
export class AsyncPositionReadback {
  private readonly gl: WebGL2RenderingContext;
  private readonly pbo: WebGLBuffer;
  private readonly statsPbo: WebGLBuffer;
  /** Bytes of the position PBO. */
  private readonly positionBytes: number;
  private readonly count: number;
  /** Staging pack pass for the positions, only where the device does not read `RG/FLOAT`. */
  private readonly pack: PackPositionsPass | null;
  private readonly packStats: PackStatsPass;
  private copying = false;
  /** Whether the PBOs' storage has been allocated (by the first copy). */
  private sized = false;

  constructor(device: Device, source: ReadbackSource) {
    if (!(device instanceof WebGLDevice)) throw new Error("AsyncPositionReadback: a WebGL2 device is required");
    this.gl = device.gl;
    this.count = source.nodeCount;
    // Built in order; a failure frees what was already built before it propagates.
    let pack: PackPositionsPass | null = null;
    let packStats: PackStatsPass | null = null;
    let pbo: WebGLBuffer | null = null;
    try {
      pack = deviceReadsRG(device) ? null : new PackPositionsPass(device, source.nodeCount);
      packStats = new PackStatsPass(device);
      pbo = packBuffer(this.gl);
      this.statsPbo = packBuffer(this.gl);
    } catch (error) {
      if (pbo) this.gl.deleteBuffer(pbo);
      packStats?.destroy();
      pack?.destroy();
      throw error;
    }
    this.pack = pack;
    this.packStats = packStats;
    this.pbo = pbo;
    this.positionBytes = pack ? pack.width * pack.height * 16 : source.positionWidth * source.atlasRows * 8;
  }

  /** Whether a copy has been issued and not yet harvested (the PBOs are busy). */
  get pending(): boolean {
    return this.copying;
  }

  /** Bytes of GPU memory this readback holds: the two PBOs, the stats staging texel pair, and on the pack path the position staging texture. */
  get gpuBytes(): number {
    return this.positionBytes + 2 * STATS_BYTES + (this.pack ? this.pack.width * this.pack.height * 16 : 0);
  }

  /**
   * Copy `source`'s current positions and stats into the PBOs — GPU → GPU, the main thread does not
   * wait; one `readPixels` per PBO. The caller must insert a fence after this and {@link harvest} only
   * once it has signalled.
   */
  issue(source: ReadbackSource): void {
    const gl = this.gl;
    const pack = this.pack;
    if (pack) pack.run(source.positionTexture, source.positionWidth);
    this.packStats.run(source.segmentStats.stats, source.segmentStats.box, source.stopState);
    const previousRead: WebGLFramebuffer | null = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const previousPack: WebGLBuffer | null = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const first = !this.sized;
    this.sized = true;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    if (first) gl.bufferData(gl.PIXEL_PACK_BUFFER, this.positionBytes, gl.STREAM_READ);
    if (pack) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboHandle(pack.framebuffer));
      gl.readPixels(0, 0, pack.width, pack.height, gl.RGBA, gl.FLOAT, 0);
    } else {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboHandle(source.positionFramebuffer));
      gl.readPixels(0, 0, source.positionWidth, source.atlasRows, gl.RG, gl.FLOAT, 0);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statsPbo);
    if (first) gl.bufferData(gl.PIXEL_PACK_BUFFER, STATS_BYTES, gl.STREAM_READ);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboHandle(this.packStats.framebuffer));
    gl.readPixels(0, 0, STATS_TEXELS, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPack);
    this.copying = true;
  }

  /**
   * Move the finished copy to the CPU: the stats into `stats` (≥ {@link READBACK_STATS_FLOATS} floats),
   * then — only when every stat is finite — the positions into `positions[0 .. 2·count)`, so a layout
   * that went non-finite never overwrites the last good positions. Returns whether the stats were
   * finite. Call it only after a fence inserted after {@link issue} has signalled.
   */
  harvest(positions: Float32Array, stats: Float32Array): boolean {
    const gl = this.gl;
    const previousPack: WebGLBuffer | null = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statsPbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, stats, 0, READBACK_STATS_FLOATS);
    let finite = true;
    for (let i = 0; i < READBACK_STATS_FLOATS; i++) {
      if (!Number.isFinite(stats[i] ?? Number.NaN)) finite = false;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    if (finite) gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, positions, 0, this.count * 2);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPack);
    this.copying = false;
    return finite;
  }

  /** Forget a copy that will never be harvested (the run stopped or its context was lost). */
  abandon(): void {
    this.copying = false;
  }

  /** Free the PBOs and the staging passes. Pass `false` on a lost context: then nothing touches GL. */
  destroy(touchGl = true): void {
    this.copying = false;
    if (!touchGl) return;
    this.gl.deleteBuffer(this.pbo);
    this.gl.deleteBuffer(this.statsPbo);
    this.pack?.destroy();
    this.packStats.destroy();
  }
}
