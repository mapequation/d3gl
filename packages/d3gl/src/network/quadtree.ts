/**
 * Flat-array Barnes-Hut quadtree for O(n log n) repulsion in the force layout (#102, epic #98).
 * Rebuilt each tick from the positions buffer using typed arrays (no per-cell objects) and reused
 * across ticks. The same spatial structure is intended to back LOD culling / picking later.
 *
 * The repulsion pass is memory-bound, so the tree is laid out for it:
 * - **Records in preorder.** Cells and bodies are one array of `[comX, comY, mass, s²]` records in the
 *   order the traversal visits them (a cell, then its quadrants 3..0), each with a skip pointer to
 *   the record after its subtree. A traversal is a forward scan — accept a record and jump its skip,
 *   or open it and step to the next — with no stack and no child indices.
 * - **Bodies are records.** A body's record holds its exact position and mass and an `s²` below any
 *   `θ²·d²`, so the one test accepts it as a point mass: the same softened term the direct sum over
 *   a leaf's bodies computed. Coincident bodies (past {@link MAX_DEPTH}) hang as body records under
 *   a bucket record whose `s²` exceeds any `θ²·d²`, so it is always opened.
 * - **Bodies in Z order.** The build partitions the bodies top-down into the tree's own quadrants
 *   and keeps that order for the next build, which then starts from an almost sorted array.
 *   {@link BarnesHutTree.applyForces} walks the bodies in it, so consecutive traversals open the
 *   same cells.
 *
 * None of this changes the approximation: the cells, the opening test and every body's summation
 * order are those of the pointer quadtree it replaces (bit-identical on unit bodies; see
 * `__tests__/bh-reference.ts`), and none of them depends on the order kept from earlier builds —
 * except the order in which a bucket sums its coincident bodies.
 */
const MAX_DEPTH = 24;
/**
 * Repulsion softening (world units²): `f = repulsion / (d² + SOFTENING)`. Bounds the force as
 * d → 0 instead of letting `repulsion / d²` blow up for near-coincident nodes (which, with an
 * unbounded force, lets velocities run away to ±∞ → NaN — seen in multilevel coarse-level solves).
 * Tiny relative to layout spacing, so it doesn't affect well-separated nodes.
 */
const SOFTENING = 1e-2;
/** `s²` of a body record: below every `θ²·d² ≥ 0`, so a body is always taken as a point mass. */
const BODY = -1;
/** `s²` of a bucket of coincident bodies: above every `θ²·d²`, so it is always opened into its bodies. */
const BUCKET = Infinity;
/** Floats per record: centre of mass x / y, mass, and `s²` (the squared cell side, or {@link BODY} / {@link BUCKET}). */
const STRIDE = 4;
/** Pending build tasks never exceed three siblings per level of the current path, plus the one popped. */
const TASKS = 3 * MAX_DEPTH + 4;

export class BarnesHutTree {
  /** {@link STRIDE} floats per record, in traversal preorder. */
  private rec: Float64Array = new Float64Array(0);
  /** Per record: the index of the record after its subtree (its subtree size while building). */
  private skip: Int32Array = new Int32Array(0);
  /** Per record: its parent record, -1 for the root (the bottom-up mass pass adds each record into it). */
  private parent: Int32Array = new Int32Array(0);
  private records = 0;
  private capacity = 0;

  /** Body slots in Z order: `order[k]` is the body in slot `k`, `slotX` / `slotY` its position. */
  private order: Int32Array = new Int32Array(0);
  private slotX: Float32Array = new Float32Array(0);
  private slotY: Float32Array = new Float32Array(0);
  /** Body count of the last build; `order` holds a permutation of `[0, bodies)`. */
  private bodies = 0;
  private px: Float32Array = new Float32Array(0);
  private half = 1;

  // The build's DFS task stack: slot range, cell centre / half-size, depth and parent record.
  private readonly taskLo = new Int32Array(TASKS);
  private readonly taskHi = new Int32Array(TASKS);
  private readonly taskDepth = new Int32Array(TASKS);
  private readonly taskParent = new Int32Array(TASKS);
  private readonly taskCx = new Float64Array(TASKS);
  private readonly taskCy = new Float64Array(TASKS);
  private readonly taskHalf = new Float64Array(TASKS);

  private ensureRecords(need: number): void {
    if (this.capacity >= need) return;
    const cap = Math.max(need, this.capacity * 2, 64);
    const rec = new Float64Array(cap * STRIDE);
    rec.set(this.rec);
    this.rec = rec;
    const skip = new Int32Array(cap);
    skip.set(this.skip);
    this.skip = skip;
    const parent = new Int32Array(cap);
    parent.set(this.parent);
    this.parent = parent;
    this.capacity = cap;
  }

