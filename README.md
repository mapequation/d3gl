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

## Install

d3gl ships as a **single package with subpath exports** — one install, modular
imports, tree-shakeable:

```sh
npm i @mapequation/d3gl
# React components also need: npm i react react-dom   (optional peer deps)
```

```ts
import { Scene } from "@mapequation/d3gl";           // core (root entry)
import { geoMap, plot } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { D3GL } from "@mapequation/d3gl/react";
// also: /webgl  /canvas  /svg  /labels
```

## Modules

`@mapequation/d3gl` is one published package built from these modules (under
`packages/d3gl/src/<name>`), each exposed as a subpath export; the root entry is
`core`.

| Subpath | Module | Responsibility |
| --- | --- | --- |
| *(root)* | `core` | `PathContext` interface, curve flattening, `PathRecorder`, ring grouping, earcut fill tessellation, stroke expansion, the retained **`Scene`** (packed buffers + color/flag side-tables) |
| `/canvas` | `canvas` | Canvas2D passthrough `PathContext` |
| `/webgl` | `webgl` | luma.gl v9 WebGL2 `GroupRenderer` — palette-texture color by `drawableId`, `mat3` transform uniform, texture-write recolor, GPU picking; `clipFromView`, `pickAt`, `toPNG` |
| `/geo` | `geo` | `fitProjection` + `featureGroup` (project any GeoJSON once with any d3 projection), `referenceFromScreen`/`lonLatFromScreen`, `viewTransform` |
| `/svg` | `svg` | `SvgPathContext` + `svgDocument` (publication vector export) |
| `/labels` | `labels` | `cullLabels` (viewport + collision) + `LabelLayer` (HTML overlay; geometry stays on the GPU, only visible labels enter the DOM) |
| `/map` | `map` | `geoMap` (project-once map engine) + `plot` (generic 2D engine), d3-zoom wiring, backend selection |
| `/react` | `react` | headless `MapController` + the `<D3GL>` React component |

Dependency direction: `core ← canvas/svg`, `core ← webgl ← geo/labels/map/react`.

> **Why one package with subpaths instead of many?** Tree-shaking keeps unused
> code out of your bundle either way, so the modular structure is preserved
> through subpaths while you install and version a single package. luma.gl is a
> regular dependency (the WebGL backend is the default); `react`/`react-dom` are
> *optional* peer dependencies, needed only for the `/react` subpath.

## Quick start (React)

```tsx
import { Scene } from "@mapequation/d3gl";
import { fitProjection, featureGroup, viewTransform } from "@mapequation/d3gl/geo";
import { D3GL } from "@mapequation/d3gl/react";
import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";

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

## Documentation

Full docs, runnable examples, and the API reference live at
**https://mapequation.github.io/d3gl/**.

## Contributing & development

See [CONTRIBUTING.md](CONTRIBUTING.md) for workspace setup, tests, and the release process.

## Roadmap (not yet in v1)

- Standalone runnable bioregions example app
- `<Layer>`-as-children component sugar (the declarative `groups` prop ships today)
- Orthographic globe interaction (versor-rotated projection + `featureGroup` + a fresh renderer on drag)
- MSDF / canvas-2D label backends for dense (thousands-of-label) trees
- A d3-zoom event-attachment helper (wire pointer/wheel → `viewTransform` → `transform`)

## Design docs

Specs and task-by-task implementation plans live under `docs/superpowers/`.
