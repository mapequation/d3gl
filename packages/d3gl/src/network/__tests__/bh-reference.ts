/**
 * Reference Barnes-Hut repulsion: the pointer-linked quadtree `BarnesHutTree` used before it was laid
 * out in preorder — bodies inserted one by one, cells subdivided until each holds one body (or the
 * depth cap buckets coincident ones, newest first as its linked list held them), mass / centre of mass
 * summed bottom-up in quadrant order 0..3,
 * each body's force gathered by a stack DFS that pushes quadrants 0..3 (so it visits 3..0). It pins
 * the approximation the flat tree must keep: the same cells, the same opening test, the same order.
 */
const MAX_DEPTH = 24;
const SOFTENING = 1e-2;

interface Cell {
  cx: number;
  cy: number;
  half: number;
  child: (Cell | undefined)[];
  bodies: number[];
  mass: number;
  comX: number;
  comY: number;
}

const cell = (cx: number, cy: number, half: number): Cell => ({ cx, cy, half, child: [], bodies: [], mass: 0, comX: 0, comY: 0 });
const quadrant = (c: Cell, x: number, y: number): number => (x >= c.cx ? 1 : 0) | (y >= c.cy ? 2 : 0);

function childOf(c: Cell, q: number): Cell {
  const existing = c.child[q];
  if (existing) return existing;
  const half = c.half / 2;
  const made = cell(c.cx + ((q & 1) === 0 ? -half : half), c.cy + ((q & 2) === 0 ? -half : half), half);
  c.child[q] = made;
  return made;
}

/** Repulsion on every body (`fx`/`fy` per body) as the reference tree computes it. */
export function referenceRepulsion(
  positions: Float32Array,
  n: number,
  repulsion: number,
  theta: number,
  mass?: Float32Array,
): { fx: Float64Array; fy: Float64Array; rootMass: number; rootCom: [number, number]; buckets: number } {
  const x = (i: number): number => positions[i * 2] ?? 0;
  const y = (i: number): number => positions[i * 2 + 1] ?? 0;
  const m = (i: number): number => mass?.[i] ?? 1;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  if (n === 0) return { fx, fy, rootMass: 0, rootCom: [0, 0], buckets: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x(i));
    maxX = Math.max(maxX, x(i));
    minY = Math.min(minY, y(i));
    maxY = Math.max(maxY, y(i));
  }
  let half = Math.max(maxX - minX, maxY - minY) / 2;
  if (!(half > 0)) half = 1;
  const root = cell((minX + maxX) / 2, (minY + maxY) / 2, half * 1.0001);

  const internal = (c: Cell): boolean => c.child.some((ch) => ch !== undefined);
  let buckets = 0;
  for (let i = 0; i < n; i++) {
    let c = root;
    let depth = 0;
    for (;;) {
      if (internal(c)) {
        c = childOf(c, quadrant(c, x(i), y(i)));
        depth++;
        continue;
      }
      if (c.bodies.length === 0) {
        c.bodies.push(i);
        break;
      }
      if (depth >= MAX_DEPTH) {
        if (c.bodies.length === 1) buckets++;
        c.bodies.unshift(i); // the old bucket was a linked list with head insertion
        break;
      }
      const j = c.bodies.pop() ?? 0; // subdivide: push the single resident down, then retry i here
      childOf(c, quadrant(c, x(j), y(j))).bodies.push(j);
    }
  }

  const summarize = (c: Cell): void => {
    let mc = 0;
    let sx = 0;
    let sy = 0;
    if (internal(c)) {
      for (let q = 0; q < 4; q++) {
        const ch = c.child[q];
        if (!ch) continue;
        summarize(ch);
        mc += ch.mass;
        sx += ch.mass * ch.comX;
        sy += ch.mass * ch.comY;
      }
    } else {
      for (const b of c.bodies) {
        mc += m(b);
        sx += m(b) * x(b);
        sy += m(b) * y(b);
      }
    }
    c.mass = mc;
    c.comX = mc > 0 ? sx / mc : 0;
    c.comY = mc > 0 ? sy / mc : 0;
  };
  summarize(root);

  const theta2 = theta * theta;
  for (let i = 0; i < n; i++) {
    let ax = 0;
    let ay = 0;
    const stack: Cell[] = [root];
    for (let c = stack.pop(); c; c = stack.pop()) {
      if (c.mass === 0) continue;
      if (internal(c)) {
        const dx = x(i) - c.comX;
        const dy = y(i) - c.comY;
        const d2 = dx * dx + dy * dy;
        const s = 2 * c.half;
        if (s * s < theta2 * d2) {
          const f = (repulsion * c.mass) / (d2 + SOFTENING);
          ax += f * dx;
          ay += f * dy;
        } else {
          for (let q = 0; q < 4; q++) {
            const ch = c.child[q];
            if (ch) stack.push(ch);
          }
        }
      } else {
        for (const b of c.bodies) {
          if (b === i) continue;
          const dx = x(i) - x(b);
          const dy = y(i) - y(b);
          const d2 = dx * dx + dy * dy;
          const f = (repulsion * m(b)) / (d2 + SOFTENING);
          ax += f * dx;
          ay += f * dy;
        }
      }
    }
    fx[i] = ax;
    fy[i] = ay;
  }
  return { fx, fy, rootMass: root.mass, rootCom: [root.comX, root.comY], buckets };
}
