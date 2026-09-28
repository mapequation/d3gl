import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { FLAT_TILE_MIN_SIDE, bandRows, bandSlots, tileSide, type PyramidLevel, type PyramidTexture, type TileAtlas } from "../segments.js";
import { SEGMENT_OF_GLSL, segmentDefines, type SegmentTable } from "../segment-table.js";
import { ADDITIVE_BLEND, beginPass, fullScreenModel, NO_BLEND, type PassTarget, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// GPU tile-atlas grid pyramid — one regular quadtree per segment (spec §6.2).
// ─────────────────────────────────────────────────────────────────────────────
//
// The pyramid backs Barnes-Hut repulsion (see repulsion.ts). Every segment with more than `exactMax`
// slots owns a square TILE of the level-0 atlas (side G_s, a power of two; `packTiles` in
// segments.ts places them). A tile is a COMPLETE quadtree with regular cell indexing over its
// segment's box, so it needs no Morton sort and no double-counting logic:
//
//   level 0    = the finest grid, G_s × G_s cells of the atlas
//   level ℓ    = (G_s >> ℓ) × (G_s >> ℓ) cells, each summing its 2×2 children
//   level L_s  = the tile's 1×1 root, L_s = log2(G_s)
//
// Tiles are aligned at every level up to their root, so ONE 2×2 reduce pass per level reduces every
// tile at once, and a tile's cells never mix with another's. The flat layout is one tile at (0, 0)
// of side chooseGrid(N): exactly the single grid it had before tiles.
//
// Each cell of level 0 holds (Σx, Σy, mass, Σ|p−cellCenter|²) in rgba32float; unit mass means mass =
// the node count in the cell and COM = (Σx/mass, Σy/mass). The w channel is the occupants' second
// moment about the cell center, consumed only at level 0 by the BH pass's near-field softening
// (#251). Coarser levels sum the (Σx, Σy, mass) of their four children, so a tile's root holds its
// segment's totals — exactly the CPU BarnesHutTree's root mass/COM.
//
// Level storage (spec §6.2.3, decided in Q2): three textures, pure luma.
//   L0    — level 0 (the atlas, A × H), the only level whose w channel is read;
//   Podd  — levels 1, 3, 5, …: level 1 at (0, 0), the rest in a column to its right;
//   Peven — levels 2, 4, …, packed the same way.
// A reduce pass samples one texture and renders into another, so there is never a feedback loop,
// and it writes only its level's rectangle (viewport, no clear) — the other levels in that texture
// stay untouched. The traversal then needs 3 samplers instead of one per level.
//
// Build per tick, from each segment's box — the segment table's `box` texel (maxX, maxY, -minX,
// -minY), which the segmented range query computes this tick (segmented-reduce.ts):
//   1. scatter — POINTS scatter with ADD blend → each slot into its segment's tile in L0
//   2. reduce  — full-screen triangle per level over its rectangle, summing 2×2 blocks → level ℓ+1
//
// All textures + FBOs are pre-created in the constructor — no per-tick createTexture /
// createFramebuffer (keeps the spy test green).
//
// A multilevel seed level (#353) is a smaller tile in the corner of the flat atlas: its single segment's
// row names a tile at (0, 0) of side chooseGrid(level count), and a build with `grid` clears and writes
// only that corner of L0 and reduces only the tile's levels, up to its root. Its slots carry masses: the
// scatter emits (m·x, m·y, m, m·r²), so a cell's COM and second moment are mass-weighted, as the CPU
// tree's. That is a uniform branch compiled only into a `multilevel` pyramid; on the graph's level
// m = 1, which changes no bit.

// ── Grid-resolution choice ──────────────────────────────────────────────────
//
// G = clamp(nextPow2(ceil(sqrt(count))), 16, 1024) for the flat layout (tileSide in segments.ts;
// a segment of a many-segment layout uses the floor 8 instead).
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
  return tileSide(count, FLAT_TILE_MIN_SIDE);
}

