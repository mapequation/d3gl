---
"@mapequation/d3gl": patch
---

A lost WebGL context no longer breaks the page (#599). The WebGL backend stops drawing and builds nothing while the context is gone, so luma.gl shows no shader-error overlay and nothing throws. When the browser gives the context back, the engine redraws the same layers, view and selection on a fresh WebGL backend. The new engine option `onContextLost` is called once when the context has not come back after 10 s.
