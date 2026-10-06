/**
 * Connected-component labeling over a full-resolution binary mask.
 *
 * Unlike findRegions() in compare.js (which flood-fills a coarse block
 * density grid for the heat map), this walks the raw pixel mask directly
 * and tracks a running centroid per blob - needed to measure checkerboard
 * square centroids precisely for lib/checkerboard.js. lib/labelCrop.js
 * runs it over the detection mask and re-floods the winning blob from
 * `seed`.
 */

"use strict";

/**
 * 4-connected flood fill. Returns one entry per blob:
 * { cx, cy, area, x0, y0, x1, y1, seed } - cx/cy are the centroid (mean
 * x/y), x0/y0/x1/y1 is the half-open bounding box, seed the first pixel
 * index the fill visited.
 */
function connectedComponents(mask, width, height, opts) {
	const minArea = (opts && opts.minArea) || 0;
	const maxArea = (opts && opts.maxArea) || Infinity;
	const n = width * height;
	const visited = new Uint8Array(n);
	const stack = new Int32Array(n);
	const blobs = [];

	for (let start = 0; start < n; start++) {
		if (!mask[start] || visited[start]) continue;
		let stackLen = 0;
		visited[start] = 1;
		stack[stackLen++] = start;

		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let sumX = 0;
		let sumY = 0;
		let area = 0;

		while (stackLen > 0) {
			const idx = stack[--stackLen];
			const x = idx % width;
			const y = (idx / width) | 0;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			sumX += x;
			sumY += y;
			area++;

			if (x > 0 && mask[idx - 1] && !visited[idx - 1]) {
				visited[idx - 1] = 1;
				stack[stackLen++] = idx - 1;
			}
			if (x < width - 1 && mask[idx + 1] && !visited[idx + 1]) {
				visited[idx + 1] = 1;
				stack[stackLen++] = idx + 1;
			}
			if (y > 0 && mask[idx - width] && !visited[idx - width]) {
				visited[idx - width] = 1;
				stack[stackLen++] = idx - width;
			}
			if (y < height - 1 && mask[idx + width] && !visited[idx + width]) {
				visited[idx + width] = 1;
				stack[stackLen++] = idx + width;
			}
		}

		if (area < minArea || area > maxArea) continue;
		blobs.push({
			cx: sumX / area,
			cy: sumY / area,
			area,
			x0: minX,
			y0: minY,
			x1: maxX + 1,
			y1: maxY + 1,
			seed: start,
		});
	}

	return blobs;
}

/**
 * The same labelling, seeded: `seeds` is every set pixel of `mask`, in any
 * order, as the pass that set them collected it. Scanning 3 MP to find
 * 1.6K set pixels was 5 ms a frame; starting from the list is under 0.5.
 * Visited pixels are marked 2 in `mask` itself, so callers that only test
 * truthiness see no change and nothing is allocated per pixel. Same blob
 * shape as connectedComponents, without `seed`.
 */
function componentsFromSeeds(mask, width, height, seeds, opts) {
	const minArea = (opts && opts.minArea) || 0;
	const blobs = [];
	let stack = new Int32Array(1024);
	for (let s = 0; s < seeds.length; s++) {
		const start = seeds[s];
		if (mask[start] !== 1) continue;
		let stackLen = 0;
		mask[start] = 2;
		stack[0] = start;
		stackLen = 1;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let sumX = 0;
		let sumY = 0;
		let area = 0;
		while (stackLen > 0) {
			const idx = stack[--stackLen];
			const x = idx % width;
			const y = (idx / width) | 0;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			sumX += x;
			sumY += y;
			area++;
			if (stackLen + 4 > stack.length) {
				const grown = new Int32Array(stack.length * 2);
				grown.set(stack);
				stack = grown;
			}
			if (x > 0 && mask[idx - 1] === 1) {
				mask[idx - 1] = 2;
				stack[stackLen++] = idx - 1;
			}
			if (x < width - 1 && mask[idx + 1] === 1) {
				mask[idx + 1] = 2;
				stack[stackLen++] = idx + 1;
			}
			if (y > 0 && mask[idx - width] === 1) {
				mask[idx - width] = 2;
				stack[stackLen++] = idx - width;
			}
			if (y < height - 1 && mask[idx + width] === 1) {
				mask[idx + width] = 2;
				stack[stackLen++] = idx + width;
			}
		}
		if (area < minArea) continue;
		blobs.push({
			cx: sumX / area,
			cy: sumY / area,
			area,
			x0: minX,
			y0: minY,
			x1: maxX + 1,
			y1: maxY + 1,
		});
	}
	return blobs;
}

module.exports = { connectedComponents, componentsFromSeeds };
