/**
 * Node-RED glue tests for the text-inspect node (text-inspect.js): regions
 * read through lib/ocr.js on frames rendered in memory, msg.regions
 * overrides, scaling from the drawing-time frame size, the single failure
 * path, msg.timings, the last-frame endpoint and the package registration.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");

const ID = "text-inspect-test";
const LEFT = { name: "left", x: 0, y: 0, width: 240, height: 80 };
const RIGHT = { name: "right", x: 300, y: 0, width: 200, height: 80 };

function makeNode(config = {}) {
	const node = loadNode("text-inspect.js", config, { id: ID });
	const sent = [];
	const statuses = [];
	const doneErrors = [];
	const errors = [];
	node.status = (s) => statuses.push(s);
	node.error = (e) => errors.push(e);
	const run = (msg) =>
		new Promise((resolve) => {
			node.listeners.input(
				msg,
				// msg.timings as it was at send time: a field set after send fails
				(m) => sent.push({ ...m, timings: m.timings && { ...m.timings } }),
				(err) => {
					if (err) doneErrors.push(err.message ? String(err.message) : String(err));
					resolve();
				},
			);
		});
	return { node, run, sent, statuses, doneErrors, errors };
}

// 500x80 white, "TX4829" on the left, "KM73" on the right, black, 40 px
let frameCache = null;
async function frame() {
	if (!frameCache) {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="80">
			<rect width="500" height="80" fill="white"/>
			<text x="20" y="58" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="black">TX4829</text>
			<text x="330" y="58" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="black">KM73</text>
		</svg>`;
		const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		frameCache = { data, width: info.width, height: info.height, channels: info.channels };
	}
	return frameCache;
}

test("two config regions read in order, the payload passes through untouched", async () => {
	const h = makeNode({ regions: [LEFT, RIGHT] });
	const payload = await frame();
	await h.run({ payload, topic: "t1" });
	assert.deepEqual(h.doneErrors, []);
	assert.equal(h.sent.length, 1);
	const m = h.sent[0];
	assert.equal(m.payload, payload, "the same object");
	assert.deepEqual(h.errors, []);
	assert.equal(m.payload.data, payload.data, "the same buffer");
	assert.equal(m.topic, "t1");
	assert.deepEqual(m.ocr.map((o) => o.name), ["left", "right"]);
	assert.deepEqual(m.ocr.map((o) => o.text), ["TX4829", "KM73"]);
	assert.deepEqual(m.ocr.map((o) => o.confidences.length), [6, 4]);
	assert.deepEqual(m.ocr[0].roi, { x: 0, y: 0, width: 240, height: 80 });
	for (const c of m.ocr.flatMap((o) => o.confidences)) {
		assert.ok(c >= 0 && c <= 1);
		assert.equal(c, Math.round(c * 1000) / 1000);
	}
	const last = h.statuses[h.statuses.length - 1];
	assert.equal(last.fill, "green");
	assert.match(last.text, /^2 regions · \d+(ms|\.\d\ds)$/);
});

test("an encoded frame reads the same", async () => {
	const h = makeNode({ regions: [LEFT, RIGHT] });
	const f = await frame();
	const png = await sharp(f.data, { raw: { width: f.width, height: f.height, channels: f.channels } }).png().toBuffer();
	await h.run({ payload: png });
	assert.deepEqual(h.doneErrors, []);
	assert.equal(h.sent[0].payload, png);
	assert.deepEqual(h.sent[0].ocr.map((o) => o.text), ["TX4829", "KM73"]);
});

test("msg.regions, as an array or a JSON string, replaces the config regions", async () => {
	for (const regions of [[LEFT], JSON.stringify([LEFT])]) {
		const h = makeNode({ regions: [RIGHT] });
		await h.run({ payload: await frame() });
		assert.equal(h.sent[0].ocr[0].text, "KM73", "config alone reads the right");
		await h.run({ payload: await frame(), regions });
		assert.deepEqual(h.doneErrors, []);
		assert.deepEqual(h.sent[1].ocr.map((o) => [o.name, o.text]), [["left", "TX4829"]], typeof regions);
	}
});

test("regions drawn on a 250x40 frame are scaled to a 500x80 one", async () => {
	const h = makeNode({ frameWidth: 250, frameHeight: 40, regions: [{ name: "id", x: 5, y: 5, width: 120, height: 30 }] });
	await h.run({ payload: await frame() });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(h.sent[0].ocr[0].roi, { x: 10, y: 10, width: 240, height: 60 });
	assert.equal(h.sent[0].ocr[0].text, "TX4829");
});

test("msg.regions are in the incoming frame's pixels: not scaled", async () => {
	const h = makeNode({ frameWidth: 250, frameHeight: 40, regions: [RIGHT] });
	await h.run({ payload: await frame(), regions: [{ name: "id", x: 10, y: 5, width: 240, height: 60 }] });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(h.sent[0].ocr[0].roi, { x: 10, y: 5, width: 240, height: 60 });
	assert.equal(h.sent[0].ocr[0].text, "TX4829");
});

test("a region outside the frame fails through done(err) only, naming it", async () => {
	const h = makeNode({ regions: [LEFT, { name: "offEdge", x: 600, y: 0, width: 50, height: 40 }] });
	await h.run({ payload: await frame() });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /offEdge/);
	assert.deepEqual(h.errors, []);
	assert.equal(h.sent.length, 0);
	assert.equal(h.statuses[h.statuses.length - 1].fill, "red");
});

test("no regions, or no image, fails through done(err)", async () => {
	const none = makeNode({});
	await none.run({ payload: await frame() });
	assert.equal(none.doneErrors.length, 1);
	assert.match(none.doneErrors[0], /region/);
	const bad = makeNode({ regions: [LEFT] });
	await bad.run({ payload: 42 });
	assert.deepEqual(bad.doneErrors, ["unsupported msg.payload type: number"]);
	assert.deepEqual([...none.errors, ...bad.errors], [], "node.error is not called");
	assert.equal(none.sent.length + bad.sent.length, 0);
});

test("configured regions left as an empty string are no regions, not bad JSON", async () => {
	for (const regions of ["", "  "]) {
		const h = makeNode({ regions });
		await h.run({ payload: await frame() });
		assert.deepEqual(h.doneErrors, ["text-inspect: no regions to read"], JSON.stringify(regions));
		assert.equal(h.sent.length, 0);
	}
});

test("msg.regions that is not valid JSON fails, saying so, rather than falling back", async () => {
	const h = makeNode({ regions: [LEFT] });
	await h.run({ payload: await frame(), regions: "{bad" });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /msg\.regions/);
	assert.match(h.doneErrors[0], /JSON/);
	assert.deepEqual(h.errors, []);
	assert.equal(h.sent.length, 0);
});

test("a region with a non-numeric coordinate fails, naming the region and the field", async () => {
	const h = makeNode({ regions: [LEFT, { name: "junk", x: "abc", y: 0, width: 100, height: 40 }] });
	await h.run({ payload: await frame() });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /"junk"/);
	assert.match(h.doneErrors[0], /\bx\b/);
	assert.equal(h.sent.length, 0);
});

test("a region partly outside the frame is clamped to it and read", async () => {
	const h = makeNode({ regions: [{ name: "wide", x: 300, y: -10, width: 400, height: 200 }] });
	await h.run({ payload: await frame() });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(h.sent[0].ocr[0].roi, { x: 300, y: 0, width: 200, height: 80 });
	assert.equal(h.sent[0].ocr[0].text, "KM73");
});

test("a scaled region left empty is reported in the frame's pixels", async () => {
	const h = makeNode({ frameWidth: 250, frameHeight: 40, regions: [{ name: "off", x: 260, y: 5, width: 20, height: 10 }] });
	await h.run({ payload: await frame() });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /"off" \(x 520, y 10, width 40, height 20\)/);
	assert.match(h.doneErrors[0], /500x80/);
});

test("a model that fails to load at deploy is warned, with a red status", async () => {
	const ocr = require("../lib/ocr.js");
	const real = ocr.loadModel;
	ocr.loadModel = () => Promise.reject(new Error("model file unreadable"));
	let node;
	try {
		node = loadNode("text-inspect.js", { regions: [LEFT] }, { id: "text-inspect-warn" });
	} finally {
		ocr.loadModel = real;
	}
	const warned = [];
	const statuses = [];
	node.warn = (m) => warned.push(String(m));
	node.status = (s) => statuses.push(s);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(warned.length, 1);
	assert.match(warned[0], /model file unreadable/);
	assert.equal(statuses[statuses.length - 1].fill, "red");
});

test("msg.timings is inputMs, cropMs, inferMs, totalMs at one decimal", async () => {
	const h = makeNode({ regions: [LEFT, RIGHT] });
	await h.run({ payload: await frame() });
	const t = h.sent[0].timings;
	assert.deepEqual(Object.keys(t), ["inputMs", "cropMs", "inferMs", "totalMs"]);
	for (const v of Object.values(t)) {
		assert.equal(typeof v, "number");
		assert.equal(v, Math.round(v * 10) / 10);
	}
	assert.ok(t.totalMs >= t.inferMs, JSON.stringify(t));
	// a model run costs several times a crop: catches the two swapped
	assert.ok(t.inferMs > 0 && t.inferMs > t.cropMs, JSON.stringify(t));
});

// ---- last frame -----------------------------------------------------------

function lastFrame(node, id = ID) {
	const handlers = node.adminRoutes["/text-inspect/last-frame/:id"];
	assert.ok(handlers, "last-frame is registered on httpAdmin");
	assert.equal(handlers.length, 2, "needsPermission's guard first, the handler last");
	assert.equal(handlers[0].permission, "text-inspect.read");
	return new Promise((resolve) => {
		const out = { status: 200, headers: {}, body: undefined };
		const res = {
			setHeader(name, value) {
				out.headers[name.toLowerCase()] = value;
			},
			status(code) {
				out.status = code;
				return this;
			},
			json(payload) {
				out.body = payload;
				resolve(out);
			},
			end(bytes) {
				out.body = bytes;
				resolve(out);
			},
		};
		handlers[1]({ params: { id } }, res);
	});
}

test("last-frame: 404 before input, the frame after, kept on redeploy, gone on removal", async () => {
	const h = makeNode({ regions: [LEFT] });
	assert.equal((await lastFrame(h.node)).status, 404);

	const f = await frame();
	const png = await sharp(f.data, { raw: { width: f.width, height: f.height, channels: f.channels } }).png().toBuffer();
	const t0 = Date.now();
	await h.run({ payload: png });
	const res = await lastFrame(h.node);
	assert.equal(res.status, 200);
	assert.equal(res.body, png, "the bytes as they came");
	assert.equal(res.headers["content-type"], "image/png");
	assert.equal(res.headers["cache-control"], "no-store");
	assert.equal(res.headers["x-frame-width"], "500");
	assert.equal(res.headers["x-frame-height"], "80");
	const received = Date.parse(res.headers["x-frame-received"]);
	assert.ok(received >= t0 && received <= Date.now());

	// a raw frame is served as a PNG of its pixels
	await h.run({ payload: f });
	const asPng = await lastFrame(h.node);
	assert.equal(asPng.headers["content-type"], "image/png");
	const back = await sharp(asPng.body).raw().toBuffer({ resolveWithObject: true });
	assert.deepEqual([back.info.width, back.info.height], [500, 80]);
	assert.ok(back.data.equals(f.data));

	// a redeploy closes with removed=false and keeps the frame for the editor
	await new Promise((resolve) => h.node.listeners.close(false, resolve));
	assert.equal((await lastFrame(h.node)).status, 200);
	await new Promise((resolve) => h.node.listeners.close(true, resolve));
	assert.equal((await lastFrame(h.node)).status, 404);
});

test("package.json registers text-inspect", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.equal(pkg["node-red"].nodes["text-inspect"], "text-inspect.js");
});
