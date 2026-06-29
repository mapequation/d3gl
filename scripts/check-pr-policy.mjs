#!/usr/bin/env node
// Changeset / Performance policy check for a pull request (AGENTS.md lifecycle 5 + 7).
//
// Shared by the CI required check (.github/workflows/changeset-policy.yml) and the
// local pre-merge hook (scripts/premerge-gate.sh) so both gate on identical rules.
//
// Rules (the "Balanced" policy):
//   1. The Version Packages bot branch (changeset-release/main) is exempt — it
//      consumes changesets rather than adding them.
//   2. If the PR changes published-package source (packages/d3gl/**, excluding the
//      generated CHANGELOG.md) it must add a changeset (any .changeset/*.md other
//      than README.md). An explicit empty changeset (`pnpm changeset add --empty`)
//      satisfies this — it is still a .changeset/*.md file.
//   3. If the PR body closes an issue (close/fix/resolve + #N) it must contain a
//      `## Performance` section.
//
// Usage:  node scripts/check-pr-policy.mjs [<pr-number>]
//   PR number defaults to the PR for the current branch (gh resolves it).
//   Repo from $GH_REPO / $GITHUB_REPOSITORY, else "mapequation/d3gl".
//
// Exit codes:  0 = pass,  1 = policy violation,  2 = could not evaluate (gh error).
import { execFileSync } from "node:child_process";

const prArg = process.argv[2];

// gh resolves the repo from $GH_REPO / $GITHUB_REPOSITORY (set by CI) or the cwd's
// git remote (the local hook always runs inside the repo). We intentionally do NOT
// pass `--repo`: with `--repo` set, `gh pr view` *requires* an explicit number, which
// would break resolving the current branch's PR when `gh pr merge` is run without one.
function gh(args) {
  const env = { ...process.env };
  if (!env.GH_REPO && env.GITHUB_REPOSITORY) env.GH_REPO = env.GITHUB_REPOSITORY;
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

let pr;
try {
  const ref = prArg && /^\d+$/.test(prArg) ? [prArg] : [];
  const out = gh(["pr", "view", ...ref, "--json", "number,body,headRefName,files"]);
  pr = JSON.parse(out);
} catch (err) {
  console.error(`check-pr-policy: could not load PR via gh (${err.message?.trim() || err}).`);
  process.exit(2);
}

const body = pr.body || "";
const files = (pr.files || []).map((f) => f.path);

// 1. Release bot branch is exempt.
if (pr.headRefName === "changeset-release/main") {
  console.log(`PR #${pr.number}: changeset-release/main (Version Packages) — exempt.`);
  process.exit(0);
}

const changesPackage = files.some(
  (p) => p.startsWith("packages/d3gl/") && p !== "packages/d3gl/CHANGELOG.md",
);
const hasChangeset = files.some(
  (p) => p.startsWith(".changeset/") && p.endsWith(".md") && !p.endsWith("/README.md"),
);
// GitHub closing keywords: close|closes|closed | fix|fixes|fixed | resolve|resolves|resolved
const closesIssue = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#\d+/i.test(body);
const hasPerformance = /^[ \t]*#{1,6}[ \t]+Performance\b/im.test(body);

const failures = [];
if (changesPackage && !hasChangeset) {
  failures.push(
    "Changes packages/d3gl/** but adds no changeset. Run `pnpm changeset` " +
      "(or `pnpm changeset add --empty` if no release is intended).",
  );
}
if (closesIssue && !hasPerformance) {
  failures.push(
    "PR body closes an issue (close/fix/resolve #N) but has no `## Performance` " +
      "section. Add one per AGENTS.md lifecycle step 5 (Per-frame cost + Memory footprint).",
  );
}

if (failures.length) {
  console.error(`PR #${pr.number} fails the changeset/Performance policy:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(
  `PR #${pr.number}: policy OK ` +
    `(packageChange=${changesPackage}, changeset=${hasChangeset}, ` +
    `closesIssue=${closesIssue}, performance=${hasPerformance}).`,
);
process.exit(0);
