/**
 * The region-detect editor: six options, and a read-only view of the last
 * result - the last frame with the detected regions drawn on it, a caption
 * with the counts, a table of the regions and a button that copies them as
 * JSON.
 *
 * The editor <script> is lifted out of the .html and run against the fake
 * DOM in helpers/fakeEditorDom.js, with a fake $.ajax that answers each
 * request when the test says so.
 */

const test = require("node:test");
const assert = require("node:assert");
const { makeEditorEnv } = require("./helpers/fakeEditorDom.js");
const { editorScript } = require("./helpers/previewDom.js");

const SCRIPT = editorScript("region-detect.html");
const BOOLEANS = ["graphics", "barcodes"];

const FRAME_HEADERS = {
	"X-Frame-Width": "1800",
	"X-Frame-Height": "1200",
	"X-Frame-Received": "2026-10-19T08:30:00.000Z",
};
const REGIONS = [
	{ name: "text1", label: "LOT", kind: "text", x: 100, y: 50, width: 400, height: 40, rotate: 0, score: 0.93 },
	{ name: "text2", label: "", kind: "text", x: 20, y: 100, width: 30, height: 300, rotate: 270, score: 0.81 },
	{ name: "barcode1", label: "", kind: "barcode", x: 600, y: 400, width: 300, height: 120, rotate: 0, score: 1 },
	{ name: "graphic1", label: "", kind: "graphic", x: 1000, y: 900, width: 1, height: 1, rotate: 0, score: 1 },
];
const RESULT = {
	regions: REGIONS,
	detect: { frameWidth: 1800, frameHeight: 1200, charHeight: 24, counts: { text: 2, barcode: 1, graphic: 1 } },
	received: "2026-10-19T08:30:00.000Z",
};

function fakeAjax() {
	const calls = [];
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
			calls.push({
				opts,
				resolve: (body, headers = {}) =>
					settle("done", [
						body,
						"success",
						{ getResponseHeader: (name) => (headers[name] === undefined ? null : String(headers[name])) },
					]),
				reject: (xhr = { status: 404 }) => settle("fail", [xhr]),
			});
			return chain;
		},
	};
	/** The requests made to one endpoint, in order. */
	const to = (kind) => calls.filter((c) => c.opts.url.includes("/last-" + kind + "/"));
	return { $, calls, to };
}

function withAjax(fn) {
	const ajax = fakeAjax();
	globalThis.$ = ajax.$;
	try {
		return fn(ajax);
	} finally {
		delete globalThis.$;
	}
}

/**
 * Boot the editor on `node` the way Node-RED does: each input filled from
 * the node's own value only, so a key the node lacks leaves a checkbox
 * unticked and a text input blank.
 */
function boot(node = {}, script = SCRIPT, { deferImages = false } = {}) {
	const env = makeEditorEnv({ script, imageSize: { width: 1800, height: 1200 }, deferImages });
	env.node = node;
	for (const key of Object.keys(env.def.defaults)) {
		const el = env.field(key);
		if (BOOLEANS.includes(key)) {
			el.type = "checkbox";
			el.checked = node[key] === true || node[key] === "true";
		} else el.value = node[key] === undefined ? "" : String(node[key]);
	}
	env.def.oneditprepare.call(node);
	return env;
}
/** A node as a new one from the palette carries every default. */
function fresh(id) {
	const env = makeEditorEnv({ script: SCRIPT });
	const node = { id };
	for (const [k, spec] of Object.entries(env.def.defaults)) node[k] = spec.value;
	return node;
}
const caption = (env) => env.document.getElementById("region-detect-caption").textContent;
const tableRows = (env) => env.document.getElementById("region-detect-table").children;
const canvasOps = (env) => env.document.getElementById("region-detect-canvas").getContext().ops();

/** Answer both requests of one open with the full result. */
function answer(ajax, i = 0) {
	ajax.to("frame")[i].resolve({ size: 1, type: "image/png" }, FRAME_HEADERS);
	ajax.to("regions")[i].resolve(JSON.parse(JSON.stringify(RESULT)));
}

// ---- defaults and save ------------------------------------------------------

test("the defaults are the runtime's: auto, 8, 0.7, true, true, 4", () => {
	const { def } = makeEditorEnv({ script: SCRIPT });
	const values = Object.fromEntries(Object.entries(def.defaults).map(([k, s]) => [k, s.value]));
	assert.deepStrictEqual(values, {
		name: "",
		orientation: "auto",
		minTextHeight: 8,
		minScore: 0.7,
		graphics: true,
		barcodes: true,
		pad: 4,
	});
});

