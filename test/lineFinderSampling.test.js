/**
 * lib/lineFinder.js builds its banded profiles two ways: the general one,
 * which samples through sampleBilinear, and a cheaper one for a region whose
 * axes are the image's, which resolves the interpolation weights once per
 * region instead of once per sample.
 *
 * The second exists only for speed, so the only acceptable difference
 * between them is none at all. "Close enough" would be a slow drift in
 * measured edge positions that no other test would notice - and the whole
 * point of this node is sub-pixel positions.
 *
 * So every value of every band is compared exactly, over regions chosen to
 * hit the awkward cases: fractional origins and sizes, band counts that do
 * not divide the region, single-row bands, and regions hanging off each edge
 * of the image.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
	profilesGeneral,
	profilesAxisAligned,
	isAxisAligned,
	regionFrame,
	normalizeRegion,
	findLine,
} = require("../lib/lineFinder.js");

const W = 320;
const H = 240;

/** Texture with structure at several scales, so equality is not vacuous. */
function image() {
	const g = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let v = 40 + ((x * 7 + y * 13) % 23);
			if (x > 150) v += 60; // a step
			if (x % 17 === 0) v += 25; // fine vertical rules
			if (y % 11 === 0) v += 9; // fine horizontal rules
			g[y * W + x] = Math.min(255, v);
		}
	}
	return g;
}

const GRAY = image();
const SCANS = ["right", "left", "down", "up"];

function geometryFor(region, scanDirection, bands) {
	const reg = normalizeRegion(region);
	const frame = regionFrame(reg, scanDirection);
	const scanSteps = Math.max(5, Math.round(frame.depth));
	const bandLength = frame.length / bands;
	const rowsPerBand = Math.max(1, Math.round(bandLength));
	return { frame, geom: { bands, scanSteps, bandLength, rowsPerBand } };
}

const REGIONS = [
	{ x: 100, y: 40, width: 60, height: 160 },
	// fractional origin and size: the weights are no longer a constant 0.5
	{ x: 100.25, y: 40.5, width: 60.75, height: 160.5 },
	// a band count that does not divide the length, so rows land off-centre
	{ x: 30, y: 30, width: 40, height: 101 },
	// one row per band
	{ x: 30, y: 30, width: 40, height: 12 },
	// hanging off each edge in turn
	{ x: -15, y: 40, width: 60, height: 160 },
	{ x: W - 20, y: 40, width: 60, height: 160 },
	{ x: 100, y: -12, width: 60, height: 160 },
	{ x: 100, y: H - 30, width: 60, height: 160 },
	// flush against the far edge, where sampleBilinear clamps its neighbour
	{ x: W - 60, y: H - 160, width: 60, height: 160 },
];
const BAND_COUNTS = [1, 3, 12, 16, 17];

test("the axis-aligned profiles are bit-identical to the general ones", () => {
	let compared = 0;
	let nulls = 0;
	for (const region of REGIONS) {
		for (const scan of SCANS) {
			for (const bands of BAND_COUNTS) {
				const { frame, geom } = geometryFor({ ...region, angleDeg: 0 }, scan, bands);
				assert.ok(isAxisAligned(frame), "an unrotated region must take the fast path");
				const slow = profilesGeneral(GRAY, W, H, frame, geom);
				const fast = profilesAxisAligned(GRAY, W, H, frame, geom);
				assert.strictEqual(fast.length, slow.length);
				for (let b = 0; b < bands; b++) {
					const where = `${JSON.stringify(region)} ${scan} bands=${bands} band=${b}`;
					if (slow[b] === null || fast[b] === null) {
						assert.strictEqual(
							fast[b] === null,
							slow[b] === null,
							`band completeness disagrees: ${where}`,
						);
						nulls++;
						continue;
					}
					assert.strictEqual(fast[b].length, slow[b].length, where);
					for (let s = 0; s < slow[b].length; s++) {
						// strictEqual, not a tolerance: same operations, same order
						assert.strictEqual(
							fast[b][s],
							slow[b][s],
							`${where} step=${s}: ${fast[b][s]} vs ${slow[b][s]}`,
						);
						compared++;
					}
				}
			}
		}
	}
	assert.ok(compared > 20000, `expected a real sweep, compared ${compared} values`);
	assert.ok(nulls > 0, "the out-of-frame regions should have produced skipped bands");
});

test("a rotated region keeps the general path", () => {
	// only an angle of exactly 0 is exactly axis-aligned: Math.sin(Math.PI) is
	// 1.2e-16, so 180 degrees is not, and snapping it would stop the fast path
	// being bit-identical
	for (const angleDeg of [0.001, 7.5, 45, 90, 180, -179.9]) {
		const { frame } = geometryFor({ x: 100, y: 40, width: 60, height: 160, angleDeg }, "right", 8);
		assert.strictEqual(
			isAxisAligned(frame),
			false,
			`${angleDeg} degrees should not be treated as axis-aligned`,
		);
	}
	const { frame } = geometryFor({ x: 100, y: 40, width: 60, height: 160, angleDeg: 0 }, "right", 8);
	assert.strictEqual(isAxisAligned(frame), true);
});

test("findLine gives the same answer either way", () => {
	// the profiles are equal, so the edge, the fit and the score must be too;
	// this checks the wiring rather than the arithmetic
	const region = { x: 120, y: 40, width: 70, height: 160 };
	for (const scan of ["right", "left"]) {
		const result = findLine(GRAY, W, H, region, {
			scanDirection: scan,
			polarity: "either",
			calipers: 8,
			contrastThreshold: 1,
		});
		assert.strictEqual(result.found, true, result.reason);
		// the step is at x > 150, and both paths must place it identically
		assert.ok(
			Math.abs(result.line.x - 150.5) < 2,
			`${scan}: edge at ${result.line.x}`,
		);
	}
});

test("a region entirely outside the image finds nothing, either way", () => {
	const region = { x: 400, y: 300, width: 40, height: 40 };
	const { frame, geom } = geometryFor({ ...region, angleDeg: 0 }, "right", 4);
	const slow = profilesGeneral(GRAY, W, H, frame, geom);
	const fast = profilesAxisAligned(GRAY, W, H, frame, geom);
	assert.deepStrictEqual(slow, [null, null, null, null]);
	assert.deepStrictEqual(fast, [null, null, null, null]);
	const result = findLine(GRAY, W, H, region, { scanDirection: "right", calipers: 4 });
	assert.strictEqual(result.found, false);
	assert.strictEqual(result.reason, "no-edge");
});
