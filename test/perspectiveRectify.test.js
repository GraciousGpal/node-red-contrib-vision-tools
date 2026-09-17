/**
 * perspective-rectify Node-RED glue (perspective-rectify.js), driven
 * through a fake RED like the other node suites. The warp itself is
 * covered in homography.test.js; this checks what the node does around
 * it - the scale file contract, input shapes, output shapes, the
 * resolution rescale, and that failures are setup errors rather than
 * silent pass-throughs.
 *
 * Runs on the inspector worker by default; GOLDEN_COMPARE_INLINE=1
 * exercises the same code on the calling thread.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");
const inspector = require("../lib/inspector.js");
const { applyHomography } = require("../lib/homography.js");

function makeNode(config = {}) {
	const RED = {
		nodes: {
			createNode(node, cfg) {
				node.config = cfg;
				node.listeners = {};
				node.on = (evt, fn) => {
					node.listeners[evt] = fn;
				};
				node.send = () => {};
				node.error = () => {};
				node.warn = () => {};
				node.log = () => {};
				node.status = () => {};
			},
			registerType(name, ctor) {
				RED.nodes.ctor = ctor;
			},
		},
	};
	require("../perspective-rectify.js")(RED);
	const node = new RED.nodes.ctor(config);
	const sent = [];
	const errors = [];
	const doneErrors = [];
	node.send = (m) => sent.push(m);
	node.error = (m) => errors.push(String(m));
	const run = (msg) =>
		node.listeners.input(msg, undefined, (err) => {
			if (err) doneErrors.push(err && err.message ? String(err.message) : String(err));
		});
	return { node, run, sent, errors, doneErrors };
}

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), "gc-rectify-"));

// shift right by 3, down by 2: a homography whose effect is easy to read
// off a pixel
const SHIFT = [1, 0, 3, 0, 1, 2, 0, 0, 1];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

async function scaleFile(dir, record) {
	const p = path.join(dir, "scale.json");
	await fsp.writeFile(
		p,
		JSON.stringify({
			mmPerPixelNative: 0.05,
			nativeWidth: 40,
			nativeHeight: 30,
			calibratedAt: "2026-09-17T00:00:00.000Z",
			...record,
		}),
	);
	return p;
}

/** 40x30 grey frame with one bright pixel at (7, 5). */
function dotFrame(channels = 1) {
	const data = Buffer.alloc(40 * 30 * channels);
	for (let ch = 0; ch < channels; ch++) data[(5 * 40 + 7) * channels + ch] = 200;
	return { data, width: 40, height: 30, channels };
}

test.after(() => inspector.shutdown());

test("a raw frame is warped through the stored homography and comes back raw", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	await run({ payload: dotFrame() });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	const out = sent[0].payload;
	assert.ok(Buffer.isBuffer(out.data), "raw output carries a Buffer");
	assert.strictEqual(out.width, 40);
	assert.strictEqual(out.height, 30);
	assert.strictEqual(out.channels, 1);
	assert.strictEqual(out.colorSpace, "GRAY");
	assert.strictEqual(out.dtype, "uint8");
	assert.strictEqual(out.data[7 * 40 + 10], 200, "the dot moved by (3, 2)");
	assert.strictEqual(out.data[5 * 40 + 7], 0);
	const meta = sent[0].rectify;
	assert.strictEqual(meta.applied, true);
	assert.strictEqual(meta.reason, "ok");
	assert.deepStrictEqual(meta.homography, SHIFT);
	assert.strictEqual(meta.rescaledFrom, null);
	assert.strictEqual(typeof meta.timings.warpMs, "number");
});

test("an identity homography passes the frame through and says so", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: IDENTITY }) });
	const frame = dotFrame(3);
	await run({ payload: frame });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent[0].rectify.applied, false);
	assert.strictEqual(sent[0].rectify.reason, "identity");
	assert.strictEqual(sent[0].payload.data[(5 * 40 + 7) * 3], 200);
	assert.strictEqual(sent[0].payload.colorSpace, "RGB");
});

test("an encoded frame is decoded, warped, and re-encoded on request", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({
		scaleFilePath: await scaleFile(dir, { homography: SHIFT }),
		outputFormat: "png",
	});
	const f = dotFrame();
	const png = await sharp(f.data, { raw: { width: 40, height: 30, channels: 1 } })
		.png()
		.toBuffer();
	await run({ payload: png });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	const out = sent[0].payload;
	assert.ok(Buffer.isBuffer(out));
	const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
	assert.strictEqual(info.width, 40);
	assert.strictEqual(info.height, 30);
	// sharp decides the decoded channel count (a grey PNG may come back
	// expanded); the dot is wherever it is at (10, 7), and nowhere at (7, 5)
	assert.strictEqual(data[(7 * 40 + 10) * info.channels], 200);
	assert.strictEqual(data[(5 * 40 + 7) * info.channels], 0);
	// and msg.outputFormat overrides the configured one
	const again = makeNode({
		scaleFilePath: await scaleFile(dir, { homography: SHIFT }),
		outputFormat: "png",
	});
	await again.run({ payload: png, outputFormat: "raw" });
	assert.strictEqual(again.sent[0].payload.width, 40);
});

