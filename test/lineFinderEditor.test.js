/**
 * The line-finder editor's region selector: thumbnail, zoom viewer, and
 * the drag/resize/rotate/nudge editing in it.
 *
 * This is UI, but it is UI made of coordinate arithmetic, and the way it
 * fails is silent - a region drawn in one place and searched in another.
 * So the editor <script> is lifted out of the .html and run against the
 * small fake DOM in helpers/fakeEditorDom.js, with the view transform
 * pinned by clicking "Fit" first so screen coordinates can be worked out
 * by hand.
 *
 * test/editorRegionGeometry.test.js covers the other half: that the
 * editor's copy of the region geometry still matches the runtime's, and
 * the crop/explanation maths behind the Run button.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { makeEditorEnv } = require("./helpers/fakeEditorDom.js");

const HTML = path.join(__dirname, "..", "line-finder.html");
const html = fs.readFileSync(HTML, "utf8");
const SCRIPT = (() => {
	const m = html.match(/<script type="text\/javascript">\n([\s\S]*)\n<\/script>\s*$/);
	assert.ok(m, "could not find the editor script in line-finder.html");
	return m[1];
})();
// The thumbnail's pixel size comes from the template's own attributes, so
// a change to the markup cannot quietly invalidate the coordinates below.
const THUMB = (() => {
	const m = html.match(/id="line-finder-canvas"\s+width="(\d+)"\s+height="(\d+)"/);
	assert.ok(m, "could not read the thumbnail size out of the template");
	return { width: Number(m[1]), height: Number(m[2]) };
})();

// the synthetic frame the fake Image reports
const IMG = { width: 800, height: 600 };
// what fitView() produces for a 900x600 viewer body and that frame
const FIT = { scale: 0.96, ox: 66, oy: 12 };
const toScreen = (x, y) => [FIT.ox + x * FIT.scale, FIT.oy + y * FIT.scale];

/** Boot the editor on `node` - the object oneditprepare/oneditsave see as `this`. */
function boot(overrides = {}, node = {}) {
	const env = makeEditorEnv({ script: SCRIPT, imageSize: IMG });
	env.node = node;
	const thumb = env.document.getElementById("line-finder-canvas");
	thumb.width = THUMB.width;
	thumb.height = THUMB.height;
	for (const [key, spec] of Object.entries(env.def.defaults)) {
		const el = env.field(key);
		if (spec.value !== undefined && spec.value !== null) el.value = spec.value;
	}
	for (const [key, value] of Object.entries(overrides)) env.field(key).value = value;
	env.def.oneditprepare.call(node);
	return env;
}
/** What Done would store: oneditsave on the booted node, then its regions. */
function save(env) {
	env.def.oneditsave.call(env.node);
	return env.node.regions;
}
const listRows = (env) => env.document.getElementById("line-finder-region-list").children;
const regionName = (env) => env.document.getElementById("line-finder-region-name");

/** Hand the editor an image the way the file input does. */
function loadImage(env) {
	const input = env.document.getElementById("line-finder-file");
	input.files = [{ name: "frame.png" }];
	input.dispatch("change");
}

function viewerParts(env) {
	const overlay = env.overlay();
	const canvas = overlay.descendants().find((e) => e.tagName === "CANVAS");
	const spans = overlay.descendants().filter((e) => e.tagName === "SPAN");
	return {
		overlay,
		canvas,
		ctx: canvas.getContext(),
		footer: spans[spans.length - 1],
		button: (label) => overlay.findButton(label),
	};
}

/** A pointer drag over the viewer canvas, in screen (CSS px) coordinates. */
function drag(canvas, from, to, opts = {}) {
	const ev = (x, y, extra = {}) => ({
		clientX: x, clientY: y, button: opts.button || 0, pointerId: 1, ...extra,
	});
	canvas.dispatch("pointerdown", ev(from[0], from[1]));
	const steps = 4;
	for (let i = 1; i <= steps; i++) {
		canvas.dispatch(
			"pointermove",
			ev(
				from[0] + ((to[0] - from[0]) * i) / steps,
				from[1] + ((to[1] - from[1]) * i) / steps,
				{ shiftKey: !!opts.shiftKey },
			),
		);
	}
	canvas.dispatch("pointerup", ev(to[0], to[1]));
}

/** The first closed path drawn after the image: the region parallelogram. */
function regionPath(ctx) {
	const calls = ctx.calls;
	let i = calls.length - 1;
	while (i >= 0 && calls[i].op !== "drawImage") i--;
	const pts = [];
	for (let j = i + 1; j < calls.length; j++) {
		const c = calls[j];
		if (c.op === "moveTo") {
			if (pts.length) break;
			pts.push({ x: c.args[0], y: c.args[1] });
		} else if (c.op === "lineTo" && pts.length) {
			pts.push({ x: c.args[0], y: c.args[1] });
		} else if (c.op === "closePath" && pts.length) {
			break;
		}
	}
	return pts;
}

