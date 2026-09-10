/**
 * allowScripts must name the versions that actually install.
 *
 * The gate matches on `name@version`, so a pin left behind by a dependency
 * bump stops matching the package it was written for: the install script
 * either does not run - which for a package that fetches or links a prebuilt
 * binary means it never sets itself up - or the gate reports an unrecognised
 * package. Neither shows up here, only on a clean install, which is exactly
 * when it is most expensive to discover.
 *
 * Both pins had already drifted when this was written: the engine was pinned
 * at 1.6.4 against a lockfile resolving 1.7.0, and sharp at 0.35.3 against
 * 0.35.4.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const pkg = require("../package.json");
const lock = require("../package-lock.json");

test("every allowScripts pin matches the resolved version in the lockfile", () => {
	const pins = Object.keys(pkg.allowScripts || {});
	assert.ok(pins.length > 0, "expected at least one allowScripts entry");
	for (const pin of pins) {
		// scoped names carry their own @, so split on the last one
		const at = pin.lastIndexOf("@");
		assert.ok(at > 0, `malformed allowScripts key: ${pin}`);
		const name = pin.slice(0, at);
		const pinned = pin.slice(at + 1);
		const entry = lock.packages[`node_modules/${name}`];
		assert.ok(entry, `${name} is pinned in allowScripts but absent from the lockfile`);
		assert.equal(
			entry.version,
			pinned,
			`allowScripts pins ${name}@${pinned} but the lockfile resolves ${entry.version} - ` +
				`update the pin, or the install script silently stops being allowed`,
		);
	}
});

test("the package version and the lockfile agree", () => {
	// a stale lock root is the other half of the same class of drift
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[""].version, pkg.version);
});

test("allowScripts does not name a package that is not a dependency", () => {
	const declared = new Set([
		...Object.keys(pkg.dependencies || {}),
		...Object.keys(pkg.optionalDependencies || {}),
		...Object.keys(pkg.devDependencies || {}),
	]);
	for (const pin of Object.keys(pkg.allowScripts || {})) {
		const name = pin.slice(0, pin.lastIndexOf("@"));
		assert.ok(
			declared.has(name),
			`allowScripts names ${name}, which is not a declared dependency`,
		);
	}
	void path;
});
