/**
 * Node-RED glue tests for the label-crop node (label-crop.js).
 *
 * The node is exercised without Node-RED installed: label-crop.js exports
 * its registerType factory, invoked with a fake RED whose createNode/
 * registerType capture the constructor, and the node's own 'input'
 * listener is driven directly - the same harness shape as glue.test.js.
 *
 * The engine is the fake from the seam: _setBridge() replaces the lazy
 * loader so the node never touches the real native bridge here.
 */

const test = require("node:test");
const assert = require("node:assert");
const { _setBridge, _resetBridge } = require("../lib/labelCrop.js");
const { makeRectMask, rawImage, labelOnTray } = require("./helpers/synthetic.js");
const { pixelEngine } = require("./helpers/pixelEngine.js");
const { loadNode } = require("./helpers/fakeRed.js");

function makeNode(config = {}) {
	const published = [];
	const node = loadNode("label-crop.js", config, {
		id: "label-crop-test",
		comms: {
			publish(topic, data) {
				published.push({ topic, data });
			},
		},
	});
	const sent = [];
	const errors = [];
	const statuses = [];
	const doneErrors = [];
	node.send = (m) => sent.push(m);
	node.error = (m) => errors.push(String(m));
	node.status = (s) => statuses.push(s);
	const run = (msg) =>
		node.listeners.input(
			msg,
			(m) => sent.push(m),
			(err) => {
				if (err) {
					doneErrors.push(err && err.message ? String(err.message) : String(err));
				}
			},
		);
	return { node, run, sent, errors, statuses, doneErrors, published };
}

/** Engine that always detects a 160x120 rect at the center of the copy. */
function detectingEngine() {
	const SMALL_W = 400;
	const SMALL_H = 300;
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	return {
		colorConvert: async (img) => {
			if (Buffer.isBuffer(img)) {
				return {
					image: rawImage(Buffer.alloc(800 * 600 * 3), 800, 600, 3, "RGB"),
					timing: {},
				};
			}
			return {
				image: rawImage(
					Buffer.alloc(img.width * img.height),
					img.width,
					img.height,
					1,
					"GRAY",
				),
				timing: {},
			};
		},
		resize: async (img, _mode, w, _hm, h, fmt) => ({
			image:
				fmt === "jpg"
					? Buffer.from(`${img.width}x${img.height}`)
					: rawImage(Buffer.alloc(w * h * 3), w, h, 3, "RGB"),
			timing: {},
		}),
		filter: async (img, _type, _ks, _intensity, _fmt) => ({
			image: rawImage(Buffer.from(mask), img.width, img.height, 1, "GRAY"),
			timing: {},
		}),
		crop: async (_img, _x, _y, w, h, _normalized, _fmt) => ({
			image: rawImage(Buffer.alloc(w * h * 3), w, h, 3, "RGB"),
			timing: {},
		}),
		rotate: async (img, _angle, _pad, _fmt) => ({
			image: rawImage(
				Buffer.alloc(img.width * img.height * 3),
				img.width,
				img.height,
				3,
				"RGB",
			),
			timing: {},
		}),
	};
}

test("label-crop replaces msg.payload with the deskewed crop and attaches metadata", async () => {
	_setBridge(detectingEngine());
	try {
		const { run, sent, doneErrors } = makeNode({ maxEdge: 400 });
		const input = rawImage(Buffer.alloc(800 * 600 * 3), 800, 600, 3, "RGB");
		run({ payload: input });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(sent.length, 1);
		const msg = sent[0];
		assert.ok(msg.labelCrop, "msg.labelCrop attached");
		assert.strictEqual(msg.labelCrop.detected, true);
		// the final crop width: axis-aligned 160x120 rect at scale 2 -> 320
		assert.strictEqual(msg.payload.width, 320);
		assert.strictEqual(msg.payload.height, 240);
		assert.deepStrictEqual(doneErrors, []);
	} finally {
		_resetBridge();
	}
});

test("label-crop publishes side-by-side before and after previews when enabled", async () => {
	_setBridge(detectingEngine());
	try {
		const { run, sent, published, doneErrors } = makeNode({
			maxEdge: 400,
			previewEnabled: true,
			previewWidth: 180,
		});
		const input = rawImage(Buffer.alloc(800 * 600 * 3), 800, 600, 3, "RGB");
		run({ payload: input });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.strictEqual(sent.length, 1);
		assert.deepStrictEqual(doneErrors, []);
		assert.strictEqual(
			sent[0].payload.width,
			320,
			"preview does not replace output",
		);
		const event = published.find((item) => item.topic === "label-crop-preview");
		assert.ok(event, "preview event published");
		assert.strictEqual(event.data.id, "label-crop-test");
		assert.strictEqual(event.data.previewWidth, 180);
		assert.strictEqual(
			Buffer.from(event.data.before, "base64").toString(),
			"800x600",
		);
		assert.strictEqual(
			Buffer.from(event.data.after, "base64").toString(),
			"320x240",
		);
	} finally {
		_resetBridge();
	}
});

