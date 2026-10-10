/**
 * @graciousstar/opencv5.
 *
 * Each pixel op is held to the stock opencv.js build of the same OpenCV
 * (test/helpers/reference.js) byte for byte, which checks the op's
 * arguments as much as OpenCV; imageAlign to known shifts; every op to
 * bytes pinned per arch in test/expected.json, which each OS's binary of
 * that arch must reproduce; then
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
const ref = require("./helpers/reference.js");
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

test("an encoded output keeps a BGR image's colours, and pngOptimize only shrinks the file", { skip }, async () => {
	const sharp = require("sharp");
	const rgb = labelFrame(40, 30, 0, 20, 10, 3);
	const bgr = { ...rgb, data: Buffer.from(rgb.data), colorSpace: "BGR" };
	for (let i = 0; i < bgr.data.length; i += 3) [bgr.data[i], bgr.data[i + 2]] = [rgb.data[i + 2], rgb.data[i]];
	const fast = (await own.crop(bgr, 0, 0, 40, 30, false, "png", 90, false)).image;
	const small = (await own.crop(bgr, 0, 0, 40, 30, false, "png", 90, true)).image;
	for (const png of [fast, small]) {
		const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
		assert.ok(data.equals(rgb.data), "red and blue swapped");
	}
	assert.ok(small.length <= fast.length);
	assert.strictEqual(bgr.data[0], rgb.data[2], "the caller's BGR buffer is left alone");
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

/** Count the addon's createGolden calls while `fn` runs. */
async function countingGoldens(fn) {
	const cv = own.load();
	const create = cv.createGolden;
	let created = 0;
	cv.createGolden = (...args) => {
		created++;
		return create(...args);
	};
	try {
		await fn(() => created);
	} finally {
		cv.createGolden = create;
	}
}

