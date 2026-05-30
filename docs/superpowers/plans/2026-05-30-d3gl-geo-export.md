# d3gl Geo + Export Implementation Plan (Plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire d3gl to real maps: project any GeoJSON **once** with any d3-geo projection into a `Scene` group (the GPU renders it via Plan 3), convert screen coordinates back to lon/lat for tooltips, expose GPU picking + PNG export, and add an SVG path-string backend for publication-quality vector export.

**Architecture:** Two new packages plus two helpers on the existing GPU package.
- `@d3gl/svg` (Node): `SvgPathContext implements PathContext` builds an SVG path `d` string; `svgDocument()` assembles styled `<path>`s into an `<svg>` document. This is the export path — it re-runs the d3 generator to keep crisp vectors (the GPU tessellation is for screen, not print).
- `@d3gl/geo` (Node): `fitProjection()` (fit any d3 projection to the viewport), `featureGroup()` (a `Scene.group` builder that runs `geoPath` per feature — project-once), and inverse helpers `referenceFromScreen()` / `lonLatFromScreen()` for tooltips and `viewTransform()` to turn a d3-zoom transform into a `clipFromView` matrix.
- `@d3gl/webgl` additions (browser): `pickAt()` (offscreen pick render + 1px readback + decode → drawableId) and `toPNG()` (full readback → PNG data URL).

**Tech Stack:** TypeScript, Vitest (Node) for `@d3gl/svg` + `@d3gl/geo` pure logic; Vitest browser mode (Playwright Chromium WebGL2) for the `@d3gl/webgl` export/pick helpers. `d3-geo` (peer/dep), reuses `@d3gl/core` (PathContext, Scene, flatten) and `@d3gl/webgl` (GroupRenderer, decodePickColor).

**Builds on:** Plan 3's `GroupRenderer.renderPick`, `device.readPixelsToArrayWebGL`, `decodePickColor`, and `clipFromView`; Plan 1's `PathContext`/flatten; Plan 2's `Scene`.

**Scope boundary / deferrals:** Orthographic globe interaction (versor rotation → CPU reproject → rebuild renderer) is deferred to a follow-up — Plan 4's `featureGroup` + a rotated projection + a new `GroupRenderer` compose into it. SVG `<arc>` uses flattened line segments (not `A` commands) — correct geometry, documented; geo export is overwhelmingly polygons/lines. No labels/React/example/perf CI gate (Plan 5). The d3-zoom *event wiring* (attaching the behavior to a canvas) is consumer glue documented inline; this plan provides the pure `viewTransform` conversion it needs.

---

## File Structure

```
packages/
├─ svg/
│  ├─ package.json                # @d3gl/svg (dep: @d3gl/core)
│  ├─ tsconfig.json
│  └─ src/
│     ├─ svg-context.ts           # SvgPathContext                         (Task 1)
│     ├─ document.ts              # svgDocument()                          (Task 2)
│     ├─ index.ts
│     └─ __tests__/{svg-context,document}.test.ts
├─ geo/
│  ├─ package.json                # @d3gl/geo (deps: @d3gl/core, d3-geo)
│  ├─ tsconfig.json
│  └─ src/
│     ├─ project.ts               # fitProjection, featureGroup            (Task 3)
│     ├─ inverse.ts               # viewTransform, referenceFromScreen, lonLatFromScreen (Task 4)
│     ├─ index.ts
│     └─ __tests__/{project,inverse}.test.ts
└─ webgl/
   └─ src/
      ├─ pick.ts                  # pickAt                                 (Task 5)
      ├─ png.ts                   # toPNG                                  (Task 5)
      ├─ index.ts                 # (add exports)
      └─ export.browser.test.ts   # browser tests                         (Task 5)
```

