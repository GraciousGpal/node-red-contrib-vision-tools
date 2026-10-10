/**
 * The "own" engine (lib/ownCv.js over native/opencv/vision-cv.cc).
 *
 * Each pixel op is held to the opencv.js build of the same OpenCV major
 * (lib/cvjs.js) byte for byte where both are installed, which is a check
 * of the op's arguments as much as of OpenCV; imageAlign to a known
 * shift; label-crop end to end. Then the guards: a length the dimensions
 * do not fit is refused before any native code runs.
 *
 * Skipped when no vision-cv addon loads here (none is shipped yet: point
 * VISION_TOOLS_CV_ADDON at a build).
 */

const test = require("node:test");
const assert = require("node:assert");

const own = require("../lib/ownCv.js");
const cvjs = require("../lib/cvjs.js");
const engineModule = require("../lib/engine.js");
const { labelCrop } = require("../lib/labelCrop.js");
const { rawImage } = require("./helpers/synthetic.js");

const skip = own.available() ? false : "no vision-cv addon (VISION_TOOLS_CV_ADDON)";
const skipCross = skip || (cvjs.available() ? false : "@techstark/opencv-js is not installed");

const DEG = Math.PI / 180;

function labelFrame(width, height, angleDeg, labelWidth, labelHeight, channels = 3) {
	const data = Buffer.alloc(width * height * channels, 30);
	const ca = Math.cos(angleDeg * DEG);
	const sa = Math.sin(angleDeg * DEG);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x - width / 2) * ca + (y - height / 2) * sa;
			const v = -(x - width / 2) * sa + (y - height / 2) * ca;
			if (Math.abs(u) <= labelWidth / 2 && Math.abs(v) <= labelHeight / 2) {
				const i = (y * width + x) * channels;
				for (let c = 0; c < channels; c++) data[i + c] = 200 + ((x * 7 + y * 3 + c * 11) % 50);
			}
		}
	}
	return rawImage(data, width, height, channels, channels === 1 ? "GRAY" : "RGB");
}

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

const same = (a, b) => {
	assert.deepStrictEqual(
		{ width: a.width, height: a.height, channels: a.channels, colorSpace: a.colorSpace },
		{ width: b.width, height: b.height, channels: b.channels, colorSpace: b.colorSpace },
	);
	assert.ok(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0, "pixels differ");
};

// ---- the same bytes as opencv.js -------------------------------------

test("colorConvert matches opencv.js, RGB to GRAY and back", { skip: skipCross }, async () => {
	const frame = labelFrame(160, 90, 7, 90, 50, 3);
	const gray = (await own.colorConvert(frame, "GRAY", "raw")).image;
	same(gray, (await cvjs.colorConvert(frame, "GRAY", "raw")).image);
	same((await own.colorConvert(gray, "RGBA", "raw")).image, (await cvjs.colorConvert(gray, "RGBA", "raw")).image);
});

test("resize matches opencv.js down and up, 1 and 3 channels", { skip: skipCross }, async () => {
	for (const channels of [1, 3]) {
		const frame = labelFrame(301, 199, 9, 150, 90, channels);
		for (const [w, h] of [[150, 99], [97, 0], [640, 480]]) {
			same(
				(await own.resize(frame, "num", w, "num", h, "raw")).image,
				(await cvjs.resize(frame, "num", w, "num", h, "raw")).image,
			);
		}
	}
});

test("filter otsu and edge match opencv.js, including the in-place blur", { skip: skipCross }, async () => {
	const a = labelFrame(200, 150, 11, 120, 70, 1);
	const b = labelFrame(200, 150, 11, 120, 70, 1);
	same((await own.filter(a, "otsu", 3, 0, "raw")).image, (await cvjs.filter(b, "otsu", 3, 0, "raw")).image);
	same(a, b); // both blurred their caller's buffer, identically
	same((await own.filter(a, "edge", 3, 1, "raw")).image, (await cvjs.filter(b, "edge", 3, 1, "raw")).image);
	const rgb = labelFrame(200, 150, 11, 120, 70, 3);
	same((await own.filter(rgb, "otsu", 5, 0, "raw")).image, (await cvjs.filter(rgb, "otsu", 5, 0, "raw")).image);
});

