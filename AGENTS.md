# AGENTS.md — d3gl conventions & gotchas

Notes for anyone (human or agent) working in this repo. Read before touching geo
rendering, the build, or the test setup.

> The root `CLAUDE.md` imports this file (`@AGENTS.md`) so Claude Code auto-loads these
> conventions every session. **This file is canonical — edit it, not `CLAUDE.md`.**

## Core values

- **Efficient rendering** — Never increase the computational complexity or memory footprint of the rendering path or make a performance-motivated trade-off without first weighing the options and asking me for guidance. Explain the trade-offs concretely: how run time and space grow with the data and which data (all drawables, only visible set, all descendats etc) under each option, and how noticeable it will be for a user. **Never assume that LOD, declutter, culling, or any other reduction technique is on, or that it keeps the scale small.** They are *optional helpers* the user can turn off — and even with LOD on, the **visible set can itself be large-scale**: ≈1M LOD-aggregated glyphs must render as efficiently as ≈1M non-reduced glyphs. LOD and friends are a core part of the answer to scale, but they are helpers, not guarantees — so the rendering path itself must stay efficient at large scale both with reductions **off** (the full-detail draw — for *any* engine: GeoMap layers, Plot layers, or the whole network graph) and with them **on over a large visible set**. See the per-frame test rule (lifecycle §5).
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
   If the change adds, moves, or grows work on a **per-frame path**, you MUST also land an automated
   **per-frame regression test** before requesting verification. A **per-frame path** is anything
   reachable from `setTransform` / `render` / a selection `emit` / a draw loop — **and any continuous
   pointer interaction: hover-move, node-drag, marquee-drag.** These fire on *every* pointer event while
   the pointer moves, so a hover-drag across glyphs is effectively per-frame — it is **not** "just a
   click" and gets no exemption. (Exactly this was the loophole once: a hover restyle was classed as
   click-frequency and re-emitted the whole graph per hovered node — a severe drag lag.) The test must:
   - drive a **realistic large input** — ≈1M drawables (points / nodes / edges / shapes, including
     half-edges) — through the **actual trigger** (a `setTransform` zoom sweep for the draw path; a
     **hover sweep across glyphs / a drag** for an interaction path) and assert a **frame budget** (a
     wall-clock ceiling generous enough to be non-flaky but tight enough to catch an order-of-magnitude
     drop). "Large" is about the set the path actually processes — not just a total count of ≈1M, but a
     **visible set of ≈1M *even with reductions on*** (don't let LOD off the hook by assuming it shrinks
     the frontier). Test **both** reduction states — a green test on one does not prove the other, and a
     proxy pipeline instead of the real trigger does not count:
       - **reductions ON (LOD / declutter)** — the common case users run, so keeping it fast is the
         *primary* goal: per-frame work must be O(visible), not O(total); **and** a ≈1M-glyph aggregated
         *visible* frontier must be as efficient as ≈1M non-reduced glyphs;
       - **reductions OFF (full detail drawn)** — must ALSO hold: it's where an O(N)-per-frame or
         per-interaction cost hides. **and**
   - assert the regression's **deterministic signature** directly where one exists: per-frame
     work the baseline did **once** must stay once — e.g. spy that style/colour resolution (or any
     accessor) runs **O(data) at registration, not O(visible) per frame**; that GPU buffers are
     **updated in place, not destroyed + recreated** each frame; and that an interaction restyle
     (hover/select) issues **no geometry re-emit/upload** (only a uniform / small in-place buffer write).

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

### Winding is DATA, not decoration: it decides solid vs hole (#73)

Canvas (`ctx.fill()`) and SVG (`fill-rule: nonzero`) resolve a drawable's subpaths with the
**nonzero winding rule** natively. WebGL cannot — `PathRecorder` hands `groupRings`
(`core/rings.ts`) a flat list of rings with no outer/hole marking, and earcut needs
`{ outer, holes }`. So **`groupRings` reimplements nonzero**: for each ring it sums the
directions of the rings enclosing it, and the ring is an outer where the fill turns on
(outside 0, inside ≠ 0), a hole where it turns off, dropped where neither. Consequences:

- Nesting works at **any depth** — land ▸ lake ▸ island ▸ pond — because the convention makes
  winding alternate with depth. It used to be single-level, so an island in a lake became a
  second hole of the land: the island vanished and earcut, handed two overlapping holes,
  dropped geometry outright (6.2% of the harness frame diverged from Canvas).
- **Do not "fix" a classifier bug by switching to even-odd / by depth parity.** Even-odd
  agrees with nonzero only while the data alternates; where it doesn't (two nested rings wound
  the same way) even-odd invents a hole that Canvas and SVG do not draw, i.e. it *creates* a
  backend divergence. Nonzero is the reference because it is what the other two backends run.
- The same classification drives **hit-testing** (`HitIndex` in `core/hit-test.ts` calls
  `groupRings`), so a fill bug here is also a picking bug — an island in a lake is unclickable.
