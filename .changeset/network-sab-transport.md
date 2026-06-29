---
"@mapequation/d3gl": minor
---

Report which position transport the worker layout uses, so the `SharedArrayBuffer` zero-copy path is observable (#163):

- **`sharedMemoryAvailable()`** — new export: whether this environment can use the SAB zero-copy transport (`SharedArrayBuffer` exists and the page is cross-origin isolated via `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). The environment's *capability*, independent of any run.
- **`Network.layoutTransport`** (`"shared" | "copy" | "none"`) — new getter: the transport the *active* worker layout actually selected. `"shared"` = positions stream zero-copy through a `SharedArrayBuffer`; `"copy"` = posted as per-frame snapshots (also when the worker fell back to a synchronous main-thread solve); `"none"` = no worker-backed layout running.
- **`WorkerLayoutHandle.shared`** — new boolean on the handle returned by `startWorkerLayout`, backing the getter.

Layout behaviour is unchanged — the SAB path already self-selected at runtime; this only makes the selection inspectable.
