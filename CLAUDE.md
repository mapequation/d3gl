# CLAUDE.md — d3gl

d3gl draws d3-style maps, plots and networks through one engine on three backends: WebGL, Canvas and
SVG. `packages/d3gl` is the library, the product. `website/` holds the docs and the examples, its clients.

This file holds only what every task needs. Read more when the task calls for it:

- **You coordinate a task end to end** (issue, worktree, PR, merge, release): read
  `docs/agents/workflow.md` first. A subagent working on a bounded slice can skip it.
- **The change adds, moves or grows work on a per-frame path** (anything reachable from `setTransform` /
  `render` / a selection `emit` / a draw loop, or a continuous pointer interaction: hover-move,
  node-drag, marquee-drag), or you write or change a perf guard: read `docs/agents/performance.md`.
- **You touch one of the areas below**: read its section of `LOG.md` (not loaded; ~1,000 lines of
  gotchas and post-mortems; find the line with `grep -n '^## ' LOG.md` and read only that section).

| You touch | `LOG.md` section |
|---|---|
| polygons, rings, fills, hit-testing of fills (`geo/`, `core/rings.ts`, `core/hit-test.ts`) | GeoJSON winding |
| the WebGL renderer, strokes, bordered circles, `toSVG()` export | Backend compositing equivalence |
| what `Scene` returns (`drawables()`, `buffers()`, flags) | What the Scene hands out is SHARED |
| curve flattening, anchored / screen-size drawables | Curve bake tolerance is per DRAWABLE |
| pass-through layers | Pass-through layers share ONE accumulation surface |
| zoom, pan, node-drag, wheel or pointer handlers | Pan vs node-drag; Continuous input draws once per animation frame |
| host or canvas sizing, layout shift | Host sizing |
| `network/gpu/**` (the GPU layout) | every `GPU …` section |
| browser tests that mock modules or spawn workers | Test infrastructure |
| perf guards | Perf-guard coverage map |
| labels: the overlay, native text, `TextData` (`labels/`, `paintTexts`, `serializeTexts`) | Labels: the overlay and native text share one style and one box |

When you learn something that will bite again in one area, add it to that area's `LOG.md` section (or a
new one, titled by the rule and citing the issue). Put a rule here only if most tasks need it.

## Core values

- **Efficient rendering.** Never increase the computational complexity or memory footprint of the
  rendering path, or make a performance-motivated trade-off, without first weighing the options and
  asking me. Explain the trade-offs concretely: how run time and space grow with the data and with which
  data (all drawables, only the visible set, all descendants, …) under each option, and how noticeable it
  is for a user. **Never assume that LOD, declutter, culling or any other reduction is on, or that it
  keeps the scale small.** They are optional helpers the user can turn off, and even with LOD on the
  visible set can be ≈1M glyphs, which must render as efficiently as ≈1M non-reduced ones. So the
  rendering path must stay efficient at large scale with reductions **off** (the full-detail draw, for
  any engine) and with them **on over a large visible set**.
- **Unified rendering.** Before changing the rendering path, work out how to do it the same way on
  WebGL, Canvas and SVG with shared code, as long as that is as efficient as a backend-specific
  alternative. When you touch backend-specific code, check whether the other backends need the change too.
- **d3 compatibility.** Design for d3 familiarity: keep d3's low-level flexibility and offer an API that
  keeps example code simple. Accept `d3-shape` generators, `d3-geo` projections, `d3-hierarchy` layouts,
  `d3-scale` scales and the like.
- **Clean code.** Casting or reaching for `any` / `unknown` is a sign of bad design: fix the underlying
  seam (a typed pure function, a test at the right layer) instead. Avoid the non-null assertion `!` for
  the same reason, unless it is justified in a performance-critical spot and I approve it.
- **Regression-safe.** Test behaviour and visual output. Never claim a visual issue is solved without
  visual testing (browser tests or the backend-equivalence harness). A library change must break no example.