- Guards: `core/__tests__/rings.test.ts` (classification + tessellated area),
  `geo/__tests__/project.test.ts` (through the real `geoPath` projection),
  `core/__tests__/hit-test.test.ts`, and the `nestedRingShapes` case in
  `map/backend-equivalence.browser.test.ts` (three-way pixel diff).

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
  `process.env` — a define is the only way in. **`PERF_REAL_GPU=1`** (unset on CI; for the hardware-GPU tier
  #392) marks a run on a hardware GPU (`perfRealGpu`, with `softwareRenderer()` to check it): a wall-clock
  comparison between a GPU path and a CPU-worker path asserts only then — under SwiftShader, GL competes with
  the page's workers for the runner's cores — and the guard asserts its deterministic counts everywhere.

### Perf-guard coverage map (#258 — check here before claiming a cell is covered)

Which guard covers which §5 cell. **A cell that runs but asserts nothing is not covered** — that
was the #258 finding: 6 of the node benches printed numbers at `PERF_N` and gated on nothing but the
per-file timeout. Every at-scale leg below now asserts. When you add a guard, add its row.

| path | backend | guard | always-on | at-scale (CI `perf`, `PERF_N`) |
|---|---|---|---|---|
| plot points, full detail | Canvas | `canvas/__tests__/canvas-zoom-sweep-perf.test.ts` | 100k | `BENCH_CANVAS_SWEEP` |
| plot points, retained DOM | SVG | `svg/__tests__/svg-zoom-sweep-perf.test.ts` | 100k | `BENCH_SVG_SWEEP` |
| geo polygons + clip | Canvas | `geo/__tests__/geo-zoom-sweep-perf.test.ts` | 50k cells | `BENCH_GEO_SWEEP` |
| geoMap append | — | `map/__tests__/append-scaling-perf.test.ts` | O(new) delta | — |
| layer push, Scene seam | — | `core/__tests__/vector-view-perf.test.ts` | 1M, ×20 pushes | — |
| plot declutter `select()` | — | `map/__tests__/points-lane-scratch-perf.test.ts` | 1M | — |
| plot points lane sweep | — | `map/__tests__/points-lane-perf.bench.test.ts` | — | `BENCH_POINTS` |
| hover pick (interaction) | — | `core/__tests__/hit-test-grid-perf.test.ts` | 1M, world+screen | `BENCH_HIT` (`core/hit-test.bench.test.ts`) |
| network LOD cut + declutter | — | `network/__tests__/frontier-perf.test.ts` | 100k, **all-leaves frontier** | `BENCH_FRONTIER` |
| network LOD super-edges | — | `network/__tests__/super-edges-perf.test.ts` | 100k + all-leaves; **ragged** module tree 100k (sweep + mixed-level + all-leaves, #325); **Map-free scratch** (#364) on the ragged tree: zero `Map`/`Set` writes over sweep + mixed + all-leaves (line and half-arrow, cross-level on/off), memo identity, element-identical to the Map-based gather (`super-edges-map-reference.ts`; equivalence also in `super-edges-memo.test.ts`, `super-edges-depth.test.ts`), claims non-vacuous; zero `Map`/`Set` writes with anchoring (#329) and claims in `super-edges-memo.test.ts` | `BENCH_SUPER_EDGES` (+ all-leaves; ragged leg too; #364 vs the Map gather, interleaved: ≤ 1× sweep, ≤ 0.75× mixed + all-leaves, transient heap ≤ 4 B/pair (sampling profiler, colours through the engine's memo `resolveLinkColorOf`) under `PERF_ASSERT`) |
| network LOD **spatial source** (#343): cut (culled roots recorded) + declutter + lazy leaf-run super-edges, on a web-like graph whose communities the layout spreads — streamed (row memo cold per frame), zoom (memo warm), all-leaves frontier, reductions off (every edge drawn), drag; no super-edge CSR, held view = 0 rows rebuilt / 0 incidences walked / 0 leaves labelled, byte-identical; at most one walk per graph incidence per frame (`visits ≤ incidences` — the streamed/zoom legs are O(edges under the kept glyphs) by design, which is why their ceilings keep a per-100k term); gather scratch never reallocated once warm; screen-bounded streamed frontier. **streamed-rows** (#433): the streamed sweep on trees carrying the super-edge rows a worker built for the glyphs each frame's view keeps (`lazySuperEdges` takes them) — 0 rows computed and 0 incidences walked per frame, the lazy gather's pairs and flows, row entries read ≤ 2× the lazy gather's row entries + the kept leaves' own edges (bounded by what the kept glyphs link to, not by the edges under them); **streamed-gesture**: a pan + zoom with each tree's rows one view behind — the same edges, never more incidences walked than the lazy gather at that cut; the worker's **rows-build** has its own ceiling. Equivalence with the lazy gather over views, declutter, cross-fade, link styles, a moved view, a coarser cut (every row taken) and an opened one (the rows naming it rebuilt, then held) in `spatial-rows.test.ts`. The **force drag through the real trigger** (0 tree builds / 0 style passes per drag frame, 1 rebuild after the cool-down) lives in `network-spatial-lod.browser.test.ts`; the **worker stream through the real trigger** (every streamed repaint with the worker's tree: 0 incidences walked, 0 rows computed, 0 main-thread row builds, with the camera following the fit — also with the live positions moved on from the drawn tree's before each repaint, as in shared mode, where the engine frames the box the rows were cut at) in `network-spatial-lod-stream-perf.browser.test.ts` (browser tier, `PERF_BROWSER_N` max 50k); the worker's back-pressure (nothing posted — no frame, no `done` — while `MAX_OUTSTANDING` trees are out; positions always travel with their tree) in `worker-layout.browser.test.ts`; and the GPU relay's in `gpu-lod-spatial-perf.browser.test.ts`; the transition in the row below | — | `network/__tests__/spatial-lod-perf.test.ts` | 100k | `BENCH_SPATIAL_LOD` (all legs at `_NODES`, constant + per-100k ceilings under `PERF_ASSERT`) |
| network LOD module boundaries (#329): cut collection + rings + anchored module links | — | `network/__tests__/module-boundary-perf.test.ts` | 100k `.ftree`-shaped map: sweep on/off, every module open (declutter on **and** off), raw-network identity | `BENCH_MODULE_BOUNDARY` (+ on/off ratio under `PERF_ASSERT`) |
| network LOD end-to-end | — | `network/__tests__/lod-perf.bench.test.ts` | — | `BENCH_LOD` |
| streamed LOD frame: super-edge colour memo + mixed-radius declutter (radius-class grid, single-grid fallback) + unchanged-style-column compare | — | `network/__tests__/lod-frame-waste-perf.test.ts` | 100k sweep + all-leaves frontier (colour calls ≪ drawn edges, exact bytes; probes/glyph); 200k dense mixed-radius screen (single-grid identity); 200k cap-dominated screen with a tiny glyph kept first (identity; cells/glyph, probes vs the single grid); 200k-edge full-detail colour pass (calls = distinct weights); 100k continuous flows past the memo's bound (interleaved min-of-9 ≤ 1.15× no memo under `PERF_ASSERT`); `StableColumns` unchanged emit at 100k super-edges (identity; ms ceiling under `PERF_ASSERT`) | `BENCH_LOD_FRAME_WASTE` (dense + cap-dominated declutter, sweep, `StableColumns`, full-detail colours, all at `_N`) |
| network no-LOD labels | — | `network/__tests__/label-candidates-perf.test.ts` | 100k | `BENCH_LABEL_CANDIDATES` |
| network selection dim | — | `network/__tests__/selection-dim-perf.test.ts` | 100k | — |
| node-drag (interaction) | — | `network/__tests__/lod-drag-incremental-perf.test.ts` | small | `BENCH_DRAG` |
| node-drag, main-thread `force` tick (one per frame over **all** nodes; LOD-independent) | — | `network/__tests__/force-drag-tick-perf.test.ts` | 100k nodes / 200k edges | `BENCH_FORCE_DRAG` |
| position transition frame (#328) | — | `network/__tests__/transition-perf.test.ts` | 100k, LOD on **and** off, vs a streamed layout frame | `BENCH_TRANSITION` |
| streaming fit box, per streamed frame (#327) | — | `network/__tests__/fit-box-perf.test.ts` | 200k leaves (LOD-independent): clean disc in radial **and** shuffled order + 64 stragglers; exact, allocation-free | `BENCH_FIT_BOX` |
| LOD super-edge **build** | — | `network/__tests__/super-edges-build.test.ts` | equivalence | `BENCH_SUPER_EDGES_BUILD` |
| retained memory | — | `core/point-memory.bench.test.ts` | — | `BENCH_MEM` |
| declutter allocation | — | `core/declutter-alloc.bench.test.ts` | — | — |
| plot lane, per-frame | **WebGL** | `map/plot-points-perf.browser.test.ts` | 5k | `PERF_BROWSER_N` |
| declutter flags upload | **WebGL** | `map/declutter-flags-perf.browser.test.ts` | 2k engine / 1M fn | `PERF_BROWSER_N` (max 2M) |
| hover overlay reuse | **WebGL** | `map/hover-overlay-perf.browser.test.ts` | 1000 glyphs / 125 hover changes | ✗ **deliberately unscaled** |
| instanced pie | **WebGL** | `webgl/__tests__/instanced-pie-perf.browser.test.ts` | 100k | `PERF_BROWSER_N` |
| GPU layout tick (+ #349 signatures: no draw of ≥ N vertices × instances into a 1×1 viewport, via any of the five WebGL2 draw calls; zero texture / framebuffer / buffer creation per tick); hub springs (#350): hub rows in web-NotreDame's shape, scaled with N (0.52% of rows, its five > 4096 hubs, chunk count K ≥ N/30), tick ≤ 2× a hub-free twin with the same edges, and exactly one extra draw (the chunk pass, K fragments) with no per-tick allocation; tile pyramid (#354): one scatter into the L0 atlas and one reduce per coarser level, each rasterising exactly its level's rectangle of the packed Podd / Peven textures (draws are attributed by texture identity, never by size: for N in (W² − W, W²], W a power of two, the slot atlas is W × W, the size of L0) | **WebGL** | `network/gpu/__tests__/gpu-frame-budget-perf.browser.test.ts` | 30k | `PERF_BROWSER_N` (max 200k) |
| GPU layout tick sliced into row bands (#352): 4 bands per tick bitwise equal to the unsliced tick (hub rows included), 12 scissored force draws, no allocation per band — on a flat **and** a `multilevel` solver (#353: every seeded run ticks the graph's level on the latter), whose graph-level ticks are also pinned bitwise equal to the flat solver's (pyramid with hub rows, and all-pairs) | **WebGL** | `network/gpu/__tests__/gpu-frame-budget-perf.browser.test.ts` | 30k | `PERF_BROWSER_N` (max 200k) |
| GPU layout convergence stop (#376): exactly three 1×1 draws per tick — the pyramid root, the range query and the one-fragment stop latch — and the same draw list unarmed, on the tick the latch sets (armed past `MIN_SETTLE_TICKS`), and on a frozen tick after it; no allocation per tick with the stop armed or latched | **WebGL** | `network/gpu/__tests__/gpu-frame-budget-perf.browser.test.ts` | 30k | `PERF_BROWSER_N` (max 200k) |
| GPU layout work items (#402): every item submits exactly once, after its passes — P (its passes are its dependency chains: the reduction tree's levels + the range query, the latch, the L0 scatter + one reduce per coarser pyramid level, the hub chunks), each F_b and I (one pass each), an unsliced tick (3), each seed step and seed tick on a `multilevel` solver, and a readback copy (its reductions, latch and staging passes); no render pass that draws nothing (a clear is the first drawing pass's `clear`); a force band clears exactly its own rows (bitwise: its rows this tick's forces, the others the previous tick's) | **WebGL** | `network/gpu/__tests__/gpu-frame-budget-perf.browser.test.ts` (item spies: `_item-recorder.ts`) | 30k | `PERF_BROWSER_N` (max 200k) |
| GPU layout **streaming** through `network().layout({ backend: "gpu" })`, LOD off **and** on (#352): transport-only main thread per frame (p95 ceiling `c0 + c1·N`), encode median ≤ 2.5 ms; every streaming `readPixels` into a bound PBO; every `getBufferSubData` after a fence inserted after its copy was seen signalled; within a frame the harvest precedes every layout draw; exactly one fence per frame; no GPU object created per streamed frame (under LOD from the cut's first repaint; an instanced lane may grow, at least doubling); repaints ≥ 48 ms apart; `settled` after the final tick's harvest; ticks/s floored against the GPU-only rate; exactly one `device.submit()` per solver work item and per readback copy (#402). **Node drag** on the same engine (a real pointer drag of the settled layout, LOD off **and** on): the same transport bounds and GL signatures over the held and re-cool frames, no GPU object created, `setPinned` once per pointer move and held-position writes at most once per tick, each over the held set (O(held)), ticks and repaints while held | **WebGL** | `network/gpu/__tests__/_gpu-stream-harness.ts`, run as `gpu-stream-nolod-perf.browser.test.ts`, `gpu-stream-lod-perf.browser.test.ts` and `gpu-stream-seed-perf.browser.test.ts` (one file per reduction state and one for the seeded LOD run, each under the tier's 300 s per-file budget) | 100k | `PERF_BROWSER_N` (max 1M) |
| GPU layout **LOD while streaming** (#377): the LOD-on leg of the row above runs at a fit view (the whole equilibrium disc), draws the LOD worker's tree (`lodSource === "worker"`), and its main-thread ms per repaint (commit + repaint) stays within 1.5× + 2 ms of the **worker backend's** repaint on the same engine, graph and view, both from a disc cold start (a multilevel seed shares the LOD tree's hierarchy, so its frontier is a fraction of a cold start's: comparing it measures the seed). LOD lanes may grow their buffers on a few repaints after the tree arrives, never outside a repaint, never on most. The ratio is a loose bound (the GPU leg runs 60 ticks, the worker's 12, so their frontiers differ): it catches an order-of-magnitude regression, not a reintroduced 5-15 ms geometry pass, and the Navigator switch's gate (spec §12.3) reads the measured ratios in #377 (0.83 at 325k, 0.74 at 1M, 1.06 at 100k on an M1 Max). **Deterministic signatures** — the regression guards: `gpu-lod-mainthread.browser.test.ts`, zero main-thread `buildLODTree` / `computeLODGeometry` / `computeLODPositions` through `lod()` after a GPU layout, the streamed repaints, a node drag with its re-cool, and pan/zoom; `gpu-lod-relay.browser.test.ts`, the final frame of a run and of a re-cool is copied, refit and painted once (no repaint or refit after `settled`, no copy repeating the previous copy's ticks) | **WebGL** | `network/gpu/__tests__/_gpu-stream-harness.ts` (run by `gpu-stream-lod-perf.browser.test.ts`) + `gpu-lod-mainthread.browser.test.ts` + `gpu-lod-relay.browser.test.ts` | 100k / 6k / 4k | `PERF_BROWSER_N` (max 1M) / ✗ counts |
| GPU layout **LOD while streaming, spatial source** (#343 × #377): the relay's worker rebuilds the spatial tree per relayed frame (`lodFrameStep`); through `lod({ source: "spatial" }).layout({ backend: "gpu" })` at a fit view on a web-NotreDame-shaped graph (communities the layout spreads, 4.6 edges per node), disc start **and** seeded: **zero main-thread `mortonTopologyBuilds` and `lodStylePasses` on every streamed frame** (live counters a real worker never touches), the frontier the spatial one (lazy gather, screen-bounded glyphs), commit p95 `c0 + c1·N`, T7's transport bounds, 0 incidences walked / 0 rows computed / 0 row builds on the main thread per repaint with the relay's tree (#433); and the **lifecycle §5 baseline against the worker backend** on the same engine, graph and view over as many ticks: the same deterministic per-repaint work on both sides (0 tree builds, 0 style passes, 0 row builds, 0 incidences walked, 0 rows computed, a screen-bounded frontier) **everywhere**, and commit + repaint within 1.5× + 2 ms of the worker backend's repaint **only on a hardware GPU** (`PERF_REAL_GPU=1`, the `__PERF_REAL_GPU__` define — for the hardware tier #392 — which also asserts the renderer is not software). On SwiftShader GL is CPU work competing with the relay's worker for the runner's cores: the same code read 1.3× locally and 3.6× on CI, so the ratio is logged there, not asserted (the user's decision on #425). `gpu-lod-relay.browser.test.ts` pins each repaint's tree bitwise against a main-thread build at its positions, no relay or repaint after `settled`, zero main-thread builds through a drag, its re-cool and pan/zoom, the selection remap, an edge-less graph and `style()` mid-run | **WebGL** | `network/gpu/__tests__/gpu-lod-spatial-perf.browser.test.ts` + `gpu-lod-relay.browser.test.ts` | 100k / 4k-8k | `PERF_BROWSER_N` (max 1M) / ✗ counts |
| GPU **multilevel seed** (#353) on one solver: a seed level's forces from identical positions equal the mass-weighted grid-pyramid reference (p99 ≤ 1e-4) and the CPU's exact mass-weighted forces on an all-pairs level, and on a hub-heavy Barnes-Hut level (#403: supernodes of thousands of nodes) within p99 0.1 of exact per finest node, with no slot's own mass in the cells it sits in; a hub-heavy graph's seed frame spans at most 1.1× its settled extent (the stragglers a fit then zooms in from); each Barnes-Hut seed level's tick (the mass-weighted tile traversal, supernodes of thousands of nodes) stays under the flat tick's ceiling at its slot count and under the graph's own tick + 10 ms, timed interleaved on a second solver, so a seed-only runaway the flat legs cannot see fails it; `setLevel` and a level's ticks create no texture, framebuffer or buffer (`beginSeed` sizes everything once) and start every slot at rest (Σ\|v\| = 0); a whole seed compiles no shader and links no program on a fresh device (the seed's programs are built with the solver); placing the levels without solves lands the nodes exactly where the plan does (prolongation, and a ragged module tree's leaf seed). Streamed, LOD off **and** on (T7: the LOD-on seeded leg is the Navigator's path — plan and tree from the relay's worker, adoption during the seed; the disc-start LOD-on leg keeps the like-for-like worker baseline): the seed's frames carry every transport bound and GL signature of the row above, the first frame harvested is the seed frame (tick 0), no seed work item creates a GPU object, `beginSeed` (the seed's one allocation, when the plan arrives, outside the frame loop) stays under a ceiling a program compile would trip, and every seed frame stays under a max transport ceiling. `gpu-stream.browser.test.ts` pins T10: no frame before the plan, pins held until the nodes are placed, a stop mid-seed deletes every fence, `iterations: 0` paints the seed once, a seed that cannot start runs cold from the disc and a seed step that throws settles (one warning each) | **WebGL** | `network/gpu/__tests__/gpu-multilevel-seed.browser.test.ts` + `gpu-frame-budget-perf.browser.test.ts` + `_gpu-stream-harness.ts` (run by `gpu-stream-nolod-perf.browser.test.ts` and `gpu-stream-seed-perf.browser.test.ts`) + `gpu-stream.browser.test.ts` | 18k (BH level) / 40k hub-heavy / 30k seed ticks / 1M module tree / 100k streamed | `PERF_BROWSER_N` (max 200k) on the seed ticks, (max 1M) on the streamed legs |
| GPU **nested** layout streaming through `network().data(g, { modules }).layout({ backend: "gpu", nested })` (`"auto"` resolves to the same run, #375), LOD off **and** on (#355): transport-only main thread per frame (p95 ceiling `c0 + c1·N`), encode median ≤ 2.5 ms; every streaming `readPixels` into a PBO, every harvest after its copy's fence signalled, each readback PBO written once and then read once per copy, one fence per frame, the harvest before the frame's layout draws, no GPU object created per streamed frame, no draw of ≥ N points into a 1×1 viewport, `settled` after the final stream tick's harvest; repaints ≥ 48 ms apart; stream ticks/s (LOD off) floored against the same solve's GPU-only rate; at most one `device.submit()` per work item and exactly one per readback copy (#402). Per solve tick: no allocation (ticks and readbacks), and a collision step draws exactly one count scatter and K round scatters per hash table (8 for the class cells, 12 for the sub-cells) of the binned slots; every item that encodes a pass submits once (the compact swap encodes none), a copy once, and no pass only clears (#402). A **module of very uneven child sizes** (#380, a Zipf module): the same transport bounds, signatures and throughput floor through the real trigger, a collision step's pair work within 3× of the collision plan's estimate with no slot on the exact fallback, and compact bands of equal estimated work | **WebGL** | `network/gpu/__tests__/_nested-perf.ts`, run as `gpu-nested-perf.browser.test.ts` (the Infomap-shaped stream, the per-tick signatures, the Zipf module's collision plan) and `gpu-nested-zipf-perf.browser.test.ts` (the Zipf module's stream; at CI's scale it takes about 185 s of the tier's 300 s per file on its own) | 20k leaves (Zipf: 20k children) | `PERF_BROWSER_N` (max 1M; Zipf max 60k, a known hole: at 100k children the Zipf stream leg alone takes 270 s on SwiftShader against the tier's 300 s per file, and its layout reaches the exact fallback, #380 D3) |
| GPU **nested** warm re-layout with a transition through `network().layout({ backend: "auto", nested: { warm: true }, transition })` (#375, #328; the re-clustering call), LOD off **and** on, against the worker's warm + transition run on the same engine and map: resolves to the GPU; exactly one copy, each readback PBO written once and then read once, after its fence signalled; one fence per solve frame; no GPU object created per solve frame; no draw of ≥ N points into a 1×1 viewport; transport-only main thread per frame (the streaming row's p95 ceiling), encode median ≤ 2.5 ms; every callback of each solve frame (p95) within that ceiling — the worker spends no main-thread frame on the solve, and the tween's frames are the same code on both paths (the transition row bounds them) | **WebGL** | `network/gpu/__tests__/_nested-perf.ts`, run as `gpu-nested-warm-perf.browser.test.ts` (a file of its own for the tier's 300 s per file) | 20k leaves | `PERF_BROWSER_N` (max 1M) |
| GPU **nested** solve under **interaction** through `layout({ backend: "auto", nested })` (#375): a real pointer drag of a leaf, then a `setTransform` zoom sweep, during the cold stream and during the warm solve before its transition, LOD off **and** on, against the same interaction during the worker's solve: the held leaves under the cursor after every frame, GPU harvests included; the transport's p95 ceiling and encode median; every harvest after its copy's fence, each readback PBO written once and then read once, one fence per solve frame, no GPU object created in a solve frame (the sweep's lane growth inside `setTransform` and a landed map's repaint are the draw path's, #395, reported apart); main-thread per-frame p95 below the worker run's plus the transport ceiling | **WebGL** | `network/gpu/__tests__/gpu-nested-interaction-perf.browser.test.ts` | 20k leaves | ✗ max 20k: a drag repaints every pointer move, and software GL paints a LOD-off frame of 100k leaves in seconds (one variant took 183 s at 100k, past the tier's per-file budget) |
| GPU streaming readback `AsyncPositionReadback` (#352), `RG/FLOAT` and packed `RGBA/FLOAT`: exact positions and stats, both PBOs `STREAM_READ`, one `readPixels` per PBO per copy (into the PBO), no allocation per readback, copy and harvest main-thread ceilings, a non-finite layout refused without touching positions | **WebGL** | `network/gpu/__tests__/gpu-async-readback-perf.browser.test.ts` | 1M | `PERF_BROWSER_N` (max 4M) |
| GPU layout position readback through `GpuForceLayout.readPositions`, `RGBA/FLOAT` (a device that refuses `RG/FLOAT`) and `RG/FLOAT` (#351): exact positions, no GPU allocation and one `readPixels` per readback, one retained RGBA scratch | **WebGL** | `network/gpu/__tests__/gpu-readback-perf.browser.test.ts` | 1M | `PERF_BROWSER_N` (max 4M) |
| React recolor vs build | **WebGL** | `react/perf.browser.test.ts` | 4096 | capped at 8192 — see below |
| `"auto"` placeholder emit | Canvas→**WebGL** | `map/auto-placeholder-perf.browser.test.ts` | 200k edges / 200k points | `PERF_BROWSER_N` (max 611k) |
| `"auto"` placeholder **paint** | Canvas→**WebGL** | same file, `#273` describe block | 30k geo polygons | `PERF_BROWSER_N` (max 120k) |
| `pushLayers()` vector view | Canvas + **WebGL** | `map/push-layers-perf.browser.test.ts` | 20k geo polygons | `PERF_BROWSER_N` (max 120k) |
| geo polygons + clip, per-frame | **WebGL** | `map/geo-sweep-perf.browser.test.ts` | 30k polygons | `PERF_BROWSER_N` (max 200k) |
| geo polygons + clip, retained DOM | SVG | same file, SVG describe block | 20k polygons | `PERF_BROWSER_N` (max 60k) |

**Known holes, tracked:** the at-scale legs drive **backends**, not engines, so the layer above the
backend seam (accessors, lane emit, LOD integration) is only covered at N ≤ 5000 (#263).

**Geo is now guarded on all three backends** (#264), and the three legs are deliberately *not*
copies of each other — each pins the contract its own backend actually has:
- **Canvas** (node, immediate mode) — `beginPath` once per drawable per frame and a constant
  `lineTo` total; the `Path2D` clip silhouette built once for the whole sweep.
- **WebGL** (browser, the default backend) — no re-projection (a counting `projection.stream`), no
  fill/stroke accessor re-run, zero geometry/style writes reaching `WebGLBackend`, and a zero delta
  on `groupRendererConstructions`. Its wall-clock ceiling is deliberately **constant-dominant**: the
  CPU frame measured 0.4-0.8 ms flat from 30k to 200k polygons, so a linear term would only make
  room for the regression it guards against.
- **SVG** (browser, retained DOM) — a real `MutationObserver` over the whole `<svg>`: a zoom must
  produce exactly one `transform` attribute record per frame and **zero** structural records.

Two consequences worth keeping: geo's always-on Canvas leg is 50k, not the 100k the *plot* legs use,
because a geo polygon costs a `geoPath` stream + tessellation + a stroke ring and this fixture
crosses a heap-growth cliff above ~75k (3.9 s at 100k vs 0.72 s at 50k, cold) for signatures that
are exact at every N. And the SVG leg is not scaled to the tier's N for the same reason the plot SVG
guard owns the serialize budget: one DOM node per drawable buys parse time, not strictness.
| **`geoMap()` engine sweep** | **WebGL** | `map/geo-map-sweep-perf.browser.test.ts` | 20k cells | `PERF_BROWSER_N` (max 150k) |
| **`plot()` engine sweep**, retained Scene | **WebGL** | `map/plot-engine-sweep-perf.browser.test.ts` | 50k ×2 layers | `PERF_BROWSER_N` (max 300k) |
| **`network()` engine sweep**, LOD on **and** off, + held LOD view per link primitive (lines, directed lines + arrowheads, half-arrows: unchanged style columns re-emitted as the same arrays, endpoint-only upload) + declutter cost signature via `net.declutterStats` (probes/cells per glyph, scratch high-water) on the sweep and a dense mixed-radius all-leaves leg + the **spatial source** (#343: lazy links via `net.superEdgeStats`, held view 0 rows rebuilt / 0 incidences walked, same style columns, endpoint-only upload) | **WebGL** | `network/__tests__/network-sweep-perf.browser.test.ts` | 50k nodes / 50k edges | `PERF_BROWSER_N` (max 200k) |
| **`network()` position transition** (#328), LOD on **and** off + the spatial source (#343), vs a streamed frame; count signature: **no `computeLODStyle` pass and no spatial tree build** on a transition frame (`lodStylePasses` / `mortonTopologyBuilds`), ≥ 1 per streamed frame | **WebGL** | `network/__tests__/network-transition-perf.browser.test.ts` | 100k nodes (the ON ratio needs the style pass to be a real share of the streamed frame — see the file) | `PERF_BROWSER_N` (max 200k) |
| **`network()` node-drag, main-thread `force` backend** (real pointer drag: one tick + repaint per frame, re-cool stop), LOD on **and** off | **WebGL** | `network/__tests__/network-force-drag-perf.browser.test.ts` | 50k nodes / 100k edges | `PERF_BROWSER_N` (max 200k) |
| **`network()` module boundaries** (#329), sweep on vs off + every module open | **WebGL** | `network/__tests__/network-module-boundary-perf.browser.test.ts` | 50k nodes | `PERF_BROWSER_N` (max 200k) |
| **`network()` streaming fit** (#327), per streamed frame, fit on vs off at an equal view, LOD on **and** off; box once per frame, never on zoom frames or after release; no extra LOD cut or style resolution per fitted frame | **WebGL** | `network/__tests__/network-fit-stream-perf.browser.test.ts` | 50k nodes | `PERF_BROWSER_N` (max 200k) |
| **`network()` programmatic `setTransform` with zoom enabled** (#309), LOD on **and** off: one re-cut + one Scene rebuild per call, no gesture boundary; zoom-free calls rebuild nothing | Canvas + SVG | `network/__tests__/network-vector-zoom-perf.browser.test.ts` | Canvas 20k / SVG 10k nodes | `PERF_BROWSER_N` (Canvas max 100k, SVG max 30k) |
| **`network()` pan/zoom + node-drag INPUT** (#367): wheel, pan, drag and wheel+stream+drag bursts through the real d3-zoom / pointer listeners, LOD off, aggregate frontier **and** all leaves visible; no cut or render inside any handler, exactly one render + ≤1 cut per frame at the latest transform, handlers O(1) per event, the burst's frame ≤ 2× one event's (LOD-off pan/zoom frame: **count-only** — it only renders, and the render is counted; `network-sweep-perf` owns that draw's cost) | **WebGL** (draw counted, not rasterised — see below) | `network/__tests__/network-input-coalesce-perf.browser.test.ts` | 250k nodes / 748k edges, whole graph in view | `PERF_BROWSER_N` (max 250k) |
| multi pass-through: FBO count + gesture skip | **WebGL** | `map/passthrough-multi-perf.browser.test.ts` | 25k ×2 layers | `PERF_BROWSER_N` (max 50k) |
| label placement (`cullLabels`) | — | `labels/__tests__/label-cull-perf.test.ts` | 200k candidates, dense **and** spread | `BENCH_LABEL_CULL` |
| **`network.labels()` per-frame**, LOD on **and** off, + capped LOD top-k (`importanceOf` once per candidate) | **WebGL** | `network/__tests__/network-labels-perf.browser.test.ts` | 20k nodes, uncapped + `max: 50` | `PERF_BROWSER_N` (max 50k) |

**Known holes, tracked:** geo's at-scale leg is Canvas-only (#264). The GPU layout tick guard is capped
at `PERF_BROWSER_N` ≤ 200k (a SwiftShader 1M tick would spend the tier's 300 s per-file budget), so the
≈1M tick §5 asks for is measured only by hand on real hardware (#333); the #349 draw signature is exact
at any N and is the automated part. *(Closed: #263 — the at-scale
legs used to drive **backends** only, leaving accessors / lane emit / LOD integration covered at
engine level only at N ≤ 5000. The three `*-sweep-perf.browser.test.ts` rows above now drive each
engine's public entry point through the real `setTransform` at `PERF_BROWSER_N`.)*

**Engine-level sweeps (#263) live in the BROWSER tier, deliberately.** Every engine constructor
takes an `HTMLElement`, makes backend `<canvas>` elements, and resolves its box from layout; and the
layer the sweeps exist to cover — instanced lanes, style-table textures, `updateInstancedLayer`'s
in-place write — only exists on WebGL. A node fake host would make "GPU buffers are updated in
place" an assertion about the fake, and a node fake *canvas* is precisely the seam
`canvas-zoom-sweep-perf` already owns. Shared helpers: `packages/d3gl/src/__tests__/engine-sweep.ts`
(`perfHost`, `zoomSteps`, `sweepFrames`, `GlBufferSpy`). Two things learned building them:

- **`GlBufferSpy` counts uploads, not just create/delete — and the upload counter is the one with
  teeth.** Patching `createBuffer`/`deleteBuffer`/`bufferData`/`bufferSubData` on
  `WebGL2RenderingContext.prototype` is the cast-free way to assert both GPU signatures. They catch
  *different* regressions: re-pushing the same arrays into the **same** buffer every frame (the #186
  "render re-emit" shape) moves no create/delete count at all. Proven: making the network's
  full-detail lane `dynamic` re-uploaded 28.8 MB over an 18-frame sweep while create/delete stayed
  at 0 and every accessor count stayed flat. Assert it as a **ratio of the registration upload**
  (`< registration / 1000`), not `toBe(0)`, so a future per-frame uniform write isn't a false
  positive while any geometry re-upload is 1000× over.
- **Local headless Chromium rasterises on SwiftShader** (its GPU process runs `--use-angle=swiftshader-webgl`),
  so drawing a ≈1M-instance frame costs **seconds** there and every later draw queues behind it: a guard that
  renders a 1M-drawable scene a few dozen times stalls for minutes (#367 measured 15-45 s idle waits between
  bursts, and a hook timeout at 490 s), without any of that being CPU work the guard is about. A guard whose
  subject is CPU-side work at ≈1M may **count** `render()` in its probe subclass instead of submitting it
  (`network-input-coalesce-perf`), as long as it asserts the render count and another guard owns the real
  draw's CPU cost (`network-sweep-perf`).
- **Never build a second WebGL engine in the same file after a large one.** Constructing a second
  engine once a first has uploaded a ~100k-node graph stalls `whenReady()` for **9–12 s** on local
  headless Chromium (measured 24 ms → 12,168 ms → 9,251 ms → 20 ms across four sequential engines);
  it turned a 1.6 s network guard into 33 s. Share **one** engine across legs and toggle the thing
  under test (`lod()` on/off, two layers on one chart). Tracked as #287.

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

## GPU layout: reduce with a gather tree, never a 1-texel scatter (#349)

**Never reduce over all N nodes by scattering N points into one texel** with ADD or MAX blending.
The blend unit serialises on that texel. The GPU force layout used to find its centroid and its
bounding box this way: 17.3 ms + 18.8 ms of a 43-46 ms tick at 325k nodes on an M1 Max (53 + 57 of
136-141 ms at 1M). Use the segmented reduction instead (`network/gpu/passes/segmented-reduce.ts`). It is
a 16-ary gather tree over slot order, with pairwise adds and no blending, plus a canonical-cover range
query per segment. It writes the segment table's `stats` (Σx, Σy, Σ|v|, count) and `box`. It costs
0.46 ms at 325k (0.7 ms at 1M), and it is also more accurate: at 1M an offset layout's centroid is
off by 5.5e-4 world units, where a serial float32 chain is off by ~130.

- The guard is the draw spy in `gpu-frame-budget-perf.browser.test.ts`: any draw of ≥ N vertices
  (instances counted, any mode, any of `drawArrays` / `drawArraysInstanced` / `drawElements` /
  `drawElementsInstanced` / `drawRangeElements`) into a 1×1 viewport fails it. The SwiftShader
  wall-clock ceiling cannot see this regression, because it only doubles a 30k tick there.
- **Writing a sub-rectangle of a packed texture** (the tree levels share two textures, and so do the grid
  pyramid's levels 1…L, in Podd / Peven, #354): open the pass
  with `beginPass(device, { framebuffer, clear: false, viewport })` from `network/gpu/passes/fullscreen.ts`.
  luma's default clear wipes the **whole** attachment, because `gl.clear` ignores the viewport (only a
  scissor limits it). `beginPass` takes the clear as a required argument, so no call site can get the
  default by omission.

## GPU layout shaders: `discard` does not end the invocation (#350)

The GPU force layout computes in raster: one fragment per node over a square atlas, so the last row
holds **padded texels** past the last node, and every per-node pass starts with
`if (id >= u_count) { discard; }`. Do not rely on that `discard` to skip the rest of the shader. On
ANGLE's Metal backend the invocation kept running: the hub branch of the spring gather computed a row
length as `end - start` from the offsets texture, the padding (0) made it wrap to ~2^32, and the
discarded texel ran a 16M-iteration loop — 280 ms per draw instead of 0.7 ms, with correct output (the
result is discarded), so only timing showed it. **In a pass whose loops or fetches depend on texture
data, end padded texels with a neutral write and `return`** (`o_force = vec2(0.0); return;` is a no-op
under the additive force blend) — `return` does end the invocation, and it also keeps padded texels
from fetching past an atlas (`offsets[id + 1]` on the last padded texel is out of range, which GLSL ES
leaves undefined). The spring gather does this. Independently, **keep every loop bound finite**: compare
as `end > start + C`, never `end - start > C` on `uint`s. The per-tick ratio guard in
`gpu-frame-budget-perf.browser.test.ts` (hub tick ≤ 2× its hub-free twin) is what catches this class
(`discard` plus the wrap: 1,161 ms against 51 ms); the absolute ceiling has 10× headroom and did not.

## GPU layout: the #251 cell centre must round alike in the scatter and the traversal (#354)

The grid pyramid's near-field softening (#251) stores each finest cell's second moment about the cell
centre, `w = Σ|p − cc|²`, and the traversal turns it into the occupants' variance `σ² = w/m − |com − cc|²`.
That is a cancellation of two numbers up to ~600 world units² into a σ² that can be ~0.1, so it only works
if the **scatter vertex shader and the traversal fragment shader round `cc = lo + (cell + 0.5) / G ·
boxSide` bit for bit alike**. GLSL ES 3.00 has no `precise`, and ANGLE Metal compiles with fast math, so
"the same expression" is not enough: when the tile atlas moved the scatter's clip position to a different
expression (`(origin + cell + 0.5) / atlas`), the compiler stopped sharing the quotient `(cell + 0.5) / G`
and rounded `cc` differently. Level 0's `w` channel changed in 91% of occupied cells, and on web-NotreDame
the multi-occupant nodes' forces moved to p99(r) 1.1e-3 (326 nodes above 1e-2 at tick 20) against the
previous build — while every SwiftShader test stayed green, because SwiftShader does not contract.

- Keep the scatter computing `q = (cell + 0.5) / G` **once** and deriving both the clip position and the
  cell centre from it (`passes/grid-pyramid.ts`), and keep both shaders reading the tile side as an opaque
  integer (`float(side)` from `segInfo.w >> 16`, never `float(1 << rootLevel)`).
- A change to either shader's box / cell arithmetic needs a **real-GPU** A/B of the level-0 texels (all four
  channels bitwise) and of per-node forces from identical positions against the previous build. The #354
  change is bitwise equal on web-NotreDame and on a 1M-node graph at every checked tick; the SwiftShader
  tests (`flat-equivalence`, `segment-isolation`) cannot see this class of drift.
- The traversal also re-bins each slot with the scatter's own expressions, `floor((p − lo) / boxSide · G)`, to
  take the slot's own terms back out of every cell it sits in (#403) — so the cell index must round alike in
  both shaders too: a slot the traversal places one cell over is subtracted from a cell it is not in. Checked
  on an M1 Max against the reference on web-NotreDame's positions: no node off by more than r = 0.1 (flat
  max 2.3e-2; seed levels max 7.9e-2, float32 cancellation next to heavy supernodes).
- Speed has the same blind spot. ANGLE Metal compiles a loop about 2% slower when its bound comes from a
  texture fetch or through a function parameter instead of a uniform read in the loop condition (the flat
  exact loop: 3.26 → 3.33 ms per draw at N = 4096). Time a changed per-node loop on real hardware against
  the previous build; `repulsion-fs.test.ts` pins the flat exact loop's shape.

## GPU layout streaming: raw `STREAM_READ` PBOs, one write per fence, repaints cost GPU too (#352)

The streaming GPU layout never reads synchronously on the frame path. It copies positions into a PBO,
fences the frame, and harvests with `getBufferSubData` once that fence has signalled (`network/gpu/`
`async-readback.ts`, `gpu-stream.ts`, `frame-budget.ts`). Five things bit while building it:

- **luma `Buffer`s cannot be `STREAM_READ`** (9.3.3's `WEBGLBuffer` emits only `STATIC_DRAW` /
  `DYNAMIC_DRAW`). Without a `*_READ` usage Chrome's `getBufferSubData` cannot use its readback shadow
  copy and falls back to a synchronous round trip. Create readback PBOs raw on the `WebGLDevice`'s
  context, as `PickReadback` does.
- **Write each READ buffer once per fence.** Chrome keeps the shadow copy only for a buffer written once
  and then fenced. A second `readPixels` into the same PBO before the harvest logs "written again before
  being read back" and discards the copy. The harvest then logs "read back without waiting on a fence"
  and stalls the GPU pipeline. That stall does not show in main-thread time: on web-NotreDame, 300 ticks
  took 63 s instead of 11 s. Pack everything a PBO carries into one texture first (the stats ride in their
  own 32-byte PBO through a 2×1 staging texture). Chrome also counts the sizing `bufferData` as a
  write, so size the storage in the first copy, before the fence, not a frame earlier.
- **Read each READ buffer once per fence, too.** The shadow copy serves one `getBufferSubData`; a second
  read of the same copy (another range of the same buffer) logs "read back without waiting on a fence"
  and stalls, although the fence *was* seen signalled first — so a fenced-harvest assertion cannot see
  it. The nested layout read its module discs from the position PBO as a second range: every streamed
  harvest stalled (and the next copy logged "written again"), and the one-frame warm solve stalled once.
  A packed source's extra floats now have their own PBO. The guards assert each PBO's accesses in order
  (`(wr)*`, `gpu-nested-perf.browser.test.ts`), which catches both rules; a headless-Chromium probe with
  one PBO, one fenced write and two reads reproduces the warning in isolation.
- **A heavy engine repaint is GPU work the layout's fences see.** Its draws queue ahead of the layout
  items of its own frame and of every later frame. So a late fence right behind a repaint says nothing
  about the layout's band size: the late frame carried the repaint, or one did that completed within the
  frames in flight before it. The fence controller only blocks on such a miss and never resizes `k` or B.
  Before that rule, every 325k render doubled B until 50 items per tick left 4.6 ticks/s. Only the late
  frame (the oldest in flight) and what ran before it count. A repaint queued after it cannot have
  delayed its fence, because the GPU runs work in order, so it excuses nothing. Where the browser holds the next animation frame until the
  canvas is drawn (SwiftShader: seconds per 100k-node render), the rAF gap after a repaint frame is
  the render's cost, and the repaint throttle spaces repaints by twice that. But a gap is not always a
  render cost: a hidden tab pauses rAF, and a long task delays it. Taken at face value, one such gap once
  held the layout's repaints back for as long again. So `RepaintThrottle` does not sample across a
  `visibilitychange` or an idle resume, and it uses the smaller of the last two stall samples: a real GPU
  cost repeats after every repaint, and a one-off gap does not.
- **The stats a copy carries must describe the positions it copies.** The harvest refuses a non-finite
  layout by checking the reductions' stats before it touches `graph.positions`. Those stats come from the
  last prep (item P), so they describe the positions *before* that tick's integrate. The first version
  copied right after an integrate and let a NaN born there reach the screen and the settle handler.
  Positions change only at the integrate and at the prep, where a drag's held positions are written,
  never mid-tick. So a copy after a prep reuses its stats, and a copy between ticks re-runs the
  reductions first (`refreshSegmentStats`). Mid-tick, re-running them would change the box and centroid
  that the remaining force bands read.
- **A GPU layout lands its nodes differently on each platform, so a guard must not assume where a given
  node lands.** SwiftShader compiles shaders with LLVM on arm64 Macs and with Subzero on the x86-64 CI
  runners (`UNMASKED_RENDERER_WEBGL` names the JIT). The same seed and tick count give different float
  results, and the layout diverges. T7's drag once grabbed node N/2 because it was a drawn leaf at k=4 on
  a Mac. On CI the LOD declutter hid it, with no glyph over its centre, and the pointer-down grabbed
  nothing. About 3% of leaves are hidden like that at 100k. Find the node to grab through `pick`, the
  same way the pointer-down does (`centreOnDrawnLeaf`). To reproduce a CI-only layout on an Apple-silicon
  Mac, run the file under Rosetta. Install the x64 headless shell with
  `PLAYWRIGHT_BROWSERS_PATH=<dir> PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=mac15 playwright install
  chromium-headless-shell`, then point a local config's `playwright({ launchOptions: { executablePath } })`
  at it.
- **Under LOD the lanes keep changing while a layout streams, so a "no GPU object per frame" guard must
  say which changes it allows.** Three things created GPU objects in T7's LOD leg after its first repaint,
  and none of them was the transport. (1) The frontier grows as the layout spreads (163 → 431 circles and
  353 → 1472 links at 100k). The lanes grew exact-fit and reallocated all 8 buffers on each repaint that
  set a new high. They now at least double (`grownCapacity`, webgl/instanced.ts), so reallocations are
  bounded by log2(peak / first). T7 counts a creation inside a lane's `update` as a grow and requires it to
  double. (2) The main thread builds the LOD tree on a GPU frame, and the cut draws nothing until the tree
  has geometry. So the lanes register with the tree, many frames after the stream's first repaint (frame
  140 of ~550 under Rosetta). T7 starts counting at the first repaint with `lodSource !== "none"`. (3) The LOD
  stream leg inherited the LOD-off drag's k = 4 zoom. There, links entered the view mid-run, and a change of
  the lane's layer set re-registers every layer (`emitInstancedLane` keeps the z-order that way). Each T7
  half now runs its stream leg first, on its own engine; a stream leg after a drag sets its view.

## GPU layout with LOD on: the tree comes from a worker, and browser tests cannot mock what a worker imports (#377)

With LOD on, the GPU layout keeps the LOD tree off the main thread as the worker backend does: a layout
worker only coarsens the graph (`{ type: "coarsen" }`, `network/lod-refit.ts`) and then refits the tree's
geometry to each frame the GPU reads back (`{ type: "lod-geometry" }`). The stream harvests into the
relay's buffer instead of `graph.positions` and paints the frame, positions and geometry together, once
the worker replies (`network/gpu/lod-relay.ts`, the stream's `FrameSink`). With `lod({ source: "spatial" })`
(#343) the same worker rebuilds the spatial tree for every relayed frame instead, with the worker backend's own
per-frame step (`lodFrameStep` via `answerLODGeometry`, `network/lod-refit.ts`). Six things to know:

- **Transfer the topology, never clone it.** With super-edges the coarsening tree's topology is 213 MB at
  325k nodes and 773 MB at 1M (synthetic, 4.6 edges per node). The coarsen reply transfers every buffer, and
  the worker keeps its own copies of the few arrays a refit reads. A refit hands both buffers back and forth,
  so a streamed frame allocates and clones nothing.
- **A frame the worker has not returned is not on the graph.** Positions reach `graph.positions` only at
  the commit right before the repaint, with their geometry, so labels, picking and the cut never see
  positions without their aggregates. The repaint throttle harvests one round trip early to keep its cadence.
- **A relayed final frame keeps the run `finishing` for a round trip.** The run ends only when its final
  frame is painted, one worker round trip after the harvest, so any rule keyed on `finishing` alone fires
  again in the frames between. The first version re-issued the final copy there: every settle and every
  drag re-cool paid a second copy, refit and full repaint after `settled` (seconds at 1M in a fit view).
  `copyDue` checks for new ticks first (`gpu-lod-relay.browser.test.ts` counts copies and repaints).
- **`vi.mock` of a module a real Web Worker imports kills the worker** in a browser test: vitest serves the
  worker the mock proxy, which throws there (`getFactoryModule` of undefined), and the relay falls back to
  the main thread. So the main-thread call counts live in their own file with an in-process worker
  (`gpu/__tests__/_in-process-lod-worker.ts`, the worker's real code on a timer), and every test that needs
  the real worker (T7's worker baseline, `gpu-lod-relay.browser.test.ts`) stays mock-free.
- **The spatial relay's back-pressure is on the main thread.** The worker backend's stream pauses its rebuilds
  while `MAX_OUTSTANDING` spatial trees are unreturned and builds the latest positions when one comes back.
  The relay's worker cannot: it keeps no positions (each frame's come and go with the request), so a skipped
  frame could never be built later — the settled layout would keep a tree of older positions. So the relay
  takes no harvest (`target()` is null) while that many trees are unreleased, and wakes the stream when one is
  released; the worker then never skips (`lod-relay.test.ts` pins both). A frame id the worker already built
  still brings no tree (the convergence stop); the relay has no adoption refit (the first tree comes with the
  first harvest), so `settled` is never held for it.
- **A drag from idle inherits the last run's stall samples.** The repaint throttle keeps its stall samples
  while the layout idles, so on software GL, where a fit-view LOD frame at 100k nodes stalls the GPU for
  seconds, a drag's first reflow repaint can land 4-9 s after the drag starts (SwiftShader; on a GPU the
  stall term is about 0). A test that expects a repaint within a fixed number of drag frames flakes:
  T7's drag legs hold the node still until one lands (at most 20 s).

## GPU layout multilevel seed: one solver, levels as budgeted work items, nothing read back (#353)

`layout({ backend: "gpu" })` seeds multilevel like the CPU backends (`multilevel: false` gives the disc). A
layout worker builds the plan — the CPU `multilevelSeed`'s levels, masses, aggregated weights and schedule,
from the same coarsening as the LOD tree (`gpu/seed-plan.ts`, `answerCoarsen` in `lod-refit.ts`) — and the
stream runs it on the one solver (`GpuForceLayout.beginSeed` / `setLevel` / `endSeed`) as work items under
the frame budget. Four things to know:

- **Programs at construction, one allocation at `beginSeed`, never in a frame.** A solver built with
  `multilevel` compiles every seed program (the seed springs' row gather and chunk pass, the prolongation, the
  leaf seed: `SeedPasses`) in its constructor, so a failed compile fails the construction, where the transport
  falls back to the worker. The first version built them in the frame that started the seed: 120-128 ms of
  compile in one rAF on an M1 Max, and a throw there killed the loop with `settled` never resolving.
  `beginSeed` runs when the plan arrives (`GpuStream.seed`, outside the frame loop, in a try/catch that starts
  the run cold from the disc) and creates only the seed-only textures (masses, stabilizers, parent slots, the
  seed's own springs, a module tree's node-order leaf seed), sized to the plan's largest level and freed at
  `endSeed`; a level is sub-uploaded into them (`writeTexels`: full rows from a view, one scratch row) and
  prolongated with **zero velocities by MRT**, and its offsets ride in the force texture, free between levels.
  A new per-level resource breaks `gpu-multilevel-seed.browser.test.ts`'s zero-creation spy; a program built
  during a seed breaks its compile spy and T7's `beginSeed` ceiling.
- **Mass-weighted levels reuse the flat programs through a uniform branch** (`u_massive`), compiled only into
  a solver built with `multilevel`; one without it compiles exactly the flat programs, and the graph's level
  of a multilevel solver multiplies by m = 1, which changes no bit (pinned bitwise in
  `gpu-frame-budget-perf.browser.test.ts`). The seed's springs are their own
  (weighted, mass-divided) program over their own CSR textures, so the graph's springs are never rewritten.
  On the tile atlas (#354) a level is the flat segment's row pointed at the level's slots and at its own
  path: a tile of side `chooseGrid(count)` in the atlas corner above `exactMax` (the pyramid builds and
  reduces only that corner), else the exact loop — `SegmentTable.setRange` rewrites the whole `info` texel,
  never just the range, or the tile flag and side are lost. A multilevel solver compiles both repulsion paths.
- **A seed tick's main thread is its render passes' fixed cost, however small its level** (luma's pass setup
  and a draw, ~16 µs a pass on an M1 Max, plus a submit per work item since #402: see the next section).
  Under the 2 ms encode cap the seed is therefore main-thread-bound (web-NotreDame's 329 seed ticks: ~100
  frames at 120 Hz before #402), and a level whose whole tick fits half the budget is one item, so the item
  cap `k` does not bind as well. Fewer passes per tick would shorten the seed (#438); more seed ticks per
  level lengthen it frame for frame.
- **The seed frame is copied in the frame that places the nodes**, before any tick of the run (the encode
  loop stops after `endSeed`), and nothing is copied before it: the slots hold coarse levels until then. A
  frame sample's `harvestedTicks` is taken at the harvest, before that frame's own copy moves `copyTicks`.

## GPU layout: one submit per work item, and no pass only clears (#402)

luma's `WebGLDevice` runs a render pass's draws as they are encoded. `device.submit()` only executes the copy
commands queued on its default command encoder (the layout queues none), then allocates a new command
encoder, a command buffer and a promise. So a submit between two passes buys nothing, and a small pass is
nearly all fixed cost. Measured on an M1 Max (headless Chromium, ANGLE Metal): 6.5-8.5 µs of main thread per
submit, ~9 µs for luma's `beginRenderPass` + `end` (a `Resource` with its stats bookkeeping, a GL state push
and pop), ~7 µs per `Model.draw`, and ~0.02-0.05 ms of GPU per pass whatever it draws. Two rules follow:

- **The passes never submit; each work item submits once, after its last pass**: `GpuForceLayout.beginTick`,
  `forceBand`, `integrate`, `setLevel` and `endSeed`, and each nested item that encodes a pass (the compact
  swap encodes none). A readback copy is one item as well: the solver's `prepareReadback` encodes, and
  `AsyncPositionReadback.issue` submits. A helper that submits again breaks the item spies
  (`_item-recorder.ts`) in `gpu-frame-budget-perf.browser.test.ts` and `gpu-nested-perf.browser.test.ts`, and
  T7's per-item count.
- **A clear is the `clear` of the first pass that draws into its target, never a pass of its own.** Each
  force band opens the force texture with a clear, limited to its rows by its scissor (luma applies the
  scissor before `gl.clear`); the nested springs pass clears its whole target after the predict has read it.
  A clear-only pass cost as much as a small draw pass.

The passes that are left are dependency chains, so they cannot be merged the same way: each reduction-tree
level reads the level below, the range query reads the tree, the latch reads the query, each coarser pyramid
level reads the one before (alternating between `Podd` and `Peven`), and each collision round reads the
previous round. Consecutive passes of a chain render into different textures, and WebGL cannot sample a
texture it renders into (a feedback loop), even another rectangle of it. Halving the tree chains needs two
levels per pass from a repacked atlas (#438).

## GPU layout stop: decided on the GPU once per tick, tagged with its schedule (#376)

The CPU layouts check `converged` after every tick. The streaming GPU layout learns its mean step only from
a readback several frames later, so a stop decided on the CPU would land a frame-timing-dependent number of
ticks late and the final layout would change from run to run. So a one-fragment **latch** pass after each
tick's reductions applies the CPU rule on the GPU (`network/gpu/stop-latch.ts`, `passes/stop-latch.ts`), and
the integrate passes everything through once it has latched. `stopArmed` (mode, spacing, settle ticks) is the
CPU half and arrives as one flag; `stepSettled` is the GPU half. Two things are easy to get wrong:

- **Evaluate once per tick boundary.** The reductions run twice between two integrates when a readback copy
  lands between ticks (it re-runs them for its stats) and the next prep runs them again. The latch runs after
  both, but only the first may evaluate the rule: a second one compares the step with itself (`step ≤ step`)
  and stops a layout whose step has just grown. The step itself is the same both times (velocities change
  only at the integrate), so evaluating once keeps the stop independent of when copies happen.
- **Tag the stop with its schedule.** The transport learns of a stop frames after the GPU latched it, and in
  between a drag may have started a new heat schedule. Every `cool` / `hold` starts a new epoch: the latch
  releases an older epoch's stop, the integrate freezes only for the current one (a drag that begins
  mid-tick integrates at once), and the stream ignores a harvested stop from another epoch. Without the
  check a stale stop ends the next re-cool at once (the stale-stop case in `gpu-stop.browser.test.ts`).

## GPU resources live on the render backend's device: release them BEFORE a swap (#311)

Anything built on `WebGLBackend.gpuDevice` (the GPU layout, later GPU-resident positions #184) belongs to
the backend that owns the device. `onBackendSwapped()` fires **after** `old.backend.destroy()`, so it is the
wrong place to free them. Use `onBeforeBackendSwap()` (`map/base-engine.ts`): it fires in `installBackend`
while the outgoing backend and its device are still alive, only for a real swap (not the first install, not a
superseded one). The network moves a GPU layout there (`WorkerLayoutHandle.moveDevice`, `gpu-transport.ts`):
it frees its textures and fences, then continues warm on the next backend's device promise
(`whenBackendSettled().then(gpuDevice)`, which also waits out an `"auto"` upgrade). Five things learned:

- **luma's `WebGLDevice.destroy()` only detaches the device from its context** (it clears the context's device
  slot; the context lives until GC). GL calls after it still work and still free memory, so a teardown after
  a destroyed device frees normally. A **lost** context is different: make no GL call at all (check
  `gl.isContextLost()` too — the `webglcontextlost` event is queued, so a teardown can run before it arrives).
- **luma 9.3.3's `WEBGLFramebuffer.destroy()` never deletes the GL framebuffer** (`super.destroy()` sets
  `destroyed` before the check that guards `deleteFramebuffer`; still so in 9.4.2). Every framebuffer d3gl
  destroys stays behind as an empty, storage-free GL name until its context is collected; the attached
  textures are freed. A leak test that spies `deleteFramebuffer` therefore always fails: count framebuffers
  through luma's `device.statsManager.getStats("GPU Resource Counts").get("Framebuffers Active")` and track
  textures, buffers and fences at the GL level (`gpu-swap.browser.test.ts`). luma's `statsManager` is one
  global object (`lumaStats`), not per device: its counts and its "GPU Memory" cover every device on the page,
  so read them before a second device allocates, or measure a delta.
- **Keep the engine's handle.** The drag session and the settle handler hold the layout handle, so a move keeps
  the same object and swaps what runs inside it; it replays a live drag onto the new run — except after a
  non-finite layout, where the drag may be what fed it the NaN (a NaN pin wedges the CPU worker too).
- **Never keep a reference to `graph.positions` across a layout start.** A worker start in shared-memory mode
  (cross-origin-isolated page) replaces it with a view of its `SharedArrayBuffer`, and a shared-mode pin sends
  ids only. A drag session that captured the array once kept writing held positions into a buffer neither the
  worker nor the renderer read after a move, so the held node froze. Read `graph.positions` at each use.
- **A move lands on something that is still changing; decide late and hand over complete state.** The engine
  adopts a worker's LOD tree the moment it lands and draws it, so a warm worker start (no seed frame) posts the
  tree with the geometry of the positions it continues from; before, all 99k aggregates read 0 for ~1 s at 325k.
  The continuation is worked out when the next run starts, not when the move does, because a drag can end
  while the device is pending (~200 ms for an `"auto"` upgrade). And `whenBackendSettled` re-waits while the
  swap token changes: an explicit pick ends an `"auto"` upgrade while the Canvas placeholder is still live.
## GPU nested layout: dead passes hide behind complete fallbacks; fence what you time (#355)

The nested layout solves every module at once on the GPU (`network/gpu/gpu-nested-layout.ts`). Five things
cost time while building it:

- **A texture bound to any active sampler of a program while it is that draw's render target is a feedback
  loop, and WebGL drops the draw** — even when the shader's branch never reads that sampler at run time
  (it is active because some branch uses it). The nested reduction's mode 1 rendered into the segment
  table's `stats` while `u_segSum` (read only by mode 2) was bound to the same texture: every range query
  silently wrote nothing. Bind a stand-in for the unused sampler. Worse, the tests still passed: with a zero
  box every collision cell overflowed, and the grid's overflow fallback — the exact loop — gave the right
  answer, only slowly. **A complete fallback can mask a dead fast path**: test the fast path's own output
  (the composition test caught this one), not only the end result.
- **`gl.finish()` does not wait for the GPU on ANGLE Metal**, and neither does a `readPixels` from a
  framebuffer the measured passes did not write (it waits only for that resource). Timed that way, a
  336k-slot repulsion pass "took" 0.04 ms (it is 2.1 ms) and a compact tick 1 ms (it is 13 ms). To time
  GPU work, read one texel of the texture the measured work wrote last (everything queued before it
  completes first), or poll a fence across tasks.
- **Heavy-tailed radii defeat a single-scale collision grid** (fixed in #380, next section). Cells ≥ 2·r₉·PAD
  wide put dozens of small discs in a cell, and every slot near an overflowing cell took the exact loop:
  O(k²) in the largest module (one 60,000-child Zipf module: a 55 ms gather, frames stalling 157 ms). Sizing
  the gather's bands from that worst case removed the stalls but took the layout from 5.5 s to 39.5 s: the
  unsliceable P still overran its frame and the fence controller throttled the stream. The work had to be
  bounded, not sliced.
- **Row-major slots put different segments in one SIMD group, and it costs.** The slot atlas is
  `⌈√slots⌉` wide, so a 2×2 quad or a SIMD group spans rows that are hundreds of slots apart: different
  segments, with different loop lengths (exact loop, tile walk, collision fallback). Measured on the real
  GPU on the synthetic 100k-leaf map with a narrow atlas as the proxy for an 8×8-blocked mapping (a group
  then covers ≤ 32 consecutive slots): width 8 against 322 cuts an organise tick 2.2 → 1.5 ms and a compact
  tick 9.6 → 5.9 ms, with bitwise-equal output. At 325k the narrowest atlas that fits (width 24) gains only
  13-20%, and 1M cannot be tested this way. Measure a mapping change as a real blocked mapping (a define in
  the per-slot shaders, blocked uploads), not a narrower atlas: width 64 was *slower* than 322 at 100k.
  `gpu-nested-bench.browser.test.ts` (`PERF_BROWSER_N=<leaves>`, hardware-GL Chromium) times the solve.
- **A Jacobi update overshoots where the CPU's sequential one cannot, and the non-finite stop sees only
  an overflow.** The CPU applies a module's springs one link at a time, each a partial projection; the GPU
  applies all of a slot's at once. A hub whose disc is no larger than its neighbours' takes half or more
  of each link's correction, so its summed link share D grows with its degree, far past the ≈ 1.78 the
  momentum leaves stable. Directed flow makes such hubs: a directory page has many out-links but little
  in-flow, so its disc stays small (under undirected flow a hub's disc grows with its degree, so its share
  of each link shrinks as its links multiply). web-NotreDame's directed Infomap tree has 3,768 slots past
  the bound, up to D = 135 at 612 links: its solve overflowed float32 within 6 ticks and `"auto"` fell
  back to the worker. A hub moderately past the bound grows, then damps as alpha decays: the solve stays finite
  and silently loses the arrangement, so test link tightness and per-tick boundedness, not finiteness
  alone. The fix is a static per-slot relaxation `ω = min(1, NESTED_SPRING_GAIN_MAX / (α₀ · D))`, folded
  into the slot's CSR row once (`nestedSpringScale`, which derives the bound). A row cap at 1 was not
  enough: two linked capped hubs moving against each other have twice a slot's gain. For any new Jacobi
  term, bound its per-slot gain from the coupled operator (Gershgorin), not from the slot alone. Relaxed,
  the directed tree lays out in 1.6-1.9 s streamed on an M1 Max with the radius-class grid (every frame
  ≤ 10 ms at 120 Hz but the one that constructs the solve), linked siblings at 0.77 of the average pair's
  distance against the CPU layout's 0.97.

## GPU nested collision: bound the work, then the serial chain, then cost it by the work (#380)

The nested layout's collision (`network/gpu/passes/collision.ts`, plan in `network/gpu/collision-plan.ts`)
bins each disc at the scale of its own radius class: classes of halving radius, class cells of the class's
contact distance over 2^ρ (ρ = 1), nested by integer shifts of one finest-cell coordinate, hashed per
segment. A slot visits, per class, the cells its disc padded by the class's largest radius overlaps. What it
took to make that fast on the real GPU (M1 Max, ANGLE Metal), in the order it was found:

- **Real nested layouts end deeply overlapped — on the CPU too.** Two thirds of a 20,000-child Zipf module's
  discs have a sibling within half the padded distance at the end (CPU 67%, GPU 73%). So a class cell as
  wide as its discs' contact distance still holds dozens of them (up to 58 at 60,000 children), and a fixed
  K overflows whatever the cell size. Cells denser than K are **refined**: their occupants are binned again
  by 4×4 sub-cell into a second, smaller table (the scatter's vertex shader culls every other slot), and a
  visitor descends into them. Only a sub-cell with more than 12 — discs piled within an eighth of their
  contact distance — falls back to an exact loop, restricted to the work item's own cells. Size the
  sub-table with room: at 0.25 buckets per binned slot hash collisions made a 9-occupant sub-bucket (an
  overflow); at 0.5 the fullest held 8 over every compact tick of the real maps.
- **A GPU gather takes as long as its slowest fragment's serial chain, not its total work.** A large disc
  among small ones has thousands of cells to visit, or its whole segment to loop: one fragment doing it
  held the pass for 10-30 ms (a hash, then dependent random fetches, with nothing left to hide the latency
  once the rest of the pass was done), and 60,000-child loops lost the GL context to the GPU watchdog.
  Short-circuiting those loops halved the gather, which is how it was found. Every grid slot's search and
  every exact loop above 256 pair tests is **cut into work items** (32 class-cell visits or 256 pair
  tests), gathered in parallel into partial sums; each slot's own fragment sums them, or runs its exact
  loop when that is a single item. Weigh a cell visit in the exact-or-grid choice by its measured cost
  (~16 coherent pair tests): at 1:1, slots just under the threshold did k random lookups.
- **Cost the gather by its work, and cut its bands by it.** The frame budget costed the compact gather per
  leaf: 0.06× of the truth on a 20,000-child Zipf module (the fence gate blocked ~200 frames), 1.1× on 1M.
  The plan now estimates each slot's work (pair tests, and cell visits at 16), which fits the measured
  gather within ±8% on every map as 4 ms + 47 ps per unit; bands are cut at equal shares of it (rows would
  put the big module's work in the first band). The estimates handed to the budget are **half** the
  measured times, the factor the per-leaf model had on web-NotreDame's trees, which the two-frames-in-flight
  gate absorbs: those trees then pace as before (~1.9 s cold), every map streams without a blocked frame,
  and at a factor of 1 they took ~2.85 s. That factor is a pacing policy, not a measurement.
- **Measure new against old in one session, and subtract the fence wait.** Machine load moved timings by
  ±15% between runs; the fence-poll wait (`fenceSync` + `clientWaitSync` across tasks) adds ~0.7 ms per
  measurement, so N separately fenced bands look N × 0.7 ms slower than one. The CPU twin of the search
  (`gpu/__tests__/collision-twin.ts`) predicts the GPU's visits and fallbacks exactly — use it (and the
  layout's `collisionStats`) to test the fast path's own output, not only the result.

## Host sizing: backend canvases are OUT OF FLOW (#39, re-confirmed in #273)

`makeCanvas` (`map/backend-factory.ts`) gives every backend `<canvas>` `position:absolute; top:0;
left:0`, and the engine constructor promotes a `static` host to `position:relative`. **A backend
canvas therefore contributes nothing to layout, on any backend, at any point in the lifecycle.**
Consequences worth remembering before "fixing" a layout complaint:

- **A late-arriving WebGL canvas cannot flush page content down.** That was the pre-#39 symptom and
  it is gone. Measured across `webgl` / `canvas` / `auto` × all three `resolveSizing` modes: the
  offsetTop of a sibling after the host is identical before construction, synchronously after it,
  after `whenReady()` and after the `"auto"` upgrade settles. Guards:
  `map/auto-layout-shift.browser.test.ts` (incl. a pure-DOM control showing an in-flow canvas *would*
  shift by its full height, ×2 while two coexist) and `react/host-layout-shift.browser.test.tsx`.
- **The host box comes from CSS, never from the canvas.** The React wrappers always emit one
  (`react/host-style.ts`), and `aspectRatio` mode has `resolveSizing` write `width:100%` +
  `aspect-ratio` on the host — synchronously, inside the constructor, so any reflow it causes is
  paid before the first paint and is backend-independent.
- **A bare host in fixed (`width`+`height`) mode gets NO CSS from the engine**, so an unstyled
  `<div>` collapses to zero height and the map overlaps whatever follows it. Stable, not a shift —
  but it is why examples and docs always size the host.

## What the Scene hands out is SHARED, not a snapshot (#207, #208, #280)

Every array `Scene` returns is owned by the Scene and reused across calls — `styleTables()` and
`buffers()` give live subarray views of the typed storage (#207), `flagsView()` one persistent
`Uint8Array` (#208), and since #280 `drawables()` gives a **retained `DrawableVector[]`** and
`buffers().pointCenters` a retained `Float32Array`. The engine calls all of these once per layer on
every `pushLayers()`, so anything rebuilt per call is an O(total drawables) cost paid before a
backend sees it. Consequences to keep in mind:

- **Never grow or reorder an array the Scene handed you.** `CanvasBackend.appendToLayer` pushes the
  append TAIL into the array it already holds — which is the Scene's. That only works because
  `Scene.appendToGroup` **drops** its reference rather than growing it, handing ownership over; the
  next full `drawables()` builds a fresh one. Growing it on both sides double-counts the tail.
- **`DrawableVector` stores style as plain data**, so retaining it means re-applying later
  `setFill`/`setStroke`/`setFlag`/`writeDeclutterFlags` writes. Those bump a per-group `styleEpoch`
  (O(1) — `writeDeclutterFlags` bumps **once** for the whole pass, deliberately: patching the
  vectors inside that loop would put an O(drawables) object-write on every zoom frame, exactly what
  the #208 flags-only path exists to avoid), and `drawables()` resyncs in place, reusing the objects
  AND their colour tuples, when the epoch has moved.
- The one sanctioned mutation from outside is a backend's flags-only fast path writing `flags` from
  the Scene's own live flags table (`Canvas`/`Svg` `updateLayerFlags`, `WebGLBackend.toSVG`) — it
  writes the value the Scene already holds, so it can only bring the view into sync.
- Adding a per-call rebuild back into any of these is a push-path regression, guarded by
  `core/__tests__/vector-view-perf.test.ts` (1M, ×20 pushes) and
  `map/push-layers-perf.browser.test.ts` (the real `pushLayers`, on Canvas and WebGL).

## Continuous input draws once per animation frame (#367)

A wheel burst, a pan's mouse moves and a node drag's pointer moves can deliver several events inside one
frame, and a network frame at scale (LOD cut + declutter + super-edge gather + render) costs tens to
hundreds of ms. So **no continuous-input handler draws**: `BaseEngine`'s d3-zoom handler records the latest
transform, a subclass records what moved and calls `requestRedraw()`, and ONE engine frame
(`runFrame`) draws the latest transform and the subclass's `drawFrame()` together — one lane emit, one
render, however many events and sources (a streamed layout frame included) were pending. Rules that keep it
correct:

- **The drawn state is what `pick` answers against.** `this.transform` and each lane's `visible` set move
  only when a frame draws, so a pick between an event and its frame hits what is on screen.
- **A programmatic view change draws at once** and drops a pending gesture transform (the latest wins). The
  drop lives in `syncZoomToView()`: once d3-zoom is re-seeded to the current view, a transform it reported
  earlier is stale, so a subclass that sets the view directly (the network's streaming fit) drops it too.
- **A gesture frame that draws with a redraw skips `setTransform`** (the subclass's `drawFrame()` renders), so
  put what every view change must do to subclass state in an `adoptTransform()` override, not a
  `setTransform` one (the network releases a streaming fit there), and have `drawFrame()` re-emit every
  dynamic lane it owns and re-place its labels.
- **Map the pointer through `latestTransform()`**, not `this.transform`, where input places something in world
  space (a drag move between a wheel tick and that tick's frame); `pick` and a grab's hit use the drawn view.
- **Draw, don't defer, where you already are in a frame or must settle**: a d3-zoom transition tick (its
  source is the `dblclick`), a subclass's own rAF loop (a position transition, a force-drag tick) and a
  gesture's `end` call `flushFrame()`, which draws what is pending right now instead of a frame late.
- **Withdraw a request whose state is gone** (`withdrawRedraw()`, e.g. a halted layout's streamed frame).
- Guards: `map/zoom-coalesce.browser.test.ts` (base engine), `network/__tests__/network-input-coalesce.browser.test.ts`
  (WebGL/Canvas/SVG) and the ≈1M per-frame guard `network-input-coalesce-perf.browser.test.ts`.

## Pass-through layers share ONE accumulation surface (#110)

Every pass-through (`passThrough: true`) layer draws into a **single** shared surface — the WebGL
backend's one `PassThroughGL` framebuffer, the Canvas backend's main canvas. There is no
framebuffer per layer, deliberately: an offscreen RGBA8 surface costs width×height×4 bytes (a
1920×1080 layer ≈ 8.3 MB) and nothing in the product registers more than one pass-through layer.
The consequences are contract, not incidental:

- **The clear is CYCLE-scoped, not layer-scoped.** `BaseEngine.repaintPassThrough()` takes no layer
  name: it walks *every* pass-through layer in declaration order, and only the first
  `drawPassThrough` of that pass uses `"replace-first"` (which clears — WebGL: the PT framebuffer;
  Canvas: the whole canvas, then redraws the retained base). Everything after it uses
  `"replace-rest"`. Re-introducing a per-layer `"replace-first"` makes the second layer's repaint
  silently erase the first — no error, no warning, wrong output. That was the #110 bug, and it hit
  **both** backends, so don't reach for a backend-local fix.
- **A pass-through layer cannot be repainted alone.** The surface has no per-layer channel to
  erase, so any single-layer invalidation (`recolor()`, re-declaring the layer, `setSize`, a settle
  transform, a backend swap) repaints the whole set: O(sum of all pass-through layers' items).
  Appends are exempt — they never clear, so `handle.append()` stays O(new).
- **Per-layer state lives in a name-keyed map on each backend** (`ptLayers`), never in a single
  field. `sizeMode` used to be one `ptScreen` boolean on `WebGLBackend`, overwritten by whichever
  layer registered last.
- Guards: the `multiple pass-through layers (#110)` suite in `map/passthrough.browser.test.ts`
  (both backends, real pixels) and `map/passthrough-multi-perf.browser.test.ts`, which pins the
  memory decision as a number — registering layers 2..4 must allocate **zero** extra framebuffers
  and textures — plus "a gesture frame re-projects nothing" and "a settle is O(total), not
  O(layers × items)".

Still unimplemented for pass-through, and unrelated to the above: `clipTo` (accepted and ignored
on both backends), and `PassThroughGL` is not resized by `WebGLBackend.resize()`.

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
`GroupBuilder.point(id, x, y, radius, lineWidth)`. The module-boundary rings (`traceBoundaryRings`, #329)
use the same `point` encoding in a **world** layer, for a reason worth keeping: first traced as an
`arc` path, the Scene flattened each ring to ~16 segments while WebGL exported an exact `<circle>`, and
the export pixel diff measured 1% (world) to 13% (a 2px screen ring). A `point` stays a true circle on
every path (0 in the harness).

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
  screen-mode *bake* is the risky branch — the arrow setback and half-arrow taper/tip are
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
