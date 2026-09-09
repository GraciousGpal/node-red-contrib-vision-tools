/**
 * A trained transform is only meaningful against the golden it was
 * measured on and at the working size it was measured at. Applying a
 * mismatched one would misalign every frame, which reads as a
 * whole-part print fault - the most expensive way to be wrong here - so
 * these guards matter more than they look.
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

const tmp = async () =>
	path.join(
		await fsp.mkdtemp(path.join(os.tmpdir(), "gc-xform-")),
		"transform.json",
	);

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

test("a transform trained on a different golden is refused", async () => {
	const p = await tmp();
	await writeTransformFile(p, RECORD);
	const got = await readTransformFile(p, {
		goldenKey: "path:/data/golden/other.png",
		workingSize: 3072,
	});
	assert.ok(got.error, "must report a reason rather than returning scales");
	assert.match(got.error, /different golden/);
	assert.strictEqual(got.scaleX, undefined);
});

// The cheap goldenKey records how the golden was *delivered* - buf:<sha1>
// for one sent on the message, path:<file>:<mtime>:<size> for one read off
// disk. Training through msg.golden and then producing frames from the
// configured goldenPath is the documented flow, and it used to refuse the
// record on every frame and fall back to the full search, even though the
// bytes were identical.
test("the same golden delivered a different way is recognised, not refused", async () => {
	const p = await tmp();
	await writeTransformFile(p, {
		...RECORD,
		goldenKey: "buf:0d93201f",
		goldenContentKey: "sha1:0d93201f",
	});
	const got = await readTransformFile(p, {
		goldenKey: "path:/data/golden/artwork.png:1788011451282:11070",
		goldenContentKey: async () => "sha1:0d93201f",
		workingSize: 3072,
	});
	assert.strictEqual(got.error, undefined, got.error);
	assert.strictEqual(got.scaleX, RECORD.scaleX);
});

test("a genuinely different golden is still refused once content is compared", async () => {
	const p = await tmp();
	await writeTransformFile(p, {
		...RECORD,
		goldenKey: "path:/data/golden/artwork.png:1:11070",
		goldenContentKey: "sha1:0d93201f",
	});
	const got = await readTransformFile(p, {
		goldenKey: "path:/data/golden/artwork.png:2:11090",
		goldenContentKey: async () => "sha1:beefcafe",
		workingSize: 3072,
	});
	assert.match(got.error, /different golden content/);
	assert.match(got.error, /retrain/);
	assert.strictEqual(got.scaleX, undefined);
});

// Nothing to reconcile against: a record written before goldenContentKey
// existed, or a resolver that could not read the golden. Refusing is the
// safe answer, and the reason says why retraining once fixes it.
test("a mismatch that cannot be resolved by content is refused", async () => {
	const p = await tmp();
	await writeTransformFile(p, RECORD); // no goldenContentKey
	const old = await readTransformFile(p, {
		goldenKey: "buf:0d93201f",
		goldenContentKey: async () => "sha1:0d93201f",
		workingSize: 3072,
	});
	assert.match(old.error, /different golden/);
	assert.match(old.error, /predates content-keyed training/);

	const q = await tmp();
	await writeTransformFile(q, { ...RECORD, goldenContentKey: "sha1:0d93201f" });
	const unreadable = await readTransformFile(q, {
		goldenKey: "buf:0d93201f",
		goldenContentKey: async () => {
			throw new Error("golden vanished");
		},
		workingSize: 3072,
	});
	assert.match(unreadable.error, /different golden/);
	assert.strictEqual(unreadable.scaleX, undefined);
});

test("a transform trained at another working size is refused", async () => {
	const p = await tmp();
	await writeTransformFile(p, RECORD);
	const got = await readTransformFile(p, {
		goldenKey: RECORD.goldenKey,
		workingSize: 1024,
	});
	assert.ok(got.error);
	assert.match(got.error, /workingSize/);
});

test("a corrupt or incomplete record is refused, not half-applied", async () => {
	const p = await tmp();
	await fsp.writeFile(p, "{ not json");
	assert.match((await readTransformFile(p, {})).error, /readable JSON/);

	const q = await tmp();
	await writeTransformFile(q, { scaleX: 1.9, goldenKey: "k" });
	assert.match((await readTransformFile(q, {})).error, /scaleX\/scaleY/);

	const r = await tmp();
	await writeTransformFile(r, { scaleX: 0, scaleY: -1 });
	assert.match((await readTransformFile(r, {})).error, /scaleX\/scaleY/);
});

// A huge-but-finite scale (1e308 is a finite positive double) used to be
// accepted, then flowed into the pinned search as centerX = -Infinity and
// halfRange = Infinity - a synchronous infinite loop that froze the whole
// process. The record must be refused up front instead.
test("an absurd but finite scale is refused, not applied", async () => {
	const p = await tmp();
	await writeTransformFile(p, { scaleX: 1e308, scaleY: 1e308, goldenKey: "k" });
	const got = await readTransformFile(p, {});
	assert.ok(got.error, "must report a reason rather than returning scales");
	assert.match(got.error, /0\.05\.\.100/);
	assert.strictEqual(got.scaleX, undefined);
});

test("a scale outside the physical range is refused", async () => {
	const low = await tmp();
	await writeTransformFile(low, { scaleX: 0.01, scaleY: 2.0 });
	assert.match((await readTransformFile(low, {})).error, /0\.05\.\.100/);

	const high = await tmp();
	await writeTransformFile(high, { scaleX: 2.0, scaleY: 500 });
	assert.match((await readTransformFile(high, {})).error, /0\.05\.\.100/);

	// a normal trained transform still round-trips
	const ok = await tmp();
	await writeTransformFile(ok, RECORD);
	const got = await readTransformFile(ok, {});
	assert.strictEqual(got.error, undefined);
	assert.strictEqual(got.scaleX, RECORD.scaleX);
});
