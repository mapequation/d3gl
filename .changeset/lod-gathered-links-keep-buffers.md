---
"@mapequation/d3gl": patch
---
Network LOD keeps the gathered link layers' GPU buffers through a frame that gathers no link (a cut of kept leaves, or a view with nothing on it), instead of destroying them and rebuilding them on the next frame that gathers one.
