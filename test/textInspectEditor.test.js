/**
 * The text-inspect editor: a list of axis-aligned rectangles over the
 * node's last frame, drawn in a zoom viewer or typed into rows, and the
 * size of the frame they were drawn on.
 *
 * The editor <script> is lifted out of the .html and run against the
 * fake DOM in helpers/fakeEditorDom.js, as test/lineFinderEditor.test.js
 * does. The fake frame is larger than the viewer, so the viewer opens
 * at a scale well below 1 and a region stored in screen pixels instead
 * of frame pixels cannot pass.
 */

const test = require("node:test");
const assert = require("node:assert");
const { makeEditorEnv } = require("./helpers/fakeEditorDom.js");
const { editorScript } = require("./helpers/previewDom.js");

const SCRIPT = editorScript("text-inspect.html");

// the frame the fake Image reports, and what fitting it into the fake
// 900x600 viewer body gives: min(900/1800, 600/1200, 1) * 0.96
const IMG = { width: 1800, height: 1200 };
const FIT = { scale: 0.48, ox: 18, oy: 12 };
const toScreen = (x, y) => [FIT.ox + x * FIT.scale, FIT.oy + y * FIT.scale];

const FRAME_HEADERS = {
	"X-Frame-Width": "1800",
	"X-Frame-Height": "1200",
	"X-Frame-Received": new Date().toISOString(),
};

function fakeAjax() {
	const frames = [];
	const $ = {
		ajax(opts) {
			const handlers = { done: [], fail: [], always: [] };
			const chain = {};
			for (const k of Object.keys(handlers)) {
				chain[k] = (fn) => {
					handlers[k].push(fn);
					return chain;
				};
			}
			const settle = (kind, args) => {
				for (const fn of handlers[kind]) fn(...args);
				for (const fn of handlers.always) fn();
			};
			frames.push({
				opts,
				resolve: (blob, headers = {}) =>
					settle("done", [
						blob,
						"success",
						{ getResponseHeader: (name) => (headers[name] === undefined ? null : String(headers[name])) },
					]),
				reject: (xhr = { status: 404 }) => settle("fail", [xhr]),
			});
			return chain;
		},
	};
	return { $, frames };
}

/** Boot with a fake $ in scope, run the body, and take the fake down again. */
function withAjax(fn) {
	const ajax = fakeAjax();
	globalThis.$ = ajax.$;
	try {
		return fn(ajax);
	} finally {
		delete globalThis.$;
	}
}

/** Boot the editor on `node`, the object oneditprepare/oneditsave see as `this`. */
function boot(node = {}, script = SCRIPT, imageSize = IMG) {
	const env = makeEditorEnv({ script, imageSize });
	env.node = node;
	// Node-RED fills each node-input from the node, or the default
	for (const [key, spec] of Object.entries(env.def.defaults)) {
		const v = node[key] !== undefined ? node[key] : spec.value;
		if (v !== undefined && v !== null && typeof v !== "object") env.field(key).value = String(v);
	}
	env.def.oneditprepare.call(node);
	return env;
}
function save(env) {
	env.def.oneditsave.call(env.node);
	return env.node.regions;
}
const rows = (env) => env.document.getElementById("text-inspect-region-list").children;
/** The input for `key` (name, x, y, width, height) in row `i`. */
const cell = (env, i, key) => rows(env)[i].descendants().find((e) => e.tagName === "INPUT" && e.name === key);
const caption = (env) => env.document.getElementById("text-inspect-frame-caption").textContent;

function loadFile(env) {
	const input = env.document.getElementById("text-inspect-file");
	input.files = [{ name: "frame.png" }];
	input.dispatch("change");
}
function openViewer(env) {
	env.document.getElementById("text-inspect-open-viewer").dispatch("click");
	const overlay = env.overlay();
	const canvas = overlay.descendants().find((e) => e.tagName === "CANVAS");
	return { overlay, canvas, button: (label) => overlay.findButton(label) };
}
function drag(canvas, from, to) {
	const ev = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1 });
	canvas.dispatch("pointerdown", ev(from[0], from[1]));
	for (let i = 1; i <= 4; i++) {
		canvas.dispatch("pointermove", ev(from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4));
	}
	canvas.dispatch("pointerup", ev(to[0], to[1]));
}

