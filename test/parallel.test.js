/**
 * The parallel stages must agree with the serial ones exactly.
 *
 * Not "closely" — exactly. A divergence here would surface as a defect
 * that appears or disappears depending on how many cores the machine has,
 * or on whether an image happened to clear the size threshold for
 * splitting. That is close to the worst failure this project could have,
 * because it would look like a flaky camera rather than a bug.
 *
 * The fixtures are deliberately larger than the pool's minimum split size,
 * so these exercise the workers rather than quietly falling back.
 */

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { dilate } = require("../lib/dilate.js");
const {
	dilateParallel,
	defectParallel,
	binarizeParallel,
	warpParallel,
	refineLocallyParallel,
	buildIntegralParallel,
	buildGrayTableParallel,
} = require("../lib/parallel.js");
const { buildIntegral } = require("../lib/integral.js");
const { warpGray, buildGrayTable } = require("../lib/warp.js");
const { refineLocally } = require("../lib/localAlign.js");
const { shutdown } = require("../lib/pool.js");
const { HAS_SAB } = require("../lib/shared.js");

test.after(() => shutdown());

const W = 900;
const H = 900;

function noisy(width, height, salt) {
	const a = new Uint8Array(width * height);
	let seed = 12345 + salt * 7919;
	for (let i = 0; i < a.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		a[i] = (seed >> 16) & 0xff;
	}
	return a;
}
function binary(gray, level) {
	const b = new Uint8Array(gray.length);
	for (let i = 0; i < gray.length; i++) b[i] = gray[i] < level ? 1 : 0;
	return b;
}
function same(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

test("parallel dilation is byte-identical to serial", {
	skip: !HAS_SAB,
}, async () => {
	const src = binary(noisy(W, H, 1), 128);
	for (const radius of [1, 2, 5]) {
		const serial = dilate(src, W, H, radius);
		const parallel = await dilateParallel(src, W, H, radius, 4);
		assert.ok(same(serial, parallel), `dilate radius ${radius} diverged`);
	}
});

test("the parallel summed-area table is byte-identical to serial", {
	skip: !HAS_SAB,
}, async () => {
	// A table is only useful if every entry matches: the sweeps read it as
	// four corner lookups, so one wrong cell moves a candidate's score
	// without anything else looking wrong.
	const src = binary(noisy(W, H, 7), 128);
	const serial = buildIntegral(src, W, H);
	for (const workers of [2, 4, 8]) {
		const par = await buildIntegralParallel(src, W, H, workers);
		assert.strictEqual(par.stride, serial.stride, `stride differs at ${workers}`);
		assert.strictEqual(par.width, serial.width);
		assert.strictEqual(par.height, serial.height);
		assert.ok(
			same(serial.integral, par.integral),
			`summed-area table diverged with ${workers} workers`,
		);
	}
});

// A caller under the split threshold, or asking for one worker, must get
// the serial table rather than an empty one - the fallback is the whole
// reason the serial twin stays.
test("the parallel summed-area table falls back to serial when it cannot split", async () => {
	const src = binary(noisy(64, 48, 11), 128);
	const serial = buildIntegral(src, 64, 48);
	const one = await buildIntegralParallel(src, 64, 48, 1);
	assert.ok(same(serial.integral, one.integral), "one worker diverged");
	const small = await buildIntegralParallel(src, 64, 48, 4);
	assert.ok(same(serial.integral, small.integral), "small fixture diverged");
});

// Float64 addition is not associative in general; it is here only because
// every partial sum is a small exact integer. If that ever stops being
// true this test is what catches it.
test("the parallel grey summed-area table is byte-identical to serial", {
	skip: !HAS_SAB,
}, async () => {
	const gray = noisy(W, H, 13);
	const serial = buildGrayTable(gray, W, H);
	for (const workers of [2, 4, 8]) {
		const par = await buildGrayTableParallel(gray, W, H, workers);
		assert.strictEqual(par.stride, serial.stride);
		assert.ok(
			same(serial.integral, par.integral),
			`grey summed-area table diverged with ${workers} workers`,
		);
	}
	const one = await buildGrayTableParallel(gray, W, H, 1);
	assert.ok(same(serial.integral, one.integral), "one worker diverged");
});

test("parallel binarize is byte-identical to serial", {
	skip: !HAS_SAB,
}, async () => {
	const gray = noisy(W, H, 2);
	const level = 137;
	const margin = 9;
	const par = await binarizeParallel(gray, W, H, level, margin, 4);
	assert.ok(par, "precondition: the fixture should be big enough to split");
	for (let i = 0; i < gray.length; i++) {
		assert.strictEqual(par.fg[i], gray[i] < level ? 1 : 0, `fg differs at ${i}`);
		assert.strictEqual(
			par.ambiguous[i],
			gray[i] >= level - margin && gray[i] <= level + margin ? 1 : 0,
			`ambiguity differs at ${i}`,
		);
	}
});

test("parallel defect matches, count included", {
	skip: !HAS_SAB,
}, async () => {
	const a = binary(noisy(W, H, 3), 120);
	const b = binary(noisy(W, H, 4), 120);
	const amb = binary(noisy(W, H, 5), 20);
	const par = await defectParallel(a, b, amb, null, W, H, 4);
	assert.ok(par, "precondition: should have run in parallel");

	let count = 0;
	for (let i = 0; i < a.length; i++) {
		let d = a[i] & ~b[i] & 1;
		if (d && amb[i]) d = 0;
		assert.strictEqual(par.defect[i], d, `defect differs at ${i}`);
		count += d;
	}
	assert.strictEqual(
		par.count,
		count,
		"the count must match the mask it describes",
	);
});

// The end-to-end frame test below never exercises the area-average warp
// path (identical canvases land at m ~= 1, which takes the bilinear
// branch), so this pins it directly: the worker kernel reads the same
// Float64 summed-area table through the same warpRows, and the fractional
// footprint must produce byte-identical output either way.
test("parallel area-average warp is byte-identical to serial", {
	skip: !HAS_SAB,
}, async () => {
	const srcW = 900;
	const srcH = 800;
	const src = noisy(srcW, srcH, 9);
	const outW = 700;
	const outH = 600;
	const table = buildGrayTable(src, srcW, srcH);
	// fractional magnifications on both axes - the corners of the
	// footprints stay fractional, which is the path that used to differ
	const serial = warpGray(
		src,
		srcW,
		srcH,
		2.5,
		1.75,
		0.01,
		3.5,
		-2.25,
		outW,
		outH,
		255,
		table,
	);
	const par = await warpParallel(
		src,
		srcW,
		srcH,
		2.5,
		1.75,
		0.01,
		3.5,
		-2.25,
		outW,
		outH,
		255,
		table,
		4,
	);
	assert.ok(par, "precondition: the output must be large enough to split");
	assert.ok(
		same(serial, par),
		"the fractional area-average warp diverged between serial and parallel",
	);
});

// warpParallel only dispatches when a summed-area table is handed in AND
// the magnification clears 1.001 - without either it must fall back to
// the serial implementation. The fallback is not a different resampling;
// it IS warpGray, so assert that byte for byte.
test("parallel warp without a summed-area table falls back to serial", {
	skip: !HAS_SAB,
}, async () => {
	const srcW = 900;
	const srcH = 800;
	const src = noisy(srcW, srcH, 10);
	const outW = 700;
	const outH = 600;
	for (const [mx, my] of [
		[2.5, 1.75], // m > 1: serial takes the area-average path, building its own table
		[0.8, 0.9], // m <= 1: the bilinear path
	]) {
		const serial = warpGray(
			src,
			srcW,
			srcH,
			mx,
			my,
			0.01,
			3.5,
			-2.25,
			outW,
			outH,
			255,
			null,
		);
		const par = await warpParallel(
			src,
			srcW,
			srcH,
			mx,
			my,
			0.01,
			3.5,
			-2.25,
			outW,
			outH,
			255,
			null, // no table: must take the serial fallback, not a copy
			4,
		);
		assert.ok(same(serial, par), `the no-table warp diverged at m=(${mx},${my})`);
	}
});

// The end-to-end frame test below also never exercises the parallel local
// refinement (the pipeline fixture's canvas is under the split threshold
// and the transform lands at m ~= 1), so this pins it directly the same
// way the warp is pinned: the workers call the same fieldRows/applyRows
// through the same shared memory, and both halves must come out
// byte-identical to the serial refinement.
test("parallel local refinement is byte-identical to serial", {
	skip: !HAS_SAB,
}, async () => {
	const W = 900;
	const H = 900;
	const goldenGray = noisy(W, H, 7);
	// the whole frame displaced by (1, 2) - inside the 3px cap, so the
	// field has something real to recover instead of a tie at zero
	const target = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		const sy = Math.min(H - 1, Math.max(0, y - 2));
		for (let x = 0; x < W; x++) {
			const sx = Math.min(W - 1, Math.max(0, x - 1));
			target[y * W + x] = goldenGray[sy * W + sx];
		}
	}
	const cfg = {
		localAlignTile: 96,
		localAlignMax: 3,
		localAlignMinStdDev: 12,
		workers: 4,
	};
	const serial = refineLocally(goldenGray, target, W, H, cfg);
	const par = await refineLocallyParallel(goldenGray, target, W, H, cfg);
	assert.ok(par, "precondition: the fixture must be big enough to split");
	assert.ok(
		serial.stats.meanPx > 1,
		`precondition: the field should recover the shift, got ${serial.stats.meanPx}`,
	);
	assert.ok(same(serial.gray, par.gray), "the corrected grey diverged");
	assert.ok(same(serial.field.fx, par.field.fx), "the fx field diverged");
	assert.ok(same(serial.field.fy, par.field.fy), "the fy field diverged");
	assert.ok(
		same(serial.field.valid, par.field.valid),
		"the validity field diverged",
	);
	assert.deepStrictEqual(par.stats, serial.stats);
	assert.strictEqual(par.tile, serial.tile);
});

