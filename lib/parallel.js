/**
 * Parallel forms of the per-pixel stages, each falling back to its serial
 * twin whenever the pool is unavailable, the image is small enough that
 * dispatch would cost more than it saves, or the caller asked for one
 * worker.
 *
 * The fallbacks are not a nicety. The serial implementations remain the
 * reference — the tests assert these agree with them byte for byte —
 * because a divergence would surface as a defect that appears or
 * disappears depending on the core count of the machine.
 */

"use strict";

const { dilate } = require("./dilate.js");
const { buildIntegral, buildIntegral64 } = require("./integral.js");
const { warpGray } = require("./warp.js");
const { warpPerspective } = require("./rectify.js");
const { invertHomography, isIdentityLike } = require("./homography.js");
const { smoothField, fieldStats, searchableTiles } = require("./localAlign.js");
const { runRanges, shouldParallelise, poolSize } = require("./pool.js");
const {
	allocU8,
	allocU32,
	allocF32,
	allocF64,
	toShared,
	HAS_SAB,
} = require("./shared.js");

/**
 * Summed-area table over a binary mask: row prefix sums in parallel, then
 * the column accumulation in parallel.
 *
 * The serial `buildIntegral` fuses both into one pass, which is the right
 * shape for one thread and the wrong shape for several: the fused loop
 * reads the row above as it writes, so no two rows can run at once.
 * Split into two passes each dimension is independent, and the arithmetic
 * is unchanged - Uint32 addition is exact and associative modulo 2^32, so
 * the table is byte-identical to the serial one either way.
 *
 * Worth doing because this is per-frame work on the full frame canvas:
 * ~99ms of a 918ms align on a 4096x5500 frame, run on the main path while
 * the pool sits idle.
 */
async function buildIntegralParallel(src, width, height, workers) {
	if (!shouldParallelise(width * height, workers)) {
		return buildIntegral(src, width, height);
	}
	const stride = width + 1;
	const s = toShared(src);
	const integral = allocU32(stride * (height + 1));
	const rows = runRanges(
		"integralRows",
		{ src: s.buffer, out: integral.buffer, width, stride },
		height,
		workers,
	);
	if (rows === null) return buildIntegral(src, width, height);
	await rows;
	await runRanges(
		"integralCols",
		{ out: integral.buffer, height, stride },
		width,
		workers,
	);
	return { integral, stride, width, height };
}

/**
 * The grey (Float64) summed-area table, split the same way. This is the
 * second per-frame table: `buildIntegralParallel` covers the binary mask
 * the transform search reads, this one covers the greys that every
 * candidate warp in the polish and the final full-resolution warp read.
 * ~110ms per frame on a 4096x5500 canvas, also built while the pool idles.
 */
async function buildGrayTableParallel(src, width, height, workers) {
	if (!shouldParallelise(width * height, workers)) {
		return buildIntegral64(src, width, height);
	}
	const stride = width + 1;
	const s = toShared(src);
	const integral = allocF64(stride * (height + 1));
	const rows = runRanges(
		"integralRows64",
		{ src: s.buffer, out: integral.buffer, width, stride },
		height,
		workers,
	);
	if (rows === null) return buildIntegral64(src, width, height);
	await rows;
	await runRanges(
		"integralCols64",
		{ out: integral.buffer, height, stride },
		width,
		workers,
	);
	return { integral, stride, width, height };
}

/** Separable dilation: rows in parallel, then columns in parallel. */
async function dilateParallel(src, width, height, radius, workers) {
	if (radius <= 0 || !shouldParallelise(width * height, workers)) {
		return dilate(src, width, height, radius);
	}
	const s = toShared(src);
	const tmp = allocU8(width * height);
	const out = allocU8(width * height);
	const rows = runRanges(
		"dilateRows",
		{ src: s.buffer, tmp: tmp.buffer, width, height, radius },
		height,
		workers,
	);
	if (rows === null) return dilate(src, width, height, radius);
	await rows;
	// the column pass reads what every row-pass worker wrote, so the two
	// dispatches cannot be merged - this await is a real barrier
	await runRanges(
		"dilateCols",
		{ tmp: tmp.buffer, out: out.buffer, width, height, radius },
		width,
		workers,
	);
	return out;
}

/**
 * defect = a AND NOT b, cleared wherever either image was too close to
 * its own ink level to have decided anything. Either ambiguity mask may
 * be null.
 */
