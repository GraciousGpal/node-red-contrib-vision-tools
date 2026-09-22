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

// ---- the region list ----------------------------------------------------

const REGIONS_START = "// EDITOR_REGIONS_START";
const REGIONS_END = "// EDITOR_REGIONS_END";

function regionsSource() {
	const html = fs.readFileSync(HTML, "utf8");
	const from = html.indexOf(REGIONS_START);
	const to = html.indexOf(REGIONS_END);
	assert.ok(from !== -1, `${REGIONS_START} is missing from line-finder.html`);
	assert.ok(to > from, `${REGIONS_END} is missing or out of order`);
	return html.slice(from + REGIONS_START.length, to);
}

/** The list maths, which needs nothing from the DOM or the other blocks. */
function loadEditorRegions() {
	return new Function(
		`${regionsSource()}\nreturn { normalizeRegionEditor, rectangleRegionsEditor, mergeRectangleEditor, edgeRegionsEditor };`,
	)();
}

/** The Run block's rectangle maths, with the geometry it leans on. */
function loadEditorRect() {
	return new Function(
		`${editorSource()}\n${runSource()}\nreturn { intersectLinesEditor, rectCornersEditor, shortMiss };`,
	)();
}

test("Add rectangle lays out four inward-scanning sides inside the frame", () => {
	const { rectangleRegionsEditor } = loadEditorRegions();
	for (const [W, H] of [[800, 600], [3000, 2000], [640, 2400], [0, 0]]) {
		const sides = rectangleRegionsEditor(W, H);
		assert.deepStrictEqual(sides.map((r) => r.name), ["left", "right", "top", "bottom"]);
		// each side scans towards the middle of the frame
		assert.deepStrictEqual(
			sides.map((r) => r.scanDirection),
			["right", "left", "down", "up"],
		);
		const w = W || 1000;
		const h = H || 750;
		for (const r of sides) {
			assert.ok(r.x >= 0 && r.y >= 0, `${r.name} starts inside ${w}x${h}: ${JSON.stringify(r)}`);
			assert.ok(r.x + r.width <= w && r.y + r.height <= h, `${r.name} ends inside ${w}x${h}: ${JSON.stringify(r)}`);
			assert.strictEqual(r.angleDeg, 0);
			assert.strictEqual(r.polarity, "either");
			assert.strictEqual(r.edgeSelect, "best");
		}
		const [left, right, top, bottom] = sides;
		// the box straddles the edge it is for: left's centre sits on the
		// left edge of the central 60%, and so on
		const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1, `${what}: ${a} vs ${b}`);
		close(left.x + left.width / 2, w * 0.2, "left edge");
		close(right.x + right.width / 2, w * 0.8, "right edge");
		close(top.y + top.height / 2, h * 0.2, "top edge");
		close(bottom.y + bottom.height / 2, h * 0.8, "bottom edge");
		// and the sides stop short of the corners, so left/right do not
		// overlap top/bottom
		assert.ok(left.y > top.y + top.height, "left starts below the top box");
		assert.ok(left.y + left.height < bottom.y, "left ends above the bottom box");
	}
});

test("Add rectangle replaces same-named sides, keeps the rest, and drops an untouched default", () => {
	const { rectangleRegionsEditor, mergeRectangleEditor, normalizeRegionEditor } = loadEditorRegions();
	const sides = rectangleRegionsEditor(800, 600);
	// a fresh node: one default region nobody has moved
	const fresh = [normalizeRegionEditor({ name: "line", x: 0, y: 0, width: 100, height: 100 })];
	assert.deepStrictEqual(mergeRectangleEditor(fresh, sides), sides);
	// a moved one is somebody's work and stays
	const moved = [normalizeRegionEditor({ name: "line", x: 10, y: 0, width: 100, height: 100 })];
	assert.deepStrictEqual(mergeRectangleEditor(moved, sides).map((r) => r.name), ["line", "left", "right", "top", "bottom"]);
	// an existing "top" is replaced, not duplicated
	const some = [
		normalizeRegionEditor({ name: "top", x: 5, y: 5, width: 50, height: 20, scanDirection: "down" }),
		normalizeRegionEditor({ name: "seam", x: 300, y: 300, width: 40, height: 40 }),
	];
	const merged = mergeRectangleEditor(some, sides);
	assert.deepStrictEqual(merged.map((r) => r.name), ["seam", "left", "right", "top", "bottom"]);
	assert.strictEqual(merged.find((r) => r.name === "top").x, sides[2].x);
});