test("label-crop passes the original payload through on a detection miss", async () => {
	_setBridge({
		colorConvert: async (_img) => ({
			image: rawImage(Buffer.alloc(400 * 300), 400, 300, 1, "GRAY"),
			timing: {},
		}),
		resize: async (_img, _mode, w, _hm, h, _fmt) => ({
			image: rawImage(Buffer.alloc(w * h), w, h, 1, "GRAY"),
			timing: {},
		}),
		filter: async (img, _type, _ks, _intensity, _fmt) => ({
			image: rawImage(
				Buffer.alloc(img.width * img.height),
				img.width,
				img.height,
				1,
				"GRAY",
			),
			timing: {},
		}),
		crop: async () => {
			throw new Error("no crop on a miss");
		},
	});
	try {
		const { run, sent, doneErrors } = makeNode({ maxEdge: 400 });
		const input = Buffer.from("original-encoded-bytes");
		run({ payload: input });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(sent.length, 1);
		const msg = sent[0];
		assert.strictEqual(msg.payload, input, "original passed through");
		assert.strictEqual(msg.labelCrop.detected, false);
		assert.deepStrictEqual(doneErrors, []);
	} finally {
		_resetBridge();
	}
});

test("label-crop reports an unavailable engine as a setup error, not a miss", async () => {
	_setBridge(null);
	try {
		const { run, sent, doneErrors } = makeNode({});
		run({ payload: Buffer.from("x") });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(sent.length, 0, "nothing sent on a setup error");
		assert.strictEqual(doneErrors.length, 1);
		assert.match(doneErrors[0], /engine unavailable/);
	} finally {
		_resetBridge();
	}
});

test("label-crop accepts an encoded Buffer payload", async () => {
	_setBridge(detectingEngine());
	try {
		const { run, sent } = makeNode({ maxEdge: 400 });
		run({ payload: Buffer.from("jpeg-bytes") });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].labelCrop.detected, true);
	} finally {
		_resetBridge();
	}
});

test("label-crop applies same-named msg overrides", async () => {
	const engine = detectingEngine();
	const formats = [];
	const crop = engine.crop;
	engine.crop = async (...args) => {
		formats.push(args[6]);
		return crop(...args);
	};
	_setBridge(engine);
	try {
		const { run, sent } = makeNode({ maxEdge: 400, outputFormat: "raw" });
		run({ payload: Buffer.from("jpeg-bytes"), outputFormat: "jpg" });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(sent[0].labelCrop.detected, true);
		assert.strictEqual(formats.at(-1), "jpg");
	} finally {
		_resetBridge();
	}
});

test("label-crop invalid payload reports an error through done", async () => {
	_setBridge(detectingEngine());
	try {
		const { run, doneErrors } = makeNode({});
		run({ payload: 12345 });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(doneErrors.length, 1);
		assert.match(doneErrors[0], /input must be/);
	} finally {
		_resetBridge();
	}
});

// ---- upstream mode: a real line-finder's output, fed straight in ---------
//
// line-finder.js is loaded against the same fake RED, run over the tray
// fixture with four named regions, and the message it sends is what the
// label-crop node receives - no hand-built rect in between.

