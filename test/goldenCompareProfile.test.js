/**
 * golden-compare with a profile directory: one file per golden holding its
 * trained transform, nuisance map and barcode regions (lib/profileStore.js).
 *
 * What this suite exists for:
 *
 *  - The trained transform records the frame it was measured on and where
 *    the golden sat in it. The training frame here is the golden scaled
 *    and pasted off-centre onto a larger canvas: trained on the golden
 *    itself, the placement is (0, 0), which is also the nominal one, and
 *    a placement that was never written would pass unnoticed.
 *  - The profile is chosen by the golden's name and checked by its
 *    content; the next frame pins from it and says so on the message.
 *  - A legacy transform file trained on this golden is imported into the
 *    profile; one trained on another golden is passed over without a
 *    warning, because the editor's default paths make that the common
 *    case rather than a fault.
 *  - Barcode regions are read off the golden once per golden version,
 *    after the frame is sent, and not again while the section matches.
 *  - Nuisance training interleaving two goldens keeps two accumulators.
 *
 * Runs the inspector inline (GOLDEN_COMPARE_INLINE=1), set below before
 * anything loads it, so the barcode derivation's locate.js is the same
 * module object this file patches to count calls.
 */

"use strict";

process.env.GOLDEN_COMPARE_INLINE = "1";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");
const locate = require("../lib/locate.js");
const profileStore = require("../lib/profileStore.js");
const { loadNode } = require("./helpers/fakeRed.js");

// ---- harness (after test/glue.test.js) ---------------------------------

function makeNode(config = {}) {
	const node = loadNode("golden-compare.js", config);
	const sent = [];
	const warns = [];
	const logs = [];
	const doneErrors = [];
	node.send = (m) => sent.push(m);
	node.warn = (m) => warns.push(String(m));
	node.log = (m) => logs.push(String(m));
	const run = (msg) =>
		node.listeners.input(msg, undefined, (err) => {
			if (err) doneErrors.push(err && err.message ? String(err.message) : String(err));
		});
	// the barcode derivation is started after send and not awaited by the
	// handler; a test that reads its result waits for it here
	const settle = () => Promise.all([...node.derivations.values()]);
	return { node, run, settle, sent, warns, logs, doneErrors };
}

const BAR_Y = [0.1, 0.155, 0.19, 0.26, 0.3, 0.375, 0.41, 0.47, 0.545, 0.6, 0.68, 0.74];

function labelSvg(width, height, { seed = 0 } = {}) {
	const bars = [];
	for (let i = 0; i < BAR_Y.length; i++) {
		const y = Math.round(height * BAR_Y[i]);
		const w = Math.round(width * (i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.44 : 0.31));
		const x = Math.round(width * 0.14) + ((seed * (i + 1) * 7) % 40);
		bars.push(`<rect x="${x}" y="${y}" width="${w}" height="${Math.round(height * 0.022)}" fill="#111"/>`);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.05)}" width="${Math.round(width * 0.8)}" height="${Math.round(height * 0.9)}" fill="none" stroke="#111" stroke-width="${Math.max(2, Math.round(width * 0.01))}"/>` +
			bars.join("") +
			`</svg>`,
	);
}

const png = (svg) => sharp(svg).png().toBuffer();
const made = [];
const tmpDir = async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gc-profile-"));
	made.push(dir);
	return dir;
};
test.after(() => Promise.all(made.map((d) => fsp.rm(d, { recursive: true, force: true }))));
const readJson = async (p) => JSON.parse(await fsp.readFile(p, "utf8"));
const exists = (p) => fsp.access(p).then(() => true, () => false);

const W = 900;
const H = 1300;
const NODE_CFG = { workers: 1 };

/**
 * The golden scaled by `scale` and pasted at (left, top) on a white canvas:
 * a frame whose label is neither at the golden's scale nor centred, so the
 * trained placement differs from the nominal one by tens of px.
 */
async function offsetFrame(goldenBuf, { scale = 1.1, left = 40, top = 150, width = 1200, height = 1600 } = {}) {
	const label = await sharp(goldenBuf).resize(Math.round(W * scale)).png().toBuffer();
	return sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
		.composite([{ input: label, left, top }])
		.png()
		.toBuffer();
}

