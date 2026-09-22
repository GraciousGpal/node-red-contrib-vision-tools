/**
 * Caliper line-finder tests.
 *
 * Everything here runs on synthetic grayscale rasters built in-process:
 * `lib/lineFinder.js` is pure JS with no engine dependency, which is the
 * point of it, so the suite is hermetic on every platform.
 *
 * The cases that matter are the ones the Inspection rig actually hits:
 * a *weak* boundary step sitting a few millimetres from a much stronger
 * printed rule, sub-pixel accuracy over a long edge, and a tilted edge.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
	findLine,
	intersectLines,
	rectFromLines,
	normalizeCfg,
	normalizeRegion,
	findEdges,
	fitLine,
} = require("../lib/lineFinder.js");

// ---- synthetic images -------------------------------------------------

/** Flat grey canvas. */
function canvas(width, height, value = 128) {
	const g = new Uint8Array(width * height);
	g.fill(value);
	return { gray: g, width, height };
}

/**
 * Paint a vertical step whose boundary lies at `edgeX`, measured in the
 * same pixel-centre coordinates the finder reports in: pixel i covers
 * [i-0.5, i+0.5], so its share of `to` is (i + 0.5 - edgeX). A fractional
 * edgeX therefore leaves one blended pixel, which is what a real sensor
 * produces and what the sub-pixel refinement has to recover.
 */
function vStep(img, edgeX, to) {
	for (let y = 0; y < img.height; y++) {
		const row = y * img.width;
		for (let x = 0; x < img.width; x++) {
			const cover = Math.min(1, Math.max(0, x + 0.5 - edgeX));
			if (cover <= 0) continue;
			img.gray[row + x] = Math.round(
				img.gray[row + x] * (1 - cover) + to * cover,
			);
		}
	}
}

/** Paint a horizontal step whose boundary lies at `edgeY`. */
function hStep(img, edgeY, to) {
	for (let y = 0; y < img.height; y++) {
		const cover = Math.min(1, Math.max(0, y + 0.5 - edgeY));
		if (cover <= 0) continue;
		const row = y * img.width;
		for (let x = 0; x < img.width; x++) {
			img.gray[row + x] = Math.round(
				img.gray[row + x] * (1 - cover) + to * cover,
			);
		}
	}
}

/** Paint a vertical bar (a printed rule) of the given width. */
function vBar(img, x0, w, value) {
	for (let y = 0; y < img.height; y++) {
		const row = y * img.width;
		for (let x = x0; x < x0 + w; x++) {
			if (x >= 0 && x < img.width) img.gray[row + x] = value;
		}
	}
}

/** Paint a step whose boundary is a straight line through (x0,0) tilted by slope. */
function tiltedVStep(img, xAt0, slope, to) {
	for (let y = 0; y < img.height; y++) {
		const edgeX = xAt0 + slope * y;
		const row = y * img.width;
		for (let x = 0; x < img.width; x++) {
			const cover = Math.min(1, Math.max(0, x + 0.5 - edgeX));
			if (cover <= 0) continue;
			img.gray[row + x] = Math.round(
				img.gray[row + x] * (1 - cover) + to * cover,
			);
		}
	}
}

/** Deterministic pseudo-random noise, so a failure is always reproducible. */
function addNoise(img, amplitude, seed = 1) {
	let s = seed >>> 0;
	for (let i = 0; i < img.gray.length; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		const n = ((s >>> 16) / 65535 - 0.5) * 2 * amplitude;
		img.gray[i] = Math.min(255, Math.max(0, Math.round(img.gray[i] + n)));
	}
}

// ---- config / region plumbing ----------------------------------------

test("normalizeCfg clamps and rejects unknown enum values", () => {
	const cfg = normalizeCfg({
		scanDirection: "sideways",
		polarity: "nonsense",
		edgeSelect: "middle",
		calipers: 10000,
		contrastThreshold: -5,
		minCaliperFraction: 99,
	});
	assert.strictEqual(cfg.scanDirection, "right");
	assert.strictEqual(cfg.polarity, "either");
	assert.strictEqual(cfg.edgeSelect, "best");
	assert.strictEqual(cfg.calipers, 512);
	assert.strictEqual(cfg.contrastThreshold, 0);
	assert.strictEqual(cfg.minCaliperFraction, 1);
});

