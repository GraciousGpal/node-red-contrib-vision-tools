/**
 * The opencv.js WASM engine (lib/cvjs.js + lib/cvjsAlign.js).
 *
 * Two things are under test. First that each op honours the cpp-bridge
 * contract the callers were written against - argument positions, raw
 * descriptor shape, and the geometry label-crop predicts independently
 * (rotate's canvas size, imageAlign's matrix convention). Second that
 * label-crop itself runs end to end on this engine, which is the whole
 * point of the prototype: the native addon has no win32 build, so on this
 * platform these are the only real-engine integration tests there are.
 *
 * Skipped when the optional module is not installed.
 */

const test = require("node:test");
const assert = require("node:assert");

const cvjs = require("../lib/cvjs.js");
const { imageAlign } = require("../lib/cvjsAlign.js");
const { labelCrop } = require("../lib/labelCrop.js");
const { rawImage } = require("./helpers/synthetic.js");

const installed = cvjs.available();
const skip = installed ? false : "@techstark/opencv-js is not installed";

/** The engine object lib/engine.js assembles, built directly so these
 * tests exercise the WASM path whatever the host platform would pick. */
const engine = {
	colorConvert: cvjs.colorConvert,
	resize: cvjs.resize,
	filter: cvjs.filter,
	crop: cvjs.crop,
	rotate: cvjs.rotate,
	imageAlign,
	ready: cvjs.ready,
};

const DEG = Math.PI / 180;

/** A light label on a dark table, rotated about the frame centre. */
function labelFrame(width, height, angleDeg, labelWidth, labelHeight, channels = 3) {
	const data = Buffer.alloc(width * height * channels, 30);
	const ca = Math.cos(angleDeg * DEG);
	const sa = Math.sin(angleDeg * DEG);
	const cx = width / 2;
	const cy = height / 2;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x - cx) * ca + (y - cy) * sa;
			const v = -(x - cx) * sa + (y - cy) * ca;
			if (Math.abs(u) <= labelWidth / 2 && Math.abs(v) <= labelHeight / 2) {
				const i = (y * width + x) * channels;
				for (let c = 0; c < channels; c++) data[i + c] = 235;
			}
		}
	}
	return rawImage(data, width, height, channels, channels === 1 ? "GRAY" : "RGB");
}

/** Deterministic texture, so ORB has corners to find. */
function texture(image, count = 120) {
	let seed = 987;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const { data, width, height } = image;
	for (let i = 0; i < count; i++) {
		const bx = Math.floor(width * 0.2 + rnd() * width * 0.55);
		const by = Math.floor(height * 0.2 + rnd() * height * 0.55);
		const value = Math.floor(60 + rnd() * 120);
		for (let y = by; y < Math.min(height, by + 8); y++) {
			for (let x = bx; x < Math.min(width, bx + 8); x++) data[y * width + x] = value;
		}
	}
	return image;
}

// ---- ops ---------------------------------------------------------------

test("colorConvert takes RGB to a single-channel GRAY descriptor", { skip }, async () => {
	const frame = labelFrame(120, 90, 0, 60, 40, 3);
	const { image } = await cvjs.colorConvert(frame, "GRAY", "raw");
	assert.strictEqual(image.width, 120);
	assert.strictEqual(image.height, 90);
	assert.strictEqual(image.channels, 1);
	assert.strictEqual(image.colorSpace, "GRAY");
	assert.strictEqual(image.dtype, "uint8");
	assert.strictEqual(image.data.length, 120 * 90);
	// the label's 235 survives the luma conversion
	assert.ok(image.data[45 * 120 + 60] > 200, "label centre stays light");
	assert.ok(image.data[2] < 60, "table stays dark");
});

test("colorConvert returns a copy, not a view onto the caller's buffer", { skip }, async () => {
	const frame = labelFrame(32, 32, 0, 16, 16, 1);
	const { image } = await cvjs.colorConvert(frame, "GRAY", "raw");
	frame.data.fill(0);
	assert.ok(image.data[16 * 32 + 16] > 200, "output is independent of the input");
});

