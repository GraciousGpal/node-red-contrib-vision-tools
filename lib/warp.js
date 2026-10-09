/**
 * Resampling the matched region of a camera frame into the golden's own
 * frame, given the transform recovered by lib/align.js.
 *
 * The old code could get away with a plain windowed byte copy because the
 * only transform it supported was an integer translation. Once
 * magnification is in play the sampling method starts to matter a great
 * deal, and in the wrong direction for the naive choice: when the frame
 * resolves the part more finely than the golden does (m > 1, the usual
 * case for a 23MP capture against a downscaled template), point-sampling
 * one frame pixel per golden pixel throws away all but 1/m^2 of the data.
 * On the fine text that this node exists to inspect, that aliases strokes
 * in and out of existence and manufactures defects no printer produced.
 *
 * So sampling adapts to the magnification, per axis - mx and my differ
 * whenever the press stretched the print along one axis:
 *
 *   m > 1  - area-average the mx by my frame footprint of each golden
 *            pixel, read in O(1) from a summed-area table. This is a true
 *            box downsample, the same thing an image resizer would do,
 *            and it costs the same per output pixel regardless of m.
 *   m <= 1 - bilinear interpolation. There is no footprint to average
 *            (the frame carries less detail than the golden), so the
 *            useful thing is smooth sub-pixel placement.
 *
 * Under rotation the footprint is treated as its axis-aligned bounding
 * box rather than a rotated rectangle. Across the small angles this
 * handles, the difference is a slight extra blur at the corners of each
 * footprint, which costs far less than the aliasing it avoids.
 */

"use strict";

const { allocU8 } = require("./shared.js");

const { buildIntegral64 } = require("./integral.js");

// The area-average path needs a summed-area table over the source. Built
// separately so a caller evaluating many candidate transforms against the
// same frame (the refinement loop in lib/align.js) pays for it once
// instead of once per candidate - rebuilding it per call would make the
// table, not the sampling, the dominant cost.
//
// This is the *grey* table (0-255 per pixel), so it uses the Float64
// accumulator: a Uint32 table wraps once the frame's canvas passes
// ~16.8M bright pixels, and the bottom rows of the wrap read as garbage
// to the area-average warp. Float64 holds every sum here exactly.
function buildGrayTable(src, srcW, srcH) {
	return buildIntegral64(src, srcW, srcH);
}

/**
 * Resample rows [yLo,yHi) only. Rows are independent, so this is what the
 * worker pool splits - and it calls this very function, so there is one
 * implementation of the sampling rather than a copy that could drift.
 * `sat` non-null selects the area-average path.
 */
