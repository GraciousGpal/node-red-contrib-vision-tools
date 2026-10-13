/**
 * lib/locate.js against barcodes written by zxing-wasm's own writer and
 * composited onto a white canvas at known positions, so every expected
 * box is known exactly.
 *
 * What this suite exists for:
 *
 *  - Offline operation. zxing-wasm 3.1.3 fetches its .wasm from jsdelivr
 *    on first use unless it is handed the binary; a rig with no internet
 *    then fails its first decode after every restart. fetch and
 *    http(s).request/get are stubbed to throw below, before lib/locate.js
 *    is even required, so every decode in this file proves the shipped
 *    binary is used.
 *  - `symbol`: the decoded code's own box in full-image coordinates, for
 *    regions and for the full-image pass.
 *  - Dedup: one physical code seen through overlapping regions is one
 *    result, kept under the first region's label - including the case an
 *    IoU rule gets wrong, a region that cuts a Code128 short.
 *  - Raw input: bare pixels plus { width, height, channels } decode to
 *    the same results as the encoded file.
 *  - EAN-8 stays off by default (it matches noise; see DEFAULT_FORMATS).
 */

"use strict";

const http = require("node:http");
const https = require("node:https");

// Before anything zxing is loaded: any network use from here on throws.
const networkCalls = [];
function blocked(what) {
	return () => {
		networkCalls.push(what);
		throw new Error(`network blocked in test (${what})`);
	};
}
globalThis.fetch = blocked("fetch");
http.request = blocked("http.request");
http.get = blocked("http.get");
https.request = blocked("https.request");
https.get = blocked("https.get");

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { locateBarcodes, DEFAULT_FORMATS } = require("../lib/locate.js");
const { rawGeometry, assertRawFits, resolveImage } = require("../lib/nodeInput.js");
const { loadNode } = require("./helpers/fakeRed.js");

// The writer ships in zxing-wasm, a hard dependency of this package, so
// a load failure is a broken install and fails every test that needs it
// (fixture() throws with the load error) rather than skipping them. It
// is made offline the same way lib/locate.js makes the reader offline.
let writer = null;
let writerError = null;
try {
	writer = require("zxing-wasm/writer");
	const root = path.resolve(path.dirname(require.resolve("zxing-wasm/writer")), "..", "..", "..");
	const wasmBinary = fs.readFileSync(path.join(root, "dist", "writer", "zxing_writer.wasm"));
	writer.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true }).catch(() => {});
} catch (err) {
	writer = null;
	writerError = err;
}

function assertWriterLoaded() {
	if (!writer) {
		throw new Error(`zxing-wasm/writer failed to load (zxing-wasm is a hard dependency): ${writerError && writerError.stack ? writerError.stack : writerError}`);
	}
}

// Placement on the canvas. The writer is asked for no quiet zones, so the
// PNG's edges are the symbol's edges; the canvas's white supplies the
// quiet zones (>= 100 px around each code, far past Code128's 10 modules).
const CANVAS = { width: 1200, height: 700 };
const CODE128 = { text: "VT-LOCATE-128", format: "Code128", scale: 3, left: 100, top: 150 };
const DATAMATRIX = { text: "VT-DM-0042", format: "DataMatrix", scale: 8, left: 750, top: 200 };
const EAN8 = { text: "1234567", format: "EAN8", scale: 3, left: 300, top: 450 };

async function writePng(spec) {
	const r = await writer.writeBarcode(spec.text, { format: spec.format, scale: spec.scale, addQuietZones: false });
	if (r.error) throw new Error(`writeBarcode ${spec.format}: ${r.error}`);
	const buf = Buffer.from(await r.image.arrayBuffer());
	const meta = await sharp(buf).metadata();
	return { ...spec, buf, width: meta.width, height: meta.height };
}

