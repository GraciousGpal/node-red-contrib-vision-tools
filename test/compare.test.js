/**
 * Regression tests for lib/compare.js.
 *
 * Fixtures are generated here rather than read from data/sample_images
 * (which is gitignored - real customer QC photos), so these run anywhere:
 * `node --test` from the package root.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const {
	prepareGolden,
	compareFrame,
	computeTargetWorkingSize,
} = require("../lib/compare.js");

const BASE_CFG = {
	workingSize: 1024,
	threshold: 128,
	thresholdMode: "fixed",
	maxAspect: 0.06,
	aspectSteps: 7,
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	scaleSearchMin: 0.6,
	scaleSearchMax: 2.5,
	scaleSearchSteps: 19,
	maxAngleDeg: 2,
	angleSteps: 5,
	positionToleranceAngleDeg: 1,
	printTolerance: 5,
	backgroundTolerance: 3,
	alignSearch: 16,
	positionToleranceXMm: 2,
	positionToleranceYMm: 2,
	positionToleranceXPx: 16,
	positionToleranceYPx: 16,
	inkMargin: 8,
	blockSize: 16,
	blockThreshold: 0.15,
	failThreshold: 0.3,
	failRatio: 0.002,
	outputPrintHeatmap: false,
	outputBackgroundHeatmap: false,
	debugStages: false,
	mmPerPixelNative: null,
};

const cfg = (over) => ({ ...BASE_CFG, ...over });

// A label-ish synthetic: light background, dark bars and a block of
// "text" rules, so thresholding gives a decent amount of foreground.
// Bar positions are deliberately IRREGULAR. Evenly spaced bars make a
// vertical stretch genuinely ambiguous - the stretched pattern can align
// itself against the neighbouring bar and score just as well - so a
// periodic fixture would test the search against a question that has no
// single right answer. Real label text is aperiodic, which is what lets
// the stretch be recovered at all.
const BAR_Y = [
	0.1, 0.155, 0.19, 0.26, 0.3, 0.375, 0.41, 0.47, 0.545, 0.6, 0.68, 0.74,
];

function labelSvg(
	width,
	height,
	{
		shiftX = 0,
		shiftY = 0,
		extraBlob = null,
		missingBar = false,
		panelFill = null,
		localShift = null,
	} = {},
) {
	const bars = [];
	for (let i = 0; i < BAR_Y.length; i++) {
		if (missingBar && i === 5) continue;
		const y = Math.round(height * BAR_Y[i]) + shiftY;
		const w = Math.round(
			width * (i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.44 : 0.31),
		);
		// a run of bars displaced while the rest stay put - one patch of
		// substrate lifted, which is neither a rotation nor a shear and so
		// survives any global fit
		const local =
			localShift && i >= localShift.from && i < localShift.to ? localShift.px : 0;
		bars.push(
			`<rect x="${Math.round(width * 0.14) + shiftX + local}" y="${y}" width="${w}" height="${Math.round(height * 0.022)}" fill="#111"/>`,
		);
	}
	// a large flat panel, the shape that makes a drifting Otsu level
	// flip a whole region at once
	const panel = panelFill
		? `<rect x="${Math.round(width * 0.2) + shiftX}" y="${Math.round(height * 0.8) + shiftY}" width="${Math.round(width * 0.5)}" height="${Math.round(height * 0.12)}" fill="${panelFill}"/>`
		: "";
	const blob = extraBlob
		? `<rect x="${extraBlob.x}" y="${extraBlob.y}" width="${extraBlob.w}" height="${extraBlob.h}" fill="${extraBlob.fill || "#000"}"/>`
		: "";
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="${Math.round(width * 0.1) + shiftX}" y="${Math.round(height * 0.05) + shiftY}" width="${Math.round(width * 0.8)}" height="${Math.round(height * 0.9)}" fill="none" stroke="#111" stroke-width="${Math.max(2, Math.round(width * 0.01))}"/>` +
			bars.join("") +
			panel +
			blob +
			`</svg>`,
	);
}

const png = (svg) => sharp(svg).png().toBuffer();

// The bug this suite exists for: a golden smaller than workingSize was
// left at native size by the golden decode, while the target side scaled
// itself up to workingSize - so an image compared against *itself* was
// diffed against a magnified copy and failed everything.
for (const [name, w, h] of [
	["larger than workingSize", 1800, 2600],
	["smaller than workingSize", 400, 576],
	["exactly workingSize", 1024, 700],
]) {
	test(`identical image passes with zero defects (${name})`, async () => {
		const buf = await png(labelSvg(w, h));
		const golden = await prepareGolden(buf, cfg());
		const r = await compareFrame(buf, golden, cfg());

		assert.strictEqual(r.position.dxPx, 0);
		assert.strictEqual(r.position.dyPx, 0);
		assert.strictEqual(
			r.printBlemish.defectRatio,
			0,
			"print defect ratio must be exactly 0",
		);
		assert.strictEqual(
			r.backgroundBlemish.defectRatio,
			0,
			"background defect ratio must be exactly 0",
		);
		assert.strictEqual(r.pass, true);
	});
}

test("target of identical native size reuses golden's working canvas exactly", () => {
	const golden = {
		width: 400,
		height: 576,
		nativeWidth: 400,
		nativeHeight: 576,
		mmPerWorkingPx: null,
	};
	assert.deepStrictEqual(computeTargetWorkingSize(400, 576, golden, cfg()), {
		width: 400,
		height: 576,
	});
});

test("uncalibrated target inherits golden's realized native->working scale", () => {
	// golden downscaled 2000 -> 1024 (0.512); a same-rig target with more
	// field of view must get that same scale, not workingSize/its own long edge.
	const golden = {
		width: 512,
		height: 1024,
		nativeWidth: 1000,
		nativeHeight: 2000,
		mmPerWorkingPx: null,
	};
	const t = computeTargetWorkingSize(1200, 2400, golden, cfg());
	assert.deepStrictEqual(t, { width: 614, height: 1229 });
});

test("a shifted capture is measured as a position offset", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(labelSvg(1200, 1600, { shiftX: 60, shiftY: 0 }));
	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg());
	// content moved right within an identically-sized canvas, so the best
	// matching window sits to the right: a negative reported dx.
	assert.ok(
		Math.abs(r.position.dxPx) >= 10,
		`expected a measurable x shift, got ${r.position.dxPx}`,
	);
});

test("extra ink the golden never has fails the background check", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(
		labelSvg(1200, 1600, { extraBlob: { x: 700, y: 1300, w: 260, h: 200 } }),
	);
	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg());
	assert.strictEqual(
		r.backgroundBlemish.pass,
		false,
		"a large ink blob must fail background",
	);
	assert.ok(r.backgroundBlemish.regions.length > 0);
	assert.strictEqual(
		r.printBlemish.pass,
		true,
		"print must not double-count extra ink",
	);
	assert.strictEqual(r.pass, false);
});

test("ink the golden expects but the target lacks fails the print check", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(labelSvg(1200, 1600, { missingBar: true }));
	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg());
	assert.strictEqual(
		r.printBlemish.pass,
		false,
		"a missing bar must fail print",
	);
	assert.ok(r.printBlemish.regions.length > 0);
	assert.strictEqual(
		r.backgroundBlemish.pass,
		true,
		"background must not double-count missing ink",
	);
});

// The whole point of searching magnification: a golden that is rendered
// artwork rather than a capture off the same camera has no reason to
// share the frame's px-per-mm, and a translation-only search reports that
// as a catastrophically defective part.
test("a frame at a different magnification is matched, not failed", async () => {
	const goldenBuf = await png(labelSvg(600, 800));
	// the same artwork at 2x, sitting in a larger frame with margin
	const targetBuf = await sharp({
		create: { width: 1500, height: 1900, channels: 3, background: "#fff" },
	})
		.composite([
			{
				input: await sharp(labelSvg(1200, 1600)).png().toBuffer(),
				top: 150,
				left: 150,
			},
		])
		.png()
		.toBuffer();

	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg());

	assert.ok(
		Math.abs(r.transform.scale - 2) < 0.05,
		`expected the search to recover a ~2x magnification, got ${r.transform.scale.toFixed(3)}`,
	);
	assert.ok(
		r.printBlemish.defectRatio < 0.002,
		`print defect ratio should stay negligible, got ${r.printBlemish.defectRatio.toFixed(5)}`,
	);
	assert.ok(
		r.backgroundBlemish.defectRatio < 0.002,
		`background defect ratio should stay negligible, got ${r.backgroundBlemish.defectRatio.toFixed(5)}`,
	);
});

test("a part seated slightly off square is measured as an angle", async () => {
	const goldenBuf = await png(labelSvg(900, 1200));
	const targetBuf = await sharp(await png(labelSvg(900, 1200)))
		.rotate(1.2, { background: "#fff" })
		.png()
		.toBuffer();

	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg());

	assert.ok(
		Math.abs(Math.abs(r.transform.angleDeg) - 1.2) < 0.75,
		`expected a ~1.2 degree rotation, got ${r.transform.angleDeg.toFixed(2)}`,
	);
	assert.strictEqual(typeof r.position.anglePass, "boolean");
});

test("otsu absorbs a uniform exposure shift that a fixed level would not", async () => {
	const goldenBuf = await png(labelSvg(900, 1200));
	// The same part photographed darker: dark enough that the substrate
	// itself falls below the hand-set level, which is exactly when a fixed
	// threshold stops describing the image and starts inventing ink.
	const darkBuf = await sharp(await png(labelSvg(900, 1200)))
		.linear(0.45, 0)
		.png()
		.toBuffer();

	const golden = await prepareGolden(goldenBuf, cfg({ thresholdMode: "fixed" }));
	const fixed = await compareFrame(
		darkBuf,
		golden,
		cfg({ thresholdMode: "fixed" }),
	);

	const goldenOtsu = await prepareGolden(
		goldenBuf,
		cfg({ thresholdMode: "otsu" }),
	);
	const otsu = await compareFrame(
		darkBuf,
		goldenOtsu,
		cfg({ thresholdMode: "otsu" }),
	);

	assert.strictEqual(
		fixed.backgroundBlemish.pass,
		false,
		"a fixed level should be fooled once the substrate darkens past it",
	);
	assert.ok(
		otsu.backgroundBlemish.defectRatio < fixed.backgroundBlemish.defectRatio / 10,
		`otsu (${otsu.backgroundBlemish.defectRatio.toFixed(5)}) should be far below fixed ` +
			`(${fixed.backgroundBlemish.defectRatio.toFixed(5)}) on a darkened frame`,
	);
	assert.strictEqual(
		otsu.pass,
		true,
		"a merely darker photo of a good part must still pass",
	);
});

// The reason this node exists: the golden is the label's PDF artwork and
// the frame is a photograph of that label printed. A press stretches the
// print along its media-feed axis relative to the artwork - measured at
// 5-6% on this project's own sample pairs - and an isotropic scale cannot
// represent that. It splits the error instead, leaving every feature
// several pixels out toward the ends of the long axis, which on body text
// is the entire stroke.
test("a print stretched along one axis is matched, not failed", async () => {
	const goldenBuf = await png(labelSvg(700, 1000));
	// the same artwork, 5% longer vertically, in a frame with margin
	const stretched = await sharp(await png(labelSvg(700, 1000)))
		.resize(700, 1050, { fit: "fill" })
		.png()
		.toBuffer();
	const targetBuf = await sharp({
		create: { width: 820, height: 1170, channels: 3, background: "#fff" },
	})
		.composite([{ input: stretched, top: 60, left: 60 }])
		.png()
		.toBuffer();

	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg());

	assert.ok(
		Math.abs(r.transform.stretchPercent - 5) < 1.5,
		`expected ~5% stretch to be recovered, got ${r.transform.stretchPercent.toFixed(2)}%`,
	);
	assert.ok(
		r.printBlemish.defectRatio < 0.002,
		`print defect ratio should stay negligible, got ${r.printBlemish.defectRatio.toFixed(5)}`,
	);
	assert.ok(
		r.backgroundBlemish.defectRatio < 0.002,
		`background defect ratio should stay negligible, got ${r.backgroundBlemish.defectRatio.toFixed(5)}`,
	);
});

test("an unstretched pair reports no stretch", async () => {
	const buf = await png(labelSvg(700, 1000));
	const golden = await prepareGolden(buf, cfg());
	const r = await compareFrame(buf, golden, cfg());
	assert.ok(
		Math.abs(r.transform.stretchPercent) < 0.2,
		`identical images must not invent stretch, got ${r.transform.stretchPercent.toFixed(3)}%`,
	);
	assert.strictEqual(r.transform.scaleX, r.transform.scaleY);
});

// The PDF-vs-print failure mode inkMargin exists for: a screened tint is
// a few levels lighter than the ink level in the artwork and a few levels
// darker in the print, so the identical design element binarizes
// differently on the two sides and the background check reports the
// label's own artwork as unwanted ink. Real marks sit nowhere near the
// level and must survive the same setting untouched.
test("a tint that only just crosses the ink level is not a background defect", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	// #7C = 124, four levels under the fixed level of 128: ink by a hair
	const targetBuf = await png(
		labelSvg(1200, 1600, {
			extraBlob: { x: 700, y: 1300, w: 260, h: 200, fill: "#7c7c7c" },
		}),
	);

	const strict = cfg({ inkMargin: 0 });
	const rStrict = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, strict),
		strict,
	);
	assert.ok(
		rStrict.backgroundBlemish.defectRatio > 0.002,
		`with no margin the tint should be flagged, got ${rStrict.backgroundBlemish.defectRatio.toFixed(5)}`,
	);

	const lenient = cfg({ inkMargin: 8 });
	const rLenient = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, lenient),
		lenient,
	);
	assert.strictEqual(
		rLenient.backgroundBlemish.regions.length,
		0,
		"a margin wider than the tint's overshoot must clear it entirely",
	);
	assert.ok(
		rLenient.pass,
		"a good part whose only difference is a marginal tint must pass",
	);
});

test("inkMargin does not blunt a solid extra-ink defect", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(
		labelSvg(1200, 1600, { extraBlob: { x: 700, y: 1300, w: 260, h: 200 } }),
	);
	const c = cfg({ inkMargin: 8 });
	const r = await compareFrame(targetBuf, await prepareGolden(goldenBuf, c), c);

	assert.ok(
		r.backgroundBlemish.defectRatio > 0.002,
		`solid black is 128 levels clear of the cut and must still be flagged, got ${r.backgroundBlemish.defectRatio.toFixed(5)}`,
	);
	assert.strictEqual(
		r.printBlemish.defectRatio,
		0,
		"extra ink must not leak into the print check",
	);
});

test("inkMargin leaves an identical image at exactly zero", async () => {
	const buf = await png(labelSvg(900, 1300));
	const c = cfg({ inkMargin: 8 });
	const r = await compareFrame(buf, await prepareGolden(buf, c), c);
	assert.strictEqual(r.printBlemish.defectRatio, 0);
	assert.strictEqual(r.backgroundBlemish.defectRatio, 0);
});

// The second, nastier half of the same problem, and the one that only
// shows up at higher workingSize: the ambiguous pixel is in the GOLDEN.
// Otsu re-derives its level per image and the level moves with
// resolution, so a flat artwork panel sitting a few levels above the cut
// reads as background in the artwork while the print - which reproduces
// it much darker - reads as solid ink. That lights up the whole panel as
// extra ink on a perfectly good part. Excluding only weak *foreground*
// pixels never catches this, because the artwork pixel is background.
test("a golden panel just above its own ink level cannot raise a defect", async () => {
	// #84 = 132, four levels ABOVE the fixed level of 128: background,
	// but only just. The print reproduces the same panel at #3c = 60.
	const goldenBuf = await png(labelSvg(1200, 1600, { panelFill: "#848484" }));
	const targetBuf = await png(labelSvg(1200, 1600, { panelFill: "#3c3c3c" }));

	const strict = cfg({ inkMargin: 0 });
	const rStrict = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, strict),
		strict,
	);
	assert.ok(
		rStrict.backgroundBlemish.defectRatio > 0.002,
		`with no margin the panel should flood the background check, got ${rStrict.backgroundBlemish.defectRatio.toFixed(5)}`,
	);

	const lenient = cfg({ inkMargin: 8 });
	const rLenient = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, lenient),
		lenient,
	);
	assert.strictEqual(
		rLenient.backgroundBlemish.regions.length,
		0,
		"ambiguity on the golden side must void the claim just as it does on the target side",
	);
	assert.ok(rLenient.pass);
});

test("a mark on unambiguous background survives a wide margin", async () => {
	// the production recipe leans on a wide margin, so the thing it must
	// never do is swallow a solid mark sitting on clean substrate
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(
		labelSvg(1200, 1600, { extraBlob: { x: 700, y: 1300, w: 200, h: 160 } }),
	);
	const c = cfg({ inkMargin: 64 });
	const r = await compareFrame(targetBuf, await prepareGolden(goldenBuf, c), c);
	assert.ok(
		r.backgroundBlemish.regions.length > 0,
		"black on white is 128 levels clear of the cut - a 64 margin must not reach it",
	);
});

// Pinning is only safe if it reproduces what the search would have found.
// The rig's magnification and the press's stretch do not change between
// frames, so a transform measured once must give the same answer on the
// next frame - otherwise "trained" would quietly mean "differently
// aligned", and every defect number after it would be suspect.
test("a pinned scale reproduces the searched alignment", async () => {
	const goldenBuf = await png(labelSvg(900, 1300));
	const targetBuf = await png(labelSvg(900, 1300, { shiftX: 20, shiftY: -12 }));
	const golden = await prepareGolden(goldenBuf, cfg());

	const searched = await compareFrame(targetBuf, golden, cfg());
	const pinned = await compareFrame(
		targetBuf,
		golden,
		cfg({
			pinnedScale: {
				mx: searched.transform.scaleX,
				my: searched.transform.scaleY,
			},
		}),
	);

	assert.strictEqual(pinned.transform.pinned, true);
	assert.strictEqual(
		pinned.transform.scaleX,
		searched.transform.scaleX,
		"pinning must not move the scale",
	);
	assert.strictEqual(pinned.transform.scaleY, searched.transform.scaleY);
	// Within a pixel, not identical: the polish objective is computed at
	// half resolution, so it cannot resolve a single full-res pixel of
	// translation, and the two paths approach the optimum differently.
	// Worth knowing rather than hiding - a pixel is most of a stroke at a
	// high working size, and it does cost some defect sensitivity.
	assert.ok(
		Math.abs(pinned.position.dxPx - searched.position.dxPx) <= 1,
		`dx ${pinned.position.dxPx} vs ${searched.position.dxPx}`,
	);
	assert.ok(
		Math.abs(pinned.position.dyPx - searched.position.dyPx) <= 1,
		`dy ${pinned.position.dyPx} vs ${searched.position.dyPx}`,
	);
	assert.ok(
		Math.abs(
			pinned.backgroundBlemish.defectRatio -
				searched.backgroundBlemish.defectRatio,
		) < 0.0005,
		`defect ratio must not shift: ${searched.backgroundBlemish.defectRatio} vs ${pinned.backgroundBlemish.defectRatio}`,
	);
});

test("a pinned run still finds a defect the searched run finds", async () => {
	const goldenBuf = await png(labelSvg(900, 1300));
	const targetBuf = await png(
		labelSvg(900, 1300, { extraBlob: { x: 520, y: 1050, w: 150, h: 120 } }),
	);
	const golden = await prepareGolden(goldenBuf, cfg());
	const searched = await compareFrame(targetBuf, golden, cfg());
	const pinned = await compareFrame(
		targetBuf,
		golden,
		cfg({
			pinnedScale: {
				mx: searched.transform.scaleX,
				my: searched.transform.scaleY,
			},
		}),
	);
	assert.ok(
		searched.backgroundBlemish.regions.length > 0,
		"precondition: searched finds it",
	);
	assert.ok(
		pinned.backgroundBlemish.regions.length > 0,
		"pinning must not hide the defect",
	);
});

// Local refinement. The global transform places the label; a label on a
// formed tray is not flat, so parts of it still sit a few pixels off. The
// danger is obvious - anything free to move the frame around can move a
// defect into agreement - so these pin down that it fixes registration
// and only registration.

test("local refinement does not hide extra ink", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(
		labelSvg(1200, 1600, { extraBlob: { x: 700, y: 1300, w: 260, h: 200 } }),
	);
	const golden = await prepareGolden(goldenBuf, cfg({ localAlign: true }));
	const r = await compareFrame(targetBuf, golden, cfg({ localAlign: true }));
	assert.ok(
		r.backgroundBlemish.defectRatio > 0.002,
		`a blob has nowhere to hide, got ${r.backgroundBlemish.defectRatio.toFixed(5)}`,
	);
});

// The maskable direction: missing ink could in principle be papered over
// by dragging neighbouring ink into the gap.
test("local refinement does not hide missing ink", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(labelSvg(1200, 1600, { missingBar: true }));
	const golden = await prepareGolden(goldenBuf, cfg({ localAlign: true }));
	const r = await compareFrame(targetBuf, golden, cfg({ localAlign: true }));
	assert.ok(
		r.printBlemish.defectRatio > 0.002,
		`a missing bar must still be missing, got ${r.printBlemish.defectRatio.toFixed(5)}`,
	);
});

// Regression: resampling the frame with bilinear interpolation is a
// low-pass filter, and it blurred a thin mark below the ink level - an
// 82% drop in defect ratio that turned a failing part into a passing one.
// The field is interpolated; the image is not.
test("local refinement preserves thin features", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const targetBuf = await png(
		labelSvg(1200, 1600, { extraBlob: { x: 700, y: 1200, w: 5, h: 320 } }),
	);
	const golden = await prepareGolden(goldenBuf, cfg({ localAlign: false }));
	const off = await compareFrame(targetBuf, golden, cfg({ localAlign: false }));
	const on = await compareFrame(targetBuf, golden, cfg({ localAlign: true }));
	assert.ok(
		off.backgroundBlemish.regions.length > 0,
		"precondition: the hairline is found",
	);
	assert.ok(
		on.backgroundBlemish.regions.length > 0,
		"refinement must not smooth a hairline out of existence",
	);
});

test("local refinement leaves an identical image at exactly zero", async () => {
	const buf = await png(labelSvg(900, 1300));
	const c = cfg({ localAlign: true });
	const r = await compareFrame(buf, await prepareGolden(buf, c), c);
	assert.strictEqual(r.printBlemish.defectRatio, 0);
	assert.strictEqual(r.backgroundBlemish.defectRatio, 0);
});

// Raw input: pixels with no container around them, as a PDF renderer or a
// camera SDK hands them over. sharp cannot infer a geometry from such a
// buffer, so it has to be told - and the answer must not change because
// the pixels arrived undressed.
test("raw pixels compare identically to the same image in a container", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { data, info } = await sharp(encoded)
		.raw()
		.toBuffer({ resolveWithObject: true });
	const raw = {
		width: info.width,
		height: info.height,
		channels: info.channels,
	};

	const encodedCfg = cfg();
	const viaPng = await compareFrame(
		encoded,
		await prepareGolden(encoded, encodedCfg),
		encodedCfg,
	);

	const rawCfg = cfg({ raw, targetRaw: raw });
	const viaRaw = await compareFrame(
		data,
		await prepareGolden(data, rawCfg),
		rawCfg,
	);

	assert.strictEqual(
		viaRaw.printBlemish.defectRatio,
		viaPng.printBlemish.defectRatio,
	);
	assert.strictEqual(
		viaRaw.backgroundBlemish.defectRatio,
		viaPng.backgroundBlemish.defectRatio,
	);
	assert.strictEqual(viaRaw.position.dxPx, viaPng.position.dxPx);
	assert.strictEqual(viaRaw.position.dyPx, viaPng.position.dyPx);
	assert.strictEqual(viaRaw.width, viaPng.width);
	assert.strictEqual(viaRaw.height, viaPng.height);
});

test("a raw golden and an encoded frame still compare", async () => {
	// the realistic mix: artwork rendered straight out of a PDF, against a
	// camera frame that arrived as a file
	const encoded = await png(labelSvg(900, 1300));
	const { data, info } = await sharp(encoded)
		.raw()
		.toBuffer({ resolveWithObject: true });
	const c = cfg({
		raw: { width: info.width, height: info.height, channels: info.channels },
	});
	const r = await compareFrame(encoded, await prepareGolden(data, c), c);
	assert.strictEqual(r.printBlemish.defectRatio, 0);
	assert.strictEqual(r.backgroundBlemish.defectRatio, 0);
	assert.ok(r.pass);
});

// pdf-to-image in RAW mode emits msg.payload as
// { data, width, height, channels: 4, colorSpace: "RGBA" } - the exact
// shape resolveImage takes, so a golden loads with msg.golden =
// msg.payload and no glue. Four channels means alpha, and a PDF renders
// on a transparent background unless told otherwise, so the alpha has to
// be flattened rather than averaged into the grey.
test("an RGBA raw golden from a PDF render loads and compares", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { data, info } = await sharp(encoded)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	assert.strictEqual(info.channels, 4, "precondition: four channels");

	const descriptor = {
		data,
		width: info.width,
		height: info.height,
		channels: info.channels,
	};
	const c = cfg({
		raw: {
			width: descriptor.width,
			height: descriptor.height,
			channels: descriptor.channels,
		},
	});
	const golden = await prepareGolden(descriptor.data, c);
	const r = await compareFrame(encoded, golden, c);

	assert.strictEqual(
		r.printBlemish.defectRatio,
		0,
		"RGBA raw must match the same image encoded",
	);
	assert.strictEqual(r.backgroundBlemish.defectRatio, 0);
	assert.ok(r.pass);
});

// "This is the wrong golden" and "this part is badly printed" both produce
// enormous defect numbers, and they call for completely different actions.
// The distinguishing signal is the shape of the disagreement, not its size:
// a defective part disagrees in one direction and in places, two different
// labels disagree in both directions and everywhere.
test("a matching pair is graded good and never flagged as a mismatch", async () => {
	const buf = await png(labelSvg(900, 1300));
	const r = await compareFrame(buf, await prepareGolden(buf, cfg()), cfg());
	assert.strictEqual(r.match.grade, "good", `score ${r.match.score}`);
	assert.strictEqual(r.match.mismatchSuspected, false);
	assert.strictEqual(r.match.reason, null);
});

test("a real defect is not mistaken for the wrong label", async () => {
	// a blob big enough to fail the part outright still disagrees in only
	// one direction, which is what keeps it out of the mismatch bucket
	const goldenBuf = await png(labelSvg(900, 1300));
	const targetBuf = await png(
		labelSvg(900, 1300, { extraBlob: { x: 180, y: 300, w: 520, h: 620 } }),
	);
	const r = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, cfg()),
		cfg(),
	);
	assert.ok(
		r.backgroundBlemish.defectRatio > 0.02,
		"precondition: a large defect",
	);
	assert.strictEqual(r.printBlemish.defectRatio < 0.02, true, "one-directional");
	assert.strictEqual(
		r.match.mismatchSuspected,
		false,
		"a lopsided disagreement is a defect, not a different label",
	);
});

test("genuinely different artwork is flagged as a different label", async () => {
	// same fixture family, different layout: bars elsewhere, box elsewhere -
	// the shape two products' artwork have relative to each other
	const goldenBuf = await png(labelSvg(900, 1300));
	const other = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1300">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			[0.07, 0.13, 0.22, 0.29, 0.38, 0.44, 0.52, 0.61, 0.7, 0.77, 0.86, 0.93]
				.map(
					(f, i) =>
						`<rect x="${40 + ((i * 53) % 300)}" y="${Math.round(1300 * f)}" width="${760 - ((i * 37) % 280)}" height="34" fill="#111"/>`,
				)
				.join("") +
			`<rect x="60" y="60" width="780" height="1180" fill="none" stroke="#111" stroke-width="14"/>` +
			`</svg>`,
	);
	const targetBuf = await sharp(other).png().toBuffer();
	const r = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, cfg()),
		cfg(),
	);

	assert.ok(
		r.match.score >= 0.15,
		`precondition: different artwork should register poorly, got ${r.match.score.toFixed(4)}`,
	);
	assert.strictEqual(r.match.grade, "poor");
	assert.strictEqual(
		r.match.mismatchSuspected,
		true,
		r.match.reason || "should be flagged",
	);
	assert.match(r.match.reason, /different\s+label/);
});

test("the mismatch check can be turned off", async () => {
	// the same different-artwork pair as the "genuinely different artwork
	// is flagged" test - that fixture is what actually trips
	// mismatchSuspected (a shifted copy of the label scores ~0.09, below
	// the 0.15 default, so the old fixture could not distinguish enabled
	// from disabled and a broken disable path would have gone unnoticed)
	const goldenBuf = await png(labelSvg(900, 1300));
	const other = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1300">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			[0.07, 0.13, 0.22, 0.29, 0.38, 0.44, 0.52, 0.61, 0.7, 0.77, 0.86, 0.93]
				.map(
					(f, i) =>
						`<rect x="${40 + ((i * 53) % 300)}" y="${Math.round(1300 * f)}" width="${760 - ((i * 37) % 280)}" height="34" fill="#111"/>`,
				)
				.join("") +
			`<rect x="60" y="60" width="780" height="1180" fill="none" stroke="#111" stroke-width="14"/>` +
			`</svg>`,
	);
	const targetBuf = await sharp(other).png().toBuffer();

	const enabled = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, cfg()),
		cfg(),
	);
	assert.strictEqual(
		enabled.match.mismatchSuspected,
		true,
		"precondition: the fixture must trip the check when it is enabled",
	);

	const c = cfg({ mismatchScore: 0 });
	const r = await compareFrame(targetBuf, await prepareGolden(goldenBuf, c), c);
	assert.strictEqual(
		r.match.mismatchSuspected,
		false,
		"0 disables the claim entirely",
	);
});
