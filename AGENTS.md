# AGENTS.md — d3gl conventions & gotchas

Notes for anyone (human or agent) working in this repo. Read before touching geo
rendering, the build, or the test setup.

## GeoJSON winding (READ THIS before generating polygons)

`geoPath` fills polygons **on the sphere**, so a ring's orientation selects which
region it encloses. **Wind exterior rings CLOCKWISE in `[lon, lat]`** (latitude up
— i.e. *negative* signed area by the shoelace formula). Reference rings that are
correct: `makeCells`, `makeDemoPolygon`, `randomRangeRing`
(`website/src/examples/shared/geo-data.ts`).

- A ring wound **counter-clockwise** is treated as its **complement** (the whole
  sphere minus the region) and projects to a giant, map-covering polygon.
- **Symptom:** a polygon (or every polygon) renders as one solid fill covering the
  entire map. **Fix:** reverse the ring / negate the angle so it's clockwise.
- **Holes** (interior rings) take the **opposite** winding to their exterior.
- When generating rings parametrically from an angle, use a **negative** angle step
  (`-θ`) so vertices go clockwise in `[lon, lat]`.

This has bitten us repeatedly. The rule lives here, in
`packages/d3gl/src/geo/project.ts` (`featureGroup`), and
`packages/d3gl/src/geo/geo-layer.ts` (`geoLayer`).

## Build / typecheck

- **Root `pnpm typecheck` is broken** — there is no root `tsconfig.json`, so the
  `tsc -b` script errors with `TS5083`. Typecheck the library per-package instead:
  `pnpm --filter @mapequation/d3gl exec tsc -b`. Typecheck the website with
  `pnpm --filter @d3gl/website exec astro check`.
- **ESM import extensions:** import specifiers use `.js` even though sources are
  `.ts` (NodeNext/ESM convention — TS does not rewrite extensions). Do **not** change
  them to `.ts`; `tsc`/`tsup` will fail. This applies to package and website source
  alike.

## Tests

- Node unit tests: `pnpm test` (root vitest, node env; excludes `*.browser.test.ts`).
- **Browser tests (`*.browser.test.ts`) currently hang** in this environment —
  vitest browser mode (`@vitest/browser-playwright`, headless Chromium) launches the
  browser but never connects, so the run sits at `Test Files 0 passed (N)` forever.
  Don't rely on `pnpm --filter @mapequation/d3gl test:browser` to verify; instead use
  `pnpm test` + per-package typecheck + careful review, and verify rendering visually
  with `pnpm dev` in a normal browser.

## Incremental layer append (status)

`LayerHandle.append()` (`GeoMap.layer().append()` / `Plot.points().append()`) appends
without re-projecting existing features, but the per-batch cost is currently
**O(total)**: `scene.buffers()` re-serializes the whole layer and the WebGL backend
rebuilds the layer's renderer from the full buffers. The **O(new)** fast-path (Scene
delta buffers + `bufferSubData`/`texSubImage2D` on WebGL, draw-on-top on Canvas) is
designed but **deferred** — it needs interactive browser verification (see the browser
test note above).