async function defectParallel(
	a,
	b,
	ambiguousA,
	ambiguousB,
	width,
	height,
	workers,
) {
	const n = width * height;
	if (!shouldParallelise(n, workers)) return null;

	const sa = toShared(a);
	const sb = toShared(b);
	const sAmbA = ambiguousA ? toShared(ambiguousA) : null;
	const sAmbB = ambiguousB ? toShared(ambiguousB) : null;
	const out = allocU8(n);
	// one counter slot per worker rather than an atomic in the inner loop.
	// Sized from the pool, not a fixed 64: a worker index past the end of
	// a typed array is a silently ignored write (no RangeError), so with a
	// pool larger than the slot count the defect count came up short with
	// no error anywhere.
	const slots = allocU32(Math.max(1, poolSize(workers)));
	const p = runRanges(
		"defect",
		{
			a: sa.buffer,
			b: sb.buffer,
			ambiguousA: sAmbA ? sAmbA.buffer : null,
			ambiguousB: sAmbB ? sAmbB.buffer : null,
			out: out.buffer,
			counts: slots.buffer,
			width,
		},
		height,
		workers,
	);
	if (p === null) return null;
	await p;
	let count = 0;
	for (let i = 0; i < slots.length; i++) count += slots[i];
	return { defect: out, count };
}

// A fresh shared buffer; the callers below take an `alloc` of this shape
// so a frame can hand them its reused scratch instead (lib/shared.js
// takeShared). `zero` false: the caller writes every element.
function fresh(Ctor, length) {
	return Ctor === Uint32Array ? allocU32(length) : allocU8(length);
}

/**
 * Grey -> ink mask against one global level, plus the ambiguity band.
 * Given the golden's ink mask, also counts in the same pass what the
 * caller would otherwise walk the frame for twice more on one thread:
 * `golden` (its ink pixels), `covered` (of those, ink in the frame too)
 * and `mismatch` (pixels where the two masks disagree).
 *
 * The workers claim the rows a chunk at a time, as the tone check's do:
 * with fixed shares, the slowest worker's took twice the average on the
 * rig. `tone`, when given (lib/compare.js toneRide over the same grey),
 * rides along: each chunk's rows are compared by the tone check too, in
 * chunks of its rows, and `toneRan` says it ran.
 */
async function binarizeParallel(gray, width, height, level, margin, workers, golden = null, alloc = fresh, tone = null) {
	const n = width * height;
	if (!shouldParallelise(n, workers)) return null;
	const g = toShared(gray);
	const fg = alloc(Uint8Array, n, false);
	const ambiguous = margin > 0 ? alloc(Uint8Array, n, false) : null;
	// three slots per worker, sized from the pool as defectParallel's are;
	// zeroed, since a worker that claims no rows never writes its own
	const slots = golden ? alloc(Uint32Array, 3 * Math.max(1, poolSize(workers)), true) : null;
	const p = runClaimed(
		"binarize",
		{
			...(tone ? tone.ctx : {}),
			gray: g.buffer,
			fg: fg.buffer,
			ambiguous: ambiguous ? ambiguous.buffer : null,
			level,
			margin,
			width,
			golden: golden ? toShared(golden).buffer : null,
			counts: slots ? slots.buffer : null,
		},
		height,
		tone ? tone.chunk : BINARIZE_CHUNK,
		workers,
	);
	if (p === null) return null;
	await p;
	if (!slots) return { fg, ambiguous, toneRan: tone !== null };
	const counts = { golden: 0, covered: 0, mismatch: 0 };
	for (let i = 0; i < slots.length; i += 3) {
		counts.golden += slots[i];
		counts.covered += slots[i + 1];
		counts.mismatch += slots[i + 2];
	}
	return { fg, ambiguous, counts, toneRan: tone !== null };
}

/** A 256-bin grey histogram, rows split over the pool; null when it cannot. */
async function histogramParallel(gray, width, height, workers, alloc = fresh) {
	if (!shouldParallelise(width * height, workers)) return null;
	const bins = alloc(Uint32Array, 256 * Math.max(1, poolSize(workers)), true);
	const p = runRanges(
		"histogram",
		{ gray: toShared(gray).buffer, hist: bins.buffer, width },
		height,
		workers,
	);
	if (p === null) return null;
	await p;
	const hist = new Uint32Array(256);
	for (let i = 0; i < bins.length; i++) hist[i & 255] += bins[i];
	return hist;
}

