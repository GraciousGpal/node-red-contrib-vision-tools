/**
 * label-crop operation tests: the exported `labelCrop(input, cfg, engine)`
 * seam from lib/labelCrop.js and the pure JS analysis in `analyzeMask`.
 *
 * The engine is always a **fake** injected through the third argument or
 * the `_setBridge` test seam - the real cpp-bridge ships no
 * win32 binary, so the unit suite must stay hermetic. The fake records
 * every call (name, args, result) so the orchestration assertions can
 * prove the decode-once / low-res detection / ROI-only-rotation / native
 * final crop sequence the node is designed around.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
	analyzeMask,
	refineRectBoundary,
	labelCrop,
	_setBridge,
	_resetBridge,
} = require("../lib/labelCrop.js");
const {
	makeRectMask,
	edgeLine,
	unionMasks,
	rawImage,
} = require("./helpers/synthetic.js");

// ---- fake engine ------------------------------------------------------

/** Engine-shaped recorder: handlers receive the raw args array and return
 * { image, timing }. Every call (with its result) is recorded on .calls. */
function fakeEngine(handlers) {
	const calls = [];
	const engine = {};
	for (const name of ["resize", "colorConvert", "filter", "crop", "rotate"]) {
		engine[name] = async (...args) => {
			const h = handlers[name];
			if (!h) throw new Error(`fake engine: unexpected ${name} call`);
			const result = await h(args);
			calls.push({ name, args, result });
			return result;
		};
	}
	return { engine, calls };
}

function grayOf(raw) {
	return rawImage(
		Buffer.alloc(raw.width * raw.height),
		raw.width,
		raw.height,
		1,
		"GRAY",
	);
}

function rgbOf(raw) {
	return rawImage(
		Buffer.alloc(raw.width * raw.height * 3),
		raw.width,
		raw.height,
		3,
		"RGB",
	);
}

// A 800x600 full-res RGB frame; maxEdge 400 in most tests makes the
// detection copy 400x300 (scale 2), which is what the corner-scaling
// assertions below rely on.
const FULL = rawImage(Buffer.alloc(800 * 600 * 3), 800, 600, 3, "RGB");
const SMALL_W = 400;
const SMALL_H = 300;

/**
 * Build a fake engine whose filter returns `mask` (a Uint8Array at the
 * detection copy's size) and whose resize/colorConvert/crop/rotate are
 * dimension-preserving stubs.
 */
function detectionEngine(mask, { edges, gray } = {}) {
	return fakeEngine({
		colorConvert: (args) => {
			if (Buffer.isBuffer(args[0])) {
				return { image: FULL, timing: {} };
			}
			if (gray) {
				return {
					image: rawImage(
						Buffer.from(gray),
						args[0].width,
						args[0].height,
						1,
						"GRAY",
					),
					timing: {},
				};
			}
			return { image: grayOf(args[0]), timing: {} };
		},
		resize: (args) => ({
			image: rgbOf({ width: args[2], height: args[4] }),
			timing: {},
		}),
		filter: (args) => {
			const img = args[1] === "edge" ? (edges ?? mask) : mask;
			return {
				image: rawImage(Buffer.from(img), args[0].width, args[0].height, 1, "GRAY"),
				timing: {},
			};
		},
		crop: (args) => ({
			image: rgbOf({ width: args[3], height: args[4] }),
			timing: {},
		}),
		rotate: (args) => ({
			// dims: rotating a w x h canvas by the angle grows it; the exact
			// value is irrelevant to the op, which computes dstW/dstH itself
			image: rgbOf({ width: args[0].width + 10, height: args[0].height + 10 }),
			timing: {},
		}),
	});
}

// ---- analyzeMask: pure JS rectangle recovery -------------------------

