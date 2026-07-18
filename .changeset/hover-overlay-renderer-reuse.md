---
"@mapequation/d3gl": patch
---

WebGL `updateLayer` now updates an existing layer's renderer IN PLACE instead of destroying and reconstructing it (GrowBuffers, GrowTextures, Models/pipelines — ~10 GPU objects) on every call. The hover overlay calls `updateLayer` on every hover-target change, so a hover sweep across glyphs no longer churns GPU objects per pointer event: geometry and tables are rewritten through the retained buffers/textures (growing and rebinding only on capacity overflow), and a full rebuild remains only for structural changes (a geometry-type pass appearing that the renderer was built without). Hover-out/hover-in keeps the renderer alive with empty passes. Measured on a 150-change hover sweep: 150 → 0 renderer constructions, ~3.4 ms → ~0.15 ms median per hover change.