test("oneditsave writes orientation as given, numbers as numbers and booleans as booleans", () => {
	const env = boot(fresh("s1"));
	env.field("orientation").value = "auto";
	env.field("minTextHeight").value = "12";
	env.field("minScore").value = "0.55";
	env.field("pad").value = "0";
	env.field("graphics").checked = false;
	env.def.oneditsave.call(env.node);
	assert.strictEqual(env.node.orientation, "auto");
	assert.strictEqual(env.node.minTextHeight, 12);
	assert.strictEqual(env.node.minScore, 0.55);
	assert.strictEqual(env.node.pad, 0);
	assert.strictEqual(env.node.graphics, false);
	assert.strictEqual(env.node.barcodes, true);

	const env2 = boot(fresh("s2"));
	env2.field("orientation").value = "270";
	env2.field("minTextHeight").value = "";
	env2.def.oneditsave.call(env2.node);
	assert.strictEqual(env2.node.orientation, 270);
	assert.strictEqual(env2.node.minTextHeight, 8, "a blank number saves the default");
});

test("an old node without graphics or barcodes gets them ticked on load", () => {
	const env = boot({ id: "old", name: "", orientation: "auto", minTextHeight: 8, minScore: 0.7, pad: 4 });
	assert.strictEqual(env.field("graphics").checked, true);
	assert.strictEqual(env.field("barcodes").checked, true);
	env.def.oneditsave.call(env.node);
	assert.strictEqual(env.node.graphics, true);
	assert.strictEqual(env.node.barcodes, true);

	// one saved with them off keeps them off
	const off = boot({ ...fresh("off"), graphics: false, barcodes: false });
	assert.strictEqual(off.field("graphics").checked, false);
	assert.strictEqual(off.field("barcodes").checked, false);
});

test("oneditcancel leaves the node's fields untouched", () => {
	withAjax((ajax) => {
		const node = { ...fresh("c1"), orientation: 90, minScore: 0.5 };
		const before = JSON.parse(JSON.stringify(node));
		const env = boot(node);
		answer(ajax);
		env.field("orientation").value = "auto";
		env.field("minScore").value = "0.9";
		env.field("graphics").checked = false;
		env.def.oneditcancel.call(env.node);
		assert.deepStrictEqual(env.node, before);
	});
});

// ---- the last result ----------------------------------------------------------

test("on open both endpoints are fetched for this node; the caption counts and the table lists every region", () => {
	withAjax((ajax) => {
		const env = boot(fresh("rd1"));
		assert.strictEqual(ajax.to("frame").length, 1);
		assert.strictEqual(ajax.to("regions").length, 1);
		assert.strictEqual(ajax.to("frame")[0].opts.url, "region-detect/last-frame/rd1");
		assert.deepStrictEqual(ajax.to("frame")[0].opts.xhrFields, { responseType: "blob" });
		assert.strictEqual(ajax.to("regions")[0].opts.url, "region-detect/last-regions/rd1");
		assert.doesNotThrow(() => answer(ajax));
		assert.match(caption(env), /2 text · 1 barcode · 1 graphic, charHeight 24, received /);
		const rows = tableRows(env);
		assert.strictEqual(rows.length, REGIONS.length);
		const text = rows[1].descendants().map((e) => e.textContent).join("|");
		for (const v of ["text2", "text", "270", "0.81", "20", "100", "30", "300"]) assert.ok(text.includes(v), `${v} in ${text}`);
		const ops = canvasOps(env);
		assert.ok(ops.includes("drawImage"), "the frame is drawn");
		assert.ok(ops.filter((o) => o === "strokeRect").length >= REGIONS.length, "a box per region");
		// the rotated text gets its arrow
		assert.ok(ops.includes("lineTo"));
		const strokes = env.document.getElementById("region-detect-canvas").getContext().calls;
		assert.ok(strokes.length > 0);
	});
});

test("the regions arriving before the frame are drawn once the frame is in", () => {
	withAjax((ajax) => {
		const env = boot(fresh("rd2"));
		ajax.to("regions")[0].resolve(JSON.parse(JSON.stringify(RESULT)));
		assert.strictEqual(tableRows(env).length, REGIONS.length);
		ajax.to("frame")[0].resolve({ size: 1, type: "image/png" }, FRAME_HEADERS);
		assert.ok(canvasOps(env).includes("drawImage"));
		assert.match(caption(env), /2 text · 1 barcode · 1 graphic/);
	});
});

