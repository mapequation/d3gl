import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { ADDITIVE_BLEND, beginPass, fullScreenModel, NO_BLEND } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// GPU grid pyramid — a regular quadtree over the layout bounding box.
// ─────────────────────────────────────────────────────────────────────────────
//
// The pyramid backs Barnes-Hut repulsion (see repulsion-pyramid.ts). It is a
// COMPLETE quadtree with regular cell indexing, so it needs no Morton sort and
// no double-counting logic:
//
//   level 0    = the finest grid, G×G cells (G a power of two)
//   level ℓ    = (G >> ℓ) × (G >> ℓ) cells, each summing its 2×2 children
//   level L    = the 1×1 root, where L = log2(G)
//
// Each cell of level 0 holds (Σx, Σy, mass, Σ|p−cellCenter|²) in rgba32float;
// unit mass means mass = the node count in the cell and COM = (Σx/mass, Σy/mass).
// The w channel is the occupants' second moment about the cell center, consumed
// only at level 0 by the BH pass's near-field softening (#251). Coarser levels
// sum the (Σx, Σy, mass) of their four children, so the root holds the totals
// over all nodes — exactly the CPU BarnesHutTree's root mass/COM.
//
// Build per tick, from the layout's bounding box — the segment table's `box` texel
// (maxX, maxY, -minX, -minY), which the segmented range query computes this tick
// (see segmented-reduce.ts; it replaced a 1-px MAX-blend scatter of every node):
//   1. scatterPass — POINTS scatter with ADD blend → level-0 grid (Σx, Σy, mass)
//   2. reducePass  — full-screen triangle per level, summing 2×2 blocks → level ℓ+1
//
// All level textures + FBOs are pre-created in the constructor — no per-tick
// createTexture / createFramebuffer (keeps the spy test green).

// ── Grid-resolution choice ──────────────────────────────────────────────────
//
// G = clamp(nextPow2(ceil(sqrt(count))), 16, 1024).
//
// Rationale: a G×G grid has G² cells. Choosing G ≈ sqrt(count) gives ≈ count
// cells at the finest level, so on a roughly uniform layout each leaf cell holds
// O(1) nodes — the finest level already discriminates individual nodes, matching
// the CPU quadtree's leaves. Clamped to [16, 1024]:
//   - floor 16 keeps a minimum of L=4 pyramid levels so BH traversal has depth
//     to prune even for tiny N (below the all-pairs threshold anyway);
//   - ceiling 1024 (1M cells, L=10) bounds the pyramid's memory and the
//     scatter/reduce cost; at 1M nodes leaf cells average ~1 node, which is the
//     regime BH is designed for.
export function chooseGrid(count: number): number {
  const target = Math.ceil(Math.sqrt(Math.max(1, count)));
  let g = 1;
  while (g < target) g <<= 1; // next power of two ≥ target
  if (g < 16) g = 16;
  if (g > 1024) g = 1024;
  return g;
}

