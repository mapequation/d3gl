# Performance: the per-frame rule and perf guards

Read this when a change adds, moves or grows work on a per-frame path, when a PR needs its
`## Performance` section, or when you write or change a perf guard. It is the working form of the
**Efficient rendering** value in `CLAUDE.md`.

Which guard covers which path is the coverage map in `LOG.md` (`## Perf-guard coverage map`): check it
before claiming a path is covered, and add a row when you add a guard. The lessons from building the
guards (GL spies, SwiftShader stalls, one engine per file, guards that must not be scaled) are in the
paragraphs under that table.

## Per-frame paths

A **per-frame path** is anything reachable from `setTransform` / `render` / a selection `emit` / a draw
loop, **and any continuous pointer interaction: hover-move, node-drag, marquee-drag.** These fire on
every pointer event while the pointer moves, so a hover-drag across glyphs is effectively per-frame. It
is **not** "just a click" and gets no exemption. (Exactly this was the loophole once: a hover restyle was
classed as click-frequency and re-emitted the whole graph per hovered node, a severe drag lag.)

**Never assume that LOD, declutter, culling or any other reduction keeps the scale small.** They are
optional helpers the user can turn off, and even with LOD on the visible set can itself be ≈1M: ≈1M
LOD-aggregated glyphs must render as efficiently as ≈1M non-reduced glyphs. The path must stay efficient
with reductions **off** (the full-detail draw, for any engine: GeoMap layers, Plot layers, or the whole
network graph) and with them **on over a large visible set**.

## The PR's `## Performance` section

Before asking for human verification, add a `## Performance` section to the PR body with two
subsections, **Per-frame cost** and **Memory footprint**. Under each, list *every* change that could
move fps / run-time (resp. memory) by more than a negligible amount. **Include it even when you are
uncertain**, and an added loop on a per-frame path *always* requires an entry. For each:

- give the computational complexity **before → after**, and
- **quantify every `N` / `size`**: say exactly which set it ranges over (all drawables, only the visible
  frontier, only the aggregated nodes, tree depth, …) and its rough scale. Never an unqualified
  `O(size)` or `~log N`.

Then state, from the **user's** point of view, under what conditions (if any) the change is noticeable
and by how much (run-time and memory), including any scale at which it could hit a memory limit. The
`policy` CI check blocks a PR that closes an issue without this section (`docs/agents/workflow.md`).

## The per-frame regression test

**The prose section is necessary but NOT sufficient: it documents, it does not prevent.** If the change
adds, moves or grows work on a per-frame path, you MUST also land an automated **per-frame regression
test** before requesting verification. The test must:

- drive a **realistic large input** — ≈1M drawables (points / nodes / edges / shapes, including
  half-edges) — through the **actual trigger** (a `setTransform` zoom sweep for the draw path; a **hover
  sweep across glyphs / a drag** for an interaction path) and assert a **frame budget** (a wall-clock
  ceiling generous enough to be non-flaky but tight enough to catch an order-of-magnitude drop). "Large"
  is about the set the path actually processes: not just a total count of ≈1M, but a **visible set of
  ≈1M *even with reductions on*** (don't let LOD off the hook by assuming it shrinks the frontier). Test
  **both** reduction states; a green test on one does not prove the other, and a proxy pipeline instead
  of the real trigger does not count:
  - **reductions ON (LOD / declutter)** — the common case users run, so keeping it fast is the
    *primary* goal: per-frame work must be O(visible), not O(total); **and** a ≈1M-glyph aggregated
    *visible* frontier must be as efficient as ≈1M non-reduced glyphs;
  - **reductions OFF (full detail drawn)** — must ALSO hold: it's where an O(N)-per-frame or
    per-interaction cost hides; **and**
- assert the regression's **deterministic signature** directly where one exists: per-frame work the
  baseline did **once** must stay once — e.g. spy that style/colour resolution (or any accessor) runs
  **O(data) at registration, not O(visible) per frame**; that GPU buffers are **updated in place, not
  destroyed + recreated** each frame; and that an interaction restyle (hover/select) issues **no geometry
  re-emit/upload** (only a uniform / small in-place buffer write).

**Baseline comparison is mandatory when you replace a render path.** Moving a layer from one path to
another (retained-Scene → instanced lane, etc.) means the new path's per-frame cost is measured **against
the path it replaces**. A path that re-derives / re-allocates / re-parses / re-uploads per frame what the
old path **retained** is a **regression**, even if it wins on a different axis (draw count, scale). Both
axes must hold; "better at X" never excuses "worse at per-frame Y".

**Never self-defer a per-frame cost.** A per-frame allocation / upload / re-derivation you are
"uncertain" about, or that you label a "follow-up" or "not a regression", is treated as a **blocking
regression** until a test proves it bounded. Resolve it, or land the test that bounds it, *before* merge.
Do not ship it on a promise to optimise later. (This rule exists because exactly this slipped through
once: a per-frame buffer rebuild was documented as a deferred follow-up and shipped a 30× zoom
regression.)

## Test tiers

Wall-clock budgets mean nothing under machine load: before calling a timing failure a regression,
re-run the file alone and check the load (`uptime`).

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
  name new browser perf guards accordingly. **CI runs it sharded by kind** (#460): the `SHARDS`
  table in that script (`nested`, `gpu-layout`, `transitions`, `engines`) gives each guard to the
  first shard whose pattern matches its path, one job runs each shard with its own 30-minute
  timeout, and the aggregate `perf-browser` check passes only when every shard does. A shard marked
  `solo` runs after the parallel ones, alone (none is today: `transitions` was, while its guards drew
  their hand-stepped frames, and `network-transition-perf` took 300+ s beside the other shards; they
  count their renders since #464 and #488, about 10 s for the shard). The
  `perf-browser / plan` job fails when a guard matches no shard (a new directory) or a shard matches
  no guard, so check `node scripts/run-browser-perf-tier.mjs --plan` when you add a guard, and put a
  long one in the shard with the most room: one job ran every guard in series and hit its
  30-minute limit in 2026-10. `--shard=<name>` runs one shard locally. Wall-clock ceilings/timeouts are
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


## Scaling a guard and writing an at-scale leg

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

