# d3gl

GPU-accelerated rendering for d3: maps, 2D plots and large node–link networks, drawn
through one API on **SVG, Canvas2D or WebGL2**.

**[Documentation and live examples →](https://mapequation.github.io/d3gl/)**

d3's generators (`d3-geo`'s `geoPath`, `d3-shape`, `d3-hierarchy` links) don't draw;
they emit path commands to a **context**. d3gl implements that context on every
backend, so a context-driven d3 generator renders on the GPU unchanged. Geometry is
projected and tessellated once: pan/zoom is one transform uniform, and recolor or
show/hide is one texture write.

## Engines

- **`geoMap()`**: GeoJSON with any d3 projection, projected once.
- **`plot()`**: any 2D drawing from d3 generators, plus instanced point layers.
- **`network()`**: node–link graphs up to millions of nodes and links, with an in-library
  force layout that runs in a Web Worker or on the GPU, nested module layouts, and a
  level of detail that aggregates dense regions and expands them as you zoom in.

All three take a `backend` option (`"webgl"`, `"canvas"`, `"svg"` or `"auto"`), share
pan/zoom, hover, selection and labels, and export PNG and SVG. The React components
`<GeoMap>` and `<Plot>` wrap the first two.

## Install

```sh
npm i @mapequation/d3gl
# React components also need: npm i react react-dom   (optional peer deps)
```

One package with subpath exports (`/map`, `/network`, `/geo`, `/react`, …); the
[package README](packages/d3gl/README.md) lists them.

## Quick start

```ts
import { plot } from "@mapequation/d3gl/map";
import { line } from "d3-shape";

const points: [number, number][] = [[0, 0], [100, 80], [200, 40], [320, 160], [440, 90]];

const chart = plot(document.querySelector("#chart")!, { width: 640, height: 400, backend: "webgl" });
const gen = line<[number, number]>().x((d) => d[0]).y((d) => d[1]);
chart.layer("series", [points], { draw: (ctx, d) => { gen.context(ctx); gen(d); }, stroke: "#1a73e8", lineWidth: 1.5 });
chart.enableZoom();
```

A network, laid out off the main thread:

```ts
import { network, buildGraph } from "@mapequation/d3gl/network";

network(document.querySelector("#net")!, { width: 640, height: 400 })
  .data(buildGraph({ nodeCount, source, target }))
  .lod({}) // aggregate dense regions; they open as you zoom in
  .layout({ backend: "auto" }) // force layout on the GPU where it works, else in a worker
  .enableZoom([0.01, 100]);
```

See [Getting started](https://mapequation.github.io/d3gl/getting-started/) and the
[examples](https://mapequation.github.io/d3gl/examples/phylogenetic-tree/) for more.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for workspace setup, tests and the release
process. Design specs and implementation plans live under [`docs/`](docs/).

## License

[MIT](LICENSE) © Daniel Edler
