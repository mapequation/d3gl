---
"@mapequation/d3gl": patch
---

Streaming `layout({ fit: true })` now keeps framing the layout until it settles, and frames it tightly ([#327](https://github.com/mapequation/d3gl/issues/327), [#309](https://github.com/mapequation/d3gl/issues/309)).

- **Programmatic view changes are no longer gestures.** d3-zoom emits `start`/`end` for the engine's own re-seeds (the `enableZoom` seed, and the re-seed after every `setTransform` or fit frame), and the engine treated them as a user gesture: a streaming fit was released on its first frame (the camera froze on the seed while the layout grew past it), and every programmatic `setTransform` cleared hover, re-pushed `hideOnInteraction` layers and, on Canvas/SVG networks, rebuilt the whole scene. Only events with a source input event are gestures now, on every engine. A real wheel/drag still takes over the view, and so does an explicit `setTransform` on a network (e.g. zoom-to-module), so neither a later frame nor the settle reframes away from it. `enableZoom()` now seeds the gesture silently: it no longer re-renders the unchanged view or calls its `onTransform` callback for it.
- **Tight fit box.** The fit frames the bounding box of the node positions, recomputed every streamed frame, padded by the largest node radius, and ignoring a handful of flung-out stragglers. It used to pad the top LOD modules' centroids by their median extent, which compounds up the tree and framed the layout 1.6–4.3× too loose, and with LOD off it computed the box once from the seed and never updated it.
