/**
 * The loop closed end to end: frames from the synthetic generator, through
 * prepareGolden / compareFrame pinned the way the example flow runs, and
 * scored by the benchmark's own rule - a fail counts as a detection only
 * when a region in a channel the defect may appear in overlaps the
 * defect's ground-truth box. A verdict that fails somewhere else on the
 * label is `wrong-place` and fails this test, exactly as it fails recall.
 *
 * The node tests check the messages and the compare tests check the
 * verdicts on hand-drawn fixtures; nothing else asserts that the region
 * golden-compare reports is where the generator put the defect. This runs
 * the families the method is known to see (solid ink marks, dropped
 * glyphs) at medium and large size on a small golden, so it is a guard
 * against the region landing beside the defect, not a recall measurement
 * - that is bench/synth/run.js's job.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { planCases, makeCases, goldenRaster } = require("../lib/synth/cases.js");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const score = require("../bench/synth/score.js");

const W = 600;
const H = 840;

// the example flow's settings at this golden's native size, pictures off
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
	workers: 1,
	mismatchScore: 0.15,
	minCoverage: 0.5,
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
	positionToleranceXMm: 2,
	positionToleranceYMm: 2,
	positionToleranceXPx: 16,
	positionToleranceYPx: 16,
	blockSize: 16,
	blockThreshold: 0.15,
	failThreshold: 0.1,
	failRatio: 0.002,
	printMissingFraction: 0.5,
	toneThreshold: 0.3,
	toneMargin: 6,
	speckThreshold: 0.3,
	speckMinArea: 3,
	speckMaxCount: 8,
	speckMaxArea: 48,
	outputHeatmap: false,
	outputPrintHeatmap: false,
	outputBackgroundHeatmap: false,
	outputToneHeatmap: false,
	outputSpeckHeatmap: false,
	debugStages: false,
};

test("every fail golden-compare raises on a synthetic frame lands on the defect the generator painted", async () => {
	const raster = await goldenRaster(null, { width: W, height: H, seed: 1 });
	const goldenPng = await sharp(raster.data, { raw: { width: W, height: H, channels: 1 } })
		.png()
		.toBuffer();
	const plan = planCases({
		perVariant: 1,
		preset: "typical",
		families: ["mark", "misprint"],
		variants: ["ink", "dropout"],
		severities: ["medium", "large"],
	});
	const cases = [];
	for await (const c of makeCases({ raster, seed: 1, plan, rig: true })) cases.push(c);
	assert.equal(cases.filter((c) => c.family !== "clean").length, 4);
	assert.ok(cases.some((c) => c.family === "clean"));

	const golden = await prepareGolden(goldenPng, { ...CFG });
	const ctx = { scaleX: golden.width / W, scaleY: golden.height / H, blockSize: CFG.blockSize };

	// pinned the way the flow is: trained once on a clean frame of the run
	// preset, every other frame solved for placement and angle only
	const trainer = cases.find((c) => c.family === "clean" && c.preset === "typical");
	const trained = await compareFrame(trainer.buffer, golden, { ...CFG });
	assert.ok(Math.abs(trained.transform.scaleX - cases[0].rig.mx) < 0.03, `trained mx ${trained.transform.scaleX} vs rig ${cases[0].rig.mx}`);
	const cfg = {
		...CFG,
		pinnedScale: { mx: trained.transform.scaleX, my: trained.transform.scaleY },
	};

	for (const c of cases) {
		const result = await compareFrame(c.buffer, golden, { ...cfg });
		const record = score.classifyCase(c, result, ctx);
		const where = JSON.stringify({
			failed: record.failedParts,
			regions: {
				print: result.printBlemish.regions.map((r) => [r.x, r.y, r.w, r.h]),
				background: result.backgroundBlemish.regions.map((r) => [r.x, r.y, r.w, r.h]),
			},
			box: record.defects && record.defects[0] && record.defects[0].box,
		});
		if (c.family === "clean") {
			// the harsh preset's two clean frames are a thresholding stress
			// test, not a location one; typical and clean-rig must pass
			if (c.preset !== "harsh") {
				assert.equal(record.verdict, "correct-pass", `${c.id} ${where}`);
			}
		} else {
			assert.equal(record.verdict, "detected", `${c.id}: ${record.verdict} ${where}`);
			assert.ok(record.hit, `${c.id} has no overlapping region`);
		}
	}
});
