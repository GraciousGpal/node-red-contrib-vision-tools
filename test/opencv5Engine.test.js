/**
 * @graciousstar/opencv5 as this package's engine (lib/opencv5.js).
 *
 * The package tests itself (opencv5/test); these hold it to what this
 * package's callers rely on: the same bytes as the opencv.js engine
 * (lib/cvjs.js) on every op label-crop and golden-compare use - the two
 * engines must be interchangeable - and label-crop end to end on it.
 *
 * Skipped where no opencv5 binary loads; OPENCV5_ADDON tests a local build.
 */

const test = require("node:test");
const assert = require("node:assert");

const own = require("../lib/opencv5.js");
const cvjs = require("../lib/cvjs.js");
const { labelCrop } = require("../lib/labelCrop.js");
const { rawImage } = require("./helpers/synthetic.js");

const skip = own.available() ? false : "no opencv5 binary loads here (OPENCV5_ADDON)";
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

const same = (a, b) => {
	assert.deepStrictEqual(
		{ width: a.width, height: a.height, channels: a.channels, colorSpace: a.colorSpace },
		{ width: b.width, height: b.height, channels: b.channels, colorSpace: b.colorSpace },
	);
	assert.ok(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0, "pixels differ");
};

test("colorConvert gives the opencv.js engine's bytes, RGB to GRAY and back", { skip: skipCross }, async () => {
	const frame = labelFrame(160, 90, 7, 90, 50, 3);
	const gray = (await own.colorConvert(frame, "GRAY", "raw")).image;
	same(gray, (await cvjs.colorConvert(frame, "GRAY", "raw")).image);
	same((await own.colorConvert(gray, "RGBA", "raw")).image, (await cvjs.colorConvert(gray, "RGBA", "raw")).image);
});

test("resize gives the opencv.js engine's bytes, every size mode label-crop uses", { skip: skipCross }, async () => {
	for (const channels of [1, 3]) {
		const frame = labelFrame(301, 199, 9, 150, 90, channels);
		for (const [w, h] of [[150, 99], [97, 0], [640, 480]]) {
			same((await own.resize(frame, "num", w, "num", h, "raw")).image, (await cvjs.resize(frame, "num", w, "num", h, "raw")).image);
		}
	}
});

test("filter otsu and edge give the opencv.js engine's bytes, in-place blur included", { skip: skipCross }, async () => {
	const a = labelFrame(200, 150, 11, 120, 70, 1);
	const b = labelFrame(200, 150, 11, 120, 70, 1);
	same((await own.filter(a, "otsu", 3, 0, "raw")).image, (await cvjs.filter(b, "otsu", 3, 0, "raw")).image);
	same(a, b); // both blurred their caller's buffer, identically
	same((await own.filter(a, "edge", 3, 1, "raw")).image, (await cvjs.filter(b, "edge", 3, 1, "raw")).image);
	const rgb = labelFrame(200, 150, 11, 120, 70, 3);
	same((await own.filter(rgb, "otsu", 5, 0, "raw")).image, (await cvjs.filter(rgb, "otsu", 5, 0, "raw")).image);
});

test("crop gives the opencv.js engine's bytes; rotate its canvas, within one grey level", { skip: skipCross }, async () => {
	const frame = labelFrame(240, 160, 0, 140, 80, 3);
	same((await own.crop(frame, 200, -5, 100, 60, false, "raw")).image, (await cvjs.crop(frame, 200, -5, 100, 60, false, "raw")).image);
	same((await own.crop(frame, 0.1, 0.2, 0.5, 0.5, true, "raw")).image, (await cvjs.crop(frame, 0.1, 0.2, 0.5, 0.5, true, "raw")).image);
	for (const angle of [0, 12.5, -33]) {
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

test("label-crop deskews a rotated label on the opencv5 engine", { skip }, async () => {
	const frame = labelFrame(800, 600, 12, 360, 220, 3);
	const result = await labelCrop(frame, { maxEdge: 400, polarity: "light", outputFormat: "raw" }, own);
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.ok(Math.abs(result.metadata.angleDeg - 12) < 2, `angle ${result.metadata.angleDeg}`);
});

test("label-crop takes an encoded Buffer through sharp on the opencv5 engine", { skip }, async () => {
	const sharp = require("sharp");
	const frame = labelFrame(800, 600, 0, 400, 200, 3);
	const png = await sharp(frame.data, { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer();
	const result = await labelCrop(png, { maxEdge: 400, polarity: "light", outputFormat: "raw" }, own);
	assert.strictEqual(result.detected, true, result.metadata.reason);
});
