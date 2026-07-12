---
"@mapequation/d3gl": patch
---

`network.labels()` now styles itself: a built-in default label look (dark 11px sans-serif with a white text-shadow halo) applies to the HTML overlay with zero CSS, and backend-native text (SVG `<text>` / Canvas `fillText`, incl. export) defaults to the matching `font`/`color`/`halo`. New `style` option — an inline CSS-properties object merged over the default, so a partial override like `style: { color: "#1f2937" }` keeps the rest — while `className` becomes the advanced path: providing it skips the built-in default so your class's CSS keeps full control. Styling is applied once per label element at creation, never on the per-frame placement path. `@mapequation/d3gl/labels` exports the new `LabelStyle` type, `DEFAULT_LABEL_STYLE`/`DEFAULT_LABEL_TEXT`, and the `resolveLabelStyle` policy; `LabelLayer` takes an optional `style` argument applied verbatim (a raw `LabelLayer` without it stays unstyled and inherits from its container, exactly as before).