/**
 * Both binary blemish checks in one dispatch over block rows - the
 * frame's ink dilated by `radius`, the print and background defect masks,
 * the edge margin cleared, and each mask's set pixels counted per block
 * and in total - where the serial pipeline is five passes and two of them
 * strided (lib/diffRows.js). The masks must be 0/1. Null when the pool is
 * unavailable; the caller then runs that pipeline.
 *
 * The workers claim DIFF_CHUNK block rows at a time rather than a fixed
 * share each: with fixed shares the slowest worker took twice the
 * average on the rig, 20 ms at p95. Each chunk dilates the rows of its
 * halo again, as each fixed share did; whole block rows, so no two
 * chunks add to one block's count.
 */
async function diffParallel(t, width, height, blockSize, workers, alloc = fresh) {
	const n = width * height;
	if (!shouldParallelise(n, workers)) return null;
	const gridW = Math.ceil(width / blockSize);
	const gridH = Math.ceil(height / blockSize);
	const share = (a) => (a ? toShared(a).buffer : null);
	// every pixel of the masks is written; the counts are added to
	const dilated = t.wantDilated ? alloc(Uint8Array, n, false) : null;
	const printDefect = alloc(Uint8Array, n, false);
	const backgroundDefect = alloc(Uint8Array, n, false);
	const printBlocks = alloc(Uint32Array, gridW * gridH, true);
	const backgroundBlocks = alloc(Uint32Array, gridW * gridH, true);
	const slots = alloc(Uint32Array, 2 * Math.max(1, poolSize(workers)), true);
	const p = runClaimed(
		"diff",
		{
			targetFg: share(t.targetFg),
			goldenFg: share(t.goldenFg),
			goldenFgDilatedBackground: share(t.goldenFgDilatedBackground),
			goldenAmbiguous: share(t.goldenAmbiguous),
			targetAmbiguous: share(t.targetAmbiguous),
			dilated: dilated ? dilated.buffer : null,
			printDefect: printDefect.buffer,
			backgroundDefect: backgroundDefect.buffer,
			printBlocks: printBlocks.buffer,
			backgroundBlocks: backgroundBlocks.buffer,
			counts: slots.buffer,
			width,
			height,
			radius: t.radius,
			margin: t.margin,
			blockSize,
		},
		gridH,
		DIFF_CHUNK,
		workers,
	);
	if (p === null) return null;
	await p;
	let printCount = 0;
	let backgroundCount = 0;
	for (let i = 0; i < slots.length; i += 2) {
		printCount += slots[i];
		backgroundCount += slots[i + 1];
	}
	return { dilated, printDefect, backgroundDefect, printBlocks, backgroundBlocks, printCount, backgroundCount };
}

/** Set pixels per block of a 0/1 mask, block rows split over the pool. */
async function blockCountsParallel(mask, width, height, blockSize, workers) {
	if (!shouldParallelise(width * height, workers)) return null;
	const gridH = Math.ceil(height / blockSize);
	const out = allocU32(Math.ceil(width / blockSize) * gridH);
	const p = runRanges(
		"blockCounts",
		{ mask: toShared(mask).buffer, out: out.buffer, width, height, blockSize },
		gridH,
		workers,
	);
	if (p === null) return null;
	await p;
	return out;
}

module.exports = {
	buildIntegralParallel,
	buildGrayTableParallel,
	dilateParallel,
	defectParallel,
	binarizeParallel,
	histogramParallel,
	diffParallel,
	blockCountsParallel,
	warpParallel,
	refineLocallyParallel,
	objectiveBatchParallel,
	densityBatchParallel,
	rectifyParallel,
};

// The polish objective's work is the whole batch - every candidate warps
// the objective canvas - so the gate is on the batch, not on one canvas:
// the row-split threshold applied to a single canvas sent the entire
// polish serial for any golden past roughly 2.5:1 - a legitimate label
// shape - at the pattern search's full serial cost. 100k total pixels is
// ~10k per candidate on a 10-wide pinned batch, around half a millisecond
// each, which comfortably clears a dispatch.
const MIN_OBJECTIVE_PIXELS = 100000;

