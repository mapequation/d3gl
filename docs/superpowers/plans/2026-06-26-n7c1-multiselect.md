# N7c-1 — multi-select gestures + observable selection (BaseEngine, closes #79) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Add shift/cmd-click multi-select to `BaseEngine` — an observable selection set (`on("select")` event + `selection()` getter) with the selected features styled via the existing `select(name, set)` path. Shared across geoMap/plot/network; closes #79's Scene-layer scope. (Instanced-lane selection *highlight* rendering is N7c-2.)

**Architecture:** `BaseEngine` already has `select(name, set|predicate|null)` (styles `selection.selected` vs `selection.others` via the override table) — script-driven today. N7c-1 adds the **gesture**: `onPointerUp` (which already has the `PointerEvent` modifier keys) updates a retained selection set — **plain click = replace (single), shift/cmd/ctrl-click = toggle add/remove**, click on empty = clear — then applies styling through `select()` and fires `on("select")`. Opt-in: the gesture only runs once a consumer registers `on("select", …)` (mirrors how `on("click")` enables click handling), so existing behaviour is unchanged. `clickCb` still fires as today (they coexist).

**Tech Stack:** TS ESM. Vitest browser (`packages/d3gl/scripts/run-browser-tests.mjs`) + node (root). Typecheck `pnpm --filter @mapequation/d3gl exec tsc -b`.

---

## Scope & non-goals
- **In:** selection-set state (per layer), shift/cmd gesture, `on("select")` + `selection()`, Scene-layer styling via `select()`, tests, an example demo.
- **Out (N7c-2):** rendering a selection/hover *highlight* on **instanced-lane** glyphs (network frontier, plot points) — those have no Scene drawables; the selection *set* will already include them (pick resolves lanes), but their visual highlight comes in N7c-2. Labels = N7b.

## File structure
- **Modify** `packages/d3gl/src/map/base-engine.ts` — selection state + gesture in `onPointerUp` + `on("select")` + `selection()` + apply via `select()`.
- **Create** `packages/d3gl/src/map/multiselect.browser.test.ts` — gesture/accumulation/observable/styling tests.
- **Modify** a website example (`plot-highlight` or `highlight`) — demo multi-select (verifiable example).

---

### Task 1: selection state + gesture + `on("select")`/`selection()` (BaseEngine)

**Files:** Modify `base-engine.ts`; Create `map/multiselect.browser.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// packages/d3gl/src/map/multiselect.browser.test.ts
import { describe, it, expect } from "vitest";
import { plot } from "./plot.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px"; el.style.height = "200px"; document.body.appendChild(el); return el;
}
// Click helper: pointerdown+up at (x,y) with optional modifiers, within CLICK_SLOP.
function click(host: HTMLElement, x: number, y: number, mods: Partial<PointerEventInit> = {}) {
  const r = host.getBoundingClientRect();
  const o = { clientX: r.left + x, clientY: r.top + y, bubbles: true, ...mods };
  host.dispatchEvent(new PointerEvent("pointerdown", o));
  host.dispatchEvent(new PointerEvent("pointerup", o));
}

describe("multi-select gestures (#79 / N7c-1)", () => {
  async function setup() {
    const h = host();
    const eng = plot(h, { width: 200, height: 200, backend: "svg" }); // Scene path (selection styling)
    await eng.whenReady();
    const data = [{ id: "a", x: 20, y: 20 }, { id: "b", x: 100, y: 100 }, { id: "c", x: 170, y: 40 }];
    eng.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "#39f", id: (d) => d.id, selection: { others: { opacity: 0.3 } } });
    return { h, eng };
  }

  it("plain click selects one (replace); on(\"select\") fires; selection() reflects it", async () => {
    const { h, eng } = await setup();
    const seen: unknown[][] = [];
    eng.on("select", (sel) => seen.push(sel.map((s) => s.id)));
    click(h, 20, 20);              // select a
    expect(eng.selection().map((s) => s.id)).toEqual(["a"]);
    click(h, 100, 100);            // plain click on b ⇒ replace ⇒ just b
    expect(eng.selection().map((s) => s.id)).toEqual(["b"]);
    expect(seen).toEqual([["a"], ["b"]]);
    eng.destroy();
  });

  it("shift/cmd-click accumulates and toggles", async () => {
    const { h, eng } = await setup();
    eng.on("select", () => {});
    click(h, 20, 20);                          // a
    click(h, 100, 100, { shiftKey: true });    // + b
    expect(eng.selection().map((s) => s.id).sort()).toEqual(["a", "b"]);
    click(h, 170, 40, { metaKey: true });      // + c
    expect(eng.selection().map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
    click(h, 100, 100, { shiftKey: true });    // toggle b OFF
    expect(eng.selection().map((s) => s.id).sort()).toEqual(["a", "c"]);
    eng.destroy();
  });

  it("click on empty space clears; on(\"select\") fires empty", async () => {
    const { h, eng } = await setup();
    const seen: number[] = [];
    eng.on("select", (sel) => seen.push(sel.length));
    click(h, 20, 20); click(h, 100, 100, { shiftKey: true });
    click(h, 5, 195);                          // empty ⇒ clear
    expect(eng.selection()).toEqual([]);
    expect(seen[seen.length - 1]).toBe(0);
    eng.destroy();
  });

  it("applies selection styling (others dimmed) via select(); plain click still fires on(\"click\")", async () => {
    const { h, eng } = await setup();
    let clicks = 0; eng.on("click", () => clicks++); eng.on("select", () => {});
    click(h, 20, 20);                          // select a ⇒ b,c get others {opacity:0.3}
    const svg = eng.toSVG();
    expect(svg).toMatch(/opacity="0\.3"/);     // non-selected dimmed
    expect(clicks).toBe(1);                    // clickCb still fired
    eng.destroy();
  });
});
```

