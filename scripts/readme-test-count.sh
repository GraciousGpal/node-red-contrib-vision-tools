#!/usr/bin/env bash
# Refresh the test count quoted in README.md ("`node --test`), N tests") from a real run.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(npm test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped) ' || true)
echo "$OUT"
N=$(echo "$OUT" | awk '/tests/ {print $3}')
[ -n "$N" ] || { echo "could not read the test count from npm test" >&2; exit 1; }
sed -i -E "s/(\`node --test\`\), )[0-9]+/\1$N/" README.md
grep -n 'node --test`), ' README.md
echo "$OUT" | grep -q '^ℹ fail 0$' || { echo "note: there are failing tests" >&2; exit 1; }
