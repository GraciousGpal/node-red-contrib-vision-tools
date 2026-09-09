/**
 * label-crop's `boundaryMode: "calipers"` path: the boundary comes from
 * four operator-drawn line-finder regions instead of a whole-frame blob
 * search.
 *
 * Kept apart from labelCrop.test.js because the interesting assertions
 * are different in kind - these are about *which* orchestration runs
 * (no Otsu, no maxEdge copy, full-resolution measurement) and about the
 * miss policy, not about the blob analysis.
 *
 * As in labelCrop.test.js the engine is a fake, so the suite is hermetic:
 * the real cpp-bridge ships no win32 binary.
 */

const test = require("node:test");
const assert = require("node:assert");
const { labelCrop } = require("../lib/labelCrop.js");
const { rawImage } = require("./helpers/synthetic.js");

// ---- a frame with a findable label boundary ---------------------------

const W = 400;
const H = 500;
const LABEL = { x0: 40, x1: 340, y0: 60, y1: 430 };

/**
 * A pale label on a darker ground. The step is deliberately small (25
 * levels) and there is a *much* stronger printed rule just inside the
 * left edge, so a blob search would take the rule - which is the whole
 * reason this mode exists.
 */
function frame({ withPrint = true } = {}) {
	const g = new Uint8Array(W * H);
	g.fill(70);
	for (let y = LABEL.y0; y < LABEL.y1; y++) {
		const row = y * W;
		for (let x = LABEL.x0; x < LABEL.x1; x++) g[row + x] = 95;
	}
	if (withPrint) {
		for (let y = LABEL.y0 + 20; y < LABEL.y1 - 20; y++) {
			const row = y * W;
			for (let x = LABEL.x0 + 18; x < LABEL.x0 + 26; x++) g[row + x] = 5;
		}
	}
	return g;
}

const REGIONS = {
	left: { x: 20, y: 120, width: 34, height: 260, contrastThreshold: 1 },
	right: { x: 326, y: 120, width: 34, height: 260, contrastThreshold: 1 },
	top: { x: 100, y: 44, width: 180, height: 34, contrastThreshold: 1 },
	bottom: { x: 100, y: 414, width: 180, height: 34, contrastThreshold: 1 },
};

/**
 * Engine fake that records calls. crop/rotate return correctly sized raw
 * images so the tail's geometry is exercised for real; only the pixels
 * are stand-ins.
 */
function fakeEngine(gray) {
	const calls = [];
	const img = rawImage(gray, W, H, 1, "GRAY");
	return {
		calls,
		async colorConvert(image, space) {
			calls.push({ op: "colorConvert", space });
			return { image: image === undefined ? img : { ...img }, timing: {} };
		},
		async resize(image, wm, wv, hm, hv) {
			calls.push({ op: "resize", wv, hv });
			return { image: rawImage(new Uint8Array(wv * hv), wv, hv, 1, "GRAY"), timing: {} };
		},
		async filter(image, type) {
			calls.push({ op: "filter", type });
			return { image, timing: {} };
		},
		async crop(image, x, y, w, h) {
			calls.push({ op: "crop", x, y, w, h });
			return { image: rawImage(new Uint8Array(w * h), w, h, 1, "GRAY"), timing: {} };
		},
		async rotate(image, angle) {
			calls.push({ op: "rotate", angle });
			return { image, timing: {} };
		},
	};
}

const CFG = {
	boundaryMode: "calipers",
	edgeRegions: REGIONS,
	outputFormat: "raw",
	minRotateAngleDeg: 0.5,
	cropMargin: 0,
};

// ---- the tests --------------------------------------------------------

test("calipers mode finds the boundary the blob search would miss", async () => {
	const gray = frame();
	const eng = fakeEngine(gray);
	const res = await labelCrop(rawImage(gray, W, H, 1, "GRAY"), CFG, eng);

	assert.strictEqual(res.detected, true, res.metadata.reason);
	const m = res.metadata;
	// the label spans x 40..340 and y 60..430, so its boundary sits at
	// 39.5/339.5 and 59.5/429.5 in pixel-centre coordinates
	assert.ok(Math.abs(m.width - 300) < 1.5, `width ${m.width}`);
	assert.ok(Math.abs(m.height - 370) < 1.5, `height ${m.height}`);
	assert.ok(Math.abs(m.center.x - 189.5) < 1.5, `cx ${m.center.x}`);
	assert.ok(Math.abs(m.center.y - 244.5) < 1.5, `cy ${m.center.y}`);
	assert.ok(Math.abs(m.angleDeg) < 0.2, `angle ${m.angleDeg}`);
});

