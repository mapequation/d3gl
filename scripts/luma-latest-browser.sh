#!/usr/bin/env bash
# The browser half of the weekly luma.gl check (.github/workflows/luma-latest.yml, #598).
#
# With the newest luma.gl installed, run the browser suite (perf guards excluded), then keep only the
# files that fail because of luma.gl:
#   1. rerun each failing file alone on the newest luma.gl, which drops failures from load;
#   2. reinstall the luma.gl in the lockfile and run what still fails, which drops failures that are
#      already on main (an open test issue, say).
# A file that fails on the newest luma.gl and passes on the locked one is a luma.gl breakage. Those files
# go to $1, one per line. Exits 1 when there is one, or when the suite could not be evaluated.
#
# Usage: scripts/luma-latest-browser.sh <out-file> [vitest filters…]   (run from the repo root)
set -o pipefail

out=$1
shift
: > "$out"
pkg="$PWD/packages/d3gl"
exclude='**/{*-,}perf.browser.test.{ts,tsx}'
json=$(mktemp)

browser() { pnpm --filter @mapequation/d3gl test:browser --exclude "$exclude" "$@"; }

browser --reporter=default --reporter=json --outputFile.json="$json" "$@"
if [ ! -s "$json" ]; then
  echo "The browser suite wrote no results (it crashed or hit the watchdog)."
  exit 1
fi
failed=()
while IFS= read -r f; do failed+=("$f"); done < <(jq -r '.testResults[] | select(.status == "failed") | .name' "$json" | sed "s#^$pkg/##")
echo "Failed on the newest luma.gl: ${#failed[@]} file(s)"
[ ${#failed[@]} -eq 0 ] && exit 0

confirmed=()
for f in "${failed[@]}"; do
  if browser "$f" > /dev/null 2>&1; then echo "passes alone, dropped as load: $f"; else confirmed+=("$f"); fi
done
[ ${#confirmed[@]} -eq 0 ] && exit 0

git checkout -- packages/d3gl/package.json pnpm-lock.yaml
pnpm install --frozen-lockfile > /dev/null
for f in "${confirmed[@]}"; do
  if browser "$f" > /dev/null 2>&1; then
    echo "fails on the newest luma.gl only: $f"
    echo "$f" >> "$out"
  else
    echo "fails on the locked luma.gl too, so not luma.gl's: $f"
  fi
done
[ ! -s "$out" ]
