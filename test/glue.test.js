/**
 * Regression tests for the golden-compare Node-RED glue (golden-compare.js)
 * and the calibration-resolution conversion in lib/compare.js.
 *
 * The node is exercised without Node-RED installed: golden-compare.js
 * exports its registerType factory, which is invoked with a fake RED whose
 * createNode/registerType capture the constructor, and the node's own
 * 'input' listener is driven directly.
 *
 * The bugs this suite exists for:
 *
 *  - goldenRawGeometry fell through to msg.images[] for ANY golden form,
 *    so a message still carrying pdf-to-image leftovers (msg.format ===
 *    "RAW" + msg.images[]) stamped the frame's geometry onto a path-string
 *    golden, which was then decoded as raw pixels and cached as garbage
 *    under cfg.raw for every later frame.
 *  - the path-string golden cache key was content-blind ("path:<file>"):
 *    overwriting the golden file in place neither re-prepared the cache
 *    nor invalidated a trained transform measured against the old bytes.
 *  - the mm/px conversion assumed the calibration photo and the golden
 *    share a native resolution, so a golden rendered at a different size
 *    than the calibration was silently converted with the wrong scale.
 *  - FW3: resolveImage accepted ArrayBuffer only at the top level, never
 *    validated a raw descriptor against its buffer's length, read any
 *    path after only an access() check, and copied/hashed unbounded
 *    buffers; failures were also reported twice (node.error + done(err)).
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");
const { prepareGolden } = require("../lib/compare.js");

// ---- fake RED harness -------------------------------------------------

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
	require("../golden-compare.js")(RED);
	const node = new RED.nodes.ctor(config);
	const sent = [];
	const warns = [];
	const errors = [];
	const statuses = [];
	node.send = (m) => sent.push(m);
	node.warn = (m) => warns.push(String(m));
	node.error = (m) => errors.push(String(m));
	node.status = (s) => statuses.push(s);
	// failures routed through the done callback are the real Node-RED
	// path (done(err) goes to node.error); kept separate so tests can
	// assert a failure is reported exactly once
	const doneErrors = [];
	const run = (msg) =>
		node.listeners.input(msg, undefined, (err) => {
			if (err) {
				doneErrors.push(err && err.message ? String(err.message) : String(err));
			}
		});
	return { node, run, sent, warns, errors, statuses, doneErrors };
}

// ---- synthetic label fixture ------------------------------------------

// Aperiodic bar positions: evenly spaced bars make a vertical stretch
// genuinely ambiguous (the stretched pattern aligns against the
// neighbouring bar), so keep the same irregular layout the rest of the
// suite uses.
const BAR_Y = [
	0.1, 0.155, 0.19, 0.26, 0.3, 0.375, 0.41, 0.47, 0.545, 0.6, 0.68, 0.74,
];

function labelSvg(width, height, { shiftY = 0, seed = 0 } = {}) {
	const bars = [];
	for (let i = 0; i < BAR_Y.length; i++) {
		const y = Math.round(height * BAR_Y[i]) + shiftY;
		const w = Math.round(
			width * (i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.44 : 0.31),
		);
		const x = Math.round(width * 0.14) + ((seed * (i + 1) * 7) % 40);
		bars.push(
			`<rect x="${x}" y="${y}" width="${w}" height="${Math.round(height * 0.022)}" fill="#111"/>`,
		);
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

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), "gc-glue-"));

// workers: 1 disables the nested worker pool. It does not mean "inline" -
// the pipeline runs in the inspector worker either way; GOLDEN_COMPARE_INLINE
// is what selects that.
const NODE_CFG = { workers: 1 };

// ---- FW2.1: goldenRawGeometry must not inherit msg.images geometry ----

test("a path-string golden ignores stale pdf-to-image msg.images geometry", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));

	const { node, run, sent, errors } = makeNode(NODE_CFG);
	const msg = {
		golden: goldenPath, // a path string: a file golden
		payload: goldenPath, // the frame is the same file, so a clean compare passes
		format: "RAW", // stale pdf-to-image leftovers on the same message
		images: [{ page: 1, width: 1234, height: 567, channels: 3 }],
	};
	await run(msg);

	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
	// the leftover geometry must not have been stamped onto the golden
	assert.ok(
		!node.goldenCache.key.includes("1234x567x3"),
		`cache key carried the frame's geometry: ${node.goldenCache.key}`,
	);
});

test("a bare-buffer golden still inherits geometry from msg.images[]", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { data, info } = await sharp(encoded)
		.raw()
		.toBuffer({ resolveWithObject: true });

	const { node, run, sent, errors } = makeNode(NODE_CFG);
	const msg = {
		golden: Buffer.from(data), // bare buffer - the pdf-to-image straight-wire case
		payload: encoded, // the frame as an encoded file
		format: "RAW",
		page: 1,
		images: [
			{ page: 1, width: info.width, height: info.height, channels: info.channels },
		],
	};
	await run(msg);

	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
	assert.ok(
		node.goldenCache.key.includes(
			`${info.width}x${info.height}x${info.channels}`,
		),
		`raw geometry was not picked up from msg.images[]: ${node.goldenCache.key}`,
	);
});

// ---- FW2.2: the path golden cache key follows the file's content -------

test("an overwritten golden file changes the cache key and refuses the stale trained transform", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const xformPath = path.join(dir, "transform.json");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));

	// train against golden A, capturing the trained record's goldenKey
	const train = makeNode({
		...NODE_CFG,
		goldenPath,
		transformFilePath: xformPath,
		trainTransform: true,
	});
	await train.run({ payload: goldenPath });
	const record = JSON.parse(await fsp.readFile(xformPath, "utf8"));
	assert.match(record.goldenKey, /^path:/);

	// overwrite the golden in place - no re-pointing, no msg.goldenKey
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300, { seed: 3 })));

	const { node, run, warns, sent, errors } = makeNode({
		...NODE_CFG,
		goldenPath,
		transformFilePath: xformPath,
		trainTransform: false,
	});
	await run({ payload: goldenPath });

	assert.strictEqual(errors.length, 0, errors.join("\n"));
	// the new content key differs from the trained goldenKey, so the
	// stored transform is refused and the 'retrain' warning fires
	assert.notStrictEqual(node.goldenCache.key.split("|")[0], record.goldenKey);
	assert.ok(
		warns.some((w) => /different golden/.test(w) && /retrain/.test(w)),
		warns.join("\n"),
	);
	// it then searched instead of pinning the stale numbers, and passed
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
});

// ---- the trained transform follows the golden's content, not its form -

// The reported flow: tick "train transform", send the golden on the
// message (README's "train from any two images"), untick, then let the
// node use its configured goldenPath. Identical bytes, but the trained
// record was keyed buf:<sha1> and the frames keyed path:<file>:<mtime>:<size>,
// so the record was refused and the full search ran on every frame -
// behind a node.warn() that is easy to miss.
test("a transform trained through msg.golden is reused when the same image comes from goldenPath", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const xformPath = path.join(dir, "transform.json");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	const goldenBuf = await fsp.readFile(goldenPath);
	const cfg = { ...NODE_CFG, goldenPath, transformFilePath: xformPath };

	const train = makeNode({ ...cfg, trainTransform: true });
	await train.run({ payload: goldenPath, golden: goldenBuf });
	assert.strictEqual(train.errors.length, 0, train.errors.join("\n"));
	const record = JSON.parse(await fsp.readFile(xformPath, "utf8"));
	assert.match(record.goldenKey, /^buf:/);
	assert.match(record.goldenContentKey, /^sha1:/);

	const { run, sent, warns, errors } = makeNode({ ...cfg, trainTransform: false });
	await run({ payload: goldenPath });

	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.ok(
		!warns.some((w) => /different golden/.test(w)),
		`the same golden was refused for arriving by a different route: ${warns.join("\n")}`,
	);
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].result.transform.pinned, true);
	assert.strictEqual(sent[0].result.transform.pinRefused, undefined);
});

// A refused pin is otherwise invisible from the message: same shape, same
// pass/fail, just silently slower.
test("a refused trained transform says so on the message, not only in a warning", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const xformPath = path.join(dir, "transform.json");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	const cfg = { ...NODE_CFG, goldenPath, transformFilePath: xformPath };

	const train = makeNode({ ...cfg, trainTransform: true });
	await train.run({ payload: goldenPath });
	// a different golden entirely, so the record is correctly refused
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300, { seed: 3 })));

	const { run, sent, errors } = makeNode({ ...cfg, trainTransform: false });
	await run({ payload: goldenPath });

	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(sent[0].result.transform.pinned, false);
	assert.match(sent[0].result.transform.pinRefused, /different golden/);
});

// ---- FW2.4: mm/px conversion uses the calibration photo's resolution ---

const MM_CFG = {
	workingSize: 1024,
	threshold: 128,
	thresholdMode: "fixed",
	maxAspect: 0.06,
	aspectSteps: 7,
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	scaleSearchMin: 0.6,
	scaleSearchMax: 2.5,
	scaleSearchSteps: 19,
	maxAngleDeg: 2,
	angleSteps: 5,
	positionToleranceAngleDeg: 1,
	printTolerance: 5,
	backgroundTolerance: 3,
	alignSearch: 16,
	positionToleranceXMm: 2,
	positionToleranceYMm: 2,
	positionToleranceXPx: 16,
	positionToleranceYPx: 16,
	inkMargin: 8,
	blockSize: 16,
	blockThreshold: 0.15,
	failThreshold: 0.3,
	failRatio: 0.002,
	outputPrintHeatmap: false,
	outputBackgroundHeatmap: false,
	debugStages: false,
	mmPerPixelNative: null,
};

test("mmPerWorkingPx is derived from the calibration photo's native size, not the golden's", async () => {
	const buf = await png(labelSvg(900, 1300));
	const c = {
		...MM_CFG,
		mmPerPixelNative: 0.05,
		// calibration photo 2000x1000 (max 2000); golden is 900x1300
		// (max 1300). The old formula used the golden's 1300 and was wrong
		// whenever the two were not rendered at the same resolution.
		calibrationNativeWidth: 2000,
		calibrationNativeHeight: 1000,
	};
	const golden = await prepareGolden(buf, c);
	const workingMax = Math.max(golden.width, golden.height);
	assert.strictEqual(golden.mmPerWorkingPx, 0.05 * (2000 / workingMax));
	assert.notStrictEqual(golden.mmPerWorkingPx, 0.05 * (1300 / workingMax));
});

test("a calibration file without its own geometry falls back to the golden's native size", async () => {
	const buf = await png(labelSvg(900, 1300));
	const c = { ...MM_CFG, mmPerPixelNative: 0.05 };
	const golden = await prepareGolden(buf, c);
	const workingMax = Math.max(golden.width, golden.height);
	assert.strictEqual(golden.mmPerWorkingPx, 0.05 * (1300 / workingMax));
});

test("mmPerWorkingPx is unchanged when the calibration photo matches the golden's resolution", async () => {
	const buf = await png(labelSvg(900, 1300));
	const withCal = await prepareGolden(buf, {
		...MM_CFG,
		mmPerPixelNative: 0.05,
		calibrationNativeWidth: 900,
		calibrationNativeHeight: 1300,
	});
	const withoutCal = await prepareGolden(buf, {
		...MM_CFG,
		mmPerPixelNative: 0.05,
	});
	assert.strictEqual(withCal.mmPerWorkingPx, withoutCal.mmPerWorkingPx);
});

// ---- FW2.3/FW2.4 node-level warnings ------------------------------------

test("a golden at a different native resolution than the calibration photo warns once", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const scalePath = path.join(dir, "scale.json");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	await fsp.writeFile(
		scalePath,
		JSON.stringify({
			mmPerPixelNative: 0.05,
			nativeWidth: 2000,
			nativeHeight: 1000,
		}),
	);

	const { node, run, warns, sent, errors } = makeNode({
		...NODE_CFG,
		goldenPath,
		scaleFilePath: scalePath,
	});
	await run({ payload: goldenPath });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
	const resolutionWarns = () =>
		warns.filter((w) => /calibration photo/.test(w) && /golden is/.test(w));
	assert.strictEqual(resolutionWarns().length, 1, warns.join("\n"));

	// once per golden, not once per frame
	await run({ payload: goldenPath });
	assert.strictEqual(resolutionWarns().length, 1);
});

test("a corrupt calibration file warns once and the inspection runs uncalibrated", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const scalePath = path.join(dir, "scale.json");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	await fsp.writeFile(scalePath, "{not json");

	const { node, run, warns, sent, errors } = makeNode({
		...NODE_CFG,
		goldenPath,
		scaleFilePath: scalePath,
	});
	await run({ payload: goldenPath });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.ok(
		warns.some((w) => /calibration file is not readable JSON/.test(w)),
		warns.join("\n"),
	);
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);

	await run({ payload: goldenPath });
	assert.strictEqual(
		warns.filter((w) => /not readable JSON/.test(w)).length,
		1,
		"warns once per path, not per frame",
	);
});

// ---- FW3: resolveImage hardening ---------------------------------------

test("an object golden with ArrayBuffer data is accepted", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const ab = encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	);
	const { run, sent, errors, doneErrors } = makeNode(NODE_CFG);
	await run({ golden: { data: ab }, payload: encoded });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
});

test("a raw descriptor that cannot fit its buffer is refused with the real numbers", async () => {
	const { run, errors, doneErrors } = makeNode(NODE_CFG);
	await run({
		golden: { data: new Uint8Array(64), width: 1000, height: 1000, channels: 4 },
		payload: new Uint8Array(64),
	});
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(
		doneErrors[0],
		/golden reference raw descriptor 1000x1000x4 needs 4000000 bytes but the buffer holds 64/,
	);
	assert.strictEqual(errors.length, 0, "done(err) must be the only report");
});

test("msg.rawInfo geometry larger than the payload buffer is refused", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { run, errors, doneErrors } = makeNode(NODE_CFG);
	await run({
		golden: encoded,
		payload: new Uint8Array(64),
		rawInfo: { width: 1000, height: 1000, channels: 4 },
	});
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(
		doneErrors[0],
		/msg\.payload raw descriptor 1000x1000x4 needs 4000000 bytes but the buffer holds 64/,
	);
	assert.strictEqual(errors.length, 0, "done(err) must be the only report");
});

test("a payload over the 512MB cap is refused before copy or hash", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	const { run, doneErrors } = makeNode({ ...NODE_CFG, goldenPath });
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
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	const { run, doneErrors } = makeNode({ ...NODE_CFG, goldenPath });
	await run({ payload: dir }); // a directory opens, but is not a regular file
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(doneErrors[0], /not a regular file/);
});

test("a missing file payload keeps the does-not-exist error", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	const { run, doneErrors } = makeNode({ ...NODE_CFG, goldenPath });
	await run({ payload: path.join(dir, "absent.png") });
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(doneErrors[0], /does not exist on disk/);
});

test("a failure is reported through done once, not through node.error as well", async () => {
	const { run, errors, doneErrors } = makeNode(NODE_CFG);
	await run({ payload: new Uint8Array(4) }); // no golden configured
	assert.strictEqual(doneErrors.length, 1);
	assert.strictEqual(errors.length, 0, "done(err) must be the only report");
});

test("golden debug stages are only rendered when debugStages is on", async () => {
	const buf = await png(labelSvg(900, 1300));
	const off = await prepareGolden(buf, { ...MM_CFG, debugStages: false });
	assert.strictEqual(off.stages, null);
	const on = await prepareGolden(buf, { ...MM_CFG, debugStages: true });
	assert.ok(on.stages, "debug stages should be rendered when asked for");
	assert.ok(Buffer.isBuffer(on.stages.goldenGray));
	assert.ok(Buffer.isBuffer(on.stages.goldenFg));
	assert.ok(Buffer.isBuffer(on.stages.goldenFgDilatedBackground));
});

// ---- FW4: the remaining resolveImage branches, cache invalidation, and
// ---- the rawInfo forms ------------------------------------------------

test("an object golden carrying data (Uint8Array) is accepted", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { run, sent, errors, doneErrors } = makeNode(NODE_CFG);
	await run({ golden: { data: new Uint8Array(encoded) }, payload: encoded });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
});

test("an object golden carrying a path is read and cached under that path", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(900, 1300)));
	const { node, run, sent, errors, doneErrors } = makeNode(NODE_CFG);
	await run({ golden: { path: goldenPath }, payload: goldenPath });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
	assert.match(node.goldenCache.key, /^path:/);
});

test("a missing golden path is refused with the does-not-exist error", async () => {
	const dir = await tmpDir();
	const { run, errors, doneErrors } = makeNode(NODE_CFG);
	await run({
		golden: path.join(dir, "absent-golden.png"),
		payload: path.join(dir, "absent-frame.png"),
	});
	assert.strictEqual(doneErrors.length, 1, doneErrors.join("\n"));
	assert.match(doneErrors[0], /golden reference does not exist on disk/);
	assert.strictEqual(errors.length, 0, "done(err) must be the only report");
});

test("the golden cache re-prepares when a baked setting changes", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { node, run, sent, errors, doneErrors } = makeNode({
		...NODE_CFG,
		thresholdMode: "fixed", // so thresholdLevel reflects cfg.threshold
	});
	await run({ golden: encoded, payload: encoded });
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	const key1 = node.goldenCache.key;
	assert.strictEqual((await node.goldenCache.promise).thresholdLevel, 128);

	await run({ golden: encoded, payload: encoded, threshold: 200 });
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.notStrictEqual(
		node.goldenCache.key,
		key1,
		"a changed baked setting must re-key the cache",
	);
	assert.strictEqual((await node.goldenCache.promise).thresholdLevel, 200);
	assert.strictEqual(sent.length, 2);
	assert.strictEqual(sent[1].payload, true);
});

test("a bare-buffer golden decodes raw via msg.goldenRawInfo", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { data, info } = await sharp(encoded)
		.grayscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	assert.strictEqual(info.channels, 1, "precondition: one grey channel");
	const { node, run, sent, errors, doneErrors } = makeNode(NODE_CFG);
	await run({
		golden: data, // raw pixels: no container for sharp to infer geometry from
		goldenRawInfo: { width: info.width, height: info.height, channels: 1 },
		payload: encoded,
	});
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
	assert.ok(
		node.goldenCache.key.includes(`${info.width}x${info.height}x1`),
		`raw geometry was not baked into the cache key: ${node.goldenCache.key}`,
	);
});

test("a bare-buffer frame decodes raw via msg.rawInfo", async () => {
	const encoded = await png(labelSvg(900, 1300));
	const { data, info } = await sharp(encoded)
		.grayscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	assert.strictEqual(info.channels, 1, "precondition: one grey channel");
	const { run, sent, errors, doneErrors } = makeNode(NODE_CFG);
	await run({
		golden: encoded,
		payload: data, // raw pixels, geometry carried separately
		rawInfo: { width: info.width, height: info.height, channels: 1 },
	});
	assert.strictEqual(errors.length, 0, errors.join("\n"));
	assert.strictEqual(doneErrors.length, 0, doneErrors.join("\n"));
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].payload, true);
});
