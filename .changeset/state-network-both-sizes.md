---
"@mapequation/d3gl": patch
---

The state network's both view sizes its nodes by your `nodeRadius` spec and `sizeMode` (#509):

- **State nodes sized by the state view's spec.** In the both view each state node is sized by the radius your `nodeRadius` spec gives it (constant, by flow, by degree) and in your `sizeMode`, world or screen. Before, every state node of a physical node got the same world-sized radius and ignored both. Each physical node packs its state nodes by area, largest first, without overlaps.
- **World mode: physical nodes at the physical view's size.** Under `sizeMode: "world"` each physical node is drawn at the radius the physical view gives it, and its state nodes are scaled by one factor to fit inside it, keeping the state view's ratios, with a gap of a tenth of its radius. Switching between the physical and both views keeps every physical node's size and place.
- **Screen mode: physical nodes enclose their state nodes.** Under `sizeMode: "screen"` each state node is drawn at the state view's pixel size, and each physical node is centred on and sized to the smallest circle enclosing its state nodes. Both keep their pixel size at every zoom, so neighbouring physical nodes can overlap when zoomed out, as screen-sized nodes do.
- **Zooming stays free.** In screen mode the WebGL renderer adds each state node's offset after projecting its physical node, so a zoom frame uploads nothing, as for any other network. Canvas and SVG re-place the state nodes when a gesture ends, as they do for other screen-sized geometry.
- `net.positions` in the both view: under `sizeMode: "world"` where the state nodes are drawn; under `"screen"` each state node's physical node position, since its offset is in px and depends on the zoom.
- Hover, click, marquee, the highlight rings, labels and a state node drag hit the state nodes where they are drawn, on WebGL, Canvas and SVG. A state node drag in screen mode uploads only the moved state node's offsets.
- The instanced circle, line, arrow and half-arrow layers take optional per-instance `offsets` / `sourceOffsets` / `targetOffsets` in the layer's size units. The unreleased `radiiWorld` flag on the arrow layers is gone: the both view's arrowheads now meet nodes in the layer's own units.
- Fix: `interactive({ selectable: true })` selects on click on Canvas and SVG, and `interactive({ draggable: true })` starts a node drag there, without an `on("click")` handler.
