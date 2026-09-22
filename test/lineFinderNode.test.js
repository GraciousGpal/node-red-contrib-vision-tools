/**
 * Node-RED glue tests for the line-finder node (line-finder.js).
 *
 * Same harness shape as labelCropNode.test.js: the node is exercised
 * without Node-RED installed by invoking its registerType factory with a
 * fake RED and driving the 'input' listener directly.
 *
 * No engine fake is needed - lib/lineFinder.js is pure JS - so these
 * tests cover the glue only: payload shapes, msg overrides, the score
 * gate, status text, and the miss-is-not-an-error rule.
 */

const test = require("node:test");
const assert = require("node:assert");
const { loadNode } = require("./helpers/fakeRed.js");

function makeNode(config = {}) {
	const published = [];
	const node = loadNode("line-finder.js", config, {
		id: "line-finder-test",
		comms: {
			publish(topic, data) {
				published.push({ topic, data });
			},
		},
	});
	const sent = [];
	const statuses = [];
	const doneErrors = [];
	node.status = (s) => statuses.push(s);
	const run = (msg) =>
		new Promise((resolve) => {
			node.listeners.input(
				msg,
				(m) => sent.push(m),
				(err) => {
					if (err) doneErrors.push(err.message ? String(err.message) : String(err));
					resolve();
				},
			);
		});
	return { node, run, sent, statuses, doneErrors, published };
}

// A pale panel on a dark ground: a clean vertical edge at x = 99.5.
const W = 240;
const H = 200;
function grayFrame() {
	const g = new Uint8Array(W * H);
	g.fill(40);
	for (let y = 0; y < H; y++) {
		const row = y * W;
		for (let x = 100; x < W; x++) g[row + x] = 200;
	}
	return g;
}
function rawGray() {
	const g = grayFrame();
	return { data: Buffer.from(g.buffer, g.byteOffset, g.byteLength), width: W, height: H, channels: 1 };
}
/** The same frame as RGB, to prove the luma path agrees with the gray one. */
function rawRgb() {
	const g = grayFrame();
	const rgb = Buffer.alloc(W * H * 3);
	for (let i = 0; i < g.length; i++) {
		rgb[i * 3] = g[i];
		rgb[i * 3 + 1] = g[i];
		rgb[i * 3 + 2] = g[i];
	}
	return { data: rgb, width: W, height: H, channels: 3 };
}

const REGION = { regionX: 60, regionY: 20, regionWidth: 80, regionHeight: 160 };

test("finds the edge and reports it on msg.lineFinder", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right", polarity: "darkToLight", calipers: 8 });
	await h.run({ payload: rawGray() });
	assert.deepStrictEqual(h.doneErrors, []);
	assert.strictEqual(h.sent.length, 1);
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.found, true, r.reason);
	assert.ok(Math.abs(r.line.x - 99.5) < 1, `edge at ${r.line.x}`);
	assert.strictEqual(r.imageWidth, W);
	assert.ok(r.timings.totalMs >= 0);
	assert.strictEqual(h.statuses.at(-1).fill, "green");
});

test("the payload is passed through untouched - this is a measuring tool", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right", calipers: 8 });
	const payload = rawGray();
	await h.run({ payload });
	assert.strictEqual(h.sent[0].payload, payload);
});

test("a multi-channel raw payload is converted to luma, not rejected", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right", polarity: "darkToLight", calipers: 8 });
	await h.run({ payload: rawRgb() });
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.found, true, r.reason);
	assert.ok(Math.abs(r.line.x - 99.5) < 1, `edge at ${r.line.x}`);
});

test("a miss is a normal result, not an error", async () => {
	const h = makeNode({
		regionX: 10, regionY: 10, regionWidth: 60, regionHeight: 60,
		scanDirection: "right", contrastThreshold: 50, calipers: 8,
	});
	await h.run({ payload: rawGray() });
	assert.deepStrictEqual(h.doneErrors, [], "a miss must not reach done(err)");
	assert.strictEqual(h.sent[0].lineFinder.found, false);
	assert.strictEqual(h.sent[0].lineFinder.reason, "no-edge");
	assert.strictEqual(h.statuses.at(-1).fill, "yellow");
});

test("msg.region re-aims a configured node without copying it", async () => {
	const h = makeNode({
		regionX: 0, regionY: 0, regionWidth: 20, regionHeight: 20,
		scanDirection: "right", polarity: "darkToLight", calipers: 8,
	});
	await h.run({
		payload: rawGray(),
		region: { x: 60, y: 20, width: 80, height: 160 },
	});
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.found, true, r.reason);
	assert.ok(Math.abs(r.line.x - 99.5) < 1, `edge at ${r.line.x}`);
	assert.strictEqual(r.region.width, 80);
});

test("a per-message option overrides the configured one", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right", polarity: "lightToDark", calipers: 8 });
	// as configured the rising edge is the wrong polarity, so nothing is found
	await h.run({ payload: rawGray() });
	assert.strictEqual(h.sent[0].lineFinder.found, false);
	await h.run({ payload: rawGray(), polarity: "darkToLight" });
	assert.strictEqual(h.sent[1].lineFinder.found, true);
});