function fields(env) {
	return {
		x: Number(env.field("regionX").value),
		y: Number(env.field("regionY").value),
		width: Number(env.field("regionWidth").value),
		height: Number(env.field("regionHeight").value),
		angleDeg: Number(env.field("regionAngleDeg").value),
		scan: env.field("scanDirection").value,
	};
}

// ---- the editor at rest -----------------------------------------------

test("the region is described in the readout before any image is loaded", () => {
	const env = boot({ regionX: 300, regionY: 8, regionWidth: 2400, regionHeight: 90 });
	const text = env.document.getElementById("line-finder-readout").textContent;
	assert.match(text, /x 300/);
	assert.match(text, /2400×90 px/);
	// The caliper geometry is what an operator cannot work out in their head,
	// so it belongs in the readout - and it follows the scan direction: 16
	// bands across the 90px height when scanning right...
	assert.match(text, /16 calipers of 5\.6 px/);
	// ...and across the 2400px width when scanning down
	env.field("scanDirection").value = "down";
	env.field("scanDirection").dispatch("change");
	assert.match(
		env.document.getElementById("line-finder-readout").textContent,
		/16 calipers of 150\.0 px/,
	);
});

test("the thumbnail invites the viewer rather than pretending to be one", () => {
	const env = boot();
	const ctx = env.document.getElementById("line-finder-canvas").getContext();
	const texts = ctx.calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
	assert.ok(texts.some((t) => /zoom viewer/.test(t)), texts.join(" | "));
});

test("the thumbnail draws a rotated region as the parallelogram it is", () => {
	// the old thumbnail drew an upright box whatever the angle said, which
	// is the one kind of wrong a preview must not be
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 100 });
	loadImage(env);
	env.field("regionAngleDeg").value = 30;
	env.field("regionAngleDeg").dispatch("change");
	const pts = regionPath(env.document.getElementById("line-finder-canvas").getContext());
	assert.strictEqual(pts.length, 4);
	assert.ok(Math.abs(pts[0].y - pts[1].y) > 1, `expected a tilt, got ${JSON.stringify(pts)}`);
	assert.ok(Math.abs(pts[0].x - pts[3].x) > 1, `expected a tilt, got ${JSON.stringify(pts)}`);
});

test("the viewer says what it needs instead of opening empty", () => {
	const env = boot();
	env.document.getElementById("line-finder-open-viewer").dispatch("click");
	assert.strictEqual(
		env.document.getElementById("line-finder-readout").textContent,
		"Load a sample image first.",
	);
	assert.strictEqual(env.document.body.children.length, 0, "nothing should be shown");
});

// ---- the viewer -------------------------------------------------------

test("loading a frame draws it and opens the viewer on it", () => {
	const env = boot();
	loadImage(env);
	const thumb = env.document.getElementById("line-finder-canvas").getContext();
	assert.ok(thumb.ops().includes("drawImage"), "the thumbnail should show the frame");

	const v = viewerParts(env);
	assert.ok(v.canvas, "the viewer should be on screen");
	for (const label of ["Fit", "100%", "Mode: Draw", "Scan", "Calipers", "Apply", "Cancel"]) {
		assert.ok(v.button(label), `the viewer needs a ${label} control`);
	}
	assert.match(v.footer.textContent, /zoom \d+%/);
	assert.match(v.footer.textContent, /800 × 600 px|calipers/);
});

test("the viewer opens zoomed onto the region, not fitted to the whole frame", () => {
	// a caliper region is a sliver on a multi-megapixel frame; opening at
	// "fit" would show the operator nothing they could aim with
	const env = boot({ regionX: 380, regionY: 280, regionWidth: 40, regionHeight: 40 });
	loadImage(env);
	const v = viewerParts(env);
	const zoom = Number(v.footer.textContent.match(/zoom (\d+)%/)[1]);
	assert.ok(zoom > 100, `expected to open zoomed in, got ${zoom}%`);
});

test("dragging across the edge sets the region and takes the scan direction from the drag", () => {
	const env = boot();
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();

	drag(v.canvas, toScreen(100, 150), toScreen(300, 520));
	// the drag is mostly downward, so the calipers travel down
	assert.match(v.footer.textContent, /scan ↓/);
	assert.match(v.footer.textContent, /x 100/);

	// nothing is committed until Apply: a viewer you cannot back out of is a trap
	assert.deepStrictEqual(fields(env), {
		x: 0, y: 0, width: 100, height: 100, angleDeg: 0, scan: "right",
	});

	v.button("Apply").click();
	assert.deepStrictEqual(fields(env), {
		x: 100, y: 150, width: 200, height: 370, angleDeg: 0, scan: "down",
	});
	assert.strictEqual(env.document.body.children.length, 0, "Apply should close the viewer");
});