let fixturePromise = null;
function fixture() {
	if (!fixturePromise) {
		assertWriterLoaded();
		fixturePromise = (async () => {
			const codes = [await writePng(CODE128), await writePng(DATAMATRIX), await writePng(EAN8)];
			const png = await sharp({ create: { ...CANVAS, channels: 3, background: { r: 255, g: 255, b: 255 } } })
				.composite(codes.map((c) => ({ input: c.buf, left: c.left, top: c.top })))
				.png()
				.toBuffer();
			const [c128, dm, ean8] = codes;
			return { png, c128, dm, ean8 };
		})();
	}
	return fixturePromise;
}

function placed(code) {
	return { x: code.left, y: code.top, width: code.width, height: code.height };
}

function assertNear(actual, expected, tol, what) {
	for (const k of ["x", "y", "width", "height"]) {
		assert.ok(
			Math.abs(actual[k] - expected[k]) <= tol,
			`${what}.${k}: ${actual[k]} vs placed ${expected[k]} (tol ${tol}) - ${JSON.stringify(actual)}`,
		);
	}
}

function iou(a, b) {
	const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
	const inter = ix * iy;
	return inter / (a.width * a.height + b.width * b.height - inter);
}

function byFormat(results, format) {
	return results.filter((r) => r.format === format);
}

// A region around both codes, and a second, differently padded one that
// also holds both: the overlap a padded profile region or two hand-drawn
// regions produce.
const BOTH_A = { label: "A", x: 50, y: 100, width: 1000, height: 300 };
const BOTH_B = { label: "B", x: 40, y: 90, width: 1050, height: 320 };
// A full-width band through the middle 30 rows of the Code128 only.
const CUT = { label: "cut", x: 60, y: 200, width: 600, height: 30 };

test("whole image: both codes found offline, symbol boxes on their placement", async () => {
	const { png, c128, dm } = await fixture();
	const { results, usedFullImage, imageWidth, imageHeight } = await locateBarcodes(png, { mode: "autoOnly" });
	assert.strictEqual(usedFullImage, true);
	assert.deepStrictEqual([imageWidth, imageHeight], [CANVAS.width, CANVAS.height]);
	assert.strictEqual(results.length, 2, JSON.stringify(results.map((r) => [r.format, r.text])));

	const [code] = byFormat(results, "Code128");
	assert.ok(code, "Code128 found");
	assert.strictEqual(code.text, c128.text);
	assertNear(code.symbol, placed(c128), 3, "Code128 symbol");

	const [matrix] = byFormat(results, "DataMatrix");
	assert.ok(matrix, "DataMatrix found");
	assert.strictEqual(matrix.text, dm.text);
	assertNear(matrix.symbol, placed(dm), 3, "DataMatrix symbol");

	for (const r of results) {
		assert.strictEqual(r.source, "fullImage");
		assert.ok(Buffer.isBuffer(r.previewBuffer));
	}
	assert.deepStrictEqual(networkCalls, [], "zxing must not reach for the network");
});

test("regions: symbol is in full-image coordinates and roi is still the region", async () => {
	const { png, c128, dm } = await fixture();
	const { results, usedFullImage } = await locateBarcodes(png, { mode: "regionsOnly", regions: [BOTH_A] });
	assert.strictEqual(usedFullImage, false);
	assert.strictEqual(results.length, 2);
	for (const r of results) {
		assert.strictEqual(r.source, "region");
		assert.strictEqual(r.regionLabel, "A");
		assert.deepStrictEqual(r.roi, { x: BOTH_A.x, y: BOTH_A.y, width: BOTH_A.width, height: BOTH_A.height });
	}
	assertNear(byFormat(results, "Code128")[0].symbol, placed(c128), 3, "Code128 symbol");
	assertNear(byFormat(results, "DataMatrix")[0].symbol, placed(dm), 3, "DataMatrix symbol");
});