function warpRows(
	out,
	src,
	srcW,
	srcH,
	mx,
	my,
	theta,
	ox,
	oy,
	outW,
	sat,
	yLo,
	yHi,
) {
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const xFromGx = cos * mx;
	const yFromGx = sin * mx;
	const xFromGy = -sin * my;
	const yFromGy = cos * my;

	if (sat !== null) {
		// downsampling: area-average each golden pixel's footprint
		const halfX = mx / 2;
		const halfY = my / 2;
		// Each footprint is summed from the cumulative table at its four
		// fractional corners. The table is a lattice over [0,width] x
		// [0,height] (entry (x,y) is the sum of the pixels strictly above
		// and left of (x,y)); bilinear interpolation between the four
		// surrounding lattice points is what makes a box with fractional
		// corners summable in O(1) - the standard interpolated summed-area
		// table.
		//
		// That read used to be a helper, satAt, called four times a pixel.
		// This loop is the alignment polish's whole cost - every candidate
		// of every round is one pass of it on a worker - and V8 kept the
		// helper an out-of-line call that re-read the table's fields on
		// every corner: a quarter of the polish. It is inlined below term
		// for term and in the same order, so the bytes cannot move;
		// test/warp.test.js holds this loop to the helper it replaced.
		const integral = sat.integral;
		const stride = sat.stride;
		const satW = sat.width;
		const satH = sat.height;
		for (let y = yLo; y < yHi; y++) {
			const baseX = ox + xFromGy * y;
			const baseY = oy + yFromGy * y;
			const outRow = y * outW;
			for (let x = 0; x < outW; x++) {
				const tx = baseX + xFromGx * x;
				const ty = baseY + yFromGx * x;
				// Pixel index j spans continuous [j, j+1), so the footprint
				// centered on index tx spans [tx+0.5-half, tx+0.5+half).
				// Dropping that half-pixel biases every footprint half a
				// pixel up-left, which is invisible on a single image and
				// fatal when two independently-resampled grids are compared:
				// the best alignment stops being the true one.
				let x0 = tx + 0.5 - halfX;
				let y0 = ty + 0.5 - halfY;
				let x1 = tx + 0.5 + halfX;
				let y1 = ty + 0.5 + halfY;
				if (x1 <= 0 || y1 <= 0 || x0 >= srcW || y0 >= srcH) continue;
				if (x0 < 0) x0 = 0;
				if (y0 < 0) y0 = 0;
				if (x1 > srcW) x1 = srcW;
				if (y1 > srcH) y1 = srcH;
				// The corners stay fractional. Rounding them to integers was
				// exact for an odd integer magnification, but any fractional
				// m shifts the box half a pixel and degenerates toward point
				// sampling (at m = 1.5, every other box rounds to a 1-px
				// footprint) - exactly the aliasing this path exists to
				// avoid. With the corners interpolated in the cumulative
				// table, every box - integer or fractional m - is a true
				// area average.
				const area = (x1 - x0) * (y1 - y0);
				if (area <= 0) continue;
				// The four corners share two columns and two rows, so each
				// edge's lattice cell and fraction is worked out once. A
				// corner on the top or left edge of the table reads 0, as in
				// satAt - tested before the clamp, which only bounds the far
				// side.
				const xr = x1 >= satW ? satW : x1;
				const xl = x0 >= satW ? satW : x0;
				const yb = y1 >= satH ? satH : y1;
				const yt = y0 >= satH ? satH : y0;
				const ixr = xr | 0;
				const ixl = xl | 0;
				const iyb = yb | 0;
				const iyt = yt | 0;
				const fxr = xr - ixr;
				const fxl = xl - ixl;
				const fyb = yb - iyb;
				const fyt = yt - iyt;
				const ixr1 = ixr + 1 > satW ? satW : ixr + 1;
				const ixl1 = ixl + 1 > satW ? satW : ixl + 1;
				const rb = iyb * stride;
				const rb1 = (iyb + 1 > satH ? satH : iyb + 1) * stride;
				const rt = iyt * stride;
				const rt1 = (iyt + 1 > satH ? satH : iyt + 1) * stride;
				let p00;
				let p10;
				let p01;
				let p11;
				let br = 0;
				if (!(x1 <= 0 || y1 <= 0)) {
					p00 = integral[rb + ixr];
					p10 = integral[rb + ixr1];
					p01 = integral[rb1 + ixr];
					p11 = integral[rb1 + ixr1];
					br =
						p00 +
						(p10 - p00) * fxr +
						(p01 - p00) * fyb +
						(p00 - p10 - p01 + p11) * fxr * fyb;
				}
				let bl = 0;
				if (!(x0 <= 0 || y1 <= 0)) {
					p00 = integral[rb + ixl];
					p10 = integral[rb + ixl1];
					p01 = integral[rb1 + ixl];
					p11 = integral[rb1 + ixl1];
					bl =
						p00 +
						(p10 - p00) * fxl +
						(p01 - p00) * fyb +
						(p00 - p10 - p01 + p11) * fxl * fyb;
				}
				let tr = 0;
				if (!(x1 <= 0 || y0 <= 0)) {
					p00 = integral[rt + ixr];
					p10 = integral[rt + ixr1];
					p01 = integral[rt1 + ixr];
					p11 = integral[rt1 + ixr1];
					tr =
						p00 +
						(p10 - p00) * fxr +
						(p01 - p00) * fyt +
						(p00 - p10 - p01 + p11) * fxr * fyt;
				}
				let tl = 0;
				if (!(x0 <= 0 || y0 <= 0)) {
					p00 = integral[rt + ixl];
					p10 = integral[rt + ixl1];
					p01 = integral[rt1 + ixl];
					p11 = integral[rt1 + ixl1];
					tl =
						p00 +
						(p10 - p00) * fxl +
						(p01 - p00) * fyt +
						(p00 - p10 - p01 + p11) * fxl * fyt;
				}
				const sum = br - bl - tr + tl;
				out[outRow + x] = Math.round(sum / area);
			}
		}
		return;
	}

	// upsampling / same scale: bilinear
	for (let y = yLo; y < yHi; y++) {
		const baseX = ox + xFromGy * y;
		const baseY = oy + yFromGy * y;
		const outRow = y * outW;
		for (let x = 0; x < outW; x++) {
			const tx = baseX + xFromGx * x;
			const ty = baseY + yFromGx * x;
			if (tx < -1 || ty < -1 || tx > srcW || ty > srcH) continue;
			const fx = Math.floor(tx);
			const fy = Math.floor(ty);
			const dx = tx - fx;
			const dy = ty - fy;
			const x0 = fx < 0 ? 0 : fx >= srcW ? srcW - 1 : fx;
			const y0 = fy < 0 ? 0 : fy >= srcH ? srcH - 1 : fy;
			const x1 = x0 + 1 >= srcW ? srcW - 1 : x0 + 1;
			const y1 = y0 + 1 >= srcH ? srcH - 1 : y0 + 1;
			const p00 = src[y0 * srcW + x0];
			const p10 = src[y0 * srcW + x1];
			const p01 = src[y1 * srcW + x0];
			const p11 = src[y1 * srcW + x1];
			const top = p00 + (p10 - p00) * dx;
			const bottom = p01 + (p11 - p01) * dx;
			out[outRow + x] = Math.round(top + (bottom - top) * dy);
		}
	}
}

/**
 * Sample `src` (srcW x srcH, 8-bit) into an outW x outH canvas under
 * target = (ox,oy) + R(theta) * diag(mx,my) * golden.
 *
 * Pixels mapping outside the source are filled with `fill` (default 255,
 * i.e. blank substrate - so a template hanging off the frame edge reads
 * as "no ink there", which the print check will flag, rather than as a
 * black bar, which would flood the background check with a defect the
 * part does not have).
 *
 * `table` is an optional prebuilt summed-area table from buildGrayTable,
 * for callers warping the same frame many times.
 */
function warpGray(
	src,
	srcW,
	srcH,
	mx,
	my,
	theta,
	ox,
	oy,
	outW,
	outH,
	fill,
	table,
) {
	const out = allocU8(outW * outH);
	out.fill(fill == null ? 255 : fill);
	const sat =
		mx > 1.001 || my > 1.001 ? table || buildIntegral64(src, srcW, srcH) : null;
	warpRows(out, src, srcW, srcH, mx, my, theta, ox, oy, outW, sat, 0, outH);
	return out;
}

module.exports = { warpGray, warpRows, buildGrayTable };
