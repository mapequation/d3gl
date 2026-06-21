/**
 * Flat-array Barnes-Hut quadtree for O(n log n) repulsion in the force layout (#102, epic #98).
 * Rebuilt each tick from the positions buffer using typed arrays (no per-cell objects) and reused
 * across ticks. The same spatial structure is intended to back LOD culling / picking later.
 *
 * Per cell we store centre + half-size, child indices (4), a leaf body-list head, an internal
 * flag, and (after {@link build}) mass + centre-of-mass. Children always get a higher index than
 * their parent, so mass/COM is computed bottom-up by a single reverse pass.
 */
const MAX_DEPTH = 24;
/**
 * Repulsion softening (world units²): `f = repulsion / (d² + SOFTENING)`. Bounds the force as
 * d → 0 instead of letting `repulsion / d²` blow up for near-coincident nodes (which, with an
 * unbounded force, lets velocities run away to ±∞ → NaN — seen in multilevel coarse-level solves).
 * Tiny relative to layout spacing, so it doesn't affect well-separated nodes.
 */
const SOFTENING = 1e-2;

export class BarnesHutTree {
  private cellCx: Float64Array = new Float64Array(0);
  private cellCy: Float64Array = new Float64Array(0);
  private cellHalf: Float64Array = new Float64Array(0);
  private mass: Float64Array = new Float64Array(0);
  private comX: Float64Array = new Float64Array(0);
  private comY: Float64Array = new Float64Array(0);
  private child: Int32Array = new Int32Array(0); // 4 per cell, -1 = none
  private head: Int32Array = new Int32Array(0); // leaf body-list head, -1 = empty
  private internal: Uint8Array = new Uint8Array(0);
  private stack: Int32Array = new Int32Array(0); // reused DFS stack for applyForce
  private cellCount = 0;
  private capacity = 0;

  private bodyNext: Int32Array = new Int32Array(0); // per-body next pointer (coincident buckets)
  private px: Float32Array = new Float32Array(0);

  private ensureCells(need: number): void {
    if (this.capacity >= need) return;
    const cap = Math.max(need, this.capacity * 2, 64);
    const grow64 = (old: Float64Array): Float64Array => {
      const a = new Float64Array(cap);
      a.set(old);
      return a;
    };
    this.cellCx = grow64(this.cellCx);
    this.cellCy = grow64(this.cellCy);
    this.cellHalf = grow64(this.cellHalf);
    this.mass = grow64(this.mass);
    this.comX = grow64(this.comX);
    this.comY = grow64(this.comY);
    const ch = new Int32Array(cap * 4);
    ch.set(this.child);
    this.child = ch;
    const hd = new Int32Array(cap);
    hd.set(this.head);
    this.head = hd;
    const ig = new Uint8Array(cap);
    ig.set(this.internal);
    this.internal = ig;
    this.stack = new Int32Array(cap);
    this.capacity = cap;
  }

  private newCell(cx: number, cy: number, half: number): number {
    this.ensureCells(this.cellCount + 1);
    const c = this.cellCount++;
    this.cellCx[c] = cx;
    this.cellCy[c] = cy;
    this.cellHalf[c] = half;
    this.child[c * 4] = -1;
    this.child[c * 4 + 1] = -1;
    this.child[c * 4 + 2] = -1;
    this.child[c * 4 + 3] = -1;
    this.head[c] = -1;
    this.internal[c] = 0;
    return c;
  }

  private quadrant(cell: number, x: number, y: number): number {
    return (x >= this.cellCx[cell]! ? 1 : 0) | (y >= this.cellCy[cell]! ? 2 : 0);
  }

  private makeChild(parent: number, q: number): number {
    const half = this.cellHalf[parent]! / 2;
    const cx = this.cellCx[parent]! + ((q & 1) === 0 ? -half : half);
    const cy = this.cellCy[parent]! + ((q & 2) === 0 ? -half : half);
    const c = this.newCell(cx, cy, half);
    this.child[parent * 4 + q] = c;
    this.internal[parent] = 1;
    return c;
  }

