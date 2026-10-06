/**
 * frameBox maps a golden-space ground-truth box onto the frame capture()
 * made: the synthetic-defects preview draws it there, so an error here is
 * a box drawn beside the defect rather than around it.
 *
 * Checked against the pixels, not against the formula: one dark square on
 * a white raster is captured through a fixed-value preset at a visible
 * rotation and anisotropic magnification, the ink is found in the frame,
 * and its centroid and extent are compared to the mapped box.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { makePrng } = require("../lib/synth/prng.js");
const { capture, frameBox, toFrame } = require("../lib/synth/capture.js");

// a preset whose every range is a single value, so the only randomness
// left is the sign of the few-pixel offset, which the params report
const FIXED = {
	mag: [1.5, 1.5],
	stretch: [0.04, 0.04],
	angleDeg: [6, 6],
	ink: [40, 40],
	paper: [230, 230],
	tray: [120, 120],
	margin: [0.1, 0.1],
	offsetPx: [3, 3],
	gradient: [0, 0],
	vignette: [0, 0],
	blurSigma: [0.3, 0.3],
	noiseSigma: [0, 0],
	jpegQuality: null,
};

const W = 240;
const H = 200;
const SQUARE = { x: 150, y: 40, w: 10, h: 10 };

test("a box mapped through frameBox sits on the ink in the frame", async () => {
	const data = new Uint8Array(W * H).fill(255);
	for (let y = SQUARE.y; y < SQUARE.y + SQUARE.h; y++) {
		data.fill(0, y * W + SQUARE.x, y * W + SQUARE.x + SQUARE.w);
	}
	const shot = await capture({ data, width: W, height: H }, FIXED, makePrng(7));
	const { data: frame, info } = await sharp(shot.buffer)
		.removeAlpha()
		.toColourspace("b-w")
		.raw()
		.toBuffer({ resolveWithObject: true });
	assert.equal(info.channels, 1);
	assert.equal(info.width, shot.params.frameWidth);

	// the ink: well under the tray grey, so blur at the edge cannot leak in
	let n = 0, sx = 0, sy = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
	for (let y = 0; y < info.height; y++) {
		for (let x = 0; x < info.width; x++) {
			if (frame[y * info.width + x] >= 90) continue;
			n++; sx += x; sy += y;
			if (x < minX) minX = x; if (x > maxX) maxX = x;
			if (y < minY) minY = y; if (y > maxY) maxY = y;
		}
	}
	assert.ok(n > 150, `found ${n} ink pixels; expected the 10x10 square at 1.5x`);

	const corners = frameBox(SQUARE, shot.params, { width: W, height: H });
	assert.equal(corners.length, 4);
	const cx = corners.reduce((a, c) => a + c.x, 0) / 4;
	const cy = corners.reduce((a, c) => a + c.y, 0) / 4;
	assert.ok(Math.abs(cx - sx / n) < 1.5, `centre x ${cx} vs ink ${sx / n}`);
	assert.ok(Math.abs(cy - sy / n) < 1.5, `centre y ${cy} vs ink ${sy / n}`);
	// the parallelogram's extent brackets the ink's, to a pixel of blur
	const xs = corners.map((c) => c.x);
	const ys = corners.map((c) => c.y);
	assert.ok(Math.min(...xs) <= minX + 1.5 && Math.max(...xs) >= maxX - 1.5, `x extent ${Math.min(...xs)}..${Math.max(...xs)} vs ink ${minX}..${maxX}`);
	assert.ok(Math.min(...ys) <= minY + 1.5 && Math.max(...ys) >= maxY - 1.5, `y extent ${Math.min(...ys)}..${Math.max(...ys)} vs ink ${minY}..${maxY}`);
	// and it is rotated the way the frame is, not an upright box
	assert.ok(Math.abs(corners[1].y - corners[0].y) > 0.5, "top edge should slope at 6 degrees");
});

test("toFrame is the identity plus the placement when nothing is scaled or turned", () => {
	const out = toFrame([{ x: 10, y: 20 }], { mx: 1, my: 1, angleDeg: 0, dx: 5, dy: 7 }, { width: 100, height: 100 });
	assert.deepEqual(out, [{ x: 15, y: 27 }]);
});
