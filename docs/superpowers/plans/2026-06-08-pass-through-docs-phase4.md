# Pass-through Rendering — Phase 4: Website docs + streaming example

> Executed via subagent-driven-development for the example code; small JSDoc/build steps done inline.

**Goal:** Make the shipped pass-through feature discoverable: a website example demonstrating `passThrough: true` for huge/streaming point sets, a guide section leading with the standard-vs-pass-through trade-off + when-to-use, and accurate generated reference (fix the now-stale "WebGL points-only" JSDoc).

**Architecture:** Mirror the existing `streaming-points` example (file-system-based: a dir under `website/src/examples/`, a React `.tsx` wrapper + `draw.ts` `ImperativeSetup`, embedded into an MDX page via `<ExampleCard>`). Reference docs are auto-generated from source JSDoc by starlight-typedoc at `astro build` — so documenting options = fixing the JSDoc.

---

## Spec & prior work
- Design + "when to use which" + the standard-vs-pass-through table: [docs/superpowers/specs/2026-06-08-pass-through-point-rendering-design.md](../specs/2026-06-08-pass-through-point-rendering-design.md). Phases 1–3 merged (PRs #31/#32/#33). This branch: `feat/passthrough-docs`.

## Key facts (verified)
- Examples: `website/src/examples/<name>/{draw.ts, <Name>.tsx}`. `draw.ts` exports `setup: ImperativeSetup` → builds `geoMap`/`plot`, returns `{engine, render?, setVisible?, dispose?}`. Shared: `StreamController` (`shared/streaming.ts`), `createStatsOverlay` (`shared/stats-overlay.ts`), `makeStreamingPoints`/`loadWorld` (`shared/geo-data.ts`), `BATCH_SIZES`/`DATA_SIZE_TOTALS`/`randomHsl`.
- Pass-through API: `map.layer(name, features | (() => features), { passThrough: true, fill, pointRadius, ... })` / `plot.points(name, data | (()=>data), { passThrough:true, x, y, ... })`; `handle.append(batch)`. Callback data is re-invoked per repaint (the user owns the array).
- Guide page exists: `website/src/content/docs/examples/map/streaming.mdx` (embeds StreamingPoints/Polygons/Scatter via `<ExampleCard files={[...]}><X client:visible slot="demo"/></ExampleCard>`). Sidebar in `website/astro.config.mjs` (Examples group has a "Streaming data" entry → `examples/map/streaming`).
- Reference: starlight-typedoc generates from JSDoc at build; `passThrough` JSDoc already exists in `geo-map.ts`/`plot.ts` but is STALE (claims WebGL is points-only).
- Build/verify: `pnpm --filter @d3gl/website build` (runs typedoc + builds examples — catches type/import errors + regenerates reference). Dev: `pnpm dev`.

---

## Task 1 — Fix stale `passThrough` JSDoc (inline; regenerates reference)
**Files:** `packages/d3gl/src/map/geo-map.ts`, `packages/d3gl/src/map/plot.ts`.
- Update the `passThrough?: boolean` doc comment on `LayerOptions` and `PlotPointOptions`: pass-through now renders **all geometry on both Canvas and WebGL** (Phase 3) — remove the "WebGL renders only points for now / Canvas-only paths / follow-up" wording. Keep: no retained Scene geometry, not pickable, data may be a callback re-invoked per repaint, for huge/fast-changing datasets. Add a one-line pointer to the trade-off (crisp+interactive+pickable retained vs uncapped+streaming pass-through with a stale raster during gestures; non-point geometry re-tessellates per settle). Mirror the wording between the two interfaces.
- Verify `pnpm --filter @mapequation/d3gl exec tsc -b` clean; commit.

## Task 2 — Streaming pass-through example (subagent + review)
**Files (create):** `website/src/examples/streaming-passthrough/draw.ts`, `website/src/examples/streaming-passthrough/StreamingPassthrough.tsx`.
- Mirror `streaming-points/draw.ts` but: register the points layer with `passThrough: true` and **callback data** — `map.layer("points", () => retained, { passThrough: true, fill, pointRadius, sizeMode })`; `StreamController.onBatch` pushes into `retained` and calls `points.append(batch)`. Use a high total (e.g. the 10M `DATA_SIZE_TOTALS["10M"]`) to showcase the lifted ceiling; `createStatsOverlay` showing count + rec/s (the flat-memory story). Keep `setVisible`/`dispose`/`render` like the sibling. Default backend `auto` (so it shows GPU pass-through). 
- `.tsx` wrapper mirrors `StreamingPoints.tsx` (`<Example>` defaults, `<Imperative ctx setup>`), exporting default.
- Reuse shared helpers; don't duplicate generators. Match the existing examples' style/options controls.

## Task 3 — Guide section + sidebar + build verify (inline)
**Files:** `website/src/content/docs/examples/map/streaming.mdx` (+ `astro.config.mjs` only if a new page; prefer a section in the existing Streaming page).
- Add a "Pass-through (uncapped streaming)" section to `streaming.mdx`: import + embed the new example via `<ExampleCard files={["streaming-passthrough/draw.ts","shared/streaming.ts"]}><StreamingPassthrough client:visible slot="demo"/></ExampleCard>`. Lead the section with the **standard-vs-pass-through trade-off** + **when to use which** (condensed from the spec: standard = crisp/interactive/pickable but capped ~4–16M; pass-through = uncapped + streaming, soft raster during gestures, not pickable, non-point re-tessellates per settle). A short markdown table is good.
- If it reads better as its own page, add `website/src/content/docs/examples/map/streaming-passthrough.mdx` + a sidebar entry in `astro.config.mjs` under Examples. Otherwise keep it in the Streaming page (no sidebar change). Pick the cleaner option.
- **Verify the site builds:** `pnpm --filter @d3gl/website build` → succeeds (typedoc regenerates; the new example + MDX compile). Grep the generated `website/src/content/docs/reference/` for `passThrough` to confirm the corrected JSDoc surfaced (and no stale "points-only" text remains).
- Update the design spec status: Phase 4 done (docs + example shipped); the whole feature is complete. Commit.

## Out of scope
- Visual/manual QA in a real browser (the user runs `pnpm dev` to eyeball) — the build verifies compilation/regeneration, not pixels.
- Screen-mode path pass-through (a documented follow-up from Phase 3).
