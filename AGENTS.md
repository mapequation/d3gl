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
- **Browser tests** (`*.browser.test.ts`): run with `pnpm --filter @mapequation/d3gl
  test:browser` (headless Chromium via `@vitest/browser-playwright`; pass a
  package-relative path to target one file). They run reliably and are part of TDD —
  a wall-clock watchdog (`packages/d3gl/scripts/run-browser-tests.mjs`) turns any
  rare connect/teardown stall into a fast failure instead of an infinite hang. CI
  (`ci.yml`) still runs only `pnpm test` (node), not the browser suite.

## Incremental layer append (status)

`LayerHandle.append()` (`GeoMap.layer().append()` / `Plot.points().append()`) appends
without re-projecting existing features, but the per-batch cost is currently
**O(total)**: `scene.buffers()` re-serializes the whole layer and the WebGL backend
rebuilds the layer's renderer from the full buffers. The **O(new)** fast-path (Scene
delta buffers + `bufferSubData`/`texSubImage2D` on WebGL, draw-on-top on Canvas) is
designed but **deferred** — it needs interactive browser verification (see the browser
test note above).

## Releases (changesets, CI-published)

Publishing is automated by `.github/workflows/release.yml` (the `changesets/action`
on push to `main`) via npm **OIDC trusted publishing** — there is **no local publish
and no token**. Do not run `changeset publish` / `npm publish` yourself. Steps:

1. **Ensure the changes have changesets.** Each published-package change should ship a
   `.changeset/<name>.md` (added in its feature PR). If one was forgotten, add it on a
   branch (don't push to `main` directly):

   ```md
   ---
   "@mapequation/d3gl": patch   # pre-1.0: `patch` for additions/fixes, `minor` ONLY for breaking changes (see CONTRIBUTING)
   ---
   <user-facing changelog summary>
   ```

   Verify with `pnpm changeset status` (reads every `.changeset/*.md`; note
   `--since=main` only counts *committed* changesets, so a brand-new uncommitted file
   shows nothing). Open a PR and merge it.
2. On push to `main`, the workflow opens/updates the **"Version Packages"** PR (branch
   `changeset-release/main`): it bumps `packages/d3gl/package.json`, rewrites
   `CHANGELOG.md`, and deletes the consumed changeset files. Multiple changesets bundle
   into one release.
3. **Merge the "Version Packages" PR** → the workflow re-runs and this time executes
   `pnpm run release` (`build:lib && changeset publish`): publishes to npm, pushes the
   `@mapequation/d3gl@X.Y.Z` tag, and creates the GitHub release.
4. **Verify + tidy:** `npm view @mapequation/d3gl version`, `gh release list`. The
   primary worktree's local `main` may be behind (it can't be force-updated while
   checked out) — `git checkout main && git pull --ff-only` it, and delete merged
   feature/changeset branches (local + remote).

Merging the Version Packages PR is the single action that publishes — but only what
the accumulated changesets describe. No changesets ⇒ a push to `main` is a no-op
release run.
