/**
 * The tone check's two per-pixel passes, over a range of cells or rows,
 * in one place for both callers: lib/compare.js runs them over the whole
 * frame when the pool is off, and lib/poolWorker.js runs them a range per
 * worker. One implementation, so the verdict cannot depend on how many
 * cores the machine has. The tables and what they mean are explained at
 * toneDefect in lib/compare.js.
 *
 * Kept apart from compare.js because every pool worker loads this file,
 * and compare.js would bring sharp and the whole pipeline with it.
 */

"use strict";

/**
 * The frame's grey histogram per level cell, where the golden is pure
 * paper (histP) or pure ink (histK), for the cells [cellLo, cellHi) in
 * raster order. Split by whole cells, so no two ranges write the same
 * histogram, and by cells rather than rows of them: a 1500x2100 frame is
 * only 17 rows of cells, too few to share out evenly over 12 workers.
 * Still walked a pixel row at a time across the range's cells in that
 * row of cells - one cell at a time, 128 bytes a row, was half as fast.
 */
function toneHistCells(t, cellLo, cellHi) {
	const { classes, gray, histP, histK, width, height, cell, cellsW, paperBit, inkBit } = t;
	if (cellHi <= cellLo) return;
	const cyLast = ((cellHi - 1) / cellsW) | 0;
	for (let cy = (cellLo / cellsW) | 0; cy <= cyLast; cy++) {
		const first = Math.max(cellLo, cy * cellsW);
		const last = Math.min(cellHi, (cy + 1) * cellsW);
		const cxFrom = first - cy * cellsW;
		const cxTo = last - cy * cellsW;
		const yHi = Math.min(height, (cy + 1) * cell);
		for (let y = cy * cell; y < yHi; y++) {
			const row = y * width;
			for (let cx = cxFrom; cx < cxTo; cx++) {
				const off = (first + cx - cxFrom) << 8;
				const end = row + Math.min(width, (cx + 1) * cell);
				for (let i = row + cx * cell; i < end; i++) {
					const k = classes[i];
					if (k & paperBit) histP[off + gray[i]]++;
					else if (k & inkBit) histK[off + gray[i]]++;
				}
			}
		}
	}
}

/**
 * The comparison for rows [yLo, yHi): sets `defect` (and `speck`, and
 * the deviation `map`, when given) and adds how many defect and speck
 * pixels it set to tally[0] and tally[1], and each row's speck count to
 * `rowSpecks`, so the seed list is gathered from those rows alone, and,
 * when `blocks` is given, each defect pixel to its block of `blockSize`
 * px (`blocksW` across), as lib/diffRows.js blockCountRows counts a mask
 * - a caller splitting the rows must split them at whole rows of blocks.
 * A `speck` with no tables of its own (speckLo null) has the defect's
 * threshold and is the defect mask again. A row is walked in runs that
 * stay inside one level cell and one slack tile, so the cell, its span
 * and the tile's windows are looked up once per run rather than once per
 * pixel.
 */
function toneCompareRows(t, yLo, yHi, tally) {
	const { classes, gray, darkest, lightest, tileLevel, tile, slackGridW } = t;
	const { spans, lo, hi, speckLo, speckHi, expected, defect, speck, map, rowSpecks } = t;
	const { width, cell, cellsW, measuredBit } = t;
	const blocks = t.blocks || null;
	const { blockSize, blocksW } = t;
	// the common case, no map and no thresholds of the speck's own, gets
	// a loop with only the one comparison in it
	const plain = map === null && speckLo === null;
	let count = 0;
	let specks = 0;
	for (let y = yLo; y < yHi; y++) {
		const rowCell = ((y / cell) | 0) * cellsW;
		const slackRow = ((y / tile) | 0) * slackGridW;
		const row = y * width;
		const blockRow = blocks !== null ? ((y / blockSize) | 0) * blocksW : 0;
		const specksBefore = specks;
		let x0 = 0;
		while (x0 < width) {
			const cx = (x0 / cell) | 0;
			const tx = (x0 / tile) | 0;
			const x1 = Math.min(width, (cx + 1) * cell, (tx + 1) * tile);
			const c = rowCell + cx;
			const span = spans[c];
			if (span) {
				const level = tileLevel[slackRow + tx];
				const dk = darkest[level];
				const lt = lightest[level];
				const base = c << 8;
				if (plain) {
					for (let i = row + x0, end = row + x1; i < end; i++) {
						if (!(classes[i] & measuredBit)) continue;
						const v = gray[i];
						if (v <= lo[base + dk[i]] || v >= hi[base + lt[i]]) {
							defect[i] = 1;
							count++;
							if (blocks !== null) blocks[blockRow + (((i - row) / blockSize) | 0)]++;
							if (speck !== null) {
								speck[i] = 1;
								specks++;
							}
						}
					}
				} else {
					for (let i = row + x0, end = row + x1; i < end; i++) {
						if (!(classes[i] & measuredBit)) continue;
						const dark = base + dk[i];
						const light = base + lt[i];
						const v = gray[i];
						const hit = v <= lo[dark] || v >= hi[light];
						if (hit) {
							defect[i] = 1;
							count++;
							if (blocks !== null) blocks[blockRow + (((i - row) / blockSize) | 0)]++;
						}
						if (speck !== null && (speckLo === null ? hit : v <= speckLo[dark] || v >= speckHi[light])) {
							speck[i] = 1;
							specks++;
						}
						// the map starts at 0, which is what a grey inside the
						// expected range writes; only a deviation needs the division
						if (map !== null) {
							const eLo = expected[dark];
							const eHi = expected[light];
							if (v < eLo || v > eHi) {
								const dev = (v < eLo ? eLo - v : v - eHi) / span;
								map[i] = dev >= 1 ? 255 : Math.round(dev * 255);
							}
						}
					}
				}
			}
			x0 = x1;
		}
		if (rowSpecks !== null) rowSpecks[y] = specks - specksBefore;
	}
	tally[0] += count;
	tally[1] += specks;
}

module.exports = { toneHistCells, toneCompareRows };
