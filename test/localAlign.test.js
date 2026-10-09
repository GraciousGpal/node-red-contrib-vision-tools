/**
 * The displacement measurement itself, tested directly.
 *
 * The end-to-end behaviour (does not hide extra ink, does not hide
 * missing ink, does not blur thin features away) lives in
 * compare.test.js. What that cannot pin down is whether the field is
 * *right* - an end-to-end defect ratio moves for many reasons, and on a
 * sparse synthetic label the effect of a 2px shift is smaller than the
 * block threshold, so it reports nothing either way. Here the answer is
 * known exactly.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { buildDisplacementField, smoothField, applyField } = require("../lib/localAlign.js");

const W = 384;
const H = 384;

/** Textured field - block matching needs something to lock onto. */
function texture(width, height) {
	const g = new Uint8Array(width * height).fill(240);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// aperiodic, so a match cannot slide a whole period and score the same
			const v = Math.sin(x * 0.21) + Math.sin(y * 0.13) + Math.sin((x + y) * 0.07);
			if (v > 0.8) g[y * width + x] = 20;
		}
	}
	return g;
}

/**
 * Copy, with the given rect displaced so that the golden's pixel (x,y)
 * lands in the frame at (x+dx, y+dy) - i.e. dx/dy are what the field
 * should measure. The frame therefore reads from src[x-dx].
 */
function displaced(src, width, height, rect, dx, dy) {
	const out = new Uint8Array(src);
	for (let y = rect.y0; y < rect.y1; y++) {
		for (let x = rect.x0; x < rect.x1; x++) {
			const sx = x - dx;
			const sy = y - dy;
			if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
			out[y * width + x] = src[sy * width + sx];
		}
	}
	return out;
}

const opts = { tile: 48, maxOffset: 4, minStdDev: 12 };
const cellAt = (field, x, y) =>
	field.gridW * Math.floor(y / opts.tile) + Math.floor(x / opts.tile);

test("a locally displaced region is measured, and its neighbours are not", () => {
	const golden = texture(W, H);
	// golden pixel (x,y) is found in the frame at (x+2, y-1)
	const frame = displaced(golden, W, H, { x0: 192, y0: 192, x1: W, y1: H }, 2, -1);

	const field = smoothField(buildDisplacementField(golden, frame, W, H, opts));

	const inside = cellAt(field, 288, 288);
	assert.ok(field.valid[inside], "the displaced region should localise");
	assert.ok(
		Math.abs(field.fx[inside] - 2) < 0.75,
		`expected fx ~2 inside the displaced region, got ${field.fx[inside].toFixed(2)}`,
	);
	assert.ok(
		Math.abs(field.fy[inside] + 1) < 0.75,
		`expected fy ~-1 inside the displaced region, got ${field.fy[inside].toFixed(2)}`,
	);

	const outside = cellAt(field, 48, 48);
	assert.ok(
		Math.hypot(field.fx[outside], field.fy[outside]) < 0.75,
		`undisplaced region should stay put, got (${field.fx[outside].toFixed(2)}, ${field.fy[outside].toFixed(2)})`,
	);
});

test("applying the field puts the displaced region back", () => {
	const golden = texture(W, H);
	const rect = { x0: 192, y0: 192, x1: W, y1: H };
	const frame = displaced(golden, W, H, rect, 2, -1);
	const field = smoothField(buildDisplacementField(golden, frame, W, H, opts));
	const fixed = applyField(frame, W, H, field, opts.tile);

	const disagreement = (a, b) => {
		let bad = 0, n = 0;
		// away from the boundary, where the field is interpolated across
		// the discontinuity and cannot be sharp
		for (let y = rect.y0 + 60; y < rect.y1 - 8; y++) {
			for (let x = rect.x0 + 60; x < rect.x1 - 8; x++) {
				if (Math.abs(a[y * W + x] - b[y * W + x]) > 60) bad++;
				n++;
			}
		}
		return bad / n;
	};
	const before = disagreement(golden, frame);
	const after = disagreement(golden, fixed);
	assert.ok(before > 0.05, `precondition: the displacement should disagree, got ${before.toFixed(4)}`);
	assert.ok(
		after < before / 4,
		`applying the field should mostly fix it: ${before.toFixed(4)} -> ${after.toFixed(4)}`,
	);
});

test("a featureless tile is never trusted", () => {
	const flat = new Uint8Array(W * H).fill(200);
	const field = buildDisplacementField(flat, flat, W, H, opts);
	assert.strictEqual(
		field.valid.reduce((s, v) => s + v, 0),
		0,
		"a blank image offers nothing to localise against, so no tile may claim an offset",
	);
});

