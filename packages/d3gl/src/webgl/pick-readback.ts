import { decodePickColor } from "./palette.js";

/**
 * Stall-free single-pixel readback from the GPU pick FBO (#141).
 *
 * A synchronous `gl.readPixels` forces the driver to flush the command queue and block the JS thread
 * until the GPU drains and the pixel travels back — fine once, but during a hover drag the browser
 * fires a `pointermove` ~every frame, so a sync read per move stalls ~per frame (worse the heavier the
 * scene). This reader avoids that with a double-buffered WebGL2 Pixel Buffer Object (PBO):
 *
 * - {@link read} (hover): issue a *non-blocking* `readPixels` into a PBO (a GPU→GPU copy) and fence it,
 *   then return the *previous* call's already-finished result. The decoded id therefore lags the cursor
 *   by one pointer event (~16 ms) — imperceptible for hover — and the JS thread never blocks. The two
 *   PBOs ping-pong: each call harvests the one written last call and writes the other.
 * - {@link readSync} (click): a plain blocking `readPixels` at exactly (x, y). A click is a single
 *   discrete event, so one flush is negligible and the caller gets the current, exact pixel.
 *
 * Coordinates passed in are **device pixels, bottom-left origin** (already flipped + dpr-scaled by the
 * caller, which owns the FBO size) — this reader is a dumb pixel reader and knows nothing about CSS px.
 */
export class PickReadback {
  private slots: { pbo: WebGLBuffer; sync: WebGLSync | null }[];
  /** Index of the slot the next {@link read} will write into; the other holds the pending readback. */
  private cur = 0;
  /** Last successfully decoded id, returned by {@link read} until a fresher readback completes. */
  private last = -1;

  constructor(private gl: WebGL2RenderingContext) {
    this.slots = [
      { pbo: gl.createBuffer()!, sync: null },
      { pbo: gl.createBuffer()!, sync: null },
    ];
    // Size both PBOs for one RGBA8 texel (4 bytes). STREAM_READ hints repeated GPU→CPU readback.
    for (const s of this.slots) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  /**
   * Hover path: kick an async readback at device-pixel (px, py) and return the *previous* call's
   * decoded id (instance index, or -1 for background). Never blocks the JS thread.
   */
  read(fb: WebGLFramebuffer | null, px: number, py: number): number {
    const gl = this.gl;
    // Harvest the readback issued on the previous call (the other slot); update `last` if it's ready.
    const prev = this.slots[1 - this.cur]!;
    if (prev.sync) {
      // SYNC_FLUSH_COMMANDS_BIT forces a flush as part of the (non-blocking, timeout 0) poll, so the
      // fence is guaranteed reachable — without it a sync can spin un-signaled forever if the commands
      // were never flushed to the GPU (observed under headless software-GL contention).
      const status = gl.clientWaitSync(prev.sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        this.last = this.harvest(prev.pbo);
        gl.deleteSync(prev.sync);
        prev.sync = null;
      }
      // Not ready yet (rare): keep `last`; this slot is harvested again next time it comes around.
    }
    // Kick a new non-blocking readback into the current slot. Abandon any unharvested fence first.
    const slot = this.slots[this.cur]!;
    if (slot.sync) {
      gl.deleteSync(slot.sync);
      slot.sync = null;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0); // → PBO, no CPU wait
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush(); // ensure the fence + copy are actually submitted so they can complete by next call
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.cur = 1 - this.cur;
    return this.last;
  }

  /**
   * Click path: blocking readback of the current pixel at device-pixel (px, py). Decoded id, or -1.
   * Also primes {@link read}'s cache so an immediately-following hover returns the same value.
   */
  readSync(fb: WebGLFramebuffer | null, px: number, py: number): number {
    const gl = this.gl;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); // read straight to CPU (no PBO bound)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.last = decodePickColor(out[0]!, out[1]!, out[2]!);
    return this.last;
  }

  /** Copy the 4 bytes already DMA'd into `pbo` out to the CPU and decode (no stall — fence signaled). */
  private harvest(pbo: WebGLBuffer): number {
    const gl = this.gl;
    const out = new Uint8Array(4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return decodePickColor(out[0]!, out[1]!, out[2]!);
  }

  destroy(): void {
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.sync) gl.deleteSync(s.sync);
      gl.deleteBuffer(s.pbo);
    }
  }
}