/**
 * Score a whole neighbourhood of candidate transforms at once, every
 * candidate on every worker, one contiguous band of objective rows each.
 *
 * Returns null - meaning "score these yourself" - rather than throwing,
 * because the serial scorer in lib/compare.js stays the reference
 * implementation and every caller already has it to hand.
 *
 * `frame` is { gray, width, height, table, outW, outH, level, fgObj }, all
 * already expressed on the objective's own decimated grid: this function
 * does no coordinate conversion, so what it scores is exactly what the
 * serial scorer scores.
 */
async function objectiveBatchParallel(cands, frame, workers) {
	const n = cands.length;
	// Splitting one warp across eight workers costs a dispatch to save
	// nothing. (The polish no longer asks for one: it scores its start in
	// the same batch as the start's first neighbourhood.)
	if (n < 2) return null;
	if (!frame || !frame.table) return null;
	if (!HAS_SAB || workers === 1) return null;
	if (n * frame.outW * frame.outH < MIN_OBJECTIVE_PIXELS) return null;

	const gray = toShared(frame.gray);
	const fgObj = toShared(frame.fgObj);
	const integral = toShared(frame.table.integral);

	// five parameters per candidate, flat, so the dispatch carries numbers
	// rather than a structured clone of an array of objects
	const params = allocF64(n * 5);
	for (let i = 0; i < n; i++) {
		const c = cands[i];
		params[i * 5] = c.mx;
		params[i * 5 + 1] = c.my;
		params[i * 5 + 2] = c.theta;
		params[i * 5 + 3] = c.ox;
		params[i * 5 + 4] = c.oy;
	}

	// One mismatch count per candidate per worker, summed here: each worker
	// scores every candidate over its own band of rows (see the kernel on
	// why rows). Sized from the pool, as defectParallel's slots are.
	const slots = Math.max(1, poolSize(workers));
	const counts = allocU32(n * slots);
	const rows = allocU32(slots);

	const p = runRanges(
		"objective",
		{
			gray: gray.buffer,
			fgObj: fgObj.buffer,
			sat: integral.buffer,
			satStride: frame.table.stride,
			srcW: frame.width,
			srcH: frame.height,
			outW: frame.outW,
			outH: frame.outH,
			level: frame.level,
			params: params.buffer,
			counts: counts.buffer,
			rows: rows.buffer,
			slots,
		},
		frame.outH,
		workers,
	);
	// getPool returns null on a host that resolves to one worker even though
	// the pixel gate passed - a 2-core machine, where defaultSize() is 1.
	// Without this the zero counts would come back as a perfect match for
	// every candidate.
	if (p === null) return null;
	await p;

	// Zero counts are "a perfect match" - they beat every other candidate
	// and pass the part - so a band no worker scored would steer the
	// alignment rather than fail. Every row has to be accounted for.
	let covered = 0;
	for (let i = 0; i < slots; i++) covered += rows[i];
	if (covered !== frame.outH) {
		throw new Error(
			`objective batch scored ${covered} of ${frame.outH} rows - a dispatch did not write its range`,
		);
	}
	const total = frame.outW * frame.outH;
	const out = new Array(n);
	for (let c = 0; c < n; c++) {
		let mismatch = 0;
		for (let i = 0; i < slots; i++) mismatch += counts[c * slots + i];
		out[c] = mismatch / total;
	}
	return out;
}

// A density candidate costs one read per lattice cell - ~2.8k on the
// medium grid, ~6k on the fine, at ~30ns each - so a batch below this
// many cell reads (~7ms serial) is not worth a dispatch: the pinned
// search's single-candidate coarse sweep and its 3x3 fine step stay on
// the calling thread.
const MIN_DENSITY_CELLS = 250000;

// The golden's lattices are built once per golden and read by every frame;
// their shared copies are made once too, rather than once per sweep.
const sharedSignatures = new WeakMap();
function sharedSignature(sig) {
	let s = sharedSignatures.get(sig);
	if (!s) {
		s = {
			density: toShared(sig.density),
			centerX: toShared(sig.centerX),
			centerY: toShared(sig.centerY),
		};
		sharedSignatures.set(sig, s);
	}
	return s;
}

/**
 * The transform search's density sweep, candidates split across the pool.
 * `params` is five numbers per candidate (mx, my, theta, ox, oy); the
 * scores come back as a Float64Array in that order, each one exactly what
 * scoreCandidate returns for it on this thread. Null - "score these
 * yourself" - when the batch is too small or there is no pool.
 *
 * The density sweeps were the one stage of the JS search still on the
 * inspector's own thread: ~25ms a frame pinned, ~2.8s unpinned, with the
 * pool idle throughout.
 */
