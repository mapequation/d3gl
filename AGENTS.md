# AGENTS.md — d3gl conventions & gotchas

Notes for anyone (human or agent) working in this repo. Read before touching geo
rendering, the build, or the test setup.

## Issue-tracking workflow (do this for non-trivial work)

The expensive part of a session is the reasoning — hypotheses tried, tests run to
*rule things out*, the eventual root cause. None of it survives in a merged PR.
Capture it in GitHub issues so a future session can resume. Knowledge tiers, by how
long it stays useful:

- **Repo (`AGENTS.md` / `docs/`)** — recurs across tasks (architectural gotcha,
  non-obvious constraint, recurring failure mode). The only tier re-read
  automatically next session → durable learnings go here, not in a closed issue.
  `docs/specs` + `docs/plans` (superpowers skills) hold a task's spec/plan.
- **Issue** — *this problem's* understanding. Body = current answer (living doc:
  repro, confirmed root cause, ruled-out paths); edit as understanding changes.
  Comment thread = chronological work log; post negative results explicitly ("tried
  X, ruled out by Y") — most expensive thing to rediscover. End of session: summarize
  with `gh issue comment` or edit the body.
- **PR** — only diff-shaped reasoning (why this approach, tradeoffs, review replies).
  Dies at merge; inline comments detach on rebase. Put **`Fixes #N`** in the PR body
  to auto-close + link issue ↔ PR ↔ commits.
- **New / sub-issues** — a *genuinely new* problem → its own issue, linked
  (`Related to #N`). Same problem getting deeper → stays on the original. Multi-phase
  work → **sub-issues** under a parent (board tracks `Sub-issues progress`).

### Lifecycle (per task)

1. **Open the issue first**, before branching. Create it in the repo, then add it to
   the project — don't rely on the project's "default repository" auto-create.
2. Add to the board: `gh project item-add 4 --owner mapequation --url <issue-url>`
   (lands in **Backlog**). Needs `project,read:project` scopes
   (`gh auth refresh -s project,read:project`).
3. Move **Backlog → Ready** when triaged (manual — see below), **→ In progress** when
   you start, **→ In review** when the PR is open, **→ Done** on merge/close.
4. Branch (worktree under `.claude/worktrees/`), open PR with `Fixes #N`.
5. **Merge with squash** (see below), then **delete the feature branch** (local +
   remote) once it's in `main`.

### Merge strategy & branch cleanup

**Squash-merge feature PRs** (`gh pr merge <N> --squash --delete-branch`). It's the
default best practice here: one commit per PR keeps `main`'s history linear and
readable, makes revert/bisect trivial, and the messy work-in-progress commits stay in
the PR (where, per the issue-tracking rule above, throwaway reasoning belongs). Earlier
PRs used merge commits or rebase-merges — those preserve ancestry but clutter `main`
with intermediate commits and lose the one-PR-one-commit grouping, so don't carry that
pattern forward. Reserve plain merge commits for genuine long-lived branches (none
exist here today).

**Delete the branch on merge.** `--delete-branch` removes it remotely; also prune
locally:

```sh
git checkout main && git pull --ff-only
git fetch --prune origin           # drop stale remote-tracking refs
git branch -d <branch>             # delete local copy (safe; refuses if unmerged)
```

Caveat: a squash-merged branch is **not** an ancestor of `main`, so
`git branch --merged` / `git branch -d` won't recognize it — confirm via the PR
(`gh pr list --state merged`) and use `git branch -D` / `git push origin --delete` for
those. **Never delete** `changeset-release/main` (the Changesets release bot branch) or
any branch with an open PR.

### Issue body template

```md
## Context        # what's wrong / the situation, why it matters
## Goal           # one-sentence outcome
## Scope          # what's in — bullets, concrete
## Files / pointers   # repo-relative paths + symbols to start from
## Acceptance criteria  # how we know it's done (testable)
## Dependencies   # blocking issues (#N), prerequisites
## Non-goals      # explicitly out of scope
## Effort         # Small / Medium / Large
```

### Project board (`mapequation/d3gl`, org project #4)

Status field: **Backlog → Ready → In progress → In review → Done.** Built-in
workflows (Project ▸ ⋯ ▸ Workflows) automate entry/exit only — *Item added* →
Backlog, *PR merged* / *Issue closed* → Done. **Backlog → Ready and In progress / In
review have no built-in automation**: move them manually (Ready = deliberate
"groomed & prioritized" triage signal). Automate only via a label-driven GitHub
Action if wanted — not a built-in workflow.

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
  them to `.ts`; `tsc`/`tsdown` will fail. This applies to package and website source
  alike.

## Tests

- Node unit tests: `pnpm test` (root vitest, node env; excludes `*.browser.test.ts`).
- **Browser tests** (`*.browser.test.ts`): run with `pnpm --filter @mapequation/d3gl
  test:browser` (headless Chromium via `@vitest/browser-playwright`; pass a
  package-relative path to target one file). They run reliably and are part of TDD —
  a wall-clock watchdog (`packages/d3gl/scripts/run-browser-tests.mjs`) turns any
  rare connect/teardown stall into a fast failure instead of an infinite hang. CI
  (`ci.yml`) still runs only `pnpm test` (node), not the browser suite.

## Backend compositing equivalence (READ before touching the WebGL renderer)

WebGL, Canvas, and SVG must composite a layer **identically**. The reference is the
**painter's model**: for each drawable in order, fill then stroke (Canvas
`drawShapes` / SVG document order). So a later drawable's fill correctly occludes an
earlier drawable's *border* where they overlap.

`GroupRenderer` (`webgl/renderer.ts`) therefore packs fill **and** stroke into ONE
geometry pass whose index buffer is ordered **per drawable** —
`fill_d, stroke_d, fill_{d+1}, …` — and draws it in a single indexed call (WebGL
blends primitives in index order). An `a_isStroke` attribute picks the fill vs stroke
color table in-shader; both tables stay `drawableId`-indexed. **Do not** split this
back into separate all-fills-then-all-strokes passes — that puts every border on top
of every fill and diverges from Canvas/SVG (issue #41). `GroupBuffers.ranges` carries
the per-drawable fill/stroke slices the interleave needs.

Guard it with the **backend-equivalence harness**
(`map/__tests__/backend-equivalence-harness.ts` + `map/backend-equivalence.browser.test.ts`):
it renders a Scene through both backends and pixel-diffs them. Use a **position-tolerant**
diff (radius ≥ 1) — WebGL's tessellated stroke and Canvas's native stroker land ~1px
apart along edges, so an exact-position diff reports ~6% noise that isn't a real
divergence. The live `website` "Backend equivalence" example renders the same scene in
all three backends side by side with synced zoom for eyeballing.

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