test("a stored region entry is normalised the way the runtime normalises it", () => {
	const { normalizeRegionEditor } = loadEditorRegions();
	assert.deepStrictEqual(
		normalizeRegionEditor({ name: " left ", x: "10", y: 20.5, width: "0", height: "40", angleDeg: "", scanDirection: "sideways", polarity: "darkToLight", edgeSelect: null }, 3),
		{ name: "left", x: 10, y: 20.5, width: 1, height: 40, angleDeg: 0, scanDirection: "right", polarity: "darkToLight", edgeSelect: "best" },
	);
	assert.strictEqual(normalizeRegionEditor({}, 3).name, "region4");
	assert.strictEqual(normalizeRegionEditor(null, 0).width, 100);
});

test("the Copy button's JSON is what label-crop's calipers mode reads", () => {
	const { edgeRegionsEditor, rectangleRegionsEditor } = loadEditorRegions();
	const { normalizeCfg, normalizeRegion, DEFAULTS } = require("../lib/lineFinder.js");
	const cfg = {
		calipers: "12", contrastThreshold: "1.5", filterHalfWidth: "2", ignoreCount: "0",
		outlierTolerancePx: "2.5", minCaliperFraction: "0.2", angleToleranceDeg: "", minScore: "0.3",
	};
	// three sides are not a rectangle
	assert.strictEqual(edgeRegionsEditor(rectangleRegionsEditor(800, 600).slice(0, 3), cfg), null);

	const sides = rectangleRegionsEditor(800, 600);
	sides[0].polarity = "darkToLight";
	sides[0].edgeSelect = "last";
	sides[2].angleDeg = 1.5;
	const spec = edgeRegionsEditor(sides, cfg);
	assert.deepStrictEqual(Object.keys(spec), ["left", "right", "top", "bottom"]);
	for (const side of Object.keys(spec)) {
		// what lib/labelCrop.js boundaryByCalipers does with each entry: the
		// box goes to normalizeRegion, everything else to the finder's options
		const { x, y, width, height, angleDeg, ...rest } = spec[side];
		const reg = normalizeRegion({ x, y, width, height, angleDeg });
		assert.ok(reg.width > 0 && reg.height > 0);
		// the scan direction is label-crop's to imply from the side; a value
		// here would override it, so there must not be one
		assert.strictEqual("scanDirection" in rest, false, `${side} carries scanDirection`);
		assert.strictEqual("minScore" in rest, false, "minScore is not a finder option");
		const opts = normalizeCfg(rest);
		assert.strictEqual(opts.calipers, 12);
		assert.strictEqual(opts.contrastThreshold, 1.5);
		assert.strictEqual(opts.minCaliperFraction, 0.2);
		assert.strictEqual(opts.angleToleranceDeg, null, "a blank tolerance is off, not the default");
		// nothing in the entry is unknown to the finder
		for (const k of Object.keys(rest)) assert.ok(k in DEFAULTS, `${side}.${k} is not a line-finder option`);
	}
	// per-side modes travel; defaults are left implicit
	assert.strictEqual(spec.left.polarity, "darkToLight");
	assert.strictEqual(spec.left.edgeSelect, "last");
	assert.strictEqual(spec.right.polarity, undefined);
	assert.strictEqual(spec.top.angleDeg, 1.5);
	assert.strictEqual(spec.bottom.angleDeg, undefined);
	// and a pasted round trip survives JSON
	assert.deepStrictEqual(JSON.parse(JSON.stringify(spec)), spec);
});

