/**
 * @graciousstar/opencv5.
 *
 * Each pixel op is held to the stock opencv.js build of the same OpenCV
 * (test/reference.js) byte for byte, which checks the op's arguments as
 * much as OpenCV; imageAlign to known shifts and to bytes pinned in
 * test/expected.json, which every platform's binary must reproduce; then
 * the guards: a length the dimensions do not fit, a detached or resizable
 * buffer, is refused before native code runs.
 *
 * Skipped where no binary loads (a platform with no prebuild);
 * OPENCV5_ADDON tests a local build instead.
 */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const own = require("..");
const ref = require("./reference.js");
const expected = require("./expected.json");

const skip = own.available() ? false : "no opencv5 binary loads here (OPENCV5_ADDON)";
const skipCross = skip || (ref.available() ? false : "@techstark/opencv-js is not installed");

const DEG = Math.PI / 180;

function rawImage(data, width, height, channels = 1, colorSpace = "GRAY") {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return { data: buf, width, height, channels, colorSpace, dtype: "uint8" };
}

/** A textured light rectangle on a dark field, rotated about the centre. */
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

/** Deterministic blocks, so ORB has corners to find. */
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
	assert.deepStrictEqual([a.width, a.height, a.channels], [b.width, b.height, b.channels]);
	assert.ok(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0, "pixels differ");
};

// ---- the same bytes as opencv.js -------------------------------------

test("colorConvert matches opencv.js, RGB to GRAY", { skip: skipCross }, async () => {
	const frame = labelFrame(160, 90, 7, 90, 50, 3);
	const gray = (await own.colorConvert(frame, "GRAY", "raw")).image;
	assert.strictEqual(gray.colorSpace, "GRAY");
	same(gray, await ref.toGray(frame));
	// and the identity conversion is a copy, not the caller's buffer
	const again = (await own.colorConvert(gray, "GRAY", "raw")).image;
	same(again, gray);
	assert.notStrictEqual(again.data.buffer, gray.data.buffer);
});

test("resize matches opencv.js down and up, 1 and 3 channels", { skip: skipCross }, async () => {
	for (const channels of [1, 3]) {
		const frame = labelFrame(301, 199, 9, 150, 90, channels);
		for (const [w, h] of [[150, 99], [640, 480]]) {
			same((await own.resize(frame, "num", w, "num", h, "raw")).image, await ref.resize(frame, w, h));
		}
		// a 0 height keeps the aspect ratio
		const r = (await own.resize(frame, "num", 97, "num", 0, "raw")).image;
		assert.deepStrictEqual([r.width, r.height], [97, Math.round((97 * 199) / 301)]);
	}
});

test("filter otsu blurs its input in place and thresholds it, as opencv.js", { skip: skipCross }, async () => {
	const a = labelFrame(200, 150, 11, 120, 70, 1);
	const original = rawImage(Buffer.from(a.data), 200, 150, 1);
	const mask = (await own.filter(a, "otsu", 3, 0, "raw")).image;
	const blurred = await ref.blur(original, 3);
	same(a, blurred);
	same(mask, await ref.otsu(blurred));
	same((await own.filter(a, "edge", 3, 1, "raw")).image, await ref.edge(a, 3, 1));
});

test("crop clamps into the frame; rotate is within one grey level of opencv.js", { skip: skipCross }, async () => {
	const frame = labelFrame(240, 160, 0, 140, 80, 3);
	const c = (await own.crop(frame, 200, -5, 100, 60, false, "raw")).image;
	assert.deepStrictEqual([c.width, c.height], [40, 60]);
	for (let y = 0; y < 60; y++) {
		assert.ok(c.data.subarray(y * 120, y * 120 + 120).equals(frame.data.subarray((y * 240 + 200) * 3, (y * 240 + 240) * 3)));
	}
	// OpenCV 5's bilinear warp rounds its vector and scalar (WASM) paths
	// apart on the odd pixel: measured 2 and 3 of ~200,000 values, by one
	for (const angle of [0, 12.5, -33]) {
		const a = (await own.rotate(frame, angle, "#20a0ff", "raw")).image;
		const b = await ref.rotate(frame, angle, a.width, a.height, [0x20, 0xa0, 0xff, 255]);
		const rad = angle * DEG;
		assert.strictEqual(a.width, Math.trunc(160 * Math.abs(Math.sin(rad)) + 240 * Math.abs(Math.cos(rad))));
		let off = 0;
		for (let i = 0; i < a.data.length; i++) {
			const d = Math.abs(a.data[i] - b.data[i]);
			assert.ok(d <= 1, `rotate ${angle}: value ${i} differs by ${d}`);
			off += d;
		}
		assert.ok(off <= a.data.length / 1000, `rotate ${angle}: ${off} values differ`);
	}
});

