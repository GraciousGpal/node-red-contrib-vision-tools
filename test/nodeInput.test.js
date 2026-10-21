/**
 * lib/nodeInput.js: the image loader and raw-geometry helpers every node
 * reads msg.payload / msg.golden through.
 *
 * The bugs this suite exists for:
 *
 *  - the object form ({ data }) rejected an ArrayBuffer the top-level form
 *    accepted;
 *  - a path was read after only an access() check: a non-regular file
 *    (/dev/zero, a directory) was read forever, and the check/read pair
 *    was a race;
 *  - there was no size cap on buffer inputs;
 *  - copy: true handed back a view of an ArrayBuffer source, so the
 *    caller's later writes showed through.
 *
 * The node tests keep one wiring proof each (a missing path through done);
 * the guards themselves are pinned here, once.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	rawGeometry,
	assertRawFits,
	locateSource,
	resolveImage,
	assertImageSignature,
	sharpInput,
	assertPixelsUnderCap,
	geometryOf,
	MAX_INPUT_PIXELS,
} = require("../lib/nodeInput.js");
const sharp = require("sharp");
const zlib = require("node:zlib");

const made = [];
test.after(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vt-nodeinput-"));
	made.push(dir);
	return dir;
}

test("raw helpers: descriptor rules and the length guard", () => {
	const data = Buffer.alloc(10 * 4 * 3);
	assert.deepStrictEqual(rawGeometry(undefined, { data, width: 10, height: 4, channels: 3 }), { width: 10, height: 4, channels: 3 });
	assert.deepStrictEqual(rawGeometry({ rawInfo: { width: "10", height: "4", channels: "3" } }, data), { width: 10, height: 4, channels: 3 });
	assert.strictEqual(rawGeometry({ rawInfo: { width: 10, height: 4 } }, data), undefined, "partial descriptor is none");
	assert.strictEqual(rawGeometry({ rawInfo: { width: 10, height: 4, channels: 5 } }, data), undefined);
	assert.strictEqual(rawGeometry({}, data), undefined, "an encoded file has no raw geometry");
	const images = [{ page: 1, width: 10, height: 4, channels: 3 }];
	assert.deepStrictEqual(rawGeometry({ format: "RAW", images }, data), { width: 10, height: 4, channels: 3 });
	assert.strictEqual(rawGeometry({ format: "RAW", images, golden: "/g.png" }, data), undefined, "msg.images describes the golden when one rides along");

	assertRawFits(data, { width: 10, height: 4, channels: 3 }, "msg.payload");
	assertRawFits(data, undefined, "msg.payload");
	assert.throws(() => assertRawFits(data, { width: 10, height: 5, channels: 3 }, "msg.payload"), /msg\.payload raw descriptor 10x5x3 needs 150 bytes but the buffer holds 120/);
});

test("locateSource: a missing bare path and a missing path in an object say different things", () => {
	const missing = path.join(__dirname, "no-such-golden.png");

	const bare = locateSource(missing, "msg.golden");
	assert.strictEqual(bare.path, missing);
	assert.match(bare.missing, /msg\.golden does not exist on disk/);
	const inObject = locateSource({ path: missing }, "msg.golden");
	assert.strictEqual(inObject.path, missing);
	assert.match(inObject.missing, /msg\.golden object must contain "data"\/"buffer" or an existing "path"/);

	assert.throws(() => locateSource({}, "msg.golden"), /msg\.golden object must contain/);
	assert.throws(() => locateSource("", "msg.golden"), /msg\.golden is empty/);
	assert.throws(() => locateSource(5, "msg.golden"), /unsupported msg\.golden type: number/);
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

test("resolveImage refuses a path that is not a regular file instead of reading it", async () => {
	const dir = tmpDir(); // a directory opens, but is not a regular file
	await assert.rejects(resolveImage(dir, "msg.payload"), /msg\.payload is not a regular file/);
});

test("resolveImage refuses a buffer over the 512MB cap before copying it", async () => {
	// the only allocation of this size in the suite
	const big = new Uint8Array(512 * 1024 * 1024 + 1);
	await assert.rejects(
		resolveImage(big, "msg.payload"),
		/msg\.payload is 536870913 bytes, above the 536870912-byte cap/,
	);
});

test("resolveImage accepts an ArrayBuffer in the object form, as at the top level", async () => {
	const ab = new Uint8Array([1, 2, 3, 4]).buffer;
	assert.deepStrictEqual([...(await resolveImage({ data: ab }, "msg.payload", { raw: true }))], [1, 2, 3, 4]);
	assert.deepStrictEqual([...(await resolveImage(ab, "msg.payload", { raw: true }))], [1, 2, 3, 4]);
});

// copy: true promises bytes the caller can no longer change: each source
// kind is mutated after the call and the result must not follow it.
test("resolveImage copy:true: no source kind's later writes show through", async () => {
	const cases = [
		{
			name: "ArrayBuffer",
			make: () => {
				const ab = new Uint8Array([1, 2, 3, 4]).buffer;
				return { source: ab, mutate: () => new Uint8Array(ab).fill(9) };
			},
		},
		{
			name: "Buffer",
			make: () => {
				const buf = Buffer.from([1, 2, 3, 4]);
				return { source: buf, mutate: () => buf.fill(9) };
			},
		},
		{
			name: "Uint8Array at an offset (its own range only)",
			make: () => {
				const backing = new Uint8Array([7, 7, 1, 2, 3, 4, 7, 7]);
				return { source: { data: backing.subarray(2, 6) }, mutate: () => backing.fill(9) };
			},
		},
		{
			name: "file path",
			make: () => {
				const file = path.join(tmpDir(), "frame.bin");
				fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
				return { source: file, mutate: () => fs.writeFileSync(file, Buffer.from([9, 9, 9, 9])) };
			},
		},
	];
	const failures = [];
	for (const { name, make } of cases) {
		try {
			const { source, mutate } = make();
			// bytes with no image header: only a raw frame is taken unsniffed
			const out = await resolveImage(source, "msg.payload", { copy: true, raw: true });
			mutate();
			assert.deepStrictEqual([...out], [1, 2, 3, 4]);
		} catch (err) {
			failures.push(`${name}: ${err.message.split("\n")[0]}`);
		}
	}
	assert.deepStrictEqual(failures, []);
});

// 256M pixels of white compress to ~280KB: a decompression bomb the size
// of a thumbnail. libvips would allocate 256MB (more as RGB) to decode it.
function whitePng(side) {
	return sharp({ create: { width: side, height: side, channels: 3, background: "#fff" } })
		.toColourspace("b-w")
		.png()
		.toBuffer();
}

test("assertImageSignature refuses SVG in any disguise, and anything else without a known signature", () => {
	const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/>";
	const refused = {
		svg: Buffer.from(svg),
		xml: Buffer.from("  <?xml version='1.0'?>" + svg),
		bom: Buffer.from("\ufeff" + svg),
		doubleBom: Buffer.from("\ufeff\ufeff" + svg),
		formFeed: Buffer.from("\f" + svg),
		nbsp: Buffer.from("\u00a0" + svg),
		prefixed: Buffer.from("abc" + svg),
		svgz: zlib.gzipSync(Buffer.from(svg)),
		bmp: Buffer.from("BM" + "\0".repeat(52), "latin1"),
		empty: Buffer.alloc(0),
	};
	for (const [name, bytes] of Object.entries(refused)) {
		assert.throws(
			() => assertImageSignature(bytes, "msg.payload"),
			/^Error: msg\.payload: not a supported image \(JPEG, PNG, WebP, GIF, TIFF, HEIF\)$/,
			name,
		);
	}
});

test("assertImageSignature passes every format it names", async () => {
	const img = sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } });
	const formats = {
		jpeg: await img.clone().jpeg().toBuffer(),
		png: await img.clone().png().toBuffer(),
		webp: await img.clone().webp().toBuffer(),
		gif: await img.clone().gif().toBuffer(),
		tiffLE: await img.clone().tiff().toBuffer(),
		tiffBE: Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]),
		avif: await img.clone().avif().toBuffer(),
	};
	for (const [name, bytes] of Object.entries(formats)) {
		assert.doesNotThrow(() => assertImageSignature(bytes, "msg.payload"), name);
	}
});

test("resolveImage refuses SVG bytes and SVG files, but not a raw frame that starts with '<'", async () => {
	const svg = Buffer.from("<svg/>");
	await assert.rejects(resolveImage(svg, "msg.payload"), /not a supported image/);
	const file = path.join(tmpDir(), "art.png");
	fs.writeFileSync(file, svg);
	await assert.rejects(resolveImage(file, "msg.golden"), /msg\.golden: not a supported image/);
	// raw pixels have no header: a first pixel of 60 is just dark grey
	const out = await resolveImage(svg, "msg.payload", { raw: true });
	assert.strictEqual(out.length, svg.length);
});

test("sharpInput refuses an image above the 64M pixel cap by name, before any decode", async () => {
	const png = await whitePng(16000);
	await assert.rejects(sharpInput(png, "msg.payload"), /msg\.payload: 16000x16000 is above the 64M pixel cap/);
	const { info } = await (await sharpInput(await whitePng(100), "msg.payload")).raw().toBuffer({ resolveWithObject: true });
	assert.deepStrictEqual([info.width, info.height], [100, 100]);
});

test("assertPixelsUnderCap names the size and the cap, and passes a normal image", async () => {
	await assert.rejects(assertPixelsUnderCap(await whitePng(16000), "msg.payload"), /msg\.payload: 16000x16000 is above the 64M pixel cap/);
	await assertPixelsUnderCap(await whitePng(1000), "msg.payload");
});

test("geometryOf caps a raw descriptor at MAX_INPUT_PIXELS, the decode cap", () => {
	assert.strictEqual(MAX_INPUT_PIXELS, 64e6);
	assert.deepStrictEqual(geometryOf({ width: 8000, height: 8000, channels: 1 }), { width: 8000, height: 8000, channels: 1 });
	assert.strictEqual(geometryOf({ width: 8001, height: 8000, channels: 1 }), undefined);
});

test("assertPixelsUnderCap refuses bytes with no image signature before any header read", async () => {
	await assert.rejects(assertPixelsUnderCap(Buffer.from("not an image"), "msg.payload"), /msg\.payload: not a supported image/);
});
