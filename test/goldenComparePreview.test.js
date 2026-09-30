/**
 * The golden-compare editor's flow-canvas preview and the stage viewer
 * behind it.
 *
 * The thumbnail is a foreignObject inside the node's own <g>, placed the
 * way test/lineFinderPreview.test.js pins for line-finder: centred on the
 * node's width, just under its height. Clicking it fetches the last
 * inspection from the runtime and opens a viewer that steps through the
 * stages in order; the viewer is checked here against a stub document
 * and a stub $.getJSON, so the fetch URL, the stage image URLs, the
 * keyboard stepping and the teardown are all asserted without a browser.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HTML = path.join(__dirname, "..", "golden-compare.html");
const html = fs.readFileSync(HTML, "utf8");
const SCRIPT = (() => {
	const m = html.match(/<script type="text\/javascript">\n([\s\S]*)\n<\/script>\s*$/);
	assert.ok(m, "could not find the editor script in golden-compare.html");
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
		this.textContent = "";
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
	findAll(pred, out = []) {
		if (pred(this)) out.push(this);
		for (const c of this.children) c.findAll(pred, out);
		return out;
	}
}

// never fires onload; only its src matters here (the prefetch)
class StubImage {}

function boot(node, { meta, fail } = {}) {
	const group = new El("g");
	group.id = node.id;
	const bodyEl = new El("body");
	const subscriptions = {};
	const listeners = {};
	const requests = [];
	const document = {
		body: bodyEl,
		getElementById(id) {
			return group.find((e) => e.id === id) || bodyEl.find((e) => e.id === id);
		},
		createElementNS(_ns, tag) {
			return new El(tag);
		},
		addEventListener(type, fn) {
			listeners[type] = fn;
		},
		removeEventListener(type, fn) {
			if (listeners[type] === fn) delete listeners[type];
		},
	};
	const notices = [];
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
		notify(text, kind) {
			notices.push({ text, kind });
		},
	};
	const $ = {
		getJSON(url) {
			requests.push(url);
			const chain = {
				done(fn) {
					if (!fail) fn(meta);
					return chain;
				},
				fail(fn) {
					if (fail) fn({ responseJSON: { error: fail } });
					return chain;
				},
			};
			return chain;
		},
	};
	new Function("RED", "document", "window", "Image", "$", SCRIPT)(
		RED,
		document,
		{},
		StubImage,
		$,
	);
	const publish = (data) => subscriptions["golden-compare-preview"](null, data);
	const panel = () => group.find((e) => e.tag === "foreignObject");
	const viewer = () => bodyEl.find((e) => e.id === "golden-compare-stage-viewer");
	return { group, bodyEl, publish, panel, viewer, listeners, requests, notices };
}

const NODE = { id: "gc1", x: 300, y: 200, w: 120, h: 30, name: "front label" };
const EVENT = {
	id: "gc1",
	image: "QUJD",
	mimeType: "jpeg",
	imageWidth: 400,
	imageHeight: 300,
	previewWidth: 200,
	pass: false,
	text: "fail (background) · align 0.061 · 412ms",
	receivedAt: 1700000000000,
	stages: ["goldenGray", "targetGray"],
};
const META = {
	ok: true,
	receivedAt: 1700000000000,
	filename: "frame-7.jpg",
	pass: false,
	text: EVENT.text,
	result: {
		match: { score: 0.061, grade: "good", coverage: 0.91 },
		position: { pass: true, dxPx: 1, dyPx: -2, angleDeg: 0.1 },
		transform: { scale: 1.002, stretchPercent: 0.3, pinned: true },
		printBlemish: { pass: true, defectRatio: 0.0001, regions: [] },
		backgroundBlemish: {
			pass: false,
			defectRatio: 0.003,
			regions: [{ density: 0.41 }],
			worstExcess: 0.35,
			noveltyPass: false,
		},
	},
	timings: { totalMs: 412, alignMs: 200, diffMs: 40 },
	stages: [
		{ key: "goldenGray", group: "golden", title: "Golden, grey", description: "the reference" },
		{ key: "targetGray", group: "frame", title: "Frame, grey", description: "the frame" },
		{ key: "backgroundHeatmap", group: "verdict", title: "Background heat map", description: "blocks" },
	],
};

test("the thumbnail panel is centred under the node, not over it", () => {
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
	// the picture is the thumbnail the runtime sent, at the requested width
	const img = fo.find((e) => e.tag === "img");
	assert.ok(img, "the panel shows an image");
	assert.strictEqual(img.src, "data:image/jpeg;base64,QUJD");
	assert.strictEqual(img.style.width, "200px");
	assert.strictEqual(img.style.height, "150px");
	// and the verdict, coloured as a fail
	const caption = fo.find((e) => e.textContent === EVENT.text);
	assert.ok(caption, "the verdict text is shown");
	assert.strictEqual(caption.style.color, "#ef9a9a");
});

test("a clear event removes the panel, a repeat replaces it, the × hides it", () => {
	const { group, publish, panel } = boot(NODE);
	publish(EVENT);
	publish(EVENT);
	assert.strictEqual(
		group.children.filter((c) => c.tag === "foreignObject").length,
		1,
		"one panel per node",
	);
	const hide = panel().find((e) => e.textContent === "×");
	let propagated = true;
	hide.onclick({ stopPropagation: () => (propagated = false) });
	assert.strictEqual(panel(), null, "the × hides the panel");
	assert.strictEqual(propagated, false, "without opening the viewer");
	publish(EVENT);
	publish({ id: "gc1", clear: true });
	assert.strictEqual(panel(), null);
});

test("clicking the panel fetches the last inspection and opens the viewer on stage 1", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.panel().find((e) => e.tag === "div").onclick();
	assert.deepStrictEqual(h.requests, ["golden-compare/last/gc1"]);
	const v = h.viewer();
	assert.ok(v, "the viewer was appended to the body");
	const img = v.find((e) => e.tag === "img");
	assert.strictEqual(
		img.src,
		"golden-compare/last/gc1/stage/goldenGray?t=1700000000000",
		"opens on the first stage, cache-busted by the frame's time",
	);
	// one entry per stage, the current one highlighted
	const entries = v.findAll((e) => /^\d+\. /.test(e.textContent));
	assert.deepStrictEqual(
		entries.map((e) => e.textContent),
		["1. Golden, grey", "2. Frame, grey", "3. Background heat map"],
	);
	assert.strictEqual(entries[0].style.background, "#1976d2");
	assert.ok(v.find((e) => e.textContent === "the reference"), "the stage's description is shown");
	assert.ok(v.find((e) => e.textContent === "1 / 3 · Golden, grey"));
	// the numbers behind the verdict, with the failing channel marked
	assert.ok(v.find((e) => e.textContent === "front label"), "named after the node");
	assert.ok(v.find((e) => e.textContent === "frame-7.jpg"));
	const bg = v.find((e) => /^FAIL · ratio 0.00300/.test(e.textContent));
	assert.ok(bg, "the background row reads as a fail");
	assert.ok(/excess 0.350 FAIL/.test(bg.textContent), "and names the novelty gate");
	assert.strictEqual(bg.style.color, "#ef9a9a");
	assert.ok(v.find((e) => e.textContent === "91% of golden ink"));
});

test("arrow keys step through the stages and wrap, Esc closes and unhooks the keys", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.panel().find((e) => e.tag === "div").onclick();
	const v = h.viewer();
	const img = v.find((e) => e.tag === "img");
	const key = (k) => h.listeners.keydown({ key: k, preventDefault() {} });
	key("ArrowRight");
	assert.match(img.src, /stage\/targetGray\?/);
	key("ArrowRight");
	assert.match(img.src, /stage\/backgroundHeatmap\?/);
	key("ArrowRight");
	assert.match(img.src, /stage\/goldenGray\?/, "wraps to the first");
	key("ArrowLeft");
	assert.match(img.src, /stage\/backgroundHeatmap\?/, "and back around");
	key("End");
	assert.match(img.src, /stage\/backgroundHeatmap\?/);
	key("Home");
	assert.match(img.src, /stage\/goldenGray\?/);
	// the list entries follow
	const entries = v.findAll((e) => /^\d+\. /.test(e.textContent));
	assert.strictEqual(entries[0].style.background, "#1976d2");
	assert.strictEqual(entries[2].style.background, "transparent");
	key("Escape");
	assert.strictEqual(h.viewer(), null, "closed");
	assert.strictEqual(h.listeners.keydown, undefined, "the key handler is gone with it");
});

test("opening again replaces the viewer rather than stacking one", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	const open = () => h.panel().find((e) => e.tag === "div").onclick();
	open();
	open();
	assert.strictEqual(
		h.bodyEl.children.filter((c) => c.id === "golden-compare-stage-viewer").length,
		1,
	);
});

test("a runtime with no frame yet is reported, not thrown", () => {
	const h = boot(NODE, { fail: "no frame yet" });
	h.publish(EVENT);
	h.panel().find((e) => e.tag === "div").onclick();
	assert.strictEqual(h.viewer(), null);
	assert.deepStrictEqual(h.notices, [{ text: "golden-compare: no frame yet", kind: "warning" }]);
});
