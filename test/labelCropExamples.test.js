/**
 * The example flows import against the editors as they are today.
 *
 * An example is a JSON export nobody re-saves from the editor, so a
 * property renamed or added in a node's `defaults` leaves it behind
 * silently: Node-RED imports the stale node without complaint and the
 * runtime falls back to a default the flow's author never chose. Every
 * line-finder and label-crop node in examples/ is therefore held to the
 * exact key set of its editor's defaults, and the line-finder-to-label-crop
 * example is run end to end on the synthetic frame its function node
 * draws, so "imports and runs" is asserted rather than promised.
 *
 * The engine is the pixel fake, so the suite stays hermetic.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { _setBridge, _resetBridge } = require("../lib/labelCrop.js");
const { loadNode } = require("./helpers/fakeRed.js");
const { pixelEngine } = require("./helpers/pixelEngine.js");

const DIR = path.join(__dirname, "..");
const EXAMPLES = path.join(DIR, "examples");

// the keys Node-RED itself puts on an exported node, next to its defaults
const STRUCTURAL = new Set(["id", "type", "z", "x", "y", "wires", "g", "d", "l"]);
const EDITORS = {
	"line-finder": "line-finder.html",
	"label-crop": "label-crop.html",
};

/** The keys of a node's editor `defaults`, the way editorMarkup reads them. */
function defaultKeys(htmlFile) {
	const html = fs.readFileSync(path.join(DIR, htmlFile), "utf8");
	const block = html.match(/defaults:\s*\{([\s\S]*?)\n\s{4}\},/);
	assert.ok(block, `${htmlFile}: could not find the defaults block`);
	return [...block[1].matchAll(/^\s{6}(\w+):\s*\{/gm)].map((m) => m[1]);
}

function loadExample(name) {
	const text = fs.readFileSync(path.join(EXAMPLES, name), "utf8");
	const flow = JSON.parse(text);
	assert.ok(Array.isArray(flow) && flow.length > 0, `${name}: not a flow array`);
	return flow;
}

const exampleFiles = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"));

test("there are example flows to check", () => {
	assert.ok(exampleFiles.length >= 2, exampleFiles.join(", "));
});

for (const file of exampleFiles) {
	test(`${file}: every line-finder and label-crop node carries exactly its editor's defaults`, () => {
		const flow = loadExample(file);
		const checked = [];
		for (const node of flow) {
			const html = EDITORS[node.type];
			if (!html) continue;
			const expected = defaultKeys(html);
			const actual = Object.keys(node).filter((k) => !STRUCTURAL.has(k));
			const unknown = actual.filter((k) => !expected.includes(k));
			const missing = expected.filter((k) => !actual.includes(k));
			assert.deepStrictEqual(unknown, [], `${node.id} (${node.type}) has properties the editor does not know: ${unknown.join(", ")}`);
			assert.deepStrictEqual(missing, [], `${node.id} (${node.type}) lacks properties the editor saves: ${missing.join(", ")}`);
			checked.push(node.id);
		}
		assert.ok(checked.length > 0, "the example has no vision node in it");
	});

	test(`${file}: every wire points at a node in the flow`, () => {
		const flow = loadExample(file);
		const ids = new Set(flow.map((n) => n.id));
		for (const node of flow) {
			for (const port of node.wires || []) {
				for (const target of port) {
					assert.ok(ids.has(target), `${node.id} wires to ${target}, which is not in the flow`);
				}
			}
		}
	});

	test(`${file}: a calipers label-crop carries four parseable edge regions`, () => {
		const flow = loadExample(file);
		for (const node of flow) {
			if (node.type !== "label-crop" || node.boundaryMode !== "calipers") continue;
			const regions = JSON.parse(node.edgeRegions);
			for (const side of ["left", "right", "top", "bottom"]) {
				assert.ok(regions[side], `${node.id}: edgeRegions lacks ${side}`);
			}
		}
	});
}

// ---- the line-finder-to-label-crop example, run --------------------------

const RECT_EXAMPLE = "line-finder-rect-to-label-crop.json";

/** Run one node's input listener and resolve with what it sent. */
function drive(node, msg) {
	return new Promise((resolve, reject) => {
		const sent = [];
		node.listeners.input(
			msg,
			(m) => sent.push(m),
			(err) => (err ? reject(err) : resolve(sent)),
		);
	});
}

test(`${RECT_EXAMPLE}: the flow is wired inject -> frame -> line-finder -> label-crop -> debug`, () => {
	const flow = loadExample(RECT_EXAMPLE);
	const byId = Object.fromEntries(flow.map((n) => [n.id, n]));
	const next = (n) => byId[n.wires[0][0]];
	const inject = flow.find((n) => n.type === "inject");
	const frame = next(inject);
	assert.strictEqual(frame.type, "function");
	const finder = next(frame);
	assert.strictEqual(finder.type, "line-finder");
	assert.deepStrictEqual(
		finder.regions.map((r) => r.name).sort(),
		["bottom", "left", "right", "top"],
	);
	assert.deepStrictEqual(
		Object.fromEntries(finder.regions.map((r) => [r.name, r.scanDirection])),
		{ left: "right", right: "left", top: "down", bottom: "up" },
		"every region scans inward",
	);
	const crop = next(finder);
	assert.strictEqual(crop.type, "label-crop");
	assert.strictEqual(crop.boundaryMode, "upstream");
	assert.strictEqual(next(crop).type, "debug");
});

test(`${RECT_EXAMPLE}: runs end to end on its own synthetic frame`, async () => {
	const flow = loadExample(RECT_EXAMPLE);
	const frameNode = flow.find((n) => n.type === "function");
	const finderCfg = flow.find((n) => n.type === "line-finder");
	const cropCfg = flow.find((n) => n.type === "label-crop");

	// the function node's body, given the msg and Buffer it uses
	const frame = new Function("msg", "Buffer", frameNode.func)({}, Buffer);
	assert.strictEqual(frame.payload.width, 800);
	assert.strictEqual(frame.payload.height, 600);

	const finder = loadNode("line-finder.js", finderCfg, { id: finderCfg.id });
	const [measured] = await drive(finder, frame);
	assert.strictEqual(measured.lineFinder.found, true, measured.lineFinder.reason);
	assert.ok(measured.lineFinder.rect, "four named regions make a rectangle");
	assert.strictEqual(measured.lineFinder.rect.ok, true, measured.lineFinder.rect.reason);

	_setBridge(pixelEngine());
	try {
		const crop = loadNode("label-crop.js", cropCfg, { id: cropCfg.id });
		const statuses = [];
		crop.status = (s) => statuses.push(s);
		const [out] = await drive(crop, measured);
		assert.strictEqual(out.labelCrop.detected, true, out.labelCrop.reason);
		assert.strictEqual(out.labelCrop.reason, "upstream-rect");
		// the function node draws a 480x312 label tilted 4 degrees at (400,300)
		assert.ok(Math.abs(out.labelCrop.width - 480) <= 2, `width ${out.labelCrop.width}`);
		assert.ok(Math.abs(out.labelCrop.height - 312) <= 2, `height ${out.labelCrop.height}`);
		assert.ok(Math.abs(out.labelCrop.angleDeg - 4) < 0.3, `angle ${out.labelCrop.angleDeg}`);
		assert.ok(
			Math.abs(out.labelCrop.center.x - 400) < 1.5 && Math.abs(out.labelCrop.center.y - 300) < 1.5,
			`centre ${JSON.stringify(out.labelCrop.center)}`,
		);
		assert.strictEqual(out.labelCrop.crop.rotated, true);
		// the status prints the metadata's width and height, to a tenth of a pixel
		assert.match(statuses.at(-1).text, /^deskewed 4(79|80|81)(\.\d)?×31[1-3](\.\d)?$/);
	} finally {
		_resetBridge();
	}
});