// ── Scatter to the finest grid (POINTS + ADD blend) ──────────────────────────
//
// Each slot reads its position and its segment's row, maps the position into the segment's tile —
// [0, G_s) cells over the segment's padded box, offset by the tile's origin in the atlas — emits a
// point at that cell's clip-space center, and carries the NODE position to the fragment so we
// accumulate Σ(node position) (not Σ(cell center)). The FS writes (x, y, mass=1, |p−cellCenter|²);
// additive blend gives (Σx, Σy, mass, Σ|p−cellCenter|²) per cell. A slot of an exact segment (no
// tile) is emitted outside the clip volume, so it rasterises nothing.
//
// The w channel is the raw second moment about the CELL CENTER — the BH traversal turns it into the
// cell's second CENTRAL moment (σ² = w/m − |com − cellCenter|²) for the level-0 near-field softening
// (#251). Accumulating about the cell center (offsets ≤ cellSize/√2) instead of the origin keeps the
// float32 blend-sum well-conditioned; coarser levels sum w like the other channels, which is
// meaningless across differing cell centers — only level 0 reads it.
//
// The box texel is (maxX, maxY, -minX, -minY). We recover min/max, then build a SQUARE padded box
// centered on the AABB center — half = pad·max(halfX, halfY) — exactly like quadtree.ts (which makes
// the root square: half = max extent / 2). A square box keeps cells square, so cellSize = boxSide /
// cellsPerSide is a single unambiguous value the BH traversal reuses. Then
//   cell = clamp(floor((p - lo) / boxSide * G_s), 0, G_s-1).
function scatterVs(singleSegment: boolean, multilevel: boolean): string {
  return /* glsl */ `\
#version 300 es
${segmentDefines(singleSegment)}${multilevel ? "#define MULTILEVEL\n" : ""}
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_segBox;    // (maxX, maxY, -minX, -minY) per segment
uniform highp usampler2D u_segInfo;  // (start, count, x | y << 16, rootLevel | flags << 8 | side << 16)
uniform int   u_width;
uniform int   u_first;               // the first slot of this draw (a band of slots, #382)
uniform vec2  u_atlas;               // level-0 atlas size (A, H)
uniform float u_pad;                 // box padding factor (e.g. 1.01)
flat out vec2 v_pos;
flat out float v_r2;
#ifdef MULTILEVEL
uniform int u_massive;               // a mass-weighted seed level (#353)
uniform highp sampler2D u_mass;      // per-slot mass (slot atlas), sampled only when u_massive
flat out float v_mass;
#endif
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
void main() {
  ivec2 c = slotTexel(u_first + gl_VertexID, u_width);
  ivec2 st = segmentTexelOf(c);
  uvec4 info = texelFetch(u_segInfo, st, 0);
  gl_PointSize = 1.0;
  if (((info.w >> 8) & SEGMENT_HAS_TILE) == 0u) {
    // An exact segment has no tile: emit outside the clip volume, so the point is clipped.
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    v_pos = vec2(0.0);
    v_r2 = 0.0;
#ifdef MULTILEVEL
    v_mass = 0.0;
#endif
    return;
  }
  vec2 p = texelFetch(u_pos, c, 0).xy;
#ifdef MULTILEVEL
  v_mass = u_massive != 0 ? texelFetch(u_mass, c, 0).r : 1.0;
#endif

  vec4 b = texelFetch(u_segBox, st, 0);
  vec2 mx = b.xy;
  vec2 mn = -b.zw;
  vec2 ctr = 0.5 * (mn + mx);
  vec2 hlf = 0.5 * (mx - mn);
  // NOTE: 'half' is a reserved word in GLSL ES 3.00 — use hlfMax.
  float hlfMax = max(max(hlf.x, hlf.y) * u_pad, 1e-6); // square, padded
  vec2 lo = ctr - vec2(hlfMax);
  float boxSide = 2.0 * hlfMax;

  vec2 t = (p - lo) / boxSide;
  // The side as an opaque integer, exactly as the traversal converts it (segmentInfo: never 1 << level).
  float G = float(int(info.w >> 16));
  vec2 cell = clamp(floor(t * G), vec2(0.0), vec2(G - 1.0));
  vec2 origin = vec2(float(info.z & 65535u), float(info.z >> 16));

  // The cell center in tile units, computed ONCE and shared by the clip position and the second
  // moment below — keep it that way. The #251 near field needs this shader and the traversal to round
  // the world cell center lo + q·boxSide bit for bit alike, and a fast-math compiler rounds it
  // differently when q is not shared: on ANGLE Metal a clip written as (origin + cell + 0.5) / atlas
  // moved the w channel in 91% of occupied cells (AGENTS.md). The clip below is exact: origin / atlas
  // and q · (G / atlas) are short binary fractions (atlas and G are powers of two).
  vec2 q = (cell + 0.5) / G;
  vec2 clip = (origin / u_atlas + q * (G / u_atlas)) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_pos = p;
  // Second-moment channel (#251): squared offset from the cell center. The center uses the SAME
  // tile-local expression the BH traversal uses to rebuild it, so a single-occupant cell's variance
  // (w/m − |com − cellCenter|²) cancels exactly to 0.
  vec2 cellCenter = lo + q * boxSide;
  vec2 rel = p - cellCenter;
  v_r2 = dot(rel, rel);
}
`;
}

