# Contributing to d3gl

Thanks for your interest in improving d3gl! Contributions of all kinds are
welcome — bug reports, documentation, examples, and code. This guide gets you
from a clean checkout to a merged pull request with as little friction as
possible.

## Code of conduct

Be kind and constructive. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/). Treat everyone
with respect; assume good intent.

## Licensing of contributions

d3gl is released under the [MIT License](LICENSE). **By submitting a
contribution, you agree that your contribution is licensed under the same MIT
License** ("inbound = outbound"). You retain the copyright to your work; you are
simply licensing it to the project and its users under MIT.

There is **no CLA** (Contributor License Agreement) to sign. Please only submit
work that is yours to license — don't paste code that is under an incompatible
license. If a change is substantial and you'd like attribution, feel free to add
yourself to the contributors list in your pull request.

## Project layout

This is a pnpm workspace with a single published package, `@mapequation/d3gl`,
organized into modules that are each exposed as a subpath export. See the
[Modules table in the README](README.md#modules).

```
packages/d3gl/
  src/
    core      backend-agnostic Scene / PathContext / tessellation / stroke / hit-test
    canvas    Canvas2D backend
    webgl     luma.gl v9 WebGL2 backend
    svg       SVG backend + vector export
    geo       projection + GeoJSON projection helpers
    labels    HTML label overlay + culling
    map       geoMap / plot engines + d3-zoom wiring
    react     headless controller + React components
  tsdown.config.ts builds the package + per-subpath .d.ts
  vitest.config.ts browser-mode test config (WebGL / DOM / React)
examples/
  app         the demo app (deployed to GitHub Pages)
```

Modules import each other by relative path (`../core/index.js`). Keep the
dependency direction acyclic (`core ← canvas/svg`, `core ← webgl ← geo/labels/map/react`);
`core` must not import from any other module.

**Design principle:** prefer improving the core library over adding complex
user-level workarounds in examples. If an example needs awkward glue code, that
usually signals a missing core feature.

## Getting started

Requires Node 22+ and pnpm via [corepack](https://nodejs.org/api/corepack.html).

```sh
corepack pnpm@9.15.9 install
corepack pnpm@9.15.9 exec playwright install chromium   # one-time, for browser tests
```

> If a bare `pnpm` is unavailable or broken (e.g. a stale shim), use
> `corepack pnpm@9.15.9 …` in place of `pnpm …` for every command below.

### Common commands

```sh
pnpm dev                       # run the example app (Vite dev server)
pnpm build                     # build every package (incl. the published bundle)
pnpm test                      # Node unit tests (all packages)
pnpm -r exec tsc --noEmit      # typecheck
```

### Browser tests

The CPU modules test in Node (via `pnpm test`); the WebGL, DOM, and React
modules test in headless Chromium via Vitest browser mode. The
`*.browser.test.{ts,tsx}` suites run through `packages/d3gl/vitest.config.ts`:

```sh
pnpm --filter @mapequation/d3gl test:browser
```

`test:browser` runs Vitest through a wall-clock watchdog
(`scripts/run-browser-tests.mjs`) so the suite can never hang indefinitely.
If the run stalls outside a test body — browser launch, the Vite optimizer, or
post-run teardown of a leaked WebGL context — the watchdog kills the whole
process tree (including Chromium) and exits `124` instead of blocking. Raise the
budget on a slow machine with `D3GL_BROWSER_TEST_TIMEOUT=<ms>` (default 180000)
or `--watchdog-timeout=<ms>`. In-test, hook, and teardown phases are separately
bounded by Vitest's `testTimeout` / `hookTimeout` / `teardownTimeout`.

## Making a change

1. **Fork** the repo and create a branch from `main`
   (e.g. `feat/globe-rotation` or `fix/stroke-join`).
2. **Write a test first** where practical, then make it pass. New behavior
   should come with a test; bug fixes should come with a regression test.
3. Keep changes focused. Match the style and naming of the surrounding code.
4. Run `pnpm build`, `pnpm test`, and the relevant browser tests locally.
5. **Add a changeset** if your change affects the published package:

   ```sh
   pnpm changeset
   ```

   Pick a bump type and write a short, user-facing summary. While the API is
   pre-1.0, use `minor` for breaking changes and `patch` for fixes/additions
   (under `0.x` semver, a minor bump may break the API). Docs-only or
   example-only changes don't need a changeset.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) for clear
history (e.g. `feat(geo): add inverse projection helper`,
`fix(stroke): correct miter join at sharp angles`). The changeset summary — not
the commit message — drives the changelog, so keep changesets reader-friendly.

## Pull requests

- Describe **what** changed and **why**. Link any related issue.
- Make sure CI is green (build, tests, typecheck).
- Include a changeset when the published package is affected.
- A maintainer will review; small, focused PRs are reviewed fastest.

## Reporting bugs and requesting features

Open an [issue](https://github.com/mapequation/d3gl/issues). For bugs, please
include a minimal reproduction (a code snippet or a small repo), the backend in
use (`webgl` / `canvas` / `svg`), and your browser/OS. For features, describe
the use case — what are you trying to draw?

## Releases

Releases are automated with [Changesets](https://github.com/changesets/changesets)
and the **Release** workflow (`.github/workflows/release.yml`), which runs on every
push to `main`. The flow:

1. Each change to the published package lands with a **changeset** (see above). Its
   bump type and summary drive the version and the changelog.
2. Once changesets are on `main`, the workflow opens (or updates) a **"Version
   Packages"** pull request that bumps the version and rewrites `CHANGELOG.md`,
   consuming the changeset files.
3. **To cut a release, a maintainer merges the "Version Packages" PR.** Merging it
   re-runs the workflow, which builds and publishes `@mapequation/d3gl` to npm, then
   pushes a git tag and creates a GitHub release.

**So yes — merging the auto-generated "Version Packages" PR is all it takes.** Two
things to know:

- **The release contains only what has changesets.** If a merged feature forgot its
  changeset, it's on `main` but won't appear in the Version PR. Fix it by adding a
  changeset in a small follow-up PR (`pnpm changeset`, commit the `.changeset/*.md`);
  once it lands on `main`, the workflow updates the Version PR to include it, then
  merge that. Run `pnpm changeset status` any time to see what the next release will
  bump.
- **No tokens to manage.** Publishing uses npm [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers)
  from CI — there's no `NPM_TOKEN` step you maintain, and you should not run
  `changeset publish` / `npm publish` locally.

Contributors only need to add a changeset; everything above is maintainer-side.

Thanks again for contributing! 🎉