  /** Size the body slots for `n` bodies, restarting from id order when the body count changed. */
  private ensureBodies(n: number): void {
    if (this.order.length < n) {
      const cap = Math.max(n, this.order.length * 2);
      this.order = new Int32Array(cap);
      this.slotX = new Float32Array(cap);
      this.slotY = new Float32Array(cap);
      this.bodies = -1;
    }
    if (this.bodies === n) return;
    for (let k = 0; k < n; k++) this.order[k] = k;
    this.bodies = n;
  }

  private newRecord(x: number, y: number, mass: number, s2: number, parent: number): number {
    this.ensureRecords(this.records + 1);
    const r = this.records++;
    const o = r * STRIDE;
    this.rec[o] = x;
    this.rec[o + 1] = y;
    this.rec[o + 2] = mass;
    this.rec[o + 3] = s2;
    this.skip[r] = 1;
    this.parent[r] = parent;
    return r;
  }

  private bodyRecord(slot: number, parent: number, mass: Float32Array | undefined): void {
    const m = mass ? (mass[this.order[slot] ?? 0] ?? 1) : 1;
    this.newRecord(this.slotX[slot] ?? 0, this.slotY[slot] ?? 0, m, BODY, parent);
  }

  /**
   * Partition slots `[lo, hi)` so those whose coordinate (`slotY` when `byY`, else `slotX`) is
   * `>= v` come last, and return the first of them. Carries each slot's body id along, and leaves an
   * already partitioned range untouched — a layout that barely moved costs one read per slot.
   */
  private partition(lo: number, hi: number, v: number, byY: boolean): number {
    const { slotX, slotY, order } = this;
    const key = byY ? slotY : slotX;
    let i = lo;
    let j = hi - 1;
    for (;;) {
      while (i <= j && !((key[i] ?? 0) >= v)) i++;
      while (i <= j && (key[j] ?? 0) >= v) j--;
      if (i >= j) return i;
      const x = slotX[i] ?? 0;
      slotX[i] = slotX[j] ?? 0;
      slotX[j] = x;
      const y = slotY[i] ?? 0;
      slotY[i] = slotY[j] ?? 0;
      slotY[j] = y;
      const b = order[i] ?? 0;
      order[i] = order[j] ?? 0;
      order[j] = b;
      i++;
      j--;
    }
  }

  private pushTask(sp: number, lo: number, hi: number, cx: number, cy: number, half: number, depth: number, parent: number): number {
    this.taskLo[sp] = lo;
    this.taskHi[sp] = hi;
    this.taskCx[sp] = cx;
    this.taskCy[sp] = cy;
    this.taskHalf[sp] = half;
    this.taskDepth[sp] = depth;
    this.taskParent[sp] = parent;
    return sp + 1;
  }

