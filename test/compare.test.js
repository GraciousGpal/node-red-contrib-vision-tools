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
		hairlines = null,
		barFill = "#111",
		extraRects = null,
		paperFill = "#fff",
		borderFill = "#111",
		panelText = false,
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
			`<rect x="${Math.round(width * 0.14) + shiftX + local}" y="${y}" width="${w}" height="${Math.round(height * 0.022)}" fill="${barFill}"/>`,
		);
	}
	// a large flat panel, the shape that makes a drifting Otsu level
	// flip a whole region at once
	const panel = panelFill
		? `<rect x="${Math.round(width * 0.2) + shiftX}" y="${Math.round(height * 0.8) + shiftY}" width="${Math.round(width * 0.5)}" height="${Math.round(height * 0.12)}" fill="${panelFill}"/>` +
			// white type on the panel, the real-artwork case
			(panelText
				? `<rect x="${Math.round(width * 0.25)}" y="${Math.round(height * 0.83)}" width="${Math.round(width * 0.12)}" height="${Math.round(height * 0.05)}" fill="#fff"/>` +
					`<rect x="${Math.round(width * 0.42)}" y="${Math.round(height * 0.83)}" width="${Math.round(width * 0.04)}" height="${Math.round(height * 0.06)}" fill="#fff"/>`
				: "")
		: "";
	const blob = extraBlob
		? `<rect x="${extraBlob.x}" y="${extraBlob.y}" width="${extraBlob.w}" height="${extraBlob.h}" fill="${extraBlob.fill || "#000"}"/>`
		: "";
	// any number of small rectangles: specks on paper, holes in a bar
	const extras = extraRects
		? extraRects
				.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill || "#000"}"/>`)
				.join("")
		: "";
	// a patch of "body type": 2px rules every 20px, so a block over it is
	// about a tenth ink - too thin to reach blockThreshold by area if the
	// whole patch goes missing
	const rules = hairlines
		? Array.from({ length: Math.floor(hairlines.h / 20) }, (_, i) =>
				`<rect x="${hairlines.x}" y="${hairlines.y + i * 20}" width="${hairlines.w}" height="2" fill="#000"/>`,
			).join("")
		: "";
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
			`<rect width="100%" height="100%" fill="${paperFill}"/>` +
			`<rect x="${Math.round(width * 0.1) + shiftX}" y="${Math.round(height * 0.05) + shiftY}" width="${Math.round(width * 0.8)}" height="${Math.round(height * 0.9)}" fill="none" stroke="${borderFill}" stroke-width="${Math.max(2, Math.round(width * 0.01))}"/>` +
			bars.join("") +
			panel +
			blob +
			rules +
			extras +
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

// The first miss mechanism in bench/synth-findings.md: a dropped word of
// thin type is 10-15% of its blocks by area, under blockThreshold, and a
// few hundred pixels, under failRatio - so it passed. Against the ink the
// golden has in those blocks it is everything.
test("a patch of thin type that went missing fails print on the missing fraction, not by area", async () => {
	const patch = { x: 300, y: 1008, w: 200, h: 80 };
	const goldenBuf = await png(labelSvg(1200, 1600, { hairlines: patch }));
	const targetBuf = await png(labelSvg(1200, 1600));
	const golden = await prepareGolden(goldenBuf, cfg());

	// the gap, documented: by area and ratio alone the loss is invisible
	const off = await compareFrame(targetBuf, golden, cfg({ printMissingFraction: 0 }));
	assert.strictEqual(off.printBlemish.pass, true, "area and ratio gates alone let thin type go");
	assert.strictEqual(off.printBlemish.worstMissing, 0);

	const on = await compareFrame(targetBuf, golden, cfg({ printMissingFraction: 0.5 }));
	assert.strictEqual(on.printBlemish.pass, false, "the missing-ink gate must catch it");
	assert.ok(on.printBlemish.worstMissing >= 0.5, `worstMissing ${on.printBlemish.worstMissing}`);
	// and it says where: a region over the patch, in working pixels
	const sx = golden.width / 1200;
	const sy = golden.height / 1600;
	const hit = on.printBlemish.regions.find(
		(r) =>
			r.x < (patch.x + patch.w) * sx &&
			r.x + r.w > patch.x * sx &&
			r.y < (patch.y + patch.h) * sy &&
			r.y + r.h > patch.y * sy,
	);
	assert.ok(hit, `no region over the patch: ${JSON.stringify(on.printBlemish.regions)}`);
	assert.ok(hit.missing >= 0.5);
	assert.strictEqual(on.backgroundBlemish.pass, true, "background is untouched by the gate");

	// a frame that still has its type is not failed by the gate
	const same = await compareFrame(goldenBuf, golden, cfg({ printMissingFraction: 0.5 }));
	assert.strictEqual(same.printBlemish.pass, true);
	assert.strictEqual(same.printBlemish.worstMissing, 0);
});

