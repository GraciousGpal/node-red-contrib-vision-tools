/**
 * The synthetic-defects editor's flow-canvas preview: the panel the node
 * draws under itself over RED.comms.
 *
 * Same harness as test/lineFinderPreview.test.js, for the same reason: the
 * panel is a foreignObject inside the node's own <g>, whose origin is the
 * node's top-left corner, and getting that wrong draws the panel over the
 * node without any error. The editor <script> is lifted out of the .html
 * and run against a stub RED that hands back the subscribe callback.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HTML = path.join(__dirname, "..", "synthetic-defects.html");
const html = fs.readFileSync(HTML, "utf8");
const SCRIPT = (() => {
	const m = html.match(/<script type="text\/javascript">\n([\s\S]*)\n<\/script>\s*$/);
	assert.ok(m, "could not find the editor script in synthetic-defects.html");
	return m[1];
})();

class El {
	constructor(tag) {
		this.tag = tag;
		this.id = "";
		this.attrs = {};
		this.style = {};
		this.children = [];
		this.parent = null;
	}
	setAttribute(name, value) {
		this.attrs[name] = value;
	}
	appendChild(child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}
	remove() {
		if (this.parent) {
			this.parent.children = this.parent.children.filter((c) => c !== this);
			this.parent = null;
		}
	}
	find(pred) {
		if (pred(this)) return this;
		for (const c of this.children) {
			const hit = c.find(pred);
			if (hit) return hit;
		}
		return null;
	}
}

// never fires onload: the box drawing is not what is under test here
class StubImage {}

function boot(node) {
	const group = new El("g");
	group.id = node.id;
	const subscriptions = {};
	const document = {
		getElementById(id) {
			return group.find((e) => e.id === id);
		},
		createElementNS(_ns, tag) {
			return new El(tag);
		},
	};
	const RED = {
		validators: { number: () => () => true },
		comms: {
			subscribe(topic, fn) {
				subscriptions[topic] = fn;
			},
		},
		nodes: {
			registerType() {},
			node(id) {
				return id === node.id ? node : undefined;
			},
		},
	};
	new Function("RED", "document", "window", "Image", SCRIPT)(RED, document, {}, StubImage);
	const publish = (data) => subscriptions["synthetic-defects-preview"](null, data);
	const panel = () => group.find((e) => e.tag === "foreignObject");
	return { group, publish, panel };
}

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
	assert.strictEqual(fail.style.color, "#ffcc80");

	publish({ ...EVENT, pass: true, text: "2/3 · clean · expect pass" });
	assert.strictEqual(captionOf(panel(), "2/3 · clean · expect pass").style.color, "#a5d6a7");

	const golden = "golden · 400×300 · synthetic · 3 frames to come";
	publish({ ...EVENT, kind: "golden", pass: true, text: golden });
	assert.strictEqual(captionOf(panel(), golden).style.color, "#90caf9");
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
