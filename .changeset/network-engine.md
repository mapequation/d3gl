---
"@mapequation/d3gl": minor
---

Add the `network()` engine for large node–link diagrams, exported from the new `@mapequation/d3gl/network` subpath.

- **Instanced WebGL rendering**: GPU-instanced nodes (points), links (lines), and triangle arrowheads for directed edges, via a shared instanced-primitive lane in the WebGL backend.
- **SVG/Canvas + export**: the same glyphs emit through the PathContext seam, so small networks render on the SVG/Canvas backends and `toSVG()` produces publication output.
- **Data model**: columnar SoA + CSR graph (`buildGraph`), with per-node `degree`, `strength` (weighted degree), and optional app-provided `flow` (`buildGraph({ nodeFlow })`); a label-interning edge-list parser (`parseEdgeList`), a Pajek `.net` parser (`parsePajek`, supporting `*Vertices`/`*Arcs`/`*Edges`/`*Arcslist`/`*Edgeslist` with optional labels and coordinates), and a `parseNetwork(text, filename)` dispatcher (`.net` → Pajek, else edge list).
- **Node sizing**: `nodeRadius` takes a constant, a per-node `Float32Array`, a `(degree, index, graph) => radius` accessor (a d3 scale fits directly, fed the node's degree), or `{ by, scale }` to size by a metric — `"degree"`, `"strength"`, `"flow"`, or a custom `(index, graph) => value` accessor — through any d3 scale. Resolved once per `style()` with no per-frame or rendering cost (radius is already a per-instance GPU attribute), so degree/flow-scaled sizing holds at millions of nodes.
- **In-library force layout** (`layout({ backend: "force" })`): force-directed simulation with a Barnes-Hut quadtree (O(n log n)) and deterministic seeding, seeded by default via **multilevel coarsening** (heavy-edge matching) for faster convergence and fewer tangles on clustered graphs (opt out with `multilevel: false`).
- **Off-thread layout** (`layout({ backend: "worker" })`): runs the whole solve in a Web Worker and streams positions back for **progressive on-screen convergence** while the main thread stays responsive — zero-copy via `SharedArrayBuffer` on cross-origin-isolated pages, postMessage snapshots otherwise, with a synchronous fallback where Workers are unavailable. `stopLayout()` cancels; `whenSettled()` awaits convergence.