test("Cancel leaves the fields exactly as they were", () => {
	const env = boot({ regionX: 10, regionY: 20, regionWidth: 30, regionHeight: 40 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	drag(v.canvas, toScreen(200, 100), toScreen(600, 500));
	v.button("Cancel").click();
	assert.deepStrictEqual(fields(env), {
		x: 10, y: 20, width: 30, height: 40, angleDeg: 0, scan: "right",
	});
});

test("a discarded drag does not come back when the viewer is reopened", () => {
	const env = boot({ regionX: 10, regionY: 20, regionWidth: 30, regionHeight: 40 });
	loadImage(env);
	let v = viewerParts(env);
	v.button("Fit").click();
	drag(v.canvas, toScreen(200, 100), toScreen(600, 500));
	v.button("Cancel").click();

	env.document.getElementById("line-finder-open-viewer").dispatch("click");
	v = viewerParts(env);
	assert.match(v.footer.textContent, /x 10/);
	assert.match(v.footer.textContent, /30×40 px/);
});

test("a click that is not a drag keeps the region it has", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 200 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	// well outside the region, so this is a "new region" gesture that goes nowhere
	drag(v.canvas, toScreen(700, 560), toScreen(700, 560));
	v.button("Apply").click();
	assert.deepStrictEqual(fields(env), {
		x: 100, y: 100, width: 200, height: 200, angleDeg: 0, scan: "right",
	});
});

test("a corner handle resizes from the opposite corner", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 200 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	// grab the bottom-right corner (300,300) and pull it to (500,400)
	drag(v.canvas, toScreen(300, 300), toScreen(500, 400));
	v.button("Apply").click();
	const f = fields(env);
	assert.strictEqual(f.x, 100, "the fixed corner must not move");
	assert.strictEqual(f.y, 100);
	assert.strictEqual(f.width, 400);
	assert.strictEqual(f.height, 300);
});

test("dragging inside the region moves it without resizing it", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 200 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	drag(v.canvas, toScreen(200, 200), toScreen(260, 240));
	v.button("Apply").click();
	assert.deepStrictEqual(fields(env), {
		x: 160, y: 140, width: 200, height: 200, angleDeg: 0, scan: "right",
	});
});

test("the rotation grip sets the angle in degrees", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 100 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	// the grip sits 30 screen px beyond the +x edge midpoint, at image (300,150)
	const [gx, gy] = toScreen(300, 150);
	// drag it to straight below the centre (200,150): a quarter turn
	drag(v.canvas, [gx + 30, gy], toScreen(200, 400));
	v.button("Apply").click();
	const f = fields(env);
	assert.strictEqual(f.angleDeg, 90, "a quarter turn should read as 90");
	// rotation is about the centre, so the box itself is untouched
	assert.strictEqual(f.width, 200);
	assert.strictEqual(f.height, 100);
});

test("shift snaps rotation to five degrees", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 100 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	const [gx, gy] = toScreen(300, 150);
	// aim at roughly 31 degrees below the centre
	drag(v.canvas, [gx + 30, gy], toScreen(300, 210), { shiftKey: true });
	v.button("Apply").click();
	assert.strictEqual(Number(env.field("regionAngleDeg").value) % 5, 0);
});

test("arrow keys nudge the region a pixel at a time, ten with shift", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 50, regionHeight: 50 });
	loadImage(env);
	const v = viewerParts(env);
	env.window.dispatch("keydown", { key: "ArrowRight" });
	env.window.dispatch("keydown", { key: "ArrowDown", shiftKey: true });
	env.window.dispatch("keydown", { key: "ArrowUp" });
	v.button("Apply").click();
	const f = fields(env);
	assert.strictEqual(f.x, 101);
	assert.strictEqual(f.y, 109);
});

test("the scan button cycles the four directions", () => {
	const env = boot();
	loadImage(env);
	const v = viewerParts(env);
	const seen = [];
	for (let i = 0; i < 4; i++) {
		v.button("Scan").click();
		seen.push(v.footer.textContent.match(/scan (.)/)[1]);
	}
	assert.deepStrictEqual(seen, ["↓", "←", "↑", "→"]);
});

test("the caliper overlay can be turned off", () => {
	const env = boot({ regionX: 100, regionY: 100, regionWidth: 200, regionHeight: 320, calipers: 16 });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();

	const countAfter = (fn) => {
		const before = v.ctx.calls.length;
		fn();
		return v.ctx.calls.length - before;
	};
	const withCalipers = countAfter(() => v.button("Fit").click());
	const withoutCalipers = countAfter(() => v.button("Calipers").click());
	assert.ok(
		withoutCalipers < withCalipers,
		`turning the calipers off should draw less: ${withoutCalipers} vs ${withCalipers}`,
	);
});

test("a region hanging off the frame is called out, not silently accepted", () => {
	// bands that fall outside the image are skipped by the finder, which
	// looks like a mysteriously weak result unless the editor says so
	const env = boot({ regionX: 700, regionY: 100, regionWidth: 400, regionHeight: 100 });
	loadImage(env);
	const v = viewerParts(env);
	assert.match(v.footer.textContent, /past the frame/);
	assert.match(
		env.document.getElementById("line-finder-readout").textContent,
		/past the frame/,
	);
});

