# d3gl Geometry & Scene Model Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CPU-side, GPU-ready geometry and scene model in `@d3gl/core`: group polygon rings into outer+holes, expand strokes into triangles, and assemble a retained `Scene` of drawables that packs all geometry into typed-array buffers with a per-vertex `drawableId`, plus hot-swappable color/flag side-tables — so recoloring touches only a color table and never re-tessellates.

**Architecture:** Three pure modules added to `@d3gl/core`. `rings.ts` classifies the flat `Subpath[]` from `PathRecorder` into `{outer, holes}` groups (signed area + point-in-polygon containment) — recovering the fill topology that `PathRecorder` deliberately discards. `stroke.ts` expands a polyline `Subpath` into fill triangles (segment quads + bevel joins, butt caps). `scene.ts` ties it together: a `Scene` holds named groups; each `drawable(id, draw, {lineWidth})` runs the draw callback into a `PathRecorder`, tessellates fill (via `groupRings`+`tessellateFill`) and stroke (via `expandStroke`), appends the geometry into the group's shared arrays tagging every vertex with a compact integer `drawableId`, and records the drawable's contiguous buffer range. `buffers(name)` emits `Float32Array`/`Uint32Array`/`Uint8Array` ready for GPU upload; `setFill`/`setStroke`/`setFlag` write the side-tables by domain id without touching geometry.

**Tech Stack:** TypeScript (strict), Vitest, earcut (already present), d3-color (new, for CSS color → RGBA), d3-geo (dev, for the integration test). All Node-testable; no GPU.

**Builds on Plan 1:** uses `PathRecorder`, `Subpath`, `tessellateFill` from `@d3gl/core`. Stroke *width* is a build-time geometry parameter (it determines expansion), so it is NOT hot-swappable; only colors and flags are. This is intentional and reflects the design (recolor = cheap; geometry change = rare).

**Scope boundary:** No GPU/luma.gl here (Plan 3). No project-once/d3-zoom/geo specialization (Plan 4). No labels/React (Plan 5). Round/square line caps and miter joins are deferred (butt caps + bevel joins only). Nested islands-in-lakes ring topology (hole-within-hole) is out of scope — single-level holes only (covers grid cells and typical country polygons); the limitation is documented in code.

---

## File Structure

```
packages/core/
├─ package.json                 # add d3-color dep + @types/d3-color (Task 4)
└─ src/
   ├─ rings.ts                  # groupRings: Subpath[] -> RingGroup[]            (Task 1)
   ├─ stroke.ts                 # expandStroke: Subpath + width -> triangles      (Task 2)
   ├─ scene.ts                  # Scene, GroupBuilder, buffers, color/flag tables (Tasks 3+4)
   ├─ index.ts                  # re-export new public API                        (Tasks 1-4)
   └─ __tests__/
      ├─ rings.test.ts                                                            (Task 1)
      ├─ stroke.test.ts                                                           (Task 2)
      ├─ scene.test.ts                                                            (Tasks 3+4)
      └─ scene-conformance.test.ts                                                (Task 5)
```

**Tooling note for every task:** the bare `pnpm` command is broken on this machine; use `corepack pnpm@9`. Run a single suite with `corepack pnpm@9 test -- <name>`; full suite with `corepack pnpm@9 test`. Commit with `git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "..."` — never add co-author or "claude" attribution.

---

## Task 1: Ring grouping (outer + holes)

**Files:**
- Create: `packages/core/src/rings.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/rings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/rings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signedArea, pointInRing, groupRings } from "../rings.js";
import type { Subpath } from "../path-context.js";

const ccwSquare = (): Subpath => ({
  // counter-clockwise outer ring, area > 0
  points: [0, 0, 10, 0, 10, 10, 0, 10],
  closed: true,
});
const cwHole = (): Subpath => ({
  // clockwise inner ring (opposite winding), area < 0, inside the square
  points: [3, 3, 3, 7, 7, 7, 7, 3],
  closed: true,
});

describe("signedArea", () => {
  it("is positive for CCW and negative for CW rings", () => {
    expect(signedArea(ccwSquare().points)).toBeGreaterThan(0);
    expect(signedArea(cwHole().points)).toBeLessThan(0);
  });
  it("equals the geometric area magnitude (100 for a 10x10 square)", () => {
    expect(Math.abs(signedArea(ccwSquare().points))).toBeCloseTo(100, 6);
  });
});

describe("pointInRing", () => {
  it("detects inside and outside points", () => {
    const r = ccwSquare().points;
    expect(pointInRing(5, 5, r)).toBe(true);
    expect(pointInRing(15, 5, r)).toBe(false);
  });
});

describe("groupRings", () => {
  it("returns a single outer with no holes for one ring", () => {
    const groups = groupRings([ccwSquare()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(0);
  });

  it("assigns a contained, opposite-wound ring as a hole of its container", () => {
    const groups = groupRings([ccwSquare(), cwHole()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(1);
    expect(groups[0]!.outer.points).toEqual(ccwSquare().points);
  });

  it("keeps two disjoint rings as two separate outers", () => {
    const a = ccwSquare();
    const b: Subpath = { points: [20, 20, 30, 20, 30, 30, 20, 30], closed: true };
    const groups = groupRings([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.holes.length === 0)).toBe(true);
  });

  it("ignores open and degenerate subpaths", () => {
    const open: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const tiny: Subpath = { points: [0, 0, 1, 0], closed: true };
    expect(groupRings([open, tiny])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- rings`
