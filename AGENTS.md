# AGENTS.md — d3gl conventions & gotchas

Notes for anyone (human or agent) working in this repo. Read before touching geo
rendering, the build, or the test setup.

> The root `CLAUDE.md` imports this file (`@AGENTS.md`) so Claude Code auto-loads these
> conventions every session. **This file is canonical — edit it, not `CLAUDE.md`.**

## Core values

- **Efficient rendering** — Never increase the computational complexity or memory footprint of the rendering path without first weighing the options and asking me for guidance. Explain the trade-offs concretely: how run time and space grow with the input (node / edge / vertex count) under each option, and how noticeable it will be for a user.
- **Unified rendering** — Before changing the rendering path, work out how to do it in a unified way across all three backends (WebGL, Canvas, SVG) with shared code — as long as that stays as efficient as a backend-specialized alternative. When you do touch backend-specialized code, check whether the other backends need a corresponding change.
- **d3 compatibility** — Design the library for d3 compatibility and familiarity, supporting both d3's low-level flexibility and a powerful API that keeps example code simple. It should accept `d3-shape` generators, `d3-geo` projections, `d3-hierarchy` layouts, `d3-scale` scales, and the like.
- **Clean code** — Casting or reaching for `any` / `unknown` is a sign of bad design; fix the underlying seam (a typed pure function, a test at the right layer) instead. Avoid the non-null assertion operator (`!`) for the same reason, unless it's justified in a performance-critical spot and approved by me.
- **Regression-safe** — Write tests for both behavior and visual output. Never claim a visual issue is solved without visual testing (browser tests / the backend-equivalence harness). When you change the library, make sure no example breaks.
- **Up-to-date documentation** — Every major feature should be highlighted on the website landing page and have a minimal example that demonstrates it. As soon as the library changes, keep the documentation — prose and examples — up to date. If it includes a new feature, it should be possible to verify its function in at least one example.

## Library-first design (improve d3gl, don't work around it)

The d3gl library is the product; the website examples and any consumer code are its
clients. When a piece of user-facing code can only be made to work with boilerplate,
DOM hacks, or per-call ceremony, treat that as a signal that the **library** is missing
something — fix it upstream so the consumer code stays simple, instead of polishing the
workaround. If a "simple" change needs ugly userland code, step back and redesign the
API (e.g. lift a capability into the shared engine rather than re-implementing it per
consumer). When that implies a larger change, surface it as a decision rather than
silently absorbing the complexity downstream.

## Website example code (keep the d3gl usage front and center)

