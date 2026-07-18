---
"@mapequation/d3gl": patch
---

Flags-only per-frame declutter style path: zoom/pan frames with `declutter` on no longer snapshot the full colour/flag tables (9 bytes per drawable allocated + uploaded per frame) — the Scene now hands backends a persistent typed flags view by reference via the new optional `Backend.updateLayerFlags`, so WebGL rewrites only the flags texture (1 byte per drawable) and Canvas/SVG patch their retained vector views in place instead of re-materializing them. Directly smoother zoom on large decluttered layers.
