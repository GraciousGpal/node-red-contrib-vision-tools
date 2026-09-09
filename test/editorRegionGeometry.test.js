/**
 * The line-finder editor draws the search region itself - thumbnail,
 * zoom viewer, resize handles - so it carries its own copy of
 * regionFrame()/regionCorners() from lib/lineFinder.js. Two copies of a
 * rotation convention is exactly the kind of thing that drifts, and the
 * failure is nasty: the box drawn is not the box searched, and nothing
 * errors.
 *
 * So this lifts the editor's function straight out of line-finder.html,
 * between its EDITOR_GEOMETRY markers, and runs it against the runtime
 * one. The block has to stay self-contained for that to work, which is
 * asserted too.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { regionCorners } = require("../lib/lineFinder.js");

const HTML = path.join(__dirname, "..", "line-finder.html");
const START = "// EDITOR_GEOMETRY_START";
const END = "// EDITOR_GEOMETRY_END";

function editorSource() {
	const html = fs.readFileSync(HTML, "utf8");
	const from = html.indexOf(START);
	const to = html.indexOf(END);
	assert.ok(from !== -1, `${START} is missing from line-finder.html`);
	assert.ok(to > from, `${END} is missing or out of order`);
	return html.slice(from + START.length, to);
}

function loadEditorFrame() {
	// no DOM, no RED: if the block needs either, this throws, which is the
	// point of keeping it self-contained
	return new Function(
		`${editorSource()}\nreturn regionFrameEditor;`,
	)();
}

const SCANS = ["right", "left", "down", "up"];
const REGIONS = [
	{ x: 0, y: 0, width: 100, height: 100 },
	{ x: 40, y: 60, width: 300, height: 370 },
	// this rig's real ones: a tall sliver and a wide one
	{ x: 40, y: 400, width: 90, height: 2800 },
	{ x: 300, y: 8, width: 2400, height: 90 },
	// non-integer origin and an odd size, to catch a half-pixel convention slip
	{ x: 12.25, y: -7.5, width: 33.5, height: 9.75 },
];
const ANGLES = [0, 0.4, 7.5, -12.5, 45, 90, 179.9, -179.9, 270];

test("the editor's region frame matches the runtime's, corner for corner", () => {
	const regionFrameEditor = loadEditorFrame();
	let checked = 0;
	for (const base of REGIONS) {
		for (const angleDeg of ANGLES) {
			const region = { ...base, angleDeg };
			for (const scan of SCANS) {
				const mine = regionFrameEditor(region, scan).corners;
				const theirs = regionCorners(region, scan);
				assert.strictEqual(mine.length, 4);
				for (let i = 0; i < 4; i++) {
					const dx = Math.abs(mine[i].x - theirs[i].x);
					const dy = Math.abs(mine[i].y - theirs[i].y);
					assert.ok(
						dx < 1e-9 && dy < 1e-9,
						`corner ${i} of ${JSON.stringify(region)} scanning ${scan}: ` +
							`editor ${mine[i].x},${mine[i].y} vs runtime ${theirs[i].x},${theirs[i].y}`,
					);
					checked++;
				}
			}
		}
	}
	assert.ok(checked > 300, `expected a real sweep, only checked ${checked}`);
});

test("an unknown scan direction falls back the way the runtime does", () => {
	const regionFrameEditor = loadEditorFrame();
	const region = { x: 10, y: 20, width: 40, height: 60, angleDeg: 5 };
	// lib/lineFinder.js normalises an unknown value to the default before it
	// ever reaches regionFrame, so the editor's default arm must be "right"
	// rather than "up" - the switch's own default in the runtime
	const fallback = regionFrameEditor(region, "sideways").corners;
	const right = regionCorners(region, "right");
	for (let i = 0; i < 4; i++) {
		assert.ok(Math.abs(fallback[i].x - right[i].x) < 1e-9);
		assert.ok(Math.abs(fallback[i].y - right[i].y) < 1e-9);
	}
});

test("a missing angle is treated as zero, not as NaN", () => {
	const regionFrameEditor = loadEditorFrame();
	const region = { x: 5, y: 5, width: 20, height: 30 };
	const mine = regionFrameEditor(region, "down").corners;
	const theirs = regionCorners(region, "down");
	for (let i = 0; i < 4; i++) {
		assert.ok(Number.isFinite(mine[i].x) && Number.isFinite(mine[i].y));
		assert.ok(Math.abs(mine[i].x - theirs[i].x) < 1e-9);
		assert.ok(Math.abs(mine[i].y - theirs[i].y) < 1e-9);
	}
});

test("the region the viewer measures is the region the finder scans", () => {
	// the depth/length pair decides how many pixels each caliper averages,
	// so it has to agree as well as the corners do
	const regionFrameEditor = loadEditorFrame();
	const region = { x: 100, y: 200, width: 300, height: 40, angleDeg: 3 };
	assert.deepStrictEqual(
		{
			depth: regionFrameEditor(region, "right").depth,
			length: regionFrameEditor(region, "right").length,
		},
		{ depth: 300, length: 40 },
	);
	assert.deepStrictEqual(
		{
			depth: regionFrameEditor(region, "down").depth,
			length: regionFrameEditor(region, "down").length,
		},
		{ depth: 40, length: 300 },
	);
});
