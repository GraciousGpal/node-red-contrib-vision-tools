/**
 * Node-RED glue tests for the line-finder node (line-finder.js).
 *
 * Same harness shape as labelCropNode.test.js: the node is exercised
 * without Node-RED installed by invoking its registerType factory with a
 * fake RED and driving the 'input' listener directly.
 *
 * No engine fake is needed - lib/lineFinder.js is pure JS - so these
 * tests cover the glue only: payload shapes, msg overrides, the score
 * gate, status text, the miss-is-not-an-error rule, and the editor's
 * POST /line-finder/run endpoint.
 */

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { findLine } = require("../lib/lineFinder.js");
const { labelOnTray } = require("./helpers/synthetic.js");
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

test("a legacy single-region config reports exactly the shape it always has", async () => {
	// Pinned before regions were added: a flow saved with regionX/Y/Width/
	// Height/AngleDeg and no `regions` must see the same msg.lineFinder,
	// field for field, with the new `lines` array alongside rather than in
	// place of anything. The values are checked against findLine itself,
	// which is the runtime's own definition of "identical".
	const h = makeNode({ ...REGION, scanDirection: "right", polarity: "darkToLight", calipers: 8 });
	await h.run({ payload: rawGray() });
	const r = h.sent[0].lineFinder;
	const legacyKeys = [
		"found", "reason", "line", "angleDeg", "score", "calipers", "residualPx",
		"points", "caliperLines", "diagnostics", "region", "imageWidth", "imageHeight", "timings",
	];
	for (const k of legacyKeys) assert.ok(k in r, `${k} is missing from msg.lineFinder`);
	const extra = Object.keys(r).filter((k) => !legacyKeys.includes(k));
	assert.deepStrictEqual(extra, extra.includes("lines") ? ["lines"] : [], `unexpected keys ${extra}`);

	const region = { x: 60, y: 20, width: 80, height: 160, angleDeg: 0 };
	const direct = findLine(grayFrame(), W, H, region, {
		scanDirection: "right", polarity: "darkToLight", calipers: 8,
	});
	const { timings, lines, ...rest } = r;
	assert.deepStrictEqual(rest, { ...direct, region, imageWidth: W, imageHeight: H });
	assert.deepStrictEqual(r.region, region, "region carries geometry only, as before");
	assert.ok(timings.totalMs >= 0);
	assert.strictEqual(h.statuses.at(-1).text, `90.00° · 8/8 · score ${r.score.toFixed(2)}`);
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

// ---- the editor's Run endpoint ----------------------------------------

/** Drive the captured POST /line-finder/run handler with a JSON body. */
function callRun(body) {
	const node = loadNode("line-finder.js", {});
	const handlers = node.adminRoutes["/line-finder/run"];
	assert.ok(handlers, "the run endpoint should be registered on httpAdmin");
	// needsPermission's guard first, the handler last
	assert.strictEqual(handlers.length, 2);
	const handler = handlers[handlers.length - 1];
	return new Promise((resolve) => {
		const res = {
			statusCode: 200,
			status(code) {
				this.statusCode = code;
				return this;
			},
			json(payload) {
				resolve({ status: this.statusCode, body: payload });
			},
		};
		handler({ body }, res);
	});
}

// a pale label tilted 7 degrees on a dark tray; the region straddles its
// left edge, so the line found runs 7 degrees off vertical
const FRAME = { width: 400, height: 300 };
const RUN_REGION = { x: 50, y: 90, width: 60, height: 120, angleDeg: 7 };
const RUN_CFG = { scanDirection: "right", polarity: "darkToLight", calipers: "8", contrastThreshold: 3 };
function trayFrame() {
	return labelOnTray(FRAME.width, FRAME.height, { angleDeg: 7, channels: 1 });
}
async function pngCrop(raw, crop) {
	return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 1 } })
		.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
		.png()
		.toBuffer();
}

