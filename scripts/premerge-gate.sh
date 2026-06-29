#!/bin/sh
# Claude Code PreToolUse(Bash) gate. Wired up in .claude/settings.json.
#
# Fast-exits (allow) for every Bash command that is not a `gh pr merge`, so it adds
# ~no overhead to normal tool use. When a merge is attempted it defers to the shared
# policy checker (scripts/check-pr-policy.mjs, via premerge-gate.mjs) and blocks the
# merge if the PR lacks a required changeset / `## Performance` section.
#
# Degrades gracefully: if node is unavailable or the policy cannot be evaluated, it
# allows the merge — the server-side CI "policy" check is the authoritative gate.
#
# Exit codes seen by Claude Code: 2 = block the tool call, anything else = allow.

input="$(cat)"

# Fast path: not a PR merge → allow immediately (no node spawn).
case "$input" in
  *"gh pr merge"*) ;;
  *) exit 0 ;;
esac

node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  echo "premerge-gate: node not found on PATH; skipping local check (CI 'policy' check still gates)." >&2
  exit 0
fi

printf '%s' "$input" | "$node_bin" "${CLAUDE_PROJECT_DIR:-.}/scripts/premerge-gate.mjs"
status=$?

# premerge-gate.mjs: 1 = policy violation (block), anything else = allow.
if [ "$status" -eq 1 ]; then
  exit 2
fi
exit 0
