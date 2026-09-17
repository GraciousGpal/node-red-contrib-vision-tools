/**
 * Regression tests for the checkerboard-calibrate Node-RED glue
 * (checkerboard-calibrate.js), driven through a fake RED the same way
 * glue.test.js drives golden-compare.
 *
 * The bugs this suite exists for:
 *
 *  - the object form of resolveImage rejected ArrayBuffer data while the
 *    top-level form accepted it;
 *  - path payloads were read after only an access() check: a non-regular
 *    file (e.g. /dev/zero) was read forever, and the check/read pair was
 *    a TOCTOU race;
 *  - there was no size cap on buffer inputs;
 *  - failures were reported twice (node.error + done(err)).
 */



const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");

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
	require("../checkerboard-calibrate.js")(RED);
	const node = new RED.nodes.ctor(config);
	const sent = [];
	const errors = [];
	const doneErrors = [];
	node.send = (m) => sent.push(m);
	node.error = (m) => errors.push(String(m));
	// failures routed through the done callback are the real Node-RED
	// path (done(err) goes to node.error); kept separate so tests can
	// assert a failure is reported exactly once
	const run = (msg) =>
		node.listeners.input(msg, undefined, (err) => {
			if (err) {
				doneErrors.push(err && err.message ? String(err.message) : String(err));
			}
		});
	return { node, run, sent, errors, doneErrors };
}

/** Synthetic checkerboard: `cols` x `rows` physical squares, top-left
 * light, each square `size` px. */
function boardSvg(cols, rows, size) {
	let cells = "";
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const dark = (r + c) % 2 === 1;
			cells += `<rect x="${c * size}" y="${r * size}" width="${size}" height="${size}" fill="${dark ? "#000" : "#fff"}"/>`;
		}
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * size}" height="${rows * size}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			cells +
			`</svg>`,
	);
}

const png = (svg) => sharp(svg).png().toBuffer();
const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), "gc-checker-"));

test("an ArrayBuffer in the object form is accepted and measured", async () => {
	const buf = await png(boardSvg(8, 6, 40));
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const dir = await tmpDir();
	const { run, sent, errors, doneErrors } = makeNode({
		scaleFilePath: path.join(dir, "scale.json"),
	});
	await run({ payload: { data: ab } });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	// bootstrap: no baseline on disk yet, so the first calibration passes
	assert.strictEqual(sent[0].payload, true);
});

test("a payload over the 512MB cap is refused before copy", async () => {
	const dir = await tmpDir();
	const { run, doneErrors } = makeNode({
		scaleFilePath: path.join(dir, "scale.json"),
	});
	const big = new Uint8Array(512 * 1024 * 1024 + 1);
	await run({ payload: big });
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(
		doneErrors[0],
		/msg\.payload is 536870913 bytes, above the 536870912-byte cap/,
	);
});

test("a non-regular file payload is refused instead of read", async () => {
	const dir = await tmpDir();
	const { run, doneErrors, errors } = makeNode({
		scaleFilePath: path.join(dir, "scale.json"),
	});
	await run({ payload: dir }); // a directory opens, but is not a regular file
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(doneErrors[0], /not a regular file/);
	assert.strictEqual(errors.length, 0, "done(err) must be the only report");
});

test("a missing path payload keeps the does-not-exist error", async () => {
	const dir = await tmpDir();
	const { run, doneErrors } = makeNode({
		scaleFilePath: path.join(dir, "scale.json"),
	});
	await run({ payload: path.join(dir, "absent.png") });
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(doneErrors[0], /does not exist on disk/);
});

test("a failure is reported through done once, not through node.error as well", async () => {
	const { run, errors, doneErrors } = makeNode({}); // no scale file path
	await run({ payload: new Uint8Array(4) });
	assert.strictEqual(doneErrors.length, 1);
	assert.strictEqual(errors.length, 0, "done(err) must be the only report");
});

test("saving writes the homography and perspective stats next to the scale", async () => {
	const dir = await tmpDir();
	const scaleFilePath = path.join(dir, "scale.json");
	const { run, sent, doneErrors } = makeNode({ scaleFilePath });
	await run({ payload: await png(boardSvg(8, 6, 40)), save: true });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);

	const p = sent[0].result.perspective;
	assert.ok(Array.isArray(p.homography) && p.homography.length === 9);
	assert.strictEqual(p.homography[8], 1);
	assert.strictEqual(typeof p.rmsBeforePx, "number");
	assert.strictEqual(typeof p.rmsAfterPx, "number");
	assert.strictEqual(typeof p.maxCornerShiftPx, "number");
	assert.strictEqual(p.points, 24);

	const saved = JSON.parse(await fsp.readFile(scaleFilePath, "utf8"));
	assert.deepStrictEqual(saved.homography, p.homography);
	assert.strictEqual(saved.perspective.rmsBeforePx, p.rmsBeforePx);
	assert.strictEqual(saved.perspective.homography, undefined, "stored once, at the top level");
	assert.strictEqual(saved.nativeWidth, 320);
	assert.strictEqual(saved.nativeHeight, 240);
	// and it reads back through the validator
	const { readScaleFile } = require("../lib/scaleFile.js");
	const back = await readScaleFile(scaleFilePath);
	assert.strictEqual(back.error, undefined);
	assert.deepStrictEqual(back.homography, p.homography);
});