  /**
   * Rebuild over the first `n` bodies of `positions`. With `mass` each body weighs its entry (a
   * multilevel coarse level's supernodes) instead of 1, so cell masses and centres of mass are
   * mass-weighted and {@link applyForce} yields each body's repulsion per unit of its own mass.
   */
  build(positions: Float32Array, n: number, mass?: Float32Array): void {
    this.px = positions;
    this.records = 0;
    this.half = 1;
    this.ensureBodies(n);
    if (n === 0) return;

    // Gather the bodies into their slots (in the order the last build left) and take the bounds.
    const { order, slotX, slotY } = this;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      const x = positions[i * 2] ?? 0;
      const y = positions[i * 2 + 1] ?? 0;
      slotX[k] = x;
      slotY[k] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    let half = Math.max(maxX - minX, maxY - minY) / 2;
    if (!(half > 0)) half = 1;
    half *= 1.0001; // pad so max-corner points fall strictly inside the root
    this.half = half;

    // Top-down: a cell with one body is that body's record; one with more partitions its slots into
    // quadrants and queues them 0..3, so they pop — and land in preorder — as 3..0.
    let sp = this.pushTask(0, 0, n, (minX + maxX) / 2, (minY + maxY) / 2, half, 0, -1);
    while (sp > 0) {
      sp--;
      const lo = this.taskLo[sp] ?? 0;
      const hi = this.taskHi[sp] ?? 0;
      const parent = this.taskParent[sp] ?? -1;
      if (hi - lo === 1) {
        this.bodyRecord(lo, parent, mass);
        continue;
      }
      const depth = this.taskDepth[sp] ?? MAX_DEPTH;
      if (depth >= MAX_DEPTH) {
        const bucket = this.newRecord(0, 0, 0, BUCKET, parent);
        for (let k = lo; k < hi; k++) this.bodyRecord(k, bucket, mass);
        continue;
      }
      const h = this.taskHalf[sp] ?? 0;
      const cx = this.taskCx[sp] ?? 0;
      const cy = this.taskCy[sp] ?? 0;
      const cell = this.newRecord(0, 0, 0, 4 * h * h, parent);
      const mid = this.partition(lo, hi, cy, true); // [lo, mid): quadrants 0, 1; [mid, hi): 2, 3
      const q1 = this.partition(lo, mid, cx, false);
      const q3 = this.partition(mid, hi, cx, false);
      const c = h / 2;
      const d = depth + 1;
      if (q1 > lo) sp = this.pushTask(sp, lo, q1, cx - c, cy - c, c, d, cell);
      if (mid > q1) sp = this.pushTask(sp, q1, mid, cx + c, cy - c, c, d, cell);
      if (q3 > mid) sp = this.pushTask(sp, mid, q3, cx - c, cy + c, c, d, cell);
      if (hi > q3) sp = this.pushTask(sp, q3, hi, cx + c, cy + c, c, d, cell);
    }

    // Bottom-up in reverse preorder: every record is complete before its parent, and a cell's
    // quadrants arrive 0..3 — the pointer tree's summation order. A cell accumulates the
    // mass-weighted sum in its centre slots, then divides; subtree sizes become skip pointers.
    const { rec, skip } = this;
    for (let r = this.records - 1; r >= 0; r--) {
      const o = r * STRIDE;
      const m = rec[o + 2] ?? 0;
      if ((rec[o + 3] ?? BODY) !== BODY) {
        rec[o] = m > 0 ? (rec[o] ?? 0) / m : 0;
        rec[o + 1] = m > 0 ? (rec[o + 1] ?? 0) / m : 0;
      }
      const size = skip[r] ?? 1;
      skip[r] = r + size;
      const p = this.parent[r] ?? -1;
      if (p < 0) continue;
      const po = p * STRIDE;
      rec[po + 2] = (rec[po + 2] ?? 0) + m;
      rec[po] = (rec[po] ?? 0) + m * (rec[o] ?? 0);
      rec[po + 1] = (rec[po + 1] ?? 0) + m * (rec[o + 1] ?? 0);
      skip[p] = (skip[p] ?? 1) + size;
    }
  }

  /** Add body `i`'s repulsion to `fx[i]` / `fy[i]` (per unit of its own mass when the build had masses). */
  applyForce(i: number, repulsion: number, theta: number, fx: Float32Array, fy: Float32Array): void {
    const xi = this.px[i * 2] ?? 0;
    const yi = this.px[i * 2 + 1] ?? 0;
    const theta2 = theta * theta;
    const { rec, skip } = this;
    const end = this.records;
    let ax = 0;
    let ay = 0;
    let r = 0;
    while (r < end) {
      const o = r * STRIDE;
      const dx = xi - (rec[o] ?? 0);
      const dy = yi - (rec[o + 1] ?? 0);
      const d2 = dx * dx + dy * dy;
      if ((rec[o + 3] ?? BUCKET) < theta2 * d2) {
        // A far cell as one body at its centre of mass, or a body itself (its own record adds 0).
        // Softened so a near-coincident centre can't produce an unbounded force.
        const f = (repulsion * (rec[o + 2] ?? 0)) / (d2 + SOFTENING);
        ax += f * dx;
        ay += f * dy;
        r = skip[r] ?? end;
      } else {
        r++;
      }
    }
    fx[i] = (fx[i] ?? 0) + ax;
    fy[i] = (fy[i] ?? 0) + ay;
  }

  /**
   * {@link applyForce} for every body of the last build, visited in the tree's Z order so that
   * consecutive traversals share the cells they open — the force layout's per-tick repulsion.
   */
  applyForces(repulsion: number, theta: number, fx: Float32Array, fy: Float32Array): void {
    for (let k = 0; k < this.bodies; k++) this.applyForce(this.order[k] ?? 0, repulsion, theta, fx, fy);
  }

  /** Half the side of the root bounding box (≈ layout radius); 1 before the first {@link build}. */
  rootHalf(): number {
    return this.half;
  }

  /** Total mass of the last build (its body count without masses). */
  rootMass(): number {
    return this.records > 0 ? (this.rec[2] ?? 0) : 0;
  }

  /** Mass-weighted centre of the last build's bodies; `[0, 0]` for an empty build. */
  rootCom(): [number, number] {
    return this.records > 0 ? [this.rec[0] ?? 0, this.rec[1] ?? 0] : [0, 0];
  }
}
