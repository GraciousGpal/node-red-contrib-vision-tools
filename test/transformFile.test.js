/**
 * A trained transform is only meaningful against the golden it was
 * measured on and at the working size it was measured at. Applying a
 * mismatched one would misalign every frame, which reads as a
 * whole-part print fault - the most expensive way to be wrong here - so
 * these guards matter more than they look.
 *
 * readTransformFile is a JSON read in front of validateTransformRecord. The
 * accept/refuse rules are one table in test/transformValidate.test.js, run
 * through both functions; this file keeps what only the file read does.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const {
	readTransformFile,
	writeTransformFile,
} = require("../lib/transformFile.js");

const made = [];
test.after(() =>
	Promise.all(made.map((d) => fsp.rm(d, { recursive: true, force: true }))),
);

const tmp = async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gc-xform-"));
	made.push(dir);
	return path.join(dir, "transform.json");
};

const RECORD = {
	scaleX: 1.93774,
	scaleY: 2.03384,
	stretchPercent: 4.96,
	alignScore: 0.0493,
	goldenKey: "path:/data/golden/artwork.png",
	workingSize: 3072,
};

test("a trained transform round-trips", async () => {
	const p = await tmp();
	await writeTransformFile(p, RECORD);
	const got = await readTransformFile(p, {
		goldenKey: RECORD.goldenKey,
		workingSize: 3072,
	});
	assert.strictEqual(got.scaleX, RECORD.scaleX);
	assert.strictEqual(got.scaleY, RECORD.scaleY);
	assert.strictEqual(got.record.alignScore, RECORD.alignScore);
});

test("a missing file is simply absent, not an error", async () => {
	assert.strictEqual(
		await readTransformFile(path.join(os.tmpdir(), "nope-xform.json"), {}),
		null,
	);
	assert.strictEqual(await readTransformFile("", {}), null);
});

test("a corrupt file is refused, not half-applied", async () => {
	const p = await tmp();
	await fsp.writeFile(p, "{ not json");
	assert.match((await readTransformFile(p, {})).error, /readable JSON/);
});