- **Up-to-date documentation.** Keep the website's prose and examples in step with the library. Every
  major feature is highlighted on the landing page and has a minimal example that shows it working.

### Enforcing efficient rendering

These rules make the first value checkable. They apply to every option you propose and every PR you open.

1. **No recommendation without its cost, in the same message.** For each option, state how run time and
   memory grow, with which data (all drawables, the drawn/visible set, a subset such as self-links), how
   often the work runs (per frame, or only on a topology, style or data change), and whether a user would
   notice it at ≈1M drawables, both with reductions off and with them on over a large visible set (LOD,
   declutter and culling can still leave ≈1M drawn). Check it against the actual call path in the code, not
   from memory; never call a cost negligible or "cheaper than the upload" without measuring it.
2. **Per frame is the default.** Positions, the transform, the LOD drawn set and the selection change every
   frame (layout streaming, zoom, node-drag), and the instanced-layer data carries positions. Treat anything
   derived from them as per-frame work until you have traced the call site and shown it runs less often.
3. **Briefs carry the checklist.** Every delegated task that touches the rendering path states rules 1–2
   and requires per-frame work and memory to stay the same or go down, reported with before/after numbers
   (which functions run per frame, bytes per drawable).
4. **Every PR gets an independent audit before it is marked ready.** A fresh agent that did not write the
   code reviews the whole diff against these core values (per-frame paths, memory, complexity growth, the
   other backends), and the per-frame perf guards the PR touches are re-run one at a time on a quiet machine
   (check `uptime`). Put the audit's findings and the guard numbers in the PR's Performance section; the
   audit report, not your summary of it, is what I review.

## Library first

d3gl is the product; the website examples and consumer code are its clients. When user-facing code can
only be made to work with boilerplate, DOM hacks or per-call ceremony, the **library** is missing
something: fix it upstream rather than polishing the workaround. If that means a larger change, raise it
as a decision instead of absorbing the complexity downstream.

**Example code shows only the d3gl API.** Each example's `draw.ts` / `*.tsx` is shown verbatim in the
docs' code tabs. Put data generation, fixtures and math in a co-located `<example>/data.ts` or in
`website/src/examples/shared/`, and import them: `ExampleCard` shows each local import as its own tab
(as the Highlight examples do with `shared/geo-data.ts` and `plot-highlight/data.ts`).

## Build and test

- Typecheck per package; the root `pnpm typecheck` is broken (no root `tsconfig.json`):
  `pnpm --filter @mapequation/d3gl exec tsc -b` and `pnpm --filter @d3gl/website exec astro check`. `tsc -b` skips the
  test files; `pnpm --filter @mapequation/d3gl typecheck:test` checks them (CI runs both).
- Import specifiers use `.js` although the sources are `.ts` (NodeNext ESM). Don't change them to `.ts`.
- Node tests: `pnpm test`. Browser tests (`*.browser.test.ts`, headless Chromium):
  `pnpm --filter @mapequation/d3gl test:browser [package-relative path]`. Both are part of TDD. CI runs
  only the node suite and the browser perf tier, so run the browser tests you touch locally.
- A wall-clock guard is named `*-perf.test.ts`, `*.bench.test.ts` or `*-perf.browser.test.ts`, which
  enrols it in a serial perf tier. Never loosen a budget to make a run pass (`docs/agents/performance.md`).

## Worktrees

All edits happen in a worktree under `.claude/worktrees/<name>`, never in the primary checkout. The
shell's working directory can silently reset to the primary repo, so:

- run git and builds by path (`git -C <worktree> …`, `pnpm --filter …`), and stage scoped paths, never a
  bare `git add -A`;
- Read / Edit / Write the worktree's absolute paths, and check `git -C <worktree> status` after edits;
- run `pnpm install` in a new worktree before its first build or test: it has its own empty `node_modules`.