test("imageAlign keys a golden's features by its content, and keeps only a few", { skip }, async () => {
	await countingGoldens(async (created) => {
		const golden = texture(labelFrame(400, 300, 0, 200, 150, 1));
		const target = shifted(golden, 400, 300, 1, 5, 3);
		const a = await own.imageAlign(golden, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		// the same bytes in another buffer are the same golden
		const b = await own.imageAlign(rawImage(Buffer.from(golden.data), 400, 300), target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.deepStrictEqual(a.transformMatrix, b.transformMatrix);
		assert.strictEqual(created(), 1);
		await own.imageAlign(golden, target, 1, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.strictEqual(created(), 2, "another scale is another handle");
		// rewritten in place: a new golden, not the old one's features
		const ref = rawImage(Buffer.from(golden.data), 400, 300);
		const other = texture(labelFrame(400, 300, 0, 200, 150, 1), 300);
		await own.imageAlign(ref, target, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		ref.data.set(other.data);
		const t2 = shifted(other, 400, 300, 1, -6, 4);
		const stale = await own.imageAlign(ref, t2, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		const fresh = await own.imageAlign(rawImage(Buffer.from(other.data), 400, 300), t2, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.deepStrictEqual(stale.transformMatrix, fresh.transformMatrix);
		assert.ok(stale.success);
		// bounded: after five other scales the first is made again
		const before = created();
		for (const s of [0.4, 0.45, 0.55, 0.6, 0.65]) await own.imageAlign(golden, target, s, 5, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		await own.imageAlign(golden, target, 0.5, 5, 1e-3, ...ALIGN_TAIL, "auto", "orb");
		assert.strictEqual(created() - before, 6, "the cache holds a handful, not every scale");
	});
});

test("every imageAlign reply has its own image buffer", { skip }, async () => {
	const golden = texture(labelFrame(400, 300, 0, 200, 150, 1));
	const t1 = shifted(golden, 400, 300, 1, 5, 3);
	const r1 = await own.imageAlign(golden, t1, 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
	const before = Buffer.from(r1.image.data);
	await new Promise((r) => setImmediate(r));
	const r2 = await own.imageAlign(golden, rawImage(Buffer.alloc(400 * 300), 400, 300), 0.5, 30, 1e-3, ...ALIGN_TAIL, "auto", "orb");
	assert.notStrictEqual(r1.image.data.buffer, r2.image.data.buffer);
	assert.ok(r1.image.data.equals(before), "an earlier reply was overwritten");
});

test("imageAlign refuses what it does not implement", { skip }, async () => {
	const golden = texture(labelFrame(200, 150, 0, 100, 80, 1));
	await assert.rejects(own.imageAlign(golden, golden, 1, 10, 1e-3, "raw", 90, false, true, null, "homography", "features+ecc", "auto", "orb"), /supports affine/);
	await assert.rejects(own.imageAlign(golden, golden, 1, 10, 1e-3, "raw", 90, false, true, null, "affine", "features+ecc", "auto", "akaze"), /supports affine/);
	await assert.rejects(own.imageAlign(labelFrame(200, 150, 0, 100, 80, 3), golden, 1, 10, 1e-3, ...ALIGN_TAIL, "auto", "orb"), /grey/);
	// ECC's iterations are capped, in JS and in the addon
	await assert.rejects(own.imageAlign(golden, golden, 1, 501, 1e-3, ...ALIGN_TAIL, "auto", "orb"), RangeError);
	await assert.rejects(own.imageAlign(golden, golden, 1, 1e7, 1e-300, ...ALIGN_TAIL, "always", "orb"), RangeError);
	const cv = own.load();
	const g = cv.createGolden(golden.data, 200, 150, 1);
	assert.throws(() => cv.align(g, golden.data, 200, 150, 501, 1e-3, true), /iterations 1-500/);
});

// ---- the native-safety review's proofs of concept -------------------------

const { spawnSync } = require("node:child_process");
/** Run `code` in a child Node with this package and OPENCV5_ADDON as here:
 * a crash there fails the test instead of taking the runner down. */
function child(code) {
	const r = spawnSync(process.execPath, ["-e", `const pkg = require(${JSON.stringify(require.resolve(".."))});\n${code}`], {
		encoding: "utf8",
		env: process.env,
		timeout: 60000,
	});
	return { status: r.status, signal: r.signal, out: `${r.stdout}${r.stderr}` };
}

test("a golden too small for ORB's pyramid is refused, never a crash", { skip }, () => {
	const r = child(`
		const run = async (w, h, s) => {
			const g = { data: Buffer.alloc(w * h, 128), width: w, height: h, channels: 1 };
			try { await pkg.imageAlign(g, g, s, 30, 1e-3); console.log("resolved"); }
			catch (e) { console.log("rejected", e.constructor.name, e.message); }
			try { pkg.load().createGolden(g.data, w, h, s); console.log("created"); }
			catch (e) { console.log("refused", e.message); }
		};
		(async () => { await run(300, 1, 1); await run(640, 25, 0.05); })();
	`);
	assert.strictEqual(r.status, 0, r.out);
	assert.strictEqual((r.out.match(/rejected RangeError/g) || []).length, 2, r.out);
	assert.strictEqual((r.out.match(/refused createGolden: the alignment copy would be/g) || []).length, 2, r.out);
});

test("a caller's buffer detached while the op runs changes nothing", { skip }, () => {
	const r = child(`
		const crypto = require("crypto");
		const hash = (b) => crypto.createHash("sha1").update(b).digest("hex");
		(async () => {
			const w = 2000, h = 2000;
			const fill = (b) => { for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24; return b; };
			const want = await pkg.resize({ data: fill(Buffer.alloc(w * h * 3)), width: w, height: h, channels: 3 }, "num", 3000, "num", 3000);
			const data = fill(Buffer.allocUnsafeSlow(w * h * 3));
			const p = pkg.resize({ data, width: w, height: h, channels: 3 }, "num", 3000, "num", 3000);
			data.buffer.transfer(1);
			for (let i = 0; i < 50; i++) Buffer.alloc(w * h * 3, i);
			const got = await p;
			console.log("resize", hash(got.image.data) === hash(want.image.data) ? "same" : "DIFFERENT");

			const gw = 1200, gh = 900, g = Buffer.alloc(gw * gh, 40);
			for (let k = 0; k < 400; k++) { const x = (k * 7919) % (gw - 10), y = (k * 104729) % (gh - 10); for (let j = 0; j < 9; j++) g.fill(60 + (k % 180), (y + j) * gw + x, (y + j) * gw + x + 9); }
			const t = Buffer.alloc(gw * gh, 40); for (let y = 0; y < gh; y++) t.set(g.subarray(y * gw, y * gw + gw - 7), y * gw + 7);
			const tail = ["raw", 90, false, true, null, "affine", "features+ecc", "always"];
			const ref = await pkg.imageAlign({ data: g, width: gw, height: gh, channels: 1 }, { data: Buffer.from(t), width: gw, height: gh, channels: 1 }, 0.5, 50, 1e-4, ...tail);
			const tb = Buffer.allocUnsafeSlow(gw * gh); tb.set(t);
			const q = pkg.imageAlign({ data: g, width: gw, height: gh, channels: 1 }, { data: tb, width: gw, height: gh, channels: 1 }, 0.5, 50, 1e-4, ...tail);
			tb.buffer.transfer(1);
			for (let i = 0; i < 40; i++) Buffer.alloc(gw * gh, 200);
			const a = await q;
			console.log("align", hash(a.image.data) === hash(ref.image.data) ? "same" : "DIFFERENT");
		})().catch((e) => console.log("THREW", e.message));
	`);
	assert.strictEqual(r.status, 0, r.out);
	assert.match(r.out, /resize same/);
	assert.match(r.out, /align same/);
});

test("rotate's pad colour is four numbers: an object with a getter is refused before anything is read", { skip }, () => {
	const cv = own.load();
	const src = new Uint8Array(64 * 64 * 3);
	let ran = false;
	const evil = { valueOf() { ran = true; return 0; } };
	assert.throws(() => cv.rotate(src, 64, 64, 3, 64, 64, 30, evil, 0, 0, 0), /bad arguments/);
	assert.strictEqual(ran, false, "no JS ran inside the addon");
});

// ---- guards ------------------------------------------------------------

test("an op whose buffer is shorter than its dimensions is refused before it runs", { skip }, () => {
	const cv = own.load();
	const small = new Uint8Array(99);
	const ok = new Uint8Array(100);
	assert.throws(() => cv.resize(small, 10, 10, 1, 10, 10), /bad arguments/);
	assert.throws(() => cv.cvtColor(small, 10, 10, 1, cv.colorCodes["GRAY>RGB"], 3), /bad arguments/);
	assert.throws(() => cv.filter(ok, 10, 10, 0, 4, 1), /bad arguments/);
	assert.throws(() => cv.rotate(small, 10, 10, 1, 10, 10, 5, 0, 0, 0, 0), /bad arguments/);
	assert.throws(() => cv.createGolden(small, 10, 10, 0.5), /bad arguments|alignment copy/);
	const big = new Uint8Array(100 * 100);
	const g = cv.createGolden(big, 100, 100, 0.5);
	assert.throws(() => cv.align(g, small, 10, 10, 10, 1e-3, false), /bad arguments/);
	assert.throws(() => cv.align({}, ok, 10, 10, 10, 1e-3, false), /golden handle/);
	// a Float32Array is not 8-bit pixels
	assert.throws(() => cv.resize(new Float32Array(100), 10, 10, 1, 5, 5), /bad arguments/);
	// a detached store, and (in index.js) one that could resize
	const gone = new Uint8Array(100);
	structuredClone(gone.buffer, { transfer: [gone.buffer] });
	assert.throws(() => cv.resize(gone, 10, 10, 1, 10, 10), /bad arguments/);
	const resizable = new Uint8Array(new ArrayBuffer(300, { maxByteLength: 600 }));
	if (!resizable.buffer.resizable) return undefined; // Node 18: none exist
	return assert.rejects(own.resize(rawImage(resizable, 10, 10, 3, "RGB"), "num", 5, "num", 5, "raw"), /resizable/);
});

test("bad arguments are TypeErrors and RangeErrors that say which", { skip }, async () => {
	const g = rawImage(Buffer.alloc(100 * 80, 9), 100, 80);
	await assert.rejects(own.crop(g, NaN, 0, 10, 10), (e) => e instanceof RangeError && /crop x/.test(e.message));
	await assert.rejects(own.crop(g, "a", 0, 10, 10), (e) => e instanceof TypeError && /crop x/.test(e.message));
	await assert.rejects(own.crop(g, 0, 0, 0, 10), RangeError);
	await assert.rejects(own.rotate(g, Infinity), (e) => e instanceof RangeError && /angle/.test(e.message));
	await assert.rejects(own.rotate(g, "30"), TypeError);
	await assert.rejects(own.resize(g, "num", 70000, "num", 1), RangeError);
	await assert.rejects(own.filter({ data: new Float32Array(100 * 80), width: 100, height: 80, channels: 1 }, "otsu", 3, 1), TypeError);
	await assert.rejects(own.filter({ data: new DataView(new ArrayBuffer(100 * 80)), width: 100, height: 80, channels: 1 }, "otsu", 3, 1), TypeError);
	// the edge filter's 16-bit derivative overflows past a 7x7 kernel
	await assert.rejects(own.filter(g, "edge", 9, 1), RangeError);
	assert.throws(() => own.load().filter(g.data, 100, 80, 1, 9, 1), /bad arguments/);
	// OPENCV5_ADDON at nothing says so
	const previous = process.env.OPENCV5_ADDON;
	process.env.OPENCV5_ADDON = "/nonexistent/opencv5.node";
	own._reset();
	try {
		assert.throws(() => own.load(), /OPENCV5_ADDON is \/nonexistent\/opencv5\.node, which does not exist/);
	} finally {
		if (previous === undefined) delete process.env.OPENCV5_ADDON;
		else process.env.OPENCV5_ADDON = previous;
		own._reset();
	}
});

// ---- the same bytes on every platform of an arch -----------------------

/** What each case produces, as hashes: test/expected.json pins them per
 * arch, and a binary for another OS or CPU of that arch must give the
 * same. Per arch, not across them: arm64's NEON multiply-add rounds once
 * where x64's SSE rounds twice, so the float paths may differ there. */
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

test("every op gives the bytes test/expected.json pins for this arch", { skip }, async (t) => {
	const got = await fingerprints();
	const want = expected[process.arch];
	if (!want) {
		// the first binary of a new arch: its bytes, to pin after review
		t.diagnostic(`${process.arch}: ${JSON.stringify(got)}`);
		t.skip(`no bytes pinned for ${process.arch} yet`);
		return;
	}
	assert.deepStrictEqual(got, want, `this binary's bytes: ${JSON.stringify(got)}`);
});
