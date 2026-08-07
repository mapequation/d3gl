# Interaction: hover highlight, click selection, tooltips

**Date:** 2026-06-11
**Status:** Approved design, pre-implementation

Interactive styling for retained layers: a `click` event, per-drawable style
overrides with a styles-only render path, a stateful `select()` with
complement dimming, an engine-managed hover highlight (style object or custom
draw), a core tooltip helper, and clip-aware picking. Driven by two website
examples: tooltips on the GeoJSON-features map, and the Heatmap example remade
as a Highlight example.

## Problem

The engine already picks (`HitIndex`, CPU ray-cast per layer) and fires
`on("hover")`, and the `Scene` keeps hot-swappable per-drawable RGBA/flag
tables. But:

- There is **no public per-drawable style API**. The only restyle path is
  `recolor(name)`, which re-runs the layer's accessors over all data AND calls
  `Scene.buffers()` — an O(total-vertices) typed-array rebuild — per call.
  Unusable per pointermove on dense layers.
- There is **no click event**, so selection interactions can't be built
  without userland pointer bookkeeping that fights d3-zoom/versor drags.
- There is **no highlight concept**: highlighting the hovered cell of a 16k+
  cell grid by recoloring would touch the base layer per mousemove; every user
  would invent their own (inefficient) variant.
- Tooltips are ~15 lines of hand-rolled positioned-div boilerplate per example
  (see `website/src/examples/heatmap/draw.ts`).
- `pick()` ignores `clipTo`: a layer clipped to the land outline still
  hit-tests on its full geometry, so the heatmap shows tooltips over open
  ocean where nothing is visible.

## Goal

- Sweeping the pointer fast across a dense grid highlights cells with **no
  fps drop**: O(one feature) per hover change, zero work while the pointer
  stays inside one drawable, zero per-frame cost.
- Click-selection with dim-others costs one O(n)-byte-writes pass + one small
  GPU table upload at click time only. No re-tessellation, no vertex-buffer
  rebuild, no shader changes.
- The user can fully customize the hovered item's rendering with a draw
  function at the same cost.
- Identical behavior on all three backends (WebGL, Canvas, SVG).

## Public API

All additions live on `BaseEngine`/`GeoMap` (`packages/d3gl/src/map/`) plus
three new `LayerOptions` keys. No breaking changes.

### Types

```ts
/** Bulk per-drawable override: colors only (stroke geometry has its width
 *  baked in at tessellation time, so bulk width changes would be O(n)
 *  re-tessellation — widths are hover-overlay-only). */
interface StyleOverride {
  fill?: string;     // replaces the base fill (CSS color)
  stroke?: string;   // replaces the base stroke
  opacity?: number;  // multiplies the base alpha (0..1) — dimming keeps hue
}

/** Style for highlight-overlay geometry. lineWidth IS allowed here because
 *  only one item is re-tessellated per hover change. */
interface HighlightStyle {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /** Circle drawables only: multiply the point radius (default 1). */
  radiusScale?: number;
}

/** Builder passed to a custom hover draw fn, scoped to the hovered drawable.
 *  Everything recorded goes into the internal overlay group (drawn on top,
 *  inheriting the source layer's clipTo/sizeMode). World coordinates. */
interface HighlightBuilder {
  /** Re-emit the hovered drawable's geometry with new styling — uses the
   *  already-projected subpaths/circles stored in the Scene (no re-projection,
   *  no datum re-processing). */
  replay(style?: HighlightStyle): void;
  /** Record an arbitrary path (the standard PathContext: moveTo/lineTo/arc/…). */
  path(draw: (ctx: PathContext) => void, style?: HighlightStyle): void;
  /** A filled circle at world (x, y). */
  point(x: number, y: number, radius: number, style?: { fill?: string }): void;
  /** The drawable's projected anchor: its glyph anchor, or a point feature's
   *  projected center. Null for plain path drawables. */
  anchor: [number, number] | null;
}

type HoverOption<F> =
  | true                                    // default style (see below)
  | HighlightStyle                          // sugar for (d, g) => g.replay(style)
  | ((datum: F, g: HighlightBuilder) => void);

interface SelectionOption {
  /** Style for the selected set. Default: keep base style (they stand out
   *  because the others dim). */
  selected?: StyleOverride;
  /** Style for the complement. Default: { opacity: 0.3 }. */
  others?: StyleOverride;
}
```