test("two overlapping regions each holding both codes give exactly two results, first region's label", async () => {
	const { png } = await fixture();
	const { results } = await locateBarcodes(png, { mode: "regionsOnly", regions: [BOTH_A, BOTH_B] });
	assert.strictEqual(results.length, 2, JSON.stringify(results.map((r) => [r.format, r.regionLabel])));
	assert.deepStrictEqual(results.map((r) => r.format).sort(), ["Code128", "DataMatrix"]);
	for (const r of results) assert.strictEqual(r.regionLabel, "A");

	// and the other order keeps the other label: "first" is the list order
	const swapped = await locateBarcodes(png, { mode: "regionsOnly", regions: [BOTH_B, BOTH_A] });
	assert.strictEqual(swapped.results.length, 2);
	for (const r of swapped.results) assert.strictEqual(r.regionLabel, "B");
});

test("a region that cuts the Code128 short still dedups (intersection, not IoU)", async () => {
	const { png, c128 } = await fixture();

	// Precondition, the reason for the rule: through the cut region the
	// Code128 decodes with a box only as tall as the rows it saw, so its
	// IoU with the full read is far under 0.5.
	const cutOnly = await locateBarcodes(png, { mode: "regionsOnly", regions: [CUT] });
	const fullOnly = await locateBarcodes(png, { mode: "regionsOnly", regions: [BOTH_A] });
	const cutRead = byFormat(cutOnly.results, "Code128")[0];
	const fullRead = byFormat(fullOnly.results, "Code128")[0];
	assert.ok(cutRead, "precondition: the cut region still decodes the Code128");
	assert.ok(fullRead, "precondition: the full region decodes the Code128");
	assert.strictEqual(cutRead.text, c128.text);
	const overlap = iou(cutRead.symbol, fullRead.symbol);
	assert.ok(overlap < 0.5, `precondition: IoU ${overlap.toFixed(2)} is what an IoU rule would miss`);

	const { results } = await locateBarcodes(png, { mode: "regionsOnly", regions: [CUT, BOTH_A] });
	const codes = byFormat(results, "Code128");
	assert.strictEqual(codes.length, 1, JSON.stringify(codes.map((r) => [r.regionLabel, r.symbol])));
	assert.strictEqual(codes[0].regionLabel, "cut");
	assert.strictEqual(byFormat(results, "DataMatrix").length, 1);
	assert.strictEqual(results.length, 2);
});

test("raw input decodes to the same results as the PNG", async () => {
	const { png } = await fixture();
	const strip = (rs) => rs.map(({ text, format, source, regionLabel, roi, symbol }) => ({ text, format, source, regionLabel, roi, symbol }));

	// every channel count cropToImageData expands: grey, grey+alpha, RGB, RGBA
	for (const channels of [4, 3, 2, 1]) {
		let pipeline = sharp(png).removeAlpha();
		if (channels <= 2) pipeline = pipeline.toColourspace("b-w");
		if (channels === 4) pipeline = pipeline.ensureAlpha();
		const decoded = await pipeline.raw().toBuffer({ resolveWithObject: true });
		const info = { ...decoded.info };
		let data = decoded.data;
		if (channels === 2) {
			// sharp keeps a b-w image single-channel even with ensureAlpha
			data = Buffer.alloc(data.length * 2, 255);
			for (let i = 0; i < decoded.data.length; i++) data[i * 2] = decoded.data[i];
			info.channels = 2;
		}
		assert.strictEqual(info.channels, channels, "precondition: raw channel count");

		// the descriptor goes through the same helpers barcode-locate uses
		const msg = { payload: data, rawInfo: { width: info.width, height: info.height, channels } };
		const raw = rawGeometry(msg, msg.payload);
		assert.deepStrictEqual(raw, { width: CANVAS.width, height: CANVAS.height, channels });
		assertRawFits(data, raw, "msg.payload");

		for (const options of [{ mode: "autoOnly" }, { mode: "regionsOnly", regions: [BOTH_A, CUT] }]) {
			const fromPng = await locateBarcodes(png, options);
			const fromRaw = await locateBarcodes(data, { ...options, raw });
			assert.deepStrictEqual([fromRaw.imageWidth, fromRaw.imageHeight], [CANVAS.width, CANVAS.height]);
			assert.strictEqual(fromRaw.usedFullImage, fromPng.usedFullImage);
			assert.ok(fromPng.results.length >= 2, `${options.mode}: PNG finds the codes`);
			assert.deepStrictEqual(strip(fromRaw.results), strip(fromPng.results), `${channels}-channel raw, ${options.mode}`);
			for (const r of fromRaw.results) {
				const meta = await sharp(r.previewBuffer).metadata();
				assert.deepStrictEqual([meta.format, meta.width, meta.height], ["png", r.roi.width, r.roi.height], "the preview is the roi");
			}
		}
	}
});

