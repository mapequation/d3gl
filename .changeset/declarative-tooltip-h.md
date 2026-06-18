---
"@mapequation/d3gl": patch
---

Add `h`, a tiny framework-free hyperscript helper exported from `@mapequation/d3gl/map`, for building rich tooltip / HTML-overlay content declaratively. The layer `tooltip` option accepts the returned `HTMLElement`, so `tooltip: (d) => h("div", null, [...])` replaces hand-rolled `document.createElement` ceremony. Children are always inserted as text nodes (never parsed as markup).
