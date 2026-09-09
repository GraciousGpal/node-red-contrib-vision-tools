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
const { makeRectMask, rawImage } = require("./helpers/synthetic.js");

function makeNode(config = {}) {
	const published = [];
	const RED = {
		comms: {
			publish(topic, data) {
				published.push({ topic, data });
			},
		},
		nodes: {
			createNode(node, cfg) {
				node.id = "label-crop-test";
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
			registerType(_name, ctor) {
				RED.nodes.ctor = ctor;
			},
		},
	};
	require("../label-crop.js")(RED);
	const node = new RED.nodes.ctor(config);
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
