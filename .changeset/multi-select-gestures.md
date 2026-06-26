---
"@mapequation/d3gl": minor
---

Selection API: `selectable` layer option; `select()` + gesture both fire `on("select")` (#79).

**`selectable?: boolean | { multi?: boolean }`** — new per-layer option that opts a layer into click-driven selection. `true` = single-select (plain click replaces). `{ multi: true }` = shift/cmd/ctrl-click toggles add/remove; plain click replaces. Omitting `selectable` leaves the layer un-selectable (no gesture, no click-styling) — **opt-in is preserved**.

**One managed selection path** — the click gesture (on a `selectable` layer) and the programmatic `select(name, set|null)` both update the managed set, apply styling (`selection.selected`/`others`), and **fire `on("select")`**.

**`on("select", (selected, ev?) => void)`** — pure observer of selection changes. `ev` is present for a gesture, `undefined` for a programmatic `select()` call. Registering it no longer enables anything (the layer's `selectable` does).

**`on("click")`** — unchanged: fires first (before selection updates) on every pointer-up that passes the click-slop test, regardless of `selectable`.

Migration: add `selectable: { multi: true }` (or `selectable: true`) to any layer that was previously activated by `on("select")`. The `on("select", cb)` call stays as the observer.
