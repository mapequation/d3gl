import type { Device, RenderPass, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { fullScreenProgram, layoutModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";
import type { LayoutProgram } from "../programs.js";

// ─────────────────────────────────────────────────────────────────────────────
// The leaf seed of a module-tree multilevel seed (#180, #353; spec §6.4).
// ─────────────────────────────────────────────────────────────────────────────
//
// A module tree is ragged: a leaf may end at any depth, and it is placed there with its parent module and
// never subdivided. The one GPU solver reuses its slots level after level, so a level's terminal leaves
// must leave the solver before the next level overwrites their slots. Two passes carry them to the
// graph's node order without a readback:
//
//   1. scatter — after a level is solved, one POINT per terminal leaf of that level reads its slot's
//      position and writes it to its node's texel of the node-order `leafSeed` texture (no blend: each
//      node is written exactly once, by the level it ends at);
//   2. gather  — once every level is done, a full-screen pass copies `leafSeed` into the solver's write
//      side, with zero velocities (MRT), as the finest level's seed.

const SCATTER_VS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D  u_pos;         // the level's positions (the solver's read side)
uniform usampler2D u_leaves;      // (slot, node) per terminal leaf of the level (rg32ui)
uniform int u_leaf_width;         // atlas width of u_leaves
uniform int u_width;              // slot atlas width, shared by the node-order leaf seed
uniform int u_height;             // slot atlas height
flat out vec2 v_pos;
${SLOT_TEXEL_GLSL}
void main() {
  uvec2 e = texelFetch(u_leaves, slotTexel(gl_VertexID, u_leaf_width), 0).xy;
  v_pos = texelFetch(u_pos, slotTexel(int(e.x), u_width), 0).xy;
  vec2 t = vec2(slotTexel(int(e.y), u_width)) + 0.5;
  gl_Position = vec4(t / vec2(float(u_width), float(u_height)) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const SCATTER_FS = /* glsl */ `\
#version 300 es
precision highp float;
flat in vec2 v_pos;
layout(location = 0) out vec2 o_pos;
void main() {
  o_pos = v_pos;
}
`;

const GATHER_FS = /* glsl */ `\
#version 300 es
precision highp float;
uniform sampler2D u_leaf_seed;   // node-order positions of every terminal leaf
uniform int u_count;             // nodes
uniform int u_width;             // slot atlas width
layout(location = 0) out vec2 o_pos;
layout(location = 1) out vec2 o_vel;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  o_vel = vec2(0.0);
  o_pos = texelSlot(c, u_width) < u_count ? texelFetch(u_leaf_seed, c, 0).xy : vec2(0.0);
}
`;

/** The leaf seed's scatter and gather programs (#385). */
export function leafSeedPrograms(): { scatter: LayoutProgram; gather: LayoutProgram } {
  return { scatter: { vs: SCATTER_VS, fs: SCATTER_FS }, gather: fullScreenProgram(GATHER_FS) };
}

/** The leaf seed's scatter and gather (see the file header). Both models are created once, here. */
export class LeafSeedPass {
  private readonly scatterModel: Model;
  private readonly scatterUniforms: PassUniforms;
  private readonly gatherModel: Model;
  private readonly gatherUniforms: PassUniforms;

  constructor(device: Device) {
    this.scatterUniforms = { u_leaf_width: 1, u_width: 1, u_height: 1 };
    const programs = leafSeedPrograms();
    // One point per leaf entry: vertexCount is set per draw.
    this.scatterModel = layoutModel(device, programs.scatter, this.scatterUniforms, NO_BLEND, { topology: "point-list", vertexCount: 1 });
    this.gatherUniforms = { u_count: 0, u_width: 1 };
    this.gatherModel = layoutModel(device, programs.gather, this.gatherUniforms, NO_BLEND);
  }

  /**
   * Draw `leaves` points into an open pass on the leaf seed's framebuffer (`width × height`, node order):
   * entry k of `leafTex` is (slot, node), and node's texel gets the slot's position from `posTex`.
   */
  scatter(pass: RenderPass, posTex: Texture, leafTex: Texture, leafWidth: number, leaves: number, width: number, height: number): void {
    this.scatterUniforms["u_leaf_width"] = leafWidth;
    this.scatterUniforms["u_width"] = width;
    this.scatterUniforms["u_height"] = height;
    this.scatterModel.setBindings({ u_pos: posTex, u_leaves: leafTex });
    this.scatterModel.setVertexCount(leaves);
    this.scatterModel.draw(pass);
  }

  /** Copy the leaf seed's first `count` texels into an open MRT `[position, velocity]` pass, velocities zero. */
  gather(pass: RenderPass, leafSeedTex: Texture, count: number, width: number): void {
    this.gatherUniforms["u_count"] = count;
    this.gatherUniforms["u_width"] = width;
    this.gatherModel.setBindings({ u_leaf_seed: leafSeedTex });
    this.gatherModel.draw(pass);
  }

  destroy(): void {
    this.scatterModel.destroy();
    this.gatherModel.destroy();
  }
}
