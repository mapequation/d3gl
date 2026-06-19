---
"@mapequation/d3gl": patch
---

Make screen-space glyph `declutter` scale to very large node counts. The per-zoom cull
ran on every transform but rebuilt transform-independent work each frame and materialized
the full vector view twice. It now:

- caches the anchor grouping on the Scene (built once per layer, reused every frame);
- bins with a reused flat typed-array grid + intrusive linked list (no per-frame `Map`
  or bucket allocation), bounded to the viewport plus a one-cell margin;
- writes visibility flags in place; and
- skips the export-only `drawables()` rebuild on WebGL while interacting (the new optional
  `Backend.updateLayerStyles` `drawables` arg + `stylesNeedDrawables` capability — Canvas/SVG
  render from the vector view and still receive it; the settle frame refreshes it for `toSVG`).

At 131k screen-mode nodes a full zoom frame drops from ~33ms to ~8ms; cull output is
unchanged (verified against a brute-force reference).

Also fixes declutter not being applied on the first draw — it now runs before the initial
upload, not only after the first zoom/pan.