test("Escape closes the viewer and takes its window listeners with it", () => {
	const env = boot();
	loadImage(env);
	assert.strictEqual(env.window.listenerCount("keydown"), 1);
	env.window.dispatch("keydown", { key: "Escape" });
	assert.strictEqual(env.document.body.children.length, 0);
	assert.strictEqual(env.window.listenerCount("keydown"), 0, "a leaked listener would fire forever");
	assert.strictEqual(env.window.listenerCount("resize"), 0);
});

test("the wheel zooms and the readout follows", () => {
	const env = boot();
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	const before = Number(v.footer.textContent.match(/zoom (\d+)%/)[1]);
	v.canvas.dispatch("wheel", { clientX: 400, clientY: 300, deltaY: -100 });
	const after = Number(v.footer.textContent.match(/zoom (\d+)%/)[1]);
	assert.ok(after > before, `${after}% should be more than ${before}%`);
});

// ---- Run on this image ------------------------------------------------

/**
 * A stand-in for jQuery's ajax: records each request and lets the test
 * answer it, through the same done/fail/always chain the editor uses.
 */
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
			const settle = (kind, arg) => {
				for (const fn of handlers[kind]) fn(arg);
				for (const fn of handlers.always) fn();
			};
			calls.push({
				opts,
				body: JSON.parse(opts.data),
				resolve: (data) => settle("done", data),
				reject: (xhr) => settle("fail", xhr),
			});
			return chain;
		},
	};
	return { $, calls };
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

const runStatus = (env) => env.document.getElementById("line-finder-run-status").textContent;

function hit(overrides = {}) {
	return {
		found: true, reason: "ok", angleDeg: 0.12, score: 0.91, residualPx: 0.31,
		calipers: { total: 8, found: 8, used: 7 },
		// a little right of the region's own centre line, so the drawing of
		// the fitted line cannot be mistaken for the dashed expected-edge line
		line: { x: 210, y: 200, dx: 0, dy: 1, p0: { x: 210, y: 150 }, p1: { x: 210, y: 250 } },
		points: [],
		caliperLines: [
			{ band: 0, p0: { x: 100, y: 156 }, p1: { x: 300, y: 156 }, complete: true, peakContrast: 9, edge: { x: 200, y: 156 }, used: true },
			{ band: 1, p0: { x: 100, y: 168 }, p1: { x: 300, y: 168 }, complete: true, peakContrast: 9, edge: { x: 230, y: 168 }, used: false },
		],
		diagnostics: { peakContrast: 9, medianPeakContrast: 9, calipersWithEdge: 8, calipersInImage: 8, peakPolarity: "darkToLight" },
		settings: { contrastThreshold: 2, minCaliperFraction: 0.5, polarity: "either", angleToleranceDeg: 10, minScore: 0 },
		...overrides,
	};
}

test("Run waits for an image, then posts a crop around the region with the dialog's settings", () => {
	withAjax((ajax) => {
		const env = boot({ regionX: 100, regionY: 150, regionWidth: 200, regionHeight: 100, calipers: 8, contrastThreshold: 1.5 });
		const run = env.document.getElementById("line-finder-run");
		assert.strictEqual(run.disabled, true, "nothing to run on yet");
		run.dispatch("click");
		assert.strictEqual(ajax.calls.length, 0);

		loadImage(env);
		assert.strictEqual(run.disabled, false);
		run.dispatch("click");
		assert.strictEqual(ajax.calls.length, 1);
		const { opts, body } = ajax.calls[0];
		assert.strictEqual(opts.url, "line-finder/run");
		assert.strictEqual(opts.type, "POST");
		assert.strictEqual(opts.contentType, "application/json");
		// the region's bounding box with the 32px margin (bands are 12.5px)
		assert.deepStrictEqual(body.offset, { x: 68, y: 118 });
		assert.deepStrictEqual(body.region, { x: 100, y: 150, width: 200, height: 100, angleDeg: 0 });
		assert.strictEqual(Number(body.cfg.contrastThreshold), 1.5);
		assert.strictEqual(Number(body.cfg.calipers), 8);
		assert.strictEqual(body.cfg.scanDirection, "right");
		// the crop was cut from the image at that offset
		const crop = env.created.find((e) => e.tagName === "CANVAS" && e.width === 264);
		assert.ok(crop, "a crop canvas of the box's size");
		assert.strictEqual(crop.height, 164);
		const draw = crop.getContext().calls.find((c) => c.op === "drawImage");
		assert.deepStrictEqual(draw.args.slice(1, 5), [68, 118, 264, 164]);
		// busy until the answer comes
		assert.strictEqual(run.disabled, true);
		assert.match(runStatus(env), /running/);
	});
});