Each example's `draw.ts` / `*.tsx` is shown verbatim in the docs code tabs, so it must
read as a **minimal, idiomatic demonstration of the d3gl API — nothing else**. Push data
generation, fixtures, math, and similar boilerplate into separate co-located files
(`<example>/data.ts`) or shared helpers (`website/src/examples/shared/`), and import
them. `ExampleCard` (`website/src/components/ExampleCard.astro`) transitively discovers
local relative imports and renders each as its own code tab (it excludes only the
`types.ts` harness contract), so an imported `data.ts` stays visible to readers without
cluttering the file that teaches the API. Mirror the existing pattern: the Highlight
examples import `makeCells`/`loadWorld` from `shared/geo-data.ts` and `makeData` from
`plot-highlight/data.ts`.

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
4. Branch **inside a worktree**, created in one step:
   ```sh
   git worktree add .claude/worktrees/<name> -b <branch>   # new branch, checked out IN the worktree
   ```
   Don't `git checkout <branch>` in the primary checkout — the branch lives in the worktree and
   the primary stays on `main`. Drive everything by the worktree path (`git -C <worktree>`,
   `pnpm --filter`, and Read/Edit/Write under `/…/.claude/worktrees/<name>/…`), never the primary
   tree — see **§Worktrees & shell cwd** for why and how to recover a mis-targeted edit.

   **Immediately `pnpm install` in the new worktree** — it has its own *empty* `node_modules`
   (deps aren't shared from the primary checkout), so builds/typecheck/tests fail or run against
   stale deps until you do. Run it *before* the first `tsc`/`astro check`/`vitest`/build, not after
   it errors. Then open the PR with `Fixes #N`.
5. **Performance section in the PR** — before asking for human verification, add a
   `## Performance` section to the PR body with two subsections, **Per-frame cost** and
   **Memory footprint**. Under each, list *every* change that could move fps / run-time
   (resp. memory) by more than a negligible amount — **include it even when you are
   uncertain**, and an added loop on a per-frame path *always* requires an entry. For each:
   - give the computational complexity **before → after**, and
   - **quantify every `N` / `size`**: say exactly which set it ranges over (all drawables,
     only the visible frontier, only the aggregated nodes, tree depth, …) and its rough
     scale — never an unqualified `O(size)` or `~log N`.

   Then state, from the **user's** point of view, under what conditions (if any) the change
   is noticeable and by how much (run-time and memory), including any scale at which it
   could hit a memory limit.

   **The prose section is necessary but NOT sufficient — it documents, it does not prevent.**
   If the change adds, moves, or grows work on a **per-frame path** (anything reachable from
   `setTransform` / `render` / a selection `emit` / a draw loop), you MUST also land an
   automated **per-frame regression test** before requesting verification. It must:
   - drive a **realistic large input** (≈1M points/nodes) through a sequence of `setTransform`s
     (a zoom-in sweep) and assert a **frame budget** — a wall-clock-per-`setTransform` ceiling
     generous enough to be non-flaky but tight enough to catch an order-of-magnitude drop; **and**
   - assert the regression's **deterministic signature** directly where one exists: per-frame
     work the baseline did **once** must stay once — e.g. spy that style/colour resolution (or any
     accessor) runs **O(data) at registration, not O(visible) per frame**, and that GPU buffers
     are **updated in place, not destroyed + recreated** each frame.

   **Baseline comparison is mandatory when you replace a render path.** Moving a layer from one
   path to another (retained-Scene → instanced lane, etc.) means the new path's per-frame cost is
   measured **against the path it replaces**. A path that re-derives / re-allocates / re-parses /
   re-uploads per frame what the old path **retained** is a **regression** — even if it wins on a
   different axis (draw count, scale). Both axes must hold; "better at X" never excuses "worse at
   per-frame Y".

   **Never self-defer a per-frame cost.** A per-frame allocation / upload / re-derivation you are
   "uncertain" about, or that you label a "follow-up" or "not a regression", is treated as a
   **blocking regression** until a test proves it bounded. Resolve it — or land the test that
   bounds it — *before* merge. Do not ship it on a promise to optimise later. (This rule exists
   because exactly this slipped through once: a per-frame buffer rebuild was documented as a
   deferred follow-up and shipped a 30× zoom regression.)
6. **Human verification** — Summarize what you have done (point to the Performance section
   for any per-frame / memory impact) and ask for approval before merging a PR.
7. **Create changesets** (see §Releases). **Enforced** (§Enforcement): a PR that changes
   `packages/d3gl/**` without a changeset, or that closes an issue without a `## Performance`
   section, is blocked by the `policy` CI check and a local pre-merge hook.
8. **Merge with squash** (see below), then **delete the feature branch** (local +
   remote) once it's in `main`.
9. **Tear down the worktree.** Stop any dev server you started in it and **wait for its
   `astro`/`vite`/`esbuild` children to fully exit** before removing — a process still rewriting
   its cache (e.g. `website/.astro`) makes `git worktree remove --force` fail with *"Directory not
   empty"* (a worktree that only ran one-shot builds removes cleanly). Then `git worktree remove
   <path>` + `git worktree prune`; don't be `cd`'d inside it (drive via `git -C`). If git already
   de-registered the worktree but a stale dir lingers, `rm -rf` the leftover path.

### Merge strategy & branch cleanup

**Squash-merge feature PRs** (`gh pr merge <N> --squash`). One commit per PR keeps
`main`'s history linear and readable, makes revert/bisect trivial, and the messy
work-in-progress commits stay in the PR (where, per the issue-tracking rule above,
throwaway reasoning belongs). Reserve plain merge commits for genuine long-lived branches.

**Delete the branch manually after merge** — *not* with `--delete-branch`: from inside a
linked worktree it fails (gh tries to check out the base branch, which the primary checkout
holds), and a squash-merged branch isn't an ancestor of `main` so `git branch -d` refuses it
anyway. So:

```sh
git checkout main && git pull --ff-only
git fetch --prune origin           # drop stale remote-tracking refs
git push origin --delete <branch>  # remote
git branch -D <branch>             # local (confirm it merged via `gh pr list --state merged`)
```

**Never delete** `changeset-release/main` (the Changesets release bot branch) or any branch
with an open PR.

### Enforcement (changeset + Performance policy)

Lifecycle steps 7 (changeset) and 5 (`## Performance`) are mechanically gated by **one
shared check** — `scripts/check-pr-policy.mjs` — run two ways so the omission that
prompted this (network PRs shipped with no changeset) can't repeat:

- **CI required check** — `.github/workflows/changeset-policy.yml`, status name **`policy`**.
  The authoritative gate: `gh pr merge --squash` is server-side, so branch protection that
  requires `policy` blocks any non-conforming merge no matter who triggers it. Enable it once:
  Settings ▸ Branches ▸ protect `main` ▸ *Require status checks to pass* ▸ add `policy`.
- **Local pre-merge hook** — `scripts/premerge-gate.sh`, wired in `.claude/settings.json` as a
  Claude Code `PreToolUse(Bash)` hook. It runs the same check before any `gh pr merge` and
  blocks the call on failure (a shift-left backstop). It degrades to *allow* if it can't
  evaluate — node missing, gh error — since CI is the real gate. (`.claude/` is git-ignored
  except this one committed `settings.json`, via a `.gitignore` negation.)

Rules (the **Balanced** policy):
1. A change to `packages/d3gl/**` (except the generated `CHANGELOG.md`) needs a changeset. An
   explicit empty changeset (`pnpm changeset add --empty`) satisfies it when no release is intended.
2. A PR whose body closes an issue (`close`/`fix`/`resolve` + `#N`) needs a `## Performance` section.
3. The `changeset-release/main` (Version Packages) branch is exempt.

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

## Worktrees & shell cwd (avoid committing to the wrong repo)

Feature work happens in a worktree under `.claude/worktrees/<name>/`, which is a SECOND
checkout of the same repo. The shell's working directory can silently reset to the
**primary** repo between commands (e.g. after a `cd /…/d3gl && …`, a `cd /tmp`, or a tool
that resets cwd). If you then run `git add -A && git commit && git push` assuming you're in
the worktree, you'll commit to the **primary checkout's branch (usually `main`)** instead —
and `git add -A` there will even add `.claude/worktrees/<name>` as an embedded-repo gitlink.

Defenses (do these):
- Run every git/build command with an explicit path — `git -C <worktree> …`,
  `pnpm --filter <pkg> …` — instead of relying on the current directory.
- Stage scoped paths (`git add website/ packages/`), never a bare `git add -A`, so a
  wrong-cwd add can't sweep in `.claude/`.
- A `git push` that prints `main -> main` (or warns about an *embedded git repository*)
  means you're in the wrong checkout — stop and fix before pushing.

**The same trap with file edits (Read/Edit/Write take absolute paths).** Editing
`/…/d3gl/packages/…` (primary) instead of `/…/.claude/worktrees/<name>/packages/…` lands your
changes in the primary tree. Then `pnpm --filter` build/test/`tsc` run *from the worktree* see
UNCHANGED source — everything "passes" and the rebuilt `dist` has none of your changes, so it
looks like your work had no effect. Always edit via the full worktree path; after core edits,
verify `git -C <worktree> status` shows them. Recover a misplaced edit without redoing it:
```sh
git -C <primary> diff -- <files> | git -C <worktree> apply   # move tracked changes
git -C <primary> checkout -- <files>                         # restore primary to clean
# untracked new files: mv them into the worktree
```
(Also: `rm` may be aliased to `rm -i`; use `command rm -f` for a non-interactive delete.)

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
- **The node run is two sequential groups** (`vitest.config.ts` `projects`, #257): **`unit`**
  (everything else, parallel) then **`perf`** — the wall-clock guards, running **alone and one file
  at a time** (`sequence.groupOrder: 1` + `fileParallelism: false`). The guards' ceilings are
  calibrated for an *uncontended* run; sharing the pool inflated this repo's test time 4.2× (14.1s
  serial vs 58.7s parallel) and tripped budgets at random — four sessions chased that ghost before
  it was pinned as contention. **Never merge the two groups back**, and never loosen a ceiling to
  make a parallel run pass. Enrolment is **pattern-driven**: a node test named `*-perf.test.ts` or
  `*.bench.test.ts` under `packages/*/src` joins the serial group automatically — **name every new
  wall-clock guard that way** (a guard left outside the pattern silently runs contended). The perf
  group also gets `testTimeout: 120_000`: these build 100k-1M-element fixtures and vitest's 5s
  default is a harness limit, not a budget. Wall-clock ceilings themselves stay exactly as
  calibrated — a **timeout** may be raised for a slow machine, a **budget** may not.
- **Browser tests** (`*.browser.test.ts`): run with `pnpm --filter @mapequation/d3gl
  test:browser` (headless Chromium via `@vitest/browser-playwright`; pass a
  package-relative path to target one file). They run reliably and are part of TDD —
  a wall-clock watchdog (`packages/d3gl/scripts/run-browser-tests.mjs`) turns any
  rare connect/teardown stall into a fast failure instead of an infinite hang. CI
  does not run the full browser suite (node only) — only the browser perf tier below.
- **At-scale perf tier** (`ci.yml` job `perf`, #220): `node scripts/run-perf-tier.mjs`
  runs every **env-gated node bench** with its gates ON at a reduced-but-real N
  (`PERF_N`, CI default 500k) and assertions enabled (`PERF_ASSERT=1`), single-threaded
  under `--expose-gc`, with a hard per-file wall-clock budget (`PERF_FILE_BUDGET_MS`).
  Discovery is **pattern-driven**: any node test reading `process.env.BENCH_*` is
  enrolled automatically — so a new bench joins CI just by following the convention
  `BENCH_<NAME>` (gate) / `BENCH_<NAME>_N[ODES]` (scale, set to `PERF_N`) /
  `BENCH_<NAME>_LABEL` (report label). Report-only benches are still guarded by the
  per-file budget; add `PERF_ASSERT`-gated ceilings for real assertions (see
  `lod-perf.bench.test.ts`). Local report-only runs (no `PERF_ASSERT`) are unchanged.
- **Browser perf tier** (`ci.yml` job `perf-browser`, #247, **blocking as of #262** — promoted on
  a 10-of-11-green record whose single red was the tier's own injected-regression proof; add it to
  branch protection alongside `policy`): `node scripts/run-browser-perf-tier.mjs` runs every browser per-frame
  guard headless (SwiftShader software GL on CI runners), one watchdogged process
  per file. Discovery is **pattern-driven**: a file named `*-perf.browser.test.ts`
  (or bare `perf.browser.test.ts`) under `packages/*/src` is enrolled automatically —
  name new browser perf guards accordingly. Wall-clock ceilings/timeouts are
  locally-calibrated numbers multiplied by `PERF_BUDGET_SCALE` (CI sets it for
  SwiftShader; unset = 1 = local budgets) via
  `packages/d3gl/src/__tests__/perf-budget.ts` — never loosen a local budget for
  CI's sake, and never scale a deterministic (count/pixel) assertion. **`PERF_BROWSER_N`** (CI:
  100000) sets the fixture size via the `__PERF_N__` define + `perfN()`; it is a separate variable
  from the node tier's `PERF_N` because SwiftShader cannot carry 500k. Browser tests cannot read
  `process.env` — a define is the only way in.

### Perf-guard coverage map (#258 — check here before claiming a cell is covered)

Which guard covers which §5 cell. **A cell that runs but asserts nothing is not covered** — that
was the #258 finding: 6 of the node benches printed numbers at `PERF_N` and gated on nothing but the
per-file timeout. Every at-scale leg below now asserts. When you add a guard, add its row.

| path | backend | guard | always-on | at-scale (CI `perf`, `PERF_N`) |
|---|---|---|---|---|
| plot points, full detail | Canvas | `canvas/__tests__/canvas-zoom-sweep-perf.test.ts` | 100k | `BENCH_CANVAS_SWEEP` |
| plot points, retained DOM | SVG | `svg/__tests__/svg-zoom-sweep-perf.test.ts` | 100k | `BENCH_SVG_SWEEP` |
| geo polygons + clip | Canvas | `geo/__tests__/geo-zoom-sweep-perf.test.ts` | ~15k cells | `BENCH_GEO_SWEEP` |
| geoMap append | — | `map/__tests__/append-scaling-perf.test.ts` | O(new) delta | — |
| plot declutter `select()` | — | `map/__tests__/points-lane-scratch-perf.test.ts` | 1M | — |
| plot points lane sweep | — | `map/__tests__/points-lane-perf.bench.test.ts` | — | `BENCH_POINTS` |
| hover pick (interaction) | — | `core/__tests__/hit-test-grid-perf.test.ts` | 1M, world+screen | `BENCH_HIT` (`core/hit-test.bench.test.ts`) |
| network LOD cut + declutter | — | `network/__tests__/frontier-perf.test.ts` | 100k, **all-leaves frontier** | `BENCH_FRONTIER` |
| network LOD super-edges | — | `network/__tests__/super-edges-perf.test.ts` | 100k + all-leaves | `BENCH_SUPER_EDGES` (+ all-leaves) |
| network LOD end-to-end | — | `network/__tests__/lod-perf.bench.test.ts` | — | `BENCH_LOD` |
| network no-LOD labels | — | `network/__tests__/label-candidates-perf.test.ts` | 100k | `BENCH_LABEL_CANDIDATES` |
| network selection dim | — | `network/__tests__/selection-dim-perf.test.ts` | 100k | — |
| node-drag (interaction) | — | `network/__tests__/lod-drag-incremental-perf.test.ts` | small | `BENCH_DRAG` |
| LOD super-edge **build** | — | `network/__tests__/super-edges-build.test.ts` | equivalence | `BENCH_SUPER_EDGES_BUILD` |
| retained memory | — | `core/point-memory.bench.test.ts` | — | `BENCH_MEM` |
| declutter allocation | — | `core/declutter-alloc.bench.test.ts` | — | — |
| plot lane, per-frame | **WebGL** | `map/plot-points-perf.browser.test.ts` | 5k | `PERF_BROWSER_N` |
| declutter flags upload | **WebGL** | `map/declutter-flags-perf.browser.test.ts` | 2k engine / 1M fn | `PERF_BROWSER_N` (max 2M) |
| hover overlay reuse | **WebGL** | `map/hover-overlay-perf.browser.test.ts` | 1000 glyphs / 125 hover changes | ✗ **deliberately unscaled** |
| instanced pie | **WebGL** | `webgl/__tests__/instanced-pie-perf.browser.test.ts` | 100k | `PERF_BROWSER_N` |
| GPU layout tick | **WebGL** | `network/gpu/__tests__/gpu-frame-budget-perf.browser.test.ts` | 30k | `PERF_BROWSER_N` (max 200k) |
| React recolor vs build | **WebGL** | `react/perf.browser.test.ts` | 4096 | capped at 8192 — see below |
| `"auto"` placeholder emit | Canvas→**WebGL** | `map/auto-placeholder-perf.browser.test.ts` | 200k edges / 200k points | `PERF_BROWSER_N` (max 611k) |

**Known holes, tracked:** the at-scale legs drive **backends**, not engines, so the layer above the
backend seam (accessors, lane emit, LOD integration) is only covered at N ≤ 5000 (#263); geo's
at-scale leg is Canvas-only (#264).

**Two guards are deliberately NOT scaled, and both would go *vacuously green* if you scaled them:**
- `hover-overlay-perf` — its layout is a **contract**, not just a size: the 12px cell pitch must stay
  larger than the 8px glyph so `gap(i)` is genuinely empty and `center(i)` is a distinct target.
  Grow the glyph count at a fixed viewport and consecutive centres land on the same device pixel,
  `onPointerMove`'s same-target early exit fires, **no re-target happens at all** — and `built === 0`
  plus a tiny median both still pass. Scaling it needs a target-strip / bulk-block split so the
  sweep targets keep their 8px pitch while the bulk supplies the O(N) recomposite. A non-vacuity
  assertion now pins the contract so this can't rot silently.
- `react/perf` — its central assertion is a **ratio** (`recolorMs < buildMs * 0.25`), and `buildMs`
  is carried by an N-independent shader-compile constant while recolor is ~1µs/drawable of
  d3-color parsing. The ratio inverts somewhere around 10k-50k drawables **with no regression
  present**. Raising its cap means reformulating against an absolute per-drawable cost first.

**Scaling a browser guard:** size the fixture with `perfN(localDefault, { max })` from
`packages/d3gl/src/__tests__/perf-budget.ts` — `max` is mandatory thinking, not decoration, because
each guard hits a different hard wall (the style tables are a 256-wide `GrowTexture`, so past ~2.1M
rows `createTexture` fails at `setLayers` — an error, not a budget; the SVG legs materialise one DOM
node per drawable; the hover guard holds two live charts). Then **split any wall-clock ceiling into
its constant and linear terms** — `perfBudget(c0 + c1 * N / localDefault)`, reducing to exactly the
calibrated number at the local default. Scaling the whole ceiling by `N/local` instead inflates the
constant term and hides a real regression at large N; not scaling it at all makes the guard fail on
the tier's first real run, and the "fix" someone then reaches for is loosening the constant.
Deterministic assertions (counts, identity, pixels) take N straight from the same `perfN` value and
are never given slack by either knob.

**Writing an at-scale leg:** gate it `BENCH_<NAME>`, read its size from `BENCH_<NAME>_N` (the tier
sets it to `$PERF_N` — do **not** hard-code, two benches used to and silently ignored the tier),
assert the deterministic signature *unconditionally*, and put the wall-clock ceiling behind
`PERF_ASSERT` with an env override. See `frontier-perf.test.ts` for the shape.

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

**Stroke joins/caps** must also match. WebGL `expandStroke` (`core/stroke.ts`) tessellates
**miter** joins (bevel fallback past the miter limit), **round** joins (an outer-side arc
fan), and **square/round** end caps (open subpaths only — a quad or a semicircle fan, built
at geometry time, no per-frame cost). `lineJoin`/`miterLimit`/`lineCap` thread from the layer
options through `DrawableOpts` → `expandStroke` and onto `DrawableVector` so Canvas
(`ctx.lineJoin`/`miterLimit`/`lineCap`) and SVG (`stroke-linejoin`/`-miterlimit`/`-linecap` in
`svg/serialize.ts`) render the same corners/ends. Pin them explicitly on every backend — the
native defaults differ (Canvas miter limit 10, SVG 4, and WebGL used to bevel everything).
**Default join is `bevel`.** Each join emits ONLY outer-side geometry (the inner side is
already covered by the two overlapping segment quads); a miter REPLACES the bevel rather than
stacking on it. This matters for **translucent** strokes — redundant overlapping triangles
would double-blend (darken) at joins. A residual remains: the segment quads themselves overlap
on the inner side of sharp turns, which only single-coverage rendering (stencil/RTT —
incompatible with the batched single-pass painter order) would fully remove. It's ~0.4%
(position-tolerant) and opaque strokes are unaffected. luma.gl has no high-level arc/stroke
primitive to lean on — strokes are flattened to polylines (`PathRecorder`) and triangulated here.

**A bordered circle is ONE stroked ring on every path — never two stacked discs (#200, #269).**
Encode it as a single circle on the ring centreline: radius `r·(1 − b/2)` with `stroke-width = r·b`,
so the stroke covers `[r·(1 − b), r]` and the fill shows through inside it. That is what the
instanced-circle fragment shader paints, so all three backends agree — `circlesToDrawables`
(`core/instanced-vector.ts`) for the WebGL export, `traceFrontierGlyphs` + `emitNodes` and
`traceFrontierHalos` (`network/glyphs.ts`) for the retained Scene behind Canvas/SVG, via
`GroupBuilder.point(id, x, y, radius, lineWidth)`.

The Scene path used to stack a border disc under a smaller fill disc. Identical for an **opaque**
fill, wrong for a **translucent** one: the fill disc composites over the border disc, so the ring
colour bleeds through the glyph's interior (12.1% of the frame in the harness). Do **not** re-derive
a bordered glyph as two discs on any backend. Two guards:
`network/__tests__/network-export.browser.test.ts` asserts both paths export the same `<circle
r stroke-width>`, and the harness case below pixel-diffs the instanced lane against the Scene twin.

One residual, inherent to fill+stroke: a circle's stroke **straddles** its path, so the ring's inner
half (`[r·(1 − b), r·(1 − b/2)]`, ~23% of the disc) lands on the fill. With an opaque ring that is
invisible (0 mismatching pixels measured); with a **translucent** ring it double-blends there —
~1.16%, the #46 translucent-stroke residual in circle form, pinned by the #155 harness case at <0.02.
Removing it needs a fill radius decoupled from the stroke radius, i.e. two drawables again, which
loses the single-composite property that matters more.

**The WebGL *Scene* point pass ignores a circle's `lineWidth`** (it draws the fill disc only, from
`pointCenters`) — see #276. Not reachable in the product: the network, the only ring producer,
renders through the WebGL *instanced* lane and only builds the Scene for Canvas/SVG. But a
ring-encoded circle put in a Scene and rendered through WebGL loses its ring, so keep harness cases
for it on the instanced-lane-vs-Scene-twin comparison (as `fadedGlyphs` / `translucentBorderedGlyphs`
do), not on the three-way Scene diff.

**`toSVG()` is also the typed probe for "what did the WebGL lane actually emit".** `pushExportGeometry`
(`map/base-engine.ts`) re-runs the *same* `lane.update(transform, w, h)` that `emitInstancedLane` pushes
to `setInstancedLayer`, so counting elements in the exported document is a deterministic assertion about
the real emit — no `as unknown as { handle: … }` backend spy, no `any`. Prefer it whenever a test needs
to prove a layer was (or was NOT) pushed on **any** backend; it makes the same assertion portable across
WebGL / Canvas / SVG in one loop (see `network/__tests__/network-links-none.browser.test.ts`, #157).

Guard it with the **backend-equivalence harness**
(`map/__tests__/backend-equivalence-harness.ts` + `map/backend-equivalence.browser.test.ts`):
it renders a Scene through both backends and pixel-diffs them (cases: overlapping bordered
shapes for draw order, thick polylines for joins/caps, a translucent-fill bordered glyph for the
ring encoding). Use a **position-tolerant** diff
(radius ≥ 1) — WebGL's tessellated stroke and Canvas's native stroker land ~1px apart along
edges, so an exact-position diff reports ~6% noise that isn't a real divergence. The live
`website` "Backend equivalence" example renders both scenes in all three backends side by
side with synced zoom for eyeballing.

**The render diff does NOT cover the WebGL *export* (#271).** The network's glyphs live in
GPU-instanced lanes with no retained Scene, so `toSVG()` rebuilds them through
`core/instanced-vector.ts` — a converter the draw path never runs. Element-count tests agree even
when a coordinate is wrong, so exports get their own pixel diff:
`map/export-equivalence.browser.test.ts` rasterises the WebGL and Canvas `toSVG()` for the same
view (harness helpers `rasterizeSVG` / `diffExports`) and diffs them position-tolerantly. Two
rules when extending it:
- **Run every case at ≥ 2 zoom levels, and run the `world`-`sizeMode` twin as a control.** The
  screen-mode *bake* is the risky branch — the arrow setback and half-arrow taper/bend are
  constant-**pixel** terms, non-linear in `k`, so they must be solved in pixel space at the export
  `k` and emitted ÷k. At `k = 1` the bake is the identity and proves nothing; in `world` mode
  `bake = 1` and the bug cannot appear, which is exactly what makes it a control.
- **Keep the background transparent** so `considered` counts ink, not the viewport — the fraction
  then reads as "share of the drawing that moved". Both documents go through the *same*
  rasteriser, so the noise floor is 0 (measured 0.00000 on all 16 cases), unlike the
  cross-rasteriser render diff. Don't import the render diff's looser thresholds here.

Bordered nodes are deliberately kept out of that diff (the ring-vs-stacked-discs divergence above);
fold them in when #269 converges the two encodings.

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

   The changelog generator is **`@changesets/changelog-github`** (`.changeset/config.json`),
   so an entry authored in its **own** feature PR auto-links `(#PR)`, commit, and author in
   `CHANGELOG.md`. Only a **backfill** — a changeset committed in a *different* PR than the
   change it documents — needs the original `#PR (commit)` hand-cited in its body, since the
   generator would otherwise link the backfill PR's commit.
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