`hover: true` defaults: path drawables → `replay({ stroke: "#fff",
lineWidth: 1.5 })`; circle drawables → a stroked ring just outside the dot
(`path` + `arc` at radius × 1.3, stroke `#fff`, lineWidth 1.5 — circles
themselves are fill-only).

### Layer options (declarative)

```ts
map.layer("cells", geoms, {
  fill: (c) => heat(c.value),
  clipTo: "land",
  hover: { stroke: "#fff", lineWidth: 1.5 },
  tooltip: (c) => `value ${c.value.toFixed(3)}`,   // string | HTMLElement | null
  selection: { others: { opacity: 0.3 } },
});
```

All three are retained in `GeoMap.defs` like every other layer option, so they
survive projection switches and rotation rebuilds. Style configuration lives
where the layer is declared; the imperative calls below carry no style
arguments (decision: a flat `selection: {...}` meaning "selected" was
considered and rejected — ambiguous about which side it styles, and the common
case is dimming `others`).

### Events

```ts
map.on("hover", (hit: HoverHit | null, ev: PointerEvent) => void);  // existing
map.on("click", (hit: HoverHit | null, ev: PointerEvent) => void);  // NEW
```

`click` fires on pointerup when the pointer moved ≤ 4 px since pointerdown —
so d3-zoom pans and versor rotation drags never fire it. `hit` is the same
topmost-layer pick as hover; `null` when nothing pickable is under the cursor.

### Imperative methods

```ts
// Style override primitives (O(ids) writes + one styles-only push):
map.setStyle("cells", idOrIds, { opacity: 0.3 });
map.clearStyle("cells", idOrIds?);     // omit ids → restore the whole layer

// Stateful selection sugar built on the primitives:
map.select("cells", ids | predicate);  // predicate: (datum, i) => boolean
map.select("cells", null);             // clear → restores base styles

// Hover-highlight primitive (the `hover` option wires pointermove to this):
map.highlight("cells", id | ids | null, styleOrDraw?);
// styleOrDraw?: HighlightStyle | ((datum, g: HighlightBuilder) => void);
// omitted → the layer's `hover` option (or the default style).
```

### Engine option

```ts
geoMap(host, { ..., tooltipClass?: string });
```

When set, replaces the tooltip's default inline look (the website passes its
Tailwind classes). The tooltip div always carries class `d3gl-tooltip`.

## Internals

### Unified pointer pipeline

One internal `pointermove` handler does a single `pick()` and feeds three
consumers: the user's `hover` callback, auto-highlight, and the tooltip. The
listener is attached when any of the three is registered. Guards:

- While `interacting` (drag/zoom/rotation): skip picking entirely; clear any
  active highlight + tooltip at gesture start.
- When the picked `(layer, id)` is unchanged: only move the tooltip (style.left/top
  writes); no highlight work. Sweeping inside one cell costs ~nothing.
- `pointerleave`: clear highlight, hide tooltip, fire `hover(null)` (existing).

### Style overrides + styles-only render path

- The engine keeps per-layer override state: `Map<id, StyleOverride>` on the
  spec. Base colors remain whatever the layer's `fill`/`stroke` accessors
  produce.
- Composition on write: effective fill/stroke RGBA = override color (or base)
  with alpha × opacity, written into the existing Scene color tables via
  `setFill`/`setStroke`. Composing one id needs its base color, i.e. its datum
  index — add a per-layer `Map<id, index>` next to the existing `layerIds`
  Set (`base-engine.ts:51`).
- `applyAccessors` (which resets the tables on every rebuild —
  `base-engine.ts:470`) re-applies overrides afterward, so overrides survive
  `setProjection`/rotation rebuilds. Re-registering a layer via
  `map.layer(name, ...)` drops overrides and selection (ids change).
