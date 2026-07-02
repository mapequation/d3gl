---
"@mapequation/d3gl": patch
---

network: GPU force-layout backend now reheats on node-drag, at parity with the CPU worker (#183, N8.5). Dragging a node on `layout({ backend: "gpu" })` pins the held set (skipped by the integrate pass but still repelling/anchoring its neighbours) and reflows the rest on the GPU; the layout is kept alive after convergence instead of destroyed, and releases + re-cools on drop. Physical-view drags of a state network reheat too.