test("the Run endpoint answers in frame coordinates and agrees with a whole-frame search", async () => {
	const raw = trayFrame();
	const gray = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
	const direct = findLine(gray, raw.width, raw.height, RUN_REGION, RUN_CFG);
	assert.strictEqual(direct.found, true, direct.reason);

	// the editor sends a crop around the region, not the frame
	const crop = { x: 30, y: 60, width: 120, height: 180 };
	const png = await pngCrop(raw, crop);
	const { status, body } = await callRun({
		image: png.toString("base64"),
		offset: { x: crop.x, y: crop.y },
		region: RUN_REGION,
		cfg: RUN_CFG,
	});
	assert.strictEqual(status, 200);
	assert.strictEqual(body.ok, true);
	const r = body.result;
	assert.strictEqual(r.found, true, r.reason);

	// every coordinate comes back with the offset added, so the editor can
	// draw it over the full frame without knowing a crop was made
	const close = (a, b, what) =>
		assert.ok(Math.abs(a - b) < 0.5, `${what}: ${a} vs ${b}`);
	close(r.line.x, direct.line.x, "line.x");
	close(r.line.y, direct.line.y, "line.y");
	close(r.line.p0.x, direct.line.p0.x, "p0.x");
	close(r.line.p0.y, direct.line.p0.y, "p0.y");
	close(r.line.p1.x, direct.line.p1.x, "p1.x");
	close(r.line.p1.y, direct.line.p1.y, "p1.y");
	close(r.angleDeg, direct.angleDeg, "angleDeg");
	assert.strictEqual(r.points.length, direct.points.length);
	for (let i = 0; i < r.points.length; i++) {
		close(r.points[i].x, direct.points[i].x, `point ${i} x`);
		close(r.points[i].y, direct.points[i].y, `point ${i} y`);
	}
	assert.strictEqual(r.caliperLines.length, 8);
	for (let i = 0; i < 8; i++) {
		close(r.caliperLines[i].p0.x, direct.caliperLines[i].p0.x, `caliper ${i} p0.x`);
		close(r.caliperLines[i].p1.y, direct.caliperLines[i].p1.y, `caliper ${i} p1.y`);
	}
	// what the editor needs to explain the outcome and draw it
	assert.deepStrictEqual(r.region, RUN_REGION);
	assert.deepStrictEqual(r.crop, { x: 30, y: 60, width: 120, height: 180 });
	assert.strictEqual(r.settings.calipers, 8, "settings come back clamped, not as typed");
	assert.strictEqual(r.settings.minScore, 0);
	assert.ok(r.diagnostics.peakContrast >= 3, `peak ${r.diagnostics.peakContrast}`);
});

test("the Run endpoint tolerates a data: URL prefix and applies minScore like the input handler", async () => {
	const raw = trayFrame();
	const crop = { x: 30, y: 60, width: 120, height: 180 };
	const png = await pngCrop(raw, crop);
	const { status, body } = await callRun({
		image: "data:image/png;base64," + png.toString("base64"),
		offset: crop,
		region: RUN_REGION,
		cfg: { ...RUN_CFG, minScore: 1 },
	});
	assert.strictEqual(status, 200);
	assert.strictEqual(body.result.found, false);
	assert.strictEqual(body.result.reason, "below-min-score");
	assert.ok(body.result.score > 0.5, "the fit itself was fine");
});

