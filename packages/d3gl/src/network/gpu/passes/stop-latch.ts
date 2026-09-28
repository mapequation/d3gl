import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { INITIAL_STOP_STATE, STOP_NONFINITE, STOP_STOPPED } from "../stop-latch.js";
import { NO_BLEND, beginPass, fullScreenModel, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// Stop latch pass (#376, spec §6.5.5): one fragment, once per reduction
// ─────────────────────────────────────────────────────────────────────────────
//
// The GLSL twin of `latchStop` (`../stop-latch.ts`, which documents the rule and the texel). It reads
// the flat segment's stats `(Σx, Σy, Σ|v|, count)` and the current latch texel, and writes the next
// texel into the other side of a two-texture ping-pong (a pass may not sample the texture it renders
// into, even another texel of it). The integrate pass reads the current side.
//
// Finiteness is tested on the exponent bits, not with `isnan` / `isinf`: a compiler allowed to assume
// finite floats (fast math) may fold those to `false`.

/** Shared with the integrate pass: the latch flags and the finiteness test. */
export const STOP_LATCH_GLSL = /* glsl */ `\
const uint STOP_STOPPED = ${STOP_STOPPED}u;
const uint STOP_NONFINITE = ${STOP_NONFINITE}u;
bool nonFinite(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
`;

const FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform highp sampler2D u_stats; // (Σx, Σy, Σ|v|, count) of segment 0
uniform highp sampler2D u_state; // (prevStep, stopTick, epoch, flags)
uniform float u_threshold;       // CONVERGED_STEP · spacing
uniform float u_tick;            // ticks integrated so far
uniform float u_epoch;           // the current schedule
uniform int u_evaluate;          // first run at this tick boundary
uniform int u_sample;            // a tick has been integrated
uniform int u_armed;             // the CPU half of the rule holds
layout(location = 0) out vec4 o_state;
${STOP_LATCH_GLSL}

void main() {
  vec4 stats = texelFetch(u_stats, ivec2(0), 0);
  vec4 state = texelFetch(u_state, ivec2(0), 0);
  bool same = state.z == u_epoch;
  uint flags = uint(state.w);
  if (!same) flags &= STOP_NONFINITE;
  float stopTick = same ? state.y : -1.0;
  float prevStep = state.x;
  if (nonFinite(stats.x) || nonFinite(stats.y) || nonFinite(stats.z)) {
    flags |= STOP_NONFINITE;
  } else if (u_evaluate != 0) {
    float step = stats.z / max(stats.w, 1.0);
    if (u_sample == 0) {
      prevStep = 0.0;
    } else {
      if ((flags & STOP_STOPPED) == 0u && u_armed != 0 && step < u_threshold && step <= prevStep) {
        flags |= STOP_STOPPED;
        stopTick = u_tick;
      }
      prevStep = step;
    }
  }
  o_state = vec4(prevStep, stopTick, u_epoch, float(flags));
}
`;

/** One latch evaluation's CPU-side inputs (see `StopInput`; the stats come from the texture). */
export interface StopLatchUniforms {
  evaluate: boolean;
  sample: boolean;
  armed: boolean;
  threshold: number;
  tick: number;
  epoch: number;
}

/** GL enums of the float readback every `EXT_color_buffer_float` device supports. */
const GL_RGBA = 0x1908;
const GL_FLOAT = 0x1406;

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

/**
 * The latch texel's two 1×1 `rgba32float` sides, their framebuffers and the pass — all created once.
 * {@link run} evaluates into the other side and flips; {@link state} is the current side, which the
 * integrate pass and the streaming readback read. 32 bytes of texture.
 */
export class StopLatchPass {
  private readonly device: Device;
  private readonly sides: readonly [Texture, Texture];
  private readonly fbos: readonly [Framebuffer, Framebuffer];
  private readonly model: Model;
  private readonly uniforms: PassUniforms;
  /** Which side is current: 0 or 1. */
  private current: 0 | 1 = 0;

  constructor(device: Device) {
    this.device = device;
    const init = new Float32Array([INITIAL_STOP_STATE.prevStep, INITIAL_STOP_STATE.stopTick, INITIAL_STOP_STATE.epoch, INITIAL_STOP_STATE.flags]);
    const side = (): Texture =>
      device.createTexture({ width: 1, height: 1, format: "rgba32float", data: init, mipLevels: 1, sampler: NEAREST });
    const a = side();
    const b = side();
    this.sides = [a, b];
    this.fbos = [
      device.createFramebuffer({ width: 1, height: 1, colorAttachments: [a] }),
      device.createFramebuffer({ width: 1, height: 1, colorAttachments: [b] }),
    ];
    this.uniforms = { u_threshold: 0, u_tick: 0, u_epoch: 0, u_evaluate: 0, u_sample: 0, u_armed: 0 };
    this.model = fullScreenModel(device, FS, this.uniforms, NO_BLEND);
  }

  /** The current latch texel `(prevStep, stopTick, epoch, flags)`. */
  get state(): Texture {
    return this.current === 0 ? this.sides[0] : this.sides[1];
  }

  /**
   * Read the current texel synchronously into `out[0..4)` (`RGBA/FLOAT`, which WebGL2 guarantees for an
   * `rgba32float` attachment). For tests and one-off reads — never on the streaming path.
   */
  read(out: Float32Array): void {
    this.device.readPixelsToArrayWebGL(this.current === 0 ? this.fbos[0] : this.fbos[1], {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 1,
      sourceHeight: 1,
      sourceFormat: GL_RGBA,
      sourceType: GL_FLOAT,
      target: out,
    });
  }

  /** Evaluate the latch over `stats` (the segment table's, 1×1) into the other side, then flip. */
  run(stats: Texture, u: StopLatchUniforms): void {
    this.uniforms["u_threshold"] = u.threshold;
    this.uniforms["u_tick"] = u.tick;
    this.uniforms["u_epoch"] = u.epoch;
    this.uniforms["u_evaluate"] = u.evaluate ? 1 : 0;
    this.uniforms["u_sample"] = u.sample ? 1 : 0;
    this.uniforms["u_armed"] = u.armed ? 1 : 0;
    this.model.setBindings({ u_stats: stats, u_state: this.state });
    // The one texel is always written, so nothing needs clearing.
    const pass = beginPass(this.device, { framebuffer: this.current === 0 ? this.fbos[1] : this.fbos[0], clear: false });
    this.model.draw(pass);
    pass.end();
    this.device.submit();
    this.current = this.current === 0 ? 1 : 0;
  }

  destroy(): void {
    this.model.destroy();
    this.fbos[0].destroy();
    this.fbos[1].destroy();
    this.sides[0].destroy();
    this.sides[1].destroy();
  }
}
