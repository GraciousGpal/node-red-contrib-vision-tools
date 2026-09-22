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
 *
 * The EDITOR_RUN block next to it - the crop the Run button sends and the
 * sentence it writes about a miss - is lifted the same way.
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

const RUN_START = "// EDITOR_RUN_START";
const RUN_END = "// EDITOR_RUN_END";

function runSource() {
	const html = fs.readFileSync(HTML, "utf8");
	const from = html.indexOf(RUN_START);
	const to = html.indexOf(RUN_END);
	assert.ok(from !== -1, `${RUN_START} is missing from line-finder.html`);
	assert.ok(to > from, `${RUN_END} is missing or out of order`);
	return html.slice(from + RUN_START.length, to);
}

/** The Run button's maths, which leans on the geometry block and nothing else. */
function loadEditorRun() {
	return new Function(
		`${editorSource()}\n${runSource()}\nreturn { cropBoxEditor, explainMiss };`,
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

// ---- Run on this image ------------------------------------------------

test("the Run crop is the region's bounding box plus a margin, clamped to the frame", () => {
	const { cropBoxEditor } = loadEditorRun();

	// eight 12.5px bands: the 32px floor is the margin
	assert.deepStrictEqual(
		cropBoxEditor({ x: 100, y: 150, width: 200, height: 100, angleDeg: 0 }, "right", 8, 800, 600),
		{ x: 68, y: 118, width: 264, height: 164, margin: 32 },
	);
	// four 600px bands along a 2400px region scanning down: the band is the
	// margin, and the box is clamped to the frame on three sides
	assert.deepStrictEqual(
		cropBoxEditor({ x: 300, y: 8, width: 2400, height: 90, angleDeg: 0 }, "down", 4, 3000, 2000),
		{ x: 0, y: 0, width: 3000, height: 698, margin: 600 },
	);
	// a fractional region snaps outward, never inward
	assert.deepStrictEqual(
		cropBoxEditor({ x: 10.4, y: 20.6, width: 50.2, height: 30.9, angleDeg: 0 }, "left", 1, 800, 600),
		{ x: 0, y: 0, width: 93, height: 84, margin: 32 },
	);
	// wholly off the frame: nothing to send
	assert.strictEqual(
		cropBoxEditor({ x: 900, y: 900, width: 50, height: 50, angleDeg: 0 }, "right", 8, 800, 600),
		null,
	);
});

test("a rotated region's crop contains its rotated corners, not its upright box", () => {
	const { cropBoxEditor } = loadEditorRun();
	const regionFrameEditor = loadEditorFrame();
	const region = { x: 100, y: 100, width: 200, height: 100, angleDeg: 90 };
	const box = cropBoxEditor(region, "right", 16, 800, 600);
	assert.strictEqual(box.margin, 32);
	const corners = regionFrameEditor(region, "right").corners;
	for (const p of corners) {
		// inside, with the margin to spare (a pixel of rounding either way)
		assert.ok(p.x - box.x >= 31 && box.x + box.width - p.x >= 31, `x ${p.x} in ${JSON.stringify(box)}`);
		assert.ok(p.y - box.y >= 31 && box.y + box.height - p.y >= 31, `y ${p.y} in ${JSON.stringify(box)}`);
	}
	// a 200x100 box turned a quarter is 100 wide and 200 tall
	assert.ok(Math.abs(box.width - 164) <= 1, `width ${box.width}`);
	assert.ok(Math.abs(box.height - 264) <= 1, `height ${box.height}`);
});

test("a miss is explained in terms of the field to move", () => {
	const { explainMiss } = loadEditorRun();
	const settings = {
		contrastThreshold: 2, minCaliperFraction: 0.5, polarity: "either",
		angleToleranceDeg: 10, minScore: 0,
	};
	const base = {
		reason: "no-edge", score: 0, angleDeg: null,
		calipers: { total: 16, found: 0, used: 0 }, settings,
	};
	const diag = (d) => ({
		peakContrast: 0, medianPeakContrast: 0, calipersWithEdge: 0,
		calipersInImage: 16, peakPolarity: null, ...d,
	});

	// the user's case: a faint step under the threshold
	assert.strictEqual(
		explainMiss({ ...base, diagnostics: diag({ peakContrast: 1.3, medianPeakContrast: 0.9, peakPolarity: "lightToDark" }) }),
		"strongest edge contrast 1.3, threshold 2.0 - lower Contrast threshold below 1.3 to pick it up, below 0.90 for most calipers",
	);
	// a step strong enough, but running the other way
	assert.match(
		explainMiss({
			...base, settings: { ...settings, polarity: "darkToLight" },
			diagnostics: diag({ peakContrast: 5, medianPeakContrast: 4, peakPolarity: "lightToDark" }),
		}),
		/runs lightToDark but Polarity is darkToLight - switch Polarity/,
	);
	// only a few calipers see it
	const few = explainMiss({
		...base, reason: "too-few-calipers", calipers: { total: 16, found: 3, used: 0 },
		diagnostics: diag({ peakContrast: 4, medianPeakContrast: 1.1, calipersWithEdge: 3, calipersInImage: 14, peakPolarity: "darkToLight" }),
	});
	assert.match(few, /3\/16 calipers saw an edge above threshold 2\.0/);
	assert.match(few, /Min calipers needs 8/);
	assert.match(few, /2 lie past the frame/);
	assert.match(few, /median caliper peak 1\.1/);
	// the later gates
	assert.match(
		explainMiss({ ...base, reason: "angle-out-of-tolerance", angleDeg: 23.44, diagnostics: diag({ peakContrast: 9 }) }),
		/23\.4° leans more than 10° .* raise Angle tol/,
	);
	assert.match(
		explainMiss({ ...base, reason: "below-min-score", score: 0.31, settings: { ...settings, minScore: 0.5 }, diagnostics: diag({ peakContrast: 9 }) }),
		/score 0\.31 is under Min score 0\.5/,
	);
	// a region that never touched the frame
	assert.match(
		explainMiss({ ...base, diagnostics: diag({ calipersInImage: 0 }) }),
		/no caliper lies wholly inside the image/,
	);
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
