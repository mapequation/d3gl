---
"@mapequation/d3gl": patch
---

network: state networks now honour `layout({ fit: true })`. A streaming (`worker` / `gpu`) state-network
layout is framed by the **camera** as it converges — released on settle/interaction — instead of the
internal `scaleToViewport` position-remap, so it opens framed and converges in place (no top-left flash
or settle snap on the GPU backend, whose solver centres at the origin). Sizing is unaffected: containers
and rosettes are scale-relative, so the physical/state/both views and pie glyphs keep their proportions.
The `force` / `positions` backends are unchanged.