const TWO = [
	{ name: "lot", x: 100, y: 200, width: 400, height: 100 },
	{ name: "date", x: 600, y: 200, width: 300, height: 80 },
];
/** A region as saved: a stored one without rotate is read at 0. */
const R0 = (r) => ({ ...r, rotate: 0 });
const TWO0 = TWO.map(R0);
const rotateSelect = (env, i) => rows(env)[i].descendants().find((e) => e.tagName === "SELECT" && e.name === "rotate");

// ---- the viewer -----------------------------------------------------------

test("a drag on the viewer adds a region in frame pixels, not screen pixels", () => {
	const env = boot({ id: "t1" });
	loadFile(env);
	const v = openViewer(env);
	drag(v.canvas, toScreen(100, 200), toScreen(500, 300));
	v.button("Apply").click();
	assert.strictEqual(env.document.body.children.length, 0, "Apply closes the viewer");
	assert.deepStrictEqual(save(env), [{ name: "text1", x: 100, y: 200, width: 400, height: 100, rotate: 0 }]);
});

test("in the viewer a drag inside a region moves it and a corner handle resizes it; Cancel keeps nothing", () => {
	const env = boot({ id: "t2", regions: TWO.map((r) => ({ ...r })) });
	loadFile(env);
	let v = openViewer(env);
	// grab "lot" by its middle and move it 50 frame px right and 20 down
	drag(v.canvas, toScreen(300, 250), toScreen(350, 270));
	// its bottom-right corner, now at 550,320, out to 600,400
	drag(v.canvas, toScreen(550, 320), toScreen(600, 400));
	v.button("Apply").click();
	const saved = save(env);
	assert.deepStrictEqual(saved[0], { name: "lot", x: 150, y: 220, width: 450, height: 180, rotate: 0 });
	assert.deepStrictEqual(saved[1], TWO0[1], "the other region is untouched");

	const env2 = boot({ id: "t2", regions: TWO.map((r) => ({ ...r })) });
	loadFile(env2);
	v = openViewer(env2);
	drag(v.canvas, toScreen(1000, 600), toScreen(1200, 700));
	v.button("Cancel").click();
	assert.deepStrictEqual(save(env2), TWO0, "a cancelled viewer changes nothing");
});

test("a click on the viewer without a drag adds no region", () => {
	const env = boot({ id: "t3" });
	loadFile(env);
	const v = openViewer(env);
	drag(v.canvas, toScreen(100, 200), toScreen(100.5, 200.5));
	v.button("Apply").click();
	assert.deepStrictEqual(save(env), []);
});

// ---- the frame --------------------------------------------------------------

test("loading the last frame fetches it for this node and stores its size from the headers", () => {
	withAjax((ajax) => {
		const env = boot({ id: "ti1" });
		assert.strictEqual(ajax.frames.length, 1, "one fetch when the dialog opens");
		const { opts } = ajax.frames[0];
		assert.strictEqual(opts.url, "text-inspect/last-frame/ti1");
		assert.strictEqual(opts.type, "GET");
		assert.deepStrictEqual(opts.xhrFields, { responseType: "blob" });
		// the headers, not the decoded image, say the size
		ajax.frames[0].resolve({ size: 1, type: "image/png" }, { ...FRAME_HEADERS, "X-Frame-Width": "1801", "X-Frame-Height": "1201" });
		assert.strictEqual(Number(env.field("frameWidth").value), 1801);
		assert.strictEqual(Number(env.field("frameHeight").value), 1201);
		assert.match(caption(env), /last frame through this node.*1801×1201/);
		assert.ok(env.document.getElementById("text-inspect-canvas").getContext().ops().includes("drawImage"));
		save(env);
		assert.strictEqual(env.node.frameWidth, 1801);
		assert.strictEqual(env.node.frameHeight, 1201);

		env.document.getElementById("text-inspect-reload-frame").dispatch("click");
		assert.strictEqual(ajax.frames.length, 2, "Reload fetches again");
		assert.strictEqual(ajax.frames[1].opts.url, "text-inspect/last-frame/ti1");
	});
});

const HALF = { width: 900, height: 600 };
const HALF_HEADERS = { ...FRAME_HEADERS, "X-Frame-Width": "900", "X-Frame-Height": "600" };

test("a frame of another size leaves the stored size and regions alone and the caption names both", () => {
	withAjax((ajax) => {
		const lot = { name: "lot", x: 100, y: 200, width: 400, height: 100 };
		const env = boot({ id: "ti2", frameWidth: 1800, frameHeight: 1200, regions: [{ ...lot }] }, SCRIPT, HALF);
		ajax.frames[0].resolve({ size: 1, type: "image/png" }, HALF_HEADERS);
		assert.match(caption(env), /Drawn on 1800×1200, frame is 900×600/);
		save(env);
		assert.deepStrictEqual(env.node.regions, [R0(lot)]);
		assert.strictEqual(env.node.frameWidth, 1800);
		assert.strictEqual(env.node.frameHeight, 1200);
	});
});

