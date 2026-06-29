#!/usr/bin/env node
// Helper for scripts/premerge-gate.sh (the PreToolUse hook). Reads the hook's JSON
// payload on stdin, confirms the Bash command is a `gh pr merge`, extracts the PR
// number, and defers to the shared policy checker (scripts/check-pr-policy.mjs).
//
// Exit codes: 1 = policy violation (the .sh wrapper turns this into a block); any
// other code = allow (policy OK, not actually a merge, or could-not-evaluate).
import { execFileSync } from "node:child_process";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    process.exit(0); // unparseable payload — allow
  }

  const mergeAt = cmd.search(/gh\s+pr\s+merge\b/);
  if (mergeAt === -1) process.exit(0); // not a merge — allow

  // PR number, if given explicitly on the command (e.g. `gh pr merge 166 --squash`).
  // Otherwise let check-pr-policy.mjs resolve the current branch's PR.
  const after = cmd.slice(mergeAt);
  const num = after.match(/\b(\d+)\b/)?.[1];

  const dir = process.env.CLAUDE_PROJECT_DIR || ".";
  const script = `${dir}/scripts/check-pr-policy.mjs`;
  try {
    execFileSync(process.execPath, [script, ...(num ? [num] : [])], { stdio: "inherit" });
    process.exit(0); // policy OK
  } catch (err) {
    const code = typeof err.status === "number" ? err.status : 2;
    if (code === 1) {
      console.error(
        "\nLocal pre-merge gate: blocked (see policy failures above). Fix the changeset / " +
          "`## Performance` issue, or merge on GitHub once the required 'policy' check passes.",
      );
      process.exit(1); // -> .sh exits 2 -> Claude Code blocks the merge
    }
    console.error("premerge-gate: could not evaluate policy locally; CI 'policy' check still gates.");
    process.exit(0); // degrade to the server-side gate
  }
});