// The second miss mechanism in bench/synth-findings.md: both binary checks
// read the frame after thresholding, so grey that stays on the paper side
// of the level - a smudge, a ghost - or ink that is lighter but still ink
// is invisible to them. The tone check measures the grey itself.
const TONE = { toneThreshold: 0.3, toneMargin: 3 };

test("a grey smudge the ink threshold never sees fails the tone check, on the smudge", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const blob = { x: 650, y: 1250, w: 160, h: 120, fill: "#999" };
	const targetBuf = await png(labelSvg(1200, 1600, { extraBlob: blob }));
	const golden = await prepareGolden(goldenBuf, cfg());

	// the gap, documented: grey above the level is paper to both binary checks
	const off = await compareFrame(targetBuf, golden, cfg({ toneThreshold: 0 }));
	assert.strictEqual(off.pass, true, `binary checks alone pass a #999 smudge: ${JSON.stringify(off.backgroundBlemish.regions)}`);
	assert.strictEqual(off.toneBlemish.enabled, false);

	const on = await compareFrame(targetBuf, golden, cfg(TONE));
	assert.strictEqual(on.toneBlemish.enabled, true);
	assert.strictEqual(on.toneBlemish.pass, false, "the tone check must see it");
	assert.strictEqual(on.pass, false);
	assert.strictEqual(on.printBlemish.pass, true);
	assert.strictEqual(on.backgroundBlemish.pass, true);
	const sx = golden.width / 1200;
	const sy = golden.height / 1600;
	const hit = on.toneBlemish.regions.find(
		(r) =>
			r.x < (blob.x + blob.w) * sx && r.x + r.w > blob.x * sx &&
			r.y < (blob.y + blob.h) * sy && r.y + r.h > blob.y * sy,
	);
	assert.ok(hit, `no tone region on the smudge: ${JSON.stringify(on.toneBlemish.regions)}`);
	assert.ok(on.timings.toneMs >= 0);
});

test("faded print that still binarizes as ink fails the tone check", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	// #707070 is well under the Otsu level, so every bar is still ink to
	// the print check; against the artwork's own #111 it is a third of the
	// way to paper
	const targetBuf = await png(labelSvg(1200, 1600, { barFill: "#707070" }));
	const golden = await prepareGolden(goldenBuf, cfg());
	const off = await compareFrame(targetBuf, golden, cfg({ toneThreshold: 0 }));
	assert.strictEqual(off.printBlemish.pass, true, "faded bars are still ink to the binary check");
	const on = await compareFrame(targetBuf, golden, cfg(TONE));
	assert.strictEqual(on.toneBlemish.pass, false);
	assert.ok(on.toneBlemish.regions.length > 0);
	// every bar faded, so the deviation is on ink across the whole label,
	// not in one place
	assert.ok(on.toneBlemish.regions.length >= 3, `${on.toneBlemish.regions.length} regions`);
	assert.ok(on.toneBlemish.defectRatio > 0.001, `ratio ${on.toneBlemish.defectRatio}`);
});

// The two ways the tone check failed on real artwork before it was made
// to measure against the artwork's own grey: a grey panel with white type
// is paper to the golden's threshold and must be expected grey, and a
// cream paper has no pixel at 255 and must still give the check its
// levels.
test("a grey panel with white type in the artwork is expected grey, not a tone defect", async () => {
	const panel = { panelFill: "#888", panelText: true };
	const goldenBuf = await png(labelSvg(1200, 1600, panel));
	const golden = await prepareGolden(goldenBuf, cfg());
	const same = await compareFrame(goldenBuf, golden, cfg(TONE));
	assert.strictEqual(same.toneBlemish.enabled, true, same.toneBlemish.reason);
	assert.deepStrictEqual(same.toneBlemish.regions, [], "the panel and its type must not read as tone");
	assert.strictEqual(same.pass, true);
	// and a dark mark on the panel is still seen against the panel's own grey
	const smudged = await png(
		labelSvg(1200, 1600, { ...panel, extraBlob: { x: 300, y: 1310, w: 120, h: 80, fill: "#333" } }),
	);
	const r = await compareFrame(smudged, golden, cfg(TONE));
	assert.strictEqual(r.toneBlemish.pass, false, "a dark mark on the grey panel is a tone defect");
});