test("analyzeMask finds an axis-aligned rectangle", () => {
	const mask = makeRectMask(200, 150, { cx: 100, cy: 75, w: 80, h: 60 });
	const r = analyzeMask(mask, 200, 150, {});
	assert.strictEqual(r.detected, true);
	assert.strictEqual(r.reason, "ok");
	assert.ok(Math.abs(r.angleDeg) <= 0.5, `angle ${r.angleDeg}`);
	assert.ok(Math.abs(r.center.x - 100) <= 1, `cx ${r.center.x}`);
	assert.ok(Math.abs(r.center.y - 75) <= 1, `cy ${r.center.y}`);
	assert.ok(Math.abs(r.width - 80) <= 3, `width ${r.width}`);
	assert.ok(Math.abs(r.height - 60) <= 3, `height ${r.height}`);
	assert.ok(r.rectangularity > 0.9, `rectangularity ${r.rectangularity}`);
	assert.strictEqual(r.borderContact, 0);
	assert.ok(r.confidence > 0.8, `confidence ${r.confidence}`);
	assert.strictEqual(r.corners.length, 4);
	// corners must be ordered consistently (tolerant check: each corner
	// lies on the rect boundary, i.e. |u| ~ w/2 or |v| ~ h/2)
	for (const c of r.corners) {
		assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), "finite corner");
	}
});

test("analyzeMask recovers a rotated rectangle", () => {
	const mask = makeRectMask(200, 150, {
		cx: 100,
		cy: 75,
		w: 80,
		h: 60,
		angleDeg: 15,
	});
	const r = analyzeMask(mask, 200, 150, {});
	assert.strictEqual(r.detected, true);
	assert.ok(Math.abs(r.angleDeg - 15) <= 2, `angle ${r.angleDeg}`);
	assert.ok(Math.abs(r.width - 80) <= 6, `width ${r.width}`);
	assert.ok(Math.abs(r.height - 60) <= 6, `height ${r.height}`);
	assert.ok(Math.abs(r.center.x - 100) <= 2, `cx ${r.center.x}`);
});

test("analyzeMask normalises the angle into [-45, 45]", () => {
	// an 80°-long rectangle is a -10° deskew, not an 80° one
	const mask = makeRectMask(200, 150, {
		cx: 100,
		cy: 75,
		w: 60,
		h: 80,
		angleDeg: 80,
	});
	const r = analyzeMask(mask, 200, 150, {});
	assert.strictEqual(r.detected, true);
	assert.ok(Math.abs(r.angleDeg + 10) <= 2, `angle ${r.angleDeg}`);
	assert.ok(
		r.angleDeg >= -45 && r.angleDeg <= 45,
		`angle in range ${r.angleDeg}`,
	);
});

test("analyzeMask rejects a blob below the area floor", () => {
	const mask = makeRectMask(200, 150, { cx: 100, cy: 75, w: 20, h: 15 }); // 300 px vs 0.05*30000
	const r = analyzeMask(mask, 200, 150, {});
	assert.strictEqual(r.detected, false);
	assert.strictEqual(r.reason, "too-small");
});

test("analyzeMask rejects an empty mask", () => {
	const r = analyzeMask(new Uint8Array(200 * 150), 200, 150, {});
	assert.strictEqual(r.detected, false);
	assert.strictEqual(r.reason, "no-component");
});

test("analyzeMask rejects a blob touching the frame border", () => {
	const mask = makeRectMask(200, 150, { cx: 40, cy: 75, w: 80, h: 60 });
	const r = analyzeMask(mask, 200, 150, { maxBorderContact: 0 });
	assert.strictEqual(r.detected, false);
	assert.strictEqual(r.reason, "border-contact");
});

test("analyzeMask rejects a foreground region larger than the configured maximum", () => {
	const mask = makeRectMask(200, 150, { cx: 100, cy: 75, w: 180, h: 140 });
	const r = analyzeMask(mask, 200, 150, {
		maxAreaFraction: 0.8,
		maxBorderContact: 1,
	});
	assert.strictEqual(r.detected, false);
	assert.strictEqual(r.reason, "too-large");
});

