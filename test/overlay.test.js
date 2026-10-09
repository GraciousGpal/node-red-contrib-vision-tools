/**
 * The overlay stage: the one picture and the preview's thumbnail. Both
 * are built from the aligned grey and the checks' regions; what is
 * tested here is that the work is ordered so the two overlap, and that
 * the order never shows in the bytes.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { shutdown } = require("../lib/pool.js");

test.after(() => shutdown());

const W = 900;
const H = 1200;
function labelSvg(extra = "") {
	const bars = [];
	for (let i = 0; i < 10; i++) {
		bars.push(`<rect x="110" y="${80 + i * 100 + (i % 3) * 7}" width="${i % 2 ? 420 : 640}" height="26" fill="#111"/>`);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#111" stroke-width="8"/>` +
			bars.join("") +
			extra +
			`</svg>`,
	);
}

const CFG = {
	workingSize: H,
	threshold: 128,
	thresholdMode: "otsu",
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	inkMargin: 8,
	scaleSearchMin: 0.6,
	scaleSearchMax: 2.5,
	scaleSearchSteps: 37,
	alignCandidates: 5,
	workers: 4,
	localAlign: true,
	localAlignTile: 96,
	localAlignMax: 3,
	maxAspect: 0.06,
	aspectSteps: 7,
	maxAngleDeg: 2,
	angleSteps: 5,
	positionToleranceAngleDeg: 1,
	printTolerance: 2,
	backgroundTolerance: 1,
	edgeMargin: 0,
	alignSearch: 16,
	positionToleranceXPx: 16,
	positionToleranceYPx: 16,
	blockSize: 16,
	blockThreshold: 0.15,
	failThreshold: 0.3,
	failRatio: 0.002,
	printMissingFraction: 0.5,
	toneThreshold: 0.3,
	toneMargin: 6,
	speckThreshold: 0.3,
	speckMinArea: 3,
	speckMaxCount: 8,
	speckMaxArea: 48,
	outputHeatmap: true,
	heatmapFormat: "jpg",
	heatmapQuality: 85,
	thumbnailWidth: 120,
	debugStages: false,
};

test("the thumbnail's encode is asked for before the overlay is composed", async () => {
	const golden = await prepareGolden(await sharp(labelSvg()).png().toBuffer(), CFG);
	const frame = await sharp(labelSvg('<rect x="300" y="500" width="90" height="60" fill="#000"/>')).png().toBuffer();
	// the thumbnail encodes at quality 70, the overlay at heatmapQuality
	const qualities = [];
	const jpeg = sharp.prototype.jpeg;
	sharp.prototype.jpeg = function (options) {
		qualities.push(options && options.quality);
		return jpeg.call(this, options);
	};
	let result;
	try {
		result = await compareFrame(frame, golden, CFG);
	} finally {
		sharp.prototype.jpeg = jpeg;
	}
	assert.ok(result.heatmap && result.thumbnail, "both pictures rendered");
	assert.deepEqual(qualities, [70, 85], "the thumbnail first, then the overlay");
});

test("the overlay's canvas is the grey as RGB, built across turns of the loop", async () => {
	const { expandGray, OVERLAY_EXPAND_SLICE: S } = require("../lib/compare.js");
	for (const n of [1, 7, S - 1, S, S + 1, 3 * S + 5]) {
		const gray = new Uint8Array(n);
		for (let i = 0; i < n; i++) gray[i] = (i * 2654435761) >>> 24;
		const want = Buffer.alloc(n * 3);
		for (let i = 0; i < n; i++) want[i * 3] = want[i * 3 + 1] = want[i * 3 + 2] = gray[i];
		// how many turns of the loop pass while it builds
		let turns = 0;
		let counting = true;
		const tick = () => {
			if (!counting) return;
			turns++;
			setImmediate(tick);
		};
		setImmediate(tick);
		const got = await expandGray(gray, n);
		counting = false;
		assert.ok(want.equals(got), `${n} pixels`);
		const slices = Math.ceil(n / S);
		assert.ok(turns >= slices - 1, `${n} pixels: ${turns} turns for ${slices} slices`);
	}
});
