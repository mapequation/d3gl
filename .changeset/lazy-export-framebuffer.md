---
"@mapequation/d3gl": patch
---

The WebGL backend now allocates its PNG-export framebuffer lazily, on the first `toPNG()`,
instead of eagerly when the backend is created. Charts that never export no longer hold that
framebuffer's GPU memory: 8 bytes per CSS pixel, about 16.6 MB at 1920×1080 (RGBA8 colour plus
depth-stencil). Creating a WebGL backend, including the background upgrade in `backend: "auto"`, also
skips that allocation. `resize()` now frees the old framebuffer instead of reallocating it at the new
size on every resize step. Exports look the same: the target stays at CSS width×height at any
`devicePixelRatio`, and `clipTo` layers still clip in the PNG.
