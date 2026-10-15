/**
 * Regression tests for the checkerboard-calibrate Node-RED glue
 * (checkerboard-calibrate.js), driven through a fake RED the same way
 * glue.test.js drives golden-compare.
 *
 * The bugs this suite exists for:
 *
 *  - input guards this node once lacked (ArrayBuffer in the object form,
 *    non-regular files, the 512MB cap) now live in lib/nodeInput.js and
 *    are unit-tested in test/nodeInput.test.js; the missing-file test
 *    below proves this node reads its payload through them;
 *  - failures were reported twice (node.error + done(err)).
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");
const { boardSvg } = require("./helpers/synthetic.js");

function makeNode(config = {}) {
	const node = loadNode("checkerboard-calibrate.js", config);
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

const png = (svg) => sharp(svg).png().toBuffer();
const made = [];
test.after(() =>
	Promise.all(made.map((d) => fsp.rm(d, { recursive: true, force: true }))),
);
const tmpDir = async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gc-checker-"));
	made.push(dir);
	return dir;
};

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