Expected: FAIL — cannot resolve `../rings.js`.

- [ ] **Step 3: Implement ring grouping**

Create `packages/core/src/rings.ts`:

```ts
import type { Subpath } from "./path-context.js";

/** One filled polygon: an outer ring plus zero or more hole rings. */
export interface RingGroup {
  outer: Subpath;
  holes: Subpath[];
}

/**
 * Shoelace signed area of a ring (interleaved x,y). Positive for
 * counter-clockwise winding, negative for clockwise. Magnitude is the area.
 */
export function signedArea(points: readonly number[]): number {
  let sum = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = points[2 * i]!;
    const y1 = points[2 * i + 1]!;
    const j = (i + 1) % n;
    const x2 = points[2 * j]!;
    const y2 = points[2 * j + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Ray-casting point-in-polygon test against a ring (interleaved x,y). */
export function pointInRing(x: number, y: number, points: readonly number[]): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[2 * i]!;
    const yi = points[2 * i + 1]!;
    const xj = points[2 * j]!;
    const yj = points[2 * j + 1]!;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Group a flat list of closed rings into filled polygons with holes.
 *
 * `PathRecorder` emits independent subpaths and discards which ring is an outer
 * boundary vs. a hole, so we recover it here: process rings largest-first; a ring
 * is a hole of the smallest already-seen outer that geometrically contains it,
 * otherwise it starts a new outer. Open or degenerate (<3 vertex) subpaths are
 * skipped — a fill needs a closed ring.
 *
 * Limitation: single-level nesting only (no hole-within-hole islands). This covers
 * grid cells (one ring each) and typical country polygons.
 */
export function groupRings(subpaths: readonly Subpath[]): RingGroup[] {
  const rings = subpaths
    .filter((s) => s.closed && s.points.length >= 6)
    .map((s) => ({ subpath: s, absArea: Math.abs(signedArea(s.points)) }))
    .filter((r) => r.absArea > 0)
    .sort((a, b) => b.absArea - a.absArea); // largest first

  const groups: RingGroup[] = [];
  for (const ring of rings) {
    const px = ring.subpath.points[0]!;
    const py = ring.subpath.points[1]!;
    // Find the smallest-area existing outer that contains this ring's first point.
    let container: RingGroup | null = null;
    let containerArea = Infinity;
    for (const g of groups) {
      const gArea = Math.abs(signedArea(g.outer.points));
      if (gArea < containerArea && pointInRing(px, py, g.outer.points)) {
        container = g;
        containerArea = gArea;
      }
    }
    if (container) {
      container.holes.push(ring.subpath);
    } else {
      groups.push({ outer: ring.subpath, holes: [] });
    }
  }
  return groups;
}
```

- [ ] **Step 4: Re-export from index.ts**

Replace `packages/core/src/index.ts` with:

```ts
export type { PathContext, Subpath } from "./path-context.js";
export { PathRecorder } from "./path-recorder.js";
export { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";
export { tessellateFill } from "./tessellate.js";
export type { FillGeometry } from "./tessellate.js";
export { signedArea, pointInRing, groupRings } from "./rings.js";
export type { RingGroup } from "./rings.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- rings`
Expected: PASS — all ring tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/rings.ts packages/core/src/index.ts packages/core/src/__tests__/rings.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(core): group polygon rings into outer+holes"
```

---

## Task 2: Stroke expansion

**Files:**
- Create: `packages/core/src/stroke.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/stroke.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/stroke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { expandStroke } from "../stroke.js";
import type { Subpath } from "../path-context.js";

