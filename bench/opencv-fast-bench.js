/**
 * Real-image benchmark for golden-compare's native alignment paths.
 *
 * Usage (paths are container defaults):
 *   node bench/opencv-fast-bench.js [golden.png] [frame.png] [iterations]
 */

"use strict";

const fs = require("node:fs");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { shutdown } = require("../lib/pool.js");

const goldenPath =
	process.argv[2] ||
	"/data/sample_images/Trained_13112025_143345_EXP281110_LOT51111T1.png";
const framePath =
	process.argv[3] || "/data/sample_images/13112025_003.png";
const iterations = Math.max(1, Number(process.argv[4] || 3));

const cfg = {
	workingSize: 2656,
	threshold: 128,
	thresholdMode: "otsu",
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	inkMargin: 64,
	scaleSearchMin: 0.6,
	scaleSearchMax: 2.5,
	scaleSearchSteps: 19,
	alignCandidates: 5,
	workers: 12,
	mismatchScore: 0.15,
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
	alignSearch: 16,
	positionToleranceXMm: 2,
	positionToleranceYMm: 2,
	positionToleranceXPx: 16,
	positionToleranceYPx: 16,
	blockSize: 8,
	blockThreshold: 0.15,
	failThreshold: 0.1,
	failRatio: 0.002,
	outputPrintHeatmap: false,
	outputBackgroundHeatmap: false,
	debugStages: false,
	mmPerPixelNative: null,
	calibrationNativeWidth: null,
	calibrationNativeHeight: null,
	pinnedScale: { mx: 1.9754614258976002, my: 1.9903145193254013 },
};

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
}

async function main() {
	const golden = await prepareGolden(fs.readFileSync(goldenPath), cfg);
	const frame = fs.readFileSync(framePath);
	const modes = [
		{ name: "js", cfg: {} },
		{ name: "opencv-seed", cfg: { nativeAlignSeed: true } },
		{ name: "opencv-full", cfg: { nativeFastAlign: true } },
	];
	const results = [];
	for (const mode of modes) {
		await compareFrame(frame, golden, { ...cfg, ...mode.cfg });
		const samples = [];
		let result;
		for (let i = 0; i < iterations; i++) {
			result = await compareFrame(frame, golden, { ...cfg, ...mode.cfg });
			samples.push(result.timings);
		}
		results.push({
			mode: mode.name,
			decodeMs: Math.round(median(samples.map((x) => x.decodeMs))),
			alignMs: Math.round(median(samples.map((x) => x.alignMs))),
			tableMs: Math.round(median(samples.map((x) => x.tableMs))),
			searchMs: Math.round(median(samples.map((x) => x.searchMs))),
			warpMs: Math.round(median(samples.map((x) => x.warpMs))),
			totalMs: Math.round(median(samples.map((x) => x.totalMs))),
			pass: result.pass,
			native: result.transform.native,
			score: Math.round(result.transform.score * 10000) / 10000,
			scale: Math.round(result.transform.scale * 10000) / 10000,
			stretch: Math.round(result.transform.stretchPercent * 100) / 100,
			angle: Math.round(result.transform.angleDeg * 100) / 100,
			fallback: result.transform.nativeFallback,
			transform: result.transform,
			printRatio: result.printBlemish.defectRatio,
			printRegions: result.printBlemish.regions.length,
			backgroundRatio: result.backgroundBlemish.defectRatio,
			backgroundRegions: result.backgroundBlemish.regions.length,
		});
	}
	console.table(results);
	console.log(JSON.stringify({ goldenPath, framePath, iterations, results }, null, 2));
	shutdown();
}

main().catch((err) => {
	console.error(err.stack || err);
	shutdown();
	process.exitCode = 1;
});
