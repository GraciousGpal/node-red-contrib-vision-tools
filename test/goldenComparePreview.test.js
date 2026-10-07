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
 * keyboard stepping, the overlay compositing and the teardown are all
 * asserted without a browser. The canvas stub hands back pixels by which
 * image was drawn into it, so the red/cyan and difference arithmetic is
 * checked on real numbers.
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

// Pixel values a stub canvas reports for an image, by stage key: two
// pixels wide, one high. goldenFg has ink on the left, targetFgAligned on
// the right, so red/cyan should come out red then cyan.
const PIXELS = {
	goldenFg: [255, 0],
	targetFgAligned: [0, 255],
	goldenGray: [200, 200],
	backgroundHeatmap: [100, 200],
};
const sizeOf = (src) => (/stage\/targetGray\b/.test(src) ? [3, 1] : [2, 1]);
const keyOf = (src) => (src.match(/stage\/([A-Za-z]+)/) || [])[1];

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
	getContext() {
		const canvas = this;
		let drawn = null;
		return {
			drawImage(image) {
				drawn = image;
			},
			getImageData(_x, _y, w, h) {
				const data = new Uint8ClampedArray(w * h * 4);
				const values = PIXELS[keyOf(drawn.src)] || [0, 0];
				for (let i = 0; i < w * h; i++) {
					data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = values[i % values.length];
					data[i * 4 + 3] = 255;
				}
				return { data, width: w, height: h };
			},
			createImageData(w, h) {
				return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
			},
			putImageData(imageData) {
				canvas.put = imageData;
			},
		};
	}
}