test("a region naming its format is searched for that format first, then every enabled one", async () => {
	const { png, c128 } = await fixture();
	const box = { x: c128.left - 60, y: c128.top - 60, width: c128.width + 120, height: c128.height + 120 };
	const read = async (format) => (await locateBarcodes(png, { mode: "regionsOnly", regions: [{ ...box, label: "c", format }] })).results;

	assert.deepStrictEqual((await read("Code128")).map((r) => r.text), [c128.text]);
	// a QR code's region holding a Code128 reads nothing for QR, then the Code128
	assert.deepStrictEqual((await read("QRCode")).map((r) => [r.format, r.text]), [["Code128", c128.text]]);
	// a format the caller did not enable leaves the region's search as it was
	const notEnabled = await locateBarcodes(png, {
		mode: "regionsOnly",
		regions: [{ ...box, label: "c", format: "EAN8" }],
		readerOptions: { formats: ["Code128"], tryHarder: true, tryRotate: true },
	});
	assert.deepStrictEqual(notEnabled.results.map((r) => r.text), [c128.text]);
});

test("a profile region holding a code of another format still reports it", async () => {
	// A wrong label printed in another symbology: the profile recorded a
	// Code128 in region B, the part carries a DataMatrix there. Region A
	// reads, so regionsThenAuto never falls back to the full image - region
	// B alone has to report the DataMatrix.
	const { png, c128, dm } = await fixture();
	const pad = (code) => ({ x: code.left - 60, y: code.top - 60, width: code.width + 120, height: code.height + 120 });
	const { results, usedFullImage } = await locateBarcodes(png, {
		mode: "regionsThenAuto",
		regions: [
			{ ...pad(c128), label: "A", format: "Code128" },
			{ ...pad(dm), label: "B", format: "Code128" },
		],
		readerOptions: { formats: ["Code128", "DataMatrix"], tryHarder: true, tryRotate: true },
	});
	assert.strictEqual(usedFullImage, false);
	assert.deepStrictEqual(
		results.map((r) => [r.format, r.text, r.regionLabel]).sort(),
		[
			["Code128", c128.text, "A"],
			["DataMatrix", dm.text, "B"],
		],
	);
});

test("barcode-locate reads a raw payload in place: not copied, not changed", async () => {
	const { png } = await fixture();
	const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const frame = { data, width: info.width, height: info.height, channels: 3 };

	const view = await resolveImage(frame, "msg.payload", { copy: false });
	assert.strictEqual(view.buffer, data.buffer, "copy: false is the caller's memory");
	assert.strictEqual(view.byteOffset, data.byteOffset);
	assert.notStrictEqual((await resolveImage(frame, "msg.payload")).buffer, data.buffer, "the default still copies");

	const before = Buffer.from(data);
	const node = loadNode("barcode-locate.js", { mode: "autoOnly" });
	const sent = [];
	node.send = (m) => sent.push(m);
	const errors = [];
	await node.listeners.input({ payload: frame }, undefined, (err) => err && errors.push(err));
	assert.deepStrictEqual(errors, []);
	assert.deepStrictEqual(sent.map((m) => m.text).sort(), ["VT-DM-0042", "VT-LOCATE-128"]);
	assert.ok(data.equals(before), "the frame the next node gets is the one this node got");
});

