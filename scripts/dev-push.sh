#!/usr/bin/env bash
# Hot-push package files into the local Node-RED test container and restart it.
#
#   npm run dev:push                 # every modified/untracked file npm would publish
#   npm run dev:push -- lib/compare.js golden-compare.html
#   npm run dev:push -- --no-restart # copy only
#   npm run dev:push -- --dry-run    # show what would be copied
#
# The container is the one built from ../NodeRed-Test (docker compose), where
# this package is installed from a vendored tarball; see vendor-deploy.sh for
# the real install. This script just overwrites files inside the running
# container, which is enough for the editor and runtime to pick up a change
# after a restart. Override with VT_CONTAINER / VT_ADMIN_URL if needed.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash would otherwise rewrite the container path

CONTAINER="${VT_CONTAINER:-nodered-test-node-red-1}"
ADMIN="${VT_ADMIN_URL:-http://localhost:1880}"
PKG="/usr/src/node-red/node_modules/@graciousstar/node-red-contrib-vision-tools"

cd "$(dirname "$0")/.."

restart=1; dry=0; files=()
for a in "$@"; do
	case "$a" in
		--no-restart) restart=0 ;;
		--dry-run) dry=1 ;;
		-h|--help) sed -n '2,15p' "$0"; exit 0 ;;
		*) files+=("$a") ;;
	esac
done

# Default: changed files that are part of the published package (package.json
# "files"), since the container only has those. Tests and bench stay local.
if [ ${#files[@]} -eq 0 ]; then
	while IFS= read -r f; do
		[ -n "$f" ] && files+=("$f")
	done < <(git status --porcelain=v1 --untracked-files=all | cut -c4- \
		| grep -E '^([^/]+\.(js|html)|package\.json|(lib|icons|examples)/.+)$' || true)
fi
if [ ${#files[@]} -eq 0 ]; then
	echo "nothing to push (no changed package files; pass paths explicitly to force)"; exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
	echo "container $CONTAINER is not running (docker compose up -d in ../NodeRed-Test)" >&2; exit 1
fi

for f in "${files[@]}"; do
	if [ ! -f "$f" ]; then echo "skip $f (not a file)"; continue; fi
	if [ $dry -eq 1 ]; then echo "would copy $f"; continue; fi
	docker cp "$f" "$CONTAINER:$PKG/$f" && echo "copied $f"
done
[ $dry -eq 1 ] && exit 0
[ $restart -eq 0 ] && { echo "copied without restart"; exit 0; }

docker restart "$CONTAINER" >/dev/null
code=000
for i in $(seq 1 45); do
	sleep 2
	code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$ADMIN/flows" || true)
	[ "$code" = "200" ] && break
done
if [ "$code" != "200" ]; then
	echo "Node-RED did not answer on $ADMIN/flows after ~90s (last $code)" >&2
	docker logs --since 2m "$CONTAINER" 2>&1 | tail -30; exit 1
fi
echo "Node-RED up after ~$((i * 2))s"

# The /nodes listing says whether the module loaded and reports a load error.
curl -s -m 10 -H 'Accept: application/json' "$ADMIN/nodes" | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
	for (const m of JSON.parse(s)) {
		if (!/vision-tools/.test(m.module || "")) continue;
		const line = `${m.module} ${m.version} ${m.enabled ? "enabled" : "DISABLED"} ${m.types.join(",")}`;
		console.log(m.err ? `${line}\n  ERR: ${m.err}` : line);
	}
});'

# Anything the runtime complained about while loading.
docker logs --since 2m "$CONTAINER" 2>&1 | grep -iE '\[error\]|cannot find|exception|vision-tools' | tail -15 || true