test("offsets never exceed the cap", () => {
	const golden = texture(W, H);
	// far beyond the cap: the guard must refuse it rather than clamp to a
	// wrong answer, since a minimum on the edge of the box is not one
	const frame = displaced(golden, W, H, { x0: 0, y0: 0, x1: W, y1: H }, 12, 0);
	const field = buildDisplacementField(golden, frame, W, H, opts);
	for (let i = 0; i < field.valid.length; i++) {
		if (!field.valid[i]) continue;
		assert.ok(
			Math.abs(field.fx[i]) <= opts.maxOffset && Math.abs(field.fy[i]) <= opts.maxOffset,
			`offset ${field.fx[i]},${field.fy[i]} exceeds the cap of ${opts.maxOffset}`,
		);
	}
});

// The field as the exhaustive search finds it - every offset of the box
// summed in full, the first strictly lowest kept - the reference for the
// search that stops losing offsets early: the field must not move by a bit.
function fieldExhaustive(golden, target, width, height, { tile, maxOffset, minStdDev }) {
	const STEP = 3;
	const ssd = (x0, y0, x1, y1, dx, dy) => {
		let sum = 0;
		let count = 0;
		for (let y = y0; y < y1; y += STEP) {
			const sy = y + dy;
			if (sy < 0 || sy >= height) continue;
			for (let x = x0; x < x1; x += STEP) {
				const sx = x + dx;
				if (sx < 0 || sx >= width) continue;
				const d = golden[y * width + x] - target[sy * width + sx];
				sum += d * d;
				count++;
			}
		}
		return count ? sum / count : Infinity;
	};
	const stdDev = (x0, y0, x1, y1) => {
		let sum = 0;
		let sumSq = 0;
		let n = 0;
		for (let y = y0; y < y1; y += 2) {
			for (let x = x0; x < x1; x += 2) {
				const v = golden[y * width + x];
				sum += v;
				sumSq += v * v;
				n++;
			}
		}
		if (n === 0) return 0;
		const mean = sum / n;
		const variance = sumSq / n - mean * mean;
		return variance > 0 ? Math.sqrt(variance) : 0;
	};
	const parabolic = (before, at, after) => {
		if (!Number.isFinite(before) || !Number.isFinite(at) || !Number.isFinite(after)) return 0;
		const denom = before - 2 * at + after;
		if (Math.abs(denom) < 1e-9) return 0;
		const shift = (0.5 * (before - after)) / denom;
		return shift > 1 || shift < -1 ? 0 : shift;
	};
	const gridW = Math.max(1, Math.ceil(width / tile));
	const gridH = Math.max(1, Math.ceil(height / tile));
	const fx = new Float32Array(gridW * gridH);
	const fy = new Float32Array(gridW * gridH);
	const valid = new Uint8Array(gridW * gridH);
	for (let gy = 0; gy < gridH; gy++) {
		for (let gx = 0; gx < gridW; gx++) {
			const x0 = gx * tile;
			const y0 = gy * tile;
			const x1 = Math.min(width, x0 + tile);
			const y1 = Math.min(height, y0 + tile);
			if (stdDev(x0, y0, x1, y1) < minStdDev) continue;
			let bestDx = 0;
			let bestDy = 0;
			let bestVal = Infinity;
			for (let dy = -maxOffset; dy <= maxOffset; dy++) {
				for (let dx = -maxOffset; dx <= maxOffset; dx++) {
					const v = ssd(x0, y0, x1, y1, dx, dy);
					if (v < bestVal) {
						bestVal = v;
						bestDx = dx;
						bestDy = dy;
					}
				}
			}
			if (Math.abs(bestDx) === maxOffset || Math.abs(bestDy) === maxOffset) continue;
			const cell = gy * gridW + gx;
			fx[cell] = bestDx + parabolic(ssd(x0, y0, x1, y1, bestDx - 1, bestDy), bestVal, ssd(x0, y0, x1, y1, bestDx + 1, bestDy));
			fy[cell] = bestDy + parabolic(ssd(x0, y0, x1, y1, bestDx, bestDy - 1), bestVal, ssd(x0, y0, x1, y1, bestDx, bestDy + 1));
			valid[cell] = 1;
		}
	}
	return { fx, fy, valid };
}