test("with no stored size and no regions the loaded frame's size is adopted", () => {
	withAjax((ajax) => {
		const env = boot({ id: "ti3", frameWidth: 0, frameHeight: 0, regions: [] }, SCRIPT, HALF);
		ajax.frames[0].resolve({ size: 1, type: "image/png" }, HALF_HEADERS);
		save(env);
		assert.strictEqual(env.node.frameWidth, 900);
		assert.strictEqual(env.node.frameHeight, 600);
	});
});

test("a drag over a smaller frame shown stretched to the stored size gives stored-size coordinates", () => {
	const env = boot({ id: "ti4", frameWidth: 1800, frameHeight: 1200, regions: [{ name: "lot", x: 100, y: 200, width: 400, height: 100 }] }, SCRIPT, HALF);
	loadFile(env);
	const v = openViewer(env);
	// the view is fitted to 1800x1200, so FIT still applies
	drag(v.canvas, toScreen(1000, 600), toScreen(1400, 800));
	v.button("Apply").click();
	assert.deepStrictEqual(save(env)[1], { name: "text1", x: 1000, y: 600, width: 400, height: 200, rotate: 0 });
	assert.strictEqual(env.node.frameWidth, 1800);
});

test("a fetch that answers after a file was chosen does not replace the file", () => {
	withAjax((ajax) => {
		const env = boot({ id: "ti5" });
		loadFile(env);
		ajax.frames[0].resolve({ size: 1, type: "image/png" }, HALF_HEADERS);
		assert.match(caption(env), /^sample from frame.png/);
		save(env);
		assert.strictEqual(env.node.frameWidth, 1800);
		assert.strictEqual(env.node.frameHeight, 1200);
		assert.strictEqual(env.URL.created, 1, "the stale frame was never decoded");
	});
});

test("moving or resizing a region in the viewer stops at the frame edge", () => {
	const env = boot({ id: "c1", regions: [{ ...TWO[0] }] });
	loadFile(env);
	const v = openViewer(env);
	drag(v.canvas, toScreen(300, 250), toScreen(2300, 250));
	// its bottom-right corner, now at 1800,300, dragged past the bottom
	drag(v.canvas, toScreen(1800, 300), toScreen(1800, 1500));
	v.button("Apply").click();
	const r = save(env)[0];
	assert.strictEqual(r.x + r.width, 1800);
	assert.strictEqual(r.width, 400);
	assert.strictEqual(r.y + r.height, 1200);
});

test("Done or Cancel with the viewer open closes it and its window listeners", () => {
	for (const how of ["oneditcancel", "oneditsave"]) {
		const env = boot({ id: "v-" + how });
		loadFile(env);
		openViewer(env);
		assert.strictEqual(env.window.listenerCount("keydown"), 1);
		env.def[how].call(env.node);
		assert.strictEqual(env.window.listenerCount("keydown"), 0, how);
		assert.strictEqual(env.window.listenerCount("resize"), 0, how);
		assert.strictEqual(env.document.body.children.length, 0, how);
	}
});

test("a 404 from last-frame says there is no frame yet and does not throw", () => {
	withAjax((ajax) => {
		const env = boot({ id: "fresh", regions: TWO.map((r) => ({ ...r })) });
		assert.doesNotThrow(() => ajax.frames[0].reject({ status: 404, responseJSON: { ok: false, error: "no frame yet" } }));
		assert.match(caption(env), /^no frame yet/);
		assert.strictEqual(env.notifications.length, 0, "a quiet 404, no error toast");
		save(env);
		assert.deepStrictEqual(env.node.regions, TWO0);
		assert.strictEqual(env.node.frameWidth, 0, "no frame, the size stays unknown");
	});
});

test("a fetched frame that does not decode says so and stores no size", () => {
	withAjax((ajax) => {
		const broken = "Image = class { set src(_url) { this.onerror(); } };\n";
		const env = boot({ id: "bad" }, broken + SCRIPT);
		assert.doesNotThrow(() => ajax.frames[0].resolve({ size: 1, type: "image/png" }, FRAME_HEADERS));
		assert.match(caption(env), /does not decode/);
		assert.match(env.notifications[0].message, /does not decode/);
		assert.strictEqual(Number(env.field("frameWidth").value), 0);
		assert.strictEqual(env.URL.revoked, env.URL.created, "the failed frame's URL is released");
	});
});