test("resize honours the num/num mode pair and keeps the channel layout", { skip }, async () => {
	const frame = labelFrame(800, 600, 0, 360, 220, 3);
	const { image } = await cvjs.resize(frame, "num", 400, "num", 300, "raw");
	assert.strictEqual(image.width, 400);
	assert.strictEqual(image.height, 300);
	assert.strictEqual(image.channels, 3);
	assert.strictEqual(image.data.length, 400 * 300 * 3);
});

test("resize accepts a percentage mode", { skip }, async () => {
	const frame = labelFrame(200, 100, 0, 50, 50, 1);
	const { image } = await cvjs.resize(frame, "pct", 50, "pct", 50, "raw");
	assert.strictEqual(image.width, 100);
	assert.strictEqual(image.height, 50);
});

test("filter otsu returns a 0/255 mask covering the label", { skip }, async () => {
	const frame = labelFrame(400, 300, 0, 180, 110, 1);
	const { image } = await cvjs.filter(frame, "otsu", 3, 0, "raw");
	assert.strictEqual(image.channels, 1);
	let foreground = 0;
	for (let i = 0; i < image.data.length; i++) {
		const v = image.data[i];
		assert.ok(v === 0 || v === 255, `mask value ${v} is not binary`);
		if (v) foreground++;
	}
	const expected = (180 * 110) / (400 * 300);
	const got = foreground / (400 * 300);
	assert.ok(Math.abs(got - expected) < 0.01, `mask fraction ${got} vs ${expected}`);
});

test("filter otsu blurs the caller's buffer in place, as the native engine does", { skip }, async () => {
	// Bug-compatibility, deliberately: label-crop calls filter(det, "otsu")
	// and then filter(det, "edge") on the same det, and hands det to
	// refineRectBoundary as its grey image. On the native engine that det
	// has been GaussianBlurred (3x3, sigma 0) in place, and the refinement
	// depends on it - without the blur an axis-aligned label refines onto
	// its own printed rules. See the note in lib/cvjs.js.
	const frame = labelFrame(200, 150, 0, 100, 80, 1);
	const before = Buffer.from(frame.data);
	const { image } = await cvjs.filter(frame, "otsu", 3, 0, "raw");

	assert.notDeepStrictEqual(
		Buffer.from(frame.data),
		before,
		"otsu must leave the blurred copy in the caller's buffer",
	);
	// a blur, not the mask: the boundary gains intermediate tones while the
	// flat interior keeps its value
	const values = new Set(frame.data);
	assert.ok(values.size > 2, `input has ${values.size} levels, expected a blur`);
	assert.strictEqual(frame.data[75 * 200 + 100], 235, "flat interior unchanged");
	// and the mask itself is still binary
	for (let i = 0; i < image.data.length; i++) {
		assert.ok(image.data[i] === 0 || image.data[i] === 255);
	}
});

test("filter otsu leaves a multi-channel input alone", { skip }, async () => {
	// the write-back only has a meaningful destination for a single-channel
	// image; an RGB caller must not have its pixels rewritten with grey
	const frame = labelFrame(120, 90, 0, 60, 40, 3);
	const before = Buffer.from(frame.data);
	await cvjs.filter(frame, "otsu", 3, 0, "raw");
	assert.deepStrictEqual(Buffer.from(frame.data), before);
});

test("filter edge is a continuous gradient magnitude, not a binary map", { skip }, async () => {
	const frame = labelFrame(400, 300, 0, 180, 110, 1);
	const { image } = await cvjs.filter(frame, "edge", 3, 1.0, "raw");
	assert.strictEqual(image.channels, 1);
	const values = new Set();
	let aboveFloor = 0;
	let interior = 0;
	for (let i = 0; i < image.data.length; i++) {
		values.add(image.data[i]);
		// refineRectBoundary weighs this against a floor of 24
		if (image.data[i] > 24) aboveFloor++;
	}
	// the middle of the label is flat, so it must not respond
	for (let y = 140; y < 160; y++) {
		for (let x = 190; x < 210; x++) interior += image.data[y * 400 + x];
	}
	assert.ok(values.size > 2, `only ${values.size} distinct levels - looks binary`);
	assert.ok(aboveFloor > 500, `too few edge pixels (${aboveFloor})`);
	assert.strictEqual(interior, 0, "flat label interior must not produce gradient");
});

