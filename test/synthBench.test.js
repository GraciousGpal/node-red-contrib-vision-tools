/**
 * The synthetic-defect benchmark's scoring, tested against hand-built
 * manifests and hand-built results.
 *
 * Almost none of this touches an image. The rules in bench/synth/score.js
 * are where a benchmark quietly becomes dishonest - a padded box one
 * block too generous, or a fail in the wrong channel counted as a
 * detection, would flatter every number the report prints - so they are
 * pinned here with results written by hand, where the right answer is
 * known exactly rather than argued from a picture.
 *
 * One end-to-end case at the bottom checks the wiring instead: that a
 * real manifest, a real golden and two real frames come back through
 * runSet() with the verdicts they should. It runs at workingSize 320 on a
 * 300x420 label so the whole file stays a few seconds.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const score = require("../bench/synth/score.js");
const { runSet } = require("../bench/synth/run.js");
const { shutdown } = require("../lib/pool.js");

test.after(() => shutdown());

// Half-size working image, blockSize 16 - the padding is then visibly
// bigger than anything rounding could contribute.
const CTX = { scaleX: 0.5, scaleY: 0.5, blockSize: 16 };

function fakeResult(over) {
	return {
		pass: true,
		match: { grade: "good", score: 0.01, mismatchSuspected: false, reason: null },
		position: { pass: true, dxPx: 0, dyPx: 0, angleDeg: 0 },
		printBlemish: { pass: true, defectRatio: 0, regions: [] },
		backgroundBlemish: { pass: true, defectRatio: 0, regions: [] },
		timings: { totalMs: 10, alignMs: 5 },
		...over,
	};
}

function region(x, y, w, h) {
	return { x, y, w, h, density: 0.9, avgDensity: 0.7, cells: 4 };
}

function defectCase(id, over) {
	return {
		id,
		family: "mark",
		frame: `frames/${id}.png`,
		defects: [
			{
				type: "mark",
				variant: "solid",
				severity: "small",
				channel: "print",
				bbox: { x: 100, y: 100, w: 40, h: 40 },
				printPixels: 1600,
				backgroundPixels: 0,
			},
		],
		expected: { pass: false, channels: ["print"] },
		...over,
	};
}

const failing = (over) =>
	fakeResult({ pass: false, printBlemish: { pass: false, defectRatio: 0.01, regions: [] }, ...over });

test("scaleBox scales per axis and pads by one block on every side", () => {
	const box = score.scaleBox({ x: 100, y: 200, w: 50, h: 60 }, 0.5, 0.25, 16);
	assert.strictEqual(box.x, 100 * 0.5 - 16);
	assert.strictEqual(box.y, 200 * 0.25 - 16);
	assert.strictEqual(box.w, 50 * 0.5 + 32);
	assert.strictEqual(box.h, 60 * 0.25 + 32);
});

test("a region inside the padded box is a detection, one outside it is not", () => {
	// bbox 100,100 40x40 native -> 50,50 20x20 working -> padded 34,34 52x52,
	// so the padded box spans [34,86).
	const inside = score.classifyCase(
		defectCase("mark-in"),
		failing({
			printBlemish: { pass: false, defectRatio: 0.01, regions: [region(80, 80, 4, 4)] },
		}),
		CTX,
	);
	assert.strictEqual(inside.verdict, "detected");
	assert.strictEqual(inside.hit.channel, "print");
	assert.strictEqual(inside.hit.density, 0.9);

	const outside = score.classifyCase(
		defectCase("mark-out"),
		failing({
			printBlemish: { pass: false, defectRatio: 0.01, regions: [region(90, 90, 4, 4)] },
		}),
		CTX,
	);
	assert.strictEqual(outside.verdict, "wrong-place");
	assert.strictEqual(outside.hit, null);
});

test("a fail with the region in the wrong channel is wrong-place, not detected", () => {
	const r = score.classifyCase(
		defectCase("mark-wrongchan"),
		failing({
			printBlemish: { pass: true, defectRatio: 0, regions: [] },
			backgroundBlemish: {
				pass: false,
				defectRatio: 0.01,
				// exactly where the defect is - but the defect is a print one
				regions: [region(60, 60, 8, 8)],
			},
		}),
		CTX,
	);
	assert.strictEqual(r.verdict, "wrong-place");
	assert.deepStrictEqual(r.failedParts, ["background"]);
});

test("a fail that is only the position check is wrong-place", () => {
	const r = score.classifyCase(
		defectCase("mark-position"),
		fakeResult({ pass: false, position: { pass: false, dxPx: 40, dyPx: 0, angleDeg: 0 } }),
		CTX,
	);
	assert.strictEqual(r.verdict, "wrong-place");
	assert.deepStrictEqual(r.failedParts, ["position"]);
});

test("a passing result on a defect case is a miss", () => {
	const r = score.classifyCase(defectCase("mark-miss"), fakeResult({}), CTX);
	assert.strictEqual(r.verdict, "missed");
	assert.strictEqual(r.defectPixels, 1600);
});

test('a channel "none" defect is scored like a clean case', () => {
	const caseDef = defectCase("mark-none", {
		defects: [
			{
				type: "mark",
				variant: "faint",
				severity: "tiny",
				channel: "none",
				bbox: { x: 0, y: 0, w: 0, h: 0 },
				printPixels: 0,
				backgroundPixels: 0,
			},
		],
		expected: { pass: true, channels: [] },
	});
	assert.strictEqual(score.expectsPass(caseDef), true);
	assert.strictEqual(score.classifyCase(caseDef, fakeResult({}), CTX).verdict, "correct-pass");

	const ff = score.classifyCase(
		caseDef,
		failing({
			printBlemish: { pass: false, defectRatio: 0.02, regions: [region(0, 0, 32, 48)] },
		}),
		CTX,
	);
	assert.strictEqual(ff.verdict, "false-fail");
	assert.deepStrictEqual(ff.failedParts, ["print"]);
	assert.strictEqual(ff.largestRegion.channel, "print");
	assert.strictEqual(ff.largestRegion.w, 32);
});

test('a "both" defect is accepted in either channel', () => {
	const caseDef = defectCase("mark-both", {
		defects: [
			{
				type: "mark",
				variant: "solid",
				severity: "small",
				channel: "both",
				bbox: { x: 100, y: 100, w: 40, h: 40 },
				printPixels: 800,
				backgroundPixels: 800,
			},
		],
		expected: { pass: false, channels: ["print", "background"] },
	});
	assert.deepStrictEqual(score.defectChannels(caseDef.defects[0]), ["print", "background"]);

	const viaPrint = score.classifyCase(
		caseDef,
		failing({ printBlemish: { pass: false, defectRatio: 0.01, regions: [region(60, 60, 8, 8)] } }),
		CTX,
	);
	assert.strictEqual(viaPrint.verdict, "detected");
	assert.strictEqual(viaPrint.hit.channel, "print");

	const viaBackground = score.classifyCase(
		caseDef,
		failing({
			printBlemish: { pass: true, defectRatio: 0, regions: [] },
			backgroundBlemish: { pass: false, defectRatio: 0.01, regions: [region(60, 60, 8, 8)] },
		}),
		CTX,
	);
	assert.strictEqual(viaBackground.verdict, "detected");
	assert.strictEqual(viaBackground.hit.channel, "background");
});

test("a clean case that passes is correct, and one that fails is a false fail", () => {
	const clean = {
		id: "clean-0001",
		family: "clean",
		frame: "frames/clean-0001.png",
		defects: [],
		expected: { pass: true, channels: [] },
	};
	assert.strictEqual(score.classifyCase(clean, fakeResult({}), CTX).verdict, "correct-pass");
	const ff = score.classifyCase(
		clean,
		fakeResult({ pass: false, position: { pass: false, dxPx: 99, dyPx: 1, angleDeg: 0 } }),
		CTX,
	);
	assert.strictEqual(ff.verdict, "false-fail");
	assert.strictEqual(ff.dxPx, 99);
});

test("aggregation counts every bucket and computes recall over all defect cases", () => {
	const hit = failing({
		printBlemish: { pass: false, defectRatio: 0.01, regions: [region(60, 60, 8, 8)] },
	});
	const elsewhere = failing({
		printBlemish: { pass: false, defectRatio: 0.01, regions: [region(400, 400, 8, 8)] },
	});
	const records = [
		score.classifyCase(defectCase("a"), hit, CTX),
		score.classifyCase(defectCase("b"), hit, CTX),
		score.classifyCase(defectCase("c"), fakeResult({}), CTX), // miss
		score.classifyCase(defectCase("d"), elsewhere, CTX), // wrong place
		score.classifyCase(
			{ id: "scratch-e", family: "scratch", defects: [], expected: { pass: true, channels: [] } },
			fakeResult({}),
			CTX,
		),
		score.classifyCase(
			{ id: "clean-f", family: "clean", defects: [], expected: { pass: true, channels: [] } },
			failing({}),
			CTX,
		),
	];
	for (const r of records) r.timings = { totalMs: 100, alignMs: 60 };

	const s = score.aggregate(records);
	assert.strictEqual(s.overall.cases, 6);
	assert.strictEqual(s.overall.defectCases, 4);
	assert.strictEqual(s.overall.passCases, 2);
	assert.strictEqual(s.overall.detected, 2);
	assert.strictEqual(s.overall.missed, 1);
	assert.strictEqual(s.overall.wrongPlace, 1);
	assert.strictEqual(s.overall.recall, 0.5);
	assert.strictEqual(s.overall.falseFails, 1);
	assert.strictEqual(s.overall.falseFailRate, 0.5);

	assert.deepStrictEqual(s.byFamily.mark, {
		total: 4,
		detected: 2,
		missed: 1,
		wrongPlace: 1,
		recall: 0.5,
	});
	assert.strictEqual(s.byFamilyVariant["mark/solid"].total, 4);
	assert.strictEqual(s.bySeverity.small.total, 4);
	assert.strictEqual(s.byChannel.print.total, 4);
	assert.strictEqual(s.falseFails.length, 1);
	assert.strictEqual(s.falseFails[0].id, "clean-f");
	assert.strictEqual(s.problems.length, 2);
	assert.deepStrictEqual(
		s.problems.map((p) => p.verdict).sort(),
		["missed", "wrong-place"],
	);
	// c and e are the two results that passed; the other four failed
	assert.strictEqual(s.timings.pass.count, 2);
	assert.strictEqual(s.timings.fail.count, 4);
	assert.strictEqual(s.timings.pass.totalMs.p50, 100);
	assert.strictEqual(s.alignment.goodGradeRate, 1);
	assert.strictEqual(s.alignment.mismatchSuspected, 0);
});

test("percentile picks a real sample and never interpolates", () => {
	const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
	assert.strictEqual(score.percentile(xs, 50), 50);
	assert.strictEqual(score.percentile(xs, 90), 90);
	assert.strictEqual(score.percentile([], 50), null);
});

test("sweepTable has one row per value with recall and false-fail rate", () => {
	const summaries = [0.1, 0.15].map((v) => ({
		value: v,
		summary: score.aggregate([
			score.classifyCase(
				defectCase(`s-${v}`),
				failing({
					printBlemish: { pass: false, defectRatio: 0.01, regions: [region(60, 60, 8, 8)] },
				}),
				CTX,
			),
			score.classifyCase(
				{ id: `clean-${v}`, family: "clean", defects: [], expected: { pass: true, channels: [] } },
				fakeResult({}),
				CTX,
			),
		]),
	}));
	const table = score.sweepTable("blockThreshold", summaries);
	assert.strictEqual(table.key, "blockThreshold");
	assert.strictEqual(table.rows.length, 2);
	assert.deepStrictEqual(Object.keys(table.rows[0]).sort(), [
		"cases",
		"detected",
		"falseFailRate",
		"falseFails",
		"missed",
		"recall",
		"value",
		"wrongPlace",
	]);
	assert.strictEqual(table.rows[0].value, 0.1);
	assert.strictEqual(table.rows[0].recall, 1);
	assert.strictEqual(table.rows[0].falseFailRate, 0);
});

// --- end to end -----------------------------------------------------------

const GOLDEN_W = 300;
const GOLDEN_H = 420;
// Thick bars, so erasing a 40x40 square removes a solid block of ink that
// survives printTolerance's dilation with room to spare.
const BAR_Y = [30, 94, 158, 222, 286, 350];

function labelSvg() {
	const bars = BAR_Y.map(
		(y) => `<rect x="20" y="${y}" width="260" height="40" fill="#111"/>`,
	).join("");
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${GOLDEN_W}" height="${GOLDEN_H}">` +
			`<rect width="100%" height="100%" fill="#fff"/>${bars}</svg>`,
	);
}

test("runSet scores a real clean frame and a real erased-ink frame", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-run-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, "frames"));

	const label = await sharp(labelSvg()).png().toBuffer();
	fs.writeFileSync(path.join(dir, "golden.png"), label);
	fs.writeFileSync(path.join(dir, "frames", "clean-0001.png"), label);

	// 40x40 of paper over the second bar: ink the golden has and the frame
	// does not, which is exactly the print check's definition.
	const bbox = { x: 60, y: BAR_Y[1], w: 40, h: 40 };
	const patch = await sharp({
		create: { width: bbox.w, height: bbox.h, channels: 3, background: "#fff" },
	})
		.png()
		.toBuffer();
	fs.writeFileSync(
		path.join(dir, "frames", "mark-0001.png"),
		await sharp(label)
			.composite([{ input: patch, left: bbox.x, top: bbox.y }])
			.png()
			.toBuffer(),
	);

	const capture = {
		mx: 1,
		my: 1,
		angleDeg: 0,
		dx: 0,
		dy: 0,
		ink: 17,
		paper: 255,
		gradient: 0,
		blurSigma: 0,
		noiseSigma: 0,
		jpegQuality: null,
		frameWidth: GOLDEN_W,
		frameHeight: GOLDEN_H,
	};
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify({
			version: 1,
			seed: 1,
			preset: "unit",
			golden: { path: "golden.png", width: GOLDEN_W, height: GOLDEN_H, source: "synthetic" },
			cases: [
				{
					id: "clean-0001",
					family: "clean",
					frame: "frames/clean-0001.png",
					capture,
					defects: [],
					expected: { pass: true, channels: [] },
				},
				{
					id: "mark-solid-medium-0001",
					family: "mark",
					frame: "frames/mark-0001.png",
					capture,
					defects: [
						{
							type: "mark",
							variant: "solid",
							severity: "medium",
							channel: "print",
							bbox,
							printPixels: bbox.w * bbox.h,
							backgroundPixels: 0,
							params: {},
						},
					],
					expected: { pass: false, channels: ["print"] },
				},
			],
		}),
	);

	const report = await runSet({ dir, cfg: { workingSize: 320, workers: 1 } });
	assert.strictEqual(report.cases.length, 2);
	assert.deepStrictEqual(report.meta.warnings, []);

	const clean = report.cases.find((c) => c.id === "clean-0001");
	assert.strictEqual(clean.verdict, "correct-pass", JSON.stringify(clean.failedParts));
	const mark = report.cases.find((c) => c.id === "mark-solid-medium-0001");
	assert.strictEqual(mark.verdict, "detected", JSON.stringify(mark.failedParts));
	assert.strictEqual(mark.hit.channel, "print");

	assert.strictEqual(report.summary.overall.recall, 1);
	assert.strictEqual(report.summary.overall.falseFails, 0);
	// no rig in this manifest, so nothing was pinned
	assert.strictEqual(report.meta.trained, null);

	// --train pins the set to what one clean frame measures; here the frame
	// is the golden itself, so the pin is unity and the verdicts hold
	const pinned = await runSet({ dir, cfg: { workingSize: 320, workers: 1 }, train: true });
	assert.ok(pinned.meta.trained, "a trained pin is reported");
	assert.strictEqual(pinned.meta.trained.frame, "clean-0001");
	assert.ok(Math.abs(pinned.meta.trained.mx - 1) < 0.05, `mx ${pinned.meta.trained.mx}`);
	assert.ok(Math.abs(pinned.meta.trained.my - 1) < 0.05, `my ${pinned.meta.trained.my}`);
	assert.strictEqual(pinned.meta.cfg.pinnedScale.mx, pinned.meta.trained.mx);
	assert.strictEqual(pinned.cases.find((c) => c.id === "clean-0001").verdict, "correct-pass");
	assert.strictEqual(pinned.cases.find((c) => c.id === "mark-solid-medium-0001").verdict, "detected");
});
