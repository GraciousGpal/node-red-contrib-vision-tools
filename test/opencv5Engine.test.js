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

test("filter otsu and edge give the opencv.js engine's bytes, the blurred grey included", { skip: skipCross }, async () => {
	const a = labelFrame(200, 150, 11, 120, 70, 1);
	const before = Buffer.from(a.data);
	const mine = await own.filter(a, "otsu", 3, 0, "raw");
	const theirs = await cvjs.filter(a, "otsu", 3, 0, "raw");
	same(mine.image, theirs.image);
	same(mine.blurred, theirs.blurred);
	assert.deepStrictEqual(Buffer.from(a.data), before, "neither engine writes to its input");
	same((await own.filter(mine.blurred, "edge", 3, 1, "raw")).image, (await cvjs.filter(theirs.blurred, "edge", 3, 1, "raw")).image);
	const rgb = labelFrame(200, 150, 11, 120, 70, 3);
	const rgbMine = await own.filter(rgb, "otsu", 5, 0, "raw");
	const rgbTheirs = await cvjs.filter(rgb, "otsu", 5, 0, "raw");
	same(rgbMine.image, rgbTheirs.image);
	same(rgbMine.blurred, rgbTheirs.blurred);
});

test("both engines refuse the same arguments, with the same error types", { skip: skipCross }, async () => {
	const gray = labelFrame(100, 80, 0, 50, 30, 1);
	const rgb = labelFrame(100, 80, 0, 50, 30, 3);
	const tex = labelFrame(200, 160, 5, 120, 90, 1);
	const align = (...over) => (e) => {
		const a = [tex, tex, 0.5, 20, 1e-3, "raw", 90, false, true, null, "affine", "features+ecc", "auto", "orb"];
		for (let i = 0; i < over.length; i += 2) a[over[i]] = over[i + 1];
		return e.imageAlign(...a);
	};
	const cases = {
		"resize 70000 wide": (e) => e.resize(gray, "num", 70000, "num", 1, "raw"),
		"resize 20000x20000": (e) => e.resize(gray, "num", 20000, "num", 20000, "raw"),
		"resize -5": (e) => e.resize(gray, "num", -5, "num", 10, "raw"),
		"resize pct 0": (e) => e.resize(gray, "pct", 0, "pct", 50, "raw"),
		"resize nothing": (e) => e.resize(gray, "num", 0, "num", 0, "raw"),
		"filter sauvola": (e) => e.filter(gray, "sauvola", 3, 0, "raw"),
		"filter otsu 33": (e) => e.filter(gray, "otsu", 33, 0, "raw"),
		"filter edge 9": (e) => e.filter(gray, "edge", 9, 1, "raw"),
		"crop NaN": (e) => e.crop(gray, NaN, 0, 10, 10, false, "raw"),
		"crop string": (e) => e.crop(gray, "a", 0, 10, 10, false, "raw"),
		"crop 0 wide": (e) => e.crop(gray, 0, 0, 0, 10, false, "raw"),
		"rotate Infinity": (e) => e.rotate(gray, Infinity, "#000000", "raw"),
		"rotate string": (e) => e.rotate(gray, "30", "#000000", "raw"),
		"rotate past 16384": (e) => e.rotate(labelFrame(16000, 2, 0, 1, 1, 1), 45, "#000000", "raw"),
		"Float32Array data": (e) => e.resize({ data: new Float32Array(100 * 80), width: 100, height: 80, channels: 1 }, "num", 10, "num", 10, "raw"),
		"DataView data": (e) => e.resize({ data: new DataView(new ArrayBuffer(100 * 80)), width: 100, height: 80, channels: 1 }, "num", 10, "num", 10, "raw"),
		"short data": (e) => e.resize({ data: Buffer.alloc(10), width: 100, height: 80, channels: 1 }, "num", 10, "num", 10, "raw"),
		"resizable store": (e) => e.resize({ data: new Uint8Array(new ArrayBuffer(8000, { maxByteLength: 16000 })), width: 100, height: 80, channels: 1 }, "num", 10, "num", 10, "raw"),
		"align iterations 501": align(3, 501),
		"align iterations 0.4": align(3, 0.4),
		"align iterations 1e9": align(3, 1e9),
		"align iterations string": align(3, "30"),
		"align epsilon -1": align(4, -1),
		"align epsilon 0": align(4, 0),
		"align scale 0": align(2, 0),
		"align scale 1.5": align(2, 1.5),
		"align scale 0.01 (a 2x2 copy)": align(2, 0.01),
		"align homography": align(10, "homography"),
		"align ecc only": align(11, "ecc"),
		"align sift": align(13, "sift"),
		"align polygon": align(9, [[0, 0], [1, 0], [1, 1]]),
		"align colour": align(0, rgb),
	};
	const outcome = async (fn) => {
		try {
			await fn();
			return "accepted";
		} catch (err) {
			return err && err.constructor ? err.constructor.name : typeof err;
		}
	};
	const differ = [];
	for (const [name, fn] of Object.entries(cases)) {
		const mine = await outcome(() => fn(own));
		const theirs = await outcome(() => fn(cvjs.imageAlign ? cvjs : { ...cvjs, imageAlign: require("../lib/cvjsAlign.js").imageAlign }));
		if (mine === "accepted") differ.push(`${name}: opencv5 accepted it`);
		else if (mine !== theirs) differ.push(`${name}: opencv5 ${mine}, opencv.js ${theirs}`);
	}
	assert.deepStrictEqual(differ, []);
});

test("both engines encode a BGR image with its own colours, as label-crop's encoded output needs", { skip: skipCross }, async () => {
	const sharp = require("sharp");
	const rgb = labelFrame(40, 30, 0, 20, 10, 3);
	const bgr = { ...rgb, data: Buffer.from(rgb.data), colorSpace: "BGR" };
	for (let i = 0; i < bgr.data.length; i += 3) [bgr.data[i], bgr.data[i + 2]] = [rgb.data[i + 2], rgb.data[i]];
	for (const engine of [own, cvjs]) {
		for (const fmt of ["png", "jpg"]) {
			const encoded = (await engine.crop(bgr, 0, 0, 40, 30, false, fmt, 100)).image;
			const { data } = await sharp(encoded).raw().toBuffer({ resolveWithObject: true });
			if (fmt === "png") assert.ok(data.equals(rgb.data), `${fmt}: red and blue swapped`);
			// a lossy check on jpg: the label's warm red channel stays the larger
			else assert.ok(Math.abs(data[(15 * 40 + 20) * 3] - rgb.data[(15 * 40 + 20) * 3]) < 12, `${fmt}: red and blue swapped`);
		}
	}
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
