/**
 * image-resize (image-resize.js): rp-resize's size rules, the engine's
 * bytes, the input and output shapes, and errors that stop the message.
 * Driven through the fake RED like the other node suites.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");
const engineModule = require("../lib/engine.js");
const { targetSize } = require("../image-resize.js");
const { loadNode } = require("./helpers/fakeRed.js");

const anyEngine = engineModule.candidate().engine !== null;
const skip = anyEngine ? false : "no OpenCV engine here";

function makeNode(config = {}) {
	const node = loadNode("image-resize.js", config);
	const sent = [];
	const statuses = [];
	node.send = (m) => sent.push(m);
	node.status = (s) => statuses.push(s);
	const run = (msg) =>
		new Promise((resolve) => {
			node.listeners.input(msg, undefined, (err) => resolve(err || null));
		});
	return { node, run, sent, statuses };
}

/** A deterministic noise image: every interpolation disagrees on noise. */
function noise(width, height, channels, seed = 7) {
	const data = Buffer.alloc(width * height * channels);
	for (let i = 0; i < data.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		data[i] = seed >>> 23;
	}
	return { data, width, height, channels, colorSpace: { 1: "GRAY", 3: "RGB", 4: "RGBA" }[channels], dtype: "uint8" };
}

// ---- size rules -------------------------------------------------------

test("sizes follow rp-resize: round(side x factor), and auto from the other side", () => {
	const half = { widthMode: "multiply", widthValue: "0.5", heightMode: "auto", heightValue: "" };
	assert.deepStrictEqual(targetSize(2950, 4250, half), { width: 1475, height: 2125 });
	// odd sides: auto is round(w' x h / w), not round(h / 2)
	assert.deepStrictEqual(targetSize(301, 199, half), { width: 151, height: 100 });
	assert.deepStrictEqual(targetSize(3001, 2001, half), { width: 1501, height: Math.round((1501 * 2001) / 3001) });
	assert.deepStrictEqual(targetSize(400, 300, { widthMode: "set", widthValue: 100, heightMode: "auto" }), { width: 100, height: 75 });
	assert.deepStrictEqual(targetSize(400, 300, { widthMode: "auto", heightMode: "multiply", heightValue: 2 }), { width: 800, height: 600 });
	assert.deepStrictEqual(targetSize(400, 300, { widthMode: "set", widthValue: 64, heightMode: "set", heightValue: "48" }), { width: 64, height: 48 });
});

test("a size that cannot be made is refused", () => {
	assert.throws(() => targetSize(400, 300, { widthMode: "auto", heightMode: "auto" }), /both be auto/);
	assert.throws(() => targetSize(400, 300, { widthMode: "multiply", widthValue: "", heightMode: "auto" }), /positive/);
	assert.throws(() => targetSize(400, 300, { widthMode: "set", widthValue: -5, heightMode: "auto" }), /positive/);
	assert.throws(() => targetSize(400, 300, { widthMode: "multiply", widthValue: 0.001, heightMode: "auto" }), /0x0/);
});

// ---- the engine's bytes -------------------------------------------------

test("a raw image is resized to the engine's INTER_LINEAR bytes, channels and colour space kept", { skip }, async () => {
	const { engine } = engineModule.candidate();
	for (const channels of [1, 3, 4]) {
		const { run, sent } = makeNode({ widthMode: "multiply", widthValue: "0.5", heightMode: "auto" });
		const image = noise(301, 199, channels);
		const err = await run({ payload: image, topic: "t" });
		assert.strictEqual(err, null);
		const out = sent[0].payload;
		const want = (await engine.resize(image, "num", 151, "num", 100, "raw")).image;
		assert.deepStrictEqual([out.width, out.height, out.channels, out.colorSpace, out.dtype], [151, 100, channels, image.colorSpace, "uint8"]);
		assert.ok(Buffer.isBuffer(out.data) && out.data.equals(Buffer.from(want.data)));
		assert.strictEqual(sent[0].topic, "t"); // the rest of the message rides along
	}
});

test("the opencv.js engine gives the same bytes", { skip }, async () => {
	const previous = process.env.VISION_TOOLS_ENGINE;
	const image = noise(240, 160, 3);
	const outputs = [];
	try {
		for (const mode of ["auto", "opencv-js"]) {
			process.env.VISION_TOOLS_ENGINE = mode;
			engineModule._reset();
			if (!engineModule.candidate().engine) continue;
			const { run, sent } = makeNode({ widthMode: "set", widthValue: 97, heightMode: "auto" });
			assert.strictEqual(await run({ payload: image }), null);
			outputs.push(sent[0].payload.data);
		}
	} finally {
		if (previous === undefined) delete process.env.VISION_TOOLS_ENGINE;
		else process.env.VISION_TOOLS_ENGINE = previous;
		engineModule._reset();
	}
	if (outputs.length === 2) assert.ok(outputs[0].equals(outputs[1]));
});

