# d3gl

GPU-accelerated rendering for d3 — especially maps with GeoJSON and grid-cell data.

d3's generators (`d3-geo`'s `geoPath`, `d3-shape`, `d3-chord`, `d3-hierarchy` links)
don't draw; they emit path commands (`moveTo`/`lineTo`/`bezierCurveTo`/`arc`/…) to a
**context**. Today that context is Canvas2D or an SVG path-string builder. **d3gl
implements that same context across SVG / Canvas2D / WebGL2**, so any context-driven d3
generator can render on the GPU unchanged.

The design centre is *project & tessellate once, then interact for free*: geometry is
uploaded to the GPU a single time; **pan/zoom is one transform-matrix uniform** and
**recolor / show-hide is one texture write** — neither re-projects or re-tessellates.
Recoloring 4096 cells measures ~61× cheaper than the initial geometry build.

## Packages

| Package | Responsibility |
| --- | --- |
| `@d3gl/core` | `PathContext` interface, curve flattening, `PathRecorder`, ring grouping, earcut fill tessellation, stroke expansion, the retained **`Scene`** (packed buffers + color/flag side-tables) |
| `@d3gl/canvas` | Canvas2D passthrough `PathContext` |
| `@d3gl/webgl` | luma.gl v9 WebGL2 `GroupRenderer` — palette-texture color by `drawableId`, `mat3` transform uniform, texture-write recolor, GPU picking; `clipFromView`, `pickAt`, `toPNG` |
| `@d3gl/geo` | `fitProjection` + `featureGroup` (project any GeoJSON once with any d3 projection), `referenceFromScreen`/`lonLatFromScreen`, `viewTransform` |
| `@d3gl/svg` | `SvgPathContext` + `svgDocument` (publication vector export) |
| `@d3gl/labels` | `cullLabels` (viewport + collision) + `LabelLayer` (HTML overlay; geometry stays on the GPU, only visible labels enter the DOM) |
| `@d3gl/react` | headless `MapController` + the `<D3GL>` React component |

Dependency direction: `core ← canvas/svg`, `core ← webgl ← geo/labels/react`.

## Quick start (React)

```tsx
import { Scene } from "@d3gl/core";
import { fitProjection, featureGroup, viewTransform } from "@d3gl/geo";
import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { D3GL } from "@d3gl/react";

const projection = fitProjection(geoNaturalEarth1(), featureCollection, width, height);

const scene = new Scene();
scene.group("cells", featureGroup(cells, projection, { id: (c) => c.id, lineWidth: 0.5 }));

const color = scaleSequential(interpolateViridis).domain([0, 1]);
for (const c of cells) scene.setFill("cells", c.id, color(c.value));

<D3GL
  width={width}
  height={height}
  transform={viewTransform({ k: 1, x: 0, y: 0 }, width, height)}
  groups={[{ name: "cells", buffers: scene.buffers("cells") }]}
  onReady={(controller) => {/* controller.pick(...), controller.toPNG(), ... */}}
/>;
```

Recolor at any time with `scene.setFill(...)` + `controller.updateColors("cells", scene.buffers("cells"))` — a texture write, no re-tessellation. Pan/zoom by passing a new `transform`.

## Development

This is a pnpm workspace (TypeScript, Vitest). The CPU layers test in Node; the WebGL,
DOM, and React layers test in headless Chromium via Vitest browser mode + Playwright.

```sh
pnpm install
pnpm exec playwright install chromium    # one-time, for browser tests

pnpm test                                 # Node unit tests (all packages)
pnpm -r exec tsc --noEmit                 # typecheck

# Browser suites (per package):
pnpm --filter @d3gl/webgl  exec vitest run --config vitest.config.ts
pnpm --filter @d3gl/labels exec vitest run --config vitest.config.ts
pnpm --filter @d3gl/react  exec vitest run --config vitest.config.ts
```

`*.browser.test.ts(x)` run only via each package's `vitest.config.ts`; the root Node
config excludes them.

> **Environment note:** if a bare `pnpm` is unavailable or broken (e.g. a stale asdf
> shim), use `corepack pnpm@9 …` in place of `pnpm …` for every command above.

## Roadmap (not yet in v1)

- Standalone runnable bioregions example app
- `<Layer>`-as-children component sugar (the declarative `groups` prop ships today)
- Orthographic globe interaction (versor-rotated projection + `featureGroup` + a fresh renderer on drag)
- MSDF / canvas-2D label backends for dense (thousands-of-label) trees
- A d3-zoom event-attachment helper (wire pointer/wheel → `viewTransform` → `transform`)

## Design docs

Specs and task-by-task implementation plans live under `docs/superpowers/`.