test("an encoded Buffer is decoded through sharp at its own channel count", { skip }, async () => {
	const sharp = require("sharp");
	const frame = labelFrame(64, 48, 0, 30, 20, 3);
	const png = await sharp(frame.data, { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer();
	const rgb = (await own.colorConvert(png, "RGB", "raw")).image;
	same(rgb, frame);
	const encoded = (await own.colorConvert(frame, "RGB", "png")).image;
	assert.ok(Buffer.isBuffer(encoded) && encoded.subarray(1, 4).toString() === "PNG");
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

test("imageAlign recovers a shift on a 2048px golden at full scale", { skip }, async () => {
	// the rosepetal bridge answers identity, success true, from ~1536px up
	const golden = texture(labelFrame(2048, 1536, 0, 1400, 1000, 1), 900);
	const target = shifted(golden, 2048, 1536, 1, 11, -6);
	const result = await own.imageAlign(golden, target, 1, 50, 1e-4, ...ALIGN_TAIL, "auto", "orb");
	assert.strictEqual(result.success, true);
	const m = result.transformMatrix.matrix2x3;
	assert.ok(Math.abs(m[2] - 11) < 1 && Math.abs(m[5] + 6) < 1, `shift ${m}`);
});

test("imageAlign keeps one golden handle per golden buffer and scale", { skip }, async () => {
	const cv = own.load();
	const create = cv.createGolden;
	let created = 0;
	cv.createGolden = (...args) => {
		created++;
		return create(...args);
	};
	try {
		const golden = texture(labelFrame(400, 300, 0, 200, 150, 1));
		const target = shifted(golden, 400, 300, 1, 5, 3);
		const a = await own.imageAlign(golden, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		const b = await own.imageAlign(golden, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.deepStrictEqual(a.transformMatrix, b.transformMatrix);
		assert.strictEqual(created, 1);
		await own.imageAlign(golden, target, 1, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.strictEqual(created, 2, "another scale is another handle");
		// a different golden with the same first, middle and last 256 bytes -
		// rosepetal's cache key - gets its own features
		const other = rawImage(Buffer.from(golden.data), 400, 300, 1, "GRAY");
		for (let y = 10; y < 90; y++) other.data.fill(255, y * 400 + 100, y * 400 + 300);
		for (const start of [0, other.data.length / 2, other.data.length - 256]) {
			assert.ok(other.data.subarray(start, start + 256).equals(golden.data.subarray(start, start + 256)));
		}
		await own.imageAlign(other, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.strictEqual(created, 3);
	} finally {
		cv.createGolden = create;
	}
});

test("an imageAlign started while a reply is being read gets its own buffer", { skip }, async () => {
	const golden = texture(labelFrame(400, 300, 0, 200, 150, 1));
	const t1 = shifted(golden, 400, 300, 1, 5, 3);
	const t2 = shifted(golden, 400, 300, 1, -9, 7);
	await own.imageAlign(golden, t1, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
	await new Promise((r) => setImmediate(r)); // the reply buffer is free again
	let second;
	const first = await own.imageAlign(golden, t1, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb").then((r) => {
		second = own.imageAlign(golden, t2, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		return r;
	});
	const before = Buffer.from(first.image.data);
	await second;
	assert.ok(Buffer.from(first.image.data).equals(before), "the first reply's image was overwritten");
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
	// a detached store, and (in index.js) one that could shrink
	const gone = new Uint8Array(100);
	structuredClone(gone.buffer, { transfer: [gone.buffer] });
	assert.throws(() => cv.resize(gone, 10, 10, 1, out, 10, 10), /bad arguments/);
	const resizable = new Uint8Array(new ArrayBuffer(300, { maxByteLength: 600 }));
	if (!resizable.buffer.resizable) return undefined; // Node 18: none exist
	return assert.rejects(own.resize(rawImage(resizable, 10, 10, 3, "RGB"), "num", 5, "num", 5, "raw"), /resizable/);
});

// ---- the same bytes on every platform ----------------------------------

/** What each case produces, as hashes: test/expected.json pins them, and
 * a binary for another platform or CPU must give the same. */
async function fingerprints() {
	const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 32);
	const golden = texture(labelFrame(600, 400, 0, 300, 180, 1));
	const target = shifted(golden, 900, 600, 1.5, 13, -7);
	const out = {};
	for (const ecc of ["auto", "always"]) {
		const r = await own.imageAlign(golden, target, 0.5, 50, 1e-4, ...ALIGN_TAIL, ecc, "orb");
		out[`align-${ecc}`] = { image: sha(r.image.data), matrix: r.transformMatrix.matrix2x3 };
	}
	const rgb = labelFrame(301, 199, 9, 150, 90, 3);
	out.gray = sha((await own.colorConvert(rgb, "GRAY", "raw")).image.data);
	out.resize = sha((await own.resize(rgb, "num", 150, "num", 99, "raw")).image.data);
	out.rotate = sha((await own.rotate(rgb, 12.5, "#20a0ff", "raw")).image.data);
	const gray = labelFrame(301, 199, 9, 150, 90, 1);
	out.otsu = sha((await own.filter(gray, "otsu", 3, 0, "raw")).image.data);
	out.edge = sha((await own.filter(gray, "edge", 3, 1, "raw")).image.data);
	return out;
}

test("every op gives the bytes test/expected.json pins, on every platform", { skip }, async () => {
	const got = await fingerprints();
	assert.deepStrictEqual(got, expected, `this binary's bytes: ${JSON.stringify(got)}`);
});