describe("expandStroke", () => {
  it("expands a single open segment into one quad (4 verts, 6 indices)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0], closed: false };
    const { vertices, indices } = expandStroke(sp, 2);
    expect(vertices.length / 2).toBe(4);
    expect(indices.length).toBe(6);
    // half-width 1, horizontal segment => offsets in y by ±1
    expect(vertices).toEqual([0, 1, 0, -1, 10, 1, 10, -1]);
  });

  it("adds a bevel join at an interior corner of an open polyline", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { vertices, indices } = expandStroke(sp, 2);
    // 2 segment quads (12 indices) + 1 bevel joint (6 indices) = 18
    expect(indices.length).toBe(18);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("joins all corners of a closed ring (no caps)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const { vertices, indices } = expandStroke(sp, 2);
    // 4 segment quads (24 indices) + 4 bevel joints (24 indices) = 48
    expect(indices.length).toBe(48);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("returns empty geometry for zero width or a single point", () => {
    expect(expandStroke({ points: [0, 0, 10, 0], closed: false }, 0).indices).toHaveLength(0);
    expect(expandStroke({ points: [0, 0], closed: false }, 2).indices).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- stroke`
Expected: FAIL — cannot resolve `../stroke.js`.

- [ ] **Step 3: Implement stroke expansion**

Create `packages/core/src/stroke.ts`:

```ts
import type { Subpath } from "./path-context.js";

export interface StrokeGeometry {
  /** Interleaved x,y vertex coordinates. */
  vertices: number[];
  /** Triangle indices into `vertices` (3 per triangle). */
  indices: number[];
}

/**
 * Expand a polyline into fill triangles for a stroke of the given width.
 *
 * Each straight segment becomes a quad (2 triangles); each interior vertex gets a
 * bevel join (filled on both sides — robust, no cracks, harmless overlap on the
 * inner side for opaque fills). Closed subpaths join every corner including the
 * wrap-around; open subpaths use butt caps (no extra cap geometry). Round/square
 * caps and miter joins are deferred.
 *
 * Width is a geometry parameter: changing it requires re-expanding. (Recoloring a
 * stroke does not — color lives in a separate side-table.)
 */
export function expandStroke(subpath: Subpath, width: number): StrokeGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  const pts = subpath.points;
  const n = pts.length / 2;
  const half = width / 2;
  if (n < 2 || width <= 0) return { vertices, indices };

  const px = (i: number) => pts[2 * i]!;
  const py = (i: number) => pts[2 * i + 1]!;

  // Segment quads.
  const segCount = subpath.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const ax = px(i);
    const ay = py(i);
    const bx = px((i + 1) % n);
    const by = py((i + 1) % n);
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    dx /= len;
    dy /= len;
    const nx = -dy * half;
    const ny = dx * half;
    const base = vertices.length / 2;
    vertices.push(ax + nx, ay + ny, ax - nx, ay - ny, bx + nx, by + ny, bx - nx, by - ny);
    indices.push(base + 0, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  // Bevel joins. Open: interior vertices 1..n-2. Closed: every vertex 0..n-1.
  const jointStart = subpath.closed ? 0 : 1;
  const jointEnd = subpath.closed ? n : n - 1;
  for (let j = jointStart; j < jointEnd; j++) {
    const cx = px(j);
    const cy = py(j);
    const ax = px((j - 1 + n) % n);
    const ay = py((j - 1 + n) % n);
    const bx = px((j + 1) % n);
    const by = py((j + 1) % n);
    let pdx = cx - ax;
    let pdy = cy - ay;
    const pl = Math.hypot(pdx, pdy);
    let ndx = bx - cx;
    let ndy = by - cy;
    const nl = Math.hypot(ndx, ndy);
    if (pl === 0 || nl === 0) continue;
    pdx /= pl;
    pdy /= pl;
    ndx /= nl;
    ndy /= nl;
    const pnx = -pdy * half;
    const pny = pdx * half;
    const nnx = -ndy * half;
    const nny = ndx * half;
    const base = vertices.length / 2;
    // center, prevLeft, nextLeft, prevRight, nextRight
    vertices.push(cx, cy, cx + pnx, cy + pny, cx + nnx, cy + nny, cx - pnx, cy - pny, cx - nnx, cy - nny);
    indices.push(base + 0, base + 1, base + 2, base + 0, base + 3, base + 4);
  }

  return { vertices, indices };
}
```

- [ ] **Step 4: Re-export from index.ts**

Replace `packages/core/src/index.ts` with:

```ts
export type { PathContext, Subpath } from "./path-context.js";
export { PathRecorder } from "./path-recorder.js";
export { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";
export { tessellateFill } from "./tessellate.js";
export type { FillGeometry } from "./tessellate.js";
export { signedArea, pointInRing, groupRings } from "./rings.js";
export type { RingGroup } from "./rings.js";
export { expandStroke } from "./stroke.js";
export type { StrokeGeometry } from "./stroke.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- stroke`
Expected: PASS — all stroke tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/stroke.ts packages/core/src/index.ts packages/core/src/__tests__/stroke.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(core): expand strokes into triangles with bevel joins"
```

---

## Task 3: Scene & drawable model with buffer packing

**Files:**
- Create: `packages/core/src/scene.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/scene.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/scene.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene geometry", () => {
  it("packs fill geometry with a per-vertex drawableId", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => {
        ctx.rect(0, 0, 10, 10);
      });
      g.drawable("b", (ctx) => {
        ctx.rect(20, 0, 10, 10);
      });
    });
    const buf = scene.buffers("cells");
    expect(buf.drawableCount).toBe(2);
    // each rect => 4 fill verts; stride 3 (x,y,drawableId)
    expect(buf.fillVertices.length).toBe(2 * 4 * 3);
    // first 4 verts carry drawableId 0, next 4 carry 1
    expect(buf.fillVertices[2]).toBe(0); // first vertex's id
    expect(buf.fillVertices[4 * 3 + 2]).toBe(1); // 5th vertex's id
    // 2 triangles per rect => 6 indices each
    expect(buf.fillIndices.length).toBe(2 * 6);
  });

  it("produces stroke geometry only when lineWidth is given", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)); // no stroke
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10), { lineWidth: 1 });
    });
    const buf = scene.buffers("cells");
    // only drawable "b" contributes stroke geometry
    expect(buf.strokeIndices.length).toBeGreaterThan(0);
    // every stroke vertex belongs to drawableId 1
    for (let i = 0; i < buf.strokeVertices.length; i += 3) {
      expect(buf.strokeVertices[i + 2]).toBe(1);
    }
  });

  it("records contiguous per-drawable buffer ranges", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10));
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10));
    });
    const r0 = scene.range("cells", "a");
    const r1 = scene.range("cells", "b");
    expect(r0.fill.vertexOffset).toBe(0);
    expect(r0.fill.vertexCount).toBe(4);
    expect(r1.fill.vertexOffset).toBe(4);
    expect(r1.fill.indexOffset).toBe(6);
  });

  it("throws for an unknown group", () => {
    const scene = new Scene();
    expect(() => scene.buffers("nope")).toThrow(/unknown group/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- scene`
Expected: FAIL — cannot resolve `../scene.js`.

- [ ] **Step 3: Implement the Scene model**

Create `packages/core/src/scene.ts`:

```ts
import { PathRecorder } from "./path-recorder.js";
import { groupRings } from "./rings.js";
import { tessellateFill } from "./tessellate.js";
import { expandStroke } from "./stroke.js";

/** Contiguous slice a drawable occupies within a group's shared buffers. */
export interface DrawableRange {
  fill: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number };
  stroke: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number };
}

/** GPU-ready typed arrays for one group. Vertices are [x, y, drawableId]. */
export interface GroupBuffers {
  fillVertices: Float32Array;
  fillIndices: Uint32Array;
  strokeVertices: Float32Array;
  strokeIndices: Uint32Array;
  /** RGBA bytes per drawable, indexed by drawableId. */
  fillColors: Uint8Array;
  strokeColors: Uint8Array;
  /** One byte of flags per drawable (bit 0 = visible). */
  flags: Uint8Array;
  drawableCount: number;
}

export interface DrawableOpts {
  /** Stroke width in coordinate units. 0/undefined => no stroke geometry. */
  lineWidth?: number;
}

export interface GroupBuilder {
  drawable(id: string | number, draw: (ctx: PathRecorder) => void, opts?: DrawableOpts): void;
}

/** Mutable accumulation for one group while building / before buffer assembly. */
class GroupData {
  fillVerts: number[] = [];
  fillIdx: number[] = [];
  strokeVerts: number[] = [];
  strokeIdx: number[] = [];
  ranges: DrawableRange[] = [];
  idToDrawable = new Map<string, number>();
  fillColors: number[] = []; // flat RGBA, 4 per drawable
  strokeColors: number[] = [];
  flags: number[] = [];
  constructor(public readonly tolerance: number) {}
}

export class Scene {
  private groups = new Map<string, GroupData>();

  constructor(private readonly tolerance = 0.25) {}

  /** Build (or rebuild) a named group. The callback registers drawables. */
  group(name: string, build: (g: GroupBuilder) => void): void {
    const data = new GroupData(this.tolerance);
    const builder: GroupBuilder = {
      drawable: (id, draw, opts) => this.addDrawable(data, id, draw, opts),
    };
    build(builder);
    this.groups.set(name, data);
  }

  private addDrawable(
    data: GroupData,
    id: string | number,
    draw: (ctx: PathRecorder) => void,
    opts?: DrawableOpts,
  ): void {
    const recorder = new PathRecorder(data.tolerance);
    draw(recorder);
    const subpaths = recorder.subpaths;
    const drawableId = data.ranges.length;
    data.idToDrawable.set(String(id), drawableId);

    // ---- Fill ----
    const fillVertexOffset = data.fillVerts.length / 3;
    const fillIndexOffset = data.fillIdx.length;
    const closed = subpaths.filter((s) => s.closed && s.points.length >= 6);
    if (closed.length > 0) {
      const rings = groupRings(closed);
      const polygons = rings.map((r) => r.outer);
      const holes = rings.map((r) => r.holes);
      const fg = tessellateFill(polygons, holes);
      const baseVertex = data.fillVerts.length / 3;
      for (let i = 0; i < fg.vertices.length; i += 2) {
        data.fillVerts.push(fg.vertices[i]!, fg.vertices[i + 1]!, drawableId);
      }
      for (const ix of fg.indices) data.fillIdx.push(baseVertex + ix);
    }
    const fillVertexCount = data.fillVerts.length / 3 - fillVertexOffset;
    const fillIndexCount = data.fillIdx.length - fillIndexOffset;

    // ---- Stroke ----
    const strokeVertexOffset = data.strokeVerts.length / 3;
    const strokeIndexOffset = data.strokeIdx.length;
    const lineWidth = opts?.lineWidth ?? 0;
    if (lineWidth > 0) {
      for (const sp of subpaths) {
        const sg = expandStroke(sp, lineWidth);
        const baseVertex = data.strokeVerts.length / 3;
        for (let i = 0; i < sg.vertices.length; i += 2) {
          data.strokeVerts.push(sg.vertices[i]!, sg.vertices[i + 1]!, drawableId);
        }
        for (const ix of sg.indices) data.strokeIdx.push(baseVertex + ix);
      }
    }
    const strokeVertexCount = data.strokeVerts.length / 3 - strokeVertexOffset;
    const strokeIndexCount = data.strokeIdx.length - strokeIndexOffset;

    data.ranges.push({
      fill: {
        vertexOffset: fillVertexOffset,
        vertexCount: fillVertexCount,
        indexOffset: fillIndexOffset,
        indexCount: fillIndexCount,
      },
      stroke: {
        vertexOffset: strokeVertexOffset,
        vertexCount: strokeVertexCount,
        indexOffset: strokeIndexOffset,
        indexCount: strokeIndexCount,
      },
    });
    // Defaults: transparent colors, visible flag (bit 0).
    data.fillColors.push(0, 0, 0, 0);
    data.strokeColors.push(0, 0, 0, 0);
    data.flags.push(1);
  }

  private get(name: string): GroupData {
    const data = this.groups.get(name);
    if (!data) throw new Error(`unknown group: ${name}`);
    return data;
  }

  /** The contiguous buffer slice a drawable occupies. */
  range(name: string, id: string | number): DrawableRange {
    const data = this.get(name);
    const drawableId = data.idToDrawable.get(String(id));
    if (drawableId === undefined) throw new Error(`unknown drawable: ${String(id)}`);
    return data.ranges[drawableId]!;
  }

  /** Assemble GPU-ready typed arrays for a group. */
  buffers(name: string): GroupBuffers {
    const data = this.get(name);
    return {
      fillVertices: new Float32Array(data.fillVerts),
      fillIndices: new Uint32Array(data.fillIdx),
      strokeVertices: new Float32Array(data.strokeVerts),
      strokeIndices: new Uint32Array(data.strokeIdx),
      fillColors: new Uint8Array(data.fillColors),
      strokeColors: new Uint8Array(data.strokeColors),
      flags: new Uint8Array(data.flags),
      drawableCount: data.ranges.length,
    };
  }
}
```

- [ ] **Step 4: Re-export from index.ts**

Replace `packages/core/src/index.ts` with:

```ts
export type { PathContext, Subpath } from "./path-context.js";
export { PathRecorder } from "./path-recorder.js";
export { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";
export { tessellateFill } from "./tessellate.js";
export type { FillGeometry } from "./tessellate.js";
export { signedArea, pointInRing, groupRings } from "./rings.js";
export type { RingGroup } from "./rings.js";
export { expandStroke } from "./stroke.js";
export type { StrokeGeometry } from "./stroke.js";
export { Scene } from "./scene.js";
export type { GroupBuffers, GroupBuilder, DrawableRange, DrawableOpts } from "./scene.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- scene`
Expected: PASS — all scene geometry tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scene.ts packages/core/src/index.ts packages/core/src/__tests__/scene.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(core): add retained Scene model with packed drawable buffers"
```

---

## Task 4: Color & flag side-tables

**Files:**
- Modify: `packages/core/package.json` (add d3-color)
- Modify: `packages/core/src/scene.ts` (add setters)
- Test: `packages/core/src/__tests__/scene.test.ts` (append a describe block)

- [ ] **Step 1: Add the d3-color dependency**

Edit `packages/core/package.json`. Add `"d3-color": "^3.1.0"` to `dependencies` and `"@types/d3-color": "^3.1.3"` to `devDependencies`. The resulting file is:

```json
{
  "name": "@d3gl/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": {
    "earcut": "^3.0.0",
    "d3-color": "^3.1.0"
  },
  "devDependencies": {
    "@types/earcut": "^2.1.4",
    "@types/geojson": "^7946.0.14",
    "@types/d3-color": "^3.1.3",
    "d3-geo": "^3.1.1",
    "d3-shape": "^3.2.0",
    "@types/d3-geo": "^3.1.0",
    "@types/d3-shape": "^3.1.6"
  }
}
```

Run: `corepack pnpm@9 install`
Expected: installs d3-color and @types/d3-color.

- [ ] **Step 2: Write the failing tests**

Append this `describe` block to `packages/core/src/__tests__/scene.test.ts` (keep the existing imports; add `beforeEach`-free standalone tests):

```ts
describe("Scene color & flag tables", () => {
  function twoCells() {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10), { lineWidth: 1 });
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10), { lineWidth: 1 });
    });
    return scene;
  }

  it("setFill writes RGBA into the fill color table by domain id", () => {
    const scene = twoCells();
    scene.setFill("cells", "b", "#ff0000");
    const buf = scene.buffers("cells");
    // drawable "b" is drawableId 1 => bytes at offset 4
    expect(Array.from(buf.fillColors.slice(4, 8))).toEqual([255, 0, 0, 255]);
    // drawable "a" remains the default transparent
    expect(Array.from(buf.fillColors.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it("parses rgb()/named colors and opacity into bytes", () => {
    const scene = twoCells();
    scene.setFill("cells", "a", "rgba(0, 128, 255, 0.5)");
    const buf = scene.buffers("cells");
    const [r, g, b, a] = Array.from(buf.fillColors.slice(0, 4));
    expect([r, g, b]).toEqual([0, 128, 255]);
    expect(a).toBeGreaterThan(120); // ~0.5*255
    expect(a).toBeLessThan(135);
  });

  it("setStroke writes the stroke color table without touching geometry", () => {
    const scene = twoCells();
    const before = scene.buffers("cells");
    const fillBefore = Array.from(before.fillVertices);
    const strokeBefore = Array.from(before.strokeVertices);
    scene.setStroke("cells", "a", "#00ff00");
    const after = scene.buffers("cells");
    expect(Array.from(after.strokeColors.slice(0, 4))).toEqual([0, 255, 0, 255]);
    // geometry buffers are byte-for-byte unchanged by recolor
    expect(Array.from(after.fillVertices)).toEqual(fillBefore);
    expect(Array.from(after.strokeVertices)).toEqual(strokeBefore);
  });

  it("setFlag toggles the per-drawable flag byte", () => {
    const scene = twoCells();
    scene.setFlag("cells", "a", 0); // hide
    const buf = scene.buffers("cells");
    expect(buf.flags[0]).toBe(0);
    expect(buf.flags[1]).toBe(1);
  });

  it("throws when styling an unknown drawable", () => {
    const scene = twoCells();
    expect(() => scene.setFill("cells", "zzz", "#fff")).toThrow(/unknown drawable/i);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- scene`
Expected: FAIL — `scene.setFill is not a function` (setters not implemented yet).

- [ ] **Step 4: Implement the setters**

In `packages/core/src/scene.ts`, add this import at the top (after the existing imports):

```ts
import { rgb } from "d3-color";
```

Then add these methods to the `Scene` class (place them after the `range` method, before `buffers`):

```ts
  /** Resolve a group + domain id to its drawableId, or throw. */
  private drawableIdOf(name: string, id: string | number): { data: GroupData; drawableId: number } {
    const data = this.get(name);
    const drawableId = data.idToDrawable.get(String(id));
    if (drawableId === undefined) throw new Error(`unknown drawable: ${String(id)}`);
    return { data, drawableId };
  }

  /** Set a drawable's fill color (any CSS color string). Hot-swappable. */
  setFill(name: string, id: string | number, color: string): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    writeColor(data.fillColors, drawableId, color);
  }

  /** Set a drawable's stroke color (any CSS color string). Hot-swappable. */
  setStroke(name: string, id: string | number, color: string): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    writeColor(data.strokeColors, drawableId, color);
  }

  /** Set a drawable's flag byte (e.g. bit 0 = visible). Hot-swappable. */
  setFlag(name: string, id: string | number, flags: number): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    data.flags[drawableId] = flags & 0xff;
  }
```

And add this module-level helper at the bottom of the file (after the `Scene` class):

```ts
/** Parse a CSS color string into RGBA bytes and write it at drawableId. */
function writeColor(table: number[], drawableId: number, color: string): void {
  const c = rgb(color);
  const r = Number.isNaN(c.r) ? 0 : Math.round(c.r);
  const g = Number.isNaN(c.g) ? 0 : Math.round(c.g);
  const b = Number.isNaN(c.b) ? 0 : Math.round(c.b);
  const a = Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255);
  const off = drawableId * 4;
  table[off] = r;
  table[off + 1] = g;
  table[off + 2] = b;
  table[off + 3] = a;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- scene`
Expected: PASS — geometry and color/flag tests all green.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `corepack pnpm@9 test`
Expected: all suites pass.
Run: `corepack pnpm@9 -r exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json packages/core/src/scene.ts packages/core/src/__tests__/scene.test.ts pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(core): add hot-swappable color/flag side-tables to Scene"
```

---

## Task 5: Scene conformance — real geoPath grid cells, recolor stability

**Files:**
- Test: `packages/core/src/__tests__/scene-conformance.test.ts`

- [ ] **Step 1: Write the conformance test**

Create `packages/core/src/__tests__/scene-conformance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { geoPath, geoEquirectangular } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { Scene } from "../scene.js";

/** A tiny grid of square cells, each a GeoJSON polygon with a `value`. */
function gridCells(cols: number, rows: number) {
  const cells: { id: string; value: number; geometry: GeoJSON.Polygon }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -180 + (c * 360) / cols;
      const y = -90 + (r * 180) / rows;
      const w = 360 / cols;
      const h = 180 / rows;
      cells.push({
        id: `${c}-${r}`,
        value: Math.random(),
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x, y],
              [x + w, y],
              [x + w, y + h],
              [x, y + h],
              [x, y],
            ],
          ],
        },
      });
    }
  }
  return cells;
}