// The one that matters: the whole pipeline, same verdict either way.
test("a frame compares identically with and without workers", {
	skip: !HAS_SAB,
}, async () => {
	const bars = [0.12, 0.21, 0.34, 0.43, 0.58, 0.66, 0.79]
		.map(
			(f, i) =>
				`<rect x="${120 + i * 11}" y="${Math.round(1500 * f)}" width="${420 - i * 23}" height="26" fill="#111"/>`,
		)
		.join("");
	const svg = (extra) =>
		Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1500">` +
				`<rect width="100%" height="100%" fill="#fff"/>` +
				bars +
				`<circle cx="820" cy="1180" r="70" fill="none" stroke="#111" stroke-width="9"/>` +
				extra +
				`</svg>`,
		);
	const goldenBuf = await sharp(svg("")).png().toBuffer();
	const targetBuf = await sharp(
		svg('<rect x="300" y="900" width="180" height="120" fill="#000"/>'),
	)
		.png()
		.toBuffer();

	const cfg = (workers) => ({
		workingSize: 1024,
		threshold: 128,
		thresholdMode: "otsu",
		sauvolaRadius: 24,
		sauvolaK: 0.2,
		inkMargin: 8,
		alignCandidates: 5,
		localAlign: true,
		localAlignTile: 96,
		localAlignMax: 3,
		scaleSearchMin: 0.6,
		scaleSearchMax: 2.5,
		scaleSearchSteps: 19,
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
		debugStages: false,
		outputPrintHeatmap: false,
		outputBackgroundHeatmap: false,
		mmPerPixelNative: null,
		workers,
	});

	const serial = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, cfg(1)),
		cfg(1),
	);
	const parallel = await compareFrame(
		targetBuf,
		await prepareGolden(goldenBuf, cfg(4)),
		cfg(4),
	);

	assert.ok(
		serial.backgroundBlemish.regions.length > 0,
		"precondition: the blob is found",
	);
	assert.strictEqual(
		parallel.printBlemish.defectRatio,
		serial.printBlemish.defectRatio,
	);
	assert.strictEqual(
		parallel.backgroundBlemish.defectRatio,
		serial.backgroundBlemish.defectRatio,
	);
	assert.strictEqual(
		parallel.backgroundBlemish.regions.length,
		serial.backgroundBlemish.regions.length,
	);
	assert.strictEqual(parallel.position.dxPx, serial.position.dxPx);
	assert.strictEqual(parallel.position.dyPx, serial.position.dyPx);
	assert.strictEqual(parallel.pass, serial.pass);
});

// ---- rectify -------------------------------------------------------------

test("rectifyParallel is byte-identical to the serial warpPerspective", async () => {
	const { rectifyParallel } = require("../lib/parallel.js");
	const { warpPerspective } = require("../lib/rectify.js");
	const width = 900;
	const height = 700; // 630k px, above MIN_PIXELS_TO_SPLIT
	for (const channels of [1, 3]) {
		const data = new Uint8Array(width * height * channels);
		let seed = 3;
		for (let i = 0; i < data.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			data[i] = seed & 255;
		}
		const src = { data, width, height, channels };
		const H = [1.02, 0.004, -3.5, -0.003, 0.98, 6.25, 2e-6, -3e-6, 1];
		const serial = warpPerspective(src, H);
		const pooled = await rectifyParallel(src, H, 4);
		assert.notStrictEqual(pooled, serial);
		assert.strictEqual(Buffer.compare(Buffer.from(pooled.data), Buffer.from(serial.data)), 0, `${channels}ch differs`);
	}
});