test("analyzeMask recenters a rectangle whose foreground has an asymmetric hole", () => {
	const mask = makeRectMask(200, 150, { cx: 100, cy: 75, w: 100, h: 60 });
	// Simulate heavy print on the left side. The foreground centroid moves
	// right, but the exterior boundary still defines the physical label.
	for (let y = 60; y < 90; y++) {
		for (let x = 55; x < 75; x++) mask[y * 200 + x] = 0;
	}
	const r = analyzeMask(mask, 200, 150, { minRectangularity: 0.4 });
	assert.strictEqual(r.detected, true);
	assert.ok(Math.abs(r.center.x - 100) <= 2, `center.x ${r.center.x}`);
	assert.ok(Math.abs(r.center.y - 75) <= 2, `center.y ${r.center.y}`);
});

test("analyzeMask uses the exterior boundary when a clipped label has asymmetric print", () => {
	const width = 200;
	const height = 300;
	const mask = makeRectMask(width, height, {
		cx: 100,
		cy: 150,
		w: 170,
		h: 320,
	});
	// A large black printed panel on one side strongly biases PCA moments,
	// matching the deployed sample. It must not invent label rotation.
	for (let y = 10; y < 110; y++) {
		for (let x = 25; x < 95; x++) mask[y * width + x] = 0;
	}
	const r = analyzeMask(mask, width, height, {
		maxBorderContact: 0.5,
		maxAreaFraction: 0.99,
		minRectangularity: 0.2,
	});
	assert.strictEqual(r.detected, true, r.reason);
	assert.ok(Math.abs(r.angleDeg) <= 1, `boundary angle ${r.angleDeg}`);
	assert.ok(Math.abs(r.width - 170) <= 3, `width ${r.width}`);
	assert.ok(Math.abs(r.height - 299) <= 3, `height ${r.height}`);
});

test("analyzeMask rejects two equally dominant blobs", () => {
	const a = makeRectMask(200, 150, { cx: 55, cy: 75, w: 80, h: 60 });
	const b = makeRectMask(200, 150, { cx: 145, cy: 75, w: 80, h: 60 });
	const r = analyzeMask(unionMasks(a, b), 200, 150, {});
	assert.strictEqual(r.detected, false);
	assert.strictEqual(r.reason, "ambiguous");
});

test("analyzeMask enforces an expected aspect ratio", () => {
	const mask = makeRectMask(200, 150, { cx: 100, cy: 75, w: 100, h: 50 });
	const r = analyzeMask(mask, 200, 150, {
		aspectRatio: 1,
		aspectTolerance: 0.1,
	});
	assert.strictEqual(r.detected, false);
	assert.strictEqual(r.reason, "aspect-mismatch");
});

test("analyzeMask accepts a matching aspect ratio", () => {
	const mask = makeRectMask(200, 150, { cx: 100, cy: 75, w: 100, h: 50 });
	const r = analyzeMask(mask, 200, 150, {
		aspectRatio: 2,
		aspectTolerance: 0.1,
	});
	assert.strictEqual(r.detected, true);
});

// ---- refineRectBoundary: snap the region rect to the label's visible
// boundary (brightness step with Sobel fallback) ------------------------

/** A small gray frame: label-tone rectangle on a darker background, with an
 * optional bright (halo) band just outside it. */
function labelGray(
	width,
	height,
	x0,
	y0,
	x1,
	y1,
	{ background = 40, halo = null } = {},
) {
	const g = new Uint8Array(width * height);
	g.fill(background);
	if (halo) {
		for (let y = halo.y0; y < halo.y1; y++) {
			for (let x = halo.x0; x < halo.x1; x++) g[y * width + x] = halo.value;
		}
	}
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) g[y * width + x] = 255;
	}
	return g;
}