test("a hit is summed up in one line and drawn over the thumbnail through the region's own mapping", () => {
	withAjax((ajax) => {
		const env = boot({ regionX: 100, regionY: 150, regionWidth: 200, regionHeight: 100, calipers: 8 });
		loadImage(env);
		const run = env.document.getElementById("line-finder-run");
		const thumb = env.document.getElementById("line-finder-canvas").getContext();
		run.dispatch("click");
		const before = thumb.calls.length;
		ajax.calls[0].resolve({ ok: true, result: hit() });

		const status = runStatus(env);
		assert.match(status, /found/);
		assert.match(status, /0\.12°/);
		assert.match(status, /7\/8 calipers/);
		assert.match(status, /score 0\.91/);
		assert.match(status, /fraction of a pixel/, "the browser decoded the sample, and the line says so");
		assert.strictEqual(run.disabled, false, "ready to run again");

		const calls = thumb.calls.slice(before);
		// one dot per caliper that found an edge: the kept one filled, the dropped one hollow
		const arcs = calls.filter((c) => c.op === "arc");
		assert.strictEqual(arcs.length, 2);
		const after = (i) => calls.slice(calls.indexOf(arcs[i]) + 1, calls.indexOf(arcs[i]) + 2)[0].op;
		assert.strictEqual(after(0), "fill");
		assert.strictEqual(after(1), "stroke");
		// the fitted line lands where the thumbnail's mapping puts image (210,150)
		const s = Math.min(THUMB.width / IMG.width, THUMB.height / IMG.height);
		const expect = [(THUMB.width - IMG.width * s) / 2 + 210 * s, (THUMB.height - IMG.height * s) / 2 + 150 * s];
		assert.ok(
			calls.some((c) => c.op === "moveTo" && Math.abs(c.args[0] - expect[0]) < 1e-9 && Math.abs(c.args[1] - expect[1]) < 1e-9),
			`no moveTo at ${expect}`,
		);

		// the result belongs to the region it was run on: move the region and it goes
		env.field("regionX").value = 120;
		env.field("regionX").dispatch("change");
		assert.strictEqual(runStatus(env), "");
		const redraw = thumb.calls.slice(before + calls.length);
		assert.ok(redraw.some((c) => c.op === "drawImage"), "the thumbnail was repainted");
		assert.strictEqual(redraw.filter((c) => c.op === "arc").length, 0, "without the stale dots");
	});
});

test("a miss says what stopped it and which field to move; a failed call says why", () => {
	withAjax((ajax) => {
		const env = boot({ regionX: 100, regionY: 150, regionWidth: 200, regionHeight: 100, calipers: 8 });
		loadImage(env);
		const run = env.document.getElementById("line-finder-run");
		run.dispatch("click");
		ajax.calls[0].resolve({
			ok: true,
			result: hit({
				found: false, reason: "no-edge", score: 0, angleDeg: null, line: null, caliperLines: [],
				calipers: { total: 8, found: 0, used: 0 },
				diagnostics: { peakContrast: 1.3, medianPeakContrast: 1.3, calipersWithEdge: 0, calipersInImage: 8, peakPolarity: "lightToDark" },
			}),
		});
		assert.match(
			runStatus(env),
			/not found \(no-edge\): strongest edge contrast 1\.3, threshold 2\.0 - lower Contrast threshold below 1\.3 to pick it up/,
		);

		run.dispatch("click");
		ajax.calls[1].reject({ responseJSON: { ok: false, error: "line-finder: region needs positive width and height" } });
		assert.match(runStatus(env), /run failed: line-finder: region needs positive width and height/);
		assert.strictEqual(run.disabled, false);
	});
});

test("Reset restores a usable region without touching the scan direction", () => {
	const env = boot({ regionX: 900, regionY: 900, regionWidth: 1, regionHeight: 1, scanDirection: "up" });
	env.document.getElementById("line-finder-clear").dispatch("click");
	assert.deepStrictEqual(fields(env), {
		x: 0, y: 0, width: 100, height: 100, angleDeg: 0, scan: "up",
	});
});

// ---- the region list ----------------------------------------------------

const SIDES = [
	{ name: "left", x: 100, y: 200, width: 40, height: 200, angleDeg: 0, scanDirection: "right", polarity: "darkToLight", edgeSelect: "last" },
	{ name: "right", x: 460, y: 200, width: 40, height: 200, angleDeg: 0, scanDirection: "left", polarity: "darkToLight", edgeSelect: "last" },
	{ name: "top", x: 200, y: 130, width: 200, height: 40, angleDeg: 1.5, scanDirection: "down", polarity: "either", edgeSelect: "best" },
	{ name: "bottom", x: 200, y: 430, width: 200, height: 40, angleDeg: 0, scanDirection: "up", polarity: "either", edgeSelect: "first" },
];

test("a stored region list is shown, edited through the fields, and stored back as it came", () => {
	const env = boot({}, { regions: SIDES.map((r) => ({ ...r })) });
	// the list shows every region and the first is selected into the fields
	assert.strictEqual(listRows(env).length, 4);
	assert.match(listRows(env)[0].textContent, /^left\s+→/);
	assert.match(listRows(env)[3].textContent, /^bottom\s+↑/);
	assert.deepStrictEqual(fields(env), { x: 100, y: 200, width: 40, height: 200, angleDeg: 0, scan: "right" });
	assert.strictEqual(env.field("polarity").value, "darkToLight");
	assert.strictEqual(env.field("edgeSelect").value, "last");
	assert.strictEqual(regionName(env).value, "left");
	assert.match(env.document.getElementById("line-finder-readout").textContent, /^left: /);
	// untouched, the round trip is exact
	assert.deepStrictEqual(save(env), SIDES);
});

