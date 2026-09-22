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
const { boardSvg } = require("./helpers/synthetic.js");

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
	const buf = await png(boardSvg(17, 25, S, { darkFirst: true }));
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

// ---- perspective ---------------------------------------------------------

const { warpPerspective } = require("../lib/rectify.js");
const { fitHomography } = require("../lib/homography.js");

const rawPng = (r) =>
	sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), {
		raw: { width: r.width, height: r.height, channels: r.channels },
	})
		.png()
		.toBuffer();

const CFG = { checkerboardCols: 4, checkerboardRows: 6, targetPitchMm: 10 };

test("a square-on board measures no perspective and an identity homography", async () => {
	const r = await measureCheckerboard(await png(boardSvg(8, 6, 40, { margin: 60 })), CFG);
	assert.strictEqual(r.detected, true, r.reason);
	const p = r.perspective;
	assert.ok(p.rmsBeforePx < 0.01, `rmsBefore ${p.rmsBeforePx}`);
	assert.ok(p.rmsAfterPx < 0.01, `rmsAfter ${p.rmsAfterPx}`);
	assert.ok(p.maxCornerShiftPx < 0.01, `corner shift ${p.maxCornerShiftPx}`);
	assert.strictEqual(p.points, 24);
	const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	p.homography.forEach((v, i) =>
		assert.ok(Math.abs(v - I[i]) < 1e-6, `H[${i}] = ${v}`),
	);
	assert.strictEqual(p.homography[8], 1);
});

test("a keystoned board is measured, and its homography flattens it", async () => {
	const { data, info } = await sharp(boardSvg(8, 6, 40, { margin: 80 }))
		.raw()
		.toBuffer({ resolveWithObject: true });
	const flat = { data, width: info.width, height: info.height, channels: info.channels };
	const W = info.width;
	const Hh = info.height;
	// the camera looks up at the board: the top edge appears 12% narrower
	const truth = fitHomography(
		[{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hh }, { x: 0, y: Hh }],
		[{ x: W * 0.06, y: 0 }, { x: W * 0.94, y: 0 }, { x: W, y: Hh }, { x: 0, y: Hh }],
	);
	const photo = warpPerspective(flat, truth);

	const r = await measureCheckerboard(await rawPng(photo), CFG);
	assert.strictEqual(r.detected, true, r.reason);
	const p = r.perspective;
	// several pixels of keystone across a 480px board, explained to a
	// fraction of a pixel by the homography
	assert.ok(p.rmsBeforePx > 2, `rmsBefore ${p.rmsBeforePx}`);
	assert.ok(p.maxBeforePx > 4, `maxBefore ${p.maxBeforePx}`);
	assert.ok(p.rmsAfterPx < 0.3, `rmsAfter ${p.rmsAfterPx}`);
	assert.ok(p.maxAfterPx < 0.5, `maxAfter ${p.maxAfterPx}`);
	assert.ok(p.maxCornerShiftPx > 10, `corner shift ${p.maxCornerShiftPx}`);
	assert.ok(Math.abs(p.boardAngleDeg) < 0.5, `angle ${p.boardAngleDeg}`);

	// the acceptance test: rectify the photo with what was measured and
	// measure again - the board must now read as square-on
	const rectified = warpPerspective(photo, p.homography);
	const r2 = await measureCheckerboard(await rawPng(rectified), CFG);
	assert.strictEqual(r2.detected, true, r2.reason);
	assert.ok(r2.perspective.rmsBeforePx < 0.4, `rmsBefore after rectify ${r2.perspective.rmsBeforePx}`);
	assert.ok(r2.perspective.maxBeforePx < 0.6, `maxBefore after rectify ${r2.perspective.maxBeforePx}`);
	// The keystone also pulled the two pitches apart (the top edge is
	// narrower, so the median x pitch shrinks). That part is deliberately
	// NOT corrected: one photo cannot tell a keystone's apparent aspect
	// from a rectangular print, and aspect is scale, which golden-compare's
	// independent mx/my absorb - see the rectangular-cell test below.
});

test("a rotated board leaves the rotation out of the homography", async () => {
	// the operator laid the board 4 degrees off: that is placement, not
	// camera geometry, and the homography must not undo it - production
	// frames would otherwise be rotated for no reason
	const { data, info } = await sharp(boardSvg(8, 6, 40, { margin: 80 }))
		.rotate(4, { background: "#fff" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const r = await measureCheckerboard(
		await rawPng({ data, width: info.width, height: info.height, channels: info.channels }),
		CFG,
	);
	assert.strictEqual(r.detected, true, r.reason);
	const p = r.perspective;
	assert.ok(Math.abs(Math.abs(p.boardAngleDeg) - 4) < 0.3, `angle ${p.boardAngleDeg}`);
	// rotation-free: the linear part is close to the identity, and the
	// frame corners barely move
	assert.ok(Math.abs(p.homography[0] - 1) < 0.01, `H[0] ${p.homography[0]}`);
	assert.ok(Math.abs(p.homography[1]) < 0.01, `H[1] ${p.homography[1]}`);
	assert.ok(p.maxCornerShiftPx < 3, `corner shift ${p.maxCornerShiftPx}`);
	assert.ok(p.rmsBeforePx < 0.5, `rmsBefore ${p.rmsBeforePx}`);
});

test("measurePerspective handles an odd-column board's alternating rows", async () => {
	// 9 physical columns, top-left light: rows alternate 4 and 5 dark
	// squares, so the lattice must place each row on its own half-pitch
	// offset or the fit sees a 40px "perspective" that is not there
	const r = await measureCheckerboard(await png(boardSvg(9, 6, 40, { margin: 60 })), {
		checkerboardCols: 5,
		checkerboardRows: 6,
		targetPitchMm: 10,
	});
	assert.strictEqual(r.detected, true, r.reason);
	assert.strictEqual(r.perspective.points, 27);
	assert.ok(r.perspective.rmsBeforePx < 0.01, `rmsBefore ${r.perspective.rmsBeforePx}`);
});

test("a board with rectangular cells is aspect, not perspective: the homography stays the identity", async () => {
	// The first real rig this ran on measured pitchY/pitchX = 0.855. A
	// square lattice turned that into a 10% anisotropic scale in the
	// homography - 46px rms of "keystone" - and rectifying with it would
	// have stretched every frame. Aspect is scale and is left alone.
	const { data, info } = await sharp(boardSvg(8, 6, 40, { margin: 60 }))
		.resize({ width: 440, height: Math.round(360 * 0.85), fit: "fill" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const r = await measureCheckerboard(
		await rawPng({ data, width: info.width, height: info.height, channels: info.channels }),
		CFG,
	);
	assert.strictEqual(r.detected, true, r.reason);
	assert.ok(Math.abs(r.pitchYPx / r.pitchXPx - 0.85) < 0.01, `ratio ${r.pitchYPx / r.pitchXPx}`);
	const p = r.perspective;
	assert.ok(p.rmsBeforePx < 0.3, `rmsBefore ${p.rmsBeforePx}`);
	assert.ok(Math.abs(p.homography[0] - 1) < 0.005, `H[0] ${p.homography[0]}`);
	assert.ok(Math.abs(p.homography[4] - 1) < 0.005, `H[4] ${p.homography[4]}`);
	assert.ok(p.maxCornerShiftPx < 1, `corner shift ${p.maxCornerShiftPx}`);
});