test("an explicit null disables the angle check", () => {
	// null is this option's documented "off" value, but for every other
	// option null means "not supplied" - so it needs its own path.
	assert.strictEqual(normalizeCfg({ angleToleranceDeg: null }).angleToleranceDeg, null);
	assert.strictEqual(normalizeCfg({ angleToleranceDeg: "" }).angleToleranceDeg, null);
	assert.strictEqual(normalizeCfg({}).angleToleranceDeg, 10);
	assert.strictEqual(normalizeCfg({ angleToleranceDeg: 3 }).angleToleranceDeg, 3);
});

test("normalizeCfg keeps an explicit zero rather than treating it as absent", () => {
	// 0 is meaningful for both of these and must not fall back to the
	// default the way "" and null do.
	const cfg = normalizeCfg({ contrastThreshold: 0, filterHalfWidth: 0 });
	assert.strictEqual(cfg.contrastThreshold, 0);
	assert.strictEqual(cfg.filterHalfWidth, 0);
});

test("normalizeRegion rejects a degenerate region", () => {
	assert.throws(() => normalizeRegion({ x: 0, y: 0, width: 0, height: 10 }), /positive/);
	assert.throws(() => normalizeRegion({ x: 0, y: 0, width: 10 }), /positive/);
	assert.throws(() => normalizeRegion(null), /region/);
	const r = normalizeRegion({ x: 10, y: 20, width: 100, height: 50 });
	assert.strictEqual(r.cx, 60);
	assert.strictEqual(r.cy, 45);
	assert.strictEqual(r.angleDeg, 0);
});

// ---- edge extraction --------------------------------------------------

test("findEdges honours polarity", () => {
	// dark -> light -> dark, so one rising and one falling edge
	const p = new Float64Array(40);
	for (let i = 0; i < 40; i++) p[i] = i >= 10 && i < 30 ? 200 : 50;
	const cfg = normalizeCfg({ contrastThreshold: 5 });
	assert.strictEqual(findEdges(p, cfg).length, 2);
	const rising = findEdges(p, normalizeCfg({ contrastThreshold: 5, polarity: "darkToLight" }));
	assert.strictEqual(rising.length, 1);
	assert.ok(rising[0].strength > 0);
	assert.ok(Math.abs(rising[0].at - 9.5) < 1.5, `rising at ${rising[0].at}`);
	const falling = findEdges(p, normalizeCfg({ contrastThreshold: 5, polarity: "lightToDark" }));
	assert.strictEqual(falling.length, 1);
	assert.ok(falling[0].strength < 0);
});

test("findEdges ignores steps below the contrast threshold", () => {
	const p = new Float64Array(40);
	for (let i = 0; i < 40; i++) p[i] = i >= 20 ? 54 : 50; // a 4-level step
	assert.strictEqual(findEdges(p, normalizeCfg({ contrastThreshold: 10 })).length, 0);
	assert.strictEqual(findEdges(p, normalizeCfg({ contrastThreshold: 1 })).length, 1);
});

test("fitLine represents a vertical line, which least squares on y cannot", () => {
	const pts = [
		{ x: 100, y: 0 },
		{ x: 100, y: 50 },
		{ x: 100, y: 100 },
	];
	const line = fitLine(pts);
	assert.ok(Math.abs(line.cx - 100) < 1e-9);
	// direction is vertical: dx ~ 0, |dy| ~ 1
	assert.ok(Math.abs(line.dx) < 1e-9, `dx=${line.dx}`);
	assert.ok(Math.abs(Math.abs(line.dy) - 1) < 1e-9);
});

// ---- the real job -----------------------------------------------------

test("finds a clean vertical edge and reports it as vertical", () => {
	const img = canvas(200, 300, 60);
	vStep(img, 80, 200);
	const res = findLine(img.gray, img.width, img.height,
		{ x: 40, y: 20, width: 80, height: 260 },
		{ scanDirection: "right", polarity: "darkToLight", calipers: 10 });
	assert.strictEqual(res.found, true, res.reason);
	assert.ok(Math.abs(res.line.x - 80) < 0.6, `edge at ${res.line.x}`);
	assert.ok(Math.abs(Math.abs(res.angleDeg) - 90) < 0.5, `angle ${res.angleDeg}`);
	assert.strictEqual(res.calipers.used, 10);
	assert.ok(res.score > 0.9, `score ${res.score}`);
});

