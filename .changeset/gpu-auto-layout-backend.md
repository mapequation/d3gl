---
"@mapequation/d3gl": patch
---

Network layout: new `layout({ backend: "auto" })` runs on the GPU where it can and on the worker everywhere else (#375).

- `"auto"` takes the GPU solve wherever `backend: "gpu"` would run it: a WebGL render backend whose device has float render targets, float blending (`EXT_float_blend`) and textures large enough for the graph. Anywhere else it runs the worker layout that `backend: "worker"` would start, with the same options (`multilevel`, LOD tree streaming). Unlike `"gpu"`, it prints no warning when it takes the worker, because that is an expected outcome. A GPU run that fails rather than being unsupported (for example a driver error while it starts) still warns.
- The rest of the engine treats `"auto"` exactly like the backend it resolved to: `fit`, node-drag reheat, state networks, `nested` layouts (on the worker until a GPU nested path exists), `transition` (ignored, as by the other streaming backends) and LOD streaming. `net.layoutTransport` reports which transport runs.
- The default does not change: omitting `backend` behaves as before.
- The GPU fallback warning now reads `[d3gl] the GPU network layout fell back to the CPU worker: <reason>.`
