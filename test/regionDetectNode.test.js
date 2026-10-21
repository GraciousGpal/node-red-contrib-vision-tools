/**
 * Node-RED glue tests for the region-detect node (region-detect.js):
 * lib/regionDetect.js run on a synthetic label rendered in memory, the
 * msg.detect overrides, the single failure path, msg.timings, the
 * last-frame and last-regions endpoints and the package registration.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");

// count model reads: lib/regionDetect.js takes recognise from lib/ocr.js
// when it is first required, so the wrapper must be in place before that
const ocr = require("../lib/ocr.js");
let reads = 0;
const realRecognise = ocr.recognise;
ocr.recognise = (...a) => {
	reads++;
	return realRecognise(...a);
};

// the options each call reaches the library with; region-detect.js takes
// detectRegions when it is first required, so wrap it before that too
const lib = require("../lib/regionDetect.js");
const realDetect = lib.detectRegions;
let lastOpts = null;
lib.detectRegions = (raw, opts) => {
	lastOpts = opts;
	return realDetect(raw, opts);
};

const ID = "region-detect-test";
const W = 1500;
const H = 600;
const FONT = 'font-family="DejaVu Sans, Arial, sans-serif"';

// the recipe of test/regionDetect.test.js: an upright block, a block
// running top to bottom and 60 stripes that do not decode
const blockB =
	`<text x="60" y="80" ${FONT} font-size="28" fill="black">LOT 48213 BATCH A7 LINE</text>` +
	`<text x="60" y="118" ${FONT} font-size="28" fill="black">EXP 2027 11 30 REF 96</text>`;
const blockA = ["SERIAL 55102 BOX", "PACKED 04 OCT 26", "MADE IN IRELAND"]
	.map((t, i) => `<g transform="translate(${1360 + 38 * i},200) rotate(90)"><text x="0" y="0" ${FONT} font-size="28" fill="black">${t}</text></g>`)
	.join("");
function stripes() {
	let x = 700;
	let out = "";
	for (let i = 0; i < 60; i++) {
		const w = 2 + ((i * 7 + 3) % 4);
		if (i % 2 === 0) out += `<rect x="${x}" y="150" width="${w}" height="200" fill="black"/>`;
		x += w;
	}
	return out;
}

// a circle with a triangle over it, clear of the text and the stripes
const logo = `<circle cx="1000" cy="480" r="60" fill="black"/><polygon points="1050,420 1050,540 1170,480" fill="black"/>`;

async function render(body, w = W, h = H) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}
let labelCache = null;
const label = () => (labelCache = labelCache || render(blockB + blockA + stripes()));
let logoCache = null;
const logoLabel = () => (logoCache = logoCache || render(blockB + blockA + stripes() + logo));
const encode = (f, fmt) => sharp(f.data, { raw: { width: f.width, height: f.height, channels: f.channels } })[fmt]().toBuffer();

function makeNode(config = {}) {
	const node = loadNode("region-detect.js", config, { id: ID });
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
				(m) => sent.push({ ...m, timings: m.timings && { ...m.timings } }),
				(err) => {
					if (err) doneErrors.push(err.message ? String(err.message) : String(err));
					resolve();
				},
			);
		});
	return { node, run, sent, statuses, doneErrors, errors };
}

const kinds = (regions, kind) => regions.filter((r) => r.kind === kind);

// first, so nothing has loaded the model yet
test("msg.detect {orientation: 270}: every text block rotate 270, score 1, the model never read", async () => {
	const h = makeNode();
	await h.run({ payload: await label(), detect: { orientation: 270 } });
	assert.deepEqual(h.doneErrors, []);
	const text = kinds(h.sent[0].regions, "text");
	assert.equal(text.length, 2, JSON.stringify(text));
	assert.ok(text.every((r) => r.rotate === 270 && r.score === 1), JSON.stringify(text));
	assert.equal(reads, 0, "no line was read");
	assert.ok(!Object.keys(require.cache).some((k) => k.includes("onnxruntime-web")), "the model runtime is not loaded");
});

test("two text blocks and a stripe barcode: regions, kinds, counts, payload through, green status", async () => {
	const h = makeNode();
	const payload = await label();
	await h.run({ payload, topic: "golden" });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(h.errors, []);
	assert.equal(h.sent.length, 1);
	const m = h.sent[0];
	assert.equal(m.payload, payload, "the same object");
	assert.equal(m.topic, "golden");
	const text = kinds(m.regions, "text");
	const bars = kinds(m.regions, "barcode");
	assert.equal(text.length, 2, JSON.stringify(m.regions));
	assert.equal(bars.length, 1, JSON.stringify(m.regions));
	assert.equal(kinds(m.regions, "graphic").length, 0, JSON.stringify(m.regions));
	assert.deepEqual(text.map((r) => r.rotate).sort(), [0, 270]);
	assert.ok(reads > 0, "orientation auto reads lines: the read counter sees them");
	assert.ok(bars[0].x <= 700 && bars[0].x + bars[0].width >= 840 && bars[0].y <= 150, JSON.stringify(bars[0]));
	for (const r of m.regions) {
		assert.deepEqual(Object.keys(r), ["name", "label", "kind", "x", "y", "width", "height", "rotate", "score"]);
	}
	assert.deepEqual(m.detect.counts, { text: 2, barcode: 1, graphic: 0 });
	assert.equal(m.detect.frameWidth, W);
	assert.equal(m.detect.frameHeight, H);
	assert.ok(m.detect.charHeight > 10 && m.detect.charHeight < 30, String(m.detect.charHeight));
	assert.equal(h.statuses[0].fill, "blue");
	const last = h.statuses[h.statuses.length - 1];
	assert.equal(last.fill, "green");
	assert.match(last.text, /^2 text · 1 barcode · 0 graphic · \d+(ms|\.\d\ds)$/);
});

test("an encoded frame and config options work the same; msg.detect {barcodes:false} drops the barcode", async () => {
	const f = await label();
	const png = await sharp(f.data, { raw: { width: f.width, height: f.height, channels: f.channels } }).png().toBuffer();
	const h = makeNode({ orientation: "0", minTextHeight: "8", minScore: "0.7", graphics: true, barcodes: true, pad: "4" });
	await h.run({ payload: png });
	assert.deepEqual(h.doneErrors, []);
	assert.equal(h.sent[0].payload, png);
	assert.equal(kinds(h.sent[0].regions, "barcode").length, 1);
	assert.ok(kinds(h.sent[0].regions, "text").every((r) => r.rotate === 0));
	await h.run({ payload: png, detect: { barcodes: false } });
	assert.deepEqual(h.doneErrors, []);
	assert.equal(kinds(h.sent[1].regions, "barcode").length, 0, JSON.stringify(h.sent[1].regions));
	assert.equal(h.sent[1].detect.counts.barcode, 0);
	// the override is for that message only
	await h.run({ payload: png });
	assert.equal(kinds(h.sent[2].regions, "barcode").length, 1);
});

test("a logo is a graphic; msg.detect {graphics:false} leaves it out, the barcode stays", async () => {
	const h = makeNode({ orientation: "0" });
	await h.run({ payload: await logoLabel() });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(h.sent[0].detect.counts, { text: 2, barcode: 1, graphic: 1 }, JSON.stringify(h.sent[0].regions));
	await h.run({ payload: await logoLabel(), detect: { graphics: false } });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(h.sent[1].detect.counts, { text: 2, barcode: 1, graphic: 0 }, JSON.stringify(h.sent[1].regions));
});

test("config values that are not the defaults reach the library; msg.detect wins per key", async () => {
	const h = makeNode({ orientation: "90", minTextHeight: "12", minScore: "0.5", graphics: "false", barcodes: false, pad: "2" });
	await h.run({ payload: await label() });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(lastOpts, { orientation: 90, minTextHeight: 12, minScore: 0.5, graphics: false, barcodes: false, pad: 2 });
	assert.equal(kinds(h.sent[0].regions, "barcode").length, 0);
	await h.run({ payload: await label(), detect: { pad: 6, graphics: "true", orientation: 180 } });
	assert.deepEqual(h.doneErrors, []);
	assert.deepEqual(lastOpts, { orientation: 180, minTextHeight: 12, minScore: 0.5, graphics: true, barcodes: false, pad: 6 });
});

test("msg.detect graphics and barcodes take true/false or \"true\"/\"false\" only, else fail naming the key", async () => {
	for (const [detect, key] of [[{ graphics: "maybe" }, "graphics"], [{ barcodes: 1 }, "barcodes"]]) {
		const h = makeNode();
		await h.run({ payload: await label(), detect });
		assert.equal(h.doneErrors.length, 1, JSON.stringify(detect));
		assert.match(h.doneErrors[0], new RegExp(`msg\.detect\.${key}`));
		assert.equal(h.sent.length, 0);
		assert.equal(h.statuses[h.statuses.length - 1].fill, "red");
	}
});

test("a boolean payload: done(err) only, nothing sent, red ring with the message", async () => {
	const h = makeNode();
	await h.run({ payload: true });
	assert.deepEqual(h.doneErrors, ["unsupported msg.payload type: boolean"]);
	assert.deepEqual(h.errors, []);
	assert.equal(h.sent.length, 0);
	const last = h.statuses[h.statuses.length - 1];
	assert.equal(last.fill, "red");
	assert.equal(last.shape, "ring");
	assert.match(last.text, /unsupported msg\.payload type: boolean/);
});

test("a bad msg.detect value fails the message, naming it", async () => {
	const h = makeNode();
	await h.run({ payload: await label(), detect: { orientation: 45 } });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /orientation 45/);
	assert.equal(h.sent.length, 0);
});

test("a path in an error stays out of the status", async () => {
	const h = makeNode();
	await h.run({ payload: "C:/x/y/customer-part-9.png" });
	assert.equal(h.doneErrors.length, 1);
	assert.ok(h.doneErrors[0].includes("customer-part-9"));
	const last = h.statuses[h.statuses.length - 1];
	assert.equal(last.fill, "red");
	assert.doesNotMatch(last.text, /customer|[/\\]/);
	assert.ok(last.text.length <= 60);
});

test("msg.timings: inputMs, the library's parts, totalMs, one decimal", async () => {
	const h = makeNode({ orientation: "0" });
	// encoded, so inputMs is a decode of a few ms
	await h.run({ payload: await encode(await label(), "png") });
	assert.deepEqual(h.doneErrors, []);
	const t = h.sent[0].timings;
	assert.deepEqual(Object.keys(t), ["inputMs", "thresholdMs", "componentsMs", "barcodeMs", "textMs", "orientMs", "graphicsMs", "totalMs"]);
	for (const v of Object.values(t)) {
		assert.equal(typeof v, "number");
		assert.equal(v, Math.round(v * 10) / 10);
	}
	assert.ok(t.totalMs >= t.inputMs, JSON.stringify(t));
	assert.ok(t.inputMs > 0, JSON.stringify(t));
	// totalMs as sent covers the input and every library part
	const parts = t.inputMs + t.thresholdMs + t.componentsMs + t.barcodeMs + t.textMs + t.orientMs + t.graphicsMs;
	assert.ok(t.totalMs >= parts - 0.5, JSON.stringify(t));
});

// ---- endpoints ------------------------------------------------------------

function get(node, route, id = ID) {
	const handlers = node.adminRoutes[route];
	assert.ok(handlers, `${route} is registered on httpAdmin`);
	assert.equal(handlers.length, 2, "needsPermission's guard first, the handler last");
	assert.equal(handlers[0].permission, "region-detect.read");
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
const lastFrame = (node) => get(node, "/region-detect/last-frame/:id");
const lastRegions = (node) => get(node, "/region-detect/last-regions/:id");

test("last-frame and last-regions: 404 before input, served after, kept on redeploy, gone on removal", async () => {
	const h = makeNode({ orientation: "0" });
	assert.equal((await lastFrame(h.node)).status, 404);
	assert.equal((await lastRegions(h.node)).status, 404);

	const f = await label();
	const t0 = Date.now();
	await h.run({ payload: f });
	assert.deepEqual(h.doneErrors, []);
	const frame = await lastFrame(h.node);
	assert.equal(frame.status, 200);
	assert.equal(frame.headers["content-type"], "image/png");
	assert.equal(frame.headers["cache-control"], "no-store");
	assert.equal(frame.headers["x-frame-width"], String(W));
	assert.equal(frame.headers["x-frame-height"], String(H));
	const received = Date.parse(frame.headers["x-frame-received"]);
	assert.ok(received >= t0 && received <= Date.now());
	const back = await sharp(frame.body).raw().toBuffer({ resolveWithObject: true });
	assert.deepEqual([back.info.width, back.info.height], [W, H]);

	const regions = await lastRegions(h.node);
	assert.equal(regions.status, 200);
	assert.equal(regions.headers["cache-control"], "no-store");
	assert.deepEqual(regions.body.regions, h.sent[0].regions);
	assert.deepEqual(regions.body.detect, h.sent[0].detect);
	assert.ok(Date.parse(regions.body.received) >= t0);

	// what the endpoint serves is a copy: downstream changes do not reach it
	const x0 = h.sent[0].regions[0].x;
	h.sent[0].regions[0].x = -999;
	h.sent[0].regions.push({ name: "extra" });
	h.sent[0].detect.counts.text = 99;
	const again = (await lastRegions(h.node)).body;
	assert.equal(again.regions[0].x, x0);
	assert.equal(again.regions.length, h.sent[0].regions.length - 1);
	assert.equal(again.detect.counts.text, 2);

	await new Promise((resolve) => h.node.listeners.close(false, resolve));
	assert.equal((await lastFrame(h.node)).status, 200);
	assert.equal((await lastRegions(h.node)).status, 200);
	await new Promise((resolve) => h.node.listeners.close(true, resolve));
	assert.equal((await lastFrame(h.node)).status, 404);
	assert.equal((await lastRegions(h.node)).status, 404);
});

test("a failed message leaves the last frame and the last regions of the last good one", async () => {
	const h = makeNode({ orientation: "0" });
	await h.run({ payload: await label() });
	assert.deepEqual(h.doneErrors, []);
	await h.run({ payload: await render(blockB, 600, 200), detect: { minTextHeight: -1 } });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /minTextHeight -1/);
	const frame = await lastFrame(h.node);
	assert.equal(frame.status, 200);
	assert.equal(frame.headers["x-frame-width"], String(W));
	const regions = await lastRegions(h.node);
	assert.equal(regions.status, 200);
	assert.equal(regions.body.detect.frameWidth, W);
	assert.deepEqual(regions.body.regions, h.sent[0].regions);
});

test("last-frame serves a JPEG payload as it came", async () => {
	const h = makeNode({ orientation: "0" });
	const jpeg = await encode(await label(), "jpeg");
	await h.run({ payload: jpeg });
	assert.deepEqual(h.doneErrors, []);
	const res = await lastFrame(h.node);
	assert.equal(res.status, 200);
	assert.equal(res.headers["content-type"], "image/jpeg");
	assert.ok(res.body.equals(jpeg), "the same bytes");
	// a copy: painting the payload downstream does not reach the cache
	jpeg.fill(0);
	assert.equal((await lastFrame(h.node)).headers["content-type"], "image/jpeg");
});

test("last-frame keeps a copy of a raw frame: a downstream node painting msg.payload does not change it", async () => {
	const h = makeNode({ orientation: "0" });
	const f = await label();
	const payload = { data: Buffer.from(f.data), width: f.width, height: f.height, channels: f.channels };
	await h.run({ payload });
	assert.deepEqual(h.doneErrors, []);
	h.sent[0].payload.data.fill(255);
	const res = await lastFrame(h.node);
	assert.equal(res.status, 200);
	const back = await sharp(res.body).raw().toBuffer({ resolveWithObject: true });
	assert.deepEqual([back.info.width, back.info.height, back.info.channels], [f.width, f.height, f.channels]);
	assert.ok(back.data.equals(f.data), "the frame as it came, not as painted");
});

test("package.json registers region-detect", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.equal(pkg["node-red"].nodes["region-detect"], "region-detect.js");
});

// 256M pixels of white in ~280KB: refused by the 64M pixel cap, not decoded
const bombPng = () =>
	sharp({ create: { width: 16000, height: 16000, channels: 3, background: "#fff" } }).toColourspace("b-w").png().toBuffer();

test("a 16000x16000 PNG is refused by the pixel cap through done(err) only", async () => {
	const h = makeNode();
	await h.run({ payload: await bombPng() });
	assert.equal(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /msg\.payload: 16000x16000 is above the 64M pixel cap/);
	assert.equal(h.sent.length, 0);
	assert.deepEqual(h.errors, []);
});