async function densityBatchParallel(sig, table, tW, tH, params, n, workers) {
	if (!HAS_SAB || workers === 1) return null;
	if (n < 2 || n * sig.gridW * sig.gridH < MIN_DENSITY_CELLS) return null;
	const s = sharedSignature(sig);
	const integral = toShared(table.integral);
	const shParams = allocF64(n * 5);
	shParams.set(params.subarray(0, n * 5));
	// NaN, not zero: an unwritten slot must not read as a perfect match
	const scores = allocF64(n);
	scores.fill(NaN);
	const p = runRanges(
		"density",
		{
			density: s.density.buffer,
			centerX: s.centerX.buffer,
			centerY: s.centerY.buffer,
			gridW: sig.gridW,
			gridH: sig.gridH,
			cellW: sig.cellW,
			cellH: sig.cellH,
			integral: integral.buffer,
			stride: table.stride,
			tW,
			tH,
			params: shParams.buffer,
			scores: scores.buffer,
		},
		n,
		workers,
	);
	if (p === null) return null;
	await p;
	for (let i = 0; i < n; i++) {
		if (Number.isNaN(scores[i])) {
			throw new Error(
				`density batch left candidate ${i} of ${n} unscored - a dispatch did not write its range`,
			);
		}
	}
	return scores;
}

/** Resample the frame into golden's grid, rows split across the pool. */
async function warpParallel(
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
	workers,
) {
	const serial = () =>
		warpGray(src, srcW, srcH, mx, my, theta, ox, oy, outW, outH, fill, table);
	if (!shouldParallelise(outW * outH, workers)) return serial();
	// The same test warpGray uses to pick the area-average path, which is
	// the only one that reads the table. The bilinear path reads the source
	// alone and splits the same way: a rig whose frame resolves the part a
	// shade coarser than the golden (m ~0.99) used to run it on one thread.
	const area = mx > 1.001 || my > 1.001;
	if (area && !table) return serial();

	const s = toShared(src);
	const integral = area ? toShared(table.integral) : null;
	const out = allocU8(outW * outH);
	out.fill(fill == null ? 255 : fill);
	const p = runRanges(
		"warp",
		{
			src: s.buffer,
			out: out.buffer,
			srcW,
			srcH,
			mx,
			my,
			theta,
			ox,
			oy,
			outW,
			sat: integral ? integral.buffer : null,
			satStride: integral ? table.stride : 0,
		},
		outH,
		workers,
	);
	if (p === null) return serial();
	await p;
	return out;
}

/**
 * perspective-rectify's warp, output rows split across the pool. Every
 * output pixel is computed from the source alone, so the split changes
 * nothing about the bytes - the test asserts identity with the serial
 * warp. ~127ms serial on a 1500x1850 RGB frame; the split is where the
 * time goes, not the arithmetic.
 */
async function rectifyParallel(src, H, workers) {
	const { width, height, channels } = src;
	if (isIdentityLike(H)) return src;
	if (!shouldParallelise(width * height, workers)) {
		return warpPerspective(src, H);
	}
	const s = toShared(src.data);
	const out = allocU8(width * height * channels);
	const p = runRanges(
		"rectify",
		{
			src: s.buffer,
			out: out.buffer,
			width,
			height,
			channels,
			inv: invertHomography(H),
		},
		height,
		workers,
	);
	if (p === null) return warpPerspective(src, H);
	await p;
	return { data: out, width, height, channels };
}

// What a local-alignment worker claims at a time: two tiles of the field,
// a few hundred on the rig's golden, and two LOCAL_APPLY_CELL squares of
// the resampling, about a hundred.
const LOCAL_FIELD_CHUNK = 2;
const LOCAL_APPLY_CELL = 128;
const LOCAL_APPLY_CHUNK = 2;
// rows of the binarization a worker claims at a time, as the tone
// check's comparison does
const BINARIZE_CHUNK = 16;
// block rows of the fused diff a worker claims at a time: 32 px rows at
// the default block size, each chunk dilating a halo of printTolerance
// rows either side again (4 extra of 32 at the rig's 2)
const DIFF_CHUNK = 4;

/**
 * Run `kernel` on every worker of the pool over [0, total), each worker
 * claiming `chunk` at a time off one shared counter until none is left
 * (lib/poolWorker.js eachClaimed), so a worker the host has paused holds
 * up only the chunk it has. Null when there is no pool.
 */