test("the editor's line intersection matches the runtime's, corners included", () => {
	const { intersectLinesEditor, rectCornersEditor } = loadEditorRect();
	const { intersectLines } = require("../lib/lineFinder.js");
	const lines = [
		{ x: 100, y: 200, dx: 0.01, dy: 0.99995 },
		{ x: 300, y: 50, dx: 0.9999, dy: -0.012 },
		{ x: 0, y: 0, dx: Math.SQRT1_2, dy: Math.SQRT1_2 },
		{ x: 40, y: 500, dx: 1, dy: 0 },
	];
	for (const a of lines) {
		for (const b of lines) {
			const mine = intersectLinesEditor(a, b);
			const theirs = intersectLines(a, b);
			if (theirs === null) {
				assert.strictEqual(mine, null);
			} else {
				assert.ok(Math.abs(mine.x - theirs.x) < 1e-9 && Math.abs(mine.y - theirs.y) < 1e-9);
			}
		}
	}
	const found = (line) => ({ found: true, line });
	const byName = {
		left: found({ x: 100, y: 300, dx: 0, dy: 1 }),
		right: found({ x: 500, y: 300, dx: 0, dy: 1 }),
		top: found({ x: 300, y: 150, dx: 1, dy: 0 }),
		bottom: found({ x: 300, y: 450, dx: 1, dy: 0 }),
	};
	assert.deepStrictEqual(rectCornersEditor(byName), [
		{ x: 100, y: 150 }, { x: 500, y: 150 }, { x: 500, y: 450 }, { x: 100, y: 450 },
	]);
	assert.strictEqual(rectCornersEditor({ ...byName, top: { found: false } }), null);
	assert.strictEqual(rectCornersEditor({ left: byName.left, right: byName.right }), null);
	// two parallel "sides" cannot make a corner
	assert.strictEqual(rectCornersEditor({ ...byName, top: byName.left }), null);
});

test("a miss is summarised in a few characters for the per-region line", () => {
	const { shortMiss } = loadEditorRect();
	const settings = { contrastThreshold: 2, minCaliperFraction: 0.5, polarity: "either", angleToleranceDeg: 10, minScore: 0.5 };
	const base = { reason: "no-edge", score: 0, calipers: { total: 16 }, settings };
	const diag = (d) => ({ peakContrast: 0, medianPeakContrast: 0, calipersWithEdge: 0, calipersInImage: 16, peakPolarity: null, ...d });
	assert.strictEqual(shortMiss({ ...base, diagnostics: diag({ peakContrast: 1.2 }) }), "contrast 1.2<2.0");
	assert.strictEqual(shortMiss({ ...base, reason: "too-few-calipers", diagnostics: diag({ peakContrast: 4, calipersWithEdge: 3 }) }), "calipers 3/16");
	assert.strictEqual(shortMiss({ ...base, reason: "angle-out-of-tolerance", angleDeg: 23.44, diagnostics: diag({ peakContrast: 9 }) }), "angle 23.4°>10°");
	assert.strictEqual(shortMiss({ ...base, reason: "below-min-score", score: 0.31, diagnostics: diag({ peakContrast: 9 }) }), "score 0.31<0.5");
	assert.strictEqual(shortMiss({ ...base, settings: { ...settings, polarity: "darkToLight" }, diagnostics: diag({ peakContrast: 5, peakPolarity: "lightToDark" }) }), "polarity is lightToDark");
	assert.strictEqual(shortMiss({ ...base, diagnostics: diag({ calipersInImage: 0 }) }), "off the frame");
	assert.strictEqual(shortMiss({ found: false, reason: "off-frame" }), "off the frame");
	assert.strictEqual(shortMiss({ found: false, reason: "error", error: "no response" }), "error: no response");
});
