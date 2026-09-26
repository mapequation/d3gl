/**
 * `gridPyramidReference` — an executable spec of the flat GPU tick's force computation (spec §13
 * T5), in float32 (`Math.fround` after every operation, in the shaders' operation order):
 *
 *   1. segment statistics by the 16-ary pairwise tree + canonical-cover range query
 *      (segmented-reduce.ts), and the segment box by exact min/max;
 *   2. the grid pyramid (grid-pyramid.ts): square padded box, level-0 scatter in node order
 *      (blending follows primitive order) with the #251 second moment, 2×2 reduce;
 *   3. Barnes-Hut traversal (repulsion-pyramid.ts): the same DFS stack order, θ-accept, the level-0
 *      forced accept softened by σ² (#251);
 *   4. springs (attraction.ts) over the symmetric CSR in its neighbour order;
 *   5. centering (centering.ts) toward the segment centroid;
 *   6. the force texture's ADD blend in the fixed pass order springs → repulsion → centering.
 *
 * GLSL ES 3.00 has no `precise`, so the GPU may contract an FMA or round a division differently;
 * the contract (§9) compares per-node forces from IDENTICAL positions with a relative statistic,
 * not bits. Later phases reuse this helper as the flat baseline.
 */
import { chooseGrid } from "../passes/grid-pyramid.js";
import { REDUCE_FANOUT, canonicalCover, reduceLayout } from "../segments.js";

const f = Math.fround;

/** Force parameters the reference needs (a {@link ForceParams} subset). */
export interface ReferenceParams {
  repulsion: number;
  attraction: number;
  centering: number;
  theta: number;
}

/** Symmetric CSR (as `buildCSR` returns it). */
export interface ReferenceCSR {
  offsets: Uint32Array;
  neighbors: Uint32Array;
}

/** The segment statistics the reduction produces for the flat segment. */
export interface ReferenceStats {
  /** (Σx, Σy, count) by the tree + range-query add order. */
  sumX: number;
  sumY: number;
  count: number;
  /** Exact bounding box. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Vec3 = [number, number, number];

/** float32 pairwise sum of 16 terms — `sum16` in segmented-reduce.ts. */
function sum16(v: readonly Vec3[]): Vec3 {
  const add = (a: Vec3, b: Vec3): Vec3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
  const zero: Vec3 = [0, 0, 0];
  const at = (k: number): Vec3 => v[k] ?? zero;
  const a = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => add(at(2 * k), at(2 * k + 1)));
  const pick = (k: number): Vec3 => a[k] ?? zero;
  const b0 = add(pick(0), pick(1));
  const b1 = add(pick(2), pick(3));
  const b2 = add(pick(4), pick(5));
  const b3 = add(pick(6), pick(7));
  return add(add(b0, b1), add(b2, b3));
}

/**
 * The flat segment's statistics exactly as the GPU reduction orders them: level-1 texels are
 * pairwise sums of 16 mapped slots (x, y, 1), level ℓ texels pairwise sums of 16 level-(ℓ−1)
 * texels, and the range query adds the canonical cover of [0, count) sequentially.
 */