// ---- barcode writer, offline (as in test/locate.test.js) ---------------

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

const BARCODE = { text: "VT-GC-128", left: 200, top: 1040 };

/** The synthetic label with a Code128 written by zxing in its empty lower
 * band: >100 px of white on every side, past Code128's 10-module quiet
 * zone at scale 2. Cropped to 120 rows - a linear code is the same code
 * at any height. */
async function goldenWithBarcode() {
	const r = await writer.writeBarcode(BARCODE.text, { format: "Code128", scale: 2, addQuietZones: false });
	if (r.error) throw new Error(`writeBarcode: ${r.error}`);
	let code = Buffer.from(await r.image.arrayBuffer());
	const meta = await sharp(code).metadata();
	const height = Math.min(meta.height, 120);
	code = await sharp(code).extract({ left: 0, top: 0, width: meta.width, height }).png().toBuffer();
	const buf = await sharp(await png(labelSvg(W, H)))
		.composite([{ input: code, left: BARCODE.left, top: BARCODE.top }])
		.png()
		.toBuffer();
	return { buf, box: { x: BARCODE.left, y: BARCODE.top, width: meta.width, height } };
}

// Count derivations through the module object golden-compare calls.
const realLocate = locate.locateBarcodes;
let locateCalls = 0;
locate.locateBarcodes = (...args) => {
	locateCalls++;
	return realLocate(...args);
};

// ---- the trained transform, in the profile -----------------------------

test("training writes the transform into the golden's profile with frame size and a real placement, and the next frame pins from it", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const goldenPath = path.join(dir, "Demo_Good_60.png");
	const legacyPath = path.join(dir, "transform.json");
	const goldenBuf = await png(labelSvg(W, H));
	await fsp.writeFile(goldenPath, goldenBuf);
	const frame = await offsetFrame(goldenBuf);
	const cfg = { ...NODE_CFG, goldenPath, profileDir, transformFilePath: legacyPath };

	const train = makeNode({ ...cfg, trainTransform: true });
	await train.run({ payload: frame });
	assert.deepStrictEqual(train.doneErrors, []);
	const file = path.join(profileDir, "demo_good_60.json");
	const profile = await readJson(file);
	const t = profile.transform;
	assert.ok(t, "no transform section");
	assert.strictEqual(profile.version, 1);
	assert.strictEqual(profile.golden.namedBy, "source");
	assert.strictEqual(profile.golden.source, goldenPath);
	assert.match(profile.golden.contentKey, /^sha1:[0-9a-f]{40}$/);
	assert.strictEqual(profile.golden.nativeWidth, W);
	assert.strictEqual(profile.golden.nativeHeight, H);
	assert.strictEqual(t.goldenContentKey, profile.golden.contentKey);
	// training with a profile directory leaves the legacy file alone
	assert.strictEqual(await exists(legacyPath), false, "the legacy transform file was written");

	// the frame as received and at working size
	assert.strictEqual(t.frameNativeWidth, 1200);
	assert.strictEqual(t.frameNativeHeight, 1600);
	const sent = train.sent[0];
	assert.strictEqual(sent.trainedTransform.frameWidth, t.frameWidth);
	assert.ok(Number.isInteger(t.frameWidth) && t.frameWidth > 0, `frameWidth ${t.frameWidth}`);
	assert.ok(Number.isInteger(t.frameHeight) && t.frameHeight > 0, `frameHeight ${t.frameHeight}`);
	assert.ok(Math.abs(t.frameWidth / t.frameHeight - 1200 / 1600) < 0.01, "working frame keeps the aspect");
	// the placement is the solved one, not the nominal centre
	assert.deepStrictEqual(t.placement, {
		ox: sent.result.transform.ox,
		oy: sent.result.transform.oy,
		angleDeg: sent.result.transform.angleDeg,
	});
	const nominalOx = (t.frameWidth - t.scaleX * t.goldenWidth) / 2;
	const nominalOy = (t.frameHeight - t.scaleY * t.goldenHeight) / 2;
	assert.ok(
		Math.abs(t.placement.ox - nominalOx) > 10 && Math.abs(t.placement.oy - nominalOy) > 10,
		`placement ${JSON.stringify(t.placement)} vs nominal (${nominalOx.toFixed(1)}, ${nominalOy.toFixed(1)})`,
	);
	// the label sits 65 px left of and 65 px below centre on the native frame
	const k = t.frameWidth / 1200;
	assert.ok(Math.abs(t.placement.ox - nominalOx - -65 * k) < 4, `ox off nominal by ${(t.placement.ox - nominalOx).toFixed(1)}`);
	assert.ok(Math.abs(t.placement.oy - nominalOy - 65 * k) < 4, `oy off nominal by ${(t.placement.oy - nominalOy).toFixed(1)}`);
	assert.strictEqual(sent.result.profile.transform, true);
	assert.strictEqual(sent.result.profile.path, file);

	const next = makeNode({ ...cfg, trainTransform: false });
	await next.run({ payload: frame });
	assert.deepStrictEqual(next.doneErrors, []);
	assert.ok(!next.warns.some((w) => /retrain|different golden/.test(w)), next.warns.join("\n"));
	const result = next.sent[0].result;
	assert.strictEqual(result.transform.pinned, true);
	assert.deepStrictEqual(result.profile, {
		id: "demo_good_60",
		namedBy: "source",
		path: file,
		contentKey: profile.golden.contentKey,
		transform: true,
		nuisance: false,
		barcodes: null,
	});
});

