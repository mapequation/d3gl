---
"@mapequation/d3gl": patch
---

Network LOD: module boundaries (#329).

`lod({ moduleBoundary: { width, color, opacity } })` draws a thin ring around every **expanded** module in view, so a map of nested modules stays readable as you zoom into it.

- **Where the ring goes.** After `layout({ nested })` a ring is that module's disc. It is kept as an offset from the members' centroid, so it follows them through a drag or a `transition`. After any other layout the ring is centred on the members, with their extent as its radius.
- **The disc is the module's LOD geometry.** Once a nested layout lands, the cut treats each module of the laid-out tree as its disc, with rings on or off: the collapsed glyph sits at the disc's centre, and the module is culled by the disc and expands once the disc's diameter on screen reaches `expandPx`. Before, it used its members' centroid and extent. A nested layout's disc is about 1.1-1.3 times its members' extent, so modules open at a slightly lower zoom (measured: the same frontier at most zooms of a 12k-node map, at most 2× at a threshold zoom). If a member leaves its disc (mid-`transition`, or dragged out), the extent grows to hold it, so nothing is culled too early.
- **One outline per module.** With `moduleBoundary` set, **collapsed** modules get the same line by default: `aggregateOutline` falls back to its `width`, `color` and `opacity` (at the usual gap outside the glyph), so a module keeps one outline whether it is collapsed or open. An explicit `aggregateOutline` still styles the collapsed ring separately, and `aggregateOutline: false` turns it off. `aggregateOutline` also gains `opacity`.
- **Width** is in the sizeMode's units, so in `screen` mode it is a constant pixel stroke.
- **Rendering.** Rings fade with `crossFade` and draw under every link and node. WebGL, Canvas and SVG draw them the same way, and `toSVG()`/`toPNG()` export them.
- **Anchored module links.** With `crossLevelEdges` on and module links (`data(graph, { modules, moduleLinks })`, e.g. an Infomap `.ftree`), a link whose endpoint is an expanded module is drawn from that module's ring with its flow, instead of disappearing once the module opens. It runs ring to ring when both ends are open, and between the two centres where the circles overlap (as centroid + extent rings often do), so the link is never dropped. Links derived from graph edges are unchanged, so nothing is counted twice. A raw network's output is byte-identical.
- **Per frame** a ring costs O(1) for each expanded module in view, which the cut visits anyway. The walk is the same with rings on or off, and there is no second pass. Anchoring adds those modules' own module links. None of it grows with the whole tree.

New exports:
- `CutOptions.boundaries`, where the cut collects those modules and leaves the frontier unchanged;
- `makeCutBoundaries`;
- `nestedBoundaryDiscs`, and a `discs` argument to `computeLODGeometry` that places each module on its disc;
- the `CutBoundaries` (with the rings' `radius`) and `BoundaryDiscs` types.

`LODTopology` gains the per-module link rows (`moduleLinkOffset` … `moduleLinkInFlow`).