test("nodeInput raw helpers: descriptor rules and the length guard", () => {
	const data = Buffer.alloc(10 * 4 * 3);
	assert.deepStrictEqual(rawGeometry(undefined, { data, width: 10, height: 4, channels: 3 }), { width: 10, height: 4, channels: 3 });
	assert.deepStrictEqual(rawGeometry({ rawInfo: { width: "10", height: "4", channels: "3" } }, data), { width: 10, height: 4, channels: 3 });
	assert.strictEqual(rawGeometry({ rawInfo: { width: 10, height: 4 } }, data), undefined, "partial descriptor is none");
	assert.strictEqual(rawGeometry({ rawInfo: { width: 10, height: 4, channels: 5 } }, data), undefined);
	assert.strictEqual(rawGeometry({}, data), undefined, "an encoded file has no raw geometry");
	const images = [{ page: 1, width: 10, height: 4, channels: 3 }];
	assert.deepStrictEqual(rawGeometry({ format: "RAW", images }, data), { width: 10, height: 4, channels: 3 });
	assert.strictEqual(rawGeometry({ format: "RAW", images, golden: "/g.png" }, data), undefined, "msg.images describes the golden when one rides along");

	assert.doesNotThrow(() => assertRawFits(data, { width: 10, height: 4, channels: 3 }, "msg.payload"));
	assert.doesNotThrow(() => assertRawFits(data, undefined, "msg.payload"));
	assert.throws(() => assertRawFits(data, { width: 10, height: 5, channels: 3 }, "msg.payload"), /msg\.payload raw descriptor 10x5x3 needs 150 bytes but the buffer holds 120/);
});

test("locateSource: a missing bare path and a missing path in an object say different things", () => {
	const { locateSource } = require("../lib/nodeInput.js");
	const missing = path.join(__dirname, "no-such-golden.png");
	assert.strictEqual(typeof locateSource, "function", "nodeInput exports locateSource");

	const bare = locateSource(missing, "msg.golden");
	assert.deepStrictEqual(bare, { path: missing, missing: `msg.golden does not exist on disk: "${missing}"` });
	const inObject = locateSource({ path: missing }, "msg.golden");
	assert.deepStrictEqual(inObject, {
		path: missing,
		missing: 'msg.golden object must contain "data"/"buffer" or an existing "path"',
	});
	assert.throws(() => locateSource({}, "msg.golden"), /^Error: msg\.golden object must contain "data"\/"buffer" or an existing "path"$/);
	assert.throws(() => locateSource("", "msg.golden"), /^Error: msg\.golden is empty$/);
	assert.throws(() => locateSource(5, "msg.golden"), /^Error: unsupported msg\.golden type: number$/);
	const data = Buffer.alloc(4);
	assert.strictEqual(locateSource({ data }, "msg.golden").data, data);
});

test("resolveImage on a missing path keeps both errors", async () => {
	const missing = path.join(__dirname, "no-such-golden.png");
	await assert.rejects(resolveImage(missing, "msg.golden"), { message: `msg.golden does not exist on disk: "${missing}"` });
	await assert.rejects(resolveImage({ path: missing }, "msg.golden"), {
		message: 'msg.golden object must contain "data"/"buffer" or an existing "path"',
	});
});

// copy: true promises bytes the caller can no longer change: each source
// kind is mutated after the call and the result must not follow it.
test("resolveImage copy:true: an ArrayBuffer source is copied, not viewed", async () => {
	const ab = new Uint8Array([1, 2, 3, 4]).buffer;
	const out = await resolveImage(ab, "msg.payload", { copy: true });
	new Uint8Array(ab).fill(9);
	assert.deepStrictEqual([...out], [1, 2, 3, 4]);
});