test("without a profile directory the legacy transform file gains the frame fields too", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const legacyPath = path.join(dir, "transform.json");
	const goldenBuf = await png(labelSvg(W, H));
	await fsp.writeFile(goldenPath, goldenBuf);
	const train = makeNode({ ...NODE_CFG, goldenPath, transformFilePath: legacyPath, trainTransform: true });
	await train.run({ payload: await offsetFrame(goldenBuf) });
	assert.deepStrictEqual(train.doneErrors, []);
	const record = await readJson(legacyPath);
	assert.strictEqual(record.frameNativeWidth, 1200);
	assert.strictEqual(record.frameNativeHeight, 1600);
	assert.ok(record.frameWidth > 0 && record.frameHeight > 0);
	assert.strictEqual(typeof record.placement.ox, "number");
	assert.strictEqual(train.sent[0].result.profile, undefined);
});

test("msg.profile names the profile file", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const goldenPath = path.join(dir, "golden.png");
	const goldenBuf = await png(labelSvg(W, H));
	await fsp.writeFile(goldenPath, goldenBuf);
	const train = makeNode({ ...NODE_CFG, goldenPath, profileDir, trainTransform: true });
	await train.run({ payload: await offsetFrame(goldenBuf), profile: "Line A" });
	assert.deepStrictEqual(train.doneErrors, []);
	const file = path.join(profileDir, "line_a.json");
	const profile = await readJson(file);
	assert.ok(profile.transform);
	assert.strictEqual(profile.golden.namedBy, "profile");
	assert.strictEqual(profile.golden.label, "Line A");
	assert.strictEqual(train.sent[0].result.profile.id, "line_a");
	assert.strictEqual(await exists(path.join(profileDir, "golden.json")), false);
});

// ---- legacy files -------------------------------------------------------