// ── Scatter to the finest grid (POINTS + ADD blend) ──────────────────────────
//
// Each node reads its position, maps it into the [0,G) cell grid from the AABB,
// emits a point at that cell's clip-space center, and carries the NODE position
// to the fragment so we accumulate Σ(node position) (not Σ(cell center)). The FS
// writes (x, y, mass=1, |p−cellCenter|²); additive blend gives
// (Σx, Σy, mass, Σ|p−cellCenter|²) per cell. The w channel is the raw second
// moment about the CELL CENTER — the BH traversal turns it into the cell's
// second CENTRAL moment (σ² = w/m − |com − cellCenter|²) for the level-0
// near-field softening (#251). Accumulating about the cell center (offsets
// ≤ cellSize/√2) instead of the origin keeps the float32 blend-sum
// well-conditioned; coarser levels sum w like the other channels, which is
// meaningless across differing cell centers — only level 0 reads it.
//
// The bbox texel is (maxX, maxY, -minX, -minY). We recover min/max, then build a
// SQUARE padded box centered on the AABB center — half = pad·max(halfX, halfY) —
// exactly like quadtree.ts (which makes the root square: half = max extent / 2).
// A square box keeps cells square, so cellSize = boxSide / cellsPerSide is a
// single unambiguous value the BH traversal reuses. Then
//   cell = clamp(floor((p - lo) / boxSide * G), 0, G-1).
const SCATTER_VS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp sampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_box;   // segment box (maxX, maxY, -minX, -minY), segment 0 at (0,0)
uniform int   u_width;
uniform int   u_grid;            // G (finest grid side)
uniform float u_pad;             // box padding factor (e.g. 1.01)
flat out vec2 v_pos;
flat out float v_r2;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = slotTexel(gl_VertexID, u_width);
  vec2 p = texelFetch(u_pos, c, 0).xy;

  vec4 b = texelFetch(u_box, ivec2(0, 0), 0);
  vec2 mx = b.xy;
  vec2 mn = -b.zw;
  vec2 ctr = 0.5 * (mn + mx);
  vec2 hlf = 0.5 * (mx - mn);
  // NOTE: 'half' is a reserved word in GLSL ES 3.00 — use hlfMax.
  float hlfMax = max(max(hlf.x, hlf.y) * u_pad, 1e-6); // square, padded
  vec2 lo = ctr - vec2(hlfMax);
  float boxSide = 2.0 * hlfMax;

  vec2 t = (p - lo) / boxSide;
  float G = float(u_grid);
  vec2 cell = clamp(floor(t * G), vec2(0.0), vec2(G - 1.0));

  vec2 clip = ((cell + 0.5) / G) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_pos = p;
  // Second-moment channel (#251): squared offset from the cell center. The
  // center uses the SAME expression the BH traversal uses to rebuild it, so a
  // single-occupant cell's variance (w/m − |com − cellCenter|²) cancels
  // exactly to 0.
  vec2 cellCenter = lo + (cell + 0.5) / G * boxSide;
  vec2 rel = p - cellCenter;
  v_r2 = dot(rel, rel);
}
`;

const SCATTER_FS = /* glsl */ `\
#version 300 es
precision highp float;
flat in vec2 v_pos;
flat in float v_r2;
out vec4 o_cell;
void main() {
  // (Σx, Σy, mass=1, Σ|p−cellCenter|²). Additive blend accumulates per cell.
  o_cell = vec4(v_pos, 1.0, v_r2);
}
`;

// ── Mip reduce (full-screen triangle, sum 2×2 children) ──────────────────────
//
// Output level ℓ+1 (side S) reads level ℓ (side 2S) and sums its 2×2 block:
//   out(x,y) = Σ in(2x+{0,1}, 2y+{0,1})
// texelFetch on the finer level; out-of-range fetches never happen because the
// input is always exactly 2S×2S (G is a power of two).
const REDUCE_FS = /* glsl */ `\
#version 300 es
precision highp float;
uniform sampler2D u_src;   // finer level (side = 2 * this level's side)
out vec4 o_cell;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  ivec2 i = o * 2;
  vec4 a = texelFetch(u_src, i + ivec2(0, 0), 0);
  vec4 b = texelFetch(u_src, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(u_src, i + ivec2(0, 1), 0);
  vec4 d = texelFetch(u_src, i + ivec2(1, 1), 0);
  o_cell = a + b + c + d;
}
`;

/**
 * A single pyramid level: an rgba32float texture (side×side) + its FBO.
 * levels[0] is the finest (G×G); levels[L] is the 1×1 root.
 */
interface Level {
  readonly side: number;
  readonly tex: Texture;
  readonly fbo: Framebuffer;
}

/** Uniforms/inputs for a pyramid build. */
export interface PyramidBuildInput {
  /** Current node positions texture (rg32float atlas). */
  posTex: Texture;
  /**
   * The layout's bounding box, `(maxX, maxY, -minX, -minY)` at texel (0, 0) — the segment table's
   * `box` for the flat layout's single segment, computed this tick by the range query.
   */
  boxTex: Texture;
  /** Number of real nodes. */
  count: number;
  /** Atlas width of the positions texture. */
  width: number;
}

/**
 * GPU grid pyramid — builds and holds a regular-quadtree COM/mass pyramid over
 * the current layout. Owns all level textures, their FBOs and the two build
 * models. Rebuilt each tick via {@link build} from the layout's box.
 *
 * The level textures are exposed via {@link levelTextures} and {@link levelCount}
 * so the BH repulsion pass can `texelFetch` any level.
 */
export class GridPyramid {
  private readonly device: Device;
  /** Finest grid side (G, a power of two). */
  readonly grid: number;
  /** Number of pyramid levels = log2(G) + 1 (finest .. 1×1 root). */
  readonly levelCount: number;

  private readonly levels: readonly Level[];

  private readonly scatterModel: Model;
  private readonly reduceModel: Model;

  /**
   * Box padding factor so max-corner nodes fall strictly inside the grid. The
   * BH repulsion pass must apply the SAME padding when it recomputes cell
   * geometry from the box texture, so it's exposed as a public readonly.
   */
  readonly pad = 1.01;

  private readonly scatterUniforms: Record<string, number>;

  constructor(device: Device, count: number) {
    this.device = device;
    const G = chooseGrid(count);
    this.grid = G;
    this.levelCount = Math.log2(G) + 1; // integer: G is a power of two ≥ 16

    // Pre-create every pyramid level texture + FBO (finest G×G down to 1×1).
    const levels: Level[] = [];
    for (let side = G; side >= 1; side >>= 1) {
      const tex = device.createTexture({
        width: side,
        height: side,
        format: "rgba32float",
        mipLevels: 1,
        sampler: { minFilter: "nearest", magFilter: "nearest" },
      });
      const fbo = device.createFramebuffer({
        width: side,
        height: side,
        colorAttachments: [tex],
      });
      levels.push({ side, tex, fbo });
    }
    this.levels = levels;

    // ── Models ────────────────────────────────────────────────────────────
    this.scatterUniforms = { u_width: 1, u_grid: G, u_pad: this.pad };
    this.scatterModel = new Model(device, {
      vs: SCATTER_VS,
      fs: SCATTER_FS,
      topology: "point-list",
      vertexCount: 1, // overridden per build
      uniforms: this.scatterUniforms,
      parameters: ADDITIVE_BLEND,
    });

    // No blend: each reduce output texel is written exactly once.
    this.reduceModel = fullScreenModel(device, REDUCE_FS, {}, NO_BLEND);
  }

  /** Texture for pyramid level `ℓ` (0 = finest G×G, levelCount-1 = 1×1 root). */
  levelTexture(level: number): Texture {
    return this.levels[level]!.tex;
  }

  /**
   * Rebuild the pyramid from the current positions and the layout's box. Runs
   * two sub-steps, each in its own render pass (different FBO sizes / clear needs):
   *   1. clear finest grid to 0 then ADD-scatter → (Σx, Σy, mass, Σ|p−cc|²)
   *   2. reduce finest → … → 1×1 root (one pass per coarser level)
   *
   * Caller must `device.submit()` after (or between) as needed; this method
   * submits internally after each pass so downstream reads see the results.
   */
  build(input: PyramidBuildInput): void {
    const { posTex, boxTex, count, width } = input;

    // ── 1. Scatter to finest grid (ADD blend into G×G) ────────────────────
    const finest = this.levels[0]!;
    const scatterPass = beginPass(this.device, { framebuffer: finest.fbo, clear: [0, 0, 0, 0] });
    this.scatterUniforms["u_width"] = width;
    // u_grid / u_pad are constant (set in constructor).
    this.scatterModel.setBindings({ u_pos: posTex, u_box: boxTex });
    this.scatterModel.setVertexCount(count);
    this.scatterModel.draw(scatterPass);
    scatterPass.end();
    this.device.submit();

    // ── 2. Mip reduce (finest → 1×1) ──────────────────────────────────────
    // Each pass reads level ℓ and writes level ℓ+1 (half the side). No blend;
    // no clear needed since every output texel is written by the shader.
    for (let lvl = 0; lvl < this.levelCount - 1; lvl++) {
      const src = this.levels[lvl]!;
      const dst = this.levels[lvl + 1]!;
      const reducePass = beginPass(this.device, { framebuffer: dst.fbo, clear: false });
      this.reduceModel.setBindings({ u_src: src.tex });
      this.reduceModel.draw(reducePass);
      reducePass.end();
      this.device.submit();
    }
  }

  destroy(): void {
    for (const lvl of this.levels) {
      lvl.tex.destroy();
      lvl.fbo.destroy();
    }
    this.scatterModel.destroy();
    this.reduceModel.destroy();
  }
}
