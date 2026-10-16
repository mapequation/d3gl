# Workflow: the coordinator's lifecycle

Read this when you own a task end to end: the issue, the worktree, the PR, the merge and the release. A
subagent working on a bounded slice does not need it beyond the worktree rules in `CLAUDE.md`.

## Where knowledge goes

The expensive part of a session is the reasoning: hypotheses tried, tests run to *rule things out*, the
eventual root cause. None of it survives in a merged PR, so capture it where a future session will find it.

- **Repo.** `CLAUDE.md` holds the rules every task needs, `docs/agents/*.md` the rules one kind of task
  needs, and `LOG.md` the area-specific gotchas (an architectural trap, a non-obvious constraint, a
  recurring failure mode). Durable learnings go here, not in a closed issue. A task's spec and plan go in
  `docs/superpowers/specs` and `docs/superpowers/plans`.
- **Issue.** *This problem's* understanding. The body is the current answer, a living doc (repro,
  confirmed root cause, ruled-out paths): edit it as understanding changes. The comment thread is the
  chronological work log. Post negative results explicitly ("tried X, ruled out by Y"): they are the most
  expensive thing to rediscover. At the end of a session, summarize with `gh issue comment` or edit the body.
- **PR.** Only diff-shaped reasoning (why this approach, trade-offs, review replies). It dies at merge,
  and inline comments detach on rebase. Put **`Fixes #N`** in the body to auto-close the issue and link
  issue, PR and commits (`Refs #N` / `Part of #N` for partial work).
- **New issues and sub-issues.** A *genuinely new* problem gets its own issue, linked (`Related to #N`).
  The same problem getting deeper stays on the original. Multi-phase work gets **sub-issues** under a
  parent; when one closes, tick its box in the parent's checklist too.

## Lifecycle (per task)

1. **Open the issue first**, before branching, with the template below. Create it in the repo, then add
   it to the project; don't rely on the project's "default repository" auto-create.
2. **Add it to the board** (it lands in Backlog): see the board section for the commands.
3. **Move its status**: Backlog → Ready when triaged, → In progress when you start, → In review when the
   PR is open, → Done on merge or close.
4. **Branch inside a worktree**, created in one step:
   ```sh
   git worktree add .claude/worktrees/<name> -b <branch>   # new branch, checked out IN the worktree
   ```
   Don't `git checkout <branch>` in the primary checkout: the branch lives in the worktree and the
   primary stays on `main`. Run `pnpm install` in the worktree **before** the first `tsc` / `astro check`
   / `vitest` / build: it has its own empty `node_modules`, so they fail or run against stale deps until
   you do. Drive everything by the worktree path (see Worktrees below). Open the PR with `Fixes #N`.
5. **Performance.** Add the `## Performance` section to the PR body, and a per-frame regression test if
   the change touches a per-frame path, as `docs/agents/performance.md` describes. Both come before step 6.
6. **Human verification.** Summarize what you have done (point to the Performance section for any
   per-frame or memory impact), give a runnable example to check it in, and ask for approval. **Never
   merge without it.**
7. **Changesets** (see Releases). A PR that changes `packages/d3gl/**` without a changeset, or that
   closes an issue without a `## Performance` section, is blocked (see Enforcement).
8. **Merge with squash**, then **delete the feature branch** (local and remote) once it's in `main`.
9. **Tear down the worktree.** Stop any dev server you started in it and **wait for its `astro` / `vite`
   / `esbuild` children to exit** before removing it (dev servers can ignore TERM; use `kill -9`): a
   process still rewriting its cache (e.g. `website/.astro`) makes `git worktree remove --force` fail
   with *"Directory not empty"*. A worktree that only ran one-shot builds removes cleanly. Then
   `git worktree remove <path>` and `git worktree prune`; don't be `cd`'d inside it (use `git -C`). If git
   already de-registered the worktree but a stale directory lingers, `rm -rf` it.

## Worktrees and the shell's cwd

A worktree under `.claude/worktrees/<name>/` is a SECOND checkout of the same repo. The shell's working
directory can silently reset to the **primary** repo between commands (after a `cd /…/d3gl && …`, a
`cd /tmp`, or a tool that resets cwd). A `git add -A && git commit && git push` that assumes the worktree
then commits to the **primary checkout's branch (usually `main`)**, and `git add -A` there even adds
`.claude/worktrees/<name>` as an embedded-repo gitlink.

- Run every git and build command with an explicit path (`git -C <worktree> …`, `pnpm --filter <pkg> …`)
  instead of relying on the current directory.
- Stage scoped paths (`git add website/ packages/`), never a bare `git add -A`.
- A `git push` that prints `main -> main`, or warns about an *embedded git repository*, means you're in
  the wrong checkout: stop and fix it before pushing.

**The same trap with file edits.** Read / Edit / Write take absolute paths. Editing `/…/d3gl/packages/…`
(primary) instead of `/…/.claude/worktrees/<name>/packages/…` lands the change in the primary tree; then
builds, tests and `tsc` run from the worktree see unchanged source, everything "passes", and your work
seems to have no effect. After edits, check that `git -C <worktree> status` shows them. To move a
misplaced edit without redoing it:

