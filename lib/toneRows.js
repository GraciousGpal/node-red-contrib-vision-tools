/**
 * The tone check's two per-pixel passes, over a range of rows, in one
 * place for both callers: lib/compare.js runs them over the whole frame
 * when the pool is off, and lib/poolWorker.js runs them a range per
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
 * paper (histP) or pure ink (histK), for the cell rows [cellLo, cellHi).
 * Split by whole cell rows, so no two ranges write the same cell.
 */
function toneHistRows(t, cellLo, cellHi) {
	const { classes, gray, histP, histK, width, height, cell, cellsW, paperBit, inkBit } = t;
	const yHi = Math.min(height, cellHi * cell);
	for (let y = cellLo * cell; y < yHi; y++) {
		const rowCell = ((y / cell) | 0) * cellsW;
		const row = y * width;
		for (let cx = 0; cx < cellsW; cx++) {
			const off = (rowCell + cx) << 8;
			const end = row + Math.min(width, (cx + 1) * cell);
			for (let i = row + cx * cell; i < end; i++) {
				const c = classes[i];
				if (c & paperBit) histP[off + gray[i]]++;
				else if (c & inkBit) histK[off + gray[i]]++;
			}
		}
	}
}

/**
 * The comparison for rows [yLo, yHi): sets `defect` (and `speck`, and
 * the deviation `map`, when given) and adds how many defect and speck
 * pixels it set to tally[0] and tally[1]. A row is walked in runs that
 * stay inside one level cell and one slack tile, so the cell, its span
 * and the tile's windows are looked up once per run rather than once per
 * pixel.
 */
function toneCompareRows(t, yLo, yHi, tally) {
	const { classes, gray, darkest, lightest, tileLevel, tile, slackGridW } = t;
	const { spans, lo, hi, speckLo, speckHi, expected, defect, speck, map } = t;
	const { width, cell, cellsW, measuredBit } = t;
	let count = 0;
	let specks = 0;
	for (let y = yLo; y < yHi; y++) {
		const rowCell = ((y / cell) | 0) * cellsW;
		const slackRow = ((y / tile) | 0) * slackGridW;
		const row = y * width;
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
				for (let i = row + x0, end = row + x1; i < end; i++) {
					if (!(classes[i] & measuredBit)) continue;
					const dark = base + dk[i];
					const light = base + lt[i];
					const v = gray[i];
					if (v <= lo[dark] || v >= hi[light]) {
						defect[i] = 1;
						count++;
					}
					if (speck !== null && (v <= speckLo[dark] || v >= speckHi[light])) {
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
			x0 = x1;
		}
	}
	tally[0] += count;
	tally[1] += specks;
}

module.exports = { toneHistRows, toneCompareRows };