test("a weak boundary step is found even with a much stronger rule nearby", () => {
	// The Inspection rig in miniature: a 6-level label boundary at x=80
	// with a 120-level printed rule at x=140. A whole-frame search takes
	// the rule; a region drawn over the boundary cannot.
	const img = canvas(300, 400, 120);
	vStep(img, 80, 126);
	vBar(img, 140, 4, 6);
	addNoise(img, 2, 7);

	const boundary = findLine(img.gray, img.width, img.height,
		{ x: 55, y: 20, width: 45, height: 360 },
		{ scanDirection: "right", polarity: "darkToLight", contrastThreshold: 0.8, calipers: 12 });
	assert.strictEqual(boundary.found, true, boundary.reason);
	assert.ok(Math.abs(boundary.line.x - 80) < 1.5, `boundary at ${boundary.line.x}`);

	// widening the region to include the rule and asking for the *best*
	// edge finds the rule instead - which is exactly the failure a drawn
	// region prevents
	const wide = findLine(img.gray, img.width, img.height,
		{ x: 55, y: 20, width: 130, height: 360 },
		{ scanDirection: "right", contrastThreshold: 0.8, calipers: 12 });
	assert.strictEqual(wide.found, true, wide.reason);
	// either side of the 4px rule, but nowhere near the boundary at x=80
	assert.ok(wide.line.x > 130, `strongest edge at ${wide.line.x}, expected the rule`);
});

test("sub-pixel: a fractional edge is located to better than half a pixel", () => {
	for (const trueX of [80.0, 80.25, 80.5, 80.75]) {
		const img = canvas(200, 300, 60);
		vStep(img, trueX, 200);
		const res = findLine(img.gray, img.width, img.height,
			{ x: 50, y: 20, width: 60, height: 260 },
			{ scanDirection: "right", polarity: "darkToLight", calipers: 8, filterHalfWidth: 1 });
		assert.strictEqual(res.found, true, res.reason);
		assert.ok(Math.abs(res.line.x - trueX) < 0.5,
			`edge ${trueX} located at ${res.line.x.toFixed(3)}`);
	}
});

test("recovers the angle of a tilted edge", () => {
	const img = canvas(300, 400, 40);
	// 2 px of run over 400 px of rise
	const slope = 2 / 400;
	tiltedVStep(img, 100, slope, 210);
	const res = findLine(img.gray, img.width, img.height,
		{ x: 70, y: 10, width: 60, height: 380 },
		{ scanDirection: "right", polarity: "darkToLight", calipers: 16 });
	assert.strictEqual(res.found, true, res.reason);
	const expected = 90 - (Math.atan(slope) * 180) / Math.PI;
	assert.ok(Math.abs(Math.abs(res.angleDeg) - expected) < 0.2,
		`angle ${res.angleDeg} vs expected ${expected}`);
	assert.ok(res.residualPx < 0.5, `residual ${res.residualPx}`);
});

test("scan direction picks which side of a bar is reported", () => {
	const img = canvas(200, 200, 30);
	vBar(img, 90, 20, 220); // bright bar from x=90 to x=110
	const fromLeft = findLine(img.gray, img.width, img.height,
		{ x: 40, y: 20, width: 120, height: 160 },
		{ scanDirection: "right", polarity: "darkToLight", calipers: 8 });
	const fromRight = findLine(img.gray, img.width, img.height,
		{ x: 40, y: 20, width: 120, height: 160 },
		{ scanDirection: "left", polarity: "darkToLight", calipers: 8 });
	assert.strictEqual(fromLeft.found, true);
	assert.strictEqual(fromRight.found, true);
	assert.ok(Math.abs(fromLeft.line.x - 89.5) < 1.5, `left edge ${fromLeft.line.x}`);
	assert.ok(Math.abs(fromRight.line.x - 109.5) < 1.5, `right edge ${fromRight.line.x}`);
});

