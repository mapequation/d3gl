# N7c-1 selection-API rethink (revises PR #150)

Revise the multi-select API on branch `feat/n7c1-multiselect` (PR #150, NOT merged) to one coherent managed-selection concept. Approved design:

## Target API
- **`on("click", (hit, ev))`** — unchanged: the raw click hit (low-level escape hatch).
- **Layer opts into click-selection** via a new option `selectable?: boolean | { multi?: boolean }`, alongside `hover`/`tooltip`/`selection`:
  - `true` (or `{}` / `{ multi:false }`) ⇒ single-select on click (replace).
  - `{ multi: true }` ⇒ shift/cmd/ctrl-click toggles add/remove; plain click replaces.
  - `selection?: { selected, others }` stays = *styling only* (how selected vs others look).
- **One managed selection path** — both the click gesture (on a `selectable` layer) and the programmatic **`select(name, set|null)`** call:
  1. update the managed set (`this.selected: Map<layer, Set<id>>`),
  2. apply styling (the existing `select()` body — `selection.selected`/`others` overrides),
  3. **fire `on("select")`**.
  So `select()` now fires `on("select")` too (was silent — the asymmetry we're removing).
- **`selection(): HoverHit[]`** — current set (unchanged).
- **`on("select", (selected: HoverHit[], ev?: PointerEvent) => void)`** — pure OBSERVER of selection changes; `ev` present for a gesture, `undefined` for programmatic `select()`. Registering it no longer *enables* anything (the layer's `selectable` does).
- **Order on a click:** `on("click")` fires first (raw), then — only if the hit layer is `selectable` — the selection updates and `on("select")` fires.

## Implementation (revise from N7c-1's current state)
1. **`LayerSpec` + option types** (`map/base-engine.ts` `LayerSpec`; `map/plot.ts` `PlotPointOptions`/`PlotLayerOptions`; geoMap layer options + `interactionFields`): add `selectable?: boolean | { multi?: boolean }`. Thread it through `interactionFields`/`registerLayer` like `hover`.
2. **Gesture enable:** attach the pointerdown/up listeners when a `selectable` layer is registered (in `registerLayer`, like `hover`/`tooltip` attach the pointer move listener) — NOT gated on `on("select")`.
3. **`onPointerUp`:** pick once; fire `clickCb?.(hit, e)`; then if `hit` and the hit's layer spec is `selectable`, call the shared `setSelection(...)` with the layer's multi flag + `e`. (If `hit` is null and a click landed on empty over a selectable context, clear — keep N7c-1's clear-on-empty, but only when a selectable layer is in play.)
4. **Refactor a shared `private setSelection(layer, hitId|null, opts: { multi, additive, ev? })`** (or similar) that both the gesture and `select()` use: update `this.selected`, apply styling (move the current `select()` styling body here), fire `this.selectCb?.(this.selection(), ev)`. 
   - `select(name, set|null)` (public, programmatic): set the layer's selection to `set` exactly (replace), apply styling, fire `on("select")` with `ev = undefined`. (Keep its existing signature + behaviour, just ALSO fire the event.)
   - Gesture: single (replace with hit) or, when layer is `{multi}` AND a modifier is held, toggle hit.
5. **`on("select", cb)`** stays as the observer registration (store `selectCb`); it no longer attaches gesture listeners (the `selectable` layer does). Keep the `(selected, ev?)` signature.
6. **Examples → one declarative pattern:**
   - `plot-highlight`: replace the gesture-by-`on("select")` wiring with **`selectable: { multi: true }`** on the points layer + `on("select", …)` for the readout. (Same UX; declarative.)
   - `scatter-stress`: **drop** any manual `on("click")` + `chart.select(...)`; add `selectable: { multi: true }` to its points layer + an `on("select")` count readout. **Also add a `declutter` control** (a range/toggle in `ScatterStress.tsx` + wire `declutter` into `points()` in `draw.ts`). (No LOD — deferred to #149.)
7. **Tests** (`map/multiselect.browser.test.ts`): update to the new API — layers declare `selectable: { multi: true }` (no `on("select")` needed to enable); assert plain/shift/cmd/clear; assert **`select()` (programmatic) fires `on("select")`**; assert a `selectable: true` (single) layer never accumulates; assert `on("click")` still fires and fires *before* `on("select")`. Keep the "others dimmed" styling assertion.
8. **Changeset** (`.changeset/multi-select-gestures.md`): rewrite to the new API (`selectable` layer option; `select()` + gesture both fire `on("select")`; `on("click")` raw; opt-out = `selectable:true` for single or omit for none).

## Guard (must hold)
- New + existing browser suites green: `cd packages/d3gl && node scripts/run-browser-tests.mjs` (network/map/webgl/multiselect — nothing regressed; single-select/hover/tooltip unchanged for layers without `selectable`).
- `npx vitest run packages/d3gl` (node) green; `pnpm --filter @mapequation/d3gl exec tsc -b` 0; `pnpm --filter @mapequation/d3gl build` + `pnpm --filter @d3gl/website build` green.
- **Opt-in preserved:** a layer with no `selectable` behaves exactly as before (no gesture, no styling on click).

## PR
Update #150's body to the new API; `Refs #79` (instanced-lane selection highlight still N7c-2). Keep it one PR (the API + the two examples + tests).
