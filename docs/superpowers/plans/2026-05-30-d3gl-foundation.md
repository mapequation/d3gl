# d3gl Foundation Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the d3gl pnpm monorepo and build the framework-agnostic core — a `PathContext` drawing interface, a path recorder that flattens curves into polylines, polygon fill tessellation, and a Canvas2D passthrough backend — proving that unmodified d3 generators (`geoPath`, `d3-shape`) can drive the d3gl context.

**Architecture:** `@d3gl/core` defines the `PathContext` interface (the subset of `CanvasRenderingContext2D` that d3 calls) plus a `PathRecorder` that captures subpaths as flattened polylines and a tessellator that triangulates filled subpaths via earcut. `@d3gl/canvas` is a thin passthrough that forwards `PathContext` calls to a real `CanvasRenderingContext2D`. The recorder + tessellator are the pure-logic foundation the WebGL backend (Plan 2) will consume; everything in this plan runs and tests in Node with no GPU or browser.

**Tech Stack:** TypeScript (strict), pnpm workspaces, Vitest, earcut, d3-geo/d3-shape (peer, used in tests).

**Scope boundary:** Stroke expansion (line→triangles), the scene/drawable model, color/flag tables, and the luma.gl WebGL backend are **Plan 2**. This plan stops at: interface + recorder + curve flattening + fill tessellation + canvas passthrough + a d3 conformance test.

---

## File Structure

```
d3gl/
├─ package.json                      # root, private, workspace scripts
├─ pnpm-workspace.yaml
├─ tsconfig.base.json                # shared compiler options
├─ vitest.config.ts                  # root test config
├─ packages/
│  ├─ core/
│  │  ├─ package.json                # @d3gl/core
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts                 # public exports
│  │     ├─ path-context.ts          # PathContext interface + types
│  │     ├─ flatten.ts               # cubic/quadratic/arc flattening
│  │     ├─ path-recorder.ts         # PathRecorder implements PathContext
│  │     ├─ tessellate.ts            # tessellateFill (earcut)
│  │     └─ __tests__/
│  │        ├─ flatten.test.ts
│  │        ├─ path-recorder.test.ts
│  │        ├─ tessellate.test.ts
│  │        └─ d3-conformance.test.ts
│  └─ canvas/
│     ├─ package.json                # @d3gl/canvas
│     ├─ tsconfig.json
│     └─ src/
│        ├─ index.ts
│        ├─ canvas-context.ts        # CanvasContext implements PathContext
│        └─ __tests__/
│           └─ canvas-context.test.ts
```

---

## Task 1: Monorepo scaffold and tooling

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create the workspace manifest**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create the root package.json**

Create `package.json`:

```json
{
  "name": "d3gl-monorepo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create the shared TypeScript config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 4: Create the root Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Create .gitignore**

Create `.gitignore`:

```
node_modules
dist
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 6: Install and verify the toolchain**

Run: `pnpm install`
Expected: completes, creates `node_modules` and `pnpm-lock.yaml`.

Run: `pnpm test`
Expected: Vitest reports "No test files found" (exit 0) — no packages yet. This confirms the runner works.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold d3gl pnpm monorepo with vitest"
```

---

## Task 2: @d3gl/core package + PathContext interface

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/path-context.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create the core package manifest**

Create `packages/core/package.json`:

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
    "earcut": "^3.0.0"
  },
  "devDependencies": {
    "@types/earcut": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create the core tsconfig**

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Define the PathContext interface**

Create `packages/core/src/path-context.ts`:

```ts
/**
 * PathContext is the seam of d3gl: the subset of CanvasRenderingContext2D's
 * path API that d3 path-emitting generators (d3-geo geoPath, d3-shape, d3-chord,
 * d3-hierarchy links) actually call. Implement this once per backend and any of
 * those generators can render to that backend unchanged.
 *
 * The signatures intentionally match CanvasRenderingContext2D so a real 2D
 * context satisfies this interface structurally.
 */
export interface PathContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
}

