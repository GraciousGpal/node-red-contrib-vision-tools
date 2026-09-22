/**
 * Every id an editor script looks up must exist in its own template.
 *
 * This is the one class of editor bug that no other test here can see.
 * test/lineFinderEditor.test.js runs the script against a fake DOM that
 * creates elements on demand - it has to, or it would be a copy of the
 * markup rather than a test of the code - so a mistyped id sails through
 * it and then throws "cannot read properties of null" in the browser,
 * where nothing but the edit dialog failing to open tells you.
 *
 * Only literal lookups are checked. Ids built by concatenation
 * (`"...-preview-container-" + id`) belong to elements the script itself
 * creates and cannot be checked this way.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..");
const HTML_FILES = [
	"golden-compare.html",
	"checkerboard-calibrate.html",
	"perspective-rectify.html",
	"label-crop.html",
	"line-finder.html",
	"barcode-locate.html",
];

/** The editor <script> and every data-template-name block, separately. */
function split(html) {
	const script = html.match(
		/<script type="text\/javascript">\n([\s\S]*)\n<\/script>\s*$/,
	);
	assert.ok(script, "no editor script block");
	const templates = [...html.matchAll(
		/<script type="text\/html" data-template-name="[^"]+">([\s\S]*?)<\/script>/g,
	)].map((m) => m[1]);
	assert.ok(templates.length > 0, "no template block");
	return { script: script[1], templates };
}

for (const file of HTML_FILES) {
	test(`${file}: every id the script looks up is in the markup`, () => {
		const html = fs.readFileSync(path.join(DIR, file), "utf8");
		const { script, templates } = split(html);
		const markup = templates.join("\n");

		const looked = new Set();
		for (const m of script.matchAll(/getElementById\((["'])([\w-]+)\1\)/g)) {
			looked.add(m[2]);
		}
		// jQuery selectors are used interchangeably with getElementById in
		// these files, so they carry the same risk
		for (const m of script.matchAll(/\$\((["'])#([\w-]+)\1\)/g)) {
			looked.add(m[2]);
		}
		if (looked.size === 0) {
			// golden-compare and checkerboard-calibrate have no oneditprepare at
			// all - their editors are pure markup, so there is nothing to check
			return;
		}

		const missing = [...looked].filter(
			(id) => !markup.includes(`id="${id}"`),
		);
		assert.deepStrictEqual(
			missing,
			[],
			`${file} looks up ids that its template does not define: ${missing.join(", ")}`,
		);
	});

	test(`${file}: every declared default has an input to edit it`, () => {
		// a default with no field is a setting nobody can change from the
		// editor - either the row was dropped or the default is dead
		const html = fs.readFileSync(path.join(DIR, file), "utf8");
		// ...unless a custom widget edits it. barcode-locate builds its region
		// rows itself, so there is no one element holding the value, and
		// line-finder keeps its region list in the editor script - a hidden
		// node-input would make Node-RED store the array as a string.
		const CUSTOM_WIDGET = {
			"barcode-locate.html": ["regions"],
			"line-finder.html": ["regions"],
		};
		const { script, templates } = split(html);
		const markup = templates.join("\n");
		const block = script.match(/defaults:\s*\{([\s\S]*?)\n\s{4}\},/);
		assert.ok(block, "could not find the defaults block");

		const keys = [...block[1].matchAll(/^\s{6}(\w+):\s*\{/gm)].map((m) => m[1]);
		assert.ok(keys.length > 3, `only found ${keys.length} defaults`);
		const exempt = new Set(CUSTOM_WIDGET[file] || []);
		const missing = keys.filter(
			(key) => !exempt.has(key) && !markup.includes(`id="node-input-${key}"`),
		);
		assert.deepStrictEqual(missing, [], `no input for: ${missing.join(", ")}`);
		// and an exemption that stopped being needed should be removed
		for (const key of exempt) {
			assert.ok(
				keys.includes(key),
				`${key} is exempted in ${file} but is not a default any more`,
			);
		}
	});
}