test("a legacy transform file for this golden is imported once; one for another golden is passed over silently", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const goldenA = path.join(dir, "product_a.png");
	const goldenB = path.join(dir, "product_b.png");
	const legacyPath = path.join(dir, "transform.json");
	const bufA = await png(labelSvg(W, H));
	const bufB = await png(labelSvg(W, H, { seed: 3 }));
	await fsp.writeFile(goldenA, bufA);
	await fsp.writeFile(goldenB, bufB);
	const frameA = await offsetFrame(bufA);

	// trained the old way, against golden A
	const legacy = makeNode({ ...NODE_CFG, goldenPath: goldenA, transformFilePath: legacyPath, trainTransform: true });
	await legacy.run({ payload: frameA });
	assert.deepStrictEqual(legacy.doneErrors, []);
	const before = await fsp.readFile(legacyPath, "utf8");

	// golden B with the same legacy path: not B's, so no warning, no
	// refused pin, at most one log line about it however many frames
	const other = makeNode({ ...NODE_CFG, goldenPath: goldenB, profileDir, transformFilePath: legacyPath });
	await other.run({ payload: goldenB });
	await other.run({ payload: goldenB });
	assert.deepStrictEqual(other.doneErrors, []);
	assert.deepStrictEqual(other.warns.filter((w) => !/position/.test(w)), [], other.warns.join("\n"));
	assert.ok(other.logs.filter((l) => l.includes(legacyPath)).length <= 1, other.logs.join("\n"));
	for (const m of other.sent) {
		assert.strictEqual(m.result.transform.pinRefused, undefined);
		assert.strictEqual(m.result.profile.transform, false);
	}
	assert.strictEqual(await exists(path.join(profileDir, "product_b.json")), false);

	// golden A: imported into A's profile and used
	const mine = makeNode({ ...NODE_CFG, goldenPath: goldenA, profileDir, transformFilePath: legacyPath });
	await mine.run({ payload: frameA });
	assert.deepStrictEqual(mine.doneErrors, []);
	assert.strictEqual(mine.sent[0].result.transform.pinned, true);
	assert.strictEqual(mine.sent[0].result.profile.transform, true);
	assert.ok(mine.logs.some((l) => /imported the transform/.test(l)), mine.logs.join("\n"));
	const profile = await readJson(path.join(profileDir, "product_a.json"));
	assert.strictEqual(profile.transform.scaleX, JSON.parse(before).scaleX);
	// the legacy file is never rewritten
	assert.strictEqual(await fsp.readFile(legacyPath, "utf8"), before);
});

// ---- barcode regions ----------------------------------------------------

test(
	"barcode regions are read off the golden once, after the frame, and again when the section is another golden's",
	async () => {
		// zxing-wasm is a hard dependency: its writer missing is a failure,
		// not a skip that reads as a pass
		assert.ok(writer, `zxing-wasm/writer did not load: ${writerError && writerError.message}`);
		const dir = await tmpDir();
		const profileDir = path.join(dir, "profiles");
		const goldenPath = path.join(dir, "Coded_Label.png");
		const { buf, box } = await goldenWithBarcode();
		await fsp.writeFile(goldenPath, buf);
		const file = path.join(profileDir, "coded_label.json");
		const gc = makeNode({ ...NODE_CFG, goldenPath, profileDir, barcodeRegions: true });
		const start = locateCalls;

		// two frames back to back: the second arrives while (or after) the
		// first's derivation runs, and must not start another
		await gc.run({ payload: goldenPath });
		await gc.run({ payload: goldenPath });
		assert.strictEqual(gc.sent.length, 2, "the frames were sent before the derivation settled");
		assert.strictEqual(gc.sent[0].result.profile.barcodes, null);
		await gc.settle();
		assert.deepStrictEqual(gc.doneErrors, []);
		assert.strictEqual(locateCalls - start, 1, "derived more than once");
		const profile = await readJson(file);
		const bc = profile.barcodes;
		assert.strictEqual(bc.source, "golden");
		assert.strictEqual(bc.goldenContentKey, profile.golden.contentKey);
		assert.strictEqual(bc.nativeWidth, W);
		assert.strictEqual(bc.nativeHeight, H);
		assert.strictEqual(bc.regions.length, 1, JSON.stringify(bc.regions));
		const r = bc.regions[0];
		assert.strictEqual(r.format, "Code128");
		assert.strictEqual(r.text, BARCODE.text);
		assert.strictEqual(r.label, `Code128 ${BARCODE.text}`);
		// the symbol's own box in golden native px, unpadded
		assert.ok(Math.abs(r.x - box.x) <= 4 && Math.abs(r.x + r.width - (box.x + box.width)) <= 4, JSON.stringify(r));
		assert.ok(r.y >= box.y - 4 && r.y + r.height <= box.y + box.height + 4, JSON.stringify(r));

		// the section matches: no second derivation
		await gc.run({ payload: goldenPath });
		await gc.settle();
		assert.strictEqual(locateCalls - start, 1, "re-derived a matching section");
		assert.strictEqual(gc.sent[2].result.profile.barcodes, 1);

		// a section derived from other artwork is re-derived
		const stale = { ...profile, barcodes: { ...bc, goldenContentKey: `sha1:${"0".repeat(40)}`, note: "stale" } };
		await fsp.writeFile(file, JSON.stringify(stale, null, 2));
		await gc.run({ payload: goldenPath });
		assert.strictEqual(gc.sent[3].result.profile.barcodes, null);
		await gc.settle();
		assert.strictEqual(locateCalls - start, 2, "a section for other artwork was not re-derived");
		const after = await readJson(file);
		assert.strictEqual(after.barcodes.goldenContentKey, profile.golden.contentKey);
		assert.strictEqual(after.barcodes.regions.length, 1);
		// the derivation never touched the transform it shares the file with
		assert.deepStrictEqual(gc.warns.filter((w) => /barcode/.test(w)), [], gc.warns.join("\n"));

		// msg.deriveBarcodes forces one
		await gc.run({ payload: goldenPath, deriveBarcodes: true });
		await gc.settle();
		assert.strictEqual(locateCalls - start, 3);

		// in-flight derivations are shared by every node of the type, so a
		// redeployed node joins the old one's run rather than starting another
		const other = makeNode({ ...NODE_CFG, goldenPath, profileDir, barcodeRegions: true });
		assert.strictEqual(other.node.derivations, gc.node.derivations);
	},
);