test("ignoreCount steps past a known first edge", () => {
	const img = canvas(240, 200, 100);
	vStep(img, 40, 20); // a frame vignette
	vStep(img, 120, 200); // the edge actually wanted
	const cfg = { scanDirection: "right", polarity: "lightToDark", calipers: 8, contrastThreshold: 2 };
	const first = findLine(img.gray, img.width, img.height,
		{ x: 10, y: 20, width: 200, height: 160 }, { ...cfg, edgeSelect: "first" });
	assert.ok(Math.abs(first.line.x - 40) < 2, `first edge ${first.line.x}`);
	const skipped = findLine(img.gray, img.width, img.height,
		{ x: 10, y: 20, width: 200, height: 160 },
		{ ...cfg, edgeSelect: "first", ignoreCount: 1 });
	assert.strictEqual(skipped.found, false, "second edge is a rise, not a fall");
	// with the matching polarity the skip lands on the wanted edge
	const rising = findLine(img.gray, img.width, img.height,
		{ x: 10, y: 20, width: 200, height: 160 },
		{ ...cfg, polarity: "darkToLight", edgeSelect: "first" });
	assert.ok(Math.abs(rising.line.x - 120) < 2, `rising edge ${rising.line.x}`);
});

test("a caliper that lands on dirt is dropped as an outlier", () => {
	const img = canvas(200, 400, 60);
	vStep(img, 90, 200);
	// a bright speck well off the edge, covering one caliper band
	for (let y = 200; y < 230; y++) {
		for (let x = 60; x < 68; x++) img.gray[y * img.width + x] = 255;
	}
	const res = findLine(img.gray, img.width, img.height,
		{ x: 40, y: 0, width: 80, height: 400 },
		{ scanDirection: "right", polarity: "darkToLight", calipers: 10, edgeSelect: "first" });
	assert.strictEqual(res.found, true, res.reason);
	assert.ok(res.calipers.used < res.calipers.found, "the speck caliper should be trimmed");
	assert.ok(Math.abs(res.line.x - 90) < 1, `edge held at ${res.line.x}`);
	assert.ok(res.points.some((p) => !p.used), "the outlier is reported, not hidden");
});

test("a region with no qualifying edge is a clean miss, not a guess", () => {
	const img = canvas(200, 200, 100);
	addNoise(img, 1, 3);
	const res = findLine(img.gray, img.width, img.height,
		{ x: 40, y: 40, width: 100, height: 100 },
		{ scanDirection: "right", contrastThreshold: 20, calipers: 8 });
	assert.strictEqual(res.found, false);
	assert.strictEqual(res.reason, "no-edge");
	assert.strictEqual(res.line, null);
	assert.strictEqual(res.score, 0);
});

test("an edge that leans too far from the region's orientation is rejected", () => {
	const img = canvas(400, 400, 50);
	// a 45-degree edge, searched by a region that expects a vertical one
	tiltedVStep(img, 60, 1, 220);
	const region = { x: 20, y: 20, width: 340, height: 340 };
	const loose = findLine(img.gray, img.width, img.height, region,
		{ scanDirection: "right", polarity: "darkToLight", calipers: 10, angleToleranceDeg: null });
	assert.strictEqual(loose.found, true, loose.reason);
	assert.ok(Math.abs(Math.abs(loose.angleDeg) - 45) < 1, `angle ${loose.angleDeg}`);

	const strict = findLine(img.gray, img.width, img.height, region,
		{ scanDirection: "right", polarity: "darkToLight", calipers: 10, angleToleranceDeg: 10 });
	assert.strictEqual(strict.found, false);
	assert.strictEqual(strict.reason, "angle-out-of-tolerance");
	// the rejected fit still reports what it saw, so the region can be re-aimed
	assert.ok(Math.abs(Math.abs(strict.angleDeg) - 45) < 1);
});

test("a horizontal step is invisible to a horizontal scan", () => {
	// not a failure mode so much as a fact about calipers: scanning along
	// an edge sees no transition at all. Worth pinning so the miss reason
	// stays "no-edge" rather than something that implies a bad fit.
	const img = canvas(300, 300, 50);
	hStep(img, 150, 220);
	const res = findLine(img.gray, img.width, img.height,
		{ x: 20, y: 20, width: 260, height: 260 },
		{ scanDirection: "right", calipers: 10 });
	assert.strictEqual(res.found, false);
	assert.strictEqual(res.reason, "no-edge");
});

// ---- explaining a miss ------------------------------------------------

