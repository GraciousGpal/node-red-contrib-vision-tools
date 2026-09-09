/**
 * Separable morphological dilation with a square structuring element,
 * via the sliding-window-maximum (monotonic deque) algorithm.
 *
 * Cost is O(width*height) regardless of the radius - a naive dilate that
 * scans a (2r+1)x(2r+1) window per pixel would cost O(width*height*r^2),
 * which gets slow fast as the tolerance radius grows. Two 1D passes (rows,
 * then columns) give the same result as a single square-window 2D max
 * filter because max is separable over a rectangular structuring element.
 */

"use strict";

const { allocU8 } = require("./shared.js");

// dst[j] = max(src[offset + max(0,j-r)*stride .. offset + min(n-1,j+r)*stride])
// dq is caller-provided scratch (Int32Array, length >= n) to avoid
// reallocating per row/column.
function slidingMax1D(src, offset, stride, n, r, dst, dstOffset, dstStride, dq) {
	let dqLen = 0;
	let dqStart = 0;
	let added = -1;
	for (let j = 0; j < n; j++) {
		const rightIdx = j + r < n - 1 ? j + r : n - 1;
		while (added < rightIdx) {
			added++;
			const v = src[offset + added * stride];
			while (dqLen > dqStart && src[offset + dq[dqLen - 1] * stride] <= v)
				dqLen--;
			dq[dqLen++] = added;
		}
		const leftIdx = j - r > 0 ? j - r : 0;
		while (dq[dqStart] < leftIdx) dqStart++;
		dst[dstOffset + j * dstStride] = src[offset + dq[dqStart] * stride];
	}
}

/**
 * Dilate a binary/grayscale Uint8Array (row-major, width x height) by
 * `radius` px. Returns a new Uint8Array; a radius <= 0 returns a copy.
 */
function dilate(src, width, height, radius) {
	// shared-backed so the worker pool can read it without a copy
	const out = allocU8(width * height);
	if (radius <= 0) {
		out.set(src);
		return out;
	}
	const scratchLen = width > height ? width : height;
	const dq = new Int32Array(scratchLen);
	const tmp = allocU8(width * height);

	// horizontal pass: src -> tmp (contiguous rows, stride 1)
	for (let y = 0; y < height; y++) {
		const rowOffset = y * width;
		slidingMax1D(src, rowOffset, 1, width, radius, tmp, rowOffset, 1, dq);
	}
	// vertical pass: tmp -> out (columns, stride = width)
	for (let x = 0; x < width; x++) {
		slidingMax1D(tmp, x, width, height, radius, out, x, width, dq);
	}
	return out;
}

module.exports = { dilate, slidingMax1D };
