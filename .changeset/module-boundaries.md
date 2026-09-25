---
"@mapequation/d3gl": patch
---

Network LOD: module boundaries (#329).

`lod({ moduleBoundary: { width, color, opacity } })` draws a thin ring around every **expanded** module in view, so a map of nested modules stays readable as you zoom into it.

- **Where the ring goes.** After `layout({ nested })` a ring is that module's disc. It is kept as an offset from the members' centroid, so it follows them through a drag or a `transition`. After any other layout the ring is centred on the members, with their extent as its radius.
- **Width** is in the sizeMode's units, so in `screen` mode it is a constant pixel stroke.
- **Rendering.** Rings fade with `crossFade` and draw under every link and node. WebGL, Canvas and SVG draw them the same way, and `toSVG()`/`toPNG()` export them.
- **Anchored module links.** With `crossLevelEdges` on and module links (`data(graph, { modules, moduleLinks })`, e.g. an Infomap `.ftree`), a link whose endpoint is an expanded module is drawn from that module's ring with its flow, instead of disappearing once the module opens. It runs ring to ring when both ends are open. Links derived from graph edges are unchanged, so nothing is counted twice. A raw network's output is byte-identical.
- **Per frame** the cost is the expanded modules in view, which the cut already visits, plus their own module links. It never grows with the whole tree.

New exports:
- `CutOptions.boundaries`, where the cut collects those modules and leaves the frontier unchanged;
- `makeCutBoundaries`;
- `nestedBoundaryDiscs`;
- the `CutBoundaries` and `BoundaryDiscs` types.

`LODTopology` gains the per-module link rows (`moduleLinkOffset` … `moduleLinkInFlow`).