test("without jQuery the dialog still opens; the frame is simply not fetched", () => {
	assert.strictEqual(typeof globalThis.$, "undefined");
	const env = boot({ id: "nojq" });
	assert.strictEqual(caption(env), "");
});

test("a local file is a frame too: its size is stored", () => {
	const env = boot({ id: "f1" });
	loadFile(env);
	save(env);
	assert.strictEqual(env.node.frameWidth, 1800);
	assert.strictEqual(env.node.frameHeight, 1200);
	env.def.oneditcancel.call(env.node);
	assert.strictEqual(env.URL.revoked, env.URL.created);
});

// ---- the list and what is saved ---------------------------------------------

test("oneditsave writes regions as an array of numeric {name,x,y,width,height,rotate}, never a string", () => {
	// a node whose regions came in as a JSON string still saves an array
	const env = boot({ id: "s1", regions: JSON.stringify(TWO), frameWidth: "1800", frameHeight: "1200" });
	assert.strictEqual(rows(env).length, 2);
	const saved = save(env);
	assert.ok(Array.isArray(saved), `regions saved as ${typeof saved}`);
	assert.deepStrictEqual(saved, TWO0);
	for (const r of saved) {
		assert.deepStrictEqual(Object.keys(r), ["name", "x", "y", "width", "height", "rotate"]);
		for (const k of ["x", "y", "width", "height", "rotate"]) assert.strictEqual(typeof r[k], "number", k);
	}
	assert.strictEqual(env.node.frameWidth, 1800);
	assert.strictEqual(env.node.frameHeight, 1200);

	const empty = boot({ id: "s2" });
	assert.deepStrictEqual(save(empty), []);
	assert.strictEqual(empty.node.frameWidth, 0);
});

test("editing name, x, y, width or height in a row updates the saved region", () => {
	const env = boot({ id: "e1", regions: TWO.map((r) => ({ ...r })) });
	const edits = { name: "lot no", x: "110", y: "205.5", width: "390", height: "90" };
	for (const [k, v] of Object.entries(edits)) {
		const el = cell(env, 0, k);
		assert.ok(el, `row 0 has a ${k} input`);
		assert.strictEqual(String(el.value), String(TWO[0][k]));
		el.value = v;
		el.dispatch("input");
	}
	// a value that is not a number keeps the last good one
	cell(env, 1, "x").value = "abc";
	cell(env, 1, "x").dispatch("input");
	const saved = save(env);
	assert.deepStrictEqual(saved[0], { name: "lot no", x: 110, y: 205.5, width: 390, height: 90, rotate: 0 });
	assert.deepStrictEqual(saved[1], TWO0[1]);
});

test("Add appends a region and a row's remove button drops it", () => {
	const env = boot({ id: "a1", regions: TWO.map((r) => ({ ...r })) });
	env.document.getElementById("text-inspect-region-add").dispatch("click");
	assert.strictEqual(rows(env).length, 3);
	let saved = save(env);
	assert.strictEqual(saved.length, 3);
	assert.strictEqual(saved[2].name, "text1");
	assert.ok(saved[2].width > 0 && saved[2].height > 0);
	assert.strictEqual(saved[2].rotate, 0, "an added region reads upright");

	const env2 = boot({ id: "a2", regions: TWO.map((r) => ({ ...r })) });
	rows(env2)[0].findButton("✕").dispatch("click");
	saved = save(env2);
	assert.deepStrictEqual(saved, [TWO0[1]]);
});

test("a region past the frame is called out in its row", () => {
	const env = boot({ id: "o1", regions: [TWO[0], { name: "far", x: 1700, y: 100, width: 400, height: 50 }] });
	loadFile(env);
	assert.doesNotMatch(rows(env)[0].descendants().map((e) => e.textContent).join(" "), /past the frame/);
	assert.match(rows(env)[1].descendants().map((e) => e.textContent).join(" "), /past the frame/);
});

test("a typed coordinate past the stored frame is clamped to it", () => {
	const env = boot({ id: "k1", frameWidth: 1800, frameHeight: 1200, regions: [{ ...TWO[0] }] });
	cell(env, 0, "x").value = "5000";
	cell(env, 0, "x").dispatch("input");
	cell(env, 0, "height").value = "5000";
	cell(env, 0, "height").dispatch("input");
	assert.deepStrictEqual(save(env)[0], { name: "lot", x: 1400, y: 200, width: 400, height: 1000, rotate: 0 });
});