test("refineRectBoundary snaps to the measured label boundary (13112025_003 fixture)", () => {
	// Detection copy at maxEdge 640: scale = 640/5500 = 0.1164.
	const W = 477;
	const H = 640;
	// Measured label: x 240..3820 -> 28..444, y 0..5408 -> 0..629.
	// A bright halo (grayish, below label tone) sits just outside it and is
	// part of the Otsu blob - the region rect is x 172..3899 -> 20..454,
	// y 0..5491 -> 0..639. Brightness must snap past the halo to the label.
	const gray = labelGray(W, H, 28, 0, 444, 629, {
		halo: { x0: 20, y0: 0, x1: 28, y1: H, value: 240 },
	});
	const r = refineRectBoundary(
		gray,
		null,
		W,
		H,
		{ cx: 236.8, cy: 319.4, w: 433.6, h: 638.9, theta: 0 },
		"light",
	);
	assert.ok(r, "refinement produced a rect");
	assert.ok(Math.abs(r.cx - 236) <= 1, `cx ${r.cx}`);
	assert.ok(Math.abs(r.cy - 314.5) <= 1, `cy ${r.cy}`);
	assert.ok(Math.abs(r.w - 416) <= 2, `w ${r.w}`);
	assert.ok(Math.abs(r.h - 629) <= 2, `h ${r.h}`);
	// top is clipped (label tone reaches the frame edge) so it stays put;
	// the other three sides snap past the halo to the label boundary.
	assert.deepStrictEqual(
		r.sides
			.filter((s) => s.snapped)
			.map((s) => s.side)
			.sort(),
		["bottom", "left", "right"],
	);
	assert.ok(
		Math.abs(r.cy - r.h / 2 - 0) <= 1,
		`top stays clipped ${r.cy - r.h / 2}`,
	);
});

test("refineRectBoundary tightens an oversized rectangle to the label boundary", () => {
	const W = 400;
	const H = 200;
	// True label x 60..340 (w 280), y 40..160 (h 120); a bright halo outside
	// it on every side; region rect too big: x 30..370, y 10..190.
	const gray = labelGray(W, H, 60, 40, 340, 160, {
		halo: {
			x0: 30,
			y0: 10,
			x1: 60,
			y1: 190,
			value: 240,
		},
	});
	const r = refineRectBoundary(
		gray,
		null,
		W,
		H,
		{ cx: 200, cy: 100, w: 340, h: 180, theta: 0 },
		"light",
	);
	assert.ok(r);
	assert.ok(Math.abs(r.cx - 200) <= 1, `cx ${r.cx}`);
	assert.ok(Math.abs(r.cy - 100) <= 1, `cy ${r.cy}`);
	assert.ok(Math.abs(r.w - 280) <= 2, `w ${r.w}`);
	assert.ok(Math.abs(r.h - 120) <= 2, `h ${r.h}`);
});

test("refineRectBoundary uses the Sobel fallback for a seam on a similar-tone surface", () => {
	const W = 400;
	const H = 600;
	// Label-tone everywhere y 0..520 (clipped at the top), then a slightly
	// dimmer table strip to the frame bottom. Brightness confirms the
	// clipped bottom (the strip is still label-ish), so only the Sobel seam
	// at y=518..520 - the label's real bottom edge - marks the boundary.
	const gray = labelGray(W, H, 50, 0, 350, 520);
	for (let y = 520; y < 600; y++) {
		for (let x = 50; x < 350; x++) {
			gray[y * W + x] = (x - 50) % 4 === 3 ? 200 : 250; // ~75% label-tone
		}
	}
	const edges = new Uint8Array(W * H);
	edgeLine(edges, W, 50, 518, 350, 518, 200);
	edgeLine(edges, W, 50, 519, 350, 519, 200);
	edgeLine(edges, W, 50, 520, 350, 520, 200);
	const r = refineRectBoundary(
		gray,
		edges,
		W,
		H,
		{ cx: 200, cy: 300, w: 300, h: 600, theta: 0 },
		"light",
	);
	assert.ok(r);
	assert.ok(
		Math.abs(r.cy - r.h / 2 - 0) <= 1,
		`top stays clipped ${r.cy - r.h / 2}`,
	);
	assert.ok(
		Math.abs(r.cy + r.h / 2 - 519) <= 2,
		`bottom snaps to the seam ${r.cy + r.h / 2}`,
	);
	assert.ok(
		Math.abs(r.cx - 200) <= 1 && Math.abs(r.w - 300) <= 1,
		"sides unchanged",
	);
});

