/**
 * The editor's defaults and the runtime's fallbacks must agree.
 *
 * ARCHITECTURE.md calls this out as one of two things that bite when
 * adding a setting, and until now it was maintained entirely by hand -
 * nothing read the .html files. The two ways it goes wrong:
 *
 *  - A default that differs between the editor and the runtime. A node
 *    saved from the editor carries the editor's number, so the runtime
 *    fallback is only reached by an *older* node instance that predates
 *    the property - which is exactly when a silent disagreement is
 *    hardest to notice, because it only affects flows nobody is editing.
 *  - A numeric validator written as RED.validators.number() rather than
 *    number(true). Node-RED does not backfill a new default into existing
 *    node instances, so a node saved before the property existed has no
 *    value for it, and a strict validator marks it "invalid properties"
 *    in every deployed flow - with the message pointing at the node
 *    rather than at what happened.
 *
 * Both files are checked. Defaults whose runtime fallback lives in an
 * idiom rather than a clamp argument (booleans via `!== false` / `!!`,
 * the threshold mode via pickMode) are checked too, since those are the
 * ones most likely to drift; only the free-text paths are exempt, and
 * they are still asserted to default to "".
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..");

/** Pull the `defaults: { ... }` object out of a node's .html by matching
 * braces - it contains JS (validator calls), so it cannot be JSON.parsed
 * and a regex over the whole file would run past the end of the block. */
function defaultsBlock(html) {
	const at = html.indexOf("defaults:");
	assert.ok(at > 0, "no defaults block found");
	const open = html.indexOf("{", at);
	let depth = 0;
	let i = open;
	do {
		if (html[i] === "{") depth++;
		else if (html[i] === "}") depth--;
		i++;
	} while (depth > 0 && i < html.length);
	assert.strictEqual(depth, 0, "unbalanced braces in the defaults block");
	return html.slice(open, i);
}

/** name -> { value, validated } for each entry in that block. */
function parseDefaults(block) {
	const out = {};
	const re = /([A-Za-z][A-Za-z0-9]*)\s*:\s*\{([^{}]*)\}/g;
	let m;
	while ((m = re.exec(block)) !== null) {
		const body = m[2];
		const value = /value\s*:\s*([^,}]+)/.exec(body);
		if (!value) continue;
		out[m[1]] = {
			value: value[1].trim(),
			validated: /validate\s*:/.test(body),
			validator: /validate\s*:\s*([^,}]+)/.exec(body)?.[1].trim() ?? null,
		};
	}
	return out;
}

/** The runtime fallback for `name`, read out of the node's .js. Covers the
 * clamp calls and the boolean/mode idioms alike. */
function runtimeDefault(js, name) {
	const clamp = new RegExp(
		`clamp(?:Int|Float)\\(\\s*(?:config|msg)\\.${name}\\s*,\\s*([^,]+),`,
	).exec(js);
	if (clamp) return clamp[1].trim();
	const mode = new RegExp(
		`pickMode\\(config\\.${name},\\s*("[^"]*")(?:,|\\))`,
	).exec(js);
	if (mode) return mode[1].trim();
	// `config.x !== false` defaults to true; `!!config.x` defaults to false
	if (new RegExp(`config\\.${name}\\s*!==\\s*false`).test(js)) return "true";
	if (new RegExp(`!!config\\.${name}\\b`).test(js)) return "false";
	if (new RegExp(`String\\(config\\.${name}\\s*\\|\\|\\s*""\\)`).test(js))
		return '""';
	// `config.x === "a" || config.x === "b" ? config.x : "c"` - an inline
	// allow-list, where the fallback is the ternary's else branch
	const ternary = new RegExp(
		`config\\.${name}\\s*===[^?]*\\?\\s*config\\.${name}\\s*:\\s*("[^"]*")`,
	).exec(js);
	if (ternary) return ternary[1].trim();
	// A set of flags read in a loop as `config[f]`, where the default-on set
	// is a list: everything named in it is on, and a name reachable only
	// through `.concat([...])` is the opt-in extra, off by default.
	if (new RegExp(`config\\[\\w+\\]`).test(js)) {
		const list = /DEFAULT_[A-Z_]+\s*=\s*\[([^\]]*)\]/.exec(js);
		if (list && new RegExp(`"${name}"`).test(list[1])) return "true";
		if (new RegExp(`concat\\(\\[[^\\]]*"${name}"`).test(js)) return "false";
	}
	return null;
}

