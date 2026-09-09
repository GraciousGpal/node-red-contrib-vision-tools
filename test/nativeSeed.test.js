/**
 * The native seed is optional and must be invisible when it is absent.
 *
 * The engine it needs ships prebuilt binaries for a handful of platforms
 * and is not a dependency, so on most installs - including CI - these
 * exercise the fallback path rather than the seed itself. That is the
 * point: a flag whose failure mode is "silently different inspection"
 * would be worse than no flag.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const nativeSeed = require("../lib/nativeSeed.js");

const CFG = {
	workingSize: 512,
	threshold: 128,
	thresholdMode: "fixed",
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	inkMargin: 8,
	scaleSearchMin: 0.6,
	scaleSearchMax: 2.5,
	scaleSearchSteps: 9,
	alignCandidates: 3,
	workers: 1,
	mismatchScore: 0.15,
	localAlign: false,
	maxAspect: 0.06,
	aspectSteps: 5,
	maxAngleDeg: 2,
	angleSteps: 3,
	positionToleranceAngleDeg: 1,
	printTolerance: 2,
	backgroundTolerance: 1,
	alignSearch: 16,
	positionToleranceXMm: 2,
	positionToleranceYMm: 2,
	positionToleranceXPx: 32,
	positionToleranceYPx: 32,
	blockSize: 8,
	blockThreshold: 0.15,
	failThreshold: 0.3,
	failRatio: 0.01,
	outputPrintHeatmap: false,
	outputBackgroundHeatmap: false,
	debugStages: false,
	mmPerPixelNative: null,
	calibrationNativeWidth: null,
	calibrationNativeHeight: null,
};

const svg = (w, h) =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="${w * 0.2}" y="${h * 0.15}" width="${w * 0.6}" height="${h * 0.05}" fill="#111"/>` +
			`<rect x="${w * 0.25}" y="${h * 0.4}" width="${w * 0.4}" height="${h * 0.05}" fill="#111"/>` +
			`<circle cx="${w * 0.6}" cy="${h * 0.75}" r="${h * 0.08}" fill="#111"/>` +
			`</svg>`,
	);

test("available() answers without throwing when the engine is absent", () => {
	assert.strictEqual(typeof nativeSeed.available(), "boolean");
});

test("seedTransform returns null rather than throwing without the engine", async (t) => {
	if (nativeSeed.available()) return t.skip("engine installed - fallback not exercised");
	const gray = new Uint8Array(64 * 64);
	assert.strictEqual(
		await nativeSeed.seedTransform(gray, 64, 64, gray, 64, 64),
		null,
	);
});

test("alignFrame returns OpenCV's aligned canvas and target-space transform", async () => {
	let call;
	nativeSeed._setEngine({
		async imageAlign(...args) {
			call = args;
			const reference = args[0];
			return {
				success: true,
				image: {
					data: Buffer.from(reference.data),
					width: reference.width,
					height: reference.height,
					channels: 1,
				},
				transformMatrix: { matrix2x3: [1, 0, 3, 0, 1, 4] },
				timing: { taskMs: 2 },
			};
		},
	});
	try {
		const golden = new Uint8Array(10 * 20);
		const target = new Uint8Array(20 * 40);
		const out = await nativeSeed.alignFrame(golden, 10, 20, target, 20, 40);
		assert.ok(out);
		assert.strictEqual(out.gray.length, golden.length);
		assert.strictEqual(out.transform.mx, 2);
		assert.strictEqual(out.transform.my, 2);
		assert.strictEqual(out.transform.ox, 6);
		assert.strictEqual(out.transform.oy, 8);
		assert.strictEqual(call[2], nativeSeed.FAST_ALIGN_SCALE);
		assert.strictEqual(call[10], "affine");
	} finally {
		nativeSeed._resetEngine();
	}
});

test("native alignment rejects geometry outside the configured search", () => {
	const pin = { mx: 2, my: 2.02 };
	assert.strictEqual(
		nativeSeed.validateAlignment(
			{ mx: 1.96, my: 2.06, theta: 0.01 },
			pin,
			2,
		),
		null,
	);
	assert.match(
		nativeSeed.validateAlignment(
			{ mx: 1.85, my: 2.06, theta: 0.01 },
			pin,
			2,
		),
		/scale drift/,
	);
	assert.match(
		nativeSeed.validateAlignment(
			{ mx: 2, my: 2.02, theta: (3 * Math.PI) / 180 },
			pin,
			2,
		),
		/angle/,
	);
});

test("the fast native path bypasses JS search and warp", async () => {
	nativeSeed._setEngine({
		async imageAlign(reference) {
			return {
				success: true,
				image: {
					data: Buffer.from(reference.data),
					width: reference.width,
					height: reference.height,
					channels: 1,
				},
				transformMatrix: { matrix2x3: [1, 0, 0, 0, 1, 0] },
			};
		},
	});
	try {
		const goldenBuf = await sharp(svg(400, 560)).png().toBuffer();
		const golden = await prepareGolden(goldenBuf, CFG);
		const result = await compareFrame(goldenBuf, golden, {
			...CFG,
			nativeFastAlign: true,
		});
		assert.strictEqual(result.transform.native, true);
		assert.strictEqual(result.transform.seeded, false);
		assert.strictEqual(result.timings.tableMs, 0);
		assert.strictEqual(result.timings.warpMs, 0);
		assert.strictEqual(result.transform.score, 0);
	} finally {
		nativeSeed._resetEngine();
	}
});

test("a poor native score falls back to the JS alignment", async () => {
	nativeSeed._setEngine({
		async imageAlign(reference) {
			const inverted = Buffer.alloc(reference.data.length);
			for (let i = 0; i < inverted.length; i++) {
				inverted[i] = 255 - reference.data[i];
			}
			return {
				success: true,
				image: {
					data: inverted,
					width: reference.width,
					height: reference.height,
					channels: 1,
				},
				transformMatrix: { matrix2x3: [1, 0, 0, 0, 1, 0] },
			};
		},
	});
	try {
		const goldenBuf = await sharp(svg(400, 560)).png().toBuffer();
		const golden = await prepareGolden(goldenBuf, CFG);
		const result = await compareFrame(goldenBuf, golden, {
			...CFG,
			pinnedScale: { mx: 1, my: 1 },
			nativeFastAlign: true,
		});
		assert.strictEqual(result.transform.native, false);
		assert.match(result.transform.nativeFallback, /OpenCV score/);
		assert.strictEqual(result.transform.score, 0);
	} finally {
		nativeSeed._resetEngine();
	}
});

test("the flag changes nothing when the engine is unavailable", async (t) => {
	if (nativeSeed.available()) return t.skip("engine installed - fallback not exercised");
	const goldenBuf = await sharp(svg(400, 560)).png().toBuffer();
	const frameBuf = await sharp(svg(400, 560)).resize(520, 728).png().toBuffer();
	const golden = await prepareGolden(goldenBuf, CFG);
	const pinnedScale = { mx: 1.3, my: 1.3 };
	const off = await compareFrame(frameBuf, golden, { ...CFG, pinnedScale });
	const on = await compareFrame(frameBuf, golden, {
		...CFG,
		pinnedScale,
		nativeAlignSeed: true,
	});
	assert.strictEqual(on.transform.seeded, false, "reported seeded without an engine");
	assert.strictEqual(on.transform.scaleX, off.transform.scaleX);
	assert.strictEqual(on.transform.scaleY, off.transform.scaleY);
	assert.strictEqual(on.transform.ox, off.transform.ox);
	assert.strictEqual(on.transform.oy, off.transform.oy);
	assert.strictEqual(on.transform.score, off.transform.score);
	assert.strictEqual(on.pass, off.pass);
});

/**
 * OpenCV's warp has no border-value parameter to pass through, and its
 * constant fill is 0 - the darkest possible ink. Wherever the golden's canvas
 * reaches past the edge of the frame, that fill used to land in the background
 * check as a solid full-density bar of ink the part does not have, failing
 * every good frame whose label is not wholly inside the shot. lib/warp.js fills
 * the same region with 255 on the JS path for exactly that reason, and the two
 * alignment paths have to agree about what an uncovered pixel means.
 */
