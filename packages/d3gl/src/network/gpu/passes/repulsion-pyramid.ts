import type { Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { GridPyramid } from "./grid-pyramid.js";

// ─────────────────────────────────────────────────────────────────────────────
// Barnes-Hut grid-pyramid repulsion (O(n log n)).
// ─────────────────────────────────────────────────────────────────────────────
//
// A full-screen triangle over the node atlas: each fragment (= one node i) runs
// a stack-based Barnes-Hut traversal over the pyramid built by GridPyramid, and
// additive-blends the accumulated repulsion force into the shared force texture.
//
// The pyramid is a COMPLETE regular quadtree:
//   level 0    = finest G×G grid; each cell holds (Σx, Σy, mass, Σ|p−cellCenter|²)
//   level ℓ    = (G>>ℓ)×(G>>ℓ); each cell sums its 2×2 children
//   level L    = 1×1 root (L = levelCount-1)
// A cell (ℓ, cx, cy) has children at (ℓ-1, 2cx+{0,1}, 2cy+{0,1}).
//
// Traversal (matches quadtree.ts's force law exactly):
//   start with the root cell (L, 0, 0);
//   pop (ℓ, cx, cy); read (Σx,Σy,mass,w); if mass==0 skip;
//   com = (Σx,Σy)/mass;  d = p_i − com;  d2 = dot(d,d);
//   cellSize = boxSide / (G>>ℓ)   (world side of a level-ℓ cell; = 2*half in
//                                   quadtree.ts terms);
//   if cellSize² < θ²·d2 (θ-accept, any level):  accept as one body →
//     acc += u_repulsion * mass / (d2 + SOFTENING) * d;
//   else if ℓ==0:  forced near-field accept (#251) — same lumped body, but
//     softened by the cell's second CENTRAL moment σ² = w/mass − |com − cc|²
//     (cc = the cell's center):
//     acc += u_repulsion * mass / (d2 + 2σ² + SOFTENING) * d.
//     2σ² is the squared radius of the uniform disc with that second moment, so
//     the lump follows the disc's force law instead of a point's: exact at the
//     disc center and in the far field, at worst 0.5× at the disc edge — where
//     the un-softened 1/d point kernel overestimated a sub-cell clump ~3–5× vs
//     the CPU BH reference (whose adaptive leaves resolve clump members
//     individually). A single-occupant cell has σ² = 0 EXACTLY (the scatter and
//     this shader compute cc with the same expression, so the moments cancel)
//     and takes the plain point kernel — bit-identical to the θ-accept branch.
//     (The reverted #203 alternative — a fixed (cellSize/2)² floor — assumed
//     the occupants fill the whole cell and under-estimated tight sub-cell
//     clumps ~50×; σ² measures their actual extent.)
//   else: push the 4 children (ℓ-1, 2cx+{0,1}, 2cy+{0,1}).
//
// SOFTENING (1e-2) matches quadtree.ts and the all-pairs pass. The node's own
// self-contribution isn't explicitly excluded: at a leaf that contains only node
// i, d≈0 and the softened force ≈ u_repulsion*1/1e-2 * (near-zero vector) ≈ 0, so
// it's harmless (the 2-node separation test confirms nodes still repel). When a
// leaf holds node i plus others, i's own term is a small softened self-force in
// the aggregate — the same approximation the CPU quadtree makes for a leaf bucket
// with coincident bodies, and negligible vs. the peer contributions.
//
// The box used for cell geometry MUST match the padded box the scatter used, so
// the shader recomputes the padded AABB from the bbox texture with the same PAD.
//
// Stack: fixed-size array. The traversal is DFS; at any moment the stack holds at
// most 3 siblings per descended level (the 4th is being processed) plus the
// initial root, so ≤ 3*L + 1. We size STACK_MAX = 4*(L+1) with margin and cap
// the loop to avoid a runaway on a degenerate (never-terminating) case.

const VS = /* glsl */ `\
#version 300 es
in vec2 a_clip;
void main() { gl_Position = vec4(a_clip, 0.0, 1.0); }
`;

/**
 * Build the FS with a compile-time levelCount so the stack is a fixed-size
 * array and the per-level texture bindings are statically indexable (GLSL ES
 * 3.00 forbids dynamic indexing of a sampler array, so we select the level via
 * a switch over compile-time cases).
 */
function makeFs(levelCount: number): string {
  const L = levelCount - 1; // root level index
  const STACK_MAX = 4 * (levelCount + 1);

  // Emit a static switch that texelFetches the correct level sampler. GLSL ES
  // 3.00 does not allow indexing a sampler array with a non-constant, so we
  // unroll the level → sampler mapping.
  const fetchCases: string[] = [];
  for (let lvl = 0; lvl < levelCount; lvl++) {
    fetchCases.push(
      `    if (level == ${lvl}) return texelFetch(u_level${lvl}, ivec2(cx, cy), 0);`,
    );
  }
  const samplerDecls: string[] = [];
  for (let lvl = 0; lvl < levelCount; lvl++) {
    samplerDecls.push(`uniform highp sampler2D u_level${lvl};`);
  }

  return /* glsl */ `\
#version 300 es
precision highp float;
precision highp sampler2D;

uniform highp sampler2D u_pos;
uniform highp sampler2D u_box;   // 1×1 (maxX, maxY, -minX, -minY)
${samplerDecls.join("\n")}
uniform int   u_count;
uniform int   u_width;
uniform int   u_grid;            // G (finest grid side)
uniform float u_pad;             // box padding factor (must match scatter)
uniform float u_repulsion;
uniform float u_theta2;          // θ²
layout(location = 0) out vec2 o_force;

const int ROOT_LEVEL = ${L};
const int STACK_MAX = ${STACK_MAX};

// Read a pyramid cell (Σx, Σy, mass, 0) at (level, cx, cy). Level is dynamic, so
// select the sampler via an unrolled static switch (GLSL ES 3.00 rule).
vec4 fetchCell(int level, int cx, int cy) {
${fetchCases.join("\n")}
  return vec4(0.0);
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int id = fc.y * u_width + fc.x;
  if (id >= u_count) { discard; }

  vec2 pi = texelFetch(u_pos, fc, 0).xy;

  // Padded SQUARE world box — identical to the scatter's mapping so cell
  // geometry lines up exactly (half = pad·max(halfX, halfY), like quadtree.ts).
  vec4 b = texelFetch(u_box, ivec2(0, 0), 0);
  vec2 mx = b.xy;
  vec2 mn = -b.zw;
  vec2 ctr = 0.5 * (mn + mx);
  vec2 hlf = 0.5 * (mx - mn);
  // NOTE: 'half' is a reserved word in GLSL ES 3.00 — use hlfMax.
  float hlfMax = max(max(hlf.x, hlf.y) * u_pad, 1e-6);
  vec2 lo = ctr - vec2(hlfMax);
  float boxSide = 2.0 * hlfMax;
  float G = float(u_grid);

  // Traversal stack of packed cell coords. Each entry: (level, cx, cy).
  int stLevel[STACK_MAX];
  int stCx[STACK_MAX];
  int stCy[STACK_MAX];
  int sp = 0;
  stLevel[0] = ROOT_LEVEL; stCx[0] = 0; stCy[0] = 0; sp = 1;

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

    // World side of a level-'level' cell: boxSide / (cells per side at level).
    // Level 0 (finest) has G cells per side; level ℓ has G >> ℓ; root (level L)
    // has 1. So cellsPerSide = G >> level.
    int cellsPerSide = u_grid >> level;
    float cellSize = boxSide / float(cellsPerSide);

    if (cellSize * cellSize < u_theta2 * d2) {
      // θ-accept (far field, any level): treat the whole cell as one body at
      // its COM (softened). Unchanged by #251 — bit-identical far field.
      float f = u_repulsion * mass / (d2 + 1e-2);
      acc += f * d;
    } else if (level == 0) {
      // Forced near-field accept at the finest level (#251): soften the lump
      // by its occupants' second central moment (see header). mass is an
      // integer count, so mass > 1.5 ⇔ multi-occupant; single occupants keep
      // the exact point kernel of the θ-accept branch.
      float f;
      if (mass > 1.5) {
        // Same expression as the scatter's cellCenter (level 0 ⇒ the cell
        // coords are finest-grid coords), so the m=1 variance cancels exactly.
        vec2 cc = lo + (vec2(float(cx), float(cy)) + 0.5) / G * boxSide;
        vec2 comRel = com - cc;
        float sigma2 = max(cell.w / mass - dot(comRel, comRel), 0.0);
        f = u_repulsion * mass / (d2 + 2.0 * sigma2 + 1e-2);
      } else {
        f = u_repulsion * mass / (d2 + 1e-2);
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

  o_force = acc;
}
`;
}

/** Uniforms consumed by the pyramid repulsion pass. */
export interface RepulsionPyramidUniforms {
  count: number;
  width: number;
  repulsion: number;
  /** Barnes-Hut opening angle θ (the pass squares it internally). */
  theta: number;
}

/**
 * GPU Barnes-Hut grid-pyramid repulsion pass. Draws a full-screen triangle over
 * the node atlas; each fragment runs a stack-based BH traversal over the
 * {@link GridPyramid} and additive-blends its per-node repulsion into the force
 * texture (same accumulate-with-additive-blend contract as the other force
 * passes). The pyramid must be rebuilt (GridPyramid.build) before this runs.
 *
 * The FS is generated for the pyramid's fixed levelCount so the traversal stack
 * is a fixed-size array and level→sampler selection is statically unrolled.
 */
export class RepulsionPyramidPass {
  private readonly model: Model;
  private readonly uniforms: Record<string, number>;
  private readonly levelCount: number;

  constructor(device: Device, levelCount: number) {
    this.levelCount = levelCount;
    const clipBuf = device.createBuffer({
      data: new Float32Array([-1, -1, 3, -1, -1, 3]),
    });

    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_grid: 1,
      u_pad: 1.01,
      u_repulsion: 0,
      u_theta2: 0,
    };

    this.model = new Model(device, {
      vs: VS,
      fs: makeFs(levelCount),
      topology: "triangle-list",
      vertexCount: 3,
      attributes: { a_clip: clipBuf },
      bufferLayout: [{ name: "a_clip", format: "float32x2" }],
      uniforms: this.uniforms,
      parameters: {
        // Additive blend: accumulate alongside attraction + centering.
        blend: true,
        blendColorSrcFactor: "one",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one",
        blendColorOperation: "add",
        blendAlphaOperation: "add",
      },
    });
  }

  /**
   * Draw one BH repulsion step into an already-open force-accumulation render
   * pass. `pyramid` must have been built this tick and match the levelCount the
   * pass was constructed with.
   */
  run(
    pass: RenderPass,
    posTex: Texture,
    pyramid: GridPyramid,
    u: RepulsionPyramidUniforms,
  ): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_grid"] = pyramid.grid;
    this.uniforms["u_pad"] = pyramid.pad;
    this.uniforms["u_repulsion"] = u.repulsion;
    this.uniforms["u_theta2"] = u.theta * u.theta;

    const bindings: Record<string, Texture> = {
      u_pos: posTex,
      u_box: pyramid.bboxTexture,
    };
    for (let lvl = 0; lvl < this.levelCount; lvl++) {
      bindings[`u_level${lvl}`] = pyramid.levelTexture(lvl);
    }
    this.model.setBindings(bindings);
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