test("a miss over flat grey reports a peak contrast below the threshold, and where every caliper looked", () => {
	const img = canvas(200, 200, 128);
	const region = { x: 20, y: 20, width: 100, height: 100 };
	const res = findLine(img.gray, img.width, img.height, region,
		{ scanDirection: "right", calipers: 10, contrastThreshold: 2 });
	assert.strictEqual(res.found, false);
	assert.strictEqual(res.reason, "no-edge");
	assert.ok(res.diagnostics.peakContrast < 2, `peak ${res.diagnostics.peakContrast}`);
	assert.strictEqual(res.diagnostics.peakContrast, 0, "nothing at all steps on flat grey");
	assert.strictEqual(res.diagnostics.medianPeakContrast, 0);
	assert.strictEqual(res.diagnostics.peakPolarity, null);
	assert.strictEqual(res.diagnostics.calipersWithEdge, 0);
	assert.strictEqual(res.diagnostics.calipersInImage, 10);

	// one caliper per band, hit or not, so a preview can draw the search
	assert.strictEqual(res.caliperLines.length, 10);
	const first = res.caliperLines[0];
	assert.strictEqual(first.band, 0);
	assert.strictEqual(first.complete, true);
	assert.strictEqual(first.edge, null);
	assert.strictEqual(first.used, false);
	// scanning right: the caliper runs from the region's left edge to its
	// right, through the centre of its 10px band
	assert.ok(Math.abs(first.p0.x - 20) < 1e-9 && Math.abs(first.p0.y - 25) < 1e-9, JSON.stringify(first.p0));
	assert.ok(Math.abs(first.p1.x - 120) < 1e-9 && Math.abs(first.p1.y - 25) < 1e-9, JSON.stringify(first.p1));
});

test("the reported peak contrast is the threshold that would have found the edge", () => {
	// a three-level step: real, but under a threshold of 5
	const img = canvas(200, 200, 128);
	vStep(img, 100, 131);
	const region = { x: 60, y: 20, width: 80, height: 160 };
	const cfg = { scanDirection: "right", calipers: 8, contrastThreshold: 5 };
	const miss = findLine(img.gray, img.width, img.height, region, cfg);
	assert.strictEqual(miss.found, false);
	assert.strictEqual(miss.reason, "no-edge");
	const peak = miss.diagnostics.peakContrast;
	assert.ok(peak > 0 && peak < 5, `peak ${peak}`);
	assert.strictEqual(miss.diagnostics.peakPolarity, "darkToLight");
	assert.ok(Math.abs(miss.diagnostics.medianPeakContrast - peak) < 1e-6, "a clean step looks the same to every caliper");
	for (const c of miss.caliperLines) {
		assert.ok(Math.abs(c.peakContrast - peak) < 1e-6);
	}

	// the promise the editor's status line makes: lower Contrast below the
	// peak and the edge is picked up
	const hit = findLine(img.gray, img.width, img.height, region,
		{ ...cfg, contrastThreshold: peak * 0.99 });
	assert.strictEqual(hit.found, true, hit.reason);
	assert.ok(Math.abs(hit.line.x - 100) < 0.6, `edge at ${hit.line.x}`);
	assert.strictEqual(hit.diagnostics.calipersWithEdge, 8);
});

test("caliperLines carry the chosen edge and mirror the outlier trim", () => {
	const img = canvas(200, 300, 60);
	vStep(img, 80, 200);
	// a bright speck captures one caliper band away from the edge
	for (let y = 120; y < 150; y++) {
		for (let x = 50; x < 56; x++) img.gray[y * img.width + x] = 255;
	}
	const res = findLine(img.gray, img.width, img.height,
		{ x: 40, y: 30, width: 80, height: 240 },
		{ scanDirection: "right", polarity: "darkToLight", calipers: 8, edgeSelect: "first" });
	assert.strictEqual(res.found, true, res.reason);
	const dropped = res.caliperLines.filter((c) => c.edge && !c.used);
	assert.strictEqual(dropped.length, 1, "the speck's caliper is dropped");
	assert.ok(dropped[0].edge.x < 60, `the dropped edge sits on the speck, at ${dropped[0].edge.x}`);
	// the same story the points tell, band for band
	for (const p of res.points) {
		const c = res.caliperLines[p.band];
		assert.strictEqual(c.used, p.used);
		assert.ok(Math.abs(c.edge.x - p.x) < 1e-9 && Math.abs(c.edge.y - p.y) < 1e-9);
	}
	assert.strictEqual(res.diagnostics.calipersWithEdge, 8);
	assert.ok(res.diagnostics.peakContrast > res.diagnostics.medianPeakContrast, "the speck is the strongest step");
});