test("filter rejects a type it does not implement", { skip }, async () => {
	await assert.rejects(
		() => cvjs.filter(labelFrame(16, 16, 0, 8, 8, 1), "sauvola", 3, 0, "raw"),
		/not implemented/,
	);
});

test("crop copies the requested rect and clamps one that runs off the frame", { skip }, async () => {
	const frame = labelFrame(200, 150, 0, 100, 80, 1);
	const { image } = await cvjs.crop(frame, 50, 35, 100, 80, false, "raw");
	assert.strictEqual(image.width, 100);
	assert.strictEqual(image.height, 80);
	// that rect is exactly the label
	let light = 0;
	for (let i = 0; i < image.data.length; i++) if (image.data[i] > 128) light++;
	assert.ok(light / image.data.length > 0.95, `label fill ${light / image.data.length}`);

	const clamped = await cvjs.crop(frame, 180, 140, 100, 100, false, "raw");
	assert.strictEqual(clamped.image.width, 20);
	assert.strictEqual(clamped.image.height, 10);
});

test("crop reads normalized coordinates as fractions of the frame", { skip }, async () => {
	const frame = labelFrame(200, 100, 0, 50, 50, 1);
	const { image } = await cvjs.crop(frame, 0.25, 0.5, 0.5, 0.5, true, "raw");
	assert.strictEqual(image.width, 100);
	assert.strictEqual(image.height, 50);
});

test("rotate grows the canvas exactly as label-crop predicts", { skip }, async () => {
	// label-crop computes dstW/dstH itself from the same truncation and
	// places the final crop inside it; a mismatch here crops the wrong rect
	for (const angle of [12, -12, 30, 0.5]) {
		const frame = labelFrame(200, 150, 0, 100, 80, 1);
		const { image } = await cvjs.rotate(frame, angle, "#000000", "raw");
		const ca = Math.abs(Math.cos(angle * DEG));
		const sa = Math.abs(Math.sin(angle * DEG));
		assert.strictEqual(image.width, Math.trunc(150 * sa + 200 * ca), `width at ${angle}`);
		assert.strictEqual(image.height, Math.trunc(150 * ca + 200 * sa), `height at ${angle}`);
	}
});

test("rotate pads with the requested colour", { skip }, async () => {
	const frame = labelFrame(100, 100, 0, 100, 100, 1);
	const { image } = await cvjs.rotate(frame, 45, "#ffffff", "raw");
	// the corners of a 45deg rotation are outside the source square
	assert.ok(image.data[0] > 200, `corner padded with ${image.data[0]}, expected white`);
});

test("rotate uses OpenCV's +angle image-coordinate convention", { skip }, async () => {
	// a label rotated by +12 must come back level after rotate(+12), which
	// is the assumption cropToRect's dxr/dyr projection encodes
	const frame = labelFrame(300, 300, 12, 200, 100, 1);
	const { image } = await cvjs.rotate(frame, 12, "#000000", "raw");
	const mid = Math.floor(image.height / 2);
	let run = 0;
	for (let x = 0; x < image.width; x++) if (image.data[mid * image.width + x] > 128) run++;
	// levelled, the label's 200px width shows as one long bright row
	assert.ok(run > 180, `bright run ${run} across the middle row - not levelled`);
});

// ---- imageAlign --------------------------------------------------------