// Only free-text paths, and even those are pinned to "" below. Everything
// else - including the booleans and the threshold mode - is compared.
// `aspectRatio`/`expectedSizeFraction` are additionally exempt: the editor
// default is "" (blank = no gate) and the runtime fallback is `null` for
// exactly that meaning, so no numeric idiom can represent it.
// `edgeRegions` joins them for the same reason in a different shape: the
// editor holds a JSON string whose blank means "not configured", and the
// runtime parses it to an object or null. `regions` is the same story again
// as an array - the runtime runs it through normalizeRegions(), which drops
// anything malformed and yields [] for a non-array, so the fallback is a
// function's behaviour rather than a literal.
const NO_RUNTIME_EQUIVALENT = new Set([
	"name",
	"aspectRatio",
	"expectedSizeFraction",
	"edgeRegions",
	"regions",
]);

const NODES = [
	{ html: "golden-compare.html", js: "golden-compare.js" },
	{ html: "checkerboard-calibrate.html", js: "checkerboard-calibrate.js" },
	{ html: "label-crop.html", js: "label-crop.js" },
	{ html: "line-finder.html", js: "line-finder.js" },
	{ html: "barcode-locate.html", js: "barcode-locate.js" },
];

for (const node of NODES) {
	const html = fs.readFileSync(path.join(DIR, node.html), "utf8");
	// A node's runtime fallbacks can live in the lib it delegates to, so read
	// that too rather than reporting "no recognisable fallback" for one.
	const nodeJs = fs.readFileSync(path.join(DIR, node.js), "utf8");
	const libs = [...nodeJs.matchAll(/require\("(\.\/lib\/[\w.]+\.js)"\)/g)]
		.map((m) => fs.readFileSync(path.join(DIR, m[1]), "utf8"));
	const js = [nodeJs, ...libs].join("\n");
	const defaults = parseDefaults(defaultsBlock(html));

	test(`${node.html}: every editor default matches the runtime fallback`, () => {
		const names = Object.keys(defaults);
		assert.ok(names.length > 0, "parsed no defaults at all");
		const mismatches = [];
		let compared = 0;
		for (const name of names) {
			if (NO_RUNTIME_EQUIVALENT.has(name)) continue;
			const runtime = runtimeDefault(js, name);
			assert.ok(
				runtime !== null,
				`${name} has an editor default (${defaults[name].value}) but no ` +
					`recognisable runtime fallback in ${node.js} - either it is ` +
					`ignored at runtime, or this test needs to learn the idiom`,
			);
			compared++;
			// numerically where both are numbers, textually otherwise, so 0.15
			// and .15 do not read as a mismatch
			const a = Number(defaults[name].value);
			const b = Number(runtime);
			const same =
				Number.isNaN(a) || Number.isNaN(b)
					? defaults[name].value === runtime
					: a === b;
			if (!same) {
				mismatches.push(
					`${name}: editor ${defaults[name].value} vs runtime ${runtime}`,
				);
			}
		}
		assert.deepStrictEqual(mismatches, [], mismatches.join("\n"));
		// guards against the parser quietly matching almost nothing and the
		// whole test passing vacuously: today this is 38 of 39, 5 of 6, and
		// 17 of 20 (label-crop exempts name, aspectRatio, expectedSizeFraction)
		const expected = names.filter((n) => !NO_RUNTIME_EQUIVALENT.has(n)).length;
		assert.strictEqual(
			compared,
			expected,
			`compared ${compared} of ${expected} non-exempt defaults`,
		);
	});

	test(`${node.html}: numeric validators allow blank`, () => {
		// RED.validators.number() without `true` rejects a node instance saved
		// before the property existed - in every deployed flow, not just the
		// one being edited.
		const strict = Object.entries(defaults)
			.filter(([, d]) => d.validated && !/number\(\s*true\s*\)/.test(d.validator))
			.map(([name, d]) => `${name}: ${d.validator}`);
		assert.deepStrictEqual(
			strict,
			[],
			`these validators reject a blank value:\n${strict.join("\n")}`,
		);
	});
}