test("minScore turns a weak find into a reported miss", async () => {
	const strong = makeNode({ ...REGION, scanDirection: "right", polarity: "darkToLight", calipers: 8 });
	await strong.run({ payload: rawGray() });
	const score = strong.sent[0].lineFinder.score;
	assert.ok(score > 0.5, `expected a confident find, got ${score}`);

	const gated = makeNode({
		...REGION, scanDirection: "right", polarity: "darkToLight",
		calipers: 8, minScore: Math.min(1, score + 0.05),
	});
	await gated.run({ payload: rawGray() });
	assert.strictEqual(gated.sent[0].lineFinder.found, false);
	assert.strictEqual(gated.sent[0].lineFinder.reason, "below-min-score");
});

test("a blank angle tolerance disables the angle check", async () => {
	// "" is what the editor sends for an empty numeric field
	const h = makeNode({
		...REGION, scanDirection: "right", polarity: "darkToLight",
		calipers: 8, angleToleranceDeg: "",
	});
	await h.run({ payload: rawGray() });
	assert.strictEqual(h.sent[0].lineFinder.found, true, h.sent[0].lineFinder.reason);
});

test("an unusable payload is an error, not a miss", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right" });
	await h.run({ payload: { nonsense: true } });
	assert.strictEqual(h.sent.length, 0);
	assert.strictEqual(h.doneErrors.length, 1);
	assert.match(h.doneErrors[0], /must be an encoded image Buffer/);
	assert.strictEqual(h.statuses.at(-1).fill, "red");
});

// ---- preview ----------------------------------------------------------

test("no preview is published unless it is switched on", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right", calipers: 8 });
	await h.run({ payload: rawGray() });
	const previews = h.published.filter((p) => p.topic === "line-finder-preview");
	assert.strictEqual(previews.length, 1);
	// a clear, so a preview left over from when it *was* enabled goes away
	assert.strictEqual(previews[0].data.clear, true);
	assert.strictEqual(previews[0].data.image, undefined);
});

test("the preview carries the image and everything needed to draw the overlay", async () => {
	const h = makeNode({
		...REGION, scanDirection: "right", polarity: "darkToLight",
		calipers: 8, previewEnabled: true, previewWidth: 120,
	});
	await h.run({ payload: rawGray() });
	const data = h.published.filter((p) => p.topic === "line-finder-preview").at(-1).data;

	assert.ok(data.image && data.image.length > 100, "a JPEG should be attached");
	assert.strictEqual(data.mimeType, "jpeg");
	assert.strictEqual(data.previewWidth, 120);
	// image dimensions are needed to scale image-pixel geometry to the thumb
	assert.strictEqual(data.imageWidth, W);
	assert.strictEqual(data.imageHeight, H);
	assert.strictEqual(data.region.length, 4);
	assert.strictEqual(data.points.length, 8);
	assert.ok(data.line, "a found line should be drawable");
	assert.strictEqual(data.found, true);
});

test("the preview draws the region as configured, not as an upright box", async () => {
	const h = makeNode({
		...REGION, regionAngleDeg: 30, scanDirection: "right",
		calipers: 8, previewEnabled: true,
	});
	await h.run({ payload: rawGray() });
	const region = h.published.filter((p) => p.topic === "line-finder-preview").at(-1).data.region;
	// a rotated region is a parallelogram: no two adjacent corners share an axis
	assert.ok(Math.abs(region[0].y - region[1].y) > 1, "rotation should be visible");
	assert.ok(Math.abs(region[0].x - region[3].x) > 1, "rotation should be visible");
});

test("a miss still previews, so a badly aimed region can be seen", async () => {
	const h = makeNode({
		regionX: 10, regionY: 10, regionWidth: 60, regionHeight: 60,
		scanDirection: "right", contrastThreshold: 50, calipers: 8,
		previewEnabled: true,
	});
	await h.run({ payload: rawGray() });
	const data = h.published.filter((p) => p.topic === "line-finder-preview").at(-1).data;
	assert.strictEqual(data.found, false);
	assert.strictEqual(data.reason, "no-edge");
	assert.strictEqual(data.line, null);
	assert.ok(data.image, "the frame is still shown");
	assert.strictEqual(data.region.length, 4, "and so is the region that missed it");
});

test("dropped calipers are published too, not just the surviving fit", async () => {
	// a bright speck off the edge captures one caliper band
	const g = grayFrame();
	for (let y = 80; y < 110; y++) {
		for (let x = 64; x < 72; x++) g[y * W + x] = 255;
	}
	const payload = { data: Buffer.from(g.buffer, g.byteOffset, g.byteLength), width: W, height: H, channels: 1 };
	const h = makeNode({
		...REGION, scanDirection: "right", polarity: "darkToLight",
		calipers: 8, edgeSelect: "first", previewEnabled: true,
	});
	await h.run({ payload });
	const data = h.published.filter((p) => p.topic === "line-finder-preview").at(-1).data;
	assert.strictEqual(data.found, true, data.reason);
	assert.ok(data.points.some((p) => p.used === false), "the outlier should be drawable in red");
});

test("a preview failure warns but does not fail the frame", async () => {
	const h = makeNode({
		...REGION, scanDirection: "right", calipers: 8, previewEnabled: true,
	});
	const warnings = [];
	h.node.warn = (m) => warnings.push(String(m));
	// a raw descriptor whose data is far too short for its stated geometry:
	// the finder tolerates it, sharp does not
	await h.run({ payload: { data: Buffer.alloc(16), width: W, height: H, channels: 1 } });
	assert.deepStrictEqual(h.doneErrors, [], "the frame must still complete");
	assert.strictEqual(h.sent.length, 1);
	assert.ok(h.sent[0].lineFinder, "the result is still reported");
	assert.strictEqual(warnings.length, 1);
	assert.match(warnings[0], /line-finder preview/);
});
