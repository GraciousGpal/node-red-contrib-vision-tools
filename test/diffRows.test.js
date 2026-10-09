/**
 * The one-pass blemish diff (lib/diffRows.js), the counts the pool takes
 * while it binarizes, and its histogram, against the passes they replace.
 *
 * Exactly, not closely: the per-block counts decide which regions exist
 * and the totals decide the defect ratios, so a pixel's difference is a
 * verdict's. The references below are the serial pipeline written out -
 * dilate, a AND NOT b with the ambiguity cleared, clearEdge's border, a
 * per-block count - so a change to either side shows here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { diffRows, blockCountRows } = require("../lib/diffRows.js");
const { dilate } = require("../lib/dilate.js");
const { buildHeatmapGrid } = require("../lib/compare.js");
const { otsuThreshold } = require("../lib/threshold.js");
const { diffParallel, binarizeParallel, histogramParallel, blockCountsParallel } = require("../lib/parallel.js");
const { shutdown } = require("../lib/pool.js");
const { HAS_SAB } = require("../lib/shared.js");

test.after(() => shutdown());

function mask(width, height, salt, density) {
	const a = new Uint8Array(width * height);
	let seed = 4242 + salt * 7919;
	for (let i = 0; i < a.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		a[i] = (seed >> 16) % 1000 < density * 1000 ? 1 : 0;
	}
	return a;
}

// The serial pipeline compareFrame ran before the one pass, as plain loops.
function reference(t, width, height, blockSize) {
	const dilated = dilate(t.targetFg, width, height, t.radius);
	const defect = (a, b, i) => {
		const d = a[i] & ~b[i] & 1;
		if (!d) return 0;
		if ((t.goldenAmbiguous && t.goldenAmbiguous[i]) || (t.targetAmbiguous && t.targetAmbiguous[i])) return 0;
		return 1;
	};
	const n = width * height;
	const printDefect = new Uint8Array(n);
	const backgroundDefect = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		printDefect[i] = defect(t.goldenFg, dilated, i);
		backgroundDefect[i] = defect(t.targetFg, t.goldenFgDilatedBackground, i);
	}
	// clearEdge
	const m = Math.min(t.margin, Math.floor(width / 2), Math.floor(height / 2));
	if (m > 0) {
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (x < m || x >= width - m || y < m || y >= height - m) {
					printDefect[y * width + x] = 0;
					backgroundDefect[y * width + x] = 0;
				}
			}
		}
	}
	const sum = (a) => a.reduce((s, v) => s + v, 0);
	const blocks = (a) => {
		const gridW = Math.ceil(width / blockSize);
		const out = new Uint32Array(gridW * Math.ceil(height / blockSize));
		for (let i = 0; i < n; i++) {
			out[Math.floor(Math.floor(i / width) / blockSize) * gridW + Math.floor((i % width) / blockSize)] += a[i];
		}
		return out;
	};
	return {
		dilated,
		printDefect,
		backgroundDefect,
		printCount: sum(printDefect),
		backgroundCount: sum(backgroundDefect),
		printBlocks: blocks(printDefect),
		backgroundBlocks: blocks(backgroundDefect),
	};
}

function inputs(width, height, salt, { radius, margin, ambiguous }) {
	const targetFg = mask(width, height, salt, 0.08);
	const goldenFg = mask(width, height, salt + 1, 0.1);
	return {
		targetFg,
		goldenFg,
		goldenFgDilatedBackground: dilate(goldenFg, width, height, 1),
		goldenAmbiguous: ambiguous ? mask(width, height, salt + 2, 0.05) : null,
		targetAmbiguous: ambiguous ? mask(width, height, salt + 3, 0.05) : null,
		radius,
		margin,
	};
}

// lib/diffRows.js run over `ranges` of block rows, as the pool would
function runRows(t, width, height, blockSize, ranges) {
	const n = width * height;
	const gridW = Math.ceil(width / blockSize);
	const gridH = Math.ceil(height / blockSize);
	const out = {
		...t,
		width,
		height,
		blockSize,
		dilated: new Uint8Array(n),
		printDefect: new Uint8Array(n),
		backgroundDefect: new Uint8Array(n),
		printBlocks: new Uint32Array(gridW * gridH),
		backgroundBlocks: new Uint32Array(gridW * gridH),
	};
	const tally = [0, 0];
	const scratch = { rows: new Uint8Array(0), cols: new Int32Array(0) };
	for (const [lo, hi] of ranges) diffRows(out, lo, hi, tally, scratch);
	return { ...out, printCount: tally[0], backgroundCount: tally[1] };
}

function assertSame(actual, expected, label) {
	for (const key of ["dilated", "printDefect", "backgroundDefect", "printBlocks", "backgroundBlocks"]) {
		if (actual[key] === null) continue;
		assert.ok(Buffer.from(actual[key].buffer, actual[key].byteOffset, actual[key].byteLength).equals(
			Buffer.from(expected[key].buffer, expected[key].byteOffset, expected[key].byteLength),
		), `${label}: ${key}`);
	}
	assert.equal(actual.printCount, expected.printCount, `${label}: print count`);
	assert.equal(actual.backgroundCount, expected.backgroundCount, `${label}: background count`);
}

test("the one-pass diff matches the serial pipeline, however its rows are split", () => {
	let salt = 0;
	// odd sizes clip the last block row and column; 1-px images, radii
	// past the image and margins past half of it are all edge cases
	for (const [width, height] of [[1, 1], [5, 3], [37, 29], [64, 64], [101, 83]]) {
		for (const blockSize of [4, 7, 16]) {
			for (const radius of [0, 1, 2, 5, 60]) {
				for (const margin of [0, 3, 1000]) {
					for (const ambiguous of [false, true]) {
						const t = inputs(width, height, ++salt, { radius, margin, ambiguous });
						const expected = reference(t, width, height, blockSize);
						const gridH = Math.ceil(height / blockSize);
						const label = `${width}x${height} block ${blockSize} r ${radius} margin ${margin} amb ${ambiguous}`;
						// whole, one block row at a time, and uneven ranges
						const splits = [
							[[0, gridH]],
							Array.from({ length: gridH }, (_, i) => [i, i + 1]),
							[[0, gridH >> 1], [gridH >> 1, gridH]],
						];
						for (const ranges of splits) {
							assertSame(runRows(t, width, height, blockSize, ranges), expected, label);
						}
					}
				}
			}
		}
	}
});

test("diffParallel matches the serial pipeline on the pool", { skip: !HAS_SAB }, async () => {
	const width = 801;
	const height = 703;
	for (const [radius, margin, blockSize] of [[2, 0, 8], [1, 5, 16], [4, 0, 7]]) {
		const t = inputs(width, height, radius * 10 + margin, { radius, margin, ambiguous: true });
		const expected = reference(t, width, height, blockSize);
		for (const workers of [2, 3, 8, 12, 16]) {
			const par = await diffParallel({ ...t, wantDilated: true }, width, height, blockSize, workers);
			assert.ok(par, "precondition: the fixture should be big enough to split");
			assertSame(par, expected, `r ${radius} margin ${margin} block ${blockSize} workers ${workers}`);
		}
		// The workers claim block rows a chunk at a time, and the masks
		// arrive holding the last frame's pixels (compareFrame's scratch):
		// every row must still be written exactly once, every block counted
		// once. Block rows that no chunk size divides (703 / 7 = 101).
		const dirty = (Ctor, length, zero) => {
			const a = new Ctor(new SharedArrayBuffer(length * Ctor.BYTES_PER_ELEMENT));
			if (!zero) a.fill(1);
			return a;
		};
		const par = await diffParallel({ ...t, wantDilated: true }, width, height, blockSize, 12, dirty);
		assertSame(par, expected, `r ${radius} margin ${margin} block ${blockSize}, dirty scratch`);
	}
	// without the stage viewer the dilated mask is not written at all
	const t = inputs(width, height, 1, { radius: 2, margin: 0, ambiguous: false });
	const par = await diffParallel(t, width, height, 8, 4);
	assert.equal(par.dilated, null);
	assertSame(par, reference(t, width, height, 8), "without the dilated mask");
});

// buildHeatmapGrid as it was before it was split into counting and
// dividing, the reference for both halves
function gridPerPixel(defect, width, height, blockSize, reference) {
	const gridW = Math.ceil(width / blockSize);
	const gridH = Math.ceil(height / blockSize);
	const density = new Float32Array(gridW * gridH);
	const missing = reference ? new Float32Array(gridW * gridH) : null;
	for (let gy = 0; gy < gridH; gy++) {
		const y0 = gy * blockSize;
		const y1 = Math.min(height, y0 + blockSize);
		for (let gx = 0; gx < gridW; gx++) {
			const x0 = gx * blockSize;
			const x1 = Math.min(width, x0 + blockSize);
			let count = 0;
			let ref = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					count += defect[y * width + x];
					if (reference) ref += reference[y * width + x];
				}
			}
			const area = (x1 - x0) * (y1 - y0);
			const i = gy * gridW + gx;
			density[i] = area > 0 ? count / area : 0;
			if (missing) {
				const minInk = Math.max(4, Math.round(area * 0.06));
				missing[i] = ref >= minInk ? Math.min(1, count / ref) : 0;
			}
		}
	}
	return { density, gridW, gridH, missing };
}

test("grids from block counts are buildHeatmapGrid's, the missing-ink fraction included", { skip: !HAS_SAB }, async () => {
	const { gridFromCounts } = require("../lib/compare.js");
	for (const [width, height, blockSize] of [[801, 703, 8], [640, 640, 16], [999, 517, 7]]) {
		const defect = mask(width, height, 5, 0.04);
		// dense enough that some blocks clear the missing gate's minimum
		// ink, and some lose all of it
		const golden = mask(width, height, 6, 0.12);
		for (let i = 0; i < golden.length; i += 3) if (golden[i]) defect[i] = 1;
		for (const ref of [null, golden]) {
			const expected = gridPerPixel(defect, width, height, blockSize, ref);
			assert.deepEqual(buildHeatmapGrid(defect, width, height, blockSize, ref), expected);
			const counts = await blockCountsParallel(defect, width, height, blockSize, 4);
			assert.ok(counts, "precondition: should have run in parallel");
			const serialCounts = new Uint32Array(counts.length);
			blockCountRows(defect, width, height, blockSize, serialCounts, 0, Math.ceil(height / blockSize));
			assert.deepEqual(new Uint32Array(counts), serialCounts);
			const refCounts = ref ? await blockCountsParallel(ref, width, height, blockSize, 4) : null;
			const actual = gridFromCounts(counts, refCounts, width, height, blockSize);
			assert.deepEqual(actual, expected, `${width}x${height} block ${blockSize} ref ${!!ref}`);
		}
	}
});

test("binarize counts the golden's ink, its coverage and the disagreement", { skip: !HAS_SAB }, async () => {
	const width = 777;
	const height = 611;
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < gray.length; i++) gray[i] = (i * 2654435761) >>> 24;
	const golden = mask(width, height, 9, 0.2);
	for (const workers of [2, 5, 8]) {
		const par = await binarizeParallel(gray, width, height, 131, 6, workers, golden);
		assert.ok(par, "precondition: should have run in parallel");
		let ink = 0;
		let covered = 0;
		let mismatch = 0;
		for (let i = 0; i < gray.length; i++) {
			const f = gray[i] < 131 ? 1 : 0;
			if (golden[i]) {
				ink++;
				if (f) covered++;
			}
			if (f !== golden[i]) mismatch++;
		}
		assert.deepEqual(par.counts, { golden: ink, covered, mismatch }, `workers ${workers}`);
	}
	// without a golden it is the plain binarize, and says nothing
	const plain = await binarizeParallel(gray, width, height, 131, 6, 4);
	assert.equal(plain.counts, undefined);
});

test("the pool's histogram is the serial one, so Otsu's level is too", { skip: !HAS_SAB }, async () => {
	const width = 900;
	const height = 700;
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < gray.length; i++) gray[i] = i % 3 ? 40 + ((i * 7) % 50) : 200 + (i % 40);
	const serial = new Uint32Array(256);
	for (const v of gray) serial[v]++;
	for (const workers of [2, 7, 8]) {
		const hist = await histogramParallel(gray, width, height, workers);
		assert.deepEqual(hist, serial, `workers ${workers}`);
	}
	const { otsuLevel } = require("../lib/threshold.js");
	assert.equal(otsuLevel(await histogramParallel(gray, width, height, 4), gray.length), otsuThreshold(gray));
});