test("barcode regions stay off without the setting", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "plain.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(W, H)));
	const gc = makeNode({ ...NODE_CFG, goldenPath, profileDir: path.join(dir, "profiles") });
	const start = locateCalls;
	await gc.run({ payload: goldenPath });
	await gc.settle();
	assert.deepStrictEqual(gc.doneErrors, []);
	assert.strictEqual(locateCalls, start);
	assert.strictEqual(gc.sent[0].result.profile.barcodes, null);
});

// ---- nuisance training, two goldens interleaved -------------------------

test("nuisance training alternating two goldens keeps one accumulator per profile", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const goldenA = path.join(dir, "Alpha.png");
	const goldenB = path.join(dir, "Beta.png");
	await fsp.writeFile(goldenA, await png(labelSvg(W, H)));
	await fsp.writeFile(goldenB, await png(labelSvg(W, H, { seed: 3 })));
	// no nuisance path: the profile directory is somewhere to write
	const gc = makeNode({ ...NODE_CFG, profileDir, trainNuisance: true });
	for (const g of [goldenA, goldenB, goldenA, goldenB, goldenA]) {
		await gc.run({ golden: g, payload: g });
	}
	assert.deepStrictEqual(gc.doneErrors, []);
	const a = await readJson(path.join(profileDir, "alpha.json"));
	const b = await readJson(path.join(profileDir, "beta.json"));
	assert.strictEqual(a.nuisance.frames, 3);
	assert.strictEqual(b.nuisance.frames, 2);
	assert.notStrictEqual(a.nuisance.goldenContentKey, b.nuisance.goldenContentKey);
	assert.strictEqual(gc.sent[4].trainedNuisance.path, path.join(profileDir, "alpha.json"));
	assert.strictEqual(gc.sent[4].result.profile.nuisance, true);

	// and the next untrained frame applies A's map from A's profile
	const run = makeNode({ ...NODE_CFG, profileDir });
	await run.run({ golden: goldenA, payload: goldenA });
	assert.deepStrictEqual(run.doneErrors, []);
	assert.strictEqual(run.sent[0].result.profile.nuisance, true);
	assert.ok(!run.warns.some((w) => /nuisance/.test(w)), run.warns.join("\n"));
});

// ---- review fixes ----------------------------------------------------------

