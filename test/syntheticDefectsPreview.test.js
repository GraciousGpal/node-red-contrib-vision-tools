/**
 * The synthetic-defects editor's flow-canvas preview: the panel the node
 * draws under itself over RED.comms.
 *
 * Same harness as test/lineFinderPreview.test.js (test/helpers/previewDom.js),
 * for the same reason: the panel is a foreignObject inside the node's own
 * <g>, whose origin is the node's top-left corner, and getting that wrong
 * draws the panel over the node without any error.
 */

const test = require("node:test");
const assert = require("node:assert");

// a "#rgb" or "#rrggbb" colour as [r, g, b]: a fail must read red and a
// pass green, not only differ, or swapping the two would pass
const rgb = (hex) => {
	const m = /^#(?:([0-9a-f])([0-9a-f])([0-9a-f])|([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2}))$/i.exec(hex);
	assert.ok(m, `not a #rgb or #rrggbb colour: ${hex}`);
	return m[1] ? m.slice(1, 4).map((h) => parseInt(h + h, 16)) : m.slice(4).map((h) => parseInt(h, 16));
};
const redDominant = (hex) => rgb(hex)[0] > rgb(hex)[1];
const greenDominant = (hex) => rgb(hex)[1] > rgb(hex)[0];
const { editorScript, StubImage, bootPreview } = require("./helpers/previewDom.js");

const SCRIPT = editorScript("synthetic-defects.html");
const boot = (node) => bootPreview(SCRIPT, "synthetic-defects-preview", node, { globals: { Image: StubImage } });

const NODE = { id: "n1", x: 300, y: 200, w: 120, h: 30 };
const EVENT = {
	id: "n1",
	kind: "frame",
	image: "QUJD",
	imageWidth: 400,
	imageHeight: 300,
	previewWidth: 200,
	index: 1,
	total: 3,
	pass: false,
	text: "1/3 · mark/ink · tiny · expect fail (background)",
	boxes: [],
};

const captionOf = (panel, text) =>
	panel.find((e) => e.tag === "div" && e.textContent === text);

test("the preview panel is centred under the node, not over it", () => {
	const { publish, panel } = boot(NODE);
	publish(EVENT);
	const fo = panel();
	assert.ok(fo, "a foreignObject was appended to the node group");
	const x = Number(fo.attrs.x);
	const y = Number(fo.attrs.y);
	const width = Number(fo.attrs.width);
	assert.strictEqual(width, 200 + 20);
	assert.strictEqual(x + width / 2, NODE.w / 2);
	assert.ok(y > NODE.h, `panel top ${y} must clear the node bottom ${NODE.h}`);
	assert.ok(y - NODE.h <= 20, `gap ${y - NODE.h} should stay small`);
	// the thumbnail keeps the frame's aspect
	assert.strictEqual(Number(fo.attrs.height), 150 + 46);
});

test("the caption carries the case text and colours by the expected verdict", () => {
	const { publish, panel } = boot(NODE);
	publish(EVENT);
	const fail = captionOf(panel(), EVENT.text);
	assert.ok(fail, "caption shows the event text");

	publish({ ...EVENT, pass: true, text: "2/3 · clean · expect pass" });
	const pass = captionOf(panel(), "2/3 · clean · expect pass");

	const goldenText = "golden · 400×300 · synthetic · 3 frames to come";
	publish({ ...EVENT, kind: "golden", pass: true, text: goldenText });
	const golden = captionOf(panel(), goldenText);

	// expect fail, expect pass and the golden each get their own colour
	const colours = [fail, pass, golden].map((c) => c.style.color);
	assert.ok(colours.every(Boolean), `every caption is coloured: ${colours}`);
	assert.strictEqual(new Set(colours).size, 3, `three verdicts, three colours: ${colours}`);
	assert.ok(redDominant(colours[0]), `expect fail reads red: ${colours[0]}`);
	assert.ok(greenDominant(colours[1]), `expect pass reads green: ${colours[1]}`);
});

test("a clear event removes the panel and a repeat replaces it", () => {
	const { group, publish, panel } = boot(NODE);
	publish(EVENT);
	publish(EVENT);
	assert.strictEqual(
		group.children.filter((c) => c.tag === "foreignObject").length,
		1,
		"one panel per node",
	);
	publish({ id: "n1", clear: true });
	assert.strictEqual(panel(), null);
});
