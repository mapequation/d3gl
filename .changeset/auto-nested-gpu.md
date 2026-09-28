---
"@mapequation/d3gl": patch
---

`layout({ backend: "auto", nested })` now lays the module map out on the GPU wherever `backend: "gpu"` would (#375, #355). Before, it always used the worker. It is the same batched GPU solve: a cold layout streams in as one animation of all depths, and a warm start or a transition (`nested: { warm: true }`, `transition`, the call an app makes after re-clustering) reads back only the final layout and eases to it. Where the device or the module tree is unsupported, the worker lays the map out with the same options and no warning, as the flat `"auto"` layout does. A GPU solve that fails (it throws while starting, or stops before its final harvest) still warns, and the worker lays the map out. The nested fallback warning now reads `[d3gl] the GPU nested layout fell back to the CPU worker: <reason>.`
