---
"@mapequation/d3gl": patch
---

network: cache the no-LOD per-instance `selected` flag columns per selection version, so layout-streaming and drag position frames skip rebuilding the flags (O(nodes)+O(edges) Uint8Array churn) and skip their per-layer Float32 conversion + GPU re-upload (~80 MB/frame at 10M directed edges across lines + arrows) while the selection is unchanged. A selection change still refreshes the flags in place, and a fresh layer registration (backend switch) still seeds them.
