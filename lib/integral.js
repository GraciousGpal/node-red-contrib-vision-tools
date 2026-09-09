/**
 * Summed-area table (integral image) over a binary/grayscale Uint8Array,
 * so a rectangular block sum is an O(1) lookup instead of an O(block area)
 * scan - used to turn the per-pixel defect mask into a heat-map grid
 * without re-walking every pixel per block.
 */

"use strict";

const { allocU32, allocF64 } = require("./shared.js");

function buildIntegral(src, width, height) {
	const stride = width + 1;
	// shared-backed: the warp kernel reads this from worker threads
	const integral = allocU32(stride * (height + 1));
	for (let y = 0; y < height; y++) {
		let rowSum = 0;
		const srcRow = y * width;
		const intRow = (y + 1) * stride;
		const intPrevRow = y * stride;
		for (let x = 0; x < width; x++) {
			rowSum += src[srcRow + x];
			integral[intRow + x + 1] = integral[intPrevRow + x + 1] + rowSum;
		}
	}
	return { integral, stride, width, height };
}

/**
 * Wider-accumulator twin of buildIntegral, for summing *grey* values
 * (0-255) rather than binary 0/1 masks.
 *
 * A Uint32 table wraps at 2^32 / 255 ~= 16.8M pixels. The frame's working
 * canvas is capped at 2.5x workingSize on the long edge, which at
 * workingSize 3072 is roughly 7680x5720 - the bottom rows of a Uint32
 * table there wrap silently and the area-average warp reads garbage
 * (phantom or missed defects). Float64 holds every integer sum in this
 * codebase exactly (well past 2^53), so a grey table built this way is
 * exact regardless of canvas size. The binary-mask tables must stay
 * Uint32: they are what scoreCandidate/blockSum read inline, and the
 * Float64 form would cost 2x the memory for no benefit.
 */
function buildIntegral64(src, width, height) {
	const stride = width + 1;
	// shared-backed: the warp kernel reads this from worker threads
	const integral = allocF64(stride * (height + 1));
	for (let y = 0; y < height; y++) {
		let rowSum = 0;
		const srcRow = y * width;
		const intRow = (y + 1) * stride;
		const intPrevRow = y * stride;
		for (let x = 0; x < width; x++) {
			rowSum += src[srcRow + x];
			integral[intRow + x + 1] = integral[intPrevRow + x + 1] + rowSum;
		}
	}
	return { integral, stride, width, height };
}

// Sum over the half-open rectangle [x0,x1) x [y0,y1), clamped to bounds.
function blockSum(table, x0, y0, x1, y1) {
	const { integral, stride, width, height } = table;
	const cx0 = x0 < 0 ? 0 : x0 > width ? width : x0;
	const cy0 = y0 < 0 ? 0 : y0 > height ? height : y0;
	const cx1 = x1 < 0 ? 0 : x1 > width ? width : x1;
	const cy1 = y1 < 0 ? 0 : y1 > height ? height : y1;
	if (cx1 <= cx0 || cy1 <= cy0) return 0;
	return (
		integral[cy1 * stride + cx1] -
		integral[cy0 * stride + cx1] -
		integral[cy1 * stride + cx0] +
		integral[cy0 * stride + cx0]
	);
}

module.exports = { buildIntegral, buildIntegral64, blockSum };