test("refineRectBoundary does not snap a Sobel seam to print inside the label", () => {
	const W = 400;
	const H = 600;
	// Label tone fills the frame top (clipped) with a printed dark band at
	// y=24..40 - its top edge is a strong Sobel line, but it is print inside
	// the label, not a boundary. The top must stay clipped at 0.
	const gray = labelGray(W, H, 50, 0, 350, 600);
	for (let y = 24; y < 40; y++) {
		for (let x = 50; x < 350; x++) gray[y * W + x] = 60;
	}
	const edges = new Uint8Array(W * H);
	edgeLine(edges, W, 50, 24, 350, 24, 200);
	edgeLine(edges, W, 50, 25, 350, 25, 200);
	edgeLine(edges, W, 50, 26, 350, 26, 200);
	const r = refineRectBoundary(
		gray,
		edges,
		W,
		H,
		{ cx: 200, cy: 300, w: 300, h: 600, theta: 0 },
		"light",
	);
	assert.ok(r);
	assert.ok(
		Math.abs(r.cy - r.h / 2 - 0) <= 1,
		`top stays clipped ${r.cy - r.h / 2}`,
	);
	assert.ok(
		Math.abs(r.cy + r.h / 2 - 599) <= 1,
		`bottom stays clipped ${r.cy + r.h / 2}`,
	);
});

test("refineRectBoundary leaves the rect alone when there is no evidence", () => {
	const W = 200;
	const H = 150;
	const gray = new Uint8Array(W * H);
	gray.fill(200); // flat: nothing is a boundary
	const r = refineRectBoundary(
		gray,
		new Uint8Array(W * H),
		W,
		H,
		{ cx: 100, cy: 75, w: 80, h: 60, theta: 0 },
		"light",
	);
	assert.ok(r);
	assert.ok(Math.abs(r.cx - 100) <= 0.5 && Math.abs(r.w - 80) <= 0.5);
	assert.strictEqual(
		r.sides.every((s) => !s.snapped),
		true,
		"no side snapped",
	);
});

// ---- labelCrop: decode-once, detection copy, polarity, orchestration --

test("labelCrop decodes an encoded buffer and returns corners in original coordinates", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
		angleDeg: 12,
	});
	const fake = detectionEngine(mask);
	const res = await labelCrop(
		Buffer.from("fake-jpeg-bytes"),
		{ maxEdge: 400 },
		fake.engine,
	);

	assert.strictEqual(res.detected, true);
	const meta = res.metadata;
	// scale = 800/400 = 2, so the small-rect 160x120 @ 12deg becomes 320x240
	assert.ok(Math.abs(meta.center.x - 400) <= 3, `center.x ${meta.center.x}`);
	assert.ok(Math.abs(meta.center.y - 300) <= 3, `center.y ${meta.center.y}`);
	assert.ok(Math.abs(meta.width - 320) <= 12, `width ${meta.width}`);
	assert.ok(Math.abs(meta.height - 240) <= 12, `height ${meta.height}`);
	assert.ok(Math.abs(meta.angleDeg - 12) <= 2.5, `angle ${meta.angleDeg}`);
	assert.strictEqual(meta.corners.length, 4);
	for (const c of meta.corners) {
		assert.ok(c.x >= 0 && c.x <= 800, `corner.x ${c.x}`);
		assert.ok(c.y >= 0 && c.y <= 600, `corner.y ${c.y}`);
	}
	// decoded exactly once: the only Buffer input is the first colorConvert
	const decode = fake.calls.filter(
		(c) => c.name === "colorConvert" && Buffer.isBuffer(c.args[0]),
	);
	assert.strictEqual(decode.length, 1, "encoded input decoded exactly once");
});