test("the Run endpoint refuses a missing image or an invalid region with a 400 and a reason", async () => {
	const noImage = await callRun({ offset: { x: 0, y: 0 }, region: RUN_REGION, cfg: {} });
	assert.strictEqual(noImage.status, 400);
	assert.strictEqual(noImage.body.ok, false);
	assert.match(noImage.body.error, /image must be/);

	const raw = trayFrame();
	const png = await pngCrop(raw, { x: 0, y: 0, width: 100, height: 100 });
	const badRegion = await callRun({
		image: png.toString("base64"),
		offset: { x: 0, y: 0 },
		region: { x: 10, y: 10, width: 0, height: 50 },
		cfg: {},
	});
	assert.strictEqual(badRegion.status, 400);
	assert.match(badRegion.body.error, /positive width and height/);

	const garbage = await callRun({ image: "bm90IGFuIGltYWdl", offset: { x: 0, y: 0 }, region: RUN_REGION, cfg: {} });
	assert.strictEqual(garbage.status, 400);
	assert.ok(garbage.body.error.length > 0, "an undecodable image says so");
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

// ---- several regions ---------------------------------------------------

// the pale panel's other edges, for a second and third region on the
// same frame: its top edge sits at y = 99.5 when the panel is boxed
function panelFrame() {
	const g = new Uint8Array(W * H);
	g.fill(40);
	for (let y = 100; y < H; y++) {
		const row = y * W;
		for (let x = 100; x < W; x++) g[row + x] = 200;
	}
	return { data: Buffer.from(g.buffer, g.byteOffset, g.byteLength), width: W, height: H, channels: 1 };
}
const LEFT = { name: "left", x: 60, y: 120, width: 80, height: 70, scanDirection: "right", polarity: "darkToLight" };
const TOP = { name: "top", x: 120, y: 60, width: 100, height: 80, scanDirection: "down", polarity: "darkToLight" };

test("two regions report one entry each in lines, and found only when both found", async () => {
	const h = makeNode({ regions: [LEFT, TOP], calipers: 8 });
	await h.run({ payload: panelFrame() });
	assert.deepStrictEqual(h.doneErrors, []);
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.lines.length, 2);
	assert.deepStrictEqual(r.lines.map((l) => l.name), ["left", "top"], "configured order");
	assert.strictEqual(r.lines[0].found, true, r.lines[0].reason);
	assert.strictEqual(r.lines[1].found, true, r.lines[1].reason);
	assert.ok(Math.abs(r.lines[0].line.x - 99.5) < 1, `left edge at ${r.lines[0].line.x}`);
	assert.ok(Math.abs(r.lines[1].line.y - 99.5) < 1, `top edge at ${r.lines[1].line.y}`);
	// each entry carries the region it searched, modes included
	assert.strictEqual(r.lines[1].region.scanDirection, "down");
	assert.strictEqual(r.lines[1].region.name, "top");
	assert.strictEqual(r.found, true);
	assert.strictEqual(r.reason, "ok");
	// the single-region fields are not faked up at the top level
	assert.strictEqual(r.line, undefined);
	assert.strictEqual(r.rect, undefined, "no rectangle from two sides");
	// the two lines cross at the panel's corner
	assert.strictEqual(r.intersections.length, 1);
	assert.deepStrictEqual([r.intersections[0].a, r.intersections[0].b], ["left", "top"]);
	assert.ok(Math.abs(r.intersections[0].x - 99.5) < 1 && Math.abs(r.intersections[0].y - 99.5) < 1);
	assert.strictEqual(h.statuses.at(-1).text, "2/2 lines");
	assert.strictEqual(h.statuses.at(-1).fill, "green");
});

test("one region missing makes the whole result a miss that names it", async () => {
	// the top region is aimed at plain background
	const h = makeNode({ regions: [LEFT, { ...TOP, x: 10, y: 10, width: 40, height: 40 }], calipers: 8 });
	await h.run({ payload: panelFrame() });
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.lines[0].found, true);
	assert.strictEqual(r.lines[1].found, false);
	assert.strictEqual(r.found, false);
	assert.strictEqual(r.reason, "top:no-edge");
	assert.deepStrictEqual(r.intersections, [], "nothing to intersect a miss with");
	assert.strictEqual(h.statuses.at(-1).text, "not found (top:no-edge)");
	assert.strictEqual(h.statuses.at(-1).fill, "yellow");
});

test("two near-parallel lines are not intersected", async () => {
	// the same edge searched twice: parallel within any tolerance
	const h = makeNode({ regions: [LEFT, { ...LEFT, name: "left2", y: 30, height: 60 }], calipers: 8 });
	await h.run({ payload: rawGray() });
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.found, true, r.reason);
	assert.deepStrictEqual(r.intersections, []);
});

test("msg.regions replaces the configured list for that message", async () => {
	const h = makeNode({ ...REGION, scanDirection: "right", polarity: "darkToLight", calipers: 8 });
	await h.run({ payload: panelFrame(), regions: [LEFT, TOP] });
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.lines.length, 2);
	assert.strictEqual(r.found, true, r.reason);
	// an entry that leaves its modes out inherits the node's
	await h.run({ payload: panelFrame(), regions: [{ name: "a", x: 60, y: 120, width: 80, height: 70 }] });
	const one = h.sent[1].lineFinder;
	assert.strictEqual(one.lines.length, 1);
	assert.strictEqual(one.lines[0].region.polarity, "darkToLight");
	assert.strictEqual(one.found, true, one.reason);
	// and with one region the top level is the single-region shape again
	assert.ok(one.line, "line at the top level");
	assert.deepStrictEqual(one.region, { x: 60, y: 120, width: 80, height: 70, angleDeg: 0 });
	// an unusable override falls back to the configuration
	await h.run({ payload: rawGray(), regions: "nonsense" });
	assert.strictEqual(h.sent[2].lineFinder.lines.length, 1);
	assert.strictEqual(h.sent[2].lineFinder.lines[0].name, "line");
});