test("cream paper and soft ink still give the tone check its levels", async () => {
	const cream = { paperFill: "#ebebeb", barFill: "#2a2a2a", borderFill: "#2a2a2a" };
	const goldenBuf = await png(labelSvg(1200, 1600, cream));
	const golden = await prepareGolden(goldenBuf, cfg());
	const blob = { x: 650, y: 1250, w: 160, h: 120, fill: "#999" };
	const r = await compareFrame(await png(labelSvg(1200, 1600, { ...cream, extraBlob: blob })), golden, cfg(TONE));
	assert.strictEqual(r.toneBlemish.enabled, true, r.toneBlemish.reason);
	assert.ok(r.toneBlemish.paperLevel > 200 && r.toneBlemish.inkLevel < 80, `levels ${r.toneBlemish.paperLevel}/${r.toneBlemish.inkLevel}`);
	assert.strictEqual(r.toneBlemish.pass, false, "the smudge is still seen on cream paper");
	const same = await compareFrame(goldenBuf, golden, cfg(TONE));
	assert.strictEqual(same.pass, true);
});

test("a golden whose ink and paper cannot be told apart leaves the tone and speck checks off, with a reason", async () => {
	const flat = await png(
		Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="100%" height="100%" fill="#c8c8c8"/><rect x="60" y="60" width="480" height="680" fill="none" stroke="#a0a0a0" stroke-width="6"/></svg>`,
		),
	);
	const golden = await prepareGolden(flat, cfg());
	const r = await compareFrame(flat, golden, cfg(SPECKS));
	assert.strictEqual(r.toneBlemish.enabled, false);
	assert.match(r.toneBlemish.reason, /grey levels apart/);
	assert.strictEqual(r.speckBlemish.enabled, false);
	// a check that cannot run contributes nothing to the verdict
	assert.strictEqual(r.toneBlemish.pass, true);
	assert.strictEqual(r.speckBlemish.pass, true);
	assert.strictEqual(r.pass, r.position.pass && r.printBlemish.pass && r.backgroundBlemish.pass && !r.match.labelMissing);
});

test("the tone check leaves a faint stain and an identical frame alone", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const golden = await prepareGolden(goldenBuf, cfg());
	const same = await compareFrame(goldenBuf, golden, cfg(TONE));
	assert.strictEqual(same.toneBlemish.pass, true);
	assert.deepStrictEqual(same.toneBlemish.regions, []);
	assert.strictEqual(same.pass, true);
	// 25 levels off paper is a tenth of the span: under the floor, as the
	// synthetic set's stain variant is by construction
	const faint = await png(
		labelSvg(1200, 1600, { extraBlob: { x: 650, y: 1250, w: 160, h: 120, fill: "#e6e6e6" } }),
	);
	const stain = await compareFrame(faint, golden, cfg(TONE));
	assert.strictEqual(stain.toneBlemish.pass, true, JSON.stringify(stain.toneBlemish.regions));
	assert.strictEqual(stain.pass, true);
});

// The third miss mechanism in bench/synth-findings.md: dust and pinholes
// are a few pixels each. No block ever gets dense, and the total never
// reaches the ratio, so the block checks pass them; counted as specks
// they are obvious.
// speckMinArea 2 rather than the default 3: the 4x4 fixtures land as
// 2-3 working px after the resize
const SPECKS = { toneThreshold: 0.3, toneMargin: 3, speckThreshold: 0.3, speckMinArea: 2, speckMaxCount: 8, speckMaxArea: 48 };

test("dust on the paper fails the speck check by count where every block check passes", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	// 15 dark 4x4 specks down the clear strip right of the bars
	const dust = Array.from({ length: 15 }, (_, i) => ({ x: 960 + (i % 3) * 40, y: 220 + i * 80, w: 4, h: 4, fill: "#333" }));
	const targetBuf = await png(labelSvg(1200, 1600, { extraRects: dust }));
	const golden = await prepareGolden(goldenBuf, cfg());

	const off = await compareFrame(targetBuf, golden, cfg({ ...SPECKS, speckThreshold: 0 }));
	assert.strictEqual(off.pass, true, `the block checks alone pass 15 specks: ${JSON.stringify(off.backgroundBlemish.regions)}`);
	assert.strictEqual(off.speckBlemish.enabled, false);

	const on = await compareFrame(targetBuf, golden, cfg(SPECKS));
	assert.strictEqual(on.speckBlemish.enabled, true);
	assert.ok(on.speckBlemish.count >= 12 && on.speckBlemish.count <= 15, `counted ${on.speckBlemish.count} specks`);
	assert.strictEqual(on.speckBlemish.pass, false);
	assert.strictEqual(on.pass, false);
	assert.strictEqual(on.printBlemish.pass, true);
	assert.strictEqual(on.backgroundBlemish.pass, true);
	assert.strictEqual(on.toneBlemish.pass, true);
	// each region is one speck, in working px, on the strip they were drawn on
	const sx = golden.width / 1200;
	for (const r of on.speckBlemish.regions) {
		assert.ok(r.x >= 950 * sx && r.x <= 1050 * sx, `speck at x ${r.x}`);
		assert.ok(r.area >= 2);
	}
	assert.ok(on.timings.speckMs >= 0);
});

test("the one-picture overlay carries every check's regions in colour", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const dust = Array.from({ length: 12 }, (_, i) => ({ x: 960 + (i % 3) * 40, y: 220 + i * 90, w: 4, h: 4, fill: "#333" }));
	const targetBuf = await png(
		labelSvg(1200, 1600, { extraRects: dust, extraBlob: { x: 650, y: 1250, w: 160, h: 120, fill: "#999" }, missingBar: true }),
	);
	const golden = await prepareGolden(goldenBuf, cfg());
	const r = await compareFrame(targetBuf, golden, cfg({ ...SPECKS, outputHeatmap: true }));
	assert.strictEqual(r.pass, false);
	assert.ok(Buffer.isBuffer(r.heatmap), "the overlay is an encoded image");
	const meta = await sharp(r.heatmap).metadata();
	assert.strictEqual(meta.width, golden.width);
	assert.strictEqual(meta.height, golden.height);
	// coloured where something was found: red (missing bar), amber (smudge), green (dust)
	const { data } = await sharp(r.heatmap).raw().toBuffer({ resolveWithObject: true });
	let red = 0, amber = 0, green = 0;
	for (let i = 0; i < data.length; i += 3) {
		const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
		// blended over paper, so red reads as pink: strong R, weaker G and B
		if (R > 200 && G < 170 && B < 170 && R - G > 60) red++;
		else if (R > 180 && G > 120 && G < 200 && B < 90) amber++;
		else if (G > 150 && R < 110 && B < 150) green++;
	}
	assert.ok(red > 200, `red pixels ${red}`);
	assert.ok(amber > 200, `amber pixels ${amber}`);
	assert.ok(green > 50, `green pixels ${green}`);
	assert.ok(r.timings.overlayMs >= 0);
	const off = await compareFrame(targetBuf, golden, cfg({ ...SPECKS, outputHeatmap: false }));
	assert.strictEqual(off.heatmap, null);
});

test("pinholes inside a bar fail the speck check by count", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const barTop = Math.round(1600 * BAR_Y[3]);
	const holes = Array.from({ length: 10 }, (_, i) => ({ x: 300 + i * 50, y: barTop + 15, w: 4, h: 4, fill: "#fff" }));
	const targetBuf = await png(labelSvg(1200, 1600, { extraRects: holes }));
	const golden = await prepareGolden(goldenBuf, cfg());
	const off = await compareFrame(targetBuf, golden, cfg({ ...SPECKS, speckThreshold: 0 }));
	assert.strictEqual(off.printBlemish.pass, true, "4px holes are closed by the print tolerance");
	const on = await compareFrame(targetBuf, golden, cfg(SPECKS));
	assert.ok(on.speckBlemish.count >= 8, `counted ${on.speckBlemish.count} pinholes`);
	assert.strictEqual(on.speckBlemish.pass, false);
});

test("one spatter fails the speck check on its size, and a clean frame has no specks", async () => {
	const goldenBuf = await png(labelSvg(1200, 1600));
	const golden = await prepareGolden(goldenBuf, cfg());
	// 13 px square: ~70 working px, over the size gate but too thin a block
	// for the tone check to fail it itself (which would make it tone's)
	const spatter = await png(labelSvg(1200, 1600, { extraRects: [{ x: 980, y: 700, w: 13, h: 13, fill: "#222" }] }));
	const r = await compareFrame(spatter, golden, cfg(SPECKS));
	assert.strictEqual(r.toneBlemish.pass, true, "a lone spatter is under the tone check's block gate");
	assert.strictEqual(r.speckBlemish.count, 1, JSON.stringify(r.speckBlemish.regions));
	assert.ok(r.speckBlemish.largest >= 48, `largest ${r.speckBlemish.largest}`);
	assert.strictEqual(r.speckBlemish.pass, false);
	// with no size gate the same spatter is one speck under the count
	const noArea = await compareFrame(spatter, golden, cfg({ ...SPECKS, speckMaxArea: 0 }));
	assert.strictEqual(noArea.speckBlemish.pass, true);
	const same = await compareFrame(goldenBuf, golden, cfg(SPECKS));
	assert.strictEqual(same.speckBlemish.count, 0);
	assert.strictEqual(same.pass, true);
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
	// sharp rotates about the centre, so the part has not moved: the
	// offset must say so. Measured at the golden's corner it read ~10px
	// here - half the label's height times sin(1.2 degrees) - and on the
	// synthetic benchmark that charged clean parts with offsets they did
	// not have.
	assert.ok(
		Math.abs(r.position.dxPx) <= 3 && Math.abs(r.position.dyPx) <= 3,
		`a rotation about the centre is not an offset: dx ${r.position.dxPx} dy ${r.position.dyPx}`,
	);
});

test("a frame with none of the golden's ink in it fails, whatever the ambiguity band hides", async () => {
	const goldenBuf = await png(labelSvg(900, 1200));
	// the rig's own blank frame: paper, a strip of tray, nothing printed,
	// and shorter than the label. With inkMargin 64 the ambiguity band
	// voids every blemish claim and the search sits at nominal, so before
	// coverage this passed as a clean part.
	const blank = await sharp(
		Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400">` +
				`<rect width="100%" height="100%" fill="#e8ece8"/>` +
				`<rect width="30" height="100%" fill="#777"/></svg>`,
		),
	)
		.png()
		.toBuffer();
	const golden = await prepareGolden(goldenBuf, cfg({ inkMargin: 64 }));
	const r = await compareFrame(
		blank,
		golden,
		cfg({ inkMargin: 64, pinnedScale: { mx: 1, my: 1 } }),
	);
	assert.ok(r.match.coverage < 0.1, `coverage ${r.match.coverage}`);
	assert.strictEqual(r.match.labelMissing, true);
	assert.strictEqual(r.pass, false);
	assert.match(r.match.reason, /label missing/);
	// and a part that is there is not "missing", however wide the band
	const there = await compareFrame(goldenBuf, golden, cfg({ inkMargin: 64 }));
	assert.ok(there.match.coverage > 0.9, `coverage ${there.match.coverage}`);
	assert.strictEqual(there.match.labelMissing, false);
	assert.strictEqual(there.pass, true);
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

test("a loaded nuisance map is drawn as a debug stage over the golden", async () => {
	const g = await prepareGolden(await png(labelSvg(300, 450)), cfg({ debugStages: true }));
	const frame = await png(labelSvg(300, 450));
	const without = await compareFrame(frame, g, cfg({ debugStages: true }));
	assert.strictEqual(
		without.stages.nuisanceBaseline,
		undefined,
		"no map loaded, no baseline stage",
	);
	const { gridW, gridH } = without.backgroundBlemish;
	const baseline = new Float32Array(gridW * gridH);
	baseline[0] = 0.5;
	const withMap = await compareFrame(
		frame,
		g,
		cfg({ debugStages: true, nuisanceBaseline: baseline, noveltyThreshold: 0.3 }),
	);
	const stage = withMap.stages.nuisanceBaseline;
	assert.ok(stage, "the baseline is rendered when a map is loaded");
	const meta = await sharp(stage).metadata();
	assert.strictEqual(meta.width, g.width);
	assert.strictEqual(meta.height, g.height);
	// the one dirty block is red over the golden, its neighbour is not
	const rgb = await sharp(stage).raw().toBuffer();
	const at = (x, y) => rgb.subarray((y * g.width + x) * 3, (y * g.width + x) * 3 + 3);
	const dirty = at(4, 4);
	const clean = at(BASE_CFG.blockSize + 4, 4);
	assert.ok(dirty[0] > dirty[1] + 40, `block 0 should be tinted red, got ${[...dirty]}`);
	assert.ok(Math.abs(clean[0] - clean[1]) < 8, `block 1 should be grey, got ${[...clean]}`);
	assert.strictEqual(
		Object.keys(without.stages).length + 1,
		Object.keys(withMap.stages).length,
		"the other stages are unchanged",
	);
});

test("the nuisance map gates the background channel only, never the print channel", async () => {
	// the density and ratio gates are switched off, so only the novelty
	// gate can fail a channel here
	const loose = { failThreshold: 1, failRatio: 1, blockThreshold: 0.05, noveltyThreshold: 0.3 };
	const g = await prepareGolden(await png(labelSvg(300, 450)), cfg(loose));
	const probe = await compareFrame(await png(labelSvg(300, 450)), g, cfg(loose));
	const zeros = new Float32Array(probe.backgroundBlemish.gridW * probe.backgroundBlemish.gridH);
	// a bar dropped: missing ink, dense in its blocks
	const missing = await compareFrame(
		await png(labelSvg(300, 450, { missingBar: true })),
		g,
		cfg({ ...loose, nuisanceBaseline: zeros }),
	);
	assert.ok(missing.printBlemish.regions.length > 0, "the dropped bar is a print region");
	assert.ok(missing.printBlemish.regions[0].density >= 0.3, "dense enough to trip a novelty gate");
	assert.strictEqual(missing.printBlemish.pass, true, "but print is not judged by the map");
	assert.strictEqual(missing.printBlemish.worstExcess, 0);
	assert.strictEqual(missing.printBlemish.noveltyPass, true);
	// a blob added: extra ink, which the map does judge
	const extra = await compareFrame(
		await png(labelSvg(300, 450, { extraBlob: { x: 150, y: 380, w: 40, h: 30 } })),
		g,
		cfg({ ...loose, nuisanceBaseline: zeros }),
	);
	assert.ok(extra.backgroundBlemish.worstExcess >= 0.3, `excess ${extra.backgroundBlemish.worstExcess}`);
	assert.strictEqual(extra.backgroundBlemish.noveltyPass, false);
	assert.strictEqual(extra.backgroundBlemish.pass, false, "background still fails on novelty");
});

// The rig's left edge: a few px of substrate past the label's die-cut
// edge, full height, dark against the golden's white border. It is not a
// mark on the artwork, yet at x=0 it is one block column at density 0.75+
// and trips the background density gate on a good part.
test("edgeMargin: substrate past the label's edge is not a background blemish", async () => {
	const w = 1024;
	const h = 700;
	const golden = await prepareGolden(await png(labelSvg(w, h)), cfg());
	const frame = await png(
		labelSvg(w, h, { extraBlob: { x: 0, y: 0, w: 12, h, fill: "#333" } }),
	);

	const bare = await compareFrame(frame, golden, cfg());
	assert.strictEqual(
		bare.backgroundBlemish.pass,
		false,
		"without a margin the strip is a background defect",
	);
	assert.ok(
		bare.backgroundBlemish.regions.some((r) => r.x === 0 && r.h > h / 2),
		"the defect is the full-height strip at x=0",
	);

	const trimmed = await compareFrame(frame, golden, cfg({ edgeMargin: 16 }));
	assert.strictEqual(trimmed.backgroundBlemish.pass, true);
	assert.ok(
		trimmed.backgroundBlemish.defectRatio < 0.0002,
		`background defect ratio should be negligible, got ${trimmed.backgroundBlemish.defectRatio.toFixed(5)}`,
	);
	assert.ok(
		!trimmed.backgroundBlemish.regions.some((r) => r.x < 16),
		"nothing inside the margin is reported",
	);
	assert.strictEqual(trimmed.printBlemish.pass, true);
	assert.strictEqual(trimmed.position.pass, true);
});
