import type { Device, Framebuffer, PrimitiveTopology, RenderPass, RenderPipelineParameters } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { noteProgramBuilt, type LayoutProgram } from "../programs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup for the GPU layout's compute-in-raster passes.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every per-slot pass (integrate, springs, repulsion, centering, prolongation, the pyramid and
// reduction levels) is one full-screen triangle over a target atlas: each fragment is one output
// texel. This module owns that setup once, and owns the render-pass opening so the clear is always
// an explicit choice (see {@link beginPass}).
//
// **No pass submits (#402).** WebGL runs a render pass's draws as they are encoded, so a pass needs no
// `device.submit()` for the passes after it to see its output. What luma's submit adds is main-thread work:
// a new command encoder, a command buffer and a promise (6.5 µs a call on an M1 Max, a quarter of a small
// pass's encode). So the passes never submit; the solvers submit once per **work item** (`beginTick`,
// `forceBand`, `integrate`, a seed step, a readback copy), after all of its passes. And **no pass only
// clears**: a clear is the `clear` of the first pass that draws into its target, never a pass of its own.

/**
 * Full-screen triangle generated from `gl_VertexID` — vertices (-1,-1), (3,-1), (-1,3) cover the
 * whole viewport, so no vertex buffer is needed. Each fragment of the viewport runs once.
 */
export const FULLSCREEN_VS = /* glsl */ `\
#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

/**
 * Additive blend (dst += src), the force accumulator's contract: every force pass adds its per-node
 * contribution into the `force` texture. Float targets need `EXT_float_blend`.
 */
export const ADDITIVE_BLEND: RenderPipelineParameters = {
  blend: true,
  blendColorSrcFactor: "one",
  blendColorDstFactor: "one",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one",
  blendColorOperation: "add",
  blendAlphaOperation: "add",
};

/** No blending: each output texel is written exactly once. */
export const NO_BLEND: RenderPipelineParameters = { blend: false };

/**
 * Mutable uniforms record — the luma v9 pattern the passes use: the record is handed to the
 * {@link Model} once and mutated in place before each draw, so updating a value allocates nothing.
 * A vector or array uniform (`vec2`, `ivec2 u[n]`) takes a typed array, allocated once with the pass.
 */
export type PassUniforms = Record<string, number | Float32Array | Int32Array>;

/** The full-screen-triangle program of fragment shader `fs` (#385: what a pass declares, and the warm-up links). */
export function fullScreenProgram(fs: string): LayoutProgram {
  return { vs: FULLSCREEN_VS, fs };
}

/** How a layout model draws: a full-screen triangle (the default), or `vertexCount` points (a scatter). */
export interface LayoutDraw {
  readonly topology: PrimitiveTopology;
  readonly vertexCount: number;
}

const FULL_SCREEN_DRAW: LayoutDraw = { topology: "triangle-list", vertexCount: 3 };

/**
 * The {@link Model} of a layout pass's `program` (no vertex buffer; a full-screen triangle unless `draw` says
 * otherwise). Every layout model is built here — the only way a layout pass builds one — so the device records
 * the program as built (#385): a later layout on it finds the program in luma's cache and warms nothing.
 */
export function layoutModel(
  device: Device,
  program: LayoutProgram,
  uniforms: PassUniforms,
  parameters: RenderPipelineParameters,
  draw: LayoutDraw = FULL_SCREEN_DRAW,
): Model {
  const model = new Model(device, {
    vs: program.vs,
    fs: program.fs,
    topology: draw.topology,
    vertexCount: draw.vertexCount,
    uniforms,
    parameters,
  });
  noteProgramBuilt(device, program);
  return model;
}

/** An RGBA clear colour. */
export type ClearColor = readonly [number, number, number, number];

/** A sub-rectangle `[x, y, width, height]` of the attachment, in texels. */
export type PassViewport = [number, number, number, number];

/**
 * Where a pass renders and what happens to the attachment first. `clear` is required, so no call
 * site gets luma's default clear by omission:
 *
 * - a colour clears the **whole** attachment (luma 9.3.3 `WEBGLRenderPass.clear()` calls `gl.clear`,
 *   which ignores the viewport — only a scissor limits it), so a clearing pass takes no viewport, only an
 *   optional `scissor`: luma applies the pass's scissor before its clear, so the clear and the pass's draws
 *   then touch only that rectangle (how a multilevel seed level clears just its own rows or grid, #353);
 * - `false` keeps the contents, and may restrict rasterisation to a `viewport` sub-rectangle — how a
 *   pass writes one level of a packed texture without touching the others — or to a `scissor`
 *   rectangle, which keeps the viewport (so the slot ↔ texel mapping) of the whole attachment and only
 *   drops the fragments outside it: how the force pass runs one row band at a time (#352).
 */
export type PassTarget =
  | {
      readonly framebuffer: Framebuffer;
      readonly clear: ClearColor;
      /** Limits the clear (and the draws) to this rectangle. */
      readonly scissor?: PassViewport;
      /** Maps the draws onto this rectangle; it does not limit the clear, so pair it with an equal `scissor`. */
      readonly viewport?: PassViewport;
    }
  | {
      readonly framebuffer: Framebuffer;
      readonly clear: false;
      readonly viewport?: PassViewport;
      readonly scissor?: PassViewport;
    };

/**
 * Open a render pass on `target`. Depth and stencil are never cleared (the layout's framebuffers
 * have neither), and the colour clear is exactly what the target says.
 */
export function beginPass(device: Device, target: PassTarget): RenderPass {
  if (target.clear === false) {
    const { viewport, scissor } = target;
    return device.beginRenderPass({
      framebuffer: target.framebuffer,
      clearColor: false,
      clearDepth: false,
      clearStencil: false,
      ...(viewport || scissor
        ? { parameters: { ...(viewport ? { viewport } : {}), ...(scissor ? { scissorRect: scissor } : {}) } }
        : {}),
    });
  }
  const [r, g, b, a] = target.clear;
  return device.beginRenderPass({
    framebuffer: target.framebuffer,
    clearColor: [r, g, b, a],
    clearDepth: false,
    clearStencil: false,
    ...(target.scissor || target.viewport
      ? { parameters: { ...(target.viewport ? { viewport: target.viewport } : {}), ...(target.scissor ? { scissorRect: target.scissor } : {}) } }
      : {}),
  });
}
