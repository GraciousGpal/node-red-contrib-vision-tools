/**
 * barcode-locate with regionSource "profile": regions read out of a
 * golden's profile file and mapped into the payload, end to end through
 * the node with a fake RED.
 *
 * The profile is written by hand: a transform whose numbers make one
 * golden native px exactly one payload px (gs 500/1000 = 0.5, scale 0.75,
 * frame working -> native 600/450, native -> payload 1200/600: 0.5 x 0.75
 * x 4/3 x 2 = 1), a placement off nominal so the recorded one is what
 * moves the region, and a barcodes section naming a Code128 written by
 * zxing-wasm's own writer. The payload is a white 1200x1600 canvas (the
 * "native camera frame", twice the 600x800 the compare saw) with that
 * Code128 composited where the mapping puts it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");
const { mapProfileRegions } = require("../lib/goldenRegions.js");

// The writer is a test-only dependency of the same package, made offline
// the way lib/locate.js makes the reader offline (see test/locate.test.js).
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
const skip = writer ? false : `zxing-wasm/writer did not load: ${writerError && writerError.message}`;

const TEXT = "VT-PROFILE-128";
const KEY = "sha1:" + "a".repeat(40);
const OTHER_KEY = "sha1:" + "b".repeat(40);
const PAYLOAD = { width: 1200, height: 1600 };
// golden native px of the code's top-left; its size is the written PNG's
const AT = { x: 300, y: 400 };

const TRANSFORM = {
	scaleX: 0.75,
	scaleY: 0.75,
	angleDeg: 0,
	goldenWidth: 500,
	goldenHeight: 650,
	goldenContentKey: KEY,
	frameWidth: 450,
	frameHeight: 600,
	frameNativeWidth: 600,
	frameNativeHeight: 800,
	// nominal would be (37.5, 56.25); this is what training recorded
	placement: { ox: 20, oy: 30, angleDeg: 0 },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vt-bc-profile-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let fixturePromise = null;
function fixture() {
	if (!fixturePromise) {
		fixturePromise = (async () => {
			const r = await writer.writeBarcode(TEXT, { format: "Code128", scale: 3, addQuietZones: false });
			if (r.error) throw new Error(`writeBarcode: ${r.error}`);
			const code = Buffer.from(await r.image.arrayBuffer());
			const meta = await sharp(code).metadata();
			const box = { label: `Code128 ${TEXT}`, format: "Code128", text: TEXT, x: AT.x, y: AT.y, width: meta.width, height: meta.height };
			const barcodes = { source: "golden", derivedAt: new Date(0).toISOString(), goldenContentKey: KEY, nativeWidth: 1000, nativeHeight: 1300, regions: [box] };
			// where the code lands in the payload, unpadded: by construction
			// (353.33, 480) -> (353, 480), the PNG's own size
			const [mapped] = mapProfileRegions({ transform: TRANSFORM, barcodes, goldenNative: { width: 1000, height: 1300 } }, PAYLOAD, null, {}).regions;
			assert.deepStrictEqual([mapped.x, mapped.y, mapped.width, mapped.height], [353, 480, meta.width, meta.height], "precondition: the hand-built transform maps 1:1");
			const canvas = (size) => sharp({ create: { ...size, channels: 3, background: { r: 255, g: 255, b: 255 } } });
			const frame = await canvas(PAYLOAD).composite([{ input: code, left: mapped.x, top: mapped.y }]).png().toBuffer();
			return { code, box, barcodes, mapped, frame, canvas };
		})();
	}
	return fixturePromise;
}

function writeProfile(name, { transform = TRANSFORM, barcodes, golden = { contentKey: KEY, nativeWidth: 1000, nativeHeight: 1300 } } = {}, dir = tmp) {
	const file = path.join(dir, `${name}.json`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ version: 1, golden, transform, barcodes, updatedAt: new Date(0).toISOString() }));
	return file;
}

function makeNode(config) {
	const node = loadNode("barcode-locate.js", { regionSource: "profile", ...config });
	const sent = [];
	const warns = [];
	const doneErrors = [];
	node.send = (m) => sent.push(m);
	node.warn = (m) => warns.push(String(m));
	const run = async (msg) => {
		const before = sent.length;
		await node.listeners.input(msg, undefined, (err) => {
			if (err) doneErrors.push(String(err && err.message ? err.message : err));
		});
		assert.deepStrictEqual(doneErrors, [], doneErrors.join("\n"));
		return sent.slice(before);
	};
	return { node, run, sent, warns };
}

function contains(outer, inner) {
	return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function assertProfileRead(out, mapped) {
	assert.strictEqual(out.length, 1, JSON.stringify(out.map((m) => [m.text, m.source])));
	const [m] = out;
	assert.strictEqual(m.text, TEXT);
	assert.strictEqual(m.regionSource, "profile");
	assert.strictEqual(m.source, "region", "read in the profile's region, not by the fallback");
	assert.ok(contains(m.roi, m.symbol), `roi ${JSON.stringify(m.roi)} holds symbol ${JSON.stringify(m.symbol)}`);
	for (const k of ["x", "y", "width", "height"]) {
		assert.ok(Math.abs(m.symbol[k] - mapped[k]) <= 3, `symbol.${k} ${m.symbol[k]} vs placed ${mapped[k]}`);
	}
	assert.strictEqual(m.expectedText, TEXT);
	assert.strictEqual(m.textMatches, true);
}

test("profilePath: the profile's region decodes and the text matches the artwork", { skip }, async () => {
	const { barcodes, mapped, frame } = await fixture();
	const file = writeProfile("fixed", { barcodes });
	const { run, warns } = makeNode({ profilePath: file });
	assertProfileRead(await run({ payload: frame }), mapped);
	// the region is the mapped box padded by regionPadMinPx's default 64
	// golden working px = 64 x 0.75 x 4/3 x 2 = 128 payload px each side
	const [again] = await run({ payload: frame });
	assert.deepStrictEqual(again.roi, { x: 353 - 128, y: 480 - 128, width: mapped.width + 256, height: mapped.height + 256 });
	assert.deepStrictEqual(warns, []);
});

test("msg.result.profile.path wins over the configured profilePath", { skip }, async () => {
	const { barcodes, mapped, frame } = await fixture();
	const file = writeProfile("upstream", { barcodes });
	const { run, warns } = makeNode({ profilePath: path.join(tmp, "nope.json") });
	assertProfileRead(await run({ payload: frame, result: { profile: { path: file, contentKey: KEY } } }), mapped);
	assert.deepStrictEqual(warns, []);
});

test("msg.profile is a name looked up in profileDir", { skip }, async () => {
	const { barcodes, mapped, frame } = await fixture();
	const dir = path.join(tmp, "dir");
	writeProfile("line_a", { barcodes }, dir);
	const { run, warns } = makeNode({ profileDir: dir });
	assertProfileRead(await run({ payload: frame, profile: "Line A" }), mapped);
	assert.deepStrictEqual(warns, []);
});

test("msg.regions overrides the profile", { skip }, async () => {
	const { barcodes, mapped, frame } = await fixture();
	const file = writeProfile("override", { barcodes });
	const { run } = makeNode({ profilePath: file });
	const region = { label: "mine", x: mapped.x - 40, y: mapped.y - 40, width: mapped.width + 80, height: mapped.height + 80 };
	const [m] = await run({ payload: frame, regions: [region] });
	assert.strictEqual(m.text, TEXT);
	assert.strictEqual(m.regionSource, "msg");
	assert.strictEqual(m.regionLabel, "mine");
	assert.strictEqual(m.expectedText, null);
	assert.strictEqual(m.textMatches, null);
});

test("a missing profile warns once and the full-image fallback still decodes", { skip }, async () => {
	const { frame } = await fixture();
	const { run, warns } = makeNode({ profilePath: path.join(tmp, "missing.json") });
	for (let i = 0; i < 2; i++) {
		const [m] = await run({ payload: frame });
		assert.strictEqual(m.text, TEXT);
		assert.strictEqual(m.source, "fullImage");
		assert.strictEqual(m.regionSource, "profile");
		assert.strictEqual(m.textMatches, null);
	}
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /does not exist/);
});

test("barcodes and transform of different goldens: no regions, one warning", { skip }, async () => {
	const { barcodes, frame } = await fixture();
	const file = writeProfile("mixed", { barcodes: { ...barcodes, goldenContentKey: OTHER_KEY } });
	const { run, warns } = makeNode({ profilePath: file });
	for (let i = 0; i < 2; i++) {
		const [m] = await run({ payload: frame });
		assert.strictEqual(m.source, "fullImage", "no profile regions, so the fallback ran");
		assert.strictEqual(m.text, TEXT);
	}
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /barcodes of one golden and a transform of another/);
});

test("a profile for another golden than the compare's: no regions, one warning", { skip }, async () => {
	const { barcodes, frame } = await fixture();
	const file = writeProfile("stale", { barcodes });
	const { run, warns } = makeNode({});
	const [m] = await run({ payload: frame, result: { profile: { path: file, contentKey: OTHER_KEY } } });
	assert.strictEqual(m.source, "fullImage");
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /another golden/);
});

test("a payload no larger than the compare's frame warns about resolution", { skip }, async () => {
	const { barcodes, code, canvas } = await fixture();
	const file = writeProfile("small", { barcodes });
	// the 600x800 frame the compare saw; the code is placed at the
	// half-size mapped position, legible here only because it was written
	// at a generous scale
	const small = await canvas({ width: 600, height: 800 }).composite([{ input: code, left: 177, top: 240 }]).png().toBuffer();
	const { run, warns } = makeNode({ profilePath: file });
	await run({ payload: small });
	await run({ payload: small });
	const resolution = warns.filter((w) => /no larger than the frame the compare saw \(600x800\)/.test(w));
	assert.strictEqual(resolution.length, 1, warns.join("\n"));
	// a rig whose compare already gets the native frame trips the same
	// check, so the warning has to say when it is expected
	assert.match(resolution[0], /if golden-compare already inspects the native camera frame this is expected/);
});

test("a raw payload object decodes through the profile like the PNG", { skip }, async () => {
	const { barcodes, mapped, frame } = await fixture();
	const file = writeProfile("raw", { barcodes });
	const { data, info } = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const { run } = makeNode({ profilePath: file });
	assertProfileRead(await run({ payload: { data, width: info.width, height: info.height, channels: info.channels } }), mapped);
	// and the bytes-plus-rawInfo form
	assertProfileRead(await run({ payload: data, rawInfo: { width: info.width, height: info.height, channels: info.channels } }), mapped);
});

test("a read that differs from the artwork's text: textMatches false, warned once", { skip }, async () => {
	const { barcodes, frame } = await fixture();
	const wrong = { ...barcodes, regions: [{ ...barcodes.regions[0], text: "VT-SOMETHING-ELSE" }] };
	const file = writeProfile("wrongtext", { barcodes: wrong });
	const { run, warns } = makeNode({ profilePath: file });
	for (let i = 0; i < 2; i++) {
		const [m] = await run({ payload: frame });
		assert.strictEqual(m.text, TEXT);
		assert.strictEqual(m.expectedText, "VT-SOMETHING-ELSE");
		assert.strictEqual(m.textMatches, false);
	}
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /where the golden's artwork has "VT-SOMETHING-ELSE"/);
});

test("a calibration on an already rectified payload warns once (un-rectified twice)", { skip }, async () => {
	const { barcodes, mapped, frame } = await fixture();
	const file = writeProfile("calibrated", { barcodes });
	const scaleFilePath = path.join(tmp, "calibration.json");
	fs.writeFileSync(
		scaleFilePath,
		JSON.stringify({ mmPerPixelNative: 0.1, nativeWidth: 1200, nativeHeight: 1600, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }),
	);
	const { run, warns } = makeNode({ profilePath: file, scaleFilePath });
	// identity homography: the regions are where they were, so it decodes
	assertProfileRead(await run({ payload: frame }), mapped);
	assert.deepStrictEqual(warns, []);
	const rectify = { applied: true, width: PAYLOAD.width, height: PAYLOAD.height };
	await run({ payload: frame, rectify });
	await run({ payload: frame, rectify });
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /un-rectified twice/);
});

test("the none-found message carries null symbol, expectedText and textMatches", { skip }, async () => {
	const { barcodes, canvas } = await fixture();
	const file = writeProfile("blank", { barcodes });
	const blank = await canvas(PAYLOAD).png().toBuffer();
	const { run } = makeNode({ profilePath: file, mode: "regionsOnly" });
	const [m] = await run({ payload: blank });
	assert.strictEqual(m.text, null);
	assert.strictEqual(m.regionSource, "profile");
	assert.strictEqual(m.symbol, null);
	assert.strictEqual(m.expectedText, null);
	assert.strictEqual(m.textMatches, null);
});

test("overlapping padded regions: each code gets its own region's text", { skip }, async () => {
	// The demo label's case: two Code128s close together, so a padded
	// region holds the centre of both codes. Stacked here, 60 px apart;
	// with regionPadMinPx 100 (200 payload px) region 1 reaches 200 px
	// below code 1, past code 2's centre (75 + 60 = 135 px below it), and
	// region 2 reaches as far above code 2, past code 1's. Taking the first
	// region that holds the centre paired code 2 with code 1's text.
	const { code, barcodes, canvas } = await fixture();
	const SECOND = "VT-SECOND-128";
	const r = await writer.writeBarcode(SECOND, { format: "Code128", scale: 3, addQuietZones: false });
	const code2 = Buffer.from(await r.image.arrayBuffer());
	const meta2 = await sharp(code2).metadata();
	const first = barcodes.regions[0];
	const gap = 60;
	const second = { label: `Code128 ${SECOND}`, format: "Code128", text: SECOND, x: AT.x, y: AT.y + first.height + gap, width: meta2.width, height: meta2.height };
	const both = { ...barcodes, regions: [first, second] };
	const config = { regionPadMinPx: 100 };

	// 1:1 mapping, so code 2 sits at (353, 480 + height + gap)
	const frame = await canvas(PAYLOAD)
		.composite([
			{ input: code, left: 353, top: 480 },
			{ input: code2, left: 353, top: 480 + first.height + gap },
		])
		.png()
		.toBuffer();
	const file = writeProfile("adjacent", { barcodes: both });
	const { run, warns } = makeNode({ profilePath: file, ...config });
	const out = await run({ payload: frame });
	assert.deepStrictEqual(out.map((m) => m.text).sort(), [SECOND, TEXT].sort(), JSON.stringify(out.map((m) => [m.text, m.source])));

	// precondition, the reason for the test: each code's centre lies in both regions
	const regions = mapProfileRegions(
		{ transform: TRANSFORM, barcodes: both, goldenNative: { width: 1000, height: 1300 } },
		PAYLOAD,
		null,
		{ pad: 0.2, padMinPx: 100 },
	).regions;
	for (const m of out) {
		const cx = m.symbol.x + m.symbol.width / 2;
		const cy = m.symbol.y + m.symbol.height / 2;
		const holding = regions.filter((g) => cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height);
		assert.strictEqual(holding.length, 2, `precondition: ${m.text}'s centre is in both regions`);
	}

	for (const m of out) {
		assert.strictEqual(m.source, "region");
		assert.strictEqual(m.expectedText, m.text);
		assert.strictEqual(m.textMatches, true);
	}
	assert.deepStrictEqual(warns, []);
});

test("the identity checked against golden-compare is the barcodes section's, not golden.contentKey", { skip }, async () => {
	// writeProfileSection merges the golden record on every write: a
	// nuisance training for revised artwork B leaves transform A and
	// barcodes A in the file under golden.contentKey B
	const { barcodes, mapped, frame } = await fixture();
	const file = writeProfile("merged", { barcodes, golden: { contentKey: OTHER_KEY, nativeWidth: 1000, nativeHeight: 1300 } });
	const { run, warns } = makeNode({});
	// the compare inspected against A, which is what the barcodes are: used
	assertProfileRead(await run({ payload: frame, result: { profile: { path: file, contentKey: KEY } } }), mapped);
	assert.deepStrictEqual(warns, []);
	// against B, whose name the golden record now carries: A's boxes must not be used
	const [m] = await run({ payload: frame, result: { profile: { path: file, contentKey: OTHER_KEY } } });
	assert.strictEqual(m.source, "fullImage");
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /another golden/);
});

test("a profile path that cannot even be stat'ed warns once and does not fail the message", { skip }, async () => {
	const { frame } = await fixture();
	const { run, warns } = makeNode({});
	const bad = path.join(tmp, "bad\0name.json"); // fs refuses it: ERR_INVALID_ARG_VALUE
	for (let i = 0; i < 2; i++) {
		// run() asserts done() got no error
		const [m] = await run({ payload: frame, result: { profile: { path: bad } } });
		assert.strictEqual(m.text, TEXT, "the full-image fallback still decodes");
		assert.strictEqual(m.source, "fullImage");
	}
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	assert.match(warns[0], /cannot be used/);
});

test("a profile fixed and then broken again is warned again", { skip }, async () => {
	const { barcodes, frame } = await fixture();
	const broken = { ...barcodes, goldenContentKey: OTHER_KEY };
	const file = writeProfile("flaky", { barcodes: broken });
	const { run, warns } = makeNode({ profilePath: file });
	await run({ payload: frame });
	await run({ payload: frame });
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	writeProfile("flaky", { barcodes });
	await run({ payload: frame });
	assert.strictEqual(warns.length, 1, "a good profile adds nothing");
	// broken again, a different size so (mtimeMs, size) changes whatever
	// the filesystem's timestamp resolution
	writeProfile("flaky", { barcodes: { ...broken, note: "rewritten" } });
	await run({ payload: frame });
	await run({ payload: frame });
	assert.strictEqual(warns.length, 2, warns.join("\n"));
	assert.match(warns[1], /barcodes of one golden and a transform of another/);
});

test("a text mismatch is warned once per (expected, read) pair", { skip }, async () => {
	const { barcodes, frame } = await fixture();
	const withText = (text) => ({ ...barcodes, regions: [{ ...barcodes.regions[0], text }] });
	const file = writeProfile("pairs", { barcodes: withText("VT-EXPECTED-ONE") });
	const { run, warns } = makeNode({ profilePath: file });
	await run({ payload: frame });
	await run({ payload: frame });
	assert.strictEqual(warns.length, 1, warns.join("\n"));
	writeProfile("pairs", { barcodes: withText("VT-EXPECTED-TWO-LONGER") });
	await run({ payload: frame });
	assert.strictEqual(warns.length, 2, warns.join("\n"));
	assert.match(warns[1], /"VT-EXPECTED-TWO-LONGER"/);
});
