---
"@mapequation/d3gl": patch
---

Label `font` and `color` now style every backend (#577). On `network.labels()` and on the plot/geoMap `labels()`, they used to style only the Canvas/SVG text and exports, while the WebGL overlay kept the default font and colour. Now one resolved font, colour and halo drive the overlay, the native text, every export and the label measurement. The order is the same in both engines: explicit `font`/`color` first, then `style.font`/`style.color`, then the default. A network label set styled only through `style.font` is now measured and drawn in that font on every backend. `resolveLabelText` and the `LabelText` type are exported from `@mapequation/d3gl/labels`.