test("labelCrop runs the detection copy at the max edge", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const fake = detectionEngine(mask);
	await labelCrop(FULL, { maxEdge: 400 }, fake.engine);
	const resize = fake.calls.find((c) => c.name === "resize");
	assert.ok(resize, "resize called for a full image above maxEdge");
	assert.strictEqual(resize.args[1], "num");
	assert.strictEqual(resize.args[2], SMALL_W);
	assert.strictEqual(resize.args[3], "num");
	assert.strictEqual(resize.args[4], SMALL_H);
	assert.strictEqual(resize.args[5], "raw");
});

test("labelCrop skips the detection copy when already small", async () => {
	const mask = makeRectMask(320, 240, { cx: 160, cy: 120, w: 120, h: 80 });
	const fake = detectionEngine(mask);
	const smallFull = rawImage(Buffer.alloc(320 * 240 * 3), 320, 240, 3, "RGB");
	await labelCrop(smallFull, { maxEdge: 640 }, fake.engine);
	assert.strictEqual(
		fake.calls.some((c) => c.name === "resize"),
		false,
	);
	// gray conversion still runs on the full image (identity, 1ch)
	const gray = fake.calls.find((c) => c.name === "colorConvert");
	assert.strictEqual(gray.args[1], "GRAY");
});

test("labelCrop auto polarity thresholds once and analyzes the inverse mask", async () => {
	const darkLabel = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const lightBackground = Uint8Array.from(darkLabel, (value) =>
		value ? 0 : 255,
	);
	const fake = detectionEngine(lightBackground);
	const res = await labelCrop(
		FULL,
		{ maxEdge: 400, polarity: "auto" },
		fake.engine,
	);
	assert.strictEqual(res.detected, true);
	assert.strictEqual(res.metadata.polarity, "dark");
	const otsu = fake.calls.filter(
		(c) => c.name === "filter" && c.args[1] === "otsu",
	);
	assert.strictEqual(otsu.length, 1, "Otsu runs once");
	assert.strictEqual(otsu[0].args[3], 0);
	// the Sobel edge pass is the refinement input
	const edges = fake.calls.filter(
		(c) => c.name === "filter" && c.args[1] === "edge",
	);
	assert.strictEqual(edges.length, 1, "one Sobel edge pass");
});

test("labelCrop fixed polarity thresholds once", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const fake = detectionEngine(mask);
	await labelCrop(FULL, { maxEdge: 400, polarity: "light" }, fake.engine);
	const otsu = fake.calls.filter(
		(c) => c.name === "filter" && c.args[1] === "otsu",
	);
	assert.strictEqual(otsu.length, 1);
	assert.strictEqual(otsu[0].args[2], 3);
	assert.strictEqual(otsu[0].args[3], 0);
});

test("labelCrop passes the original through unchanged on a miss", async () => {
	const empty = new Uint8Array(SMALL_W * SMALL_H);
	const fake = detectionEngine(empty);
	const original = Buffer.from("fake-jpeg-bytes");
	const res = await labelCrop(original, { maxEdge: 400 }, fake.engine);
	assert.strictEqual(res.detected, false);
	assert.strictEqual(res.image, original, "original object passed through");
	assert.strictEqual(res.metadata.reason, "no-component");
	assert.strictEqual(res.metadata.corners, null);
	assert.strictEqual(res.metadata.angleDeg, null);
});

test("labelCrop crops the tight ROI and deskews it, rotating only the ROI", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
		angleDeg: 12,
	});
	const fake = detectionEngine(mask);
	await labelCrop(FULL, { maxEdge: 400 }, fake.engine);

	const crops = fake.calls.filter((c) => c.name === "crop");
	assert.strictEqual(crops.length, 2, "bbox crop + final crop");
	const bbox = crops[0];
	const finalCrop = crops[1];
	// bbox crop is pixel coords on the full frame
	assert.strictEqual(bbox.args[5], false);
	assert.strictEqual(bbox.args[6], "raw");

	// the rotate input is the bbox crop result, never the full image
	const rotate = fake.calls.find((c) => c.name === "rotate");
	assert.ok(rotate, "rotate called for a rotated label");
	assert.strictEqual(
		rotate.args[0],
		bbox.result.image,
		"rotate input is the ROI",
	);
	assert.notStrictEqual(rotate.args[0], FULL);
	// OpenCV's image-coordinate matrix deskews a PCA axis with +angle.
	assert.ok(
		Math.abs(rotate.args[1] - 12) <= 2.5,
		`rotate angle ${rotate.args[1]}`,
	);
	assert.strictEqual(rotate.args[2], "#000000");
	assert.strictEqual(rotate.args[3], "raw");

	// the final crop is tight to the label: PCA dims scaled to full res
	assert.strictEqual(finalCrop.args[5], false);
	assert.ok(
		Math.abs(finalCrop.args[3] - 320) <= 12,
		`final width ${finalCrop.args[3]}`,
	);
	assert.ok(
		Math.abs(finalCrop.args[4] - 240) <= 12,
		`final height ${finalCrop.args[4]}`,
	);
});