- **New cheap path**: `Scene.styleTables(name)` returns
  `{ fillColors, strokeColors, flags }` as typed arrays — O(drawableCount),
  4 bytes per drawable, never the O(total-vertices) `Scene.buffers()`.
  New backend method `updateLayerStyles(name, tables)`:
  - **WebGL**: `GroupRenderer.updateColors` with just the tables (the texture
    rewrite already exists; today it's only reachable through `updateLayer`,
    which forces a full `buffers()` build at the engine layer).
  - **Canvas**: patch the stored layer's `DrawableVector` colors and redraw
    (a full redraw is canvas's normal frame cost).
  - **SVG**: update stored drawables, mark dirty, lazy re-serialize.
- `recolor(name)` keeps its semantics but switches to the styles-only path
  (accessor re-run + `styleTables` + `updateLayerStyles`) — its current
  `Scene.buffers()` call is wasted work even today, since geometry can't have
  changed under it.

### Selection

`select(layer, set, /* styles from the layer's selection option */)`:

1. Resolve `set` to an id Set (ids array, or predicate run over `spec.data`).
2. Clear previous selection overrides for the layer.
3. Write `selected` override for members, `others` for the complement, in one
   pass over the layer's drawables; one `updateLayerStyles` push.
4. `select(layer, null)` clears all selection overrides and pushes.

Selection state is per layer and re-applied after rebuilds (same hook as
overrides). Manual `setStyle` calls compose independently of selection only in
the sense that `select(null)` restores them too if they overlap — overrides
are one table; last write wins. Documented; not worth two override layers.

### Hover highlight overlay

- One internal Scene group + RenderLayer per highlighted source layer, named
  `"<layer>:highlight"` (the `:` suffix is reserved; user layer names with
  `:highlight` are rejected). It inherits the source layer's `clipTo` and
  `sizeMode`, is rendered after all user layers (top), is not pickable, and
  never appears in `specs`/`defs`.
- On highlight change: rebuild the group — for each highlighted id, run the
  custom draw fn (or the implied `replay(style)`), where `replay` copies the
  drawable's stored subpaths/circles from the Scene (`Scene.drawables` already
  exposes them) into the overlay group. Cost = tessellate ONE feature (a grid
  cell ≈ 2 triangles fill + a thin stroke ring) + one tiny
  `backend.updateLayer` for the overlay layer only. The base layer's buffers
  are untouched.
- `backend.updateLayer` already handles changed-drawable-count layers by
  rebuilding just that layer's renderer, and registers unseen names at the end
  of the draw order — exactly the overlay's need (`webgl-backend.ts:91-106`).
  A small follow-up inside the WebGL backend may reuse the overlay's
  `GroupRenderer` buffers between hover changes; not required for v1 (the
  buffers involved are a few hundred bytes).
- `highlight(layer, null)` empties the group. Gesture start clears it.
- Rotation/projection rebuilds re-resolve the highlighted ids against the new
  Scene; ids that no longer exist are dropped.

### Clip-aware picking

In `BaseEngine.pick()` (`base-engine.ts:428`): when a spec has `clipTo`, a hit
in that layer must ALSO hit the clip-source layer's hit index (point-in-fill
test on e.g. "land"). If the clip source has `pickable: false` (no index), the
check is skipped — documented. This makes hover/click match what is visibly
painted, and makes "click outside deselects" work when a clipped grid covers
the whole globe.

### Tooltip

Lazily created singleton div in the host: `position: absolute`,
`pointer-events: none`, hidden by default, class `d3gl-tooltip`, default
inline style (white/translucent card, 1px border, 12px font, 2px 6px padding)
unless `tooltipClass` is set. On hover over a layer with a `tooltip` accessor:
fill (`textContent` for strings, `replaceChildren` for elements; `null` hides),
position at pointer + 12 px offset, clamped to the host rect. Removed on
`destroy()`.

## Performance model

| Operation | Cost | When |
| --- | --- | --- |
| Pointer move within one drawable | pick + tooltip reposition | per move |
| Hover crosses into a new drawable | tessellate 1 feature + tiny upload + render | per change |
| `select()` / `setStyle` bulk | O(n) byte writes + table upload (n×8 B) + render | per click |
| Gesture frames (pan/zoom/rotate) | unchanged — interaction pipeline is bypassed | — |
| Layer rebuild (projection/rotation) | unchanged + O(overrides) re-apply | existing cost |

No new per-frame work anywhere; no shader changes; no vertex-buffer changes.

## Website examples

### geojson-features (additions)