test("a 404 on either endpoint says no result yet, quietly", () => {
	for (const which of ["frame", "regions", "both"]) {
		withAjax((ajax) => {
			const env = boot(fresh("n-" + which));
			const no = { status: 404, responseJSON: { ok: false, error: "no frame yet" } };
			assert.doesNotThrow(() => {
				if (which === "frame" || which === "both") ajax.to("frame")[0].reject(no);
				else ajax.to("frame")[0].resolve({ size: 1, type: "image/png" }, FRAME_HEADERS);
				if (which === "regions" || which === "both") ajax.to("regions")[0].reject(no);
				else ajax.to("regions")[0].resolve(JSON.parse(JSON.stringify(RESULT)));
			});
			assert.strictEqual(env.notifications.length, 0, `no toast (${which})`);
			if (which === "frame") {
				// the regions are still the last result; only the picture is missing
				assert.match(caption(env), /^2 text · 1 barcode · 1 graphic, .*\(no frame to show\)$/);
				assert.strictEqual(tableRows(env).length, REGIONS.length);
			} else {
				assert.match(caption(env), /no result yet/, which);
				assert.strictEqual(tableRows(env).length, 0, which);
			}
		});
	}
});

test("a last frame that does not decode says so", () => {
	withAjax((ajax) => {
		const broken = "Image = class { set src(_url) { this.onerror(); } };\n";
		const env = boot(fresh("bad"), broken + SCRIPT);
		assert.doesNotThrow(() => answer(ajax));
		assert.match(caption(env), /does not decode/);
		assert.strictEqual(env.URL.revoked, env.URL.created, "the URL is released");
	});
});

test("an answer to a fetch made before Reload is ignored", () => {
	withAjax((ajax) => {
		const env = boot(fresh("late"));
		env.document.getElementById("region-detect-reload").dispatch("click");
		assert.strictEqual(ajax.to("frame").length, 2, "Reload fetches again");
		assert.strictEqual(ajax.to("regions").length, 2);
		// the new pair says nothing yet; the old pair answers late
		ajax.to("frame")[1].reject();
		ajax.to("regions")[1].reject();
		assert.match(caption(env), /no result yet/);
		answer(ajax, 0);
		assert.match(caption(env), /no result yet/, "the stale answer did not land");
		assert.strictEqual(tableRows(env).length, 0);
		assert.ok(!canvasOps(env).includes("drawImage"));
		assert.strictEqual(env.URL.created, 0, "the stale frame was never decoded");
	});
});

test("without jQuery the dialog still opens", () => {
	assert.strictEqual(typeof globalThis.$, "undefined");
	assert.doesNotThrow(() => boot(fresh("nojq")));
});

// ---- copy -----------------------------------------------------------------------

test("Copy regions JSON writes the regions to the clipboard and notifies once", async () => {
	const written = [];
	const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", {
		value: { clipboard: { writeText: (t) => (written.push(t), Promise.resolve()) } },
		configurable: true,
	});
	try {
		await withAjax(async (ajax) => {
			const env = boot(fresh("cp"));
			answer(ajax);
			env.document.getElementById("region-detect-copy").dispatch("click");
			await new Promise((r) => setImmediate(r));
			assert.deepStrictEqual(written, [JSON.stringify(REGIONS)]);
			assert.strictEqual(env.notifications.length, 1);
			assert.strictEqual(env.notifications[0].kind, "success");
		});
	} finally {
		if (prev) Object.defineProperty(globalThis, "navigator", prev);
		else delete globalThis.navigator;
	}
});

// ---- review follow-ups ----------------------------------------------------------

/** The strokeStyle in force at each strokeRect, recorded from now on. */
function recordBoxColours(env) {
	const ctx = env.document.getElementById("region-detect-canvas").getContext();
	const colours = [];
	const strokeRect = ctx.strokeRect;
	ctx.strokeRect = (...args) => {
		colours.push(ctx.strokeStyle);
		strokeRect(...args);
	};
	return colours;
}

test("each box is stroked in its kind's colour: text red, barcode blue, graphic green", () => {
	withAjax((ajax) => {
		const env = boot(fresh("col"));
		const colours = recordBoxColours(env);
		answer(ajax);
		const RED_ = "#e53935";
		const BLUE = "#1e88e5";
		const GREEN = "#43a047";
		assert.deepStrictEqual(colours.slice(-REGIONS.length), [RED_, RED_, BLUE, GREEN]);
	});
});