/** A flattened subpath: a polyline plus whether it was closed. */
export interface Subpath {
  /** Interleaved x,y coordinates: [x0, y0, x1, y1, ...]. */
  points: number[];
  closed: boolean;
}
```

- [ ] **Step 4: Create the public index**

Create `packages/core/src/index.ts`:

```ts
export type { PathContext, Subpath } from "./path-context.js";
```

- [ ] **Step 5: Install the new dependency**

Run: `pnpm install`
Expected: installs `earcut` and `@types/earcut` into `@d3gl/core`.

- [ ] **Step 6: Typecheck the package**

Run: `pnpm --filter @d3gl/core exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): add PathContext interface and Subpath type"
```

---

## Task 3: Curve flattening

**Files:**
- Create: `packages/core/src/flatten.ts`
- Test: `packages/core/src/__tests__/flatten.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/flatten.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { flattenCubic, flattenQuadratic, flattenArc } from "../flatten.js";

describe("flattenCubic", () => {
  it("collapses a straight (collinear) curve to just the endpoint", () => {
    // p0..p3 all on the x-axis => already flat
    const out: number[] = [];
    flattenCubic(0, 0, 1, 0, 2, 0, 3, 0, 0.1, out);
    expect(out).toEqual([3, 0]);
  });

  it("subdivides a genuinely curved segment into multiple points", () => {
    const out: number[] = [];
    flattenCubic(0, 0, 0, 10, 10, 10, 10, 0, 0.01, out);
    expect(out.length / 2).toBeGreaterThan(2);
    // last point is the curve endpoint
    expect(out.slice(-2)).toEqual([10, 0]);
  });

  it("produces more points at a tighter tolerance", () => {
    const coarse: number[] = [];
    const fine: number[] = [];
    flattenCubic(0, 0, 0, 10, 10, 10, 10, 0, 1, coarse);
    flattenCubic(0, 0, 0, 10, 10, 10, 10, 0, 0.001, fine);
    expect(fine.length).toBeGreaterThan(coarse.length);
  });
});

describe("flattenQuadratic", () => {
  it("collapses a straight quadratic to just the endpoint", () => {
    const out: number[] = [];
    flattenQuadratic(0, 0, 1, 0, 2, 0, 0.1, out);
    expect(out).toEqual([2, 0]);
  });

  it("subdivides a curved quadratic", () => {
    const out: number[] = [];
    flattenQuadratic(0, 0, 5, 10, 10, 0, 0.01, out);
    expect(out.length / 2).toBeGreaterThan(2);
    expect(out.slice(-2)).toEqual([10, 0]);
  });
});