```sh
git -C <primary> diff -- <files> | git -C <worktree> apply   # move tracked changes
git -C <primary> checkout -- <files>                         # restore primary to clean
# untracked new files: mv them into the worktree
```

(`rm` may be aliased to `rm -i`; use `command rm -f` for a non-interactive delete.)

## Merge and branch cleanup

**Squash-merge feature PRs** (`gh pr merge <N> --squash`). One commit per PR keeps `main` linear,
revert and bisect trivial, and the work-in-progress commits stay in the PR. Reserve plain merge commits
for genuine long-lived branches.

**Delete the branch by hand after the merge**, not with `--delete-branch`: from inside a linked worktree
it fails (gh tries to check out the base branch, which the primary checkout holds), and a squash-merged
branch isn't an ancestor of `main`, so `git branch -d` refuses it anyway:

```sh
git checkout main && git pull --ff-only
git fetch --prune origin           # drop stale remote-tracking refs
git push origin --delete <branch>  # remote
git branch -D <branch>             # local (confirm it merged via `gh pr list --state merged`)
```

**Never delete** `changeset-release/main` (the Changesets release bot's branch) or a branch with an open PR.

## Enforcement (changeset and Performance policy)

Lifecycle steps 5 and 7 are gated by **one shared check**, `scripts/check-pr-policy.mjs`, run two ways:

- **CI required check**: `.github/workflows/changeset-policy.yml`, status name **`policy`**. It is the
  authoritative gate: `gh pr merge --squash` runs server-side, so branch protection that requires
  `policy` blocks a non-conforming merge whoever triggers it (Settings ▸ Branches ▸ protect `main` ▸
  *Require status checks to pass* ▸ add `policy`).
- **Local pre-merge hook**: `scripts/premerge-gate.sh`, wired in `.claude/settings.json` as a Claude
  Code `PreToolUse(Bash)` hook. It runs the same check before any `gh pr merge` and blocks the call on
  failure. It allows the call if it can't evaluate (node missing, a gh error), since CI is the real gate.
  (`.claude/` is git-ignored except this committed `settings.json`, through a `.gitignore` negation.)

The rules:
1. A change to `packages/d3gl/**` (except the generated `CHANGELOG.md`) needs a changeset. An empty one
   (`pnpm changeset add --empty`) satisfies it when no release is intended.
2. A PR whose body closes an issue (`close` / `fix` / `resolve` + `#N`) needs a `## Performance` section.
3. The `changeset-release/main` (Version Packages) branch is exempt.

## Issue body template

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

## Project board (`mapequation/d3gl`, org project #4)

Status: **Backlog → Ready → In progress → In review → Done.** The built-in workflows automate only entry
and exit: *Item added* → Backlog, *PR merged* / *Issue closed* → Done. Move Backlog → Ready (the
deliberate "groomed and prioritized" signal), In progress and In review by hand. The commands need the
`project,read:project` scopes (`gh auth refresh -s project,read:project`):

```sh
item=$(gh project item-add 4 --owner mapequation --url <issue-url> --format json --jq .id)
gh project item-edit --project-id PVT_kwDOAPRbMM4BaKhB --id "$item" \
  --field-id PVTSSF_lADOAPRbMM4BaKhBzhVEB-k --single-select-option-id <option>
# options: Backlog f75ad846, Ready 61e4505c, In progress 47fc9ee4, In review df73e18b, Done 98236657
```

## Releases (changesets, published by CI)

Publishing is automated by `.github/workflows/release.yml` (the `changesets/action` on push to `main`)
through npm **OIDC trusted publishing**: there is **no local publish and no token**. Never run
`changeset publish` or `npm publish` yourself.

1. **Each published-package change ships a changeset**, `.changeset/<name>.md`, added in its feature PR.
   If one was forgotten, add it on a branch (never push to `main` directly):

   ```md
   ---
   "@mapequation/d3gl": patch   # pre-1.0: `patch` for additions/fixes, `minor` ONLY for breaking changes (see CONTRIBUTING)
   ---
   <user-facing changelog summary>
   ```

   Check with `pnpm changeset status`. (`--since=main` counts only *committed* changesets, so a new
   uncommitted file shows nothing.) The changelog generator is `@changesets/changelog-github`
   (`.changeset/config.json`): an entry written in its **own** feature PR auto-links the PR, commit and
   author. Only a **backfill** (a changeset committed in a different PR than the change it documents)
   needs the original `#PR (commit)` cited by hand.
2. On push to `main`, the workflow opens or updates the **"Version Packages"** PR (branch
   `changeset-release/main`): it bumps `packages/d3gl/package.json`, rewrites `CHANGELOG.md` and deletes
   the consumed changesets. Several changesets bundle into one release.
3. **Merging the Version Packages PR publishes**: the workflow runs `pnpm run release`
   (`build:lib && changeset publish`), pushes the `@mapequation/d3gl@X.Y.Z` tag and creates the GitHub
   release. It publishes only what the accumulated changesets describe; without changesets a push to
   `main` releases nothing.
4. **Verify and tidy**: `npm view @mapequation/d3gl version`, `gh release list`. The primary checkout's
   `main` may be behind (it can't be force-updated while checked out): `git checkout main && git pull
   --ff-only` it, and delete merged feature and changeset branches (local and remote).