export function referenceStats(positions: Float32Array, count: number): ReferenceStats {
  const zero: Vec3 = [0, 0, 0];
  const slot = (s: number): Vec3 => (s < count ? [positions[s * 2] ?? 0, positions[s * 2 + 1] ?? 0, 1] : zero);
  const levels: Vec3[][] = [];
  const layout = reduceLayout(count);
  let prev = (i: number): Vec3 => slot(i);
  for (const level of layout.levels) {
    const src = prev;
    const texels: Vec3[] = [];
    for (let j = 0; j < level.size; j++) {
      const terms: Vec3[] = [];
      for (let k = 0; k < REDUCE_FANOUT; k++) terms.push(src(j * REDUCE_FANOUT + k));
      texels.push(sum16(terms));
    }
    levels.push(texels);
    prev = (i: number): Vec3 => texels[i] ?? zero;
  }
  let sx = 0, sy = 0, n = 0;
  for (const t of canonicalCover(0, count)) {
    const v = t.level === 0 ? slot(t.index) : (levels[t.level - 1]?.[t.index] ?? zero);
    sx = f(sx + v[0]);
    sy = f(sy + v[1]);
    n = f(n + v[2]);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2] ?? 0;
    const y = positions[i * 2 + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { sumX: sx, sumY: sy, count: n, minX, minY, maxX, maxY };
}

/** Box padding factor — `GridPyramid.pad`. */
const PAD = 1.01;
/** Softening — the absolute 1e-2 of the repulsion passes. */
const SOFTENING = f(1e-2);

/**
 * Per-node force (springs + repulsion + centering) of one flat pyramid tick from `positions`,
 * `count * 2` floats. See the file header for the order of operations it mirrors.
 */
export function gridPyramidReference(
  positions: Float32Array,
  count: number,
  csr: ReferenceCSR,
  params: ReferenceParams,
): Float32Array {
  const px = (i: number): number => positions[i * 2] ?? 0;
  const py = (i: number): number => positions[i * 2 + 1] ?? 0;
  const stats = referenceStats(positions, count);

  // ── Padded square box (grid-pyramid.ts SCATTER_VS / repulsion-pyramid.ts, same expressions) ──
  const ctrX = f(0.5 * f(stats.minX + stats.maxX));
  const ctrY = f(0.5 * f(stats.minY + stats.maxY));
  const hlfX = f(0.5 * f(stats.maxX - stats.minX));
  const hlfY = f(0.5 * f(stats.maxY - stats.minY));
  const hlfMax = Math.max(f(Math.max(hlfX, hlfY) * f(PAD)), f(1e-6));
  const loX = f(ctrX - hlfMax);
  const loY = f(ctrY - hlfMax);
  const boxSide = f(2 * hlfMax);
  const G = chooseGrid(count);
  const levelCount = Math.log2(G) + 1;

  // ── Level-0 scatter, node order: (Σx, Σy, mass, Σ|p − cellCenter|²) ──
  const levels: Float32Array[] = [];
  const level0 = new Float32Array(G * G * 4);
  for (let i = 0; i < count; i++) {
    const x = px(i), y = py(i);
    const tx = f(f(x - loX) / boxSide);
    const ty = f(f(y - loY) / boxSide);
    const cx = Math.min(Math.max(Math.floor(f(tx * G)), 0), G - 1);
    const cy = Math.min(Math.max(Math.floor(f(ty * G)), 0), G - 1);
    const ccx = f(loX + f(f(f(cx + 0.5) / G) * boxSide));
    const ccy = f(loY + f(f(f(cy + 0.5) / G) * boxSide));
    const rx = f(x - ccx), ry = f(y - ccy);
    const r2 = f(f(rx * rx) + f(ry * ry));
    const o = (cy * G + cx) * 4;
    level0[o] = f((level0[o] ?? 0) + x);
    level0[o + 1] = f((level0[o + 1] ?? 0) + y);
    level0[o + 2] = f((level0[o + 2] ?? 0) + 1);
    level0[o + 3] = f((level0[o + 3] ?? 0) + r2);
  }
  levels.push(level0);

  // ── 2×2 reduce: out = ((a + b) + c) + d, a/b the lower row ──
  for (let side = G >> 1; side >= 1; side >>= 1) {
    const src = levels[levels.length - 1] ?? level0;
    const srcSide = side * 2;
    const dst = new Float32Array(side * side * 4);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const a = ((2 * y) * srcSide + 2 * x) * 4;
        const b = a + 4;
        const c = ((2 * y + 1) * srcSide + 2 * x) * 4;
        const d = c + 4;
        for (let ch = 0; ch < 4; ch++) {
          dst[(y * side + x) * 4 + ch] = f(f(f((src[a + ch] ?? 0) + (src[b + ch] ?? 0)) + (src[c + ch] ?? 0)) + (src[d + ch] ?? 0));
        }
      }
    }
    levels.push(dst);
  }

  const out = new Float32Array(count * 2);
  const theta2 = f(params.theta * params.theta);
  const repulsion = f(params.repulsion);
  const attraction = f(params.attraction);
  const centering = f(params.centering);
  const centX = f(stats.sumX / Math.max(stats.count, 1));
  const centY = f(stats.sumY / Math.max(stats.count, 1));
  const stackLevel: number[] = [];
  const stackX: number[] = [];
  const stackY: number[] = [];

  for (let i = 0; i < count; i++) {
    const xi = px(i), yi = py(i);

    // ── Springs: Σ (p_j − p_i) over the CSR row, then × attraction ──
    let sx = 0, sy = 0;
    const start = csr.offsets[i] ?? 0;
    const end = csr.offsets[i + 1] ?? 0;
    for (let p = start; p < end; p++) {
      const j = csr.neighbors[p] ?? 0;
      sx = f(sx + f(px(j) - xi));
      sy = f(sy + f(py(j) - yi));
    }
    const springX = f(attraction * sx);
    const springY = f(attraction * sy);

    // ── Barnes-Hut traversal, the shader's DFS order ──
    let ax = 0, ay = 0;
    stackLevel.length = 0; stackX.length = 0; stackY.length = 0;
    stackLevel.push(levelCount - 1); stackX.push(0); stackY.push(0);
    while (stackLevel.length > 0) {
      const level = stackLevel.pop() ?? 0;
      const cx = stackX.pop() ?? 0;
      const cy = stackY.pop() ?? 0;
      const side = G >> level;
      const cell = levels[level] ?? level0;
      const o = (cy * side + cx) * 4;
      const mass = cell[o + 2] ?? 0;
      if (mass === 0) continue;
      const comX = f((cell[o] ?? 0) / mass);
      const comY = f((cell[o + 1] ?? 0) / mass);
      const dx = f(xi - comX), dy = f(yi - comY);
      const d2 = f(f(dx * dx) + f(dy * dy));
      const cellSize = f(boxSide / side);
      let force: number | null = null;
      if (f(cellSize * cellSize) < f(theta2 * d2)) {
        force = f(f(repulsion * mass) / f(d2 + SOFTENING));
      } else if (level === 0) {
        if (mass > 1.5) {
          const ccx = f(loX + f(f(f(cx + 0.5) / G) * boxSide));
          const ccy = f(loY + f(f(f(cy + 0.5) / G) * boxSide));
          const rx = f(comX - ccx), ry = f(comY - ccy);
          const sigma2 = Math.max(f(f((cell[o + 3] ?? 0) / mass) - f(f(rx * rx) + f(ry * ry))), 0);
          force = f(f(repulsion * mass) / f(f(d2 + f(2 * sigma2)) + SOFTENING));
        } else {
          force = f(f(repulsion * mass) / f(d2 + SOFTENING));
        }
      } else {
        const bx = cx * 2, by = cy * 2;
        stackLevel.push(level - 1, level - 1, level - 1, level - 1);
        stackX.push(bx, bx + 1, bx, bx + 1);
        stackY.push(by, by, by + 1, by + 1);
      }
      if (force !== null) {
        ax = f(ax + f(force * dx));
        ay = f(ay + f(force * dy));
      }
    }

    // ── Centering toward the segment centroid ──
    const centerX = f(centering * f(centX - xi));
    const centerY = f(centering * f(centY - yi));

    // ── The force texture's ADD blend: 0 + springs, + repulsion, + centering ──
    out[i * 2] = f(f(springX + ax) + centerX);
    out[i * 2 + 1] = f(f(springY + ay) + centerY);
  }
  return out;
}
