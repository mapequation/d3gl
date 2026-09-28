import type { Device, Framebuffer, RenderPass, RenderPipelineParameters } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup for the GPU layout's compute-in-raster passes.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every per-slot pass (integrate, springs, repulsion, centering, prolongation, the pyramid and
// reduction levels) is one full-screen triangle over a target atlas: each fragment is one output
// texel. This module owns that setup once, and owns the render-pass opening so the clear is always
// an explicit choice (see {@link beginPass}).

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

/** A full-screen-triangle {@link Model} for fragment shader `fs` (no vertex buffer, 3 vertices). */
export function fullScreenModel(
  device: Device,
  fs: string,
  uniforms: PassUniforms,
  parameters: RenderPipelineParameters,
): Model {
  return new Model(device, {
    vs: FULLSCREEN_VS,
    fs,
    topology: "triangle-list",
    vertexCount: 3,
    uniforms,
    parameters,
  });
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
 *   which ignores the viewport — only a scissor limits it), so a clearing pass takes no viewport;
 * - `false` keeps the contents, and may restrict rasterisation to a `viewport` sub-rectangle — how a
 *   pass writes one level of a packed texture without touching the others.
 */
export type PassTarget =
  | { readonly framebuffer: Framebuffer; readonly clear: ClearColor }
  | { readonly framebuffer: Framebuffer; readonly clear: false; readonly viewport?: PassViewport };

/**
 * Open a render pass on `target`. Depth and stencil are never cleared (the layout's framebuffers
 * have neither), and the colour clear is exactly what the target says.
 */
export function beginPass(device: Device, target: PassTarget): RenderPass {
  if (target.clear === false) {
    return device.beginRenderPass({
      framebuffer: target.framebuffer,
      clearColor: false,
      clearDepth: false,
      clearStencil: false,
      ...(target.viewport ? { parameters: { viewport: target.viewport } } : {}),
    });
  }
  const [r, g, b, a] = target.clear;
  return device.beginRenderPass({
    framebuffer: target.framebuffer,
    clearColor: [r, g, b, a],
    clearDepth: false,
    clearStencil: false,
  });
}
