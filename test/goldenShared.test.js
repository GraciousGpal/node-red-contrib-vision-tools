/**
 * The prepared golden is read from worker threads on every frame, so its
 * buffers are allocated shared once rather than copied into shared memory
 * again per frame (~4ms at 4.9MP, to re-share something that has not
 * changed since it was cached).
 *
 * Asserted by walking the returned object rather than by naming fields, so
 * a golden that grows a new pixel buffer later is covered without anyone
 * remembering to come back here.
 *
 * The nullable case has its own test because it is the one that bites:
 * fgAmbiguous is null whenever inkMargin is 0, and toShared(null) throws.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { prepareGolden } = require("../lib/compare.js");
const { HAS_SAB } = require("../lib/shared.js");

const svg = (w, h) =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="30" y="40" width="${(w * 0.6) | 0}" height="${(h * 0.2) | 0}" fill="#111"/>` +
			// a ramp from ink to paper, so whatever level Otsu settles on, an
			// ambiguity band around it has pixels to mark when inkMargin is
			// non-zero - a single mid-grey would only sit inside the band by
			// luck of the tie-break between the spikes
			`<defs><linearGradient id="g"><stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>` +
			`<rect x="30" y="${(h * 0.5) | 0}" width="${(w * 0.5) | 0}" height="${(h * 0.2) | 0}" fill="url(#g)"/>` +
			`</svg>`,
	);

const cfg = (over = {}) => ({
	workingSize: 256,
	threshold: 128,
	thresholdMode: "otsu",
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	inkMargin: 8,
	backgroundTolerance: 1,
	debugStages: false,
	mmPerPixelNative: null,
	calibrationNativeWidth: null,
	calibrationNativeHeight: null,
	...over,
});

const pixelFields = (golden) =>
	Object.entries(golden).filter(
		([, v]) => v instanceof Uint8Array || v instanceof Float32Array,
	);

test("every pixel buffer on a prepared golden is shared", { skip: !HAS_SAB }, async () => {
	const golden = await prepareGolden(await sharp(svg(400, 600)).png().toBuffer(), cfg());
	const fields = pixelFields(golden);
	assert.ok(fields.length >= 4, `expected several pixel buffers, saw ${fields.length}`);
	for (const [name, buf] of fields) {
		assert.ok(
			buf.buffer instanceof SharedArrayBuffer,
			`golden.${name} is not shared - every frame will copy it again`,
		);
	}
});

test("inkMargin 0 leaves fgAmbiguous null rather than throwing", async () => {
	// toShared(null) throws; the guard has to be in prepareGolden, not in
	// the caller
	const golden = await prepareGolden(
		await sharp(svg(400, 600)).png().toBuffer(),
		cfg({ inkMargin: 0 }),
	);
	assert.strictEqual(golden.fgAmbiguous, null);
	// and the rest is still shared
	if (HAS_SAB) {
		assert.ok(golden.fg.buffer instanceof SharedArrayBuffer);
		assert.ok(golden.gray.buffer instanceof SharedArrayBuffer);
	}
});

test("an ambiguity band is still produced when inkMargin is set", async () => {
	const golden = await prepareGolden(
		await sharp(svg(400, 600)).png().toBuffer(),
		cfg({ inkMargin: 40 }),
	);
	assert.ok(golden.fgAmbiguous, "expected an ambiguity mask");
	let marked = 0;
	for (let i = 0; i < golden.fgAmbiguous.length; i++) {
		if (golden.fgAmbiguous[i]) marked++;
	}
	assert.ok(marked > 0, "the mid-grey panel should have marked some pixels");
});
