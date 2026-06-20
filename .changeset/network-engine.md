---
"@mapequation/d3gl": minor
---

Add the `network()` engine for large node–link diagrams, exported from the new `@mapequation/d3gl/network` subpath.

- **Instanced WebGL rendering**: GPU-instanced nodes (points), links (lines), and triangle arrowheads for directed edges, via a shared instanced-primitive lane in the WebGL backend.
- **SVG/Canvas + export**: the same glyphs emit through the PathContext seam, so small networks render on the SVG/Canvas backends and `toSVG()` produces publication output.
- **Data model**: columnar SoA + CSR graph (`buildGraph`), a label-interning edge-list parser (`parseEdgeList`), and a Pajek `.net` parser (`parsePajek`, supporting `*Vertices`/`*Arcs`/`*Edges`/`*Arcslist`/`*Edgeslist` with optional labels and coordinates).
- **In-library force layout** (`layout({ backend: "force" })`): force-directed simulation with a Barnes-Hut quadtree (O(n log n)) and deterministic seeding, seeded by default via **multilevel coarsening** (heavy-edge matching) for faster convergence and fewer tangles on clustered graphs (opt out with `multilevel: false`).