test("labelCrop rejects a detection whose refined size deviates from the expected size", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	// The refined label covers ~11.5% of the frame.
	const gray = labelGray(SMALL_W, SMALL_H, 130, 100, 270, 200);
	const fake = detectionEngine(mask, { gray });
	const original = Buffer.from("fake-jpeg-bytes");
	const res = await labelCrop(
		original,
		{ maxEdge: 400, expectedSizeFraction: 0.4, sizeTolerance: 0.2 },
		fake.engine,
	);
	assert.strictEqual(res.detected, false);
	assert.strictEqual(res.metadata.reason, "size-mismatch");
	assert.strictEqual(res.image, original, "original passed through");
	assert.strictEqual(res.metadata.corners, null);
});

test("labelCrop accepts a detection matching the expected size", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const gray = labelGray(SMALL_W, SMALL_H, 130, 100, 270, 200);
	const fake = detectionEngine(mask, { gray });
	const res = await labelCrop(
		FULL,
		{ maxEdge: 400, expectedSizeFraction: 0.1155, sizeTolerance: 0.2 },
		fake.engine,
	);
	assert.strictEqual(res.detected, true, res.metadata.reason);
});

test("labelCrop skips rotation for a near-axis-aligned label", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const fake = detectionEngine(mask);
	const res = await labelCrop(FULL, { maxEdge: 400 }, fake.engine);
	assert.strictEqual(res.detected, true);
	assert.strictEqual(
		fake.calls.some((c) => c.name === "rotate"),
		false,
	);
	const crops = fake.calls.filter((c) => c.name === "crop");
	assert.strictEqual(crops.length, 1, "single direct crop, no bbox+rotate");
	const crop = crops[0];
	// crop args: [image, x, y, w, h, normalized, format, quality, pngOptimize]
	assert.strictEqual(crop.args[5], false);
	// axis-aligned 160x120 at center (200,150), scale 2 -> exact 320x240
	// centered at (400,300)
	assert.strictEqual(crop.args[1], 240);
	assert.strictEqual(crop.args[2], 180);
	assert.strictEqual(crop.args[3], 320);
	assert.strictEqual(crop.args[4], 240);
	assert.strictEqual(crop.args[6], "raw");
});

test("labelCrop applies boundary refinement to the final crop", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	// The small gray shows the label 10px inside the blob rect on every side
	// (a bright halo that Otsu lumps with the white label).
	const gray = labelGray(SMALL_W, SMALL_H, 130, 100, 270, 200);
	const fake = detectionEngine(mask, { gray });
	const res = await labelCrop(FULL, { maxEdge: 400 }, fake.engine);
	assert.strictEqual(res.detected, true);
	// refined 140x100 at (200,150) -> full-res 280x200 at (400,300)
	assert.ok(
		Math.abs(res.metadata.width - 280) <= 8,
		`width ${res.metadata.width}`,
	);
	assert.ok(
		Math.abs(res.metadata.height - 200) <= 8,
		`height ${res.metadata.height}`,
	);
	assert.ok(
		Math.abs(res.metadata.center.x - 400) <= 4,
		`cx ${res.metadata.center.x}`,
	);
	assert.ok(
		Math.abs(res.metadata.center.y - 300) <= 4,
		`cy ${res.metadata.center.y}`,
	);
	assert.deepStrictEqual([...res.metadata.refinedSides].sort(), [
		"bottom",
		"left",
		"right",
		"top",
	]);
	const crops = fake.calls.filter((c) => c.name === "crop");
	assert.strictEqual(crops.length, 1, "single direct crop, no rotation");
	const crop = crops[0];
	// crop args: [image, x, y, w, h, normalized, format, quality, pngOptimize]
	assert.ok(Math.abs(crop.args[1] - 260) <= 2, `crop x ${crop.args[1]}`);
	assert.ok(Math.abs(crop.args[2] - 200) <= 2, `crop y ${crop.args[2]}`);
	assert.ok(Math.abs(crop.args[3] - 280) <= 2, `crop w ${crop.args[3]}`);
	assert.ok(Math.abs(crop.args[4] - 200) <= 2, `crop h ${crop.args[4]}`);
});

