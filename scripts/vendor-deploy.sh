#!/usr/bin/env bash
# Pack this checkout into ../NodeRed-Test/vendor and point that project at it.
#
#   npm run deploy:vendor            # pack, repoint package.json, refresh lockfile
#   npm run deploy:vendor -- --build # ...then docker compose build + up -d
#   npm run deploy:vendor -- --dry-run
#
# NodeRed-Test installs this package from a vendored tarball named
# vision-tools-<version>-<sha>.tgz (a temporary state until the version is on
# npm; its Dockerfile says so). Older vision-tools tarballs in vendor/ are
# removed so the directory holds exactly one, and the Dockerfile comment above
# its COPY vendor/ line is rewritten to name the commit and list what it carries
# past the last tag (scripts/vendor-note.js). Override the sibling checkout with
# NODERED_TEST_DIR.
set -euo pipefail
cd "$(dirname "$0")/.."

T="${NODERED_TEST_DIR:-../NodeRed-Test}"
build=0; dry=0
for a in "$@"; do
	case "$a" in
		--build) build=1 ;;
		--dry-run) dry=1 ;;
		-h|--help) sed -n '2,12p' "$0"; exit 0 ;;
		*) echo "unknown flag $a" >&2; exit 2 ;;
	esac
done
[ -f "$T/package.json" ] || { echo "no package.json in $T (set NODERED_TEST_DIR)" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
	echo "WARNING: working tree is dirty; the tarball will be named after HEAD but contain uncommitted changes" >&2
fi
VER=$(node -p 'require("./package.json").version')
SHA=$(git rev-parse --short HEAD)
NAME="vision-tools-$VER-$SHA.tgz"
echo "packing $NAME -> $T/vendor"
# --loglevel notice: under `npm run -s` the inherited silent level would hide these lines.
[ $dry -eq 1 ] && { npm pack --dry-run --loglevel notice 2>&1 | grep -E 'package size|total files' || true; echo "(dry run, nothing written)"; exit 0; }

mkdir -p "$T/vendor"
for old in "$T"/vendor/vision-tools-*.tgz; do
	[ -f "$old" ] && [ "$(basename "$old")" != "$NAME" ] && rm -f "$old" && echo "removed $(basename "$old")"
done
PACK=$(npm pack --silent --pack-destination "$T/vendor")
mv -f "$T/vendor/$PACK" "$T/vendor/$NAME"

# Repoint the dependency without disturbing the rest of the file.
node -e '
const fs = require("fs"), p = process.argv[1], name = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.dependencies["@graciousstar/node-red-contrib-vision-tools"] = "file:vendor/" + name;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$T/package.json" "$NAME"
grep -n 'vision-tools' "$T/package.json"

(cd "$T" && npm install --package-lock-only --no-audit --no-fund --ignore-scripts 2>&1 | tail -2)
node scripts/vendor-note.js "$T/Dockerfile" "$SHA"

if [ $build -eq 1 ]; then
	(cd "$T" && docker compose build node-red && docker compose up -d node-red)
else
	echo "next: (cd $T && docker compose build node-red && docker compose up -d node-red)"
fi