test("the field is the exhaustive search's, to the bit, edge tiles and ties included", () => {
	let seed = 11;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const cases = [];
	// a textured golden against itself displaced, plus noise
	const golden = texture(W, H);
	const shifted = displaced(golden, W, H, { x0: 0, y0: 0, x1: W, y1: H }, 2, -1);
	cases.push(["displaced", golden, shifted.map((v) => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * 40)))), W, H, opts]);
	// a checkerboard one period apart: offsets exactly tied, the first of
	// them in raster order inside the box
	const checks = (w, h, p) =>
		Uint8Array.from({ length: w * h }, (_, i) => (((i % w) % p < p / 2) !== (((i / w) | 0) % p < p / 2) ? 30 : 220));
	cases.push(["tied checks", checks(150, 90, 4), checks(150, 90, 4), 150, 90, { tile: 32, maxOffset: 5, minStdDev: 12 }]);
	// noise, tiles that do not divide the frame, a cap past the frame's
	// own size, and a frame smaller than one tile
	for (const [w, h, tile, maxOffset] of [[101, 77, 24, 4], [60, 45, 16, 16], [20, 13, 32, 3], [200, 140, 48, 6]]) {
		const g = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 256));
		const t = Uint8Array.from(g, (v) => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * 60))));
		cases.push([`noise ${w}x${h} tile ${tile} cap ${maxOffset}`, g, t, w, h, { tile, maxOffset, minStdDev: 12 }]);
	}
	for (const [name, g, t, w, h, o] of cases) {
		const want = fieldExhaustive(g, t, w, h, o);
		const got = buildDisplacementField(g, t, w, h, o);
		assert.ok(want.valid.some((v) => v), `${name}: precondition, some tile localises`);
		assert.deepStrictEqual(Array.from(got.valid), Array.from(want.valid), `${name}: valid`);
		assert.deepStrictEqual(Array.from(got.fx), Array.from(want.fx), `${name}: fx`);
		assert.deepStrictEqual(Array.from(got.fy), Array.from(want.fy), `${name}: fy`);
	}
});

// applyRows as it was before its per-column terms were hoisted, the
// reference: the resampled frame must not move by a pixel
function applyRowsPerPixel(out, src, width, height, { fx, fy, gridW, gridH }, tile, yLo, yHi) {
	const sample = (x, y) => src[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
	for (let y = yLo; y < yHi; y++) {
		let gyf = y / tile - 0.5;
		if (gyf < 0) gyf = 0;
		else if (gyf > gridH - 1) gyf = gridH - 1;
		const gy0 = Math.floor(gyf);
		const gy1 = gy0 + 1 < gridH ? gy0 + 1 : gy0;
		const wy = gyf - gy0;
		for (let x = 0; x < width; x++) {
			let gxf = x / tile - 0.5;
			if (gxf < 0) gxf = 0;
			else if (gxf > gridW - 1) gxf = gridW - 1;
			const gx0 = Math.floor(gxf);
			const gx1 = gx0 + 1 < gridW ? gx0 + 1 : gx0;
			const wx = gxf - gx0;
			const i00 = gy0 * gridW + gx0;
			const i01 = gy0 * gridW + gx1;
			const i10 = gy1 * gridW + gx0;
			const i11 = gy1 * gridW + gx1;
			const top = fx[i00] + (fx[i01] - fx[i00]) * wx;
			const bot = fx[i10] + (fx[i11] - fx[i10]) * wx;
			const dx = top + (bot - top) * wy;
			const topY = fy[i00] + (fy[i01] - fy[i00]) * wx;
			const botY = fy[i10] + (fy[i11] - fy[i10]) * wx;
			const dy = topY + (botY - topY) * wy;
			out[y * width + x] = sample(x + Math.round(dx), y + Math.round(dy));
		}
	}
}

test("applyRows resamples exactly as the per-pixel form did", () => {
	const { applyRows } = require("../lib/localAlign.js");
	let seed = 7;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (const [width, height, tile] of [[1, 1, 8], [37, 23, 8], [200, 150, 96], [301, 257, 17]]) {
		const src = Uint8Array.from({ length: width * height }, () => Math.floor(rnd() * 256));
		const gridW = Math.max(1, Math.ceil(width / tile));
		const gridH = Math.max(1, Math.ceil(height / tile));
		// sub-pixel offsets, halves that sit on Math.round's tie, and
		// offsets that push samples off every edge
		const field = {
			fx: Float32Array.from({ length: gridW * gridH }, (_, i) => (i % 5 === 0 ? 0.5 : (rnd() - 0.5) * 30)),
			fy: Float32Array.from({ length: gridW * gridH }, (_, i) => (i % 7 === 0 ? -2.5 : (rnd() - 0.5) * 30)),
			gridW,
			gridH,
		};
		const expected = new Uint8Array(width * height);
		applyRowsPerPixel(expected, src, width, height, field, tile, 0, height);
		const whole = new Uint8Array(width * height);
		applyRows(whole, src, width, height, field, tile, 0, height);
		assert.deepStrictEqual(whole, expected, `${width}x${height} tile ${tile}`);
		// and over split ranges, as the pool runs it
		const split = new Uint8Array(width * height);
		const mid = height >> 1;
		applyRows(split, src, width, height, field, tile, 0, mid);
		applyRows(split, src, width, height, field, tile, mid, height);
		assert.deepStrictEqual(split, expected, `${width}x${height} tile ${tile}, split`);
		// ranges that start and end inside a band of rows sharing a pair of
		// field rows, one row long, and across several bands
		for (const step of [1, 3, tile - 1, tile + 1, 2 * tile + 5]) {
			const banded = new Uint8Array(width * height);
			for (let lo = 0; lo < height; lo += step) applyRows(banded, src, width, height, field, tile, lo, Math.min(height, lo + step));
			assert.deepStrictEqual(banded, expected, `${width}x${height} tile ${tile}, ranges of ${step}`);
		}
	}
});