test("crop matches opencv.js; rotate to within one grey level on a few pixels", { skip: skipCross }, async () => {
	const frame = labelFrame(240, 160, 0, 140, 80, 3);
	same((await own.crop(frame, 200, -5, 100, 60, false, "raw")).image, (await cvjs.crop(frame, 200, -5, 100, 60, false, "raw")).image);
	same((await own.crop(frame, 0.1, 0.2, 0.5, 0.5, true, "raw")).image, (await cvjs.crop(frame, 0.1, 0.2, 0.5, 0.5, true, "raw")).image);
	same((await own.rotate(frame, 0, "#20a0ff", "raw")).image, (await cvjs.rotate(frame, 0, "#20a0ff", "raw")).image);
	// OpenCV 5's bilinear warp rounds its vector and scalar paths apart on
	// the odd pixel: measured 2 and 3 of ~200,000 values, by one level
	for (const angle of [12.5, -33]) {
		const a = (await own.rotate(frame, angle, "#20a0ff", "raw")).image;
		const b = (await cvjs.rotate(frame, angle, "#20a0ff", "raw")).image;
		assert.deepStrictEqual([a.width, a.height, a.channels], [b.width, b.height, b.channels]);
		let off = 0;
		for (let i = 0; i < a.data.length; i++) {
			const d = Math.abs(a.data[i] - b.data[i]);
			assert.ok(d <= 1, `rotate ${angle}: value ${i} differs by ${d}`);
			off += d;
		}
		assert.ok(off <= a.data.length / 1000, `rotate ${angle}: ${off} values differ`);
	}
});

// ---- alignment ---------------------------------------------------------

function shifted(golden, tw, th, mx, shiftX, shiftY) {
	const target = Buffer.alloc(tw * th, 30);
	for (let y = 0; y < th; y++) {
		for (let x = 0; x < tw; x++) {
			const gx = Math.round((x - shiftX) / mx);
			const gy = Math.round((y - shiftY) / mx);
			target[y * tw + x] = gx >= 0 && gx < golden.width && gy >= 0 && gy < golden.height ? golden.data[gy * golden.width + gx] : 30;
		}
	}
	return rawImage(target, tw, th, 1, "GRAY");
}

const ALIGN_TAIL = ["raw", 90, false, true, null, "affine", "features+ecc"];

test("imageAlign recovers a known shift and warps the frame onto the golden", { skip }, async () => {
	const golden = texture(labelFrame(600, 400, 0, 300, 180, 1));
	const target = shifted(golden, 900, 600, 1.5, 13, -7);
	for (const ecc of ["auto", "always"]) {
		const result = await own.imageAlign(golden, target, 1, 50, 1e-4, ...ALIGN_TAIL, ecc, "orb");
		assert.strictEqual(result.success, true);
		const m = result.transformMatrix.matrix2x3;
		assert.ok(Math.abs(m[0] - 1) < 0.02 && Math.abs(m[4] - 1) < 0.02, `scale ${m}`);
		assert.ok(Math.abs(m[2] - 13 / 1.5) < 1.5 && Math.abs(m[5] + 7 / 1.5) < 1.5, `shift ${m}`);
		assert.strictEqual(result.image.width, 600);
		assert.strictEqual(result.image.channels, 1);
		// the warped frame is the golden again, away from the borders
		let off = 0;
		for (let y = 50; y < 350; y++) for (let x = 50; x < 550; x++) off += Math.abs(result.image.data[y * 600 + x] - golden.data[y * 600 + x]) > 40;
		assert.ok(off < 0.02 * 300 * 500, `${off} pixels off`);
	}
});

