---
"@mapequation/d3gl": minor
---

Make the engines responsive to their parent and resize in place. `width`/`height` are now
optional on `plot()` / `geoMap()` (and the React `<Plot>` / `<GeoMap>`), with a new `aspectRatio`
option. Sizing is **responsive by default**:

- `aspectRatio` set → width-driven: fills the parent's width and keeps the ratio.
- nothing set → fill-parent: tracks the parent box (the parent supplies the height).
- both `width` & `height` → fixed: a static size (the previous behavior, unchanged).

In responsive modes the engine observes its host (a `ResizeObserver`, coalesced per animation
frame) and resizes **in place** via a new `setSize(width, height)` — no teardown, so the view
transform, layers, hover, and selection are preserved. A resized `geoMap` also refits its
projection to the new box (uniform resizes preserve the original framing exactly; an aspect-ratio
change re-letterboxes via the engine's own retained geometry). The React wrappers no longer
recreate the engine on a size change — they call `setSize` instead.
