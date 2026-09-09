/**
 * Regression tests for lib/scaleFile.js.
 *
 * The bugs this suite exists for: readScaleFile accepted 0, negative,
 * Infinity (JSON happily parses "1e999") and absurdly large
 * mmPerPixelNative values, which flowed downstream into NaN and a
 * sharp.resize that errored every frame (or a silent pass when the sizes
 * happened to match); and a corrupt/unreadable file came back as null,
 * so the node silently ran uncalibrated with no warning at all.
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { readScaleFile } = require("../lib/scaleFile.js");

const tmp = async () =>
	path.join(
		await fsp.mkdtemp(path.join(os.tmpdir(), "gc-scale-")),
		"scale.json",
	);

test("a valid calibration file round-trips", async () => {
	const p = await tmp();
	await fsp.writeFile(
		p,
		JSON.stringify({
			mmPerPixelNative: 0.05,
			nativeWidth: 2000,
			nativeHeight: 1000,
		}),
	);
	const got = await readScaleFile(p);
	assert.strictEqual(got.mmPerPixelNative, 0.05);
	assert.strictEqual(got.nativeWidth, 2000);
	assert.strictEqual(got.nativeHeight, 1000);
});

test("a missing scale file is simply absent, not an error", async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gc-scale-"));
	assert.strictEqual(await readScaleFile(path.join(dir, "nope.json")), null);
	assert.strictEqual(await readScaleFile(""), null);
});

test("0, negative, Infinity, or past-the-bound mmPerPixelNative is refused with an error", async () => {
	// 1e999 is written as raw JSON because JSON.stringify(Infinity) emits
	// null - the point is that JSON.parse accepts it as Infinity
	for (const raw of [
		JSON.stringify({ mmPerPixelNative: 0 }),
		JSON.stringify({ mmPerPixelNative: -1 }),
		'{"mmPerPixelNative":1e999}',
		JSON.stringify({ mmPerPixelNative: 1001 }),
	]) {
		const p = await tmp();
		await fsp.writeFile(p, raw);
		const got = await readScaleFile(p);
		assert.match(got.error, /mmPerPixelNative/);
	}
});

test("a corrupt scale file returns an error rather than silent null", async () => {
	const p = await tmp();
	await fsp.writeFile(p, "{not json");
	const got = await readScaleFile(p);
	assert.match(got.error, /not readable JSON/);
});

test("nativeWidth/nativeHeight must be positive integers when present", async () => {
	for (const rec of [
		{ mmPerPixelNative: 0.05, nativeWidth: 2000 },
		{ mmPerPixelNative: 0.05, nativeWidth: "2000", nativeHeight: 1000 },
		{ mmPerPixelNative: 0.05, nativeWidth: -5, nativeHeight: 1000 },
	]) {
		const p = await tmp();
		await fsp.writeFile(p, JSON.stringify(rec));
		const got = await readScaleFile(p);
		assert.match(got.error, /nativeWidth\/nativeHeight/);
	}
});
