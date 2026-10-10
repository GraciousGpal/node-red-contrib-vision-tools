/**
 * Whole frames through compareFrame on the pool, once with the native
 * kernels and once with VISION_TOOLS_KERNELS=js: the results, the overlay
 * and the stages must be the same to the byte. test/nativeKernels.test.js
 * holds each kernel to its JS twin on synthetic dispatches; this holds the
 * pipeline to it on the dispatches a frame actually makes - the local
 * alignment's field and resampling with the tone check's counts, the
 * binarization with the tone comparison riding on it, the one-pass diff -
 * from several workers at once. Skipped where no binary loads.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { shutdown, poolSize } = require("../lib/pool.js");
const { HAS_SAB } = require("../lib/shared.js");
const nativeKernels = require("../lib/nativeKernels.js");

const status = nativeKernels.status();
// the native kernels as this process loads them: the prebuild, or a
// build from source under VISION_TOOLS_KERNELS=source
const NATIVE = nativeKernels.mode() === "source" ? "source" : undefined;
const setKernels = (v) => {
	if (v === undefined) delete process.env.VISION_TOOLS_KERNELS;
	else process.env.VISION_TOOLS_KERNELS = v;
};
const SKIP = !HAS_SAB
	? "no SharedArrayBuffer"
	: poolSize(4) < 2
		? "no worker pool on this host"
		: status.native
			? false
			: `no native kernels here: ${status.reason}`;

const W = 900;
const H = 1200;
// a label on a slightly warped sheet, so the local alignment has a field
// to find, with the defects each check looks for
function labelSvg(extra = "", warp = 0) {
	const bars = [];
	for (let i = 0; i < 10; i++) {
		const dx = Math.round(warp * Math.sin(i));
		bars.push(`<rect x="${110 + dx}" y="${80 + i * 100 + (i % 3) * 7}" width="${i % 2 ? 420 : 640}" height="26" fill="#111"/>`);
		bars.push(`<rect x="${150 + dx}" y="${120 + i * 100}" width="${200 + i * 30}" height="10" fill="#555"/>`);
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
	localAlignMax: 4,
	maxAspect: 0.06,
	aspectSteps: 7,
	maxAngleDeg: 2,
	angleSteps: 5,
	positionToleranceAngleDeg: 1,
	printTolerance: 2,
	backgroundTolerance: 1,
	edgeMargin: 6,
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
	speckThreshold: 0.2,
	speckMinArea: 3,
	speckMaxCount: 8,
	speckMaxArea: 48,
	outputHeatmap: true,
	heatmapFormat: "png",
	thumbnailWidth: 0,
	debugStages: false,
};

const FRAMES = [
	["clean", labelSvg("", 2)],
	["blot", labelSvg('<rect x="300" y="500" width="90" height="60" fill="#000"/>', 3)],
	["missing ink", labelSvg('<rect x="120" y="290" width="200" height="40" fill="#fff"/>', 1)],
	// every grey from ink to paper, over a bar and over paper, so some
	// pixels sit exactly on each threshold and on the ambiguity band's
	// edges; and ink up to the frame's right edge, through the margin
	["gradients and an edge smudge", labelSvg(
		'<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
			'<rect x="110" y="280" width="640" height="26" fill="url(#g)"/>' +
			'<rect x="200" y="760" width="400" height="40" fill="url(#g)" opacity="0.6"/>' +
			`<rect x="${W - 24}" y="560" width="24" height="160" fill="#000"/>`,
		2,
	)],
	["faded patch and specks", labelSvg(
		'<rect x="500" y="700" width="200" height="120" fill="#bbb" opacity="0.5"/>' +
			'<rect x="250" y="980" width="3" height="3" fill="#777"/><rect x="620" y="150" width="4" height="3" fill="#888"/>',
		4,
	)],
];

/** Every frame's result with the kernels `mode` asks for: the JSON of it
 * without the timings, and the picture's bytes. */
async function run(mode, golden, cfg) {
	shutdown();
	// the pool's workers are spawned after this, so they see it
	if (mode === "js") process.env.VISION_TOOLS_KERNELS = "js";
	else setKernels(NATIVE);
	try {
		const out = [];
		for (const [name, svg] of FRAMES) {
			const r = await compareFrame(await sharp(svg).png().toBuffer(), golden, cfg);
			const stages = r.stages
				? Object.fromEntries(
						Object.entries(r.stages).map(([k, v]) => [k, v && v.data ? Buffer.from(v.data).toString("base64") : v]),
					)
				: null;
			out.push({ name, result: JSON.stringify({ ...r, timings: null, heatmap: null, stages }), heatmap: r.heatmap });
		}
		return out;
	} finally {
		shutdown();
		setKernels(NATIVE);
	}
}

test.after(() => shutdown());

for (const [label, cfg] of [
	["", CFG],
	[", with the stages", { ...CFG, debugStages: true, heatmapFormat: "raw" }],
]) {
	test(`whole frames come out the same with the native kernels as with the JS ones${label}`, { skip: SKIP }, async () => {
		const golden = await prepareGolden(await sharp(labelSvg()).png().toBuffer(), cfg);
		const js = await run("js", golden, cfg);
		const native = await run("native", golden, cfg);
		let failed = 0;
		for (let i = 0; i < FRAMES.length; i++) {
			assert.equal(native[i].result, js[i].result, `${FRAMES[i][0]}: the results differ`);
			const a = native[i].heatmap;
			const b = js[i].heatmap;
			assert.ok(Buffer.from(a.data || a).equals(Buffer.from(b.data || b)), `${FRAMES[i][0]}: the overlays differ`);
			const r = JSON.parse(js[i].result);
			if (!r.pass) failed++;
			// the dispatches this is about all ran
			assert.ok(r.localAlign, `${FRAMES[i][0]}: no local alignment`);
			assert.equal(r.toneBlemish.enabled, true, `${FRAMES[i][0]}: tone check off - ${r.toneBlemish.reason}`);
		}
		assert.ok(failed >= 2 && failed < FRAMES.length, `${failed} of ${FRAMES.length} frames failed: the defects must show`);
	});
}
