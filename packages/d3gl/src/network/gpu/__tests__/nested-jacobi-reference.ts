/**
 * An executable spec of the batched GPU nested solve (#355) in float64: the same slots, segments, links
 * and constants as `GpuNestedLayout`, and the same Jacobi update — every term of a tick reads one state,
 * where the CPU `nestedLayout` applies its links and collision pairs one after another. Repulsion is
 * exact all-pairs within each segment (the GPU's exact loop; its segments above 32 children traverse a
 * grid pyramid instead, so compare those with the pyramid's tolerance). Test helper only.
 */
import { NESTED, WARM_ALPHA, nestedAlphaDecay } from "../../nested-layout.js";
import type { NestedSolverTopology } from "../nested-topology.js";

import { COLLISION_RELAX, COLLISION_STEPS } from "../passes/collision.js";

/** `a[i]`, or 0 past the end — typed-array reads without non-null assertions. */
function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/** The reference's state and its tick / compose steps. */
export class NestedJacobiReference {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  private readonly topo: NestedSolverTopology;
  private readonly segOf: Uint32Array;
  /**
   * CSR of the links in buildCSR's order (per link: its source's row, then its target's): neighbour and
   * weight, the weight times the row slot's spring relaxation (`springScale`) and rounded to float32, as
   * the GPU springs upload it.
   */
  private readonly rowStart: Uint32Array;
  private readonly rowNbr: Uint32Array;
  private readonly rowW: Float64Array;
  private tick = 0;
  private alphaCold = 1;
  private alphaWarm = WARM_ALPHA;
  private readonly organise: number;