- Move `centreCells()` from `map-projections/draw.ts` to `shared/geo-data.ts`;
  add a `cells` layer (viridis fill, `clipTo: "land"`), declared right after
  `land` so rivers/route/cities render and pick above it.
- `makeMajorRivers()` changes to return named `Feature<LineString>[]`
  (Amazon, Nile, Mississippi, Yangtze, Congo, Volga, Ganges) with
  `properties.name`; the rivers layer gets per-feature ids. `buildParents()`
  and the shared tests update to the new shape.
- Tooltips: cells → `value x.xxx`; cities → name; rivers → name;
  region → "Sahara box (demo region)"; route → "London → New York → Tokyo";
  cluster → "Cluster (MultiPoint)".
- City labels (LabelLayer) stay as-is.

### heatmap → highlight (remake)

- Rename `website/src/examples/heatmap/` → `highlight/`, `Heatmap.tsx` →
  `Highlight.tsx`, and `content/docs/examples/map/heatmap.mdx` →
  `highlight.mdx` (title "Highlight"; URL slug changes with it).
- The hand-rolled tooltip div and `on("hover")` wiring are replaced by the
  core `hover` + `tooltip` options.
- Cells layer: `hover: { stroke: "#fff", lineWidth: 1.5 }`,
  `tooltip: (c) => …value…`, `selection: { others: { opacity: 0.3 } }`.
- Click: on a cell → `map.select("cells", (c) => Math.abs(c.value - v) <= 0.1)`
  where `v` is the clicked cell's value; anywhere else → `map.select("cells",
  null)`. (Clip-aware picking makes ocean clicks land on "not a cell".)
- Cell-size slider and zoom stay; slider re-registration clears the selection
  (ids change), which matches user expectation for a new grid.

### Docs

New docs page "Interaction" under the map guide: `on("hover"/"click")`,
`hover`/`tooltip`/`selection` layer options, `select`, `setStyle`/`clearStyle`,
`highlight` + `HighlightBuilder`, `tooltipClass`, clip-aware picking, and the
performance model table. (House rule: new core features get user-facing
website docs.)

## Testing

TDD; browser tests run via the `test:browser` watchdog runner.

Core (`packages/d3gl/src/map/*.browser.test.ts` + core):

- `click`: fires with the picked hit; a >4 px drag does not fire; works with
  d3-zoom attached.
- Highlight: `highlight(layer, id)` paints on top (readPixel at a spot where
  overlay and base colors differ); respects the source layer's `clipTo`
  (readPixel outside the mask unchanged); `highlight(layer, null)` restores;
  array-of-ids form; custom draw fn receives a working builder (`replay`,
  `path`, `anchor` for a Point layer).
- Styles: `setStyle` opacity composes with the base color (readPixel alpha
  blend over a known background); fill/stroke replacement; `clearStyle`
  restores; overrides survive `setProjection`.
- `select`: dims the complement, keeps/styles the selected set, `select(null)`
  restores; predicate and ids forms.
- Clip-aware pick: point over the clipped-away part of a cell returns the
  layer below, not the cell.
- Tooltip: synthetic pointermove shows the div with accessor content; leaves
  hide it; `tooltipClass` is applied.
- Backend equivalence: the existing harness covers the overlay layer +
  dimmed tables across WebGL/Canvas/SVG.

Unit: override→RGBA composition (opacity multiply, replace-vs-base, clamp).

Website: shared geo-data tests updated for named rivers; centreCells move.

## Out of scope

- Bulk `lineWidth`/custom-draw styling (O(n) re-tessellation) — hover-overlay
  only.
- Multi-select gestures (shift-click accumulation), keyboard interaction.
- Hover/selection on `passThrough` layers (not pickable by design).
- Per-vertex styling, animated transitions of styles.
- ~~WebGL pick-buffer picking~~ — **implemented since this spec was written** (#141): GPU
  colour-buffer picking lives in `packages/d3gl/src/webgl/pick.ts` (`pickAt`,
  `encodePickColor`/`decodePickColor`, `readPixelsToArrayWebGL`). The CPU `HitIndex` also stays —
  it is backend-agnostic and, since #216, indexes rather than scans — so the two coexist rather
  than one replacing the other.