test("a failed legacy import is retried on the next frame rather than remembered as checked", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const goldenPath = path.join(dir, "product_a.png");
	const legacyPath = path.join(dir, "transform.json");
	const goldenBuf = await png(labelSvg(W, H));
	await fsp.writeFile(goldenPath, goldenBuf);
	const frame = await offsetFrame(goldenBuf);
	const legacy = makeNode({ ...NODE_CFG, goldenPath, transformFilePath: legacyPath, trainTransform: true });
	await legacy.run({ payload: frame });

	// the first two profile writes fail as a held handle on Windows would
	const realWrite = profileStore.writeProfileSection;
	let failures = 2;
	profileStore.writeProfileSection = (...args) => {
		if (failures > 0) {
			failures--;
			return Promise.reject(Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }));
		}
		return realWrite(...args);
	};
	try {
		const gc = makeNode({ ...NODE_CFG, goldenPath, profileDir, transformFilePath: legacyPath });
		for (let i = 0; i < 3; i++) await gc.run({ payload: frame });
		assert.deepStrictEqual(gc.doneErrors, []);
		// every frame pinned, the failed ones from the legacy record itself
		assert.deepStrictEqual(gc.sent.map((m) => m.result.transform.pinned), [true, true, true]);
		assert.strictEqual(gc.warns.filter((w) => /could not import/.test(w)).length, 1, gc.warns.join("\n"));
		assert.ok(gc.logs.some((l) => /imported the transform/.test(l)), gc.logs.join("\n"));
		assert.ok((await readJson(path.join(profileDir, "product_a.json"))).transform);
	} finally {
		profileStore.writeProfileSection = realWrite;
	}
});

test("a bytes golden is named by msg.filename only when it is an artwork document", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const goldenBuf = await png(labelSvg(W, H));
	const gc = makeNode({ ...NODE_CFG, profileDir });
	// the golden rides on the frame's message, and file in read the frame
	await gc.run({ golden: goldenBuf, payload: goldenBuf, filename: "/frames/image_0001.jpg", goldenKey: "demo" });
	// the artwork PDF's name, as pdf-to-image passes it through
	await gc.run({ golden: goldenBuf, payload: goldenBuf, filename: "/art/Label.PDF" });
	assert.deepStrictEqual(gc.doneErrors, []);
	assert.strictEqual(gc.sent[0].result.profile.id, "demo");
	assert.strictEqual(path.basename(gc.sent[0].result.profile.path), "demo.json");
	assert.strictEqual(gc.sent[1].result.profile.id, "label");
	assert.strictEqual(path.basename(gc.sent[1].result.profile.path), "label.json");
	assert.strictEqual(gc.sent[1].result.profile.namedBy, "source");
});

test("nuisance training restarts for a revised artwork under the same profile name", async () => {
	const dir = await tmpDir();
	const profileDir = path.join(dir, "profiles");
	const a = await png(labelSvg(W, H));
	const b = await png(labelSvg(W, H, { seed: 3 }));
	const gc = makeNode({ ...NODE_CFG, profileDir, trainNuisance: true });
	await gc.run({ golden: a, payload: a, profile: "same" });
	await gc.run({ golden: a, payload: a, profile: "same" });
	await gc.run({ golden: b, payload: b, profile: "same" });
	assert.deepStrictEqual(gc.doneErrors, []);
	assert.deepStrictEqual(gc.sent.map((m) => m.trainedNuisance.frames), [1, 2, 1]);
});

test("without a profile directory nuisance training keeps one accumulator across a rewritten golden file", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const nuisancePath = path.join(dir, "nuisance.json");
	const goldenBuf = await png(labelSvg(W, H));
	await fsp.writeFile(goldenPath, goldenBuf);
	const gc = makeNode({ ...NODE_CFG, goldenPath, nuisancePath, trainNuisance: true });
	await gc.run({ payload: goldenPath });
	// the flow rewrites the same golden each cycle: a new mtime, a new key
	await fsp.writeFile(goldenPath, goldenBuf);
	const later = new Date(Date.now() + 5000);
	await fsp.utimes(goldenPath, later, later);
	await gc.run({ payload: goldenPath });
	assert.deepStrictEqual(gc.doneErrors, []);
	assert.deepStrictEqual(gc.sent.map((m) => m.trainedNuisance.frames), [1, 2]);
	assert.strictEqual((await readJson(nuisancePath)).frames, 2);
});