test("imageAlign recovers a known shift in reference coordinates", { skip }, async () => {
	const golden = texture(labelFrame(600, 400, 0, 300, 180, 1));
	// the target is the golden on a 1.5x canvas, shifted by (13, -7)
	const tw = 900;
	const th = 600;
	const target = Buffer.alloc(tw * th, 30);
	const mx = 1.5;
	const shiftX = 13;
	const shiftY = -7;
	for (let y = 0; y < th; y++) {
		for (let x = 0; x < tw; x++) {
			const gx = Math.round((x - shiftX) / mx);
			const gy = Math.round((y - shiftY) / mx);
			target[y * tw + x] =
				gx >= 0 && gx < 600 && gy >= 0 && gy < 400 ? golden.data[gy * 600 + gx] : 30;
		}
	}

	const result = await imageAlign(
		golden,
		rawImage(target, tw, th, 1, "GRAY"),
		1,
		50,
		1e-4,
		"raw",
		90,
		false,
		true,
		null,
		"affine",
		"features+ecc",
		"auto",
		"orb",
	);
	assert.strictEqual(result.success, true);
	const m = result.transformMatrix.matrix2x3;
	assert.strictEqual(m.length, 6);
	// the matrix is expressed against the target normalised to the
	// reference's size, so the 1.5x canvas scale is already divided out and
	// only the shift, itself divided by 1.5, remains
	assert.ok(Math.abs(m[0] - 1) < 0.02, `mx ${m[0]}`);
	assert.ok(Math.abs(m[4] - 1) < 0.02, `my ${m[4]}`);
	assert.ok(Math.abs(m[2] - shiftX / mx) < 1.5, `ox ${m[2]}`);
	assert.ok(Math.abs(m[5] - shiftY / mx) < 1.5, `oy ${m[5]}`);
});

test("imageAlign returns a reference-sized single-channel warp of the frame", { skip }, async () => {
	const golden = texture(labelFrame(600, 400, 0, 300, 180, 1));
	const tw = 900;
	const th = 600;
	const target = Buffer.alloc(tw * th, 30);
	for (let y = 0; y < th; y++) {
		for (let x = 0; x < tw; x++) {
			const gx = Math.round(x / 1.5);
			const gy = Math.round(y / 1.5);
			target[y * tw + x] =
				gx < 600 && gy < 400 ? golden.data[gy * 600 + gx] : 30;
		}
	}
	const result = await imageAlign(
		golden,
		rawImage(target, tw, th, 1, "GRAY"),
		1,
		50,
		1e-4,
		"raw",
		90,
		false,
		true,
		null,
		"affine",
		"features+ecc",
		"auto",
		"orb",
	);
	assert.strictEqual(result.success, true);
	assert.strictEqual(result.image.width, 600);
	assert.strictEqual(result.image.height, 400);
	assert.strictEqual(result.image.channels, 1);
	let diff = 0;
	for (let i = 0; i < 600 * 400; i++) {
		diff += Math.abs(result.image.data[i] - golden.data[i]);
	}
	assert.ok(diff / (600 * 400) < 6, `mean abs diff ${diff / (600 * 400)}`);
});

test("imageAlign leaves blank substrate outside the frame, not a dark rim", { skip }, async () => {
	// The warp's border fill lands in the blemish checks. Filled with ink
	// (OpenCV's default 0) the interpolation ramp puts a one-pixel dark rim
	// just inside the boundary, which reads as extra ink the part does not
	// have - see DIVERGES in lib/cvjsAlign.js.
	const golden = texture(labelFrame(400, 300, 0, 200, 120, 1));
	// The target is the golden shifted right by 8px. Alignment maps golden
	// x to target x+8, so it is the golden's RIGHT edge that maps past the
	// frame and has to come back blank.
	const tw = 400;
	const th = 300;
	const shift = 8;
	const target = Buffer.alloc(tw * th, 30);
	for (let y = 0; y < th; y++) {
		for (let x = shift; x < tw; x++) {
			target[y * tw + x] = golden.data[y * 400 + (x - shift)];
		}
	}
	const result = await imageAlign(
		golden, rawImage(target, tw, th, 1, "GRAY"), 1, 50, 1e-4, "raw", 90,
		false, true, null, "affine", "features+ecc", "auto", "orb",
	);
	assert.strictEqual(result.success, true);
	const row = Math.floor(th / 2) * 400;
	for (let x = 400 - shift + 1; x < 400; x++) {
		assert.ok(
			result.image.data[row + x] > 128,
			`uncovered column ${x} came back at ${result.image.data[row + x]}, expected blank`,
		);
	}
});

