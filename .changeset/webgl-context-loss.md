---
"@mapequation/d3gl": patch
---

A lost WebGL context no longer breaks the page (#599). The WebGL backend stops drawing and builds nothing while the context is gone, so luma.gl shows no shader-error overlay and nothing throws. When the browser gives the context back, the engine redraws the same layers, view and selection on a fresh WebGL backend. Data and style changes made while the context is gone are kept, so `toSVG()` exports them and the redraw shows them; `toPNG()` throws a clear error while the context is gone instead of returning a blank image. The new engine option `onContextUnrestored` is called once when the context has not come back after 10 s, or when it came back but the new WebGL backend could not be built. `setBackend("webgl")` while the context is lost rebuilds at once, and the replaced backend's context is released instead of staying alive until garbage collection.
