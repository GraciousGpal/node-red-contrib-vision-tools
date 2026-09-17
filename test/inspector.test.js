/**
 * The thread boundary.
 *
 * Every test here covers something the rest of the suite provably cannot
 * see, because the failures are not wrong *values* - they are wrong
 * *types*, silent fallbacks, and state machines that never terminate.
 *
 *  - Structured clone turns a Buffer into a Uint8Array. msg.printHeatmap
 *    is documented as a PNG Buffer and wired into an image viewer in the
 *    demo flow, and the damage is silent:
 *      Buffer.toString("base64")     -> "iVBORw0KGgo..."
 *      Uint8Array.toString("base64") -> "137,80,78,71,..."
 *    Nothing in the suite asserted this: the only Buffer.isBuffer checks
 *    call prepareGolden directly rather than going through the node.
 *  - Both re-wrapped values are null by default (heatmaps unless asked
 *    for, stages unless debugStages is on), so the unguarded version of
 *    that fix fails on the first frame of a default flow.
 *  - The inspector's golden store is bounded, so an entry can be evicted
 *    between preparing it and using it. The retry that handles this
 *    livelocks unless it invalidates the node's own cache first: the
 *    handler decides on `node.goldenCache.key !== cacheKey`, so a retry
 *    that leaves it in place re-enters a cache *hit*, never sends a
 *    prepare, and asks the same empty inspector forever.
 *  - A rejected prepare must not wedge its key. Both caches need their
 *    own clearing; the node's alone is not enough.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");
const inspector = require("../lib/inspector.js");
const core = require("../lib/inspectorCore.js");

test.after(() => inspector.shutdown());

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
	node.send = (m) => sent.push(m);
	node.warn = () => {};
	node.error = () => {};
	node.status = () => {};
	node.log = () => {};
	const run = (msg) =>
		new Promise((resolve, reject) =>
			node.listeners.input(msg, undefined, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	return { node, run, sent };
}

const svg = (w, h, extra = "") =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="30" y="40" width="${(w * 0.6) | 0}" height="${(h * 0.15) | 0}" fill="#111"/>` +
			`<circle cx="${(w * 0.6) | 0}" cy="${(h * 0.7) | 0}" r="${(h * 0.08) | 0}" fill="#111"/>` +
			extra +
			`</svg>`,
	);

const png = (s) => sharp(s).png().toBuffer();
const CFG = { workers: 1, workingSize: 384 };

// ---- Buffers across the boundary ---------------------------------------

test("heatmaps arrive as real Buffers, not Uint8Arrays", async () => {
	const golden = await png(svg(500, 700));
	// a mark the golden does not have, so the background check produces a
	// heat map with something in it
	const frame = await png(
		svg(500, 700, `<rect x="300" y="560" width="90" height="30" fill="#111"/>`),
	);
	const { run, sent } = makeNode({
		...CFG,
		outputPrintHeatmap: true,
		outputBackgroundHeatmap: true,
	});
	await run({ payload: frame, golden, goldenKey: "hm" });
	assert.strictEqual(sent.length, 1);

	for (const key of ["printHeatmap", "backgroundHeatmap"]) {
		const v = sent[0][key];
		assert.ok(v, `${key} missing`);
		assert.ok(Buffer.isBuffer(v), `${key} is ${v.constructor.name}, not a Buffer`);
		// the observable, not the type name: a Uint8Array here yields
		// "255,216,255,..." instead of base64, and a viewer renders nothing.
		// JPEG by default (see encodeImage in lib/compare.js)
		assert.match(
			v.toString("base64").slice(0, 4),
			/^\/9j\//,
			`${key} does not base64 as a JPEG`,
		);
	}
	// and PNG on request, through the same path
	const asPng = makeNode({ ...CFG, heatmapFormat: "png" });
	await asPng.run({ payload: frame, golden, goldenKey: "hm-png" });
	for (const key of ["printHeatmap", "backgroundHeatmap"]) {
		assert.match(
			asPng.sent[0][key].toString("base64").slice(0, 12),
			/^iVBORw0KGgo/,
			`${key} does not base64 as a PNG`,
		);
	}
	// raw: no codec, the package's raw object, its data a real Buffer even
	// after the trip out of the inspector worker
	const asRaw = makeNode({ ...CFG, heatmapFormat: "raw" });
	await asRaw.run({ payload: frame, golden, goldenKey: "hm-raw" });
	for (const key of ["printHeatmap", "backgroundHeatmap"]) {
		const v = asRaw.sent[0][key];
		assert.ok(Buffer.isBuffer(v.data), `${key}.data is ${v.data && v.data.constructor.name}`);
		assert.strictEqual(v.channels, 3);
		assert.strictEqual(v.colorSpace, "RGB");
		assert.strictEqual(v.dtype, "uint8");
		assert.strictEqual(v.data.length, v.width * v.height * 3);
	}
	// the background heat map has the mark painted red: R up, G and B down
	const bg = asRaw.sent[0].backgroundHeatmap;
	let red = 0;
	for (let i = 0; i < bg.data.length; i += 3) {
		if (bg.data[i] > bg.data[i + 1] + 40) red++;
	}
	assert.ok(red > 0, "no red block in the raw background heat map");
});

test("debug stages arrive as real Buffers", async () => {
	const golden = await png(svg(400, 560));
	const frame = await png(svg(400, 560));
	const { run, sent } = makeNode({ ...CFG, debugStages: true });
	await run({ payload: frame, golden, goldenKey: "stages" });
	const stages = sent[0].stages;
	assert.ok(stages && Object.keys(stages).length >= 8, "expected the stage set");
	// grey stages follow heatmapFormat (JPEG by default); masks are always
	// PNG - see renderMaskPng
	const isMask = (name) => /Fg|Defect/.test(name);
	for (const [name, v] of Object.entries(stages)) {
		assert.ok(Buffer.isBuffer(v), `stages.${name} is ${v.constructor.name}`);
		if (isMask(name)) {
			assert.match(v.toString("base64").slice(0, 12), /^iVBORw0KGgo/, `stages.${name} not PNG`);
		} else {
			assert.match(v.toString("base64").slice(0, 4), /^\/9j\//, `stages.${name} not JPEG`);
		}
	}
	// the format is baked into the golden's cached stages, so flipping it
	// must re-prepare rather than serve the old encodes
	const asPng = makeNode({ ...CFG, debugStages: true, heatmapFormat: "png" });
	await asPng.run({ payload: frame, golden, goldenKey: "stages" });
	for (const [name, v] of Object.entries(asPng.sent[0].stages)) {
		assert.match(v.toString("base64").slice(0, 12), /^iVBORw0KGgo/, `stages.${name} not PNG`);
	}
	const asRaw = makeNode({ ...CFG, debugStages: true, heatmapFormat: "raw" });
	await asRaw.run({ payload: frame, golden, goldenKey: "stages" });
	for (const [name, v] of Object.entries(asRaw.sent[0].stages)) {
		assert.ok(Buffer.isBuffer(v.data), `stages.${name}.data not a Buffer`);
		assert.strictEqual(v.channels, 1, `stages.${name} is grey`);
		assert.strictEqual(v.data.length, v.width * v.height);
	}
});

test("the default configuration - no heatmaps, no stages - does not throw", async () => {
	// both re-wrapped values are null by default, and Buffer.from(null.buffer)
	// throws: unguarded, this takes out every default flow on frame one
	const golden = await png(svg(400, 560));
	const frame = await png(svg(400, 560));
	const { run, sent } = makeNode({
		...CFG,
		outputPrintHeatmap: false,
		outputBackgroundHeatmap: false,
		debugStages: false,
	});
	await run({ payload: frame, golden, goldenKey: "bare" });
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].printHeatmap, undefined);
	assert.strictEqual(sent[0].stages, undefined);
	assert.strictEqual(typeof sent[0].result.printBlemish.defectRatio, "number");
});

// ---- eviction and the retry -------------------------------------------

test("a golden evicted between prepare and inspect is recovered, not spun on", async () => {
	const golden = await png(svg(400, 560));
	const frame = await png(svg(400, 560));
	const { node, run, sent } = makeNode({ ...CFG });
	await run({ payload: frame, golden, goldenKey: "evict" });
	assert.strictEqual(sent.length, 1);

	// Evict everything the inspector holds while the node still believes its
	// entry is good - exactly the state the bounded store can produce on its
	// own when several goldens are in flight.
	core.clear();
	if (!inspector.INLINE) {
		// the worker has its own store; reach it the same way a real
		// eviction would, by filling it past MAX_GOLDENS
		for (let i = 0; i < core.MAX_GOLDENS + 1; i++) {
			await inspector.prepare({
				cacheKey: `filler-${i}`,
				cfg: {
					workingSize: 64,
					threshold: 128,
					thresholdMode: "fixed",
					sauvolaRadius: 24,
					sauvolaK: 0.2,
					inkMargin: 0,
					backgroundTolerance: 0,
					debugStages: false,
					mmPerPixelNative: null,
					calibrationNativeWidth: null,
					calibrationNativeHeight: null,
				},
				golden: (await png(svg(80, 80))).buffer,
			});
		}
	}
	assert.ok(node.goldenCache, "precondition: the node still holds its entry");

	// must complete, and must not hang
	await run({ payload: frame, golden, goldenKey: "evict" });
	assert.strictEqual(sent.length, 2, "the second frame did not complete");
	assert.strictEqual(typeof sent[1].result.transform.score, "number");
});

test("the store is bounded", () => {
	assert.ok(
		core.MAX_GOLDENS >= 2 && core.MAX_GOLDENS <= 8,
		`MAX_GOLDENS is ${core.MAX_GOLDENS}`,
	);
});

test("a golden that fails to prepare does not wedge its key", async () => {
	// Both caches have to clear on rejection. The node's own entry is
	// cleared by golden-compare.js; if the inspector kept a rejected
	// promise under the same key, every later frame would inherit one
	// transient failure for the life of the process.
	const notAnImage = Buffer.from("this is not a PNG, and sharp will say so");
	const frame = await png(svg(400, 560));
	const { run, sent } = makeNode({ ...CFG });

	await assert.rejects(
		run({ payload: frame, golden: notAnImage, goldenKey: "wedge" }),
		/unsupported image format|Input buffer/i,
	);

	// same key, now with bytes that do decode - a stale rejected promise
	// would make this fail too
	const golden = await png(svg(400, 560));
	await run({ payload: frame, golden, goldenKey: "wedge" });
	assert.strictEqual(sent.length, 1, "the key stayed wedged after one failure");
});

// ---- error fidelity ----------------------------------------------------

test("an error raised inside the pipeline keeps its message", async () => {
	const frame = Buffer.from("not an image either");
	const golden = await png(svg(400, 560));
	const { run } = makeNode({ ...CFG });
	await assert.rejects(
		run({ payload: frame, golden, goldenKey: "err" }),
		(err) => {
			assert.ok(err instanceof Error, "not an Error");
			assert.match(err.message, /unsupported image format|Input buffer/i);
			return true;
		},
	);
});

// ---- calibration moved too --------------------------------------------

test("checkerboard-calibrate still measures through the inspector", async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gc-cal-"));
	const board = [];
	const sq = 40;
	for (let y = 0; y < 6; y++) {
		for (let x = 0; x < 8; x++) {
			if ((x + y) % 2 === 0) continue;
			board.push(
				`<rect x="${20 + x * sq}" y="${20 + y * sq}" width="${sq}" height="${sq}" fill="#111"/>`,
			);
		}
	}
	const image = await png(
		Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="320">` +
				`<rect width="100%" height="100%" fill="#fff"/>${board.join("")}</svg>`,
		),
	);

	const RED = {
		nodes: {
			createNode(node, cfg) {
				node.config = cfg;
				node.listeners = {};
				node.on = (e, f) => {
					node.listeners[e] = f;
				};
				node.send = () => {};
				node.error = () => {};
				node.warn = () => {};
				node.log = () => {};
				node.status = () => {};
			},
			registerType(n, c) {
				RED.nodes.ctor = c;
			},
		},
	};
	require("../checkerboard-calibrate.js")(RED);
	const node = new RED.nodes.ctor({
		cols: 4,
		rows: 3,
		squareMm: 10,
		scaleFilePath: path.join(dir, "scale.json"),
	});
	const sent = [];
	node.send = (m) => sent.push(m);
	node.warn = () => {};
	node.error = () => {};
	node.status = () => {};
	node.log = () => {};
	await new Promise((resolve, reject) =>
		node.listeners.input({ payload: image }, undefined, (err) =>
			err ? reject(err) : resolve(),
		),
	);
	assert.strictEqual(sent.length, 1);
	// detected or not, the point is that it ran off-thread and answered
	assert.strictEqual(typeof sent[0].result.checkerboardDetected, "boolean");
	await fsp.rm(dir, { recursive: true, force: true });
});