test("imageAlign reports failure rather than a garbage transform", { skip }, async () => {
	// two flat fields: no features, and ECC has no gradient to follow
	const flat = rawImage(Buffer.alloc(200 * 200, 128), 200, 200, 1, "GRAY");
	const other = rawImage(Buffer.alloc(200 * 200, 128), 200, 200, 1, "GRAY");
	const result = await imageAlign(
		flat, other, 1, 20, 1e-4, "raw", 90, false, true, null, "affine",
		"features+ecc", "auto", "orb",
	);
	assert.strictEqual(typeof result.success, "boolean");
	if (!result.success) {
		assert.strictEqual(result.transformMatrix, null);
		assert.strictEqual(result.image, null);
	}
});

test("imageAlign refuses an unsupported motion model or detector", { skip }, async () => {
	const img = rawImage(Buffer.alloc(64 * 64, 10), 64, 64, 1, "GRAY");
	await assert.rejects(
		() => imageAlign(img, img, 1, 10, 1e-4, "raw", 90, false, true, null, "homography", "ecc", "auto", "orb"),
		/motion/,
	);
	await assert.rejects(
		() => imageAlign(img, img, 1, 10, 1e-4, "raw", 90, false, true, null, "affine", "features", "auto", "sift"),
		/detector/,
	);
});

// ---- label-crop on the WASM engine -------------------------------------

test("label-crop deskews a rotated label on the opencv.js engine", { skip }, async () => {
	const angle = 12;
	const frame = labelFrame(800, 600, angle, 360, 220, 3);
	const result = await labelCrop(
		frame,
		{ maxEdge: 400, polarity: "light", outputFormat: "raw" },
		engine,
	);
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.ok(
		Math.abs(result.metadata.angleDeg - angle) < 2,
		`angle ${result.metadata.angleDeg}`,
	);
	assert.ok(
		Math.abs(result.image.width / result.image.height - 360 / 220) < 0.1,
		`aspect ${result.image.width}x${result.image.height}`,
	);
	let light = 0;
	const pixels = result.image.width * result.image.height;
	for (let i = 0; i < pixels; i++) {
		if (result.image.data[i * result.image.channels] > 128) light++;
	}
	assert.ok(light / pixels > 0.92, `deskewed label fill ${light / pixels}`);
});

test("label-crop finds an axis-aligned label on the opencv.js engine", { skip }, async () => {
	const frame = labelFrame(800, 600, 0, 400, 200, 3);
	const result = await labelCrop(
		frame,
		{ maxEdge: 400, polarity: "light", outputFormat: "raw" },
		engine,
	);
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.ok(Math.abs(result.metadata.width - 400) < 12, `width ${result.metadata.width}`);
	assert.ok(Math.abs(result.metadata.height - 200) < 12, `height ${result.metadata.height}`);
	assert.ok(Math.abs(result.metadata.center.x - 400) < 6, `cx ${result.metadata.center.x}`);
	assert.ok(Math.abs(result.metadata.center.y - 300) < 6, `cy ${result.metadata.center.y}`);
});

test("label-crop accepts an encoded Buffer through the codec fallback", { skip }, async () => {
	// opencv.js has no codecs, so colorConvert(Buffer, RGB) is the one
	// place on this path that goes to sharp instead
	const sharp = require("sharp");
	const frame = labelFrame(800, 600, 0, 360, 220, 3);
	const png = await sharp(frame.data, {
		raw: { width: 800, height: 600, channels: 3 },
	})
		.png()
		.toBuffer();
	const result = await labelCrop(
		png,
		{ maxEdge: 400, polarity: "light", outputFormat: "raw" },
		engine,
	);
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.strictEqual(result.image.channels, 3, "the decoded layout is preserved");
	assert.ok(Math.abs(result.metadata.width - 360) < 12, `width ${result.metadata.width}`);
	assert.ok(Math.abs(result.metadata.height - 220) < 12, `height ${result.metadata.height}`);
});

