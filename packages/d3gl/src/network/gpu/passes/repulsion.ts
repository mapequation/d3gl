import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import type { GridPyramid } from "./grid-pyramid.js";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines, type SegmentTable } from "../segment-table.js";
import { ADDITIVE_BLEND, fullScreenModel, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// Repulsion — per segment, by the tile-root Barnes-Hut traversal or the exact loop (spec §6.2).
// ─────────────────────────────────────────────────────────────────────────────
//
// A full-screen triangle over the slot atlas: each fragment (= one slot i) reads its segment's row
// and additive-blends its repulsion into the shared force texture. Repulsion never crosses segments:
//
// - a segment with a TILE (more than `exactMax` slots) runs a stack-based Barnes-Hut traversal over
//   its own tile of the grid pyramid (grid-pyramid.ts), starting at the tile's root;
// - an EXACT segment (at most `exactMax` slots) loops over its own slots [start, start + count),
//   skipping i — O(k²) per segment, the correctness baseline (flat: every node below 4096).
//
// Both use the segment's repulsion strength and softening ε from `segParam` (x, z): the kernel is
// f = repulsion · mass / (d² + ε) · d. The flat layout uses ε = 1e-2 on both paths (quadtree.ts).
//
// Tile-root traversal (matches quadtree.ts's force law exactly). A tile of side G_s at atlas origin
// (ox, oy) has root level L_s = log2 G_s at cell (ox >> L_s, oy >> L_s); a cell (ℓ, cx, cy) — in
// level-ℓ atlas coordinates — has children (ℓ-1, 2cx+{0,1}, 2cy+{0,1}), which stay inside the tile.
//   pop (ℓ, cx, cy); read (Σx,Σy,mass,w); if mass==0 skip;
//   com = (Σx,Σy)/mass;  d = p_i − com;  d2 = dot(d,d);
//   cellSize = boxSide / (G_s>>ℓ)   (world side of a level-ℓ cell; = 2*half in quadtree.ts terms);
//   if cellSize² < θ²·d2 (θ-accept, any level):  accept as one body →
//     acc += repulsion * mass / (d2 + ε) * d;
//   else if ℓ==0:  forced near-field accept (#251) — same lumped body, but
//     softened by the cell's second CENTRAL moment σ² = w/mass − |com − cc|²
//     (cc = the cell's center, from the tile-local cell cx − ox):
//     acc += repulsion * mass / (d2 + 2σ² + ε) * d.
//     2σ² is the squared radius of the uniform disc with that second moment, so
//     the lump follows the disc's force law instead of a point's: exact at the
//     disc center and in the far field, at worst 0.5× at the disc edge — where
//     the un-softened 1/d point kernel overestimated a sub-cell clump ~3–5× vs
//     the CPU BH reference (whose adaptive leaves resolve clump members
//     individually). A single-occupant cell has σ² = 0 EXACTLY (the scatter and
//     this shader compute cc with the same expression, so the moments cancel)
//     and takes the plain point kernel — bit-identical to the θ-accept branch.
//   else: push the 4 children (ℓ-1, 2cx+{0,1}, 2cy+{0,1}).
//
// The node's own self-contribution isn't explicitly excluded: at a leaf that contains only node i,
// d≈0 and the softened force ≈ repulsion*1/ε * (near-zero vector) ≈ 0, so it's harmless. When a leaf
// holds node i plus others, i's own term is a small softened self-force in the aggregate — the same
// approximation the CPU quadtree makes for a leaf bucket with coincident bodies.
//
// The box used for cell geometry MUST match the padded box the scatter used, so the shader recomputes
// the padded AABB from the segment's box with the same PAD.
//
// Levels live in three textures (L0 / Podd / Peven, grid-pyramid.ts): `fetchCell` picks the texture by
// level parity and offsets the cell by the level's origin (`u_levelOrigin`) — a 3-way branch and one
// uniform-array read, where the single-texture-per-level pyramid needed an 11-way unrolled switch over
// 11 samplers.
//
// Stack: fixed-size array. The traversal is DFS; at any moment the stack holds at most 3 siblings per
// descended level (the 4th is being processed) plus the root, so ≤ 3*L + 1. STACK_MAX = 4*(L+1) with
// margin, and the loop is capped to avoid a runaway on a degenerate (never-terminating) case.
//
// Padded texels (slot ≥ u_count) write a neutral 0 and RETURN: `discard` does not end the invocation
// on ANGLE Metal (AGENTS.md, #350), and both paths loop over texture data.

/** Which repulsion paths and segment lookup a program is compiled for — fixed per layout. */
export interface RepulsionVariant {
  /** S = 1 (the flat layout): the segment id is the constant 0, no `slotSeg` texture. */
  singleSegment: boolean;
  /**
   * Pyramid levels of the tile atlas (log2 of the largest tile side + 1), or 0 when no segment has a
   * tile — then the traversal is not compiled and no pyramid sampler is declared.
   */
  levelCount: number;
  /** Some non-empty segment has no tile: compile the exact loop. */
  exact: boolean;
}

/** The fragment shader of a {@link RepulsionVariant}. */
export function repulsionFs(variant: RepulsionVariant): string {
  const tiles = variant.levelCount > 0;
  if (!tiles && !variant.exact) throw new Error("repulsionFs: a variant needs the tile path, the exact path, or both");
  const defines =
    segmentDefines(variant.singleSegment) +
    (tiles ? `#define TILES\n#define LEVELS ${variant.levelCount}\n#define STACK_MAX ${4 * (variant.levelCount + 1)}\n` : "") +
    (variant.exact ? "#define EXACT\n" : "");
  return /* glsl */ `\
#version 300 es
${defines}
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

uniform highp sampler2D u_pos;
uniform highp usampler2D u_segInfo;  // (start, count, x | y << 16, rootLevel | flags << 8 | side << 16)
uniform highp sampler2D u_segParam;  // (repulsion, centering, softening, alpha0) per segment
uniform int   u_count;
uniform int   u_width;
#ifdef TILES
uniform highp sampler2D u_segBox;    // (maxX, maxY, -minX, -minY) per segment
uniform highp sampler2D u_L0;        // pyramid level 0
uniform highp sampler2D u_Podd;      // levels 1, 3, 5, …
uniform highp sampler2D u_Peven;     // levels 2, 4, …
uniform ivec2 u_levelOrigin[LEVELS]; // each level's origin in its texture
uniform float u_pad;                 // box padding factor (must match scatter)
uniform float u_theta2;              // θ²
#endif
layout(location = 0) out vec2 o_force;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
#ifdef TILES
// A pyramid cell (Σx, Σy, mass, w) at (level, cx, cy), in level-level atlas coordinates.
vec4 fetchCell(int level, int cx, int cy) {
  if (level == 0) return texelFetch(u_L0, ivec2(cx, cy), 0);
  ivec2 t = ivec2(cx, cy) + u_levelOrigin[level];
  if ((level & 1) == 1) return texelFetch(u_Podd, t, 0);
  return texelFetch(u_Peven, t, 0);
}

// Barnes-Hut over the segment's tile (see the header).
vec2 tileRepulsion(vec2 pi, uvec4 info, vec4 b, float repulsion, float eps) {
  // Padded SQUARE world box — identical to the scatter's mapping so cell
  // geometry lines up exactly (half = pad·max(halfX, halfY), like quadtree.ts).
  vec2 mx = b.xy;
  vec2 mn = -b.zw;
  vec2 ctr = 0.5 * (mn + mx);
  vec2 hlf = 0.5 * (mx - mn);
  // NOTE: 'half' is a reserved word in GLSL ES 3.00 — use hlfMax.
  float hlfMax = max(max(hlf.x, hlf.y) * u_pad, 1e-6);
  vec2 lo = ctr - vec2(hlfMax);
  float boxSide = 2.0 * hlfMax;

  int rootLevel = int(info.w & 255u);
  // G_s as an opaque integer, converted exactly as the scatter does (segmentInfo: never 1 << level).
  int grid = int(info.w >> 16);
  float G = float(grid);
  ivec2 origin = ivec2(int(info.z & 65535u), int(info.z >> 16));

  // Traversal stack of cell coords. Each entry: (level, cx, cy).
  int stLevel[STACK_MAX];
  int stCx[STACK_MAX];
  int stCy[STACK_MAX];
  int sp = 0;
  stLevel[0] = rootLevel; stCx[0] = origin.x >> rootLevel; stCy[0] = origin.y >> rootLevel; sp = 1;

  vec2 acc = vec2(0.0);

  // Cap iterations well above the worst-case node count of visited cells to
  // guarantee termination even on pathological inputs. Each accepted/rejected
  // cell is one iteration; a full descent visits O(n) cells for θ>0.
  for (int iter = 0; iter < 4194304 && sp > 0; iter++) {
    sp--;
    int level = stLevel[sp];
    int cx = stCx[sp];
    int cy = stCy[sp];

    vec4 cell = fetchCell(level, cx, cy);
    float mass = cell.z;
    if (mass == 0.0) continue;

    vec2 com = cell.xy / mass;
    vec2 d = pi - com;
    float d2 = dot(d, d);

    // World side of a level-'level' cell: boxSide / (cells per side at level) — G_s >> level.
    int cellsPerSide = grid >> level;
    float cellSize = boxSide / float(cellsPerSide);

    if (cellSize * cellSize < u_theta2 * d2) {
      // θ-accept (far field, any level): treat the whole cell as one body at
      // its COM (softened). Unchanged by #251 — bit-identical far field.
      float f = repulsion * mass / (d2 + eps);
      acc += f * d;
    } else if (level == 0) {
      // Forced near-field accept at the finest level (#251): soften the lump
      // by its occupants' second central moment (see header). mass is an
      // integer count, so mass > 1.5 ⇔ multi-occupant; single occupants keep
      // the exact point kernel of the θ-accept branch.
      float f;
      if (mass > 1.5) {
        // Same tile-local expression as the scatter's cellCenter, so the m=1 variance cancels exactly.
        vec2 cc = lo + (vec2(float(cx - origin.x), float(cy - origin.y)) + 0.5) / G * boxSide;
        vec2 comRel = com - cc;
        float sigma2 = max(cell.w / mass - dot(comRel, comRel), 0.0);
        f = repulsion * mass / (d2 + 2.0 * sigma2 + eps);
      } else {
        f = repulsion * mass / (d2 + eps);
      }
      acc += f * d;
    } else {
      // Descend: push the 4 children at level-1, (2cx+{0,1}, 2cy+{0,1}).
      int cl = level - 1;
      int bx = cx * 2;
      int by = cy * 2;
      if (sp + 4 <= STACK_MAX) {
        stLevel[sp] = cl; stCx[sp] = bx;     stCy[sp] = by;     sp++;
        stLevel[sp] = cl; stCx[sp] = bx + 1; stCy[sp] = by;     sp++;
        stLevel[sp] = cl; stCx[sp] = bx;     stCy[sp] = by + 1; sp++;
        stLevel[sp] = cl; stCx[sp] = bx + 1; stCy[sp] = by + 1; sp++;
      }
    }
  }
  return acc;
}
#endif

#ifdef EXACT
// Exact repulsion from every other slot of the segment, in slot order.
vec2 exactRepulsion(int id, vec2 pi, uvec4 info, float repulsion, float eps) {
  int start = int(info.x);
  int end = start + int(info.y);
  vec2 acc = vec2(0.0);
  for (int j = start; j < end; j++) {
    if (j == id) continue;
    vec2 pj = texelFetch(u_pos, slotTexel(j, u_width), 0).xy;
    vec2 d = pi - pj;
    float d2 = dot(d, d);
    float f = repulsion / (d2 + eps);
    acc += f * d;
  }
  return acc;
}
#endif

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int id = texelSlot(fc, u_width);
  if (id >= u_count) { o_force = vec2(0.0); return; } // a no-op under the ADD blend; see the header

  ivec2 st = segmentTexelOf(fc);
  uvec4 info = texelFetch(u_segInfo, st, 0);
  vec4 param = texelFetch(u_segParam, st, 0);
  vec2 pi = texelFetch(u_pos, fc, 0).xy;
#if defined(TILES) && defined(EXACT)
  if (((info.w >> 8) & SEGMENT_HAS_TILE) != 0u) {
    o_force = tileRepulsion(pi, info, texelFetch(u_segBox, st, 0), param.x, param.z);
  } else {
    o_force = exactRepulsion(id, pi, info, param.x, param.z);
  }
#elif defined(TILES)
  o_force = tileRepulsion(pi, info, texelFetch(u_segBox, st, 0), param.x, param.z);
#else
  o_force = exactRepulsion(id, pi, info, param.x, param.z);
#endif
}
`;
}

/** Per-draw inputs of the repulsion pass. */
export interface RepulsionInput {
  /** Current slot positions (rg32float slot atlas). */
  posTex: Texture;
  /** Number of real slots. */
  count: number;
  /** Slot atlas width. */
  width: number;
  /** Barnes-Hut opening angle θ (the pass squares it internally). */
  theta: number;
  /** The segment table (info, param, and this tick's box). */
  segments: SegmentTable;
  /** The tile pyramid, built this tick — required when the variant has tiles. */
  pyramid: GridPyramid | null;
  /** Segment id per slot — required when the variant has more than one segment. */
  slotSeg: Texture | null;
}

/**
 * GPU repulsion pass: a full-screen triangle over the slot atlas whose fragments add each slot's
 * repulsion from its own segment into the force texture (additive blend, like the other force
 * passes) — by the tile-root traversal for tiled segments, by the exact loop for the rest. The pyramid
 * must be rebuilt ({@link GridPyramid.build}) before this runs.
 */
export class RepulsionPass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;
  private readonly variant: RepulsionVariant;

  constructor(device: Device, variant: RepulsionVariant) {
    this.variant = variant;
    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_pad: 1.01,
      u_theta2: 0,
      u_tableWidth: 1,
      u_levelOrigin: new Int32Array(Math.max(1, variant.levelCount) * 2),
    };
    // Additive blend: accumulate alongside attraction + centering.
    this.model = fullScreenModel(device, repulsionFs(variant), this.uniforms, ADDITIVE_BLEND);
  }

  /** Draw one repulsion step into an already-open force-accumulation render pass. */
  run(pass: RenderPass, input: RepulsionInput): void {
    const u = this.uniforms;
    u["u_count"] = input.count;
    u["u_width"] = input.width;
    u["u_theta2"] = input.theta * input.theta;
    u["u_tableWidth"] = input.segments.width;

    const bindings: Record<string, Texture> = {
      u_pos: input.posTex,
      u_segInfo: input.segments.info,
      u_segParam: input.segments.param,
    };
    if (this.variant.levelCount > 0) {
      const pyramid = input.pyramid;
      if (!pyramid) throw new Error("RepulsionPass: this variant traverses tiles but no pyramid was given");
      u["u_pad"] = pyramid.pad;
      u["u_levelOrigin"] = pyramid.levelOrigins;
      const t = pyramid.textures;
      bindings["u_segBox"] = input.segments.box;
      bindings["u_L0"] = t.l0;
      bindings["u_Podd"] = t.odd;
      bindings["u_Peven"] = t.even;
    }
    if (!this.variant.singleSegment) {
      if (!input.slotSeg) throw new Error("RepulsionPass: a many-segment variant needs the slot → segment texture");
      bindings["u_slotSeg"] = input.slotSeg;
    }
    this.model.setBindings(bindings);
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