function scatterFs(multilevel: boolean): string {
  return /* glsl */ `\
#version 300 es
${multilevel ? "#define MULTILEVEL\n" : ""}precision highp float;
flat in vec2 v_pos;
flat in float v_r2;
#ifdef MULTILEVEL
flat in float v_mass;
#endif
out vec4 o_cell;
void main() {
#ifdef MULTILEVEL
  // A mass-weighted seed level (#353): (Σm·x, Σm·y, Σm, Σm·|p−cellCenter|²), so a cell's COM and second
  // moment are mass-weighted, as the CPU tree's. On the graph's level m = 1, which changes no bit.
  o_cell = vec4(v_mass * v_pos, v_mass, v_mass * v_r2);
#else
  // (Σx, Σy, mass=1, Σ|p−cellCenter|²). Additive blend accumulates per cell.
  o_cell = vec4(v_pos, 1.0, v_r2);
#endif
}
`;
}

// ── Packed reduce (full-screen triangle over one level's rectangle, sum 2×2 children) ──────────
//
// Output level ℓ+1 reads level ℓ and sums its 2×2 block, in level-local coordinates:
//   out(x,y) = Σ in(2x+{0,1}, 2y+{0,1})
// The pass's viewport is the output level's rectangle, so gl_FragCoord minus that rectangle's origin
// is the output cell, and the input cells are offset by the input level's origin. Every tile is
// aligned, so a 2×2 block never straddles two tiles; out-of-range fetches never happen because the
// input level is exactly twice the output level (the atlas sides are powers of two).
const REDUCE_FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;   // the texture holding level ℓ
uniform int u_srcX;              // level ℓ's origin in u_src
uniform int u_srcY;
uniform int u_dstX;              // level ℓ+1's origin in the target (the viewport's origin)
uniform int u_dstY;
out vec4 o_cell;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) - ivec2(u_dstX, u_dstY);
  ivec2 i = o * 2 + ivec2(u_srcX, u_srcY);
  vec4 a = texelFetch(u_src, i + ivec2(0, 0), 0);
  vec4 b = texelFetch(u_src, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(u_src, i + ivec2(0, 1), 0);
  vec4 d = texelFetch(u_src, i + ivec2(1, 1), 0);
  o_cell = a + b + c + d;
}
`;

/** One pyramid texture and the framebuffer that renders into it. */
interface PyramidTarget {
  readonly tex: Texture;
  readonly fbo: Framebuffer;
}

/** One reduce pass (level ℓ → ℓ+1): the level it reads, the level it writes, and how. */
interface ReduceStep {
  readonly src: PyramidLevel;
  readonly dst: PyramidLevel;
  /** `dst`'s rectangle of its packed texture, without a clear. */
  readonly target: PassTarget;
  /** The packed texture holding `src`. */
  readonly bindings: { readonly u_src: Texture };
}

/** Inputs of a pyramid build. */
export interface PyramidBuildInput {
  /** Current slot positions (rg32float slot atlas). */
  posTex: Texture;
  /** Slot atlas width of the positions texture. */
  width: number;
  /** Number of real slots. */
  count: number;
  /** The segment table: `info` places each slot's tile, `box` (this tick's range query) sizes its grid. */
  segments: SegmentTable;
  /** Segment id per slot (`r32uint`, slot atlas) — only when there is more than one segment. */
  slotSeg: Texture | null;
  /**
   * A multilevel seed level's tile side (#353): its single segment's tile sits at (0, 0) with this side (a
   * power of two, at most the atlas's), so the build clears and writes only that corner of L0 and reduces
   * only the tile's levels, up to its root at level `log2(grid)`. Omitted: the whole atlas.
   */
  grid?: number;
  /** A mass-weighted seed level's per-slot masses (slot atlas), or null. Only on a `multilevel` pyramid. */
  mass?: Texture | null;
}

/** Options of a {@link GridPyramid}. */
export interface GridPyramidOptions {
  /**
   * Compile the scatter for mass-weighted seed levels (#353) as a uniform branch; `unit` is bound in place
   * of the masses when a build has none (never sampled then).
   */
  multilevel?: { unit: Texture };
}

/**
 * GPU tile-atlas grid pyramid — builds and holds one regular-quadtree COM/mass pyramid per tiled
 * segment, packed into the three textures `L0` / `Podd` / `Peven`. Owns the textures, their FBOs and
 * the two build models. Rebuilt each tick via {@link build} from every segment's box.
 *
 * The BH repulsion pass reads a cell through {@link textures}, the per-level origins
 * {@link levelOrigins} and the tile of the node's segment (in the segment table).
 */
export class GridPyramid {
  private readonly device: Device;
  /** Where every tile and every level lives. */
  readonly atlas: TileAtlas;
  /** Number of pyramid levels = log2(largest tile side) + 1. */
  readonly levelCount: number;
  /**
   * Each level's origin in its texture, `(x, y)` per level (level 0 is (0, 0)) — the traversal's
   * `u_levelOrigin` uniform array.
   */
  readonly levelOrigins: Int32Array;

  private readonly targets: Readonly<Record<PyramidTexture, PyramidTarget>>;
  /** The three pyramid textures, for the traversal's `u_L0` / `u_Podd` / `u_Peven` (built once). */
  readonly textures: Readonly<Record<PyramidTexture, Texture>>;
  private readonly scatterModel: Model;
  private readonly reduceModel: Model;
  /** The scatter's target: the whole L0 atlas, cleared (L0 holds level 0 alone). */
  private readonly scatterTarget: PassTarget;
  /** The L − 1 reduce passes in build order, built once: the atlas is fixed per topology. */
  private readonly reduceSteps: readonly ReduceStep[];

  /**
   * Box padding factor so max-corner nodes fall strictly inside the grid. The
   * BH repulsion pass must apply the SAME padding when it recomputes cell
   * geometry from the box texture, so it's exposed as a public readonly.
   */
  readonly pad = 1.01;

  private readonly scatterUniforms: PassUniforms;
  private readonly reduceUniforms: PassUniforms;
  private readonly singleSegment: boolean;
  /** The stand-in bound as `u_mass` on a build without masses (multilevel only). */
  private readonly unit: Texture | null;

  /**
   * @param atlas the segments' tile atlas (`packTiles`); it must have at least one tile.
   * @param singleSegment S = 1 (the flat layout): the segment id is the constant 0, no `slotSeg`.
   * @param opts `multilevel`: compile the scatter for a multilevel seed's mass-weighted levels (#353).
   */
  constructor(device: Device, atlas: TileAtlas, singleSegment: boolean, opts: GridPyramidOptions = {}) {
    if (atlas.levels.length === 0) throw new Error("GridPyramid: the atlas has no tiles");
    this.device = device;
    this.atlas = atlas;
    this.singleSegment = singleSegment;
    this.unit = opts.multilevel?.unit ?? null;
    this.levelCount = atlas.levels.length;
    this.levelOrigins = new Int32Array(this.levelCount * 2);
    atlas.levels.forEach((lvl, l) => this.levelOrigins.set([lvl.x, lvl.y], l * 2));

    const target = (width: number, height: number): PyramidTarget => {
      const tex = device.createTexture({
        width,
        height,
        format: "rgba32float",
        mipLevels: 1,
        sampler: { minFilter: "nearest", magFilter: "nearest" },
      });
      return { tex, fbo: device.createFramebuffer({ width, height, colorAttachments: [tex] }) };
    };
    this.targets = {
      l0: target(atlas.width, atlas.height),
      odd: target(atlas.odd.width, atlas.odd.height),
      even: target(atlas.even.width, atlas.even.height),
    };
    this.textures = { l0: this.targets.l0.tex, odd: this.targets.odd.tex, even: this.targets.even.tex };
    this.scatterTarget = { framebuffer: this.targets.l0.fbo, clear: [0, 0, 0, 0] };
    // The reduce passes of `build` step 2, one per level ℓ → ℓ+1, with their targets and bindings.
    this.reduceSteps = atlas.levels.slice(1).map((dst, l) => {
      const src = this.level(l);
      return {
        src,
        dst,
        target: { framebuffer: this.targets[dst.texture].fbo, clear: false, viewport: [dst.x, dst.y, dst.width, dst.height] },
        bindings: { u_src: this.targets[src.texture].tex },
      };
    });

    // ── Models ────────────────────────────────────────────────────────────
    this.scatterUniforms = {
      u_width: 1,
      u_first: 0,
      u_atlas: new Float32Array([atlas.width, atlas.height]),
      u_pad: this.pad,
      u_tableWidth: 1,
      ...(this.unit ? { u_massive: 0 } : {}),
    };
    this.scatterModel = new Model(device, {
      vs: scatterVs(singleSegment, this.unit !== null),
      fs: scatterFs(this.unit !== null),
      topology: "point-list",
      vertexCount: 1, // overridden per build
      uniforms: this.scatterUniforms,
      parameters: ADDITIVE_BLEND,
    });

    // No blend: each reduce output texel is written exactly once.
    this.reduceUniforms = { u_srcX: 0, u_srcY: 0, u_dstX: 0, u_dstY: 0 };
    this.reduceModel = fullScreenModel(device, REDUCE_FS, this.reduceUniforms, NO_BLEND);
  }

  /** Where level `ℓ` is packed (0 = the level-0 atlas). */
  level(level: number): PyramidLevel {
    const lvl = this.atlas.levels[level];
    if (!lvl) throw new Error(`GridPyramid: no level ${level} (levels 0…${this.levelCount - 1})`);
    return lvl;
  }

  /**
   * Rebuild every tile from the current positions and the segments' boxes. Runs
   * two sub-steps, each in its own render pass:
   *   1. clear L0 to 0 then ADD-scatter every tiled slot → (Σx, Σy, mass, Σ|p−cc|²)
   *   2. reduce level ℓ → ℓ+1 into its rectangle of Podd / Peven, one pass per level
   *
   * Nothing is submitted: WebGL runs each pass as it is encoded, so the passes after it (and the traversal)
   * see its results, and the caller's work item submits once (#402).
   */
  build(input: PyramidBuildInput): void {
    this.scatter(input);
    this.reduceLevels(input.grid);
  }

  /** Rows of level 1 — the most bands {@link reduceLevels} can cut (1 without a level above 0). */
  get levelRows(): number {
    return this.atlas.levels[1]?.height ?? 1;
  }

  /**
   * Step 1 over the slots of the slot-atlas rows of band `band` of `bands` (#382): its first band clears
   * L0 (a seed level's tile only its corner), every band ADD-scatters its slots. Blending follows draw
   * order, and the bands draw the slots in the order one draw would, so L0 is bitwise the same for any
   * `bands`.
   */
  scatter(input: PyramidBuildInput, band = 0, bands = 1): void {
    const { posTex, width, count, segments, slotSeg, grid } = input;
    if (!this.singleSegment && !slotSeg) throw new Error("GridPyramid: a many-segment build needs the slot → segment texture");
    if (grid !== undefined && (!this.singleSegment || grid > (this.atlas.tiles[0]?.side ?? 0))) {
      throw new Error("GridPyramid: a corner build (a seed level's tile) needs the flat layout and fits its tile");
    }
    if (input.mass && !this.unit) throw new Error("GridPyramid: a mass-weighted build needs a multilevel pyramid");
    const [first, end] = bandSlots(band, bands, width, count);

    // L0 holds level 0 alone, so clearing the whole attachment is right here; a seed level's tile clears
    // only its corner (the scissor), which is all its traversal reads. Later bands add to the first's.
    const target =
      band > 0
        ? { framebuffer: this.targets.l0.fbo, clear: false as const }
        : grid === undefined
          ? this.scatterTarget
          : { ...this.scatterTarget, scissor: [0, 0, grid, grid] as [number, number, number, number] };
    const scatterPass = beginPass(this.device, target);
    if (end > first) {
      this.scatterUniforms["u_width"] = width;
      this.scatterUniforms["u_first"] = first;
      this.scatterUniforms["u_tableWidth"] = segments.width;
      const bindings: Record<string, Texture> = { u_pos: posTex, u_segBox: segments.box, u_segInfo: segments.info };
      if (slotSeg) bindings["u_slotSeg"] = slotSeg;
      if (this.unit) {
        this.scatterUniforms["u_massive"] = input.mass ? 1 : 0;
        bindings["u_mass"] = input.mass ?? this.unit;
      }
      this.scatterModel.setBindings(bindings);
      this.scatterModel.setVertexCount(end - first);
      this.scatterModel.draw(scatterPass);
    }
    scatterPass.end();
  }

  /**
   * Step 2, the packed reduce (level ℓ → ℓ + 1), over band `band` of `bands` of every level's rows (#382):
   * level ℓ + 1's rows `[⌊b·h/B⌋, ⌊(b+1)·h/B⌋)` (h its height) read level ℓ's rows below
   * `2·⌊(b+1)·h/B⌋ ≤ ⌊(b+1)·2h/B⌋`, which bands ≤ b of level ℓ wrote — so each band reduces all levels in
   * order, and the pyramid does not depend on `bands`. `grid`: a seed level's tile (#353), whose levels are
   * reduced only up to its root, each over its corner.
   */
  reduceLevels(grid?: number, band = 0, bands = 1): void {
    // Each pass reads level ℓ from one texture and writes level ℓ+1's rectangle of the other: no
    // clear (the other levels share the target), no blend (every output texel is written once).
    const u = this.reduceUniforms;
    const levels = grid === undefined ? this.reduceSteps.length : Math.min(this.reduceSteps.length, Math.log2(grid));
    for (let l = 0; l < levels; l++) {
      const step = this.reduceSteps[l];
      if (!step) break;
      const { src, dst, target, bindings } = step;
      const side = grid === undefined ? 0 : grid >> (l + 1);
      const w = grid === undefined ? dst.width : side;
      const h = grid === undefined ? dst.height : side;
      const [r0, r1] = bandRows(band, bands, h);
      if (r1 <= r0) continue;
      const pass = beginPass(
        this.device,
        grid === undefined && bands === 1
          ? target
          : {
              ...target,
              viewport: [dst.x, dst.y, w, h],
              ...(bands > 1 ? { scissor: [dst.x, dst.y + r0, w, r1 - r0] as [number, number, number, number] } : {}),
            },
      );
      u["u_srcX"] = src.x;
      u["u_srcY"] = src.y;
      u["u_dstX"] = dst.x;
      u["u_dstY"] = dst.y;
      this.reduceModel.setBindings(bindings);
      this.reduceModel.draw(pass);
      pass.end();
    }
  }


  destroy(): void {
    for (const t of Object.values(this.targets)) {
      t.tex.destroy();
      t.fbo.destroy();
    }
    this.scatterModel.destroy();
    this.reduceModel.destroy();
  }
}