  private insert(i: number): void {
    const x = this.px[i * 2]!;
    const y = this.px[i * 2 + 1]!;
    let cell = 0;
    let depth = 0;
    for (;;) {
      if (this.internal[cell]) {
        const q = this.quadrant(cell, x, y);
        const c = this.child[cell * 4 + q]!;
        if (c === -1) {
          const nc = this.makeChild(cell, q);
          this.head[nc] = i;
          this.bodyNext[i] = -1;
          return;
        }
        cell = c;
        if (++depth >= MAX_DEPTH) {
          this.bodyNext[i] = this.head[cell]!;
          this.head[cell] = i;
          return;
        }
        continue;
      }
      // leaf
      if (this.head[cell] === -1) {
        this.head[cell] = i;
        this.bodyNext[i] = -1;
        return;
      }
      if (depth >= MAX_DEPTH) {
        this.bodyNext[i] = this.head[cell]!;
        this.head[cell] = i;
        return;
      }
      // subdivide: push the existing single body down into a child, then re-loop for i
      const j = this.head[cell]!;
      this.head[cell] = -1;
      const qj = this.quadrant(cell, this.px[j * 2]!, this.px[j * 2 + 1]!);
      const cj = this.makeChild(cell, qj);
      this.head[cj] = j;
      this.bodyNext[j] = -1;
    }
  }

  build(positions: Float32Array, n: number): void {
    this.px = positions;
    this.cellCount = 0;
    if (this.bodyNext.length < n) this.bodyNext = new Int32Array(n);

    if (n === 0) {
      this.newCell(0, 0, 1);
      this.mass[0] = 0;
      this.comX[0] = 0;
      this.comY[0] = 0;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 2]!;
      const y = positions[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let half = Math.max(maxX - minX, maxY - minY) / 2;
    if (!(half > 0)) half = 1;
    half *= 1.0001; // pad so max-corner points fall strictly inside the root

    this.newCell(cx, cy, half);
    for (let i = 0; i < n; i++) this.insert(i);

    // Mass / COM bottom-up: children always have a higher index than their parent.
    for (let c = this.cellCount - 1; c >= 0; c--) {
      let m = 0;
      let sx = 0;
      let sy = 0;
      if (this.internal[c]) {
        for (let q = 0; q < 4; q++) {
          const ch = this.child[c * 4 + q]!;
          if (ch !== -1) {
            const mc = this.mass[ch]!;
            m += mc;
            sx += mc * this.comX[ch]!;
            sy += mc * this.comY[ch]!;
          }
        }
      } else {
        for (let b = this.head[c]!; b !== -1; b = this.bodyNext[b]!) {
          m += 1;
          sx += positions[b * 2]!;
          sy += positions[b * 2 + 1]!;
        }
      }
      this.mass[c] = m;
      this.comX[c] = m > 0 ? sx / m : 0;
      this.comY[c] = m > 0 ? sy / m : 0;
    }
  }

  applyForce(i: number, repulsion: number, theta: number, fx: Float32Array, fy: Float32Array): void {
    const xi = this.px[i * 2]!;
    const yi = this.px[i * 2 + 1]!;
    const theta2 = theta * theta;
    let ax = 0;
    let ay = 0;
    let sp = 0;
    this.stack[sp++] = 0;
    while (sp > 0) {
      const cell = this.stack[--sp]!;
      if (this.mass[cell] === 0) continue;
      if (this.internal[cell]) {
        const dx = xi - this.comX[cell]!;
        const dy = yi - this.comY[cell]!;
        const d2 = dx * dx + dy * dy;
        const s = 2 * this.cellHalf[cell]!;
        if (s * s < theta2 * d2) {
          // Cell is far enough: treat it as a single body at its centre of mass. Softened so a
          // near-coincident COM can't produce an unbounded force.
          const f = (repulsion * this.mass[cell]!) / (d2 + SOFTENING);
          ax += f * dx;
          ay += f * dy;
        } else {
          for (let q = 0; q < 4; q++) {
            const ch = this.child[cell * 4 + q]!;
            if (ch !== -1) this.stack[sp++] = ch;
          }
        }
      } else {
        for (let b = this.head[cell]!; b !== -1; b = this.bodyNext[b]!) {
          if (b === i) continue;
          const dx = xi - this.px[b * 2]!;
          const dy = yi - this.px[b * 2 + 1]!;
          const d2 = dx * dx + dy * dy;
          const f = repulsion / (d2 + SOFTENING); // softened: bounded as d → 0
          ax += f * dx;
          ay += f * dy;
        }
      }
    }
    fx[i] = fx[i]! + ax;
    fy[i] = fy[i]! + ay;
  }

  /** Half the side of the root bounding box (≈ layout radius); 1 before the first {@link build}. */
  rootHalf(): number {
    return this.cellCount > 0 ? this.cellHalf[0]! : 1;
  }

  rootMass(): number {
    return this.cellCount > 0 ? this.mass[0]! : 0;
  }

  rootCom(): [number, number] {
    return this.cellCount > 0 ? [this.comX[0]!, this.comY[0]!] : [0, 0];
  }
}
