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
 * - **One write, then one read, per PBO per copy.** Chrome keeps that shadow copy only if the buffer is
 *   written once and then fenced; a second write before the harvest discards it ("written again before
 *   being read back") and the harvest stalls the GPU pipeline — measured on web-NotreDame when the stats
 *   rode in the position PBO as two extra `readPixels`. The copy also serves only one `getBufferSubData`:
 *   a second read of the same copy is a synchronous round trip ("read back without waiting on a fence"),
 *   which the nested layout paid on every harvest while its module discs shared the position PBO. So the
 *   48 bytes of stats have their own PBO, filled by one `readPixels` of a 3×1 staging texture
 *   ({@link PackStatsPass}), and a packed source's extra floats have theirs, filled by one `readPixels` of
 *   the staging rows that hold them.
 * - **The copy reads the position texture itself** where the device reads `rg32f` as `RG/FLOAT` (the #351
 *   probe; ANGLE Metal): 8 bytes per atlas texel, no staging texture. Elsewhere the pack pass writes the
 *   positions into a staging `rgba32f` texture in node order first ({@link PackPositionsPass}) and the
 *   copy reads that as `RGBA/FLOAT`, the format WebGL2 guarantees.
 * - **The stats** are the segment table's `stats` `(Σx, Σy, Σ|v|, count)` and `box`
 *   `(maxX, maxY, −minX, −minY)` from the last tick's reductions, so the harvest can refuse a non-finite
 *   layout without scanning N positions, and the stop latch's texel `(prevStep, stopTick, epoch, flags)`
 *   (#376), so the transport learns of a convergence stop with the positions it froze.
 * - **The harvest allocates nothing**: `getBufferSubData` writes straight into the caller's positions
 *   array, a caller-owned 8-float stats array and the extra floats' array (luma's `Buffer.readSyncWebGL`
 *   would allocate per call).
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
 * Positions a solver has already packed in node order into an `rgba32float` staging texture — two nodes
 * per texel, `(x0, y0, x1, y1)`, row-major, so the copy read back is the interleaved positions array —
 * optionally followed by `extraFloats` more floats (the nested layout's module discs, #355) starting at
 * texel ⌈count / 2⌉. The solver writes it in its {@link StreamSolver.prepareReadback}.
 */
export interface PackedPositions {
  readonly framebuffer: Framebuffer;
  readonly width: number;
  readonly height: number;
  /** Floats after the ⌈count / 2⌉ position texels that a harvest can return (0 for none). */
  readonly extraFloats: number;
}

/**
 * What a readback copies: the solver's current positions and one range's stats.
 *
 * - Without `packed`, **slot order is node order** (the flat solver's identity permutation, spec §5.1):
 *   the `RG/FLOAT` copy reads the position atlas as it is, and the pack pass addresses slot = node id.
 * - A solver with a slot permutation (the nested layout, #355) gathers its positions into node order
 *   itself and hands the staging texture over as `packed`; the copy then reads that as `RGBA/FLOAT`, the
 *   format WebGL2 guarantees, on every device (spec §6.5.2).
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
  /**
   * The stop latch's current texel (1×1), from the same reduction as {@link segmentStats} (#376) — absent
   * for a solve without one (the nested layout's fixed tick count): the copy then carries no stop.
   */
  readonly stopState?: Texture;
  /**
   * The table texel of the range whose stats a copy carries — a non-finite stat refuses the harvest.
   * Default (0, 0): the flat layout's one segment; the nested layout's whole-slot range.
   */
  readonly statsTexel?: readonly [number, number];
  /** Positions already packed in node order (see {@link PackedPositions}); the copy reads them as they are. */
  readonly packed?: PackedPositions;
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
 * The position PBO, the stats PBO and — for a packed source's extra floats — the extras PBO, one copy in
 * flight at a time. {@link issue} copies; {@link harvest} (once the caller's fence after the copy has
 * signalled) moves it to the CPU, reading each PBO exactly once.
 */
export class AsyncPositionReadback {
  private readonly device: Device;
  private readonly gl: WebGL2RenderingContext;
  private readonly pbo: WebGLBuffer;
  private readonly statsPbo: WebGLBuffer;
  /** The extra floats' PBO, when a packed source's extras are read back (see the constructor). */
  private readonly extraPbo: WebGLBuffer | null;
  /** Rows of the copy the position PBO holds: the atlas, the pack pass's staging texture, or a packed source's position rows. */
  private readonly positionRows: number;
  /** Bytes of the position PBO. */
  private readonly positionBytes: number;
  private readonly count: number;
  /** Staging pack pass for the positions, only where the device does not read `RG/FLOAT` (and the source packs none). */
  private readonly pack: PackPositionsPass | null;
  private readonly packStats: PackStatsPass;
  /** Where the harvest lands the extra floats, and how many (a packed source's module discs; 0 for none). */
  private readonly extra: Float32Array | null;
  private readonly extraFloats: number;
  /** The staging rows the extras PBO copies (first row, count), its bytes, and the extras' byte offset in it. */
  private readonly extraRow: number;
  private readonly extraRows: number;
  private readonly extraBytes: number;
  private readonly extraOffset: number;
  private copying = false;
  /** Whether the PBOs' storage has been allocated (by the first copy). */
  private sized = false;

  /**
   * @param extra where each harvest lands a packed source's extra floats (up to its length and
   *   {@link PackedPositions.extraFloats}). Without it none are copied: every PBO a copy writes, the
   *   harvest reads.
   */
  constructor(device: Device, source: ReadbackSource, extra?: Float32Array) {
    if (!(device instanceof WebGLDevice)) throw new Error("AsyncPositionReadback: a WebGL2 device is required");
    this.device = device;
    this.gl = device.gl;
    this.count = source.nodeCount;
    const packed = source.packed;
    // Positions fill texels [0, ⌈count / 2⌉) of a packed source's staging texture, its extra floats the
    // texels after them; each PBO copies only the whole rows that hold its part.
    const positionTexels = Math.ceil(source.nodeCount / 2);
    this.extraFloats = packed ? Math.min(extra?.length ?? 0, packed.extraFloats) : 0;
    this.extra = this.extraFloats > 0 && extra ? extra : null;
    if (packed) {
      const lastTexel = positionTexels + Math.ceil(this.extraFloats / 4) - 1;
      if (Math.max(positionTexels - 1, lastTexel) >= packed.width * packed.height) {
        throw new Error("AsyncPositionReadback: the packed positions and extra floats overflow the staging texture");
      }
      this.extraRow = Math.floor(positionTexels / packed.width);
      this.extraRows = this.extra ? Math.floor(lastTexel / packed.width) - this.extraRow + 1 : 0;
      this.extraBytes = packed.width * this.extraRows * 16;
      this.extraOffset = (positionTexels - this.extraRow * packed.width) * 16;
    } else {
      this.extraRow = 0;
      this.extraRows = 0;
      this.extraBytes = 0;
      this.extraOffset = 0;
    }
    // Built in order; a failure frees what was already built before it propagates.
    let pack: PackPositionsPass | null = null;
    let packStats: PackStatsPass | null = null;
    let pbo: WebGLBuffer | null = null;
    let statsPbo: WebGLBuffer | null = null;
    try {
      pack = packed || deviceReadsRG(device) ? null : new PackPositionsPass(device, source.nodeCount);
      packStats = new PackStatsPass(device);
      pbo = packBuffer(this.gl);
      statsPbo = packBuffer(this.gl);
      this.extraPbo = this.extra ? packBuffer(this.gl) : null;
    } catch (error) {
      if (statsPbo) this.gl.deleteBuffer(statsPbo);
      if (pbo) this.gl.deleteBuffer(pbo);
      packStats?.destroy();
      pack?.destroy();
      throw error;
    }
    this.pack = pack;
    this.packStats = packStats;
    this.pbo = pbo;
    this.statsPbo = statsPbo;
    this.positionRows = packed
      ? Math.max(1, Math.ceil(positionTexels / packed.width))
      : pack
        ? pack.height
        : source.atlasRows;
    this.positionBytes = packed
      ? packed.width * this.positionRows * 16
      : pack
        ? pack.width * pack.height * 16
        : source.positionWidth * source.atlasRows * 8;
  }

  /** Whether a copy has been issued and not yet harvested (the PBOs are busy). */
  get pending(): boolean {
    return this.copying;
  }

  /** Bytes of GPU memory this readback holds: its PBOs, the stats staging texel pair, and on the pack path the position staging texture. */
  get gpuBytes(): number {
    return this.positionBytes + this.extraBytes + 2 * STATS_BYTES + (this.pack ? this.pack.width * this.pack.height * 16 : 0);
  }

  /**
   * Copy `source`'s current positions, stats and extra floats into the PBOs — GPU → GPU, the main thread
   * does not wait; one `readPixels` per PBO. The copy is one work item: the source's `prepareReadback` and the
   * staging passes here are submitted once, before the copies (#402). The caller must insert a fence after
   * this and {@link harvest} only once it has signalled.
   */
  issue(source: ReadbackSource): void {
    const gl = this.gl;
    const pack = this.pack;
    const packed = source.packed;
    if (pack) pack.run(source.positionTexture, source.positionWidth);
    const [sx, sy] = source.statsTexel ?? [0, 0];
    this.packStats.run(source.segmentStats.stats, source.segmentStats.box, source.stopState ?? null, sx, sy);
    this.device.submit();
    const previousRead: WebGLFramebuffer | null = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const previousPack: WebGLBuffer | null = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const first = !this.sized;
    this.sized = true;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    if (first) gl.bufferData(gl.PIXEL_PACK_BUFFER, this.positionBytes, gl.STREAM_READ);
    const staged = packed ?? pack;
    if (staged) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboHandle(staged.framebuffer));
      gl.readPixels(0, 0, staged.width, this.positionRows, gl.RGBA, gl.FLOAT, 0);
      if (this.extraPbo) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.extraPbo);
        if (first) gl.bufferData(gl.PIXEL_PACK_BUFFER, this.extraBytes, gl.STREAM_READ);
        gl.readPixels(0, this.extraRow, staged.width, this.extraRows, gl.RGBA, gl.FLOAT, 0);
      }
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
   * then — only when every stat is finite — the positions into `positions[0 .. 2·count)` and the extra
   * floats (see {@link PackedPositions}) into the constructor's `extra`, so a layout that went
   * non-finite never overwrites the last good positions. One `getBufferSubData` per PBO. Returns whether
   * the stats were finite. Call it only after a fence inserted after {@link issue} has signalled.
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
    if (finite) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, positions, 0, this.count * 2);
      if (this.extraPbo && this.extra) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.extraPbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, this.extraOffset, this.extra, 0, this.extraFloats);
      }
    }
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
    if (this.extraPbo) this.gl.deleteBuffer(this.extraPbo);
    this.pack?.destroy();
    this.packStats.destroy();
  }
}
