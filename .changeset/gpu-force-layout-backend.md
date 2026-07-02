---
"@mapequation/d3gl": patch
---
network: add a GPU force-layout backend (`layout({ backend: "gpu" })`) — a WebGL2 Barnes-Hut grid-pyramid many-body solve streamed back into the existing render path, with automatic fallback to the CPU-worker backend when WebGL2 float render targets are unavailable. Milestone A of #106 (GPU layout).