test("four regions named left/right/top/bottom become the label's rectangle", async () => {
	// the tray fixture: a 240x156 label centred at (200,150), tilted 7°;
	// its corners follow from that, and the found rectangle must land on them
	const raw = trayFrame();
	const a = (7 * Math.PI) / 180;
	const corner = (u, v) => ({
		x: 200 + u * Math.cos(a) - v * Math.sin(a),
		y: 150 + u * Math.sin(a) + v * Math.cos(a),
	});
	const expected = [corner(-120, -78), corner(120, -78), corner(120, 78), corner(-120, 78)];
	const h = makeNode({
		regions: [
			{ name: "left", x: 56, y: 85, width: 50, height: 100, angleDeg: 7, scanDirection: "right", polarity: "darkToLight" },
			{ name: "right", x: 294, y: 115, width: 50, height: 100, angleDeg: 7, scanDirection: "left", polarity: "darkToLight" },
			{ name: "top", x: 160, y: 53, width: 100, height: 40, angleDeg: 7, scanDirection: "down", polarity: "darkToLight" },
			{ name: "bottom", x: 140, y: 207, width: 100, height: 40, angleDeg: 7, scanDirection: "up", polarity: "darkToLight" },
		],
		calipers: 8,
		contrastThreshold: 3,
		previewEnabled: true,
	});
	await h.run({ payload: raw });
	assert.deepStrictEqual(h.doneErrors, []);
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.found, true, r.reason);
	assert.strictEqual(r.lines.length, 4);
	assert.ok(r.rect, "a rectangle from the four sides");
	assert.strictEqual(r.rect.ok, true, r.rect.reason);
	// label-crop's field names and corner order: tl, tr, br, bl
	assert.deepStrictEqual(Object.keys(r.rect).sort(), [
		"angleDeg", "center", "corners", "height", "ok", "reason", "residualPx", "score", "width",
	]);
	assert.strictEqual(r.rect.corners.length, 4);
	for (let i = 0; i < 4; i++) {
		const d = Math.hypot(r.rect.corners[i].x - expected[i].x, r.rect.corners[i].y - expected[i].y);
		assert.ok(d < 1.5, `corner ${i}: ${JSON.stringify(r.rect.corners[i])} vs ${JSON.stringify(expected[i])} (${d.toFixed(2)}px)`);
	}
	assert.ok(Math.abs(r.rect.width - 240) < 1.5, `width ${r.rect.width}`);
	assert.ok(Math.abs(r.rect.height - 156) < 1.5, `height ${r.rect.height}`);
	assert.ok(Math.abs(r.rect.center.x - 200) < 1 && Math.abs(r.rect.center.y - 150) < 1, `centre ${JSON.stringify(r.rect.center)}`);
	assert.ok(Math.abs(r.rect.angleDeg - 7) < 0.5, `angle ${r.rect.angleDeg}`);
	// the four corners are also the four crossings of adjacent sides
	assert.strictEqual(r.intersections.length, 4, JSON.stringify(r.intersections.map((i) => [i.a, i.b])));
	assert.match(h.statuses.at(-1).text, /^4\/4 lines · rect 240×15[56]$/);

	// the preview draws every region and the rectangle
	const data = h.published.filter((p) => p.topic === "line-finder-preview").at(-1).data;
	assert.strictEqual(data.lines.length, 4);
	assert.deepStrictEqual(data.lines.map((l) => l.name), ["left", "right", "top", "bottom"]);
	assert.ok(data.lines.every((l) => l.region.length === 4 && l.line && l.points.length === 8));
	assert.strictEqual(data.rect.corners.length, 4);
	assert.strictEqual(data.found, true);
	assert.strictEqual(data.region, null, "no single-region geometry to mislead a drawer");
});

test("a rectangle with a side missing says which, rather than guessing a corner", async () => {
	const raw = trayFrame();
	const h = makeNode({
		regions: [
			{ name: "left", x: 56, y: 85, width: 50, height: 100, angleDeg: 7, scanDirection: "right", polarity: "darkToLight" },
			{ name: "right", x: 294, y: 115, width: 50, height: 100, angleDeg: 7, scanDirection: "left", polarity: "darkToLight" },
			{ name: "top", x: 160, y: 53, width: 100, height: 40, angleDeg: 7, scanDirection: "down", polarity: "darkToLight" },
			// the bottom region is off on the tray
			{ name: "bottom", x: 20, y: 250, width: 60, height: 30, scanDirection: "up" },
		],
		calipers: 8,
		contrastThreshold: 3,
	});
	await h.run({ payload: raw });
	const r = h.sent[0].lineFinder;
	assert.strictEqual(r.found, false);
	assert.strictEqual(r.reason, "bottom:no-edge");
	assert.deepStrictEqual(r.rect, { ok: false, reason: "missing-edge:bottom", missing: ["bottom"] });
	// the three found sides still cross where they should
	assert.strictEqual(r.intersections.length, 2);
});

test("the single-region preview shape is unchanged, with lines alongside", async () => {
	const h = makeNode({
		...REGION, scanDirection: "right", polarity: "darkToLight",
		calipers: 8, previewEnabled: true,
	});
	await h.run({ payload: rawGray() });
	const data = h.published.filter((p) => p.topic === "line-finder-preview").at(-1).data;
	assert.strictEqual(data.lines.length, 1);
	assert.strictEqual(data.lines[0].name, "line");
	assert.deepStrictEqual(data.lines[0].region, data.region);
	assert.deepStrictEqual(data.lines[0].line, data.line);
	assert.strictEqual(data.rect, null);
});
