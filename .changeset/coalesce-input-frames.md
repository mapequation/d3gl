---
"@mapequation/d3gl": patch
---
Pan/zoom and node-drag input now draw once per animation frame instead of once per event. A burst of wheel ticks, a pan's mouse moves or a node drag's pointer moves records only the latest state; the engine then runs one frame at the latest transform, merged with any streamed layout frame that lands in the same frame. On a large network this turns a zoom gesture's one long task per wheel event (the LOD cut, declutter and super-edge gather ran inside every event handler) into one pass per frame, and drags no longer re-cut per pointer move. `enableZoom`'s `onTransform` fires once per drawn frame with the drawn view; `pick` answers against what is drawn; a programmatic `setTransform` still draws at once.