test("a region partly outside the image skips only the bands that fall out", () => {
	const img = canvas(200, 300, 60);
	vStep(img, 80, 200);
	const res = findLine(img.gray, img.width, img.height,
		// hangs 60px below the bottom of the image
		{ x: 40, y: 100, width: 80, height: 260 },
		{ scanDirection: "right", polarity: "darkToLight", calipers: 13, minCaliperFraction: 0.4 });
	assert.strictEqual(res.found, true, res.reason);
	assert.ok(res.calipers.found < res.calipers.total, "some bands are outside");
	assert.ok(Math.abs(res.line.x - 80) < 0.8, `edge at ${res.line.x}`);
	// the skipped bands are still listed, flagged, so a preview can show them
	const outside = res.caliperLines.filter((c) => !c.complete);
	assert.strictEqual(outside.length, res.calipers.total - res.calipers.found);
	assert.ok(outside.every((c) => c.peakContrast === null && c.edge === null));
	assert.strictEqual(res.diagnostics.calipersInImage, res.calipers.found);
});

// ---- four edges into a rectangle -------------------------------------

test("intersectLines returns null for parallel lines", () => {
	const a = { x: 0, y: 0, dx: 1, dy: 0 };
	const b = { x: 0, y: 50, dx: 1, dy: 0 };
	assert.strictEqual(intersectLines(a, b), null);
	const c = { x: 30, y: 0, dx: 0, dy: 1 };
	const hit = intersectLines(a, c);
	assert.ok(Math.abs(hit.x - 30) < 1e-9 && Math.abs(hit.y) < 1e-9);
});

test("four found edges become the rectangle they bound", () => {
	const img = canvas(400, 500, 30);
	// a bright panel from (60,80) to (330,420)
	for (let y = 80; y < 420; y++) {
		for (let x = 60; x < 330; x++) img.gray[y * img.width + x] = 200;
	}
	const common = { calipers: 10, contrastThreshold: 5 };
	const left = findLine(img.gray, 400, 500, { x: 30, y: 120, width: 60, height: 260 },
		{ ...common, scanDirection: "right", polarity: "darkToLight" });
	const right = findLine(img.gray, 400, 500, { x: 300, y: 120, width: 60, height: 260 },
		{ ...common, scanDirection: "left", polarity: "darkToLight" });
	const top = findLine(img.gray, 400, 500, { x: 100, y: 50, width: 200, height: 60 },
		{ ...common, scanDirection: "down", polarity: "darkToLight" });
	const bottom = findLine(img.gray, 400, 500, { x: 100, y: 390, width: 200, height: 60 },
		{ ...common, scanDirection: "up", polarity: "darkToLight" });

	const rect = rectFromLines({ left, right, top, bottom });
	assert.strictEqual(rect.ok, true, rect.reason);
	assert.ok(Math.abs(rect.width - 270) < 1.5, `width ${rect.width}`);
	assert.ok(Math.abs(rect.height - 340) < 1.5, `height ${rect.height}`);
	assert.ok(Math.abs(rect.cx - 194.5) < 1.5, `cx ${rect.cx}`);
	assert.ok(Math.abs(rect.cy - 249.5) < 1.5, `cy ${rect.cy}`);
	assert.ok(Math.abs(rect.angleDeg) < 0.3, `angle ${rect.angleDeg}`);
	assert.strictEqual(rect.corners.length, 4);
});

test("rectFromLines names the edges that were not found", () => {
	const ok = { found: true, score: 1, residualPx: 0, angleDeg: 0, line: { x: 0, y: 0, dx: 1, dy: 0 } };
	const bad = { found: false, reason: "no-edge", score: 0 };
	const r = rectFromLines({ left: ok, right: bad, top: ok, bottom: bad });
	assert.strictEqual(r.ok, false);
	assert.match(r.reason, /missing-edge/);
	assert.deepStrictEqual(r.missing, ["right", "bottom"]);
});
