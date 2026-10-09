/**
 * Regression tests for the area-average warp and its grey summed-area
 * table.
 *
 * Two bugs live here:
 *
 *  - the grey table was built with a Uint32 accumulator, which wraps once
 *    the frame's canvas passes ~16.8M bright pixels (the working canvas
 *    is capped at 2.5x workingSize on the long edge, so at workingSize
 *    3072 it is ~7680x5720) - the bottom rows of the table read as
 *    garbage to the warp, silently manufacturing phantom or missed
 *    defects;
 *  - the area-average footprint rounded its corners to integers, which is
 *    exact for odd integer magnifications but shifts a fractional
 *    magnification half a pixel (at m = 1.5 every other box degenerates
 *    to a 1-px point sample). The fractional-corner box sum reads the
 *    cumulative table with bilinear interpolation at the corners.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { warpGray, buildGrayTable } = require("../lib/warp.js");
const { blockSum } = require("../lib/integral.js");

test("the grey summed-area table does not wrap on a large frame", () => {
	// 4200x4200 all-white: 255*4200*4200 = 4,498,200,000, which is past
	// 2^32 - the exact frame size class that silently wrapped in Uint32
	// (the old table reported 641,832,704 here). Float64 holds it exactly.
	const W = 4200;
	const H = 4200;
	const src = new Uint8Array(W * H).fill(255);
	const table = buildGrayTable(src, W, H);
	const total = 255 * W * H;
	assert.ok(total > 2 ** 32, "precondition: the sums must exceed Uint32 range");
	assert.strictEqual(
		table.integral[H * table.stride + W],
		total,
		"the bottom-right corner of the table must be the exact total",
	);
	// the wrap hits the bottom rows first - the region the warp reads for
	// the lower half of the output
	assert.strictEqual(blockSum(table, 4000, 4000, W, H), 255 * 200 * 200);
});

/** Reference: exact integer-box average (theta = 0, integer corners). */
function integerBoxAverage(src, srcW, srcH, mx, my, ox, oy, outW, outH) {
	const out = new Uint8Array(outW * outH).fill(255);
	const halfX = mx / 2;
	const halfY = my / 2;
	for (let y = 0; y < outH; y++) {
		const ty = oy + my * y;
		let y0 = Math.round(ty + 0.5 - halfY);
		let y1 = Math.round(ty + 0.5 + halfY);
		if (y1 <= 0 || y0 >= srcH) continue;
		if (y0 < 0) y0 = 0;
		if (y1 > srcH) y1 = srcH;
		for (let x = 0; x < outW; x++) {
			const tx = ox + mx * x;
			let x0 = Math.round(tx + 0.5 - halfX);
			let x1 = Math.round(tx + 0.5 + halfX);
			if (x1 <= 0 || x0 >= srcW) continue;
			if (x0 < 0) x0 = 0;
			if (x1 > srcW) x1 = srcW;
			const area = (x1 - x0) * (y1 - y0);
			if (area <= 0) continue;
			let sum = 0;
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) sum += src[sy * srcW + sx];
			}
			out[y * outW + x] = Math.round(sum / area);
		}
	}
	return out;
}

test("an odd integer magnification stays an exact box average", () => {
	// m = 3 keeps integer corners, so the interpolated-table path must
	// reproduce the plain box average byte for byte - this pins the
	// table indexing (stride, offsets) as well as the Float64 table.
	const W = 61;
	const H = 53;
	const src = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) src[y * W + x] = (x * 3 + y * 5) & 0xff;
	}
	const outW = 21;
	const outH = 18;
	const got = warpGray(src, W, H, 3, 3, 0, 0, 0, outW, outH, 255, null);
	const expected = integerBoxAverage(src, W, H, 3, 3, 0, 0, outW, outH);
	assert.deepStrictEqual(Array.from(got), Array.from(expected));
});

test("a fractional magnification is a true box average, not rounded boxes", () => {
	// Hand-computed oracle. A 2x2 planar image warped at m = 1.5 with the
	// footprint [0,1.5) x [0,1.5):
	//   I(1.5,1.5) = bilinear(10,30,40,100 at 0.5,0.5) = 45
	//   sum = 45, area = 2.25, out = round(45/2.25) = 20
	// The old rounded-box code read [0,2) x [0,2) instead: sum 100,
	// area 4, out 25 - the box shifted half a pixel and swallowed the
	// whole far corner.
	const src = new Uint8Array([10, 20, 30, 40]);
	const out = warpGray(src, 2, 2, 1.5, 1.5, 0, 0.25, 0.25, 1, 1);
	assert.strictEqual(out[0], 20);
});

