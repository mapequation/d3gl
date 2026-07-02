---
"@mapequation/d3gl": patch
---

Add in-place GPU buffer update path to `InstancedLines`, `InstancedArrows`, and `InstancedHalfArrows` (#179). Layout-animation frames (force-directed convergence) now call `bufferSubData` for link/arrow endpoint buffers instead of destroying+recreating the GPU objects on every frame. At 100k nodes + 600k edges with LOD off, this eliminates the per-frame buffer teardown overhead that dominated render time (~446ms/frame). `updateInstancedLayer` now takes the in-place path for all four instanced primitives; falling back to recreate only when a structural property changes (vertex template `samples`, arrow `half` flag) or the primitive type itself changes.