test("a bare raw Buffer with msg.rawInfo is taken as raw", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	const f = dotFrame();
	await run({ payload: f.data, rawInfo: { width: 40, height: 30, channels: 1 } });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent[0].payload.data[7 * 40 + 10], 200);
});

test("a frame at another resolution of the same field of view gets the rescaled homography", async () => {
	const dir = await tmpDir();
	// calibrated at 40x30 with a 3px/2px shift; an 80x60 frame must shift 6/4
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	const data = Buffer.alloc(80 * 60);
	data[10 * 80 + 14] = 200;
	await run({ payload: { data, width: 80, height: 60, channels: 1 } });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	const out = sent[0].payload;
	assert.strictEqual(out.data[14 * 80 + 20], 200);
	assert.deepStrictEqual(sent[0].rectify.rescaledFrom, { width: 40, height: 30 });
	const q = applyHomography(sent[0].rectify.homography, 0, 0);
	assert.strictEqual(q.x, 6);
	assert.strictEqual(q.y, 4);
});

test("a frame with a different aspect ratio passes through unrectified, with a reason", async () => {
	// One odd frame must not stall the line: the original goes on with
	// applied:false so the inspection behind this node still grades it.
	const dir = await tmpDir();
	const { node, run, sent, doneErrors, errors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	const warnings = [];
	node.warn = (w) => warnings.push(String(w));
	const payload = { data: Buffer.alloc(40 * 40), width: 40, height: 40, channels: 1 };
	await run({ payload });
	await run({ payload });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(errors.length, 0);
	assert.strictEqual(sent.length, 2);
	assert.strictEqual(sent[0].payload, payload, "the original frame goes through untouched");
	assert.strictEqual(sent[0].rectify.applied, false);
	assert.strictEqual(sent[0].rectify.reason, "aspect-mismatch");
	assert.match(sent[0].rectify.error, /aspect ratio/);
	assert.strictEqual(sent[0].rectify.homography, null);
	assert.strictEqual(warnings.length, 1, "one warning per distinct reason, not per frame");
	// a good frame afterwards re-arms the warning and reports ok
	await run({ payload: dotFrame() });
	assert.strictEqual(sent[2].rectify.reason, "ok");
	await run({ payload });
	assert.strictEqual(warnings.length, 2);
});

test("an undecodable payload passes through with reason input", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	const payload = Buffer.from("not an image");
	await run({ payload });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent[0].payload, payload);
	assert.strictEqual(sent[0].rectify.applied, false);
	assert.strictEqual(sent[0].rectify.reason, "input");
	const missing = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	await missing.run({ payload: path.join(dir, "absent.jpg") });
	assert.strictEqual(missing.sent[0].rectify.reason, "input");
	assert.match(missing.sent[0].rectify.error, /does not exist/);
});

test("a scale file without a homography is a setup error, not a pass-through", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, {}) });
	await run({ payload: dotFrame() });
	assert.strictEqual(sent.length, 0);
	assert.strictEqual(doneErrors.length, 1);
	assert.match(doneErrors[0], /has no homography/);
});

test("a missing or corrupt scale file is reported, and so is no path at all", async () => {
	const dir = await tmpDir();
	const missing = makeNode({ scaleFilePath: path.join(dir, "absent.json") });
	await missing.run({ payload: dotFrame() });
	assert.match(missing.doneErrors[0], /no calibration at/);

	const corruptPath = path.join(dir, "corrupt.json");
	await fsp.writeFile(corruptPath, "{not json");
	const corrupt = makeNode({ scaleFilePath: corruptPath });
	await corrupt.run({ payload: dotFrame() });
	assert.match(corrupt.doneErrors[0], /not readable JSON/);

	const none = makeNode({});
	await none.run({ payload: dotFrame() });
	assert.match(none.doneErrors[0], /no scale file path configured/);
});

test("raw input shorter than its declared geometry passes through as an input failure", async () => {
	const dir = await tmpDir();
	const { run, sent, doneErrors } = makeNode({ scaleFilePath: await scaleFile(dir, { homography: SHIFT }) });
	await run({ payload: { data: Buffer.alloc(10), width: 40, height: 30, channels: 1 } });
	assert.strictEqual(doneErrors.length, 0);
	assert.strictEqual(sent[0].rectify.reason, "input");
	assert.match(sent[0].rectify.error, /shorter than 40x30x1/);
});
