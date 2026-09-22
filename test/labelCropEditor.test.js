/**
 * The label-crop editor's flow-canvas preview: the Before / After panel
 * the node draws under itself over RED.comms.
 *
 * The panel is a foreignObject appended inside the node's own <g>, whose
 * origin is the node's top-left corner (Node-RED translates the group to
 * x - w/2, y - h/2 and keeps node.x/node.y as the centre). Getting that
 * wrong puts the panel over the node instead of under it, and nothing
 * errors - so the editor <script> is lifted out of the .html and run
 * against a stub RED that hands back the subscribe callback.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HTML = path.join(__dirname, "..", "label-crop.html");
const html = fs.readFileSync(HTML, "utf8");
const SCRIPT = (() => {
	const m = html.match(/<script type="text\/javascript">\n([\s\S]*)\n<\/script>\s*$/);
	assert.ok(m, "could not find the editor script in label-crop.html");
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
	new Function("RED", "document", "window", SCRIPT)(RED, document, {});
	const publish = (data) => subscriptions["label-crop-preview"](null, data);
	const panel = () => group.find((e) => e.tag === "foreignObject");
	return { group, publish, panel };
}

const NODE = { id: "n1", x: 300, y: 200, w: 120, h: 30 };
const EVENT = { id: "n1", before: "QUJD", after: "REVG", previewWidth: 200 };

test("the preview panel is centred under the node, not over it", () => {
	const { publish, panel } = boot(NODE);
	publish(EVENT);
	const fo = panel();
	assert.ok(fo, "a foreignObject was appended to the node group");
	const x = Number(fo.attrs.x);
	const y = Number(fo.attrs.y);
	const width = Number(fo.attrs.width);
	assert.strictEqual(width, 200 * 2 + 30);
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