test("a frame and regions from different messages are fetched again once, and a match then shows plainly", () => {
	withAjax((ajax) => {
		const env = boot(fresh("pair"));
		ajax.to("frame")[0].resolve({ size: 1, type: "image/png" }, { ...FRAME_HEADERS, "X-Frame-Received": "2026-10-19T08:29:00.000Z" });
		ajax.to("regions")[0].resolve(JSON.parse(JSON.stringify(RESULT)));
		assert.strictEqual(ajax.to("frame").length, 2, "one refetch of the frame");
		assert.strictEqual(ajax.to("regions").length, 2, "one refetch of the regions");
		answer(ajax, 1);
		assert.strictEqual(ajax.calls.length, 4, "exactly two rounds");
		assert.match(caption(env), /^2 text · 1 barcode · 1 graphic, charHeight 24, received [^(]*$/);
	});
});

test("a pair still from different messages after the refetch is shown and called out", () => {
	withAjax((ajax) => {
		const env = boot(fresh("pair2"));
		const other = { ...FRAME_HEADERS, "X-Frame-Received": "2026-10-19T08:29:00.000Z" };
		for (const i of [0, 1]) {
			ajax.to("frame")[i].resolve({ size: 1, type: "image/png" }, other);
			ajax.to("regions")[i].resolve(JSON.parse(JSON.stringify(RESULT)));
		}
		assert.strictEqual(ajax.calls.length, 4, "no third round");
		assert.match(caption(env), /\(frame and regions from different messages\)$/);
		assert.strictEqual(tableRows(env).length, REGIONS.length);
	});
});

test("the numeric validators flag values out of range and accept blank", () => {
	const { def } = makeEditorEnv({ script: SCRIPT });
	const v = (key, value) => def.defaults[key].validate.call({}, value);
	assert.strictEqual(v("pad", "-3"), false);
	assert.strictEqual(v("pad", "0"), true);
	assert.strictEqual(v("minScore", "5"), false);
	assert.strictEqual(v("minScore", "0.7"), true);
	assert.strictEqual(v("minTextHeight", "0"), false);
	assert.strictEqual(v("minTextHeight", "8"), true);
	for (const key of ["pad", "minScore", "minTextHeight"]) assert.strictEqual(v(key, ""), true, key);

	const env = boot(fresh("val"));
	env.field("pad").value = "-3";
	env.def.oneditsave.call(env.node);
	assert.strictEqual(v("pad", env.node.pad), false, "the saved -3 is flagged");
});

test("an orientation that is not auto/0/90/180/270 saves as auto", () => {
	const env = boot(fresh("o1"));
	env.field("orientation").value = "45";
	env.def.oneditsave.call(env.node);
	assert.strictEqual(env.node.orientation, "auto");
});

test("a frame that finishes decoding after Cancel is dropped and its URL revoked", () => {
	withAjax((ajax) => {
		const env = boot(fresh("late-img"), SCRIPT, { deferImages: true });
		answer(ajax);
		assert.strictEqual(env.pendingImages.length, 1);
		env.def.oneditcancel.call(env.node);
		const ctx = env.document.getElementById("region-detect-canvas").getContext();
		const before = ctx.calls.length;
		env.pendingImages[0].load();
		assert.strictEqual(ctx.calls.length, before, "nothing drawn after Cancel");
		assert.strictEqual(env.URL.created, 1);
		assert.strictEqual(env.URL.revoked, 1, "revoked exactly once");
	});
});

test("a stale frame never draws under the regions of a newer fetch", () => {
	withAjax((ajax) => {
		const env = boot(fresh("race"), SCRIPT, { deferImages: true });
		ajax.to("frame")[0].resolve({ size: 1, type: "image/png" }, FRAME_HEADERS);
		env.document.getElementById("region-detect-reload").dispatch("click");
		// the newer fetch: regions arrive, no frame
		ajax.to("frame")[1].reject();
		ajax.to("regions")[1].resolve(JSON.parse(JSON.stringify(RESULT)));
		// the old frame decodes now
		env.pendingImages[0].load();
		assert.ok(!canvasOps(env).includes("drawImage"), "the stale frame is not drawn");
		assert.match(caption(env), /\(no frame to show\)$/);
		assert.strictEqual(env.URL.revoked, env.URL.created);
	});
});