test("clicking a row selects that region; a field edit lands on the selected one only", () => {
	const env = boot({}, { regions: SIDES.map((r) => ({ ...r })) });
	listRows(env)[2].dispatch("click");
	assert.deepStrictEqual(fields(env), { x: 200, y: 130, width: 200, height: 40, angleDeg: 1.5, scan: "down" });
	assert.strictEqual(regionName(env).value, "top");
	env.field("regionX").value = 210;
	env.field("regionX").dispatch("change");
	env.field("polarity").value = "lightToDark";
	env.field("polarity").dispatch("change");
	regionName(env).value = "top edge";
	regionName(env).dispatch("change");
	assert.match(listRows(env)[2].textContent, /^top edge\s+↓\s+x 210/);
	const saved = save(env);
	assert.strictEqual(saved[2].x, 210);
	assert.strictEqual(saved[2].polarity, "lightToDark");
	assert.strictEqual(saved[2].name, "top edge");
	assert.deepStrictEqual(saved[0], SIDES[0], "the others are untouched");
	assert.deepStrictEqual(saved[3], SIDES[3]);
});

test("a node saved before regions existed seeds one region from its fields", () => {
	const env = boot({
		regionX: 300, regionY: 8, regionWidth: 2400, regionHeight: 90, regionAngleDeg: 0.4,
		scanDirection: "down", polarity: "lightToDark", edgeSelect: "first",
	});
	assert.strictEqual(listRows(env).length, 1);
	assert.strictEqual(regionName(env).value, "line");
	assert.deepStrictEqual(save(env), [{
		name: "line", x: 300, y: 8, width: 2400, height: 90, angleDeg: 0.4,
		scanDirection: "down", polarity: "lightToDark", edgeSelect: "first",
	}]);
});

test("a value typed into a field without a change event is still what gets saved", () => {
	// Done can be clicked straight after typing; oneditsave reads the fields
	// itself rather than trusting that every change handler has fired
	const env = boot({ regionX: 10, regionY: 20, regionWidth: 30, regionHeight: 40 });
	env.field("regionWidth").value = 333;
	regionName(env).value = "seam";
	assert.deepStrictEqual(save(env), [{
		name: "seam", x: 10, y: 20, width: 333, height: 40, angleDeg: 0,
		scanDirection: "right", polarity: "either", edgeSelect: "best",
	}]);
});

test("Add appends a region and selects it; Remove takes the selected one and never the last", () => {
	const env = boot({ regionX: 10, regionY: 20, regionWidth: 30, regionHeight: 40 });
	const add = env.document.getElementById("line-finder-region-add");
	const remove = env.document.getElementById("line-finder-region-remove");
	assert.strictEqual(remove.disabled, true, "one region cannot be removed");
	add.dispatch("click");
	add.dispatch("click");
	assert.strictEqual(listRows(env).length, 3);
	assert.strictEqual(regionName(env).value, "line3", "names stay unique");
	assert.strictEqual(remove.disabled, false);
	// a duplicate name typed in is made unique too
	regionName(env).value = "line";
	regionName(env).dispatch("change");
	assert.strictEqual(regionName(env).value, "line3", "line and line2 are taken");
	remove.dispatch("click");
	assert.strictEqual(listRows(env).length, 2);
	assert.strictEqual(regionName(env).value, "line2", "the neighbour is selected");
	remove.dispatch("click");
	assert.strictEqual(listRows(env).length, 1);
	assert.strictEqual(remove.disabled, true);
	remove.dispatch("click");
	assert.strictEqual(listRows(env).length, 1, "the last region stays");
	assert.deepStrictEqual(save(env).map((r) => r.name), ["line"]);
});

test("Add rectangle lays four inward-scanning sides over the loaded frame and selects left", () => {
	const env = boot();
	loadImage(env);
	env.window.dispatch("keydown", { key: "Escape" });
	env.document.getElementById("line-finder-add-rect").dispatch("click");
	const saved = save(env);
	assert.deepStrictEqual(saved.map((r) => r.name), ["left", "right", "top", "bottom"], "the untouched default is dropped");
	assert.deepStrictEqual(saved.map((r) => r.scanDirection), ["right", "left", "down", "up"]);
	for (const r of saved) {
		assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= IMG.width && r.y + r.height <= IMG.height, JSON.stringify(r));
	}
	assert.strictEqual(regionName(env).value, "left");
	assert.strictEqual(listRows(env).length, 4);
	// the thumbnail now labels every region by name
	const texts = env.document.getElementById("line-finder-canvas").getContext().calls
		.filter((c) => c.op === "fillText").map((c) => c.args[0]);
	for (const name of ["left", "right", "top", "bottom"]) assert.ok(texts.includes(name), `${name} labelled`);
});

