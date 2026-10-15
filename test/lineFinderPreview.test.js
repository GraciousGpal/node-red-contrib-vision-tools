/**
 * The line-finder editor's flow-canvas preview: the result panel the
 * node draws under itself over RED.comms.
 *
 * The panel is a foreignObject appended inside the node's own <g>, whose
 * origin is the node's top-left corner (Node-RED translates the group to
 * x - w/2, y - h/2 and keeps node.x/node.y as the centre). Getting that
 * wrong puts the panel over the node and off to the side instead of under
 * it, and nothing errors - so the editor script is lifted out of the
 * .html and run against a stub RED that hands back the subscribe callback
 * (test/helpers/previewDom.js).
 * test/labelCropEditor.test.js does the same for label-crop.
 */

const test = require("node:test");
const assert = require("node:assert");
const { editorScript, StubImage, bootPreview } = require("./helpers/previewDom.js");

const SCRIPT = editorScript("line-finder.html");
const boot = (node) => bootPreview(SCRIPT, "line-finder-preview", node, { globals: { Image: StubImage } });

const NODE = { id: "n1", x: 300, y: 200, w: 120, h: 30 };
const EVENT = {
	id: "n1",
	image: "QUJD",
	imageWidth: 400,
	imageHeight: 300,
	previewWidth: 200,
	found: false,
	reason: "test",
};

test("the preview panel is centred under the node, not over it", () => {
	const { publish, panel } = boot(NODE);
	publish(EVENT);
	const fo = panel();
	assert.ok(fo, "a foreignObject was appended to the node group");
	const x = Number(fo.attrs.x);
	const y = Number(fo.attrs.y);
	const width = Number(fo.attrs.width);
	assert.strictEqual(width, 200 + 20);
	// horizontally centred on the node's own centre (w/2 in group space)
	assert.strictEqual(x + width / 2, NODE.w / 2);
	// starts below the node's bottom edge (h in group space), with a gap
	assert.ok(y > NODE.h, `panel top ${y} must clear the node bottom ${NODE.h}`);
	assert.ok(y - NODE.h <= 20, `gap ${y - NODE.h} should stay small`);
});

test("the preview panel follows the node's size", () => {
	const wide = { ...NODE, w: 240, h: 60 };
	const { publish, panel } = boot(wide);
	publish(EVENT);
	const fo = panel();
	assert.strictEqual(Number(fo.attrs.x) + Number(fo.attrs.width) / 2, 120);
	assert.strictEqual(Number(fo.attrs.y), 70);
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