describe("Scene conformance with d3-geo", () => {
  it("builds a grid-cell scene from geoPath and packs fill+stroke buffers", () => {
    const cells = gridCells(6, 4); // 24 cells
    const projection = geoEquirectangular();
    const scene = new Scene();
    scene.group("cells", (g) => {
      for (const cell of cells) {
        // geoPath draws INTO the per-drawable recorder context.
        g.drawable(
          cell.id,
          (ctx) => {
            const path = geoPath(projection, ctx);
            path(cell.geometry);
          },
          { lineWidth: 0.5 },
        );
      }
    });
    const buf = scene.buffers("cells");
    expect(buf.drawableCount).toBe(24);
    expect(buf.fillIndices.length).toBeGreaterThanOrEqual(24 * 6); // >=2 triangles/cell
    expect(buf.strokeIndices.length).toBeGreaterThan(0);
    // every fill vertex carries a valid drawableId in [0, 24)
    for (let i = 0; i < buf.fillVertices.length; i += 3) {
      const id = buf.fillVertices[i + 2]!;
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(24);
    }
  });

  it("recoloring with a d3 color scale changes only the color table, not geometry", () => {
    const cells = gridCells(6, 4);
    const projection = geoEquirectangular();
    const scene = new Scene();
    scene.group("cells", (g) => {
      for (const cell of cells) {
        g.drawable(cell.id, (ctx) => geoPath(projection, ctx)(cell.geometry), { lineWidth: 0.5 });
      }
    });

    const geomBefore = Array.from(scene.buffers("cells").fillVertices);

    // Heatmap recolor.
    const color = scaleSequential(interpolateViridis).domain([0, 1]);
    for (const cell of cells) scene.setFill("cells", cell.id, color(cell.value));

    const after = scene.buffers("cells");
    // Geometry byte-for-byte identical after recolor.
    expect(Array.from(after.fillVertices)).toEqual(geomBefore);
    // Color table now has non-transparent entries.
    let nonTransparent = 0;
    for (let i = 0; i < after.fillColors.length; i += 4) {
      if (after.fillColors[i + 3]! > 0) nonTransparent++;
    }
    expect(nonTransparent).toBe(24);
  });
});
```

- [ ] **Step 2: Add the d3-scale test dependencies**

Edit `packages/core/package.json` to add to `devDependencies`: `"d3-scale": "^4.0.2"`, `"d3-scale-chromatic": "^3.1.0"`, `"@types/d3-scale": "^4.0.8"`, `"@types/d3-scale-chromatic": "^3.0.3"`.

Run: `corepack pnpm@9 install`
Expected: installs the d3-scale packages.

- [ ] **Step 3: Run the conformance test**

Run: `corepack pnpm@9 test -- scene-conformance`
Expected: PASS (2 tests).

- [ ] **Step 4: Run the full suite and typecheck**

Run: `corepack pnpm@9 test`
Expected: all suites pass (flatten, path-recorder, tessellate, rings, stroke, scene, scene-conformance, canvas-context, d3-conformance).
Run: `corepack pnpm@9 -r exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/src/__tests__/scene-conformance.test.ts pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "test(core): verify geoPath grid-cell scene build and recolor stability"
```

---

## Self-Review

**Spec coverage (this plan's slice of the design doc):**
- Stroke expansion (segments→triangles with joins) → Task 2. ✓
- Ring grouping into outer+holes (the limitation flagged at the end of Plan 1) → Task 1. ✓
- Scene/drawable model → Task 3. ✓
- Per-vertex `drawableId` → Task 3 (fill + stroke vertices tagged). ✓
- `geometryIndex` ranges (per-drawable contiguous slices) → Task 3 (`DrawableRange`, `range()`). ✓
- Color/flag side-tables, recolor = single table write, geometry untouched → Task 4 + verified in Task 5. ✓
- d3 color scale fidelity on CPU → Task 4 (d3-color parse) + Task 5 (d3-scale heatmap). ✓
- "Geometry built once; recolor never re-tessellates" thesis → Task 5 asserts byte-identical geometry after recolor. ✓

**Deferred to later plans (intentional, in Scope boundary):** luma.gl device/buffers/shaders, transform-uniform pan/zoom, MSAA/SDF AA, GPU color-picking (Plan 3); project-once + d3-zoom + quadtree + globe (Plan 4); labels + React + bioregions example + perf CI gate (Plan 5). Round/square caps, miter joins, and nested-island ring topology are documented deferrals.

**Placeholder scan:** No TBD/TODO; all test and implementation code is complete and concrete.

**Type consistency:** `Subpath` (Plan 1) consumed unchanged by `groupRings`, `expandStroke`, and `Scene`. `RingGroup {outer, holes}` (Task 1) consumed by `Scene.addDrawable` (Task 3). `tessellateFill(polygons, holes)` (Plan 1) called with `rings.map(r=>r.outer)` / `rings.map(r=>r.holes)` (Task 3) — matches the `(Subpath[], Subpath[][])` signature. `DrawableRange`, `GroupBuffers`, `GroupBuilder`, `DrawableOpts` defined in Task 3 and used consistently in Task 4/5. `writeColor(table, drawableId, color)` (Task 4) called by `setFill`/`setStroke` with matching args. Vertex stride is 3 (`x,y,drawableId`) consistently across fill and stroke in Task 3 and asserted in Tasks 3/5.

---

## Next plans

- **Plan 3 — luma.gl WebGL backend (`@d3gl/webgl`):** `Device`/`Buffer`/`Model` from the `GroupBuffers`; vertex shader applies a `mat3` transform uniform; fragment shader reads color via `drawableId` and the visible/faded flag; MSAA + SDF stroke AA; GPU color-picking pass; browser-mode (Playwright) render + recolor tests.
- **Plan 4 — Geo + export (`@d3gl/svg`, `@d3gl/geo`):** SVG path-string backend; project-once with any d3-geo projection; d3-zoom→transform-uniform; quadtree hit-testing; orthographic globe mode (a); PNG/SVG export.
- **Plan 5 — Product (`@d3gl/labels`, `@d3gl/react`):** HTML LabelLayer with culling; `<D3GL>`/`<Layer>`/`<Tooltip>`; bioregions map example; performance-budget CI gate.