const TRAY_REGIONS = [
	{ name: "left", x: 56, y: 85, width: 50, height: 100, angleDeg: 7, scanDirection: "right", polarity: "darkToLight" },
	{ name: "right", x: 294, y: 115, width: 50, height: 100, angleDeg: 7, scanDirection: "left", polarity: "darkToLight" },
	{ name: "top", x: 160, y: 53, width: 100, height: 40, angleDeg: 7, scanDirection: "down", polarity: "darkToLight" },
	{ name: "bottom", x: 140, y: 207, width: 100, height: 40, angleDeg: 7, scanDirection: "up", polarity: "darkToLight" },
];
const trayFrame = () => labelOnTray(400, 300, { angleDeg: 7, channels: 1 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** The message a line-finder with the four tray regions sends for `frame`. */
function lineFinderOutput(frame) {
	const finder = loadNode(
		"line-finder.js",
		{ regions: TRAY_REGIONS, calipers: 8, contrastThreshold: 3 },
		{ id: "line-finder-upstream" },
	);
	return new Promise((resolve, reject) => {
		const sent = [];
		finder.listeners.input(
			{ payload: frame },
			(m) => sent.push(m),
			(err) => (err ? reject(err) : resolve(sent[0])),
		);
	});
}

test("label-crop in upstream mode crops the rectangle a line-finder found", async () => {
	_setBridge(pixelEngine());
	try {
		const measured = await lineFinderOutput(trayFrame());
		assert.strictEqual(measured.lineFinder.rect.ok, true, measured.lineFinder.rect.reason);

		const { run, sent, doneErrors, statuses } = makeNode({ boundaryMode: "upstream" });
		run(measured);
		await settle();
		assert.deepStrictEqual(doneErrors, []);
		assert.strictEqual(sent.length, 1);
		const msg = sent[0];
		assert.strictEqual(msg.labelCrop.detected, true, msg.labelCrop.reason);
		assert.strictEqual(msg.labelCrop.reason, "upstream-rect");
		// the tray label is 240x156, tilted 7 degrees
		assert.ok(Math.abs(msg.payload.width - 240) <= 2, `width ${msg.payload.width}`);
		assert.ok(Math.abs(msg.payload.height - 156) <= 2, `height ${msg.payload.height}`);
		assert.ok(Math.abs(msg.labelCrop.angleDeg - 7) < 0.5, `angle ${msg.labelCrop.angleDeg}`);
		assert.strictEqual(msg.labelCrop.crop.rotated, true);
		assert.strictEqual(
			msg.labelCrop.confidence,
			Math.round(measured.lineFinder.rect.score * 1000) / 1000,
			"the line-finder's score is the confidence",
		);
		assert.strictEqual(msg.labelCrop.polarity, null);
		// the status prints the metadata width and height, to a tenth of a pixel
		assert.match(statuses.at(-1).text, /^deskewed 2(39|40|41)(\.\d)?×15[5-7](\.\d)?$/);
		// the line-finder's own result stays on the message for a debug node
		assert.strictEqual(msg.lineFinder.lines.length, 4);
	} finally {
		_resetBridge();
	}
});

test("msg.rect overrides msg.lineFinder.rect in upstream mode", async () => {
	_setBridge(pixelEngine());
	try {
		const measured = await lineFinderOutput(trayFrame());
		const { run, sent, statuses, doneErrors } = makeNode({ boundaryMode: "upstream" });

		// an explicit, different rectangle wins over the line-finder's
		run({
			...measured,
			payload: trayFrame(),
			rect: { ok: true, reason: "ok", center: { x: 200, y: 150 }, width: 100, height: 50, angleDeg: 0 },
		});
		await settle();
		assert.strictEqual(sent[0].labelCrop.detected, true, sent[0].labelCrop.reason);
		assert.strictEqual(sent[0].payload.width, 100);
		assert.strictEqual(sent[0].payload.height, 50);
		assert.strictEqual(sent[0].labelCrop.confidence, 1, "no score on a hand-built rect");
		assert.strictEqual(sent[0].labelCrop.crop.rotated, false);

		// and so does an explicit miss, though the line-finder found the label
		const frame = trayFrame();
		run({ ...measured, payload: frame, rect: { ok: false, reason: "missing-edge:top", missing: ["top"] } });
		await settle();
		assert.strictEqual(sent[1].labelCrop.detected, false);
		assert.strictEqual(sent[1].labelCrop.reason, "upstream-rect:missing-edge:top");
		assert.strictEqual(sent[1].payload, frame, "the frame passes through");
		assert.strictEqual(statuses.at(-1).text, "not detected (upstream-rect:missing-edge:top)");
		assert.deepStrictEqual(doneErrors, []);
	} finally {
		_resetBridge();
	}
});

test("upstream mode with nothing in front is a no-upstream-rect miss, and only upstream mode reads msg.rect", async () => {
	_setBridge(pixelEngine());
	try {
		// configured blob, switched to upstream for this message
		const { run, sent, statuses, doneErrors } = makeNode({ boundaryMode: "blob" });
		const frame = trayFrame();
		run({ payload: frame, boundaryMode: "upstream" });
		await settle();
		assert.strictEqual(sent[0].labelCrop.detected, false);
		assert.strictEqual(sent[0].labelCrop.reason, "no-upstream-rect");
		assert.strictEqual(sent[0].payload, frame);
		assert.strictEqual(statuses.at(-1).text, "not detected (no-upstream-rect)");

		// in blob mode a msg.rect is not consulted: the pixel fake's Otsu is a
		// pass-through, so the blob search finds nothing and says so
		run({
			payload: trayFrame(),
			rect: { ok: true, center: { x: 200, y: 150 }, width: 100, height: 50, angleDeg: 0 },
		});
		await settle();
		assert.strictEqual(sent[1].labelCrop.detected, false);
		assert.notStrictEqual(sent[1].labelCrop.reason, "upstream-rect");
		assert.notStrictEqual(sent[1].labelCrop.reason, "no-upstream-rect");
		assert.deepStrictEqual(doneErrors, []);
	} finally {
		_resetBridge();
	}
});
