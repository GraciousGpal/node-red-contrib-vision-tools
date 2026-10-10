/**
 * prebuilds/manifest.json: each shipped binary's size and SHA-256, which
 * lib/nativeKernels.js checks before it loads one.
 *
 *   node native/manifest.js [DIR]          write DIR/manifest.json (DIR: prebuilds)
 *   node native/manifest.js --check FILE…  each FILE (DIR/<platform>-<arch>/<name>)
 *                                          against the committed manifest; exit 1
 *                                          on any difference
 *
 * The check is how CI holds a rebuild to the committed binary: the builds
 * are deterministic in their pinned images (native/build.sh), so a
 * different hash is a different compiler, flag or source, not noise.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const entry = (file) => {
	const bytes = fs.readFileSync(file);
	return { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
};
const keyOf = (file) => file.split(path.sep).join("/").split("/").slice(-2).join("/");

if (process.argv[2] === "--check") {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "prebuilds", "manifest.json"), "utf8"));
	let bad = 0;
	for (const file of process.argv.slice(3)) {
		const key = keyOf(file);
		const got = entry(file);
		const want = manifest[key];
		const same = want && want.size === got.size && want.sha256 === got.sha256;
		console.log(`${same ? "same" : "DIFFERENT"} ${key} ${got.size} ${got.sha256}${same ? "" : ` (committed: ${want ? `${want.size} ${want.sha256}` : "none"})`}`);
		if (!same) bad++;
	}
	process.exitCode = bad ? 1 : 0;
} else {
	const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "prebuilds"));
	const manifest = {};
	for (const sub of fs.readdirSync(dir).sort()) {
		const d = path.join(dir, sub);
		if (!fs.statSync(d).isDirectory()) continue;
		for (const name of fs.readdirSync(d).sort()) {
			if (name.endsWith(".node")) manifest[`${sub}/${name}`] = entry(path.join(d, name));
		}
	}
	fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(JSON.stringify(manifest, null, "\t"));
}
