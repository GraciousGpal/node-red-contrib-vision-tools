/**
 * lib/goldenRegions.js: a barcode box measured on the golden, carried
 * through the trained transform (and, without a rectified payload, back
 * through the rectification) into the frame barcode-locate decodes.
 *
 * The fixture is the demo rig's own numbers from the probe that read
 * 149/149 photos (scratchpad qc/bcprobe.js, 2026-10-08): the 400 dpi
 * golden render 2950x4250, compared at 1475x2125 against the halved
 * rectified frame 1500x1850 (working 1723x2125), decoded on the native
 * 3000x3700 camera frame. The expected box is worked by hand below, not
 * read back from the code under test.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { mapProfileRegions, nominalPlacement, goldenToFrameAffine } = require("../lib/goldenRegions.js");
const { applyHomography } = require("../lib/homography.js");

const TRANSFORM = Object.freeze({
	scaleX: 1.1284,
	scaleY: 0.9671,
	goldenWidth: 1475,
	goldenHeight: 2125,
	frameWidth: 1723,
	frameHeight: 2125,
	frameNativeWidth: 1500,
	frameNativeHeight: 1850,
	placement: Object.freeze({ ox: 31.4, oy: -8.3, angleDeg: 0 }),
});
const GOLDEN_NATIVE = { width: 2950, height: 4250 };
const BOX = { label: "Code128 7 89G", format: "Code128", text: "7 89G", x: 205, y: 2423, width: 151, height: 1117 };
const PAYLOAD = { width: 3000, height: 3700 };

function profile(overrides = {}, regions = [BOX]) {
	return {
		transform: { ...TRANSFORM, ...overrides },
		barcodes: { regions },
		goldenNative: GOLDEN_NATIVE,
	};
}

function only(result) {
	assert.strictEqual(result.regions.length, 1, JSON.stringify(result));
	return result.regions[0];
}

test("the probe's numbers map to the box worked by hand", () => {
	// 1. golden native -> working: gs = 1475 / 2950 = 0.5
	//      x0 = 205 * 0.5 = 102.5        x1 = (205 + 151) * 0.5 = 178
	//      y0 = 2423 * 0.5 = 1211.5      y1 = (2423 + 1117) * 0.5 = 1770
	// 2. -> frame working (angle 0): tx = 31.4 + 1.1284 gx, ty = -8.3 + 0.9671 gy
	//      tx0 = 31.4 + 115.661   = 147.061      tx1 = 31.4 + 200.8552  = 232.2552
	//      ty0 = -8.3 + 1171.6417 = 1163.3417    ty1 = -8.3 + 1711.767  = 1703.467
	// 3.+4. -> compare input (x 1500/1723) -> payload (x 3000/1500): k = 3000/1723 = 1.741149
	//      x0 = 256.055 -> 256     x1 = 404.391 -> 404     width  = 148
	//      y0 = 2025.551 -> 2026   y1 = 2965.990 -> 2966   height = 940
	const result = mapProfileRegions(profile(), PAYLOAD, null, { pad: 0, padMinPx: 0 });
	assert.deepStrictEqual(result.warnings, []);
	assert.deepStrictEqual(only(result), {
		label: BOX.label,
		format: "Code128",
		text: "7 89G",
		x: 256,
		y: 2026,
		width: 148,
		height: 940,
	});
});

test("pad grows the box symmetrically, as a fraction of the longer edge", () => {
	const bare = only(mapProfileRegions(profile(), PAYLOAD, null, { pad: 0, padMinPx: 0 }));
	const padded = only(mapProfileRegions(profile(), PAYLOAD, null, { pad: 0.2, padMinPx: 0 }));
	// longer edge in golden working px: 1117 * 0.5 = 558.5; pad 0.2 -> 111.7
	// working px each side; in payload px that is 111.7 * 1.1284 * k across
	// and 111.7 * 0.9671 * k down
	const k = 3000 / 1723;
	const growX = 111.7 * 1.1284 * k;
	const growY = 111.7 * 0.9671 * k;
	assert.ok(Math.abs(bare.x - padded.x - growX) <= 1, `left grew ${bare.x - padded.x}, want ~${growX.toFixed(1)}`);
	assert.ok(Math.abs(padded.x + padded.width - (bare.x + bare.width) - growX) <= 1, "right grew the same");
	assert.ok(Math.abs(bare.y - padded.y - growY) <= 1, `top grew ${bare.y - padded.y}, want ~${growY.toFixed(1)}`);
	assert.ok(Math.abs(padded.y + padded.height - (bare.y + bare.height) - growY) <= 1, "bottom grew the same");
});

test("padMinPx wins for a small box", () => {
	// a 50 px DataMatrix: 25 working px, pad 0.2 would be 5 px; 64 wins
	const small = { label: "dm", format: "DataMatrix", text: "x", x: 1000, y: 1000, width: 50, height: 50 };
	const prop = only(mapProfileRegions(profile({}, [small]), PAYLOAD, null, { pad: 0.2, padMinPx: 0 }));
	const floor = only(mapProfileRegions(profile({}, [small]), PAYLOAD, null, { pad: 0.2, padMinPx: 64 }));
	const k = 3000 / 1723;
	const growX = (64 - 5) * 1.1284 * k; // the extra pad, each side
	assert.ok(Math.abs(prop.x - floor.x - growX) <= 1, `left grew ${prop.x - floor.x}, want ~${growX.toFixed(1)}`);
	assert.ok(floor.width > prop.width + 2 * growX - 2);
	// and where the proportional pad is larger, the floor changes nothing
	const big = only(mapProfileRegions(profile(), PAYLOAD, null, { pad: 0.2, padMinPx: 64 }));
	assert.deepStrictEqual(big, only(mapProfileRegions(profile(), PAYLOAD, null, { pad: 0.2, padMinPx: 0 })));
});

test("no recorded placement: the nominal one, with a warning", () => {
	const nominal = nominalPlacement(TRANSFORM);
	// (1723 - 1.1284 * 1475) / 2 = (1723 - 1664.39) / 2 = 29.305
	// (2125 - 0.9671 * 2125) / 2 = 69.9125 / 2 = 34.95625
	assert.ok(Math.abs(nominal.ox - 29.305) < 1e-9, String(nominal.ox));
	assert.ok(Math.abs(nominal.oy - 34.95625) < 1e-9, String(nominal.oy));
	assert.strictEqual(nominal.angleDeg, 0);

	const result = mapProfileRegions(profile({ placement: undefined }), PAYLOAD, null, {});
	assert.strictEqual(result.warnings.length, 1);
	assert.match(result.warnings[0], /no recorded placement/);
	const pinned = only(mapProfileRegions(profile({ placement: nominal }), PAYLOAD, null, {}));
	assert.deepStrictEqual(only(result), pinned, "the fallback is exactly the nominal placement");
});

test("goldenToFrameAffine is the compare's model", () => {
	const A = goldenToFrameAffine(TRANSFORM, { ox: 10, oy: 20, angleDeg: 90 });
	// 90 degrees: tx = ox - my*gy, ty = oy + mx*gx
	const gx = 100;
	const gy = 50;
	assert.ok(Math.abs(A.a * gx + A.b * gy + A.c - (10 - 0.9671 * 50)) < 1e-9);
	assert.ok(Math.abs(A.d * gx + A.e * gy + A.f - (20 + 1.1284 * 100)) < 1e-9);
});

test("an identity calibration changes nothing", () => {
	const calibration = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], nativeWidth: 3000, nativeHeight: 3700 };
	const plain = mapProfileRegions(profile(), PAYLOAD, null, { pad: 0.2, padMinPx: 64 });
	const calibrated = mapProfileRegions(profile(), PAYLOAD, calibration, { pad: 0.2, padMinPx: 64 });
	assert.deepStrictEqual(calibrated, plain);
});

test("a pure-scale calibration round-trips through the rectification", () => {
	// measured on a 1500x1850 calibration photo, so it is rescaled to the
	// payload first (an identity conjugation for a pure scale about the
	// origin); its inverse halves every point, and H brings the corners back
	const H = [2, 0, 0, 0, 2, 0, 0, 0, 1];
	const calibration = { homography: H, nativeWidth: 1500, nativeHeight: 1850 };
	const plain = only(mapProfileRegions(profile(), PAYLOAD, null, {}));
	const result = mapProfileRegions(profile(), PAYLOAD, calibration, {});
	assert.deepStrictEqual(result.warnings, []);
	const back = only(result);
	const tl = applyHomography(H, back.x, back.y);
	const br = applyHomography(H, back.x + back.width, back.y + back.height);
	// one rounding on each side of the doubling: within 2 px
	assert.ok(Math.abs(tl.x - plain.x) <= 2 && Math.abs(tl.y - plain.y) <= 2, JSON.stringify({ tl, plain }));
	assert.ok(Math.abs(br.x - (plain.x + plain.width)) <= 2 && Math.abs(br.y - (plain.y + plain.height)) <= 2, JSON.stringify({ br, plain }));
});

test("a payload of another aspect warns", () => {
	const result = mapProfileRegions(profile(), { width: 3000, height: 3000 }, null, {});
	assert.strictEqual(result.warnings.length, 1);
	assert.match(result.warnings[0], /not the aspect of the frame/);
	assert.strictEqual(result.regions.length, 1, "mapping still proceeds");
});

test("a calibration of another aspect warns and gives no regions, without throwing", () => {
	// 3000x3000 against a 3000x3700 payload is far past rescaleHomography's 0.5 %
	const calibration = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], nativeWidth: 3000, nativeHeight: 3000 };
	let result;
	assert.doesNotThrow(() => {
		result = mapProfileRegions(profile(), PAYLOAD, calibration, {});
	});
	assert.deepStrictEqual(result.regions, []);
	assert.strictEqual(result.warnings.length, 1);
	assert.match(result.warnings[0], /cannot undo the rectification: .*aspect ratio/);
});

test("a box past the payload's edge is clamped, and one wholly outside is dropped", () => {
	const edge = { label: "edge", x: 2850, y: 100, width: 300, height: 300 };
	const outside = { label: "out", x: 5000, y: 100, width: 100, height: 100 };
	const result = mapProfileRegions(profile({}, [edge, outside, BOX]), PAYLOAD, null, {});
	assert.deepStrictEqual(
		result.regions.map((r) => r.label),
		["edge", BOX.label],
	);
	const clamped = result.regions[0];
	assert.strictEqual(clamped.x + clamped.width, PAYLOAD.width);
	assert.ok(clamped.width > 0 && clamped.x >= 0);
});

test("a transform without the frame fields throws a clear error", () => {
	const legacy = { scaleX: 1.1, scaleY: 0.9, goldenWidth: 1475, goldenHeight: 2125, angleDeg: 0 };
	assert.throws(
		() => mapProfileRegions({ transform: legacy, barcodes: { regions: [BOX] }, goldenNative: GOLDEN_NATIVE }, PAYLOAD, null, {}),
		/no frameWidth, frameHeight, frameNativeWidth, frameNativeHeight .*retrain the transform with this version/,
	);
	assert.throws(() => mapProfileRegions({ transform: null, barcodes: { regions: [] }, goldenNative: GOLDEN_NATIVE }, PAYLOAD, null, {}), /no transform section/);
});

test("a box with no position is dropped, not passed on as NaN", () => {
	const noX = { label: "no x", width: 100, height: 100, y: 100 };
	const result = mapProfileRegions(profile({}, [noX, BOX]), PAYLOAD, null, {});
	assert.deepStrictEqual(
		result.regions.map((r) => r.label),
		[BOX.label],
	);
	for (const r of result.regions) {
		for (const k of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(r[k]), `${k} ${r[k]}`);
	}
});

test("a box with a corner on the homography's horizon is dropped", () => {
	// Everything 1:1 so the corner coordinates are exact: golden native =
	// golden working = frame working = frame native = payload, placement 0,
	// no pad. The inverse homography's projective row (-1/128, 0, 1) is zero
	// at x = 128, so the corner (128, 0) maps to (128/0, 0/0) = (Inf, NaN).
	// H is that inverse's inverse: [1,0,0, 0,1,0, 1/128,0,1].
	const flat = {
		scaleX: 1,
		scaleY: 1,
		goldenWidth: 1000,
		goldenHeight: 1000,
		frameWidth: 1000,
		frameHeight: 1000,
		frameNativeWidth: 1000,
		frameNativeHeight: 1000,
		placement: { ox: 0, oy: 0, angleDeg: 0 },
	};
	const frame = { width: 1000, height: 1000 };
	const calibration = { homography: [1, 0, 0, 0, 1, 0, 1 / 128, 0, 1], nativeWidth: 1000, nativeHeight: 1000 };
	const horizon = { label: "horizon", x: 128, y: 0, width: 50, height: 50 };
	const fine = { label: "fine", x: 10, y: 500, width: 50, height: 50 };
	const result = mapProfileRegions(
		{ transform: flat, barcodes: { regions: [horizon, fine] }, goldenNative: { width: 1000, height: 1000 } },
		frame,
		calibration,
		{},
	);
	assert.deepStrictEqual(
		result.regions.map((r) => r.label),
		["fine"],
	);
	for (const r of result.regions) {
		for (const k of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(r[k]), `${k} ${r[k]}`);
	}
});