test("resolveImage copy:true: a Buffer source is copied, not viewed", async () => {
	const buf = Buffer.from([1, 2, 3, 4]);
	const out = await resolveImage(buf, "msg.payload", { copy: true });
	buf.fill(9);
	assert.deepStrictEqual([...out], [1, 2, 3, 4]);
});

test("resolveImage copy:true: a Uint8Array at an offset is copied, its own range only", async () => {
	const backing = new Uint8Array([7, 7, 1, 2, 3, 4, 7, 7]);
	const view = backing.subarray(2, 6);
	const out = await resolveImage({ data: view }, "msg.payload", { copy: true });
	backing.fill(9);
	assert.deepStrictEqual([...out], [1, 2, 3, 4]);
});

test("resolveImage copy:true: a file path's bytes do not follow the file", async (t) => {
	const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vt-resolve-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "frame.bin");
	fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
	const out = await resolveImage(file, "msg.payload", { copy: true });
	fs.writeFileSync(file, Buffer.from([9, 9, 9, 9]));
	assert.deepStrictEqual([...out], [1, 2, 3, 4]);
});

test("EAN-8 is off by default and found when asked for", async () => {
	const { png, ean8 } = await fixture();
	assert.ok(!DEFAULT_FORMATS.includes("EAN8"));

	const byDefault = await locateBarcodes(png, { mode: "autoOnly" });
	assert.strictEqual(byFormat(byDefault.results, "EAN8").length, 0, "EAN-8 must not be read with the default formats");

	// the code itself is readable - the default, not the fixture, is why
	const asked = await locateBarcodes(png, { mode: "autoOnly", readerOptions: { formats: [...DEFAULT_FORMATS, "EAN8"], tryHarder: true, tryRotate: true } });
	const found = byFormat(asked.results, "EAN8");
	assert.strictEqual(found.length, 1);
	assert.ok(found[0].text.startsWith(ean8.text), `${found[0].text} (check digit appended)`);
	// EAN guard bars run below the others, so only the box's top and
	// width are pinned; its bottom lies within the PNG
	const sym = found[0].symbol;
	assert.ok(Math.abs(sym.x - ean8.left) <= 3 && Math.abs(sym.y - ean8.top) <= 3, JSON.stringify(sym));
	assert.ok(Math.abs(sym.width - ean8.width) <= 3 && sym.y + sym.height <= ean8.top + ean8.height + 3, JSON.stringify(sym));
	assert.deepStrictEqual(networkCalls, []);
});

test("timings: every stage is reported; bare pixels skip the header read and the decode", async () => {
	const { png, c128 } = await fixture();
	const fromPng = await locateBarcodes(png, { mode: "regionsOnly", regions: [placed(c128)] });
	for (const k of ["warmupMs", "headerMs", "decodeMs", "cropMs", "readMs", "previewMs", "regionsMs"]) {
		assert.ok(typeof fromPng.timings[k] === "number" && fromPng.timings[k] >= 0, `${k}: ${fromPng.timings[k]}`);
	}
	assert.ok(!("fullImageMs" in fromPng.timings), "no fallback ran");
	assert.ok(fromPng.timings.headerMs > 0 && fromPng.timings.decodeMs > 0, "a PNG is read and decoded");
	assert.ok(fromPng.timings.readMs > 0, "one read");
	assert.ok(fromPng.results[0].decodeMs > 0 && fromPng.results[0].decodeMs <= fromPng.timings.readMs);
	// previewMs is the wait after the reads; a whole-canvas region's
	// encode cannot have finished before its read ends
	const whole = await locateBarcodes(png, { mode: "regionsOnly", regions: [{ x: 0, y: 0, width: CANVAS.width, height: CANVAS.height }] });
	assert.ok(whole.timings.previewMs > 0, `previewMs ${whole.timings.previewMs}`);

	const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const raw = { width: decoded.info.width, height: decoded.info.height, channels: 4 };
	const fromRaw = await locateBarcodes(decoded.data, { mode: "regionsOnly", regions: [placed(c128)], raw });
	assert.strictEqual(fromRaw.timings.headerMs, 0);
	assert.strictEqual(fromRaw.timings.decodeMs, 0);
	assert.ok(fromRaw.timings.readMs > 0);

	const full = await locateBarcodes(png, { mode: "autoOnly" });
	assert.ok(full.timings.fullImageMs > 0 && !("regionsMs" in full.timings));
});