test("Copy as label-crop edgeRegions needs all four sides and writes their JSON to the clipboard", async () => {
	const env = boot({}, { regions: SIDES.slice(0, 3).map((r) => ({ ...r })) });
	const copy = env.document.getElementById("line-finder-copy-edge-regions");
	assert.strictEqual(copy.disabled, true, "three sides are not a rectangle");
	env.document.getElementById("line-finder-region-add").dispatch("click");
	regionName(env).value = "bottom";
	regionName(env).dispatch("change");
	assert.strictEqual(copy.disabled, false);

	const written = [];
	env.window.navigator = { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } };
	env.field("contrastThreshold").value = "1.5";
	env.field("angleToleranceDeg").value = "";
	copy.dispatch("click");
	await Promise.resolve();
	assert.strictEqual(written.length, 1);
	const spec = JSON.parse(written[0]);
	assert.deepStrictEqual(Object.keys(spec), ["left", "right", "top", "bottom"]);
	assert.deepStrictEqual(
		spec.left,
		{ x: 100, y: 200, width: 40, height: 200, polarity: "darkToLight", edgeSelect: "last",
			calipers: 16, contrastThreshold: 1.5, filterHalfWidth: 2, ignoreCount: 0,
			outlierTolerancePx: 2.5, minCaliperFraction: 0.5, angleToleranceDeg: null },
	);
	assert.strictEqual(spec.left.scanDirection, undefined, "label-crop implies the scan from the side");
	assert.strictEqual(spec.top.angleDeg, 1.5);
	assert.match(runStatus(env), /copied edgeRegions/);
});

test("without a clipboard API the JSON goes through a textarea and execCommand", async () => {
	const env = boot({}, { regions: SIDES.map((r) => ({ ...r })) });
	let copied = false;
	env.document.execCommand = (cmd) => {
		copied = cmd === "copy";
		return true;
	};
	env.document.getElementById("line-finder-copy-edge-regions").dispatch("click");
	await Promise.resolve();
	assert.strictEqual(copied, true);
	const ta = env.created.find((e) => e.tagName === "TEXTAREA");
	assert.ok(ta && ta.removed, "the scratch textarea is taken down again");
	assert.deepStrictEqual(Object.keys(JSON.parse(ta.value)), ["left", "right", "top", "bottom"]);
	assert.strictEqual(env.document.body.children.length, 0);
});

test("in the viewer, clicking another region selects it, and Apply writes every region back", () => {
	const env = boot({}, { regions: SIDES.map((r) => ({ ...r })) });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	assert.match(v.footer.textContent, /left: /);
	// a click inside the right region (460..500 x 200..400) selects it
	drag(v.canvas, toScreen(480, 300), toScreen(480, 300));
	assert.match(v.footer.textContent, /right: /);
	assert.match(v.footer.textContent, /scan ←/);
	// now drag inside it: it moves, the others stay
	drag(v.canvas, toScreen(480, 300), toScreen(500, 320));
	v.button("Apply").click();
	assert.strictEqual(regionName(env).value, "right", "the selection follows Apply");
	assert.deepStrictEqual(fields(env), { x: 480, y: 220, width: 40, height: 200, angleDeg: 0, scan: "left" });
	const saved = save(env);
	assert.deepStrictEqual(saved[0], SIDES[0]);
	assert.strictEqual(saved[1].x, 480);
	assert.deepStrictEqual(saved[2], SIDES[2]);
});

test("Cancel in the viewer discards a selection change as well as a drag", () => {
	const env = boot({}, { regions: SIDES.map((r) => ({ ...r })) });
	loadImage(env);
	const v = viewerParts(env);
	v.button("Fit").click();
	drag(v.canvas, toScreen(480, 300), toScreen(480, 300));
	drag(v.canvas, toScreen(480, 300), toScreen(520, 340));
	v.button("Cancel").click();
	assert.strictEqual(regionName(env).value, "left");
	assert.deepStrictEqual(save(env), SIDES);
});

test("a click on the thumbnail over another region selects it instead of opening the viewer", () => {
	const env = boot({}, { regions: SIDES.map((r) => ({ ...r })) });
	loadImage(env);
	env.window.dispatch("keydown", { key: "Escape" });
	const thumb = env.document.getElementById("line-finder-canvas");
	// the fake thumbnail is 900x600 CSS px for a 360x240 canvas showing 800x600
	const s = Math.min(THUMB.width / IMG.width, THUMB.height / IMG.height);
	const dx = (THUMB.width - IMG.width * s) / 2;
	const dy = (THUMB.height - IMG.height * s) / 2;
	const css = (x, y) => ({
		clientX: ((dx + x * s) * thumb.rect.width) / THUMB.width,
		clientY: ((dy + y * s) * thumb.rect.height) / THUMB.height,
	});
	thumb.dispatch("click", css(300, 150));
	assert.strictEqual(regionName(env).value, "top");
	assert.strictEqual(env.document.body.children.length, 0, "no viewer opened");
	// clicking on the selected region, or on nothing, opens the viewer as before
	thumb.dispatch("click", css(300, 150));
	assert.strictEqual(env.document.body.children.length, 1);
});

