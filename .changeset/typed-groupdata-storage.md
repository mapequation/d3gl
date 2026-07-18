---
"@mapequation/d3gl": patch
---

Typed GroupData storage (#207): the Scene's per-drawable tables (colors, flags, line widths) and vertex data now live in grow-on-append typed arrays instead of boxed `number[]`s; join/cap/miter-limit columns are omitted entirely while a whole layer uses the defaults; and path drawables no longer allocate an empty `circles` array each (1M path drawables used to allocate 1M empty arrays). `Scene.buffers()`, `Scene.styleTables()` and `Scene.appendedBuffers()` now hand out zero-copy LIVE views of that storage instead of fresh typed-array snapshots — consumers must not mutate them or retain them across drawable-set changes. Retained-Scene memory at 1M path drawables drops ~40% (990 → 589 B/drawable measured, GPU-ready form), and styles-only pushes (hover/selection restyles, the declutter fallback) stop allocating 9 bytes per drawable per call.