function runClaimed(kernel, ctx, total, chunk, workers) {
	const claim = { next: allocU32(1).buffer, total, chunk };
	return runRanges(kernel, { ...ctx, ...claim }, poolSize(workers), workers);
}

/**
 * Per-tile refinement with both halves split: the field build over tiles,
 * then - after a barrier, since the median filter reads the whole field -
 * the resampling over squares of the frame, each claimed a chunk at a
 * time rather than taken a fixed share per worker: a tile's search costs
 * anything from nothing (a blank tile) to every offset in full, and on
 * the rig the slowest worker's fixed share of the field took 40% longer
 * than the average one.
 *
 * The resampling writes every pixel of the grey the checks after it read,
 * so it also counts what two of them would otherwise each spend a pass
 * over the pool counting: with `count.grey`, the grey's histogram (for
 * Otsu's level), returned as `grey`; with `count.tone` (lib/compare.js
 * toneCounts), the tone check's per-cell histograms, returned as
 * `tone: { histP, histK }`. Its squares are then the tone check's cells,
 * so no two workers add to one cell's bins.
 */
async function refineLocallyParallel(
	goldenGray,
	alignedTargetGray,
	width,
	height,
	cfg,
	alloc = fresh,
	count = null,
) {
	const tile = Math.max(8, cfg.localAlignTile | 0);
	const maxOffset = Math.max(1, cfg.localAlignMax | 0);
	const minStdDev =
		cfg.localAlignMinStdDev != null ? cfg.localAlignMinStdDev : 12;
	if (!shouldParallelise(width * height, cfg.workers)) return null;

	const g = toShared(goldenGray);
	const t = toShared(alignedTargetGray);
	const gridW = Math.max(1, Math.ceil(width / tile));
	const gridH = Math.max(1, Math.ceil(height / tile));
	const raw = {
		fx: allocF32(gridW * gridH),
		fy: allocF32(gridW * gridH),
		valid: allocU8(gridW * gridH),
		gridW,
		gridH,
	};
	const build = runClaimed(
		"localField",
		{
			golden: g.buffer,
			target: t.buffer,
			fx: raw.fx.buffer,
			fy: raw.fy.buffer,
			valid: raw.valid.buffer,
			width,
			height,
			gridW,
			tile,
			maxOffset,
			minStdDev,
			searchable: searchableTiles(goldenGray, width, height, tile, minStdDev).buffer,
		},
		gridW * gridH,
		LOCAL_FIELD_CHUNK,
		cfg.workers,
	);
	if (build === null) return null;
	await build;

	// small enough that splitting it would cost more than it saves
	const field = smoothField(raw);

	// every pixel is written; the bins are added to, so they start at zero
	const out = alloc(Uint8Array, width * height, false);
	const tone = count && count.tone ? count.tone : null;
	const cell = tone ? tone.cell : LOCAL_APPLY_CELL;
	const cellsW = Math.ceil(width / cell);
	const cells = cellsW * Math.ceil(height / cell);
	// one histogram per worker, summed below, as histogramParallel's are
	const slots = Math.max(1, poolSize(cfg.workers));
	const greyBins = count && count.grey ? alloc(Uint32Array, 256 * slots, true) : null;
	const histP = tone ? alloc(Uint32Array, cells * 256, true) : null;
	const histK = tone ? alloc(Uint32Array, cells * 256, true) : null;
	await runClaimed(
		"localApply",
		{
			target: t.buffer,
			out: out.buffer,
			fx: field.fx.buffer,
			fy: field.fy.buffer,
			width,
			height,
			gridW,
			gridH,
			tile,
			cell,
			cellsW,
			grey: greyBins ? greyBins.buffer : null,
			classes: tone ? toShared(tone.classes).buffer : null,
			histP: histP ? histP.buffer : null,
			histK: histK ? histK.buffer : null,
			paperBit: tone ? tone.paperBit : 0,
			inkBit: tone ? tone.inkBit : 0,
		},
		cells,
		LOCAL_APPLY_CHUNK,
		cfg.workers,
	);
	let grey = null;
	if (greyBins) {
		grey = new Uint32Array(256);
		for (let i = 0; i < greyBins.length; i++) grey[i & 255] += greyBins[i];
	}
	return {
		gray: out,
		field,
		tile,
		stats: fieldStats(field),
		grey,
		tone: tone ? { histP, histK } : null,
	};
}