**Tooling note (every task):** bare `pnpm` is broken — use `corepack pnpm@9`. Node suites: `corepack pnpm@9 test` (root config; excludes `*.browser.test.ts`) or `corepack pnpm@9 test -- <name>`. Browser suite: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`. New packages need `corepack pnpm@9 install` after their `package.json` is created. Commit with `git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "..."` — never add co-author or "claude" attribution.

---

## Task 1: SVG path-string backend (`@d3gl/svg` SvgPathContext)

**Files:**
- Create: `packages/svg/package.json`, `packages/svg/tsconfig.json`
- Create: `packages/svg/src/svg-context.ts`, `packages/svg/src/index.ts`
- Test: `packages/svg/src/__tests__/svg-context.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/svg/package.json`:

```json
{
  "name": "@d3gl/svg",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": { "@d3gl/core": "workspace:*" }
}
```

Create `packages/svg/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/svg/src/__tests__/svg-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SvgPathContext } from "../svg-context.js";

describe("SvgPathContext", () => {
  it("builds an SVG path from moveTo/lineTo/closePath", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.lineTo(10, 10);
    ctx.closePath();
    expect(ctx.toPath()).toBe("M0,0L10,0L10,10Z");
  });

  it("emits a cubic bezier as a C command", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(0, 10, 10, 10, 10, 0);
    expect(ctx.toPath()).toBe("M0,0C0,10,10,10,10,0");
  });

  it("emits a quadratic bezier as a Q command", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(5, 10, 10, 0);
    expect(ctx.toPath()).toBe("M0,0Q5,10,10,0");
  });

  it("expands rect() into a closed subpath", () => {
    const ctx = new SvgPathContext();
    ctx.rect(1, 2, 10, 20);
    expect(ctx.toPath()).toBe("M1,2L11,2L11,22L1,22Z");
  });

  it("rounds coordinates to 3 decimals", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0.123456, 1.999999);
    expect(ctx.toPath()).toBe("M0.123,2");
  });

  it("beginPath clears the accumulated path", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.lineTo(1, 1);
    ctx.beginPath();
    ctx.moveTo(2, 2);
    expect(ctx.toPath()).toBe("M2,2");
  });

  it("approximates arc() with line segments (flattened)", () => {
    const ctx = new SvgPathContext();
    ctx.arc(0, 0, 10, 0, Math.PI / 2, false);
    const d = ctx.toPath();
    expect(d.startsWith("M10,0")).toBe(true); // arc start point
    expect(d).toContain("L"); // flattened to line segments
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `corepack pnpm@9 install` (links `@d3gl/core` into the new package), then `corepack pnpm@9 test -- svg-context`
Expected: FAIL — cannot resolve `../svg-context.js`.

- [ ] **Step 4: Implement SvgPathContext**

Create `packages/svg/src/svg-context.ts`:

```ts
import type { PathContext } from "@d3gl/core";
import { flattenArc } from "@d3gl/core";

/** Round to 3 decimals and drop trailing zeros (compact, deterministic output). */
function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * A PathContext that accumulates an SVG path `d` string. Used for publication
 * vector export: re-run a d3 generator (geoPath, d3-shape, …) into this context
 * and read `toPath()`. Curves map to native C/Q commands; arcs are flattened to
 * line segments (correct geometry; geo export is polygons/lines, so this is rare).
 */
export class SvgPathContext implements PathContext {
  private d = "";
  private cx = 0;
  private cy = 0;

  constructor(public tolerance = 0.25) {}

  toPath(): string {
    return this.d;
  }

  beginPath(): void {
    this.d = "";
  }

  moveTo(x: number, y: number): void {
    this.d += `M${fmt(x)},${fmt(y)}`;
    this.cx = x;
    this.cy = y;
  }

  lineTo(x: number, y: number): void {
    this.d += `L${fmt(x)},${fmt(y)}`;
    this.cx = x;
    this.cy = y;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.d += `Q${fmt(cpx)},${fmt(cpy)},${fmt(x)},${fmt(y)}`;
    this.cx = x;
    this.cy = y;
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.d += `C${fmt(cp1x)},${fmt(cp1y)},${fmt(cp2x)},${fmt(cp2y)},${fmt(x)},${fmt(y)}`;
    this.cx = x;
    this.cy = y;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (this.d === "") this.moveTo(sx, sy);
    else this.lineTo(sx, sy);
    const pts: number[] = [];
    flattenArc(x, y, radius, startAngle, endAngle, counterclockwise, this.tolerance, pts);
    for (let i = 0; i < pts.length; i += 2) this.lineTo(pts[i]!, pts[i + 1]!);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, _radius: number): void {
    // Same documented simplification as the GPU recorder: not a true tangent arc.
    this.lineTo(x1, y1);
    this.lineTo(x2, y2);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.d += `M${fmt(x)},${fmt(y)}L${fmt(x + w)},${fmt(y)}L${fmt(x + w)},${fmt(y + h)}L${fmt(x)},${fmt(y + h)}Z`;
    this.cx = x;
    this.cy = y;
  }

  closePath(): void {
    this.d += "Z";
  }
}
```

- [ ] **Step 5: Create the index**

Create `packages/svg/src/index.ts`:

```ts
export { SvgPathContext } from "./svg-context.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- svg-context`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/svg pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(svg): add SvgPathContext that builds SVG path strings"
```

---

## Task 2: SVG document assembler (`svgDocument`)

**Files:**
- Create: `packages/svg/src/document.ts`
- Modify: `packages/svg/src/index.ts`
- Test: `packages/svg/src/__tests__/document.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/svg/src/__tests__/document.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { svgDocument } from "../document.js";

describe("svgDocument", () => {
  it("wraps styled paths into an svg element of the given size", () => {
    const svg = svgDocument(200, 100, [
      { d: "M0,0L10,0Z", fill: "#ff0000" },
      { d: "M0,0L5,5", stroke: "#00ff00", strokeWidth: 2 },
    ]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="100"');
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain('<path d="M0,0L10,0Z" fill="#ff0000"');
    expect(svg).toContain('stroke="#00ff00"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("defaults fill to none when only a stroke is given", () => {
    const svg = svgDocument(10, 10, [{ d: "M0,0L1,1", stroke: "#000" }]);
    expect(svg).toContain('fill="none"');
  });

  it("escapes nothing unexpected and skips empty paths", () => {
    const svg = svgDocument(10, 10, [{ d: "", fill: "#000" }, { d: "M0,0L1,1", fill: "#111" }]);
    // empty-d path is omitted
    expect(svg).not.toContain('d=""');
    expect(svg).toContain('d="M0,0L1,1"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- document`
Expected: FAIL — cannot resolve `../document.js`.

- [ ] **Step 3: Implement svgDocument**

Create `packages/svg/src/document.ts`:

```ts
/** One styled path in an SVG document. */
export interface SvgPath {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * Assemble styled paths into a standalone SVG document string. Paths with an
 * empty `d` are skipped. `fill` defaults to "none" when only a stroke is given,
 * otherwise to the provided fill.
 */
export function svgDocument(width: number, height: number, paths: readonly SvgPath[]): string {
  const body = paths
    .filter((p) => p.d.length > 0)
    .map((p) => {
      const fill = p.fill ?? (p.stroke ? "none" : "#000");
      const attrs = [`d="${p.d}"`, `fill="${fill}"`];
      if (p.stroke) attrs.push(`stroke="${p.stroke}"`);
      if (p.strokeWidth != null) attrs.push(`stroke-width="${p.strokeWidth}"`);
      return `  <path ${attrs.join(" ")} />`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${body}\n</svg>`;
}
```

- [ ] **Step 4: Re-export from index.ts**

Replace `packages/svg/src/index.ts` with:

```ts
export { SvgPathContext } from "./svg-context.js";
export { svgDocument } from "./document.js";
export type { SvgPath } from "./document.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- document`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/svg/src/document.ts packages/svg/src/index.ts packages/svg/src/__tests__/document.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(svg): assemble styled paths into an SVG document"
```

---

## Task 3: Project-once into a Scene (`@d3gl/geo` project.ts)

**Files:**
- Create: `packages/geo/package.json`, `packages/geo/tsconfig.json`
- Create: `packages/geo/src/project.ts`, `packages/geo/src/index.ts`
- Test: `packages/geo/src/__tests__/project.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/geo/package.json`:

```json
{
  "name": "@d3gl/geo",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@d3gl/core": "workspace:*",
    "d3-geo": "^3.1.1"
  },
  "devDependencies": {
    "@types/d3-geo": "^3.1.0",
    "@types/geojson": "^7946.0.14"
  }
}
```

Create `packages/geo/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/geo/src/__tests__/project.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { Scene } from "@d3gl/core";
import { fitProjection, featureGroup } from "../project.js";

const featureA: GeoJSON.Feature = {
  type: "Feature",
  properties: { id: "a" },
  geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
};
const featureB: GeoJSON.Feature = {
  type: "Feature",
  properties: { id: "b" },
  geometry: { type: "Polygon", coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]] },
};

describe("fitProjection", () => {
  it("fits the projection so geometry falls within the viewport", () => {
    const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [featureA, featureB] };
    const projection = fitProjection(geoEquirectangular(), fc, 256, 128);
    const p = projection([5, 5])!; // a lon/lat inside the data
    expect(p[0]).toBeGreaterThanOrEqual(0);
    expect(p[0]).toBeLessThanOrEqual(256);
    expect(p[1]).toBeGreaterThanOrEqual(0);
    expect(p[1]).toBeLessThanOrEqual(128);
  });
});

describe("featureGroup", () => {
  it("builds one drawable per feature, projected once into the Scene", () => {
    const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [featureA, featureB] };
    const projection = fitProjection(geoEquirectangular(), fc, 256, 128);
    const scene = new Scene();
    scene.group(
      "land",
      featureGroup([featureA, featureB], projection, {
        id: (f) => String((f.properties as { id: string }).id),
        lineWidth: 1,
      }),
    );
    const buf = scene.buffers("land");
    expect(buf.drawableCount).toBe(2);
    expect(buf.fillIndices.length).toBeGreaterThanOrEqual(2 * 6);
    expect(buf.strokeIndices.length).toBeGreaterThan(0);
    // drawable ids map to the feature ids
    expect(() => scene.range("land", "a")).not.toThrow();
    expect(() => scene.range("land", "b")).not.toThrow();
  });

  it("omits stroke geometry when no lineWidth is given", () => {
    const projection = fitProjection(geoEquirectangular(), featureA, 256, 128);
    const scene = new Scene();
    scene.group("land", featureGroup([featureA], projection, { id: () => "a" }));
    expect(scene.buffers("land").strokeIndices.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `corepack pnpm@9 install`, then `corepack pnpm@9 test -- project`
Expected: FAIL — cannot resolve `../project.js`.

- [ ] **Step 4: Implement project.ts**

Create `packages/geo/src/project.ts`:

```ts
import { geoPath } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { GroupBuilder, PathContext } from "@d3gl/core";

/** A GeoJSON object d3-geo can project + render (feature, geometry, or collection). */
export type GeoInput = GeoJSON.GeoJSON;

/** Fit a d3 projection so `object`'s bounds fill a width x height viewport. Mutates + returns it. */
export function fitProjection<P extends GeoProjection>(
  projection: P,
  object: GeoInput,
  width: number,
  height: number,
): P {
  projection.fitSize([width, height], object as Parameters<P["fitSize"]>[1]);
  return projection;
}

/** How to derive a drawable id (and optional stroke width) from a feature. */
export interface FeatureAccessors<F> {
  id: (feature: F, index: number) => string | number;
  /** Stroke width in projected pixels; omit/0 for fill-only. */
  lineWidth?: number;
}

/**
 * A Scene.group builder that projects each GeoJSON feature ONCE with `projection`
 * (via geoPath into the drawable's PathContext) and registers it as a drawable.
 * After this, the GPU renders, recolors, and pans/zooms without re-projecting.
 */
export function featureGroup<F extends GeoInput>(
  features: readonly F[],
  projection: GeoProjection,
  accessors: FeatureAccessors<F>,
): (g: GroupBuilder) => void {
  const opts = accessors.lineWidth != null ? { lineWidth: accessors.lineWidth } : undefined;
  return (g) => {
    features.forEach((feature, i) => {
      g.drawable(
        accessors.id(feature, i),
        (ctx: PathContext) => {
          const path = geoPath(projection, ctx);
          path(feature as Parameters<typeof path>[0]);
        },
        opts,
      );
    });
  };
}
```

- [ ] **Step 5: Create the index**

Create `packages/geo/src/index.ts`:

```ts
export { fitProjection, featureGroup } from "./project.js";
export type { GeoInput, FeatureAccessors } from "./project.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- project`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/geo pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(geo): project GeoJSON once into a Scene group with any d3 projection"
```

---

## Task 4: Inverse mapping for tooltips + zoom transform (`@d3gl/geo` inverse.ts)

**Files:**
- Create: `packages/geo/src/inverse.ts`
- Modify: `packages/geo/src/index.ts`
- Test: `packages/geo/src/__tests__/inverse.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/geo/src/__tests__/inverse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { referenceFromScreen, lonLatFromScreen, viewTransform } from "../inverse.js";

describe("referenceFromScreen", () => {
  it("inverts the d3-zoom pixel transform", () => {
    // screen = k*reference + (x,y)  =>  reference = (screen - (x,y)) / k
    expect(referenceFromScreen({ k: 2, x: 10, y: 20 }, 50, 60)).toEqual([20, 20]);
  });
  it("is identity at k=1, no pan", () => {
    expect(referenceFromScreen({ k: 1, x: 0, y: 0 }, 33, 44)).toEqual([33, 44]);
  });
});

describe("lonLatFromScreen", () => {
  it("round-trips a projected point back to lon/lat", () => {
    const projection = geoEquirectangular();
    const lonlat: [number, number] = [12, -7];
    const [px, py] = projection(lonlat)!;
    const back = lonLatFromScreen(projection, { k: 1, x: 0, y: 0 }, px, py);
    expect(back).not.toBeNull();
    expect(back![0]).toBeCloseTo(12, 4);
    expect(back![1]).toBeCloseTo(-7, 4);
  });

  it("accounts for zoom/pan before inverting", () => {
    const projection = geoEquirectangular();
    const lonlat: [number, number] = [30, 10];
    const [px, py] = projection(lonlat)!;
    // place that point under a zoomed/panned screen pixel
    const k = 3, x = 100, y = 50;
    const screenX = k * px + x;
    const screenY = k * py + y;
    const back = lonLatFromScreen(projection, { k, x, y }, screenX, screenY);
    expect(back![0]).toBeCloseTo(30, 3);
    expect(back![1]).toBeCloseTo(10, 3);
  });
});

describe("viewTransform", () => {
  it("produces a 9-element clip-space matrix from a zoom transform", () => {
    const m = viewTransform({ k: 1, x: 0, y: 0 }, 100, 100);
    expect(m.length).toBe(9);
    expect(m instanceof Float32Array).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- inverse`
Expected: FAIL — cannot resolve `../inverse.js`.

- [ ] **Step 3: Implement inverse.ts**

Create `packages/geo/src/inverse.ts`:

```ts
import type { GeoProjection } from "d3-geo";
import { clipFromView } from "@d3gl/webgl";
import type { ViewTransform } from "@d3gl/webgl";

export type { ViewTransform };

/**
 * Re-export of the GPU view matrix builder: turn a d3-zoom transform {k,x,y} into
 * the column-major clip-space mat3 the renderer's setTransform expects.
 */
export function viewTransform(t: ViewTransform, width: number, height: number): Float32Array {
  return clipFromView(t, width, height);
}

/**
 * Invert the d3-zoom pixel transform: screen pixel -> reference (projected) pixel.
 * screen = k*reference + (x,y)  =>  reference = (screen - (x,y)) / k.
 */
export function referenceFromScreen(t: ViewTransform, screenX: number, screenY: number): [number, number] {
  return [(screenX - t.x) / t.k, (screenY - t.y) / t.k];
}

/**
 * Screen pixel -> lon/lat: undo the zoom transform, then the projection. Returns
 * null if the projection cannot invert the point (e.g. outside the globe).
 */
export function lonLatFromScreen(
  projection: GeoProjection,
  t: ViewTransform,
  screenX: number,
  screenY: number,
): [number, number] | null {
  if (!projection.invert) return null;
  const ref = referenceFromScreen(t, screenX, screenY);
  return projection.invert(ref) ?? null;
}
```

- [ ] **Step 4: Add `@d3gl/webgl` as a geo dependency**

Edit `packages/geo/package.json` to add `"@d3gl/webgl": "workspace:*"` to `dependencies`. Run `corepack pnpm@9 install`.

- [ ] **Step 5: Re-export from index.ts**

Replace `packages/geo/src/index.ts` with:

```ts
export { fitProjection, featureGroup } from "./project.js";
export type { GeoInput, FeatureAccessors } from "./project.js";
export { viewTransform, referenceFromScreen, lonLatFromScreen } from "./inverse.js";
export type { ViewTransform } from "./inverse.js";
```

- [ ] **Step 6: Run the tests + typecheck**

Run: `corepack pnpm@9 test -- inverse`
Expected: PASS.
Run: `corepack pnpm@9 -r exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/geo pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(geo): add screen->lon/lat inverse mapping and zoom transform"
```

---

## Task 5: GPU pick + PNG export (`@d3gl/webgl`)

**Files:**
- Create: `packages/webgl/src/pick.ts`, `packages/webgl/src/png.ts`
- Modify: `packages/webgl/src/index.ts`
- Test: `packages/webgl/src/export.browser.test.ts`

- [ ] **Step 1: Write the failing browser tests**

Create `packages/webgl/src/export.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";
import { pickAt } from "./pick.js";
import { toPNG } from "./png.js";

const W = 64;
const H = 64;

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
  const framebuffer = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
  return { device, framebuffer };
}

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

describe("pickAt", () => {
  it("returns the drawableId under a top-left-origin screen pixel", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    // screen coords are top-left origin; pickAt flips internally for the GL read.
    expect(pickAt(device, renderer, framebuffer, 16, 32, H)).toBe(0); // left -> "a"
    expect(pickAt(device, renderer, framebuffer, 48, 32, H)).toBe(1); // right -> "b"
    expect(pickAt(device, renderer, framebuffer, 16, 2, H)).toBe(0); // still over a near top

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});

describe("toPNG", () => {
  it("produces a PNG data URL from the rendered framebuffer", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const url = toPNG(device, framebuffer, W, H);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan(100);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: FAIL — cannot resolve `./pick.js` / `./png.js`.

- [ ] **Step 3: Implement pick.ts**

Create `packages/webgl/src/pick.ts`:

```ts
import type { Device, Framebuffer } from "@luma.gl/core";
import type { GroupRenderer } from "./renderer.js";
import { decodePickColor } from "./palette.js";

/**
 * Render the pick pass and read the drawableId under a screen pixel.
 *
 * `x`, `y` are top-left-origin screen coordinates (as from a pointer event);
 * WebGL readback is bottom-left, so y is flipped with `height`. Returns the
 * drawableId, or -1 for empty background. The caller maps the id to a domain id.
 *
 * `framebuffer` is used as a scratch target (its contents are overwritten).
 */
export function pickAt(
  device: Device,
  renderer: GroupRenderer,
  framebuffer: Framebuffer,
  x: number,
  y: number,
  height: number,
): number {
  const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
  renderer.renderPick(pass);
  pass.end();
  device.submit();
  const px = device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: Math.floor(x),
    sourceY: Math.floor(height - 1 - y),
    sourceWidth: 1,
    sourceHeight: 1,
  });
  return decodePickColor(px[0]!, px[1]!, px[2]!);
}
```

- [ ] **Step 4: Implement png.ts**

Create `packages/webgl/src/png.ts`:

```ts
import type { Device, Framebuffer } from "@luma.gl/core";

/**
 * Read a rendered framebuffer back to a PNG data URL. WebGL readback is
 * bottom-left origin, so rows are flipped to top-left for the image. Browser
 * only (uses a 2D canvas to encode). Render into `framebuffer` before calling.
 */
export function toPNG(device: Device, framebuffer: Framebuffer, width: number, height: number): string {
  const pixels = device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  // Flip rows: GL row 0 is the bottom; image row 0 is the top.
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    image.data.set(pixels.subarray(src, src + rowBytes), dst);
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}
```

- [ ] **Step 5: Export from index.ts**

Append to `packages/webgl/src/index.ts`:

```ts
export { pickAt } from "./pick.js";
export { toPNG } from "./png.js";
```

- [ ] **Step 6: Run the browser tests to verify they pass**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: PASS (pick + PNG, plus the existing renderer/smoke browser tests).

If `readPixelsToArrayWebGL` rejects `sourceWidth`/`sourceHeight` (the spike used only `sourceX`/`sourceY` for a single pixel), drop those two options for the single-pixel `pickAt` read and instead read the full buffer then index the pixel; for `toPNG`, if a full-buffer read needs a different call shape, adjust to the real signature and REPORT it. The single-pixel read in the spike worked with just `{sourceX, sourceY}`.

- [ ] **Step 7: Typecheck + full Node suite, then commit**

Run: `corepack pnpm@9 -r exec tsc --noEmit` (clean).
Run: `corepack pnpm@9 test` (Node suites unaffected).

```bash
git add packages/webgl/src/pick.ts packages/webgl/src/png.ts packages/webgl/src/index.ts packages/webgl/src/export.browser.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(webgl): add GPU pickAt and PNG export"
```

---

## Self-Review

**Spec coverage (this plan's slice):**
- SVG path-string backend → Task 1 (`SvgPathContext`) + Task 2 (`svgDocument`). ✓
- Project-once with any d3-geo projection feeding Scene reference coords → Task 3 (`fitProjection`, `featureGroup`). ✓
- `d3-zoom` → `clipFromView` transform → Task 4 (`viewTransform`). ✓
- Quadtree/CPU hit-testing for tooltips → Task 4 (`lonLatFromScreen` for lon/lat readout) + Task 5 (`pickAt` GPU fallback, the general hit-test). ✓
- PNG/SVG export → Task 5 (`toPNG`) + Tasks 1–2 (SVG). ✓

**Deferred (documented in Scope boundary):** orthographic globe interaction; SVG `A`-command arcs (flattened instead); d3-zoom event attachment (consumer glue); labels/React/example/perf CI gate (Plan 5).

**Placeholder scan:** No TBD/TODO. The Task 5 note about `readPixelsToArrayWebGL` options is a fallback for one unverified option shape (`sourceWidth`/`sourceHeight`) — the spike verified `{sourceX, sourceY}`; if the multi-arg form is rejected the documented fallback (full read + index) applies. Not a placeholder; the primary code is the expected form.

**Type/name consistency:** `PathContext` (core) implemented by `SvgPathContext` (Task 1), matching the same interface `CanvasContext` implements. `SvgPath` (Task 2) consumed by `svgDocument`. `GroupBuilder`/`Scene` (core) consumed by `featureGroup` (Task 3) exactly as Plan 2 defined. `ViewTransform`/`clipFromView` (Plan 3 `@d3gl/webgl`) reused by `inverse.ts` (Task 4). `GroupRenderer.renderPick` + `decodePickColor` + `readPixelsToArrayWebGL` (Plan 3) used by `pickAt` (Task 5). `featureGroup` `id` accessor returns `string | number` matching `Scene.drawable`'s id type.

---

## Next plan

- **Plan 5 — Product (`@d3gl/labels`, `@d3gl/react`):** HTML LabelLayer with viewport/collision culling (positioned via `referenceFromScreen`/the transform); `<D3GL target=...>` / `<Layer>` / `<Tooltip>` React components wrapping device + `GroupRenderer` + `featureGroup` + `pickAt`; the bioregions map example (grid cells, heatmap/bioregion recolor, tooltips, PNG/SVG export); and a performance-budget CI gate asserting recolor = texture write and pan/zoom = uniform update. Orthographic globe interaction can land here or as its own follow-up using `featureGroup` + a versor-rotated projection.
```