test("a fractional magnification matches a direct fractional-box reference", () => {
	// Same operator, evaluated per output pixel rather than through the
	// shared table path - guards the interpolated-corner indexing on a
	// non-planar image where the rounded-box behaviour would differ.
	const W = 64;
	const H = 48;
	const src = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			src[y * W + x] = ((x * 7 + y * 11 + ((x * y) & 0x3f)) ^ 0x55) & 0xff;
		}
	}
	const mx = 2.5;
	const my = 1.75;
	const ox = 0.3;
	const oy = -0.4;
	const outW = 26;
	const outH = 20;
	const got = warpGray(src, W, H, mx, my, 0, ox, oy, outW, outH, 255, null);

	// direct evaluation: for each output pixel, sum the bilinear box via
	// the interpolated cumulative table at the four corners
	const table = buildGrayTable(src, W, H);
	const satAt = (x, y) => {
		if (x <= 0 || y <= 0) return 0;
		if (x >= W) x = W;
		if (y >= H) y = H;
		const ix = x | 0;
		const iy = y | 0;
		const fx = x - ix;
		const fy = y - iy;
		const x1 = ix + 1 > W ? W : ix + 1;
		const y1 = iy + 1 > H ? H : iy + 1;
		const s = table.stride;
		const p00 = table.integral[iy * s + ix];
		const p10 = table.integral[iy * s + x1];
		const p01 = table.integral[y1 * s + ix];
		const p11 = table.integral[y1 * s + x1];
		return (
			p00 + (p10 - p00) * fx + (p01 - p00) * fy + (p00 - p10 - p01 + p11) * fx * fy
		);
	};
	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			const tx = ox + mx * x;
			const ty = oy + my * y;
			let x0 = tx + 0.5 - mx / 2;
			let y0 = ty + 0.5 - my / 2;
			let x1 = tx + 0.5 + mx / 2;
			let y1 = ty + 0.5 + my / 2;
			let expected = 255;
			if (!(x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H)) {
				if (x0 < 0) x0 = 0;
				if (y0 < 0) y0 = 0;
				if (x1 > W) x1 = W;
				if (y1 > H) y1 = H;
				const area = (x1 - x0) * (y1 - y0);
				if (area > 0) {
					const sum = satAt(x1, y1) - satAt(x0, y1) - satAt(x1, y0) + satAt(x0, y0);
					expected = Math.round(sum / area);
				}
			}
			assert.strictEqual(
				got[y * outW + x],
				expected,
				`pixel (${x},${y}) of the fractional warp`,
			);
		}
	}
});

// The area-average loop reads the table through an inlined copy of what
// used to be a helper. The helper and the loop that called it are kept
// here verbatim as the reference, and the inlined form has to agree with
// them on every byte - rotated, at fractional magnifications, and with
// footprints hanging off each edge of the frame, where a corner reads 0
// or clamps to the table's far side.
function helperSatAt(table, x, y) {
	const { integral, stride, width, height } = table;
	if (x <= 0 || y <= 0) return 0;
	if (x >= width) x = width;
	if (y >= height) y = height;
	const ix = x | 0;
	const iy = y | 0;
	const fx = x - ix;
	const fy = y - iy;
	const x1 = ix + 1 > width ? width : ix + 1;
	const y1 = iy + 1 > height ? height : iy + 1;
	const p00 = integral[iy * stride + ix];
	const p10 = integral[iy * stride + x1];
	const p01 = integral[y1 * stride + ix];
	const p11 = integral[y1 * stride + x1];
	return (
		p00 + (p10 - p00) * fx + (p01 - p00) * fy + (p00 - p10 - p01 + p11) * fx * fy
	);
}

function helperAreaWarp(sat, srcW, srcH, mx, my, theta, ox, oy, outW, outH) {
	const out = new Uint8Array(outW * outH).fill(255);
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const xFromGx = cos * mx;
	const yFromGx = sin * mx;
	const xFromGy = -sin * my;
	const yFromGy = cos * my;
	const halfX = mx / 2;
	const halfY = my / 2;
	for (let y = 0; y < outH; y++) {
		const baseX = ox + xFromGy * y;
		const baseY = oy + yFromGy * y;
		for (let x = 0; x < outW; x++) {
			const tx = baseX + xFromGx * x;
			const ty = baseY + yFromGx * x;
			let x0 = tx + 0.5 - halfX;
			let y0 = ty + 0.5 - halfY;
			let x1 = tx + 0.5 + halfX;
			let y1 = ty + 0.5 + halfY;
			if (x1 <= 0 || y1 <= 0 || x0 >= srcW || y0 >= srcH) continue;
			if (x0 < 0) x0 = 0;
			if (y0 < 0) y0 = 0;
			if (x1 > srcW) x1 = srcW;
			if (y1 > srcH) y1 = srcH;
			const area = (x1 - x0) * (y1 - y0);
			if (area <= 0) continue;
			const sum =
				helperSatAt(sat, x1, y1) -
				helperSatAt(sat, x0, y1) -
				helperSatAt(sat, x1, y0) +
				helperSatAt(sat, x0, y0);
			out[y * outW + x] = Math.round(sum / area);
		}
	}
	return out;
}

test("the inlined corner reads match the helper they replaced byte for byte", () => {
	const srcW = 311;
	const srcH = 257;
	const src = new Uint8Array(srcW * srcH);
	let seed = 99;
	for (let i = 0; i < src.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		src[i] = (seed >> 16) & 0xff;
	}
	const table = buildGrayTable(src, srcW, srcH);
	const outW = 97;
	const outH = 83;
	const cases = [
		// [mx, my, theta, ox, oy]
		[3.13, 2.87, 0.012, 0.3, -0.7],
		[1.5, 1.5, 0, 0, 0],
		[3.96, 3.97, -0.035, -40.25, -30.5], // off the top and left
		[3.5, 3.25, 0.02, 60.6, 45.4], // off the bottom and right
		[2.001, 1.0, 0.3, 150.1, -80.9], // steep rotation, one axis at 1
		[7.77, 6.1, -0.2, -300, 400], // mostly outside the frame
	];
	for (const [mx, my, theta, ox, oy] of cases) {
		const expected = helperAreaWarp(table, srcW, srcH, mx, my, theta, ox, oy, outW, outH);
		const got = warpGray(src, srcW, srcH, mx, my, theta, ox, oy, outW, outH, 255, table);
		let differ = 0;
		for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) differ++;
		assert.strictEqual(differ, 0, `m=(${mx},${my}) theta=${theta}: ${differ} bytes differ`);
	}
});
