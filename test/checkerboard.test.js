/**
 * Regression tests for lib/checkerboard.js.
 *
 * The bug this suite exists for: a grid that is too thin to measure
 * (fewer than 3 rows, or fewer than 2 columns) left one of the pitch
 * diff lists empty, median([]) returned NaN, and the board reported
 * detected:true with a NaN pitch and NaN mm/px scale - which, once saved,
 * silently disabled the mm position gate downstream. Such a grid must be
 * reported as not detected, with a reason.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { measurePitch, measureCheckerboard } = require("../lib/checkerboard.js");

/** Synthetic checkerboard: `cols` x `rows` physical squares, top-left
 * light unless `darkFirst`, each square `size` px. The corner colour only
 * matters on an odd-column board, where it decides whether the long rows
 * are the even-indexed ones or the odd-indexed ones. */
function boardSvg(cols, rows, size, darkFirst = false) {
	let cells = "";
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const dark = (r + c) % 2 === (darkFirst ? 0 : 1);
			cells += `<rect x="${c * size}" y="${r * size}" width="${size}" height="${size}" fill="${dark ? "#000" : "#fff"}"/>`;
		}
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * size}" height="${rows * size}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			cells +
			`</svg>`,
	);
}

const png = (svg) => sharp(svg).png().toBuffer();

test("a real checkerboard is detected and its mm/px scale is exact", async () => {
	// 8 squares per row x 6 rows, top-left light: 4 dark squares per row
	const S = 40;
	const buf = await png(boardSvg(8, 6, S));
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 4,
		checkerboardRows: 6,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, true, r.reason);
	// pitch is the distance between same-colour adjacent squares = two
	// square widths; y-pitch is measured two rows apart for the same reason
	assert.strictEqual(r.pitchXPx, 2 * S);
	assert.strictEqual(r.pitchYPx, 2 * S);
	assert.strictEqual(r.mmPerPixel, 10 / (2 * S));
});

test("a grid too thin to measure is not reported as detected", async () => {
	// 4 squares per row x 2 rows, top-left light: each row has 2 dark
	// squares, so the 2x2 shape matches - but there is no second row-pair
	// to measure a y pitch from, which used to yield detected:true with a
	// NaN pitch and NaN mm/px scale
	const S = 40;
	const buf = await png(boardSvg(4, 2, S));
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 2,
		checkerboardRows: 2,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, false);
	assert.match(r.reason, /finite pitch/);
	assert.strictEqual(r.mmPerPixel, undefined);
});

test("measurePitch leaves a missing pitch undefined, not NaN", () => {
	const centroids = [
		[
			{ x: 10, y: 10 },
			{ x: 30, y: 10 },
		],
	];
	const { pitchXPx, pitchYPx } = measurePitch(centroids);
	assert.strictEqual(pitchXPx, 20);
	assert.strictEqual(pitchYPx, undefined);
});

test("a board rotated a few degrees is still detected (corner bridges must not merge squares)", async () => {
	// Same-colour squares touch diagonally at corners; resampling the
	// rotation smears those contacts into 1-2px bridges that 4-connected
	// labelling merges. Before the 1px-erosion fix this board failed with
	// "found only 21 candidate blob(s)" while a human reads it at a glance.
	const S = 40;
	const buf = await sharp(await png(boardSvg(8, 6, S)))
		.rotate(8, { background: "#ccc" })
		.png()
		.toBuffer();
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 4,
		checkerboardRows: 6,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, true, r.reason);
	// de-rotation leaves a sub-pixel residual, so the pitch is within a
	// hair of the exact two-square-width value - but the old wrong-angle
	// pick was ~0.3px off, which this tolerance catches
	assert.ok(Math.abs(r.pitchXPx - 2 * S) < 0.05, `pitchXPx ${r.pitchXPx}`);
	assert.ok(Math.abs(r.pitchYPx - 2 * S) < 0.05, `pitchYPx ${r.pitchYPx}`);
});

test("a board whose dark-square count does not match the config is refused", async () => {
	// the config counts dark squares per row: a 8x6 board has 4 dark per
	// row, so cols=2 must be refused as a shape mismatch, not silently
	// accepted with half the grid
	const buf = await png(boardSvg(8, 6, 40));
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 2,
		checkerboardRows: 6,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, false);
	assert.match(r.reason, /grid shape mismatch/);
});

/**
 * A board with an odd number of square columns cannot put the same number
 * of dark squares in every row - 17 columns gives 9 in the rows that start
 * dark and 8 in the rows that start light. The grid config counts the
 * longest row, and the rows are allowed to alternate below it.
 *
 * This is the shape of the rig's real calibration target (17x25 squares,
 * 213 dark), which the detector found in full and then refused on shape.
 */
test("an odd-column board is detected with rows alternating below the config", async () => {
	const S = 40;
	// top-left light, so row 0 is the short one (8 dark) and row 1 the long
	const buf = await png(boardSvg(17, 25, S));
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 9,
		checkerboardRows: 25,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, true, r.reason);
	assert.strictEqual(r.pitchXPx, 2 * S);
	assert.strictEqual(r.pitchYPx, 2 * S);
	assert.strictEqual(r.mmPerPixel, 10 / (2 * S));
});

test("an odd-column board is detected whichever colour its corner is", async () => {
	const S = 40;
	// top-left dark: row 0 is now the long one, so the alternation starts
	// on the other parity and the shape check has to accept both
	const buf = await png(boardSvg(17, 25, S, true));
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 9,
		checkerboardRows: 25,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, true, r.reason);
	assert.strictEqual(r.pitchXPx, 2 * S);
	assert.strictEqual(r.pitchYPx, 2 * S);
});

test("allowing alternating rows does not let a wrong column count through", async () => {
	// 12 physical columns is an even board: every row holds exactly 6 dark
	// squares, 36 in all - enough blobs to get past the count guard and
	// reach the shape check. cols=5 would need either a uniform 5 or rows
	// alternating 5/4, and a uniform 6 is neither, so the relaxation must
	// still refuse it rather than shrug at the extra square.
	const buf = await png(boardSvg(12, 6, 40));
	const r = await measureCheckerboard(buf, {
		checkerboardCols: 5,
		checkerboardRows: 6,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, false);
	assert.match(r.reason, /grid shape mismatch/);
});