test("a drag where two regions overlap moves the selected one", () => {
	const a = { name: "a", x: 100, y: 100, width: 400, height: 200 };
	const b = { name: "b", x: 300, y: 100, width: 400, height: 200 };
	const env = boot({ id: "k2", regions: [{ ...a }, { ...b }] });
	loadFile(env);
	const v = openViewer(env);
	drag(v.canvas, toScreen(400, 200), toScreen(450, 200));
	v.button("Apply").click();
	const saved = save(env);
	assert.strictEqual(saved[0].x, 150, "the selected region moved");
	assert.deepStrictEqual(saved[1], R0(b));
});

test("a new drag past the frame edge is clamped to the frame", () => {
	const env = boot({ id: "k3" });
	loadFile(env);
	const v = openViewer(env);
	drag(v.canvas, toScreen(1600, 1000), toScreen(2200, 1500));
	v.button("Apply").click();
	assert.deepStrictEqual(save(env), [{ name: "text1", x: 1600, y: 1000, width: 200, height: 200, rotate: 0 }]);
});

// ---- rotate -------------------------------------------------------------------

test("each row has a rotate select of 0/90/180/270; a change is saved as a number", () => {
	const env = boot({ id: "r1", regions: [{ ...TWO[0] }, { ...TWO[1], rotate: "270" }] });
	const sel = rotateSelect(env, 0);
	assert.ok(sel, "row 0 has a rotate select");
	const options = sel.children.filter((e) => e.tagName === "OPTION");
	assert.deepStrictEqual(options.map((o) => String(o.value)), ["0", "90", "180", "270"]);
	assert.deepStrictEqual(options.map((o) => o.textContent), ["0°", "90°", "180°", "270°"]);
	assert.strictEqual(String(sel.value), "0", "a region without rotate shows 0");
	assert.strictEqual(String(rotateSelect(env, 1).value), "270");

	sel.value = "90";
	sel.dispatch("change");
	const saved = save(env);
	assert.strictEqual(saved[0].rotate, 90);
	assert.strictEqual(saved[1].rotate, 270, "a stored string is saved as a number");
});

test("rotated regions draw in the thumbnail and viewer without throwing and keep their rotate", () => {
	const regions = [
		{ name: "up", x: 100, y: 100, width: 60, height: 400, rotate: 90 },
		{ name: "flip", x: 300, y: 100, width: 400, height: 60, rotate: 180 },
		{ name: "down", x: 800, y: 100, width: 60, height: 400, rotate: 270 },
	];
	const env = boot({ id: "r2", regions: regions.map((r) => ({ ...r })) });
	assert.doesNotThrow(() => loadFile(env));
	let v;
	assert.doesNotThrow(() => {
		v = openViewer(env);
		// move "down" 50 frame px right, then draw a new region
		drag(v.canvas, toScreen(830, 300), toScreen(880, 300));
		drag(v.canvas, toScreen(1000, 800), toScreen(1400, 900));
	});
	v.button("Apply").click();
	const saved = save(env);
	assert.deepStrictEqual(saved.map((r) => r.rotate), [90, 180, 270, 0]);
	assert.strictEqual(saved[2].x, 850, "the moved region kept its rotate");
});

test("a stored rotate that is not 0/90/180/270 shows 0 and warns once, naming the region and the value", () => {
	const env = boot({
		id: "r3",
		regions: [
			{ ...TWO[0], rotate: 45 },
			{ ...TWO[1], rotate: "90abc" },
			{ name: "ok", x: 0, y: 0, width: 10, height: 10, rotate: "180" },
		],
	});
	assert.strictEqual(String(rotateSelect(env, 0).value), "0");
	assert.strictEqual(String(rotateSelect(env, 1).value), "0");
	assert.strictEqual(env.notifications.length, 1, "one warning per load");
	const { message, kind } = env.notifications[0];
	assert.strictEqual(kind, "warning");
	assert.match(message, /lot/);
	assert.match(message, /45/);
	assert.match(message, /date/);
	assert.match(message, /90abc/);
	assert.doesNotMatch(message, /\bok\b/);
	assert.deepStrictEqual(save(env).map((r) => r.rotate), [0, 0, 180]);
});