test("Run searches every region, one crop each, and sums them up in one line with the rectangle", () => {
	withAjax((ajax) => {
		const env = boot({ calipers: 8 }, { regions: SIDES.map((r) => ({ ...r })) });
		loadImage(env);
		env.window.dispatch("keydown", { key: "Escape" });
		const run = env.document.getElementById("line-finder-run");
		const thumb = env.document.getElementById("line-finder-canvas").getContext();
		run.dispatch("click");
		assert.strictEqual(ajax.calls.length, 4, "one request per region");
		for (let i = 0; i < 4; i++) {
			const { body } = ajax.calls[i];
			const { name, scanDirection, polarity, edgeSelect, ...geometry } = SIDES[i];
			assert.deepStrictEqual(body.region, geometry, `${name} is searched where it was drawn`);
			assert.strictEqual(body.cfg.scanDirection, scanDirection, `${name} scans its own way`);
			assert.strictEqual(body.cfg.polarity, polarity);
			assert.strictEqual(body.cfg.edgeSelect, edgeSelect);
			assert.strictEqual(Number(body.cfg.calipers), 8, "the tuning is shared");
		}
		assert.strictEqual(run.disabled, true);

		const vertical = (x) => hit({ angleDeg: 90, line: { x, y: 300, dx: 0, dy: 1, p0: { x, y: 200 }, p1: { x, y: 400 } }, caliperLines: [] });
		const horizontal = (y, angleDeg) => hit({ angleDeg, line: { x: 300, y, dx: 1, dy: 0, p0: { x: 200, y }, p1: { x: 400, y } }, caliperLines: [] });
		const before = thumb.calls.length;
		ajax.calls[0].resolve({ ok: true, result: vertical(100) });
		ajax.calls[1].resolve({ ok: true, result: vertical(500) });
		assert.match(runStatus(env), /running/, "nothing is said until every region has answered");
		ajax.calls[2].resolve({ ok: true, result: horizontal(150, 0.12) });
		ajax.calls[3].resolve({ ok: true, result: horizontal(450, -0.04) });

		const status = runStatus(env);
		assert.match(status, /left ✓ 90\.0°\s+·\s+right ✓ 90\.0°\s+·\s+top ✓ 0\.1°\s+·\s+bottom ✓ -0\.0°/);
		assert.match(status, /rect 400×300 px/);
		assert.strictEqual(env.document.getElementById("line-finder-run-status").style.color, "#2e7d32");
		assert.strictEqual(run.disabled, false);
		// the four corners are drawn on the thumbnail, where its mapping puts them
		const calls = thumb.calls.slice(before);
		const arcs = calls.filter((c) => c.op === "arc");
		assert.strictEqual(arcs.length, 4);
		const s = Math.min(THUMB.width / IMG.width, THUMB.height / IMG.height);
		const at = (x, y) => [(THUMB.width - IMG.width * s) / 2 + x * s, (THUMB.height - IMG.height * s) / 2 + y * s];
		for (const [x, y] of [[100, 150], [500, 150], [500, 450], [100, 450]]) {
			const [ex, ey] = at(x, y);
			assert.ok(arcs.some((c) => Math.abs(c.args[0] - ex) < 1e-9 && Math.abs(c.args[1] - ey) < 1e-9), `corner at ${x},${y}`);
		}

		// a side that misses is named with the short reason, and there is no rectangle
		run.dispatch("click");
		ajax.calls[4].resolve({ ok: true, result: vertical(100) });
		ajax.calls[5].resolve({ ok: true, result: vertical(500) });
		ajax.calls[6].resolve({
			ok: true,
			result: hit({
				found: false, reason: "no-edge", score: 0, angleDeg: null, line: null, caliperLines: [],
				calipers: { total: 8, found: 0, used: 0 },
				diagnostics: { peakContrast: 1.3, medianPeakContrast: 1.3, calipersWithEdge: 0, calipersInImage: 8, peakPolarity: "lightToDark" },
			}),
		});
		ajax.calls[7].reject({ responseJSON: { ok: false, error: "line-finder: region needs finite x and y" } });
		const missed = runStatus(env);
		assert.match(missed, /left ✓ 90\.0°\s+·\s+right ✓ 90\.0°\s+·\s+top ✗ contrast 1\.3<2\.0\s+·\s+bottom ✗ error: line-finder: region needs finite x and y/);
		assert.doesNotMatch(missed, /rect/);
		assert.strictEqual(run.disabled, false);
	});
});

test("a region wholly off the frame is reported without a request being made", () => {
	withAjax((ajax) => {
		const env = boot({}, { regions: [SIDES[0], { ...SIDES[1], name: "far", x: 2000, y: 2000 }] });
		loadImage(env);
		env.window.dispatch("keydown", { key: "Escape" });
		env.document.getElementById("line-finder-run").dispatch("click");
		assert.strictEqual(ajax.calls.length, 1, "only the region on the frame is sent");
		ajax.calls[0].resolve({ ok: true, result: hit() });
		assert.match(runStatus(env), /left ✓ 0\.1°\s+·\s+far ✗ off the frame/);
	});
});
