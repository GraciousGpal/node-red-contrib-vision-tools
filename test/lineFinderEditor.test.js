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

function boot(overrides = {}) {
	const env = makeEditorEnv({ script: SCRIPT, imageSize: IMG });
	const thumb = env.document.getElementById("line-finder-canvas");
	thumb.width = THUMB.width;
	thumb.height = THUMB.height;
	for (const [key, spec] of Object.entries(env.def.defaults)) {
		const el = env.field(key);
		if (spec.value !== undefined && spec.value !== null) el.value = spec.value;
	}
	for (const [key, value] of Object.entries(overrides)) env.field(key).value = value;
	env.def.oneditprepare.call({});
	return env;
}

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