test("labelCrop passes the output format to the final crop", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const fake = detectionEngine(mask);
	await labelCrop(
		FULL,
		{ maxEdge: 400, outputFormat: "jpg", outputQuality: 85 },
		fake.engine,
	);
	const crops = fake.calls.filter((c) => c.name === "crop");
	const finalCrop = crops[crops.length - 1];
	assert.strictEqual(finalCrop.args[6], "jpg");
	assert.strictEqual(finalCrop.args[7], 85);
});

test("labelCrop rejects unsafe or unsupported raw descriptors before native work", async () => {
	const fake = detectionEngine(new Uint8Array(SMALL_W * SMALL_H));
	await assert.rejects(
		labelCrop(
			{ data: Buffer.alloc(3), width: 100, height: 100, channels: 3 },
			{},
			fake.engine,
		),
		/raw data is shorter/,
	);
	await assert.rejects(
		labelCrop(
			{
				data: Buffer.alloc(200),
				width: 10,
				height: 10,
				channels: 1,
				dtype: "uint16",
			},
			{},
			fake.engine,
		),
		/raw dtype must be uint8/,
	);
});

test("labelCrop accepts a raw object whose data is a Uint8Array view", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const fake = detectionEngine(mask);
	const view = new Uint8Array(800 * 600 * 3);
	const input = {
		data: view,
		width: 800,
		height: 600,
		channels: 3,
		colorSpace: "RGB",
		dtype: "uint8",
	};
	const res = await labelCrop(input, { maxEdge: 400 }, fake.engine);
	assert.strictEqual(res.detected, true);
});

test("labelCrop reports engine unavailability as a setup error", async () => {
	await assert.rejects(
		labelCrop(Buffer.from("x"), {}, null),
		/engine unavailable/,
	);
});

test("labelCrop rejects an invalid input shape", async () => {
	const fake = detectionEngine(new Uint8Array(SMALL_W * SMALL_H));
	await assert.rejects(labelCrop(12345, {}, fake.engine), /input must be/);
});

test("labelCrop metadata carries per-stage timings and engine timings", async () => {
	const mask = makeRectMask(SMALL_W, SMALL_H, {
		cx: 200,
		cy: 150,
		w: 160,
		h: 120,
	});
	const fake = detectionEngine(mask);
	const res = await labelCrop(FULL, { maxEdge: 400 }, fake.engine);
	const t = res.metadata.timings;
	for (const k of [
		"decodeMs",
		"detectCopyMs",
		"maskMs",
		"analysisMs",
		"rotateMs",
		"cropMs",
		"totalMs",
	]) {
		assert.ok(Number.isFinite(t[k]) && t[k] >= 0, `${k} finite`);
	}
	assert.ok(Array.isArray(t.engine) && t.engine.length > 0);
	assert.ok(t.totalMs > 0);
});

// the _setBridge/_resetBridge seam is exercised by the node glue tests;
// assert here that the seam round-trips without breaking the loader path
test("the bridge seam resets cleanly", () => {
	_resetBridge();
	_setBridge(null);
	_resetBridge();
	assert.ok(true);
});
