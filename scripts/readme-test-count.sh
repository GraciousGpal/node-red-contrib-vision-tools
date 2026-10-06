#!/usr/bin/env bash
# Refresh the test count quoted in README.md ("`node --test`), N tests") from a real run.
# Node 24 prints the spec reporter's "ℹ tests N" when piped; Node 18-20 print TAP's
# "# tests N". Both are read. The README is touched only after a green run.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(npm test 2>&1 | grep -E '^(ℹ|#) (tests|pass|fail|skipped) ' || true)
echo "$OUT"
N=$(echo "$OUT" | awk '/tests/ {print $3}')
[ -n "$N" ] || { echo "could not read the test count from npm test" >&2; exit 1; }
FAILS=$(echo "$OUT" | awk '/fail/ {print $3}')
[ "${FAILS:-0}" = 0 ] || { echo "not updating README: $FAILS failing" >&2; exit 1; }
sed -i -E "s/(\`node --test\`\), )[0-9]+/\1$N/" README.md
echo "README test count: $N"
