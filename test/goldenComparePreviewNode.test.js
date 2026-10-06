/**
 * The golden-compare runtime's side of the preview: with previewEnabled
 * the node keeps every stage of its last inspection, serves them over two
 * admin routes, and publishes a thumbnail over RED.comms - without
 * putting stages or heat maps on the message unless they were asked
 * for. Without it, none of that happens and the routes answer 404.
 */

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");

const BAR_Y = [0.1, 0.155, 0.19, 0.26, 0.3, 0.375, 0.41, 0.47, 0.545, 0.6, 0.68, 0.74];

function labelSvg(width, height) {
	const bars = [];
	for (let i = 0; i < BAR_Y.length; i++) {
		const y = Math.round(height * BAR_Y[i]);
		const w = Math.round(width * (i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.44 : 0.31));
		const x = Math.round(width * 0.14);
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

let golden;
test.before(async () => {
	golden = await sharp(labelSvg(450, 650)).png().toBuffer();
});

function makeNode(config = {}, id = "gc-preview-test") {
	const published = [];
	const node = loadNode(
		"golden-compare.js",
		{ workers: 1, workingSize: 512, ...config },
		{
			id,
			comms: {
				publish(topic, data) {
					published.push({ topic, data });
				},
			},
		},
	);
	const sent = [];
	const warns = [];
	node.send = (m) => sent.push(m);
	node.warn = (m) => warns.push(String(m));
	node.status = () => {};
	const doneErrors = [];
	const run = (msg) =>
		new Promise((resolve) => {
			node.listeners.input(msg, (m) => sent.push(m), (err) => {
				if (err) doneErrors.push(err.message ? String(err.message) : String(err));
				resolve();
			});
		});
	return { node, run, sent, warns, doneErrors, published };
}

function callRoute(node, path, req) {
	const handlers = node.adminRoutes[path];
	assert.ok(handlers, `${path} should be registered on httpAdmin`);
	assert.strictEqual(handlers.length, 2, "needsPermission's guard first, the handler last");
	const handler = handlers[handlers.length - 1];
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
		handler(req, res);
	});
}
const last = (h, id = "gc-preview-test", t) =>
	callRoute(h.node, "/golden-compare/last/:id", { params: { id }, query: t ? { t } : {} });
const stage = (h, key, id = "gc-preview-test", t) =>
	callRoute(h.node, "/golden-compare/last/:id/stage/:key", { params: { id, key }, query: t ? { t } : {} });
const hold = (h, receivedAt, id = "gc-preview-test") =>
	callRoute(h.node, "/golden-compare/last/:id/hold", { params: { id }, body: { receivedAt } });
const release = (h, id = "gc-preview-test") =>
	callRoute(h.node, "DELETE /golden-compare/last/:id/hold", { params: { id } });

const EXPECTED_ORDER = [
	"goldenGray",
	"goldenFg",
	"goldenFgDilatedBackground",
	"targetGray",
	"targetFg",
	"targetGrayAligned",
	"targetFgAligned",
	"targetFgDilatedPrint",
	"printDefect",
	"backgroundDefect",
	"printHeatmap",
	"backgroundHeatmap",
	"toneDeviation",
	"toneHeatmap",
	"speckHeatmap",
];

test("with the preview off nothing is kept, published or served", async () => {
	const h = makeNode({}, "gc-off");
	assert.strictEqual((await last(h, "gc-off")).status, 404);
	await h.run({ golden, payload: golden });
	assert.deepStrictEqual(h.doneErrors, []);
	assert.strictEqual(h.published.length, 0, "no thumbnail");
	const r = await last(h, "gc-off");
	assert.strictEqual(r.status, 404);
	assert.deepStrictEqual(r.body, { ok: false, error: "no frame yet" });
});