test("calipers mode measures at full resolution, with no Otsu and no maxEdge copy", async () => {
	const gray = frame();
	const eng = fakeEngine(gray);
	const res = await labelCrop(rawImage(gray, W, H, 1, "GRAY"), { ...CFG, maxEdge: 64 }, eng);

	assert.strictEqual(res.detected, true, res.metadata.reason);
	// maxEdge is a blob-path setting; it must not shrink what the calipers
	// measure, or every reading would be six times coarser on a real frame
	assert.deepStrictEqual(res.metadata.smallSize, { width: W, height: H });
	assert.deepStrictEqual(res.metadata.scale, { x: 1, y: 1 });
	assert.ok(Math.abs(res.metadata.width - 300) < 1.5, `width ${res.metadata.width}`);
	assert.ok(!eng.calls.some((c) => c.op === "filter"), "no Otsu in calipers mode");
	assert.ok(
		!eng.calls.some((c) => c.op === "resize"),
		"no detection copy in calipers mode",
	);
});

test("the strong printed rule does not win, because it is outside every region", async () => {
	const withRule = await labelCrop(
		rawImage(frame({ withPrint: true }), W, H, 1, "GRAY"), CFG, fakeEngine(frame({ withPrint: true })));
	const withoutRule = await labelCrop(
		rawImage(frame({ withPrint: false }), W, H, 1, "GRAY"), CFG, fakeEngine(frame({ withPrint: false })));
	assert.strictEqual(withRule.detected, true);
	assert.strictEqual(withoutRule.detected, true);
	// the 90-level rule at x=58 is 18px inside the boundary; if it had any
	// influence the two widths would differ
	assert.ok(
		Math.abs(withRule.metadata.width - withoutRule.metadata.width) < 0.5,
		`${withRule.metadata.width} vs ${withoutRule.metadata.width}`,
	);
});

test("one edge not found fails the frame rather than guessing it", async () => {
	const gray = frame();
	const eng = fakeEngine(gray);
	const res = await labelCrop(
		rawImage(gray, W, H, 1, "GRAY"),
		{
			...CFG,
			edgeRegions: {
				...REGIONS,
				// aimed at blank ground well away from any edge
				top: { x: 150, y: 200, width: 80, height: 30, contrastThreshold: 20 },
			},
		},
		eng,
	);
	assert.strictEqual(res.detected, false);
	assert.match(res.metadata.reason, /^calipers:missing-edge:top$/);
	// the original frame passes through untouched on a miss
	assert.strictEqual(res.image.width, W);
	assert.ok(!eng.calls.some((c) => c.op === "rotate"), "nothing was cropped");
});

test("per-edge diagnostics survive onto the miss metadata", async () => {
	const gray = frame();
	const res = await labelCrop(
		rawImage(gray, W, H, 1, "GRAY"),
		{
			...CFG,
			edgeRegions: {
				...REGIONS,
				bottom: { x: 150, y: 200, width: 80, height: 30, contrastThreshold: 20 },
			},
		},
		fakeEngine(gray),
	);
	assert.strictEqual(res.detected, false);
	const edges = res.metadata.edges;
	assert.ok(edges, "edges should be reported so a bad region can be re-aimed");
	assert.strictEqual(edges.left.found, true);
	assert.strictEqual(edges.bottom.found, false);
	assert.strictEqual(edges.bottom.reason, "no-edge");
	assert.strictEqual(edges.left.calipers.total, 16);
});

test("an unconfigured edge is named rather than silently skipped", async () => {
	const gray = frame();
	const res = await labelCrop(
		rawImage(gray, W, H, 1, "GRAY"),
		{ ...CFG, edgeRegions: { left: REGIONS.left, top: REGIONS.top } },
		fakeEngine(gray),
	);
	assert.strictEqual(res.detected, false);
	assert.strictEqual(res.metadata.reason, "calipers-unconfigured:right+bottom");
});

test("calipers mode with no regions at all is a miss, not a crash", async () => {
	const gray = frame();
	const res = await labelCrop(
		rawImage(gray, W, H, 1, "GRAY"),
		{ boundaryMode: "calipers", outputFormat: "raw" },
		fakeEngine(gray),
	);
	assert.strictEqual(res.detected, false);
	assert.match(res.metadata.reason, /^calipers-unconfigured:/);
});

test("blob mode is untouched by the new option defaulting off", async () => {
	// the default must stay "blob": an existing flow's behaviour cannot
	// change because a new mode was added
	const gray = frame();
	const eng = fakeEngine(gray);
	await labelCrop(rawImage(gray, W, H, 1, "GRAY"), { outputFormat: "raw" }, eng);
	assert.ok(eng.calls.some((c) => c.op === "filter"), "blob mode still runs Otsu");
});