describe("flattenArc", () => {
  it("emits the endpoint of a quarter circle", () => {
    const out: number[] = [];
    // centre (0,0), r=1, from angle 0 to PI/2 CCW
    flattenArc(0, 0, 1, 0, Math.PI / 2, false, 0.001, out);
    const lastX = out[out.length - 2]!;
    const lastY = out[out.length - 1]!;
    expect(lastX).toBeCloseTo(0, 5);
    expect(lastY).toBeCloseTo(1, 5);
  });

  it("emits intermediate points along the arc", () => {
    const out: number[] = [];
    flattenArc(0, 0, 10, 0, Math.PI, false, 0.01, out);
    expect(out.length / 2).toBeGreaterThan(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- flatten`
Expected: FAIL — "Failed to resolve import ../flatten.js" / module not found.

- [ ] **Step 3: Implement the flattening functions**

Create `packages/core/src/flatten.ts`:

```ts
/**
 * Curve flattening: convert beziers and arcs into line segments so they can be
 * tessellated. Each function APPENDS interleaved x,y coordinates to `out`,
 * EXCLUDING the start point (the caller already has the current point) and
 * INCLUDING the end point.
 *
 * `tolerance` is the maximum allowed deviation (in coordinate units) between the
 * true curve and the polyline. Smaller => more segments.
 */

const MAX_DEPTH = 32;

/** Cubic bezier from (x0,y0) to (x3,y3) with control points (x1,y1),(x2,y2). */
export function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolerance: number,
  out: number[],
): void {
  const tolSq = tolerance * tolerance;
  recurseCubic(x0, y0, x1, y1, x2, y2, x3, y3, tolSq, 0, out);
  out.push(x3, y3);
}

function recurseCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolSq: number,
  depth: number,
  out: number[],
): void {
  // Distance of control points from the chord (x0,y0)->(x3,y3).
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const chordSq = dx * dx + dy * dy;
  if (depth >= MAX_DEPTH || (d1 + d2) * (d1 + d2) <= tolSq * chordSq) {
    return; // flat enough; caller pushes the endpoint
  }
  // de Casteljau subdivision at t=0.5
  const x01 = (x0 + x1) / 2;
  const y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2;
  const y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2;
  const y23 = (y2 + y3) / 2;
  const x012 = (x01 + x12) / 2;
  const y012 = (y01 + y12) / 2;
  const x123 = (x12 + x23) / 2;
  const y123 = (y12 + y23) / 2;
  const xm = (x012 + x123) / 2;
  const ym = (y012 + y123) / 2;
  recurseCubic(x0, y0, x01, y01, x012, y012, xm, ym, tolSq, depth + 1, out);
  out.push(xm, ym);
  recurseCubic(xm, ym, x123, y123, x23, y23, x3, y3, tolSq, depth + 1, out);
}

/** Quadratic bezier: elevate to cubic and reuse the cubic flattener. */
export function flattenQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  tolerance: number,
  out: number[],
): void {
  // Degree elevation: cubic control points from a quadratic.
  const c1x = x0 + (2 / 3) * (cx - x0);
  const c1y = y0 + (2 / 3) * (cy - y0);
  const c2x = x1 + (2 / 3) * (cx - x1);
  const c2y = y1 + (2 / 3) * (cy - y1);
  flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, tolerance, out);
}

/** Circular arc, matching CanvasRenderingContext2D.arc semantics. */
export function flattenArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  counterclockwise: boolean,
  tolerance: number,
  out: number[],
): void {
  let delta = endAngle - startAngle;
  if (!counterclockwise && delta < 0) {
    delta += Math.PI * 2;
  } else if (counterclockwise && delta > 0) {
    delta -= Math.PI * 2;
  }
  // Max angular step that keeps sagitta within tolerance: 2*acos(1 - tol/r).
  const ratio = r > 0 ? Math.max(0, 1 - tolerance / r) : 0;
  const maxStep = 2 * Math.acos(Math.min(1, ratio)) || Math.PI / 8;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / maxStep));
  for (let i = 1; i <= steps; i++) {
    const a = startAngle + (delta * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- flatten`
Expected: PASS — all flatten tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/flatten.ts packages/core/src/__tests__/flatten.test.ts
git commit -m "feat(core): add cubic/quadratic/arc curve flattening"
```

---

## Task 4: PathRecorder — capture subpaths from PathContext calls

**Files:**
- Create: `packages/core/src/path-recorder.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/path-recorder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/path-recorder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PathRecorder } from "../path-recorder.js";

describe("PathRecorder", () => {
  it("records a single open polyline", () => {
    const r = new PathRecorder();
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.lineTo(10, 10);
    const paths = r.subpaths;
    expect(paths).toHaveLength(1);
    expect(paths[0]!.points).toEqual([0, 0, 10, 0, 10, 10]);
    expect(paths[0]!.closed).toBe(false);
  });

  it("marks a subpath closed on closePath()", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.lineTo(10, 10);
    r.closePath();
    expect(r.subpaths[0]!.closed).toBe(true);
  });

  it("starts a new subpath on each moveTo", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.lineTo(1, 1);
    r.moveTo(5, 5);
    r.lineTo(6, 6);
    expect(r.subpaths).toHaveLength(2);
    expect(r.subpaths[1]!.points).toEqual([5, 5, 6, 6]);
  });

  it("beginPath() clears previously recorded subpaths", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.lineTo(1, 1);
    r.beginPath();
    r.moveTo(2, 2);
    r.lineTo(3, 3);
    expect(r.subpaths).toHaveLength(1);
    expect(r.subpaths[0]!.points).toEqual([2, 2, 3, 3]);
  });

  it("flattens bezierCurveTo into multiple points ending at the endpoint", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.bezierCurveTo(0, 10, 10, 10, 10, 0);
    const pts = r.subpaths[0]!.points;
    expect(pts.length / 2).toBeGreaterThan(2);
    expect(pts.slice(-2)).toEqual([10, 0]);
  });

  it("expands rect() into a closed 4-corner subpath", () => {
    const r = new PathRecorder();
    r.rect(0, 0, 10, 20);
    const sp = r.subpaths[0]!;
    expect(sp.closed).toBe(true);
    expect(sp.points).toEqual([0, 0, 10, 0, 10, 20, 0, 20]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- path-recorder`
Expected: FAIL — cannot resolve `../path-recorder.js`.

- [ ] **Step 3: Implement PathRecorder**

Create `packages/core/src/path-recorder.ts`:

```ts
import type { PathContext, Subpath } from "./path-context.js";
import { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";

/**
 * Records PathContext drawing calls into flattened polylines (subpaths).
 * This is the retained-mode capture used by GPU backends: call a d3 generator
 * into a PathRecorder once, then hand the subpaths to the tessellator.
 */
export class PathRecorder implements PathContext {
  private paths: Subpath[] = [];
  private current: Subpath | null = null;
  private cx = 0;
  private cy = 0;

  /** Flattening tolerance in coordinate units. */
  constructor(public tolerance = 0.25) {}

  get subpaths(): readonly Subpath[] {
    return this.paths;
  }

  beginPath(): void {
    this.paths = [];
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    this.current = { points: [x, y], closed: false };
    this.paths.push(this.current);
    this.cx = x;
    this.cy = y;
  }

  lineTo(x: number, y: number): void {
    if (!this.current) {
      this.moveTo(x, y);
      return;
    }
    this.current.points.push(x, y);
    this.cx = x;
    this.cy = y;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!this.current) this.moveTo(this.cx, this.cy);
    flattenQuadratic(this.cx, this.cy, cpx, cpy, x, y, this.tolerance, this.current!.points);
    this.cx = x;
    this.cy = y;
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    if (!this.current) this.moveTo(this.cx, this.cy);
    flattenCubic(this.cx, this.cy, cp1x, cp1y, cp2x, cp2y, x, y, this.tolerance, this.current!.points);
    this.cx = x;
    this.cy = y;
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (!this.current) {
      this.moveTo(sx, sy);
    } else {
      this.current.points.push(sx, sy);
    }
    flattenArc(x, y, radius, startAngle, endAngle, counterclockwise, this.tolerance, this.current!.points);
    const len = this.current!.points.length;
    this.cx = this.current!.points[len - 2]!;
    this.cy = this.current!.points[len - 1]!;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    // Minimal arcTo: approximate by a line to the tangent corner. d3 generators
    // rarely emit arcTo; full tangent-arc support is deferred until a consumer needs it.
    this.lineTo(x1, y1);
    this.lineTo(x2, y2);
    void radius;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.current = { points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true };
    this.paths.push(this.current);
    this.cx = x;
    this.cy = y;
  }

  closePath(): void {
    if (this.current) this.current.closed = true;
  }
}
```

- [ ] **Step 4: Export PathRecorder**

Replace `packages/core/src/index.ts` with:

```ts
export type { PathContext, Subpath } from "./path-context.js";
export { PathRecorder } from "./path-recorder.js";
export { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- path-recorder`
Expected: PASS — all PathRecorder tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/path-recorder.ts packages/core/src/index.ts packages/core/src/__tests__/path-recorder.test.ts
git commit -m "feat(core): add PathRecorder that captures subpaths and flattens curves"
```

---

## Task 5: Fill tessellation via earcut

**Files:**
- Create: `packages/core/src/tessellate.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/tessellate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/tessellate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tessellateFill } from "../tessellate.js";
import type { Subpath } from "../path-context.js";

function square(): Subpath {
  return { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
}

describe("tessellateFill", () => {
  it("triangulates a square into 2 triangles (6 indices, 4 vertices)", () => {
    const { vertices, indices } = tessellateFill([square()]);
    expect(vertices).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(indices.length).toBe(6);
    // every index references a real vertex
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("treats a polygon with a hole as outer ring + hole ring", () => {
    const outer: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const hole: Subpath = { points: [3, 3, 7, 3, 7, 7, 3, 7], closed: true };
    // Holes are signalled by winding; tessellateFill takes (outer, holes[]).
    const { indices } = tessellateFill([outer], [[hole]]);
    // A square-with-square-hole triangulates into 8 triangles = 24 indices.
    expect(indices.length).toBe(24);
  });

  it("offsets indices when given multiple independent polygons", () => {
    const a = square();
    const b: Subpath = { points: [20, 20, 30, 20, 30, 30, 20, 30], closed: true };
    const { vertices, indices } = tessellateFill([a, b]);
    expect(vertices.length / 2).toBe(8);
    // second polygon's indices must reference vertices 4..7
    expect(Math.max(...indices)).toBe(7);
  });

  it("ignores open subpaths (a fill needs a closed ring)", () => {
    const open: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { indices } = tessellateFill([open]);
    expect(indices.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tessellate`
Expected: FAIL — cannot resolve `../tessellate.js`.

- [ ] **Step 3: Implement tessellateFill**

Create `packages/core/src/tessellate.ts`:

```ts
import earcut from "earcut";
import type { Subpath } from "./path-context.js";

export interface FillGeometry {
  /** Interleaved x,y vertex coordinates. */
  vertices: number[];
  /** Triangle indices into `vertices` (3 per triangle). */
  indices: number[];
}

/**
 * Triangulate filled (closed) subpaths into triangles via earcut.
 *
 * Each entry in `polygons` is one outer ring (a closed Subpath). The matching
 * entry in `holes` (optional) is a list of hole rings for that polygon. Open
 * subpaths are skipped — a fill requires a closed ring.
 *
 * Vertices from every polygon are concatenated into one flat buffer and indices
 * are offset accordingly, so the result is one combined mesh ready for a single
 * draw call.
 */
export function tessellateFill(
  polygons: readonly Subpath[],
  holes: ReadonlyArray<readonly Subpath[]> = [],
): FillGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let p = 0; p < polygons.length; p++) {
    const outer = polygons[p]!;
    if (!outer.closed || outer.points.length < 6) continue;

    const baseVertex = vertices.length / 2;
    const flat: number[] = [...outer.points];
    const holeIndices: number[] = [];

    const polyHoles = holes[p] ?? [];
    for (const hole of polyHoles) {
      if (!hole.closed || hole.points.length < 6) continue;
      holeIndices.push(flat.length / 2);
      flat.push(...hole.points);
    }

    const tri = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
    for (const i of tri) indices.push(baseVertex + i);
    vertices.push(...flat);
  }

  return { vertices, indices };
}
```

- [ ] **Step 4: Export tessellateFill**

Replace `packages/core/src/index.ts` with:

```ts
export type { PathContext, Subpath } from "./path-context.js";
export { PathRecorder } from "./path-recorder.js";
export { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";
export { tessellateFill } from "./tessellate.js";
export type { FillGeometry } from "./tessellate.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- tessellate`
Expected: PASS — all tessellate tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tessellate.ts packages/core/src/index.ts packages/core/src/__tests__/tessellate.test.ts
git commit -m "feat(core): add fill tessellation via earcut"
```

---

## Task 6: @d3gl/canvas passthrough backend

**Files:**
- Create: `packages/canvas/package.json`
- Create: `packages/canvas/tsconfig.json`
- Create: `packages/canvas/src/canvas-context.ts`
- Create: `packages/canvas/src/index.ts`
- Test: `packages/canvas/src/__tests__/canvas-context.test.ts`

- [ ] **Step 1: Create the canvas package manifest**

Create `packages/canvas/package.json`:

```json
{
  "name": "@d3gl/canvas",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": {
    "@d3gl/core": "workspace:*"
  }
}
```

- [ ] **Step 2: Create the canvas tsconfig**

Create `packages/canvas/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/canvas/src/__tests__/canvas-context.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CanvasContext } from "../canvas-context.js";

/** A fake 2D context that records the calls made to it. */
function fakeCtx() {
  return {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    arcTo: vi.fn(),
    rect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
}

describe("CanvasContext", () => {
  it("forwards path calls to the underlying 2D context", () => {
    const raw = fakeCtx();
    const ctx = new CanvasContext(raw as unknown as CanvasRenderingContext2D);
    ctx.beginPath();
    ctx.moveTo(1, 2);
    ctx.lineTo(3, 4);
    ctx.closePath();
    expect(raw.beginPath).toHaveBeenCalledOnce();
    expect(raw.moveTo).toHaveBeenCalledWith(1, 2);
    expect(raw.lineTo).toHaveBeenCalledWith(3, 4);
    expect(raw.closePath).toHaveBeenCalledOnce();
  });

  it("fill(style) sets fillStyle then calls fill()", () => {
    const raw = fakeCtx();
    const ctx = new CanvasContext(raw as unknown as CanvasRenderingContext2D);
    ctx.fill("#ff0000");
    expect(raw.fillStyle).toBe("#ff0000");
    expect(raw.fill).toHaveBeenCalledOnce();
  });

  it("stroke(style, width) sets strokeStyle and lineWidth then strokes", () => {
    const raw = fakeCtx();
    const ctx = new CanvasContext(raw as unknown as CanvasRenderingContext2D);
    ctx.stroke("#00ff00", 2.5);
    expect(raw.strokeStyle).toBe("#00ff00");
    expect(raw.lineWidth).toBe(2.5);
    expect(raw.stroke).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test -- canvas-context`
Expected: FAIL — cannot resolve `../canvas-context.js`.

- [ ] **Step 5: Implement CanvasContext**

Create `packages/canvas/src/canvas-context.ts`:

```ts
import type { PathContext } from "@d3gl/core";

/**
 * Immediate-mode backend: forwards PathContext calls straight to a real
 * CanvasRenderingContext2D. This is the publication/fallback path and behaves
 * exactly like drawing with d3 to a canvas today. fill()/stroke() take a style
 * so callers don't poke 2D-context properties directly.
 */
export class CanvasContext implements PathContext {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  beginPath(): void {
    this.ctx.beginPath();
  }
  moveTo(x: number, y: number): void {
    this.ctx.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.ctx.lineTo(x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.ctx.quadraticCurveTo(cpx, cpy, x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.ctx.arcTo(x1, y1, x2, y2, radius);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ctx.rect(x, y, w, h);
  }
  closePath(): void {
    this.ctx.closePath();
  }

  /** Fill the current path with the given style. */
  fill(style: string): void {
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }

  /** Stroke the current path with the given style and width. */
  stroke(style: string, width = 1): void {
    this.ctx.strokeStyle = style;
    this.ctx.lineWidth = width;
    this.ctx.stroke();
  }
}
```

- [ ] **Step 6: Create the canvas index**

Create `packages/canvas/src/index.ts`:

```ts
export { CanvasContext } from "./canvas-context.js";
```

- [ ] **Step 7: Install workspace link and run tests**

Run: `pnpm install`
Expected: links `@d3gl/core` into `@d3gl/canvas`.

Run: `pnpm test -- canvas-context`
Expected: PASS — all CanvasContext tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/canvas pnpm-lock.yaml
git commit -m "feat(canvas): add Canvas2D passthrough PathContext backend"
```

---

## Task 7: d3 conformance test — real generators drive the recorder

**Files:**
- Modify: `packages/core/package.json` (add d3 test deps)
- Test: `packages/core/src/__tests__/d3-conformance.test.ts`

- [ ] **Step 1: Add d3 dev dependencies to core**

Edit `packages/core/package.json` to add a `devDependencies` block (keep the existing `dependencies` and `devDependencies.@types/earcut`):

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
    "earcut": "^3.0.0"
  },
  "devDependencies": {
    "@types/earcut": "^2.1.4",
    "d3-geo": "^3.1.1",
    "d3-shape": "^3.2.0",
    "@types/d3-geo": "^3.1.0",
    "@types/d3-shape": "^3.1.6"
  }
}
```

Run: `pnpm install`
Expected: installs the d3 test deps.

- [ ] **Step 2: Write the conformance test**

Create `packages/core/src/__tests__/d3-conformance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { geoPath, geoEquirectangular } from "d3-geo";
import { arc as d3arc } from "d3-shape";
import { PathRecorder } from "../path-recorder.js";
import { tessellateFill } from "../tessellate.js";

describe("d3 conformance", () => {
  it("d3-geo geoPath drives the PathRecorder for a polygon feature", () => {
    const recorder = new PathRecorder();
    const projection = geoEquirectangular();
    // geoPath calls moveTo/lineTo/closePath on the context we pass.
    const path = geoPath(projection, recorder);

    const square: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    };
    recorder.beginPath();
    path(square);

    expect(recorder.subpaths.length).toBeGreaterThanOrEqual(1);
    const sp = recorder.subpaths[0]!;
    expect(sp.closed).toBe(true);
    // The recorded ring tessellates into at least 2 triangles.
    const { indices } = tessellateFill([sp]);
    expect(indices.length).toBeGreaterThanOrEqual(6);
  });

  it("d3-shape arc generator drives the recorder and flattens its curves", () => {
    const recorder = new PathRecorder();
    const generator = d3arc().innerRadius(0).outerRadius(100);
    recorder.beginPath();
    generator.context(recorder)({
      startAngle: 0,
      endAngle: Math.PI / 2,
      innerRadius: 0,
      outerRadius: 100,
    });
    expect(recorder.subpaths.length).toBeGreaterThanOrEqual(1);
    const sp = recorder.subpaths[0]!;
    // A 90-degree wedge flattens into many points.
    expect(sp.points.length / 2).toBeGreaterThan(4);
  });
});
```

- [ ] **Step 3: Run the conformance tests**

Run: `pnpm test -- d3-conformance`
Expected: PASS — confirms unmodified d3-geo and d3-shape generators render through the d3gl `PathContext`.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS — all suites across `@d3gl/core` and `@d3gl/canvas` green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/src/__tests__/d3-conformance.test.ts pnpm-lock.yaml
git commit -m "test(core): verify d3-geo and d3-shape drive the PathContext"
```

---

## Self-Review

**Spec coverage (this plan's slice):**
- Path Context interface (subset of CanvasRenderingContext2D d3 calls) → Task 2. ✓
- Immediate-mode Canvas2D backend → Task 6. ✓
- Curve flattening (beziers/arcs → segments) → Task 3, wired in Task 4. ✓
- Recording into drawables/subpaths (the retained-mode capture foundation) → Task 4. ✓
- Fill tessellation via earcut → Task 5. ✓
- "d3 generators drive it unchanged" goal → Task 7 conformance. ✓
- Monorepo + Vitest (test infra from the spec's testing section) → Task 1. ✓

**Deferred to later plans (intentionally, noted in Scope boundary):** stroke expansion, scene/drawable model with color/flag tables and buffer ranges, luma.gl WebGL backend, SVG backend, geo specialization, labels, React, bioregions example, perf-budget CI gate. These are Plans 2–4.

**Placeholder scan:** No TBD/TODO. `arcTo` has a documented minimal implementation (line approximation) rather than a placeholder — acceptable because no d3 generator in scope emits `arcTo`; full support is explicitly deferred to when a consumer needs it.

**Type consistency:** `PathContext` method signatures match `CanvasRenderingContext2D` and are used identically in `PathRecorder` (Task 4) and `CanvasContext` (Task 6). `Subpath` (`{points: number[]; closed: boolean}`) defined in Task 2 and consumed unchanged in Tasks 4, 5, 7. `tessellateFill(polygons, holes?)` defined in Task 5 with the same signature used in its tests and Task 7. `flattenCubic/Quadratic/Arc` signatures defined in Task 3 match their calls in Task 4.

---

## Next plans

- **Plan 2 — GPU core (`@d3gl/webgl`):** stroke expansion (segments→triangles with joins), scene/drawable model, per-vertex `drawableId`, color/flag side-tables, `geometryIndex` ranges, luma.gl device/buffers/shaders, transform-uniform pan/zoom, recolor hot path, MSAA + SDF stroke AA, GPU color-picking.
- **Plan 3 — Geo + export (`@d3gl/svg`, `@d3gl/geo`):** SVG path-string backend, project-once with any d3-geo projection, d3-zoom→transform-uniform, quadtree hit-testing, orthographic globe mode (a), PNG/SVG export.
- **Plan 4 — Product (`@d3gl/labels`, `@d3gl/react`):** HTML LabelLayer with culling, `<D3GL>`/`<Layer>`/`<Tooltip>` React wrapper, bioregions map example, performance-budget CI gate.