test("with the preview on: a thumbnail under the node, every stage served, the message untouched", async () => {
	const h = makeNode({ previewEnabled: true, previewWidth: 120, outputBackgroundHeatmap: false });
	await h.run({ golden, payload: golden, filename: "frame-1.png" });
	assert.deepStrictEqual(h.doneErrors, []);
	assert.deepStrictEqual(h.warns, []);
	assert.strictEqual(h.sent.length, 1);
	const msg = h.sent[0];
	assert.strictEqual(msg.payload, true);
	// only what the output boxes asked for rides the message
	assert.strictEqual(msg.stages, undefined, "stages were not asked for");
	assert.ok(Buffer.isBuffer(msg.printHeatmap), "the print heat map was asked for");
	assert.strictEqual(msg.backgroundHeatmap, undefined, "the background one was not");

	// the thumbnail
	assert.strictEqual(h.published.length, 1);
	const { topic, data } = h.published[0];
	assert.strictEqual(topic, "golden-compare-preview");
	assert.strictEqual(data.id, "gc-preview-test");
	assert.strictEqual(data.pass, true);
	assert.match(data.text, /^pass · align /);
	assert.strictEqual(data.previewWidth, 120);
	const thumb = await sharp(Buffer.from(data.image, "base64")).metadata();
	assert.strictEqual(thumb.format, "jpeg");
	assert.strictEqual(thumb.width, 120);
	assert.deepStrictEqual(data.stages, EXPECTED_ORDER, "in pipeline order, every heat map included");

	// the index route
	const meta = await last(h);
	assert.strictEqual(meta.status, 200);
	assert.strictEqual(meta.headers["cache-control"], "no-store");
	assert.strictEqual(meta.body.ok, true);
	assert.strictEqual(meta.body.filename, "frame-1.png");
	assert.strictEqual(meta.body.receivedAt, data.receivedAt);
	assert.deepStrictEqual(
		meta.body.stages.map((s) => s.key),
		EXPECTED_ORDER,
	);
	for (const s of meta.body.stages) {
		assert.ok(s.title && s.description && s.group, `${s.key} is explained`);
	}
	assert.strictEqual(meta.body.result.pass, true);
	assert.ok(typeof meta.body.timings.totalMs === "number");

	// each image, as the format the pipeline rendered it in
	const grey = await stage(h, "goldenGray");
	assert.strictEqual(grey.status, 200);
	assert.strictEqual(grey.headers["content-type"], "image/jpeg");
	assert.strictEqual(grey.headers["cache-control"], "no-store");
	assert.strictEqual((await sharp(grey.body).metadata()).format, "jpeg");
	const mask = await stage(h, "targetFgAligned");
	assert.strictEqual(mask.headers["content-type"], "image/png", "masks are never JPEG");
	const bg = await stage(h, "backgroundHeatmap");
	assert.strictEqual(bg.status, 200, "rendered for the viewer even with its output off");
	const missing = await stage(h, "nuisanceBaseline");
	assert.strictEqual(missing.status, 404, "no map loaded, no baseline stage");
	assert.deepStrictEqual(missing.body, { ok: false, error: "no such stage" });
	assert.strictEqual((await stage(h, "goldenGray", "nobody")).status, 404);
});

test("a raw image format is encoded on the way out, and the next frame replaces the last", async () => {
	const h = makeNode({ previewEnabled: true, heatmapFormat: "raw" });
	await h.run({ golden, payload: golden });
	assert.deepStrictEqual(h.doneErrors, []);
	const first = (await last(h)).body.receivedAt;
	const grey = await stage(h, "goldenGray");
	assert.strictEqual(grey.headers["content-type"], "image/png");
	const meta = await sharp(grey.body).metadata();
	assert.strictEqual(meta.format, "png");
	assert.ok(meta.width > 0);
	await new Promise((r) => setTimeout(r, 5));
	await h.run({ golden, payload: golden });
	assert.ok((await last(h)).body.receivedAt > first, "replaced by the newer frame");
	assert.strictEqual(h.published.length, 2);
});

test("switching the preview off per message clears the thumbnail once", async () => {
	const h = makeNode({ previewEnabled: true });
	await h.run({ golden, payload: golden });
	await h.run({ golden, payload: golden, previewEnabled: false });
	await h.run({ golden, payload: golden, previewEnabled: false });
	assert.deepStrictEqual(h.doneErrors, []);
	assert.deepStrictEqual(
		h.published.map((p) => (p.data.clear ? "clear" : "thumb")),
		["thumb", "clear"],
	);
});

test("a removed node's inspection goes with it", async () => {
	const h = makeNode({ previewEnabled: true }, "gc-removed");
	await h.run({ golden, payload: golden });
	assert.strictEqual((await last(h, "gc-removed")).status, 200);
	await new Promise((r) => h.node.listeners.close(true, r));
	assert.strictEqual((await last(h, "gc-removed")).status, 404);
});

test("a held inspection survives the next frame, by its time, until released", async () => {
	const h = makeNode({ previewEnabled: true }, "gc-hold");
	assert.strictEqual((await hold(h, 1, "gc-hold")).status, 404, "nothing to hold yet");
	await h.run({ golden, payload: golden, filename: "first.png" });
	const first = (await last(h, "gc-hold")).body;
	// a hold naming a frame that is not the current one is refused
	const stale = await hold(h, first.receivedAt - 1, "gc-hold");
	assert.strictEqual(stale.status, 409);
	assert.strictEqual(stale.body.receivedAt, first.receivedAt);
	const held = await hold(h, first.receivedAt, "gc-hold");
	assert.strictEqual(held.status, 200);
	assert.deepStrictEqual(held.body, { ok: true, receivedAt: first.receivedAt });
	const firstGrey = (await stage(h, "targetGray", "gc-hold")).body;

	await new Promise((r) => setTimeout(r, 5));
	await h.run({ golden, payload: golden, filename: "second.png" });
	const latest = (await last(h, "gc-hold")).body;
	assert.strictEqual(latest.filename, "second.png", "no time asked for: the latest");
	assert.strictEqual(latest.held, false);
	const byTime = (await last(h, "gc-hold", first.receivedAt)).body;
	assert.strictEqual(byTime.filename, "first.png", "the held frame, by its time");
	assert.strictEqual(byTime.held, true);
	const heldGrey = (await stage(h, "targetGray", "gc-hold", first.receivedAt)).body;
	assert.ok(heldGrey.equals(firstGrey), "the held frame's own image");
	assert.strictEqual((await stage(h, "targetGray", "gc-hold", 12345)).status, 200, "an unknown time serves the latest");

	assert.deepStrictEqual((await release(h, "gc-hold")).body, { ok: true });
	assert.strictEqual((await last(h, "gc-hold", first.receivedAt)).body.filename, "second.png", "released: the latest again");
	// the thumbnail kept following while the hold was on
	assert.strictEqual(h.published.length, 2);
});
