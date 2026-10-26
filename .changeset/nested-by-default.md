---
"@mapequation/d3gl": minor
---

A network with a module hierarchy now lays out as its map of modules by default: `layout()` on `"force"`, `"worker"`, `"gpu"` or `"auto"` is `nested` unless `nested` is given (#566). Pass `nested: false` for the flat layout (the module-aware force seed). `"positions"`, graphs without a hierarchy, and state networks are unchanged.
