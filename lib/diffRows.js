/**
 * The two binary blemish checks' per-pixel half, over a range of block
 * rows, in one place for both callers: lib/compare.js runs it over the
 * whole frame in tests and lib/poolWorker.js a range per worker. The
 * serial pipeline it replaces - dilate, computeDefect twice, clearEdge,
 * buildHeatmapGrid - stays in compare.js as the reference and the path
 * without a pool; test/diffRows.test.js holds the two to the byte.
 *
 * Kept apart from compare.js because every pool worker loads this file,
 * and compare.js would bring sharp and the whole pipeline with it.
 */

"use strict";

/**
 * Set pixels per block for block rows [gyLo, gyHi) of a 0/1 mask, into
 * `out` (gridW x gridH, row-major). Blocks never overlap, so ranges of
 * whole block rows never write the same cell.
 */
function blockCountRows(mask, width, height, blockSize, out, gyLo, gyHi) {
	const gridW = Math.ceil(width / blockSize);
	for (let gy = gyLo; gy < gyHi; gy++) {
		const y0 = gy * blockSize;
		const y1 = Math.min(height, y0 + blockSize);
		const cells = gy * gridW;
		for (let y = y0; y < y1; y++) {
			const row = y * width;
			for (let gx = 0; gx < gridW; gx++) {
				const end = row + Math.min(width, (gx + 1) * blockSize);
				let count = 0;
				for (let i = row + gx * blockSize; i < end; i++) count += mask[i];
				out[cells + gx] += count;
			}
		}
	}
}

/**
 * Block rows [gyLo, gyHi) of both binary checks at once:
 *
 *   dilated          targetFg dilated by `radius` px (a square window
 *                    clipped at the image edge, as lib/dilate.js), when
 *                    a buffer is given - only the stage viewer reads it
 *   printDefect      goldenFg AND NOT dilated
 *   backgroundDefect targetFg AND NOT goldenFgDilatedBackground
 *
 * each cleared where either image is ambiguous and inside `margin` px of
 * the border (clearEdge), with its set pixels counted per block into
 * printBlocks / backgroundBlocks and in total into tally[0] / tally[1].
 *
 * The masks are 0/1, which is what lets the dilation be a count over the
 * window rather than a running maximum: rows by a sliding sum, columns by
 * a per-column count updated a row at a time, so every pass walks memory
 * in order. The rows a range needs above and below it are dilated again
 * by that range rather than shared, so a range needs no other's output.
 * `scratch` is { rows: Uint8Array, cols: Int32Array }, grown as needed.
 */
function diffRows(t, gyLo, gyHi, tally, scratch) {
	const { targetFg, goldenFg, goldenFgDilatedBackground, goldenAmbiguous, targetAmbiguous } = t;
	const { dilated, printDefect, backgroundDefect, printBlocks, backgroundBlocks } = t;
	const { width, height, blockSize } = t;
	const r = t.radius > 0 ? t.radius : 0;
	let m = Math.min(t.margin, Math.floor(width / 2), Math.floor(height / 2));
	if (!(m > 0)) m = 0;
	const gridW = Math.ceil(width / blockSize);
	const y0 = gyLo * blockSize;
	const y1 = Math.min(height, gyHi * blockSize);
	if (y0 >= y1) return;

	// the horizontal pass, over this range's rows and r more either side
	const hy0 = Math.max(0, y0 - r);
	const hy1 = Math.min(height, y1 + r);
	const need = (hy1 - hy0) * width;
	if (scratch.rows.length < need) scratch.rows = new Uint8Array(need);
	if (scratch.cols.length < width) scratch.cols = new Int32Array(width);
	const hrow = scratch.rows;
	const cols = scratch.cols;
	for (let y = hy0; y < hy1; y++) {
		const src = y * width;
		const dst = (y - hy0) * width;
		let c = 0;
		for (let x = 0; x < r && x < width; x++) c += targetFg[src + x];
		for (let x = 0; x < width; x++) {
			if (x + r < width) c += targetFg[src + x + r];
			if (x - r - 1 >= 0) c -= targetFg[src + x - r - 1];
			hrow[dst + x] = c > 0 ? 1 : 0;
		}
	}

	// the vertical pass's window for the first row: [y0 - r, y0 + r]
	cols.fill(0, 0, width);
	for (let y = hy0; y < Math.min(height, y0 + r + 1); y++) {
		const src = (y - hy0) * width;
		for (let x = 0; x < width; x++) cols[x] += hrow[src + x];
	}

	let prints = 0;
	let backgrounds = 0;
	for (let y = y0; y < y1; y++) {
		if (y > y0) {
			const add = y + r;
			const drop = y - r - 1;
			if (add < height) {
				const src = (add - hy0) * width;
				for (let x = 0; x < width; x++) cols[x] += hrow[src + x];
			}
			if (drop >= 0) {
				const src = (drop - hy0) * width;
				for (let x = 0; x < width; x++) cols[x] -= hrow[src + x];
			}
		}
		const row = y * width;
		const cells = ((y / blockSize) | 0) * gridW;
		// what clearEdge keeps of this row: nothing in the top and bottom
		// margin, else everything but its two ends
		const keepFrom = y < m || y >= height - m ? width : m;
		const keepTo = width - m;
		for (let gx = 0; gx < gridW; gx++) {
			const xEnd = Math.min(width, (gx + 1) * blockSize);
			let p = 0;
			let b = 0;
			for (let x = gx * blockSize; x < xEnd; x++) {
				const i = row + x;
				const dil = cols[x] > 0 ? 1 : 0;
				if (dilated !== null) dilated[i] = dil;
				let dp = goldenFg[i] & ~dil & 1;
				let db = targetFg[i] & ~goldenFgDilatedBackground[i] & 1;
				if (
					(dp | db) !== 0 &&
					((goldenAmbiguous !== null && goldenAmbiguous[i]) ||
						(targetAmbiguous !== null && targetAmbiguous[i]) ||
						x < keepFrom ||
						x >= keepTo)
				) {
					dp = 0;
					db = 0;
				}
				printDefect[i] = dp;
				backgroundDefect[i] = db;
				p += dp;
				b += db;
			}
			printBlocks[cells + gx] += p;
			backgroundBlocks[cells + gx] += b;
			prints += p;
			backgrounds += b;
		}
	}
	tally[0] += prints;
	tally[1] += backgrounds;
}

module.exports = { diffRows, blockCountRows };