test("the native path blanks pixels that fall outside the frame", async () => {
	// imageAlign normalises the target to the reference dimensions, so this
	// matrix decodes to mx=0.8, my=1, ox=2.4, oy=-2: the golden's top two rows
	// map above the frame and its last two columns run off the right of it.
	nativeSeed._setEngine({
		async imageAlign(reference) {
			return {
				success: true,
				image: {
					data: Buffer.alloc(reference.width * reference.height, 0),
					width: reference.width,
					height: reference.height,
					channels: 1,
				},
				transformMatrix: { matrix2x3: [1, 0, 3, 0, 1, -2] },
			};
		},
	});
	try {
		const gW = 10;
		const gH = 8;
		const tW = 8;
		const tH = 8;
		const out = await nativeSeed.alignFrame(
			new Uint8Array(gW * gH),
			gW,
			gH,
			new Uint8Array(tW * tH),
			tW,
			tH,
		);
		assert.ok(out);
		const at = (x, y) => out.gray[y * gW + x];

		// Above the frame, and past its right edge: blank substrate, not black.
		assert.strictEqual(at(5, 0), 255, "row above the frame");
		assert.strictEqual(at(5, 1), 255, "row above the frame");
		assert.strictEqual(at(8, 4), 255, "column right of the frame");
		assert.strictEqual(at(9, 4), 255, "column right of the frame");

		// Inside the frame OpenCV's pixels are handed through untouched.
		assert.strictEqual(at(0, 2), 0, "covered pixel keeps its value");
		assert.strictEqual(at(6, 7), 0, "covered pixel keeps its value");
	} finally {
		nativeSeed._resetEngine();
	}
});
