# d3gl Documentation Site — Design

**Date:** 2026-06-03
**Status:** Approved (pending written-spec review)

## Goal

Replace the React example app on GitHub Pages with an [Astro Starlight](https://starlight.astro.build)
documentation site: a feature landing page, a canonical Getting Started, an
Examples section of de-React'd live demos (visualization + source), and a
per-module API Reference. The `examples/app` package is removed.

## Architecture & placement

- New **private** workspace package **`website/`** (`@d3gl/website`), Astro +
  `@astrojs/starlight`. Replaces and deletes `examples/app`.
- **Scaffold via the official command** to pull the latest Astro + Starlight:
  `pnpm create astro@latest website -- --template starlight` (run from the repo
  root), then adapt it into the workspace — set the package name to
  `@d3gl/website` and `private: true`, add the Vite alias and `base` path,
  reconcile the pinned dependency versions with the monorepo. Do **not**
  hand-pick versions; take what the template installs.
- The site consumes d3gl by **aliasing each subpath to source** in the Astro
  Vite config — `@mapequation/d3gl` → `packages/d3gl/src/core/index.ts`,
  `@mapequation/d3gl/<m>` → `packages/d3gl/src/<m>/index.ts` (the same alias the
  old example app used). No library rebuild needed for docs dev.
- **API reference tooling:** `typedoc` + `starlight-typedoc`.
- **GitHub Pages:** `pages.yml` builds `website` instead of `examples/app`.
  Astro config sets `site: "https://mapequation.github.io"`, `base: "/d3gl/"`.
- Root `dev` script points at `website`; `examples/app` is removed from the
  workspace and root scripts.

## Site structure (Starlight sidebar)

```
Landing (splash)                 hero + tagline, [Get started] [View on GitHub], feature cards
Start Here
  Getting started                canonical: intro, install, modules, quick start
Examples
  Tree
    Phylogenetic tree            simple
    Ancestral ranges             complex
  Map
    World map                    simple (land/water)
    GeoJSON features             land/water + lines + points + city labels + a polygon
    Heatmap                      grid clipped to land, hover value
Reference
  core / canvas / webgl / svg / geo / labels / map / react   (hybrid pages)
Contributing                     one-line summary + link to CONTRIBUTING.md
```

## Landing page (Starlight `splash` template)

- Hero: project name; one-line tagline ("GPU-accelerated rendering for d3 —
  SVG / Canvas2D / WebGL2 from one API"); two actions: **Get started** →
  Getting started, **View on GitHub** → repo.
- Feature cards drawn from d3gl's real strengths:
  - *Familiar d3 contexts* — context-driven d3 generators render unchanged
  - *Three backends, one API* — SVG / Canvas2D / WebGL2, switchable
  - *Project & tessellate once* — pan/zoom is one transform uniform
  - *GPU recolor & picking* — recolor/show-hide is one texture write
  - *GeoJSON & maps* — project any GeoJSON with any d3 projection
  - *Publication export* — PNG and SVG output

## Examples architecture

### Example module contract (vanilla, no framework)

Each example lives in `website/src/examples/<name>/` and exports:

```ts
export interface ExampleOptions {
  backend: "webgl" | "canvas" | "svg";
  // example-specific options (e.g. layout, curve, coords); see per-example table
  [key: string]: unknown;
}

export interface ExampleHandle {
  dispose(): void;        // tear down listeners / GPU resources
  // Export the current rendering. The format matches the active backend:
  // "svg" backend → SVG markup; "webgl"/"canvas" → PNG data URL.
  exportImage(): { format: "svg" | "png"; data: string };
}

export function mount(el: HTMLElement, opts: ExampleOptions): ExampleHandle;
```

- **De-React:** Bioregions' React `GeoMap` becomes the imperative `geoMap()`
  engine; the tree examples already use the imperative `plot` engine and are
  ported off React state. No React anywhere in `website/`.
- On a backend or example-specific control change, the frame calls
  `handle.dispose()` and re-mounts with new `opts` (simple, predictable).

### `<ExampleFrame>` component (Astro, framework-free)

A shared `ExampleFrame.astro` renders three parts and wires them with a client
`<script>` (no UI framework island — pure Astro + hoisted client script using
`import.meta.glob` to resolve the example module by `id`):

1. **Live canvas** — a target `<div>` the client script mounts the example into
   (hydrated lazily, equivalent to `client:visible`).
2. **Control bar** — left-to-right:
   - **Perf readout** (FPS / frame time / JS heap) — a vanilla `perfMeter(el)`
     rAF loop, ported from the old `Stats` component, shown in **every** example.
   - Universal **`webgl / canvas / svg`** segmented switch.
   - A **single export button** tied to the active backend: labelled
     **"Export SVG"** for the `svg` backend and **"Export PNG"** otherwise; it
     calls `handle.exportImage()` and triggers a download.
   - Any **example-specific toggles** (see table).
3. **Code panel** — browser-like **file tabs**; each tab's content is the
   **`?raw` import of the exact source file** that runs the demo (single source
   of truth). A **copy-to-clipboard** icon appears top-right **on hover**.

Controls are **plain HTML + scoped CSS** built with a tiny shared `controls.ts`
helper (segmented buttons, toggles, sliders). Styling is clean and consistent
across examples.

### Per-example specifics

| Example | Dataset / interactions | Example-specific controls |
|---|---|---|
| **Phylogenetic tree** | small tree; **no hover, no zoom**; simplest possible code | none |
| **Ancestral ranges** | full tree; thickness, **final** ancestral ranges, and pies **always on** (no toggles) | **rect/radial**, **linear/step/bump**, **screen/world** |
| **World map** | land/water only | none |
| **GeoJSON features** | land/water + lines + points + **city labels** + one extra polygon (shows every feature type), rendered statically | none |
| **Heatmap** | grid **clipped to land**; **hover → value**; **zoom/pan** | **cell-size** slider (1°/2°/4°/8°) |

All examples additionally share (from the control bar): the `webgl/canvas/svg`
switch, the backend-aware export button, and the perf readout.

### Shared example data/util

The example-only data and utilities move from `examples/app/src/examples` into
`website/src/examples/shared/`: `mammals-data`, `parsimony`, `tree`, `layout`,
a geo data module (world-atlas land/water + cities + demo polygon), and a
heatmap-grid generator. Their existing **vitest unit tests** (`parsimony`,
`layout`, `mammals-data`) move with them and keep running; the root
`vitest.config.ts` `include`/`exclude` globs change from `examples/*` to
`website/*`.

## Getting Started, README & Reference

- **Getting Started is canonical** (intro, install, modules, quick start),
  authored as MDX in the site.
- **README is trimmed** to a short overview + badges + two links (→ docs site
  for users, → `CONTRIBUTING.md` for contributors). The README **`Development`
  and `Releases` sections are removed** — `CONTRIBUTING.md` is the single source
  for dev setup, tests, and releases.
- **Reference is hybrid**: `starlight-typedoc` generates each module's API from
  TSDoc; each module page is topped with a **hand-written overview + a short
  runnable example** (via TypeDoc's per-entry README), so curated intro sits
  above the generated symbol reference. One page per module: `core`, `canvas`,
  `webgl`, `svg`, `geo`, `labels`, `map`, `react`.
- The **Contributing** sidebar entry is a one-line summary linking to
  `CONTRIBUTING.md` on GitHub (not a copy).

## Directory layout

```
website/
  package.json            @d3gl/website (private); astro, @astrojs/starlight,
                          starlight-typedoc, typedoc, d3-*, world-atlas,
                          topojson-client, @mapequation/d3gl (workspace:*)
  astro.config.mjs        starlight integration, site/base, sidebar,
                          vite alias → d3gl source, starlight-typedoc plugin
  tsconfig.json
  typedoc.json            entryPoints = the 8 module index.ts files
  src/
    content/docs/
      index.mdx                          landing splash
      start-here/getting-started.mdx
      examples/tree/phylogenetic-tree.mdx
      examples/tree/ancestral-ranges.mdx
      examples/map/world-map.mdx
      examples/map/geojson-features.mdx
      examples/map/heatmap.mdx
      reference/<module>.mdx             hand-written wrappers (TypeDoc fills API)
      contributing.mdx
    components/
      ExampleFrame.astro                 island + control bar + code tabs
      controls.ts                        vanilla control helpers
      perf.ts                            vanilla perf readout (ported Stats)
    examples/
      phylogenetic-tree/index.ts
      ancestral-ranges/index.ts
      world-map/index.ts
      geojson-features/index.ts
      heatmap/index.ts
      shared/{mammals-data,parsimony,tree,layout,geo-data,heatmap-grid}.ts
      shared/*.test.ts
```

## CI / build / testing

- `pages.yml` builds the Astro site (`base: /d3gl/`).
- `ci.yml` gains an **`astro build` smoke** step (catches broken MDX / imports /
  TypeDoc generation).
- Existing Node and browser test suites are unaffected; the migrated
  example-util unit tests keep running under the updated `website/*` globs.

## Out of scope (future)

- Editable in-browser playgrounds (Sandpack/StackBlitz).
- Additional d3-ported examples ("typical d3 examples ported to d3gl").
- The Infomap-bioregions clustering example.