test("imageAlign keeps one golden handle per golden buffer and scale", { skip }, async () => {
	const golden = texture(labelFrame(400, 300, 0, 200, 150, 1));
	const target = shifted(golden, 400, 300, 1, 5, 3);
	const a = await own.imageAlign(golden, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
	const b = await own.imageAlign(golden, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
	assert.deepStrictEqual(a.transformMatrix, b.transformMatrix);
	// a different golden with the same first, middle and last 256 bytes -
	// rosepetal's cache key - gets its own features
	const other = rawImage(Buffer.from(golden.data), 400, 300, 1, "GRAY");
	for (let y = 100; y < 200; y++) other.data.fill(255, y * 400 + 100, y * 400 + 300);
	const c = await own.imageAlign(other, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
	assert.notDeepStrictEqual(c.transformMatrix, a.transformMatrix);
});

test("imageAlign refuses what it does not implement", { skip }, async () => {
	const golden = texture(labelFrame(200, 150, 0, 100, 80, 1));
	await assert.rejects(own.imageAlign(golden, golden, 1, 10, 1e-3, "raw", 90, false, true, null, "homography", "features+ecc", "auto", "orb"), /supports affine/);
	await assert.rejects(own.imageAlign(golden, golden, 1, 10, 1e-3, "raw", 90, false, true, null, "affine", "features+ecc", "auto", "akaze"), /supports affine/);
	await assert.rejects(own.imageAlign(labelFrame(200, 150, 0, 100, 80, 3), golden, 1, 10, 1e-3, ...ALIGN_TAIL, "auto", "orb"), /grey/);
});

// ---- guards ------------------------------------------------------------

test("an op whose buffer is shorter than its dimensions is refused before it runs", { skip }, () => {
	const cv = own.load();
	const small = new Uint8Array(99);
	const out = new Uint8Array(100);
	assert.throws(() => cv.resize(small, 10, 10, 1, out, 10, 10), /bad arguments/);
	assert.throws(() => cv.resize(out, 10, 10, 1, small, 10, 10), /bad arguments/);
	assert.throws(() => cv.cvtColor(out, 10, 10, 1, cv.colorCodes["GRAY>RGB"], out, 3), /bad arguments/);
	assert.throws(() => cv.filter(out, 10, 10, 0, 4, 1, out), /bad arguments/);
	assert.throws(() => cv.rotate(out, 10, 10, 1, small, 10, 10, 5, [0, 0, 0, 0]), /bad arguments/);
	assert.throws(() => cv.createGolden(small, 10, 10, 0.5), /bad arguments/);
	const g = cv.createGolden(out, 10, 10, 0.5);
	assert.throws(() => cv.align(g, out, 10, 10, small, 10, 1e-3, false), /bad arguments/);
	assert.throws(() => cv.align({}, out, 10, 10, out, 10, 1e-3, false), /golden handle/);
});

// ---- callers -----------------------------------------------------------

test("label-crop deskews a rotated label on the own engine", { skip }, async () => {
	const frame = labelFrame(800, 600, 12, 360, 220, 3);
	const result = await labelCrop(frame, { maxEdge: 400, polarity: "light", outputFormat: "raw" }, own);
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.ok(Math.abs(result.metadata.angleDeg - 12) < 2, `angle ${result.metadata.angleDeg}`);
});

test("label-crop takes an encoded Buffer through sharp on the own engine", { skip }, async () => {
	const sharp = require("sharp");
	const frame = labelFrame(800, 600, 0, 400, 200, 3);
	const png = await sharp(frame.data, { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer();
	const result = await labelCrop(png, { maxEdge: 400, polarity: "light", outputFormat: "raw" }, own);
	assert.strictEqual(result.detected, true, result.metadata.reason);
});

test("VISION_TOOLS_ENGINE=own selects it, and auto never does", { skip }, () => {
	const previous = process.env.VISION_TOOLS_ENGINE;
	try {
		process.env.VISION_TOOLS_ENGINE = "own";
		engineModule._reset();
		assert.strictEqual(engineModule.candidate().name, "own");
		process.env.VISION_TOOLS_ENGINE = "auto";
		engineModule._reset();
		assert.notStrictEqual(engineModule.candidate().name, "own");
	} finally {
		if (previous === undefined) delete process.env.VISION_TOOLS_ENGINE;
		else process.env.VISION_TOOLS_ENGINE = previous;
		engineModule._reset();
	}
});

test("VISION_TOOLS_ENGINE=own with no addon is an error, not a substitute", () => {
	const previous = { engine: process.env.VISION_TOOLS_ENGINE, addon: process.env.VISION_TOOLS_CV_ADDON };
	try {
		process.env.VISION_TOOLS_ENGINE = "own";
		process.env.VISION_TOOLS_CV_ADDON = "/nonexistent/vision-cv.node";
		own._reset();
		engineModule._reset();
		const selected = engineModule.candidate();
		assert.strictEqual(selected.engine, null);
		assert.match(selected.error.message, /own: no vision-cv addon/);
	} finally {
		for (const [k, v] of [["VISION_TOOLS_ENGINE", previous.engine], ["VISION_TOOLS_CV_ADDON", previous.addon]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		own._reset();
		engineModule._reset();
	}
});