- [ ] **Step 2: Run → fail** (`cd <wt>/packages/d3gl && node scripts/run-browser-tests.mjs src/map/multiselect.browser.test.ts`): no `on("select")`/`selection()`.

- [ ] **Step 3: Implement in `base-engine.ts`.**
  - State + callback (near `hoverCb`/`clickCb`):
    ```ts
    private selectCb: ((selected: HoverHit[], ev: PointerEvent) => void) | null = null;
    /** Selected ids per layer (gesture-driven multi-select, #79). */
    private selected = new Map<string, Set<string | number>>();
    ```
  - `on("select", cb)` (extend the `on` overload + union the event type to `"hover" | "click" | "select"`): store `selectCb`; attach the pointerdown/up listeners (same as the `"click"` branch — idempotent).
  - In `onPointerUp`: change the early-out to proceed when **`clickCb` OR `selectCb`** is set; pick once; `this.clickCb?.(hit, e)`; then if `this.selectCb`, `this.updateSelection(hit, e)`.
  - `private updateSelection(hit: HoverHit | null, ev: PointerEvent)`:
    ```ts
    const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    const touched = new Set<string>();        // layers whose styling must refresh
    if (!hit) { if (!additive) { for (const n of this.selected.keys()) touched.add(n); this.selected.clear(); } }
    else if (!additive) { for (const n of this.selected.keys()) touched.add(n); this.selected.clear(); (this.selected.get(hit.layer) ?? this.selected.set(hit.layer, new Set()).get(hit.layer)!).add(hit.id); touched.add(hit.layer); }
    else { const set = this.selected.get(hit.layer) ?? this.selected.set(hit.layer, new Set()).get(hit.layer)!; if (set.has(hit.id)) set.delete(hit.id); else set.add(hit.id); touched.add(hit.layer); }
    for (const n of touched) { const ids = this.selected.get(n); this.select(n, ids && ids.size ? [...ids] : null); }
    this.selectCb!(this.selection(), ev);
    ```
    (Write this clearly — the inline `?? .set().get()!` is shorthand; expand to a readable get-or-create helper.)
  - `selection(): HoverHit[]` — flatten `this.selected` into HoverHits (resolve datum via `layerIds`/`spec.data`, mirroring `pick()`'s `{ layer, id, datum }`):
    ```ts
    selection(): HoverHit[] {
      const out: HoverHit[] = [];
      for (const [layer, ids] of this.selected) {
        const spec = this.specs.find((s) => s.name === layer); const index = this.layerIds.get(layer);
        for (const id of ids) { const di = index?.get(id) ?? -1; out.push({ layer, id, datum: di >= 0 && spec ? spec.data[di] : null }); }
      }
      return out;
    }
    ```
  - Clear `this.selected` + fire nothing on `destroy()`/layer drop (drop a layer's entry in `dropInteractionState`/wherever specs are removed).

- [ ] **Step 4: Run → pass.** `tsc -b` → 0.
- [ ] **Step 5: Commit** `feat(d3gl): multi-select gestures + on("select")/selection() (#79)`.

---

### Task 2: example demo + verify no single-select regression

**Files:** Modify `website/src/examples/plot-highlight/` (or `highlight/`) — add an `on("select")` multi-select demo (shift/cmd-click to accumulate; show a count/stats readout). Keep it minimal (per the example-minimal rule).

- [ ] **Step 1:** Wire `on("select", sel => readout.textContent = …)` into the example; shift/cmd-click accumulates; a small readout shows the selected count. (A verifiable example, per the perf/verification doctrine.)
- [ ] **Step 2: Regression guard** — run the existing interaction suites (`interaction.browser.test.ts`, `plot-interaction.browser.test.ts`) + the new multiselect test + node + `tsc` + website build; **single-select / hover / tooltip must be unchanged** (the gesture is opt-in via `on("select")`, so engines without it are untouched).
- [ ] **Step 3: Commit** `docs(d3gl): multi-select demo on the plot-highlight example (#79)`.

---

### Task 3: changeset + PR
- [ ] Changeset (minor): `on("select")` + `selection()` + shift/cmd multi-select gestures; opt-in (no change unless `on("select")` is registered); selected features styled via `selection.selected`/`others`; closes #79's Scene scope. Note instanced-lane selection highlight follows in N7c-2.
- [ ] PR: **Performance** section (gesture is click-time only — O(selected) restyle compose + one styles push per click, nothing per frame; `selection()` is O(selected)); verification (new tests + unchanged single-select suites + example); `Closes #79` (gesture+set+observable+styling met; instanced *highlight* is additive N7c-2, not part of #79's criteria). Stop at the approval gate.

## Self-review notes
- **#79 criteria:** shift/cmd add/remove (Task 1) ✓; plain click = single ✓; selection observable (`on("select")`+`selection()`) ✓; style overrides apply to all selected (via `select()`) ✓.
- **Opt-in:** gesture only when `on("select")` registered ⇒ zero behaviour change for existing consumers (guarded by the unchanged interaction suites).
- **Coexistence:** `select()` (gesture) writes the layer override table; this *replaces* prior `setStyle` overrides on that layer (documented in `select()`), and is independent of the hover *overlay* (`highlight()`), so hover-highlight still composes on top. Verify hover+select together in a test if time permits.
- **Scope honesty:** the selection *set* includes instanced-lane hits (pick resolves them), but their visual styling needs N7c-2 — `select()`/`styleOverrides` only restyle Scene drawables. Note this in the PR.