test("preview: false leaves previewBuffer null and encodes nothing", async () => {
	const { png, c128, dm } = await fixture();
	const on = await locateBarcodes(png, { mode: "regionsOnly", regions: [placed(c128)] });
	const off = await locateBarcodes(png, { mode: "regionsOnly", regions: [placed(c128)], preview: false });
	assert.strictEqual(on.results.length, 1);
	assert.ok(Buffer.isBuffer(on.results[0].previewBuffer));
	assert.strictEqual(off.results.length, 1);
	assert.strictEqual(off.results[0].previewBuffer, null);
	assert.strictEqual(off.timings.previewMs, 0);
	assert.strictEqual(off.results[0].text, on.results[0].text);

	// the encodes are deferred past the reads: each result still gets its
	// own region's PNG, the size of its roi
	const two = await locateBarcodes(png, { mode: "regionsOnly", regions: [placed(c128), placed(dm)] });
	assert.strictEqual(two.results.length, 2);
	for (const r of two.results) {
		const meta = await sharp(r.previewBuffer).metadata();
		assert.deepStrictEqual([meta.width, meta.height], [r.roi.width, r.roi.height], `${r.text} preview is its own region`);
	}
	assert.ok(!two.results[0].previewBuffer.equals(two.results[1].previewBuffer));

	const fullOff = await locateBarcodes(png, { mode: "autoOnly", preview: false });
	assert.ok(fullOff.results.length >= 2);
	assert.ok(fullOff.results.every((r) => r.previewBuffer === null));
	assert.strictEqual(fullOff.timings.previewMs, 0);
});

test("barcode-locate node: msg.timings spans the frame end to end, and Preview off passes the payload through", async () => {
	const { png, c128 } = await fixture();
	for (const preview of [true, false]) {
		const node = loadNode("barcode-locate.js", { mode: "regionsOnly", regions: [placed(c128)], preview });
		const sent = [];
		node.send = (m) => sent.push(m);
		const errors = [];
		await node.listeners.input({ payload: png }, undefined, (err) => err && errors.push(err));
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(sent.length, 1);
		const t = sent[0].timings;
		for (const k of ["inputMs", "profileMs", "warmupMs", "headerMs", "decodeMs", "cropMs", "readMs", "previewMs", "regionsMs", "totalMs"]) {
			assert.ok(typeof t[k] === "number" && t[k] >= 0, `${k}: ${t[k]}`);
		}
		assert.ok(t.totalMs >= t.inputMs + t.regionsMs, "the node's total spans input and the pass");
		assert.strictEqual(t.profileMs, 0, "no profile was looked up");
		if (preview) {
			assert.ok(Buffer.isBuffer(sent[0].payload) && sent[0].payload !== png, "a preview PNG");
		} else {
			assert.strictEqual(sent[0].payload, png, "the input passes through");
			assert.strictEqual(t.previewMs, 0);
		}
	}
	// a node saved before the option existed has no preview key: on
	const legacy = loadNode("barcode-locate.js", { mode: "regionsOnly", regions: [placed(c128)] });
	assert.strictEqual(legacy.preview, true);
	const sent = [];
	legacy.send = (m) => sent.push(m);
	await legacy.listeners.input({ payload: png }, undefined, () => {});
	assert.ok(Buffer.isBuffer(sent[0].payload) && sent[0].payload !== png, "a legacy node still previews");
});