  /** `organise`: ticks of the organise phase (default the CPU's `⌈0.6 · iterations⌉`). */
  constructor(topo: NestedSolverTopology, organise = Math.ceil(topo.iterations * NESTED.ORGANISE)) {
    this.topo = topo;
    this.organise = organise;
    const n = topo.slotCount;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = at(topo.seed, 2 * i);
      this.y[i] = at(topo.seed, 2 * i + 1);
    }
    this.segOf = new Uint32Array(n);
    topo.segStart.forEach((start, s) => this.segOf.fill(s, start, start + at(topo.segCount, s)));
    const L = topo.linkSource.length;
    const start = new Uint32Array(n + 1);
    for (let l = 0; l < L; l++) {
      const a = at(topo.linkSource, l) + 1;
      const b = at(topo.linkTarget, l) + 1;
      start[a] = at(start, a) + 1;
      start[b] = at(start, b) + 1;
    }
    for (let i = 0; i < n; i++) start[i + 1] = at(start, i + 1) + at(start, i);
    this.rowStart = start;
    this.rowNbr = new Uint32Array(2 * L);
    this.rowW = new Float64Array(2 * L);
    const cursor = start.slice(0, n);
    const put = (row: number, nbr: number, w: number): void => {
      const p = at(cursor, row);
      this.rowNbr[p] = nbr;
      this.rowW[p] = w;
      cursor[row] = p + 1;
    };
    for (let l = 0; l < L; l++) {
      const a = at(topo.linkSource, l);
      const b = at(topo.linkTarget, l);
      const w = at(topo.linkWeight, l);
      put(a, b, Math.fround(w * at(topo.springScale, a)));
      put(b, a, Math.fround(w * at(topo.springScale, b)));
    }
  }

  private alpha(slot: number): number {
    return at(this.topo.segAlpha0, at(this.segOf, slot)) === 1 ? this.alphaCold : this.alphaWarm;
  }

  /** One tick, exactly as the GPU encodes it (Jacobi everywhere). */
  step(relax = COLLISION_RELAX, collisions = COLLISION_STEPS): void {
    const { topo, x, y, vx, vy } = this;
    const n = topo.slotCount;
    const organising = this.tick < this.organise;
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    // v* = v + alpha · Σ repulsion − x · G · alpha
    for (let i = 0; i < n; i++) {
      const s = at(this.segOf, i);
      const k = at(topo.segCount, s);
      const first = at(topo.segStart, s);
      const alpha = this.alpha(i);
      const xi = at(x, i);
      const yi = at(y, i);
      let rx = 0;
      let ry = 0;
      if (organising) {
        const strength = NESTED.REPULSION_K / k;
        const eps = k <= 32 ? 1e-9 : 1e-8;
        for (let j = first; j < first + k; j++) {
          if (j === i) continue;
          const dx = xi - at(x, j);
          const dy = yi - at(y, j);
          const f = strength / (dx * dx + dy * dy + eps);
          rx += f * dx;
          ry += f * dy;
        }
      }
      sx[i] = at(vx, i) + alpha * rx - xi * NESTED.GRAVITY * alpha;
      sy[i] = at(vy, i) + alpha * ry - yi * NESTED.GRAVITY * alpha;
    }
    // Springs at the predictor x + v*, then v' = (v* + ½ α Σ) · (1 − DECAY), x' = x + v'.
    const nx = new Float64Array(n);
    const ny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const pix = at(x, i) + at(sx, i);
      const piy = at(y, i) + at(sy, i);
      const ri = at(topo.radius, i);
      let fx = 0;
      let fy = 0;
      for (let e = at(this.rowStart, i); e < at(this.rowStart, i + 1); e++) {
        const j = at(this.rowNbr, e);
        const rj = at(topo.radius, j);
        const dx = at(x, j) + at(sx, j) - pix;
        const dy = at(y, j) + at(sy, j) - piy;
        const d = Math.hypot(dx, dy) || 1e-9;
        const rest = organising ? 0 : (ri + rj) * NESTED.PAD;
        const g = ((at(this.rowW, e) * Math.max(0, d - rest)) / d) * ((rj * rj) / (ri * ri + rj * rj));
        fx += g * dx;
        fy += g * dy;
      }
      const alpha = this.alpha(i);
      const keep = 1 - NESTED.DECAY;
      nx[i] = (at(sx, i) + fx * 0.5 * alpha) * keep;
      ny[i] = (at(sy, i) + fy * 0.5 * alpha) * keep;
    }
    for (let i = 0; i < n; i++) {
      vx[i] = at(nx, i);
      vy[i] = at(ny, i);
      x[i] = at(x, i) + at(nx, i);
      y[i] = at(y, i) + at(ny, i);
    }
    if (!organising) for (let c = 0; c < collisions; c++) this.collide(relax);
    this.alphaCold -= this.alphaCold * nestedAlphaDecay(1, topo.iterations);
    this.alphaWarm -= this.alphaWarm * nestedAlphaDecay(WARM_ALPHA, topo.iterations);
    this.tick++;
  }

  /** One Jacobi collision step over every sibling pair (the GPU's grid is complete, so it sees the same pairs). */
  collide(relax = COLLISION_RELAX): void {
    const { topo, x, y } = this;
    const n = topo.slotCount;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = at(this.segOf, i);
      const first = at(topo.segStart, s);
      const k = at(topo.segCount, s);
      const ri = at(topo.radius, i);
      let ax = 0;
      let ay = 0;
      for (let j = first; j < first + k; j++) {
        if (j === i) continue;
        const rj = at(topo.radius, j);
        const dx = at(x, i) - at(x, j);
        const dy = at(y, i) - at(y, j);
        const min = (ri + rj) * NESTED.PAD;
        const d2 = dx * dx + dy * dy;
        if (!(d2 < min * min)) continue;
        const share = (rj * rj) / (ri * ri + rj * rj);
        if (d2 > 0) {
          const d = Math.sqrt(d2);
          ax += dx * ((min - d) / d) * share;
          ay += dy * ((min - d) / d) * share;
        } else {
          const ang = i - first + (j - first);
          const sign = i < j ? -1 : 1;
          ax += sign * Math.cos(ang) * min * share;
          ay += sign * Math.sin(ang) * min * share;
        }
      }
      px[i] = ax;
      py[i] = ay;
    }
    for (let i = 0; i < n; i++) {
      x[i] = at(x, i) + relax * at(px, i);
      y[i] = at(y, i) + relax * at(py, i);
    }
  }

  /** World discs of every tree node from the current local positions (the composition). */
  compose(rootX = 0, rootY = 0): { cx: Float64Array; cy: Float64Array; r: Float64Array } {
    const { topo, x, y } = this;
    const size = topo.treeSize;
    const cx = new Float64Array(size);
    const cy = new Float64Array(size);
    const r = new Float64Array(size);
    cx[topo.root] = rootX;
    cy[topo.root] = rootY;
    r[topo.root] = topo.rootRadius;
    // Segments are sorted by parent depth: every parent is placed before its children.
    topo.segStart.forEach((first, s) => {
      const k = at(topo.segCount, s);
      const g = at(topo.segModule, s);
      if (k === 1) {
        const c = at(topo.slotNode, first);
        cx[c] = at(cx, g);
        cy[c] = at(cy, g);
        r[c] = at(r, g) * NESTED.ONLY_CHILD;
        return;
      }
      let mx = 0;
      let my = 0;
      let mw = 0;
      for (let i = first; i < first + k; i++) {
        const w = at(topo.radius, i) ** 2;
        mx += at(x, i) * w;
        my += at(y, i) * w;
        mw += w;
      }
      mx /= mw;
      my /= mw;
      let extent = 0;
      for (let i = first; i < first + k; i++) extent = Math.max(extent, Math.hypot(at(x, i) - mx, at(y, i) - my) + at(topo.radius, i));
      const scale = (NESTED.FILL * at(r, g)) / (extent || 1);
      for (let i = first; i < first + k; i++) {
        const c = at(topo.slotNode, i);
        cx[c] = at(cx, g) + (at(x, i) - mx) * scale;
        cy[c] = at(cy, g) + (at(y, i) - my) * scale;
        r[c] = at(topo.radius, i) * scale;
      }
    });
    return { cx, cy, r };
  }
}