function boot(node, { meta, fail, holdFail } = {}) {
	const group = new El("g");
	group.id = node.id;
	const bodyEl = new El("body");
	const subscriptions = {};
	const listeners = {};
	const requests = [];
	const images = [];
	// never fires onload on its own: settle() does, so a test controls
	// when each stage image "arrives"
	class StubImage {
		constructor() {
			images.push(this);
		}
	}
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
	// the meta a fetch answers with can be swapped mid-test to stand for
	// a newer frame having gone through the node
	const live = { meta };
	const ajaxCalls = [];
	const $ = {
		getJSON(url) {
			requests.push(url);
			const chain = {
				done(fn) {
					if (!fail) fn(live.meta);
					return chain;
				},
				fail(fn) {
					if (fail) fn({ responseJSON: { error: fail } });
					return chain;
				},
			};
			return chain;
		},
		ajax(opts) {
			ajaxCalls.push(opts);
			const ok = !(opts.type === "POST" && holdFail);
			const chain = {
				done(fn) {
					if (ok) fn({ ok: true });
					return chain;
				},
				fail(fn) {
					if (!ok) fn({ responseJSON: { error: holdFail } });
					return chain;
				},
				always(fn) {
					fn();
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
	const open = () => panel().find((e) => e.tag === "div").onclick();
	const key = (k) => listeners.keydown({ key: k, preventDefault() {} });
	// every requested image that has not loaded yet loads now
	const settle = () => {
		for (const im of images) {
			if (im.loaded || !im.onload) continue;
			im.loaded = true;
			[im.naturalWidth, im.naturalHeight] = sizeOf(im.src);
			im.onload();
		}
	};
	// the hold calls and the viewer's attention calls, kept apart: a test
	// about holds should not count the watch posted on open
	const holds = () => ajaxCalls.filter((c) => /\/hold$/.test(c.url));
	const watches = () => ajaxCalls.filter((c) => /\/watch$/.test(c.url));
	return { group, bodyEl, publish, panel, viewer, open, key, settle, images, listeners, requests, notices, live, ajaxCalls, holds, watches };
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
// a fuller stage list, for the overlay
const META_OVERLAY = {
	...META,
	stages: [
		{ key: "goldenGray", group: "golden", title: "Golden, grey", description: "" },
		{ key: "goldenFg", group: "golden", title: "Golden ink", description: "" },
		{ key: "targetGray", group: "frame", title: "Frame, grey", description: "" },
		{ key: "targetFgAligned", group: "aligned", title: "Frame ink, aligned", description: "" },
		{ key: "backgroundHeatmap", group: "verdict", title: "Background heat map", description: "" },
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
	h.open();
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
	// the verdict table is pinned at the top of the side panel; the rest scrolls under it
	const side = v.find((e) => e.id === "golden-compare-stage-side");
	assert.strictEqual(side.children[0].id, "golden-compare-stage-results");
	assert.strictEqual(side.children[1].style.overflow, "auto");
	assert.ok(side.children[1].find((e) => e.textContent === "1. Golden, grey"), "the stage list scrolls");
	assert.ok(side.children[1].find((e) => e.textContent === "the reference"), "so does the description");
	// the next stage is prefetched
	assert.ok(
		h.images.some((im) => /stage\/targetGray\?/.test(im.src)),
		"stage 2 was requested ahead of the arrow key",
	);
});

test("arrow keys step through the stages and wrap, Esc closes and unhooks the keys", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.open();
	const v = h.viewer();
	const img = v.find((e) => e.tag === "img");
	h.key("ArrowRight");
	assert.match(img.src, /stage\/targetGray\?/);
	h.key("ArrowRight");
	assert.match(img.src, /stage\/backgroundHeatmap\?/);
	h.key("ArrowRight");
	assert.match(img.src, /stage\/goldenGray\?/, "wraps to the first");
	h.key("ArrowLeft");
	assert.match(img.src, /stage\/backgroundHeatmap\?/, "and back around");
	h.key("End");
	assert.match(img.src, /stage\/backgroundHeatmap\?/);
	h.key("Home");
	assert.match(img.src, /stage\/goldenGray\?/);
	// the list entries follow
	const entries = v.findAll((e) => /^\d+\. /.test(e.textContent));
	assert.strictEqual(entries[0].style.background, "#1976d2");
	assert.strictEqual(entries[2].style.background, "transparent");
	h.key("Escape");
	assert.strictEqual(h.viewer(), null, "closed");
	assert.strictEqual(h.listeners.keydown, undefined, "the key handler is gone with it");
});

test("opening again replaces the viewer rather than stacking one", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.open();
	h.open();
	assert.strictEqual(
		h.bodyEl.children.filter((c) => c.id === "golden-compare-stage-viewer").length,
		1,
	);
});

test("a runtime with no frame yet is reported, not thrown", () => {
	const h = boot(NODE, { fail: "no frame yet" });
	h.publish(EVENT);
	h.open();
	assert.strictEqual(h.viewer(), null);
	assert.deepStrictEqual(h.notices, [{ text: "golden-compare: no frame yet", kind: "warning" }]);
});

test("the overlay composites a mask stage over the golden's ink, red where only the golden has ink and cyan where only the frame does", () => {
	const h = boot(NODE, { meta: META_OVERLAY });
	h.publish(EVENT);
	h.open();
	const v = h.viewer();
	const img = v.find((e) => e.tag === "img");
	const canvas = v.find((e) => e.tag === "canvas");
	assert.strictEqual(canvas.style.display, "none", "plain view to start with");
	h.key("End");
	h.key("ArrowLeft"); // targetFgAligned
	assert.match(img.src, /stage\/targetFgAligned\?/);

	const check = v.find((e) => e.id === "golden-compare-stage-overlay");
	assert.ok(check, "the overlay checkbox is there");
	check.checked = true;
	check.onchange();
	// nothing to draw until both images have arrived
	assert.strictEqual(canvas.style.display, "none");
	const baseSelect = v.find((e) => e.tag === "select" && e.children.some((o) => o.value === "goldenFg"));
	assert.strictEqual(baseSelect.value, "goldenFg", "a mask stage goes over the golden's ink");
	h.settle();
	assert.strictEqual(canvas.style.display, "", "the composite is shown");
	assert.strictEqual(img.style.display, "none", "in place of the plain image");
	assert.strictEqual(canvas.width, 2);
	assert.strictEqual(canvas.height, 1);
	const d = Array.from(canvas.put.data);
	assert.deepStrictEqual(d.slice(0, 4), [255, 0, 0, 255], "golden-only ink is red");
	assert.deepStrictEqual(d.slice(4, 8), [0, 255, 255, 255], "frame-only ink is cyan");
	assert.match(v.find((e) => /Red: only the golden/.test(e.textContent)).textContent, /print defect in red/);

	// difference mode: both pixels differ fully
	const modeSelect = v.find((e) => e.tag === "select" && e.children.some((o) => o.value === "difference"));
	modeSelect.value = "difference";
	modeSelect.onchange();
	assert.deepStrictEqual(Array.from(canvas.put.data).slice(0, 4), [255, 255, 255, 255]);

	// blend at 50%: halfway between the two
	modeSelect.value = "blend";
	modeSelect.onchange();
	const slider = v.find((e) => e.type === "range");
	assert.strictEqual(slider.style.display, "", "the slider appears for blend");
	assert.deepStrictEqual(Array.from(canvas.put.data).slice(0, 3), [128, 128, 128]);
	slider.value = "100";
	slider.oninput();
	assert.deepStrictEqual(Array.from(canvas.put.data).slice(0, 3), [0, 0, 0], "all the way to the stage");

	// a grey stage goes over the grey golden unless a base was chosen
	modeSelect.value = "redcyan";
	modeSelect.onchange();
	h.key("End"); // backgroundHeatmap
	h.settle();
	assert.strictEqual(baseSelect.value, "goldenGray");
	assert.deepStrictEqual(Array.from(canvas.put.data).slice(0, 3), [200, 100, 100]);

	// "o" switches it off and the plain image is back
	h.key("o");
	assert.strictEqual(canvas.style.display, "none");
	assert.strictEqual(img.style.display, "");
	assert.strictEqual(check.checked, false);
});

test("a stage on the frame's own canvas is shown plain, with a note, rather than mis-overlaid", () => {
	const h = boot(NODE, { meta: META_OVERLAY });
	h.publish(EVENT);
	h.open();
	const v = h.viewer();
	const img = v.find((e) => e.tag === "img");
	const canvas = v.find((e) => e.tag === "canvas");
	h.key("o");
	h.settle();
	assert.strictEqual(canvas.style.display, "", "goldenGray over goldenGray still composites");
	h.key("ArrowRight");
	h.key("ArrowRight"); // targetGray, 3x1 against the golden's 2x1
	h.settle();
	assert.strictEqual(canvas.style.display, "none");
	assert.strictEqual(img.style.display, "");
	const note = v.find((e) => /frame's own canvas/.test(e.textContent));
	assert.ok(note, "explains why");
	assert.match(note.textContent, /3×1.*2×1/);
	// choosing a base explicitly sticks across stages
	const baseSelect = v.find((e) => e.tag === "select" && e.children.some((o) => o.value === "goldenFg"));
	baseSelect.value = "goldenFg";
	baseSelect.onchange();
	h.key("End");
	h.settle();
	assert.strictEqual(baseSelect.value, "goldenFg");
	assert.deepStrictEqual(Array.from(canvas.put.data).slice(0, 3), [255, 100, 100]);
});

const NEWER = { ...META, receivedAt: 1700000005000, filename: "frame-8.jpg", pass: true, text: "pass · align 0.031 · 380ms" };
const NEWER_EVENT = { ...EVENT, receivedAt: NEWER.receivedAt, pass: true, text: NEWER.text };

test("the viewer opens paused, holding the frame it was clicked on, and stays on it as frames go by", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.open();
	const btn = () => h.viewer().find((e) => e.id === "golden-compare-stage-pause");
	assert.strictEqual(h.holds().length, 1, "held on open");
	assert.strictEqual(h.holds()[0].type, "POST");
	assert.strictEqual(h.holds()[0].url, "golden-compare/last/gc1/hold");
	assert.deepStrictEqual(JSON.parse(h.holds()[0].data), { receivedAt: 1700000000000 }, "names the frame it opened on");
	assert.strictEqual(btn().textContent, "▶ Go live");
	assert.ok(h.viewer().find((e) => e.textContent === "paused on this frame"));
	// a newer frame does not move it
	h.live.meta = NEWER;
	h.publish(NEWER_EVENT);
	assert.strictEqual(h.requests.length, 1, "no refetch while paused");
	assert.ok(h.viewer().find((e) => e.textContent === "frame-7.jpg"), "still the held frame");
	// stepping while paused asks for the held frame's images
	h.key("ArrowRight");
	assert.match(h.viewer().find((e) => e.tag === "img").src, /targetGray[?]t=1700000000000$/);
	// the thumbnail under the node followed regardless
	assert.ok(h.panel().find((e) => e.textContent === NEWER.text));
});

test("go live releases the hold, catches up, and then follows each frame keeping its place", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.open();
	h.key("ArrowRight"); // stage 2
	h.key("o");
	h.live.meta = NEWER;
	h.key("p");
	assert.deepStrictEqual(h.holds().map((c) => c.type), ["POST", "DELETE"]);
	assert.strictEqual(h.holds()[1].url, "golden-compare/last/gc1/hold");
	assert.strictEqual(h.requests.length, 2, "refetched on going live");
	let v = h.viewer();
	assert.ok(v.find((e) => e.textContent === "frame-8.jpg"), "caught up");
	assert.ok(v.find((e) => e.textContent === "live · follows each frame"));
	assert.strictEqual(v.find((e) => e.id === "golden-compare-stage-pause").textContent, "⏸ Pause");
	assert.strictEqual(h.holds().length, 2, "going live does not hold again");
	const img = v.find((e) => e.tag === "img");
	assert.strictEqual(img.src, "golden-compare/last/gc1/stage/targetGray?t=1700000005000", "same stage, new frame");
	assert.strictEqual(v.find((e) => e.id === "golden-compare-stage-overlay").checked, true, "the overlay carried over");
	// the next frame lands and the viewer follows
	const THIRD = { ...NEWER, receivedAt: 1700000009000, filename: "frame-9.jpg" };
	h.live.meta = THIRD;
	h.publish({ ...NEWER_EVENT, receivedAt: THIRD.receivedAt });
	assert.strictEqual(h.requests.length, 3);
	v = h.viewer();
	assert.ok(v.find((e) => e.textContent === "frame-9.jpg"));
	assert.strictEqual(h.bodyEl.children.filter((c) => c.id === "golden-compare-stage-viewer").length, 1);
	// the same frame announced again, or another node's, is not a refresh
	h.publish({ ...NEWER_EVENT, receivedAt: THIRD.receivedAt });
	h.publish({ ...NEWER_EVENT, id: "other", receivedAt: 1700000012000 });
	assert.strictEqual(h.requests.length, 3);
	// and pause holds the frame it is on now
	h.key("p");
	assert.strictEqual(h.holds().length, 3);
	assert.deepStrictEqual(JSON.parse(h.holds()[2].data), { receivedAt: THIRD.receivedAt });
	assert.strictEqual(h.viewer().find((e) => e.id === "golden-compare-stage-pause").textContent, "▶ Go live");
});

test("closing releases the hold; a hold refused because the frame has gone retries on the newer one, then gives up live", () => {
	const h = boot(NODE, { meta: META });
	h.publish(EVENT);
	h.open();
	h.key("Escape");
	assert.deepStrictEqual(h.holds().map((c) => c.type), ["POST", "DELETE"]);
	// and the viewer said it was open on the way in, and gone on the way out
	assert.deepStrictEqual(h.watches().map((c) => c.type), ["POST", "DELETE"]);
	assert.strictEqual(h.watches()[0].url, "golden-compare/last/gc1/watch");
	assert.strictEqual(h.viewer(), null);

	const r = boot(NODE, { meta: META, holdFail: "that frame has already been replaced" });
	r.publish(EVENT);
	r.open();
	assert.strictEqual(r.holds().filter((c) => c.type === "POST").length, 4, "the open and three retries");
	assert.strictEqual(r.requests.length, 4, "each retry opened on the latest");
	assert.strictEqual(r.viewer().find((e) => e.id === "golden-compare-stage-pause").textContent, "⏸ Pause", "live in the end");
	assert.deepStrictEqual(r.notices, [
		{ text: "golden-compare: that frame has already been replaced - following live instead", kind: "warning" },
	]);
});