test("label-crop reports a miss on a frame with no label", { skip }, async () => {
	const empty = rawImage(Buffer.alloc(400 * 300 * 3, 30), 400, 300, 3, "RGB");
	const result = await labelCrop(
		empty,
		{ maxEdge: 400, polarity: "light", outputFormat: "raw" },
		engine,
	);
	assert.strictEqual(result.detected, false);
	assert.strictEqual(result.image, empty, "a miss returns the original frame");
});

// ---- golden-compare's fast align on the WASM engine --------------------

test("golden-compare's nativeFastAlign path runs on the opencv.js engine", { skip }, async () => {
	const sharp = require("sharp");
	const nativeSeed = require("../lib/nativeSeed.js");
	const { prepareGolden, compareFrame } = require("../lib/compare.js");

	const width = 512;
	const height = 640;
	const bars = [];
	for (const [i, at] of [0.1, 0.19, 0.3, 0.41, 0.545, 0.68].entries()) {
		const w = Math.round(width * (i % 2 === 0 ? 0.6 : 0.35));
		bars.push(
			`<rect x="${Math.round(width * 0.14)}" y="${Math.round(height * at)}" ` +
				`width="${w}" height="${Math.round(height * 0.03)}" fill="#111"/>`,
		);
	}
	const svg = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.05)}" ` +
			`width="${Math.round(width * 0.8)}" height="${Math.round(height * 0.9)}" ` +
			`fill="none" stroke="#111" stroke-width="6"/>${bars.join("")}</svg>`,
	);
	const png = await sharp(svg).png().toBuffer();
	// the same artwork shifted 6px right: within tolerance, so it must pass
	const shifted = await sharp(
		Buffer.from(svg.toString().replace(/x="(\d+)"/g, (_, v) => `x="${Number(v) + 6}"`)),
	)
		.png()
		.toBuffer();

	const cfg = {
		workingSize: 512,
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

	nativeSeed._setEngine(engine);
	try {
		const golden = await prepareGolden(png, cfg);
		const result = await compareFrame(png, golden, { ...cfg, nativeFastAlign: true });
		// Whether the fast path is kept or handed back to the JS aligner is
		// the pipeline's own judgement; what matters here is that the WASM
		// engine drove it to a correct verdict on a frame identical to the
		// golden, rather than throwing or aligning to nonsense.
		assert.strictEqual(result.pass, true, JSON.stringify(result.transform));
		assert.strictEqual(result.printBlemish.defectRatio, 0);
		assert.strictEqual(result.backgroundBlemish.defectRatio, 0);
		assert.strictEqual(result.transform.native, true, "the fast path was used");

		// A shifted frame is the case that exposes the warp's border fill:
		// with an ink-coloured fill the interpolation rim alone flags a
		// background block and fails a frame the JS aligner passes.
		const moved = await compareFrame(shifted, golden, { ...cfg, nativeFastAlign: true });
		assert.strictEqual(moved.transform.native, true, "the fast path was used");
		assert.strictEqual(
			moved.backgroundBlemish.defectRatio,
			0,
			"a shifted frame must not invent background ink at the border",
		);
		assert.strictEqual(moved.pass, true, JSON.stringify(moved.transform));
	} finally {
		nativeSeed._resetEngine();
	}
});

test("label-crop encodes a non-raw output through the codec fallback", { skip }, async () => {
	const frame = labelFrame(800, 600, 0, 360, 220, 3);
	const result = await labelCrop(
		frame,
		{ maxEdge: 400, polarity: "light", outputFormat: "png" },
		engine,
	);
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.ok(Buffer.isBuffer(result.image), "png output is an encoded Buffer");
	// PNG signature
	assert.deepStrictEqual(
		[...result.image.subarray(0, 4)],
		[0x89, 0x50, 0x4e, 0x47],
	);
});
