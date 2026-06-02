# @mapequation/d3gl

GPU-accelerated rendering for d3 — especially maps with GeoJSON and grid-cell
data, with switchable **SVG / Canvas2D / WebGL2** backends.

d3's generators (`d3-geo`'s `geoPath`, `d3-shape`, `d3-hierarchy` links) don't
draw; they emit path commands to a **context**. d3gl implements that same context
across SVG / Canvas2D / WebGL2, so any context-driven d3 generator can render on
the GPU unchanged. Geometry is projected & tessellated **once**; pan/zoom is one
transform-matrix uniform and recolor/show-hide is one texture write.

## Install

```sh
npm i @mapequation/d3gl
# React components also need:  npm i react react-dom   (optional peer deps)
```

## Subpath exports

```ts
import { Scene } from "@mapequation/d3gl";            // core (root entry)
import { geoMap, plot } from "@mapequation/d3gl/map"; // interactive engines
import { fitProjection } from "@mapequation/d3gl/geo"; // project-once primitives
import { D3GL } from "@mapequation/d3gl/react";        // React component
// also: /webgl  /canvas  /svg  /labels
```

| Subpath | Responsibility |
| --- | --- |
| *(root)* | `Scene`, `PathContext`, tessellation, stroke expansion, hit-testing |
| `/canvas` | Canvas2D backend |
| `/webgl` | luma.gl v9 WebGL2 backend (palette-texture color, GPU picking, PNG export) |
| `/svg` | SVG backend + vector export |
| `/geo` | projection + GeoJSON project-once helpers, inverse projection |
| `/labels` | HTML label overlay with culling |
| `/map` | `geoMap` + `plot` engines with d3-zoom wiring |
| `/react` | headless `MapController` + `<D3GL>` component |

See the [repository](https://github.com/mapequation/d3gl) for full docs,
examples, and the live demo.

## License

[MIT](./LICENSE) © Daniel Edler