// ---- input and output shapes -------------------------------------------

test("input and output paths, a bare Buffer with msg.rawInfo, and an encoded image", { skip }, async () => {
	const image = noise(64, 48, 3);
	const a = makeNode({ inputPath: "frame.image", outputPath: "small", widthMode: "multiply", widthValue: 0.5, heightMode: "auto" });
	assert.strictEqual(await a.run({ frame: { image } }), null);
	assert.deepStrictEqual([a.sent[0].small.width, a.sent[0].small.height], [32, 24]);
	assert.strictEqual(a.sent[0].frame.image, image); // input left in place

	const b = makeNode({ widthMode: "multiply", widthValue: 0.5, heightMode: "auto" });
	assert.strictEqual(await b.run({ payload: image.data, rawInfo: { width: 64, height: 48, channels: 3 } }), null);
	assert.ok(b.sent[0].payload.data.equals(a.sent[0].small.data));

	const png = await sharp(image.data, { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer();
	const c = makeNode({ widthMode: "multiply", widthValue: 0.5, heightMode: "auto" });
	assert.strictEqual(await c.run({ payload: png }), null);
	assert.ok(c.sent[0].payload.data.equals(a.sent[0].small.data), "png decodes to the same pixels");

	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-resize-"));
	const file = path.join(dir, "frame.png");
	await fsp.writeFile(file, png);
	const d = makeNode({ widthMode: "multiply", widthValue: 0.5, heightMode: "auto" });
	assert.strictEqual(await d.run({ payload: file }), null);
	assert.ok(d.sent[0].payload.data.equals(a.sent[0].small.data), "a file path reads the same");
	await fsp.rm(dir, { recursive: true, force: true });
});

test("png and jpg outputs are encoded Buffers of the resized image", { skip }, async () => {
	const image = noise(80, 60, 3);
	const raw = makeNode({ widthMode: "multiply", widthValue: 0.5, heightMode: "auto" });
	await raw.run({ payload: image });
	const png = makeNode({ widthMode: "multiply", widthValue: 0.5, heightMode: "auto", outputFormat: "png" });
	assert.strictEqual(await png.run({ payload: image }), null);
	const decoded = await sharp(png.sent[0].payload).raw().toBuffer({ resolveWithObject: true });
	assert.deepStrictEqual([decoded.info.width, decoded.info.height], [40, 30]);
	assert.ok(decoded.data.equals(raw.sent[0].payload.data), "png is lossless");
	const jpg = makeNode({ widthMode: "multiply", widthValue: 0.5, heightMode: "auto", outputFormat: "jpg", outputQuality: 80 });
	assert.strictEqual(await jpg.run({ payload: image }), null);
	assert.ok(Buffer.isBuffer(jpg.sent[0].payload) && jpg.sent[0].payload[0] === 0xff && jpg.sent[0].payload[1] === 0xd8);
});

// ---- errors --------------------------------------------------------------

test("a bad input stops the message with an error and a red status", { skip }, async () => {
	const cases = [
		[{ payload: "" }, /empty/],
		[{ payload: "/nonexistent/frame.png" }, /does not exist/],
		[{ payload: { data: Buffer.alloc(10) } }, /no usable width/],
		[{ payload: { data: Buffer.alloc(10), width: 10, height: 10, channels: 3 } }, /needs 300 bytes/],
		[{ payload: { ...noise(4, 4, 1), dtype: "float32" } }, /uint8/],
		[{ payload: Buffer.from("not an image") }, /./],
		[{ payload: 42 }, /image object/],
	];
	for (const [msg, re] of cases) {
		const { run, sent, statuses } = makeNode({});
		const err = await run(msg);
		assert.ok(err && re.test(err.message), `${JSON.stringify(msg).slice(0, 60)}: ${err && err.message}`);
		assert.strictEqual(sent.length, 0);
		assert.strictEqual(statuses.at(-1).fill, "red");
	}
	const bad = makeNode({ widthMode: "auto", heightMode: "auto" });
	const err = await bad.run({ payload: noise(8, 8, 1) });
	assert.match(err.message, /both be auto/);
});
