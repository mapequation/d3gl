---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` checks what the GPU layout needs before it runs, and its worker fallback keeps every layout option.

- **Capability checks (#351).** The GPU layout now runs only on a WebGL2 device with float render targets, float blending (`EXT_float_blend`) and a texture size large enough for the graph's position, CSR and spring textures, and whose float blending passes a one-time functional probe. Before, a device without float blending took the GPU path anyway and drew wrong forces. Anywhere else it falls back to the worker with one console warning that names the reason.
- **The fallback is the worker run (#312).** A fallen-back GPU layout gets exactly the options `backend: "worker"` gets: it honours `multilevel` (a cold start stays cold), and with `lod()` on the worker builds and streams the LOD tree, so the main thread no longer builds it (about 0.36 s on web-NotreDame) and refits it on every streamed frame (about 22 ms). State networks forward `multilevel` too.
- **Live transport (#297).** `layoutTransport` reports the transport that is running now: after a worker error falls back to a synchronous solve it no longer says `"shared"`, and after a GPU fallback it reports the worker's transport.
- **Portable readback.** Every GPU position readback (the layout's frames and the module-aware seed's levels) reads `RG/FLOAT` where the device reports that as its read format, and `RGBA/FLOAT` (which WebGL2 guarantees for float targets) elsewhere. Before, such a device got no positions back. Readback now writes straight into the positions buffer, which also takes an allocation and a copy off every streamed frame on devices that read `RG/FLOAT`.
