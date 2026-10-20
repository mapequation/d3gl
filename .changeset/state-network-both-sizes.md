---
"@mapequation/d3gl": patch
---

The state network's both view sizes its state nodes as the state view does (#509):

- **State nodes at the state view's size.** In the both view each state node is drawn at the radius your `nodeRadius` spec gives it (constant, by flow, by degree) and in your `sizeMode`, world or screen. Before, every state node of a physical node got the same world-sized radius and ignored both.
- **Physical nodes enclose their state nodes.** Each physical node packs its state nodes by area, largest first, without overlaps, and is centred on and sized to the smallest circle enclosing them, in the same units. Under `sizeMode: "screen"` state nodes and physical nodes keep their pixel size at every zoom, so neighbouring physical nodes can overlap when zoomed out, as screen-sized nodes do. The physical layout does not yet space physical nodes by their size.
- **Zooming stays free.** In screen mode the WebGL renderer adds each state node's offset after projecting its physical node, so a zoom frame uploads nothing, as for any other network. Canvas and SVG re-place the state nodes when a gesture ends, as they do for other screen-sized geometry.
- Hover, click, marquee, the highlight rings, labels and a state node drag hit the state nodes where they are drawn, on WebGL, Canvas and SVG. A state node drag in screen mode uploads only the moved state node's offsets.
- The instanced circle, line, arrow and half-arrow layers take optional per-instance `offsets` / `sourceOffsets` / `targetOffsets` in the layer's size units. The unreleased `radiiWorld` flag on the arrow layers is gone: the both view's arrowheads now meet nodes in the layer's own units.
- Fix: `interactive({ selectable: true })` selects on click on Canvas and SVG, and `interactive({ draggable: true })` starts a node drag there, without an `on("click")` handler.
