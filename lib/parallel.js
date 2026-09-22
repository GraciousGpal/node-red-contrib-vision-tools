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
const { smoothField, fieldStats } = require("./localAlign.js");
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

/** Grey -> ink mask against one global level, plus the ambiguity band. */
async function binarizeParallel(gray, width, height, level, margin, workers) {
	const n = width * height;
	if (!shouldParallelise(n, workers)) return null;
	const g = toShared(gray);
	const fg = allocU8(n);
	const ambiguous = margin > 0 ? allocU8(n) : null;
	const p = runRanges(
		"binarize",
		{
			gray: g.buffer,
			fg: fg.buffer,
			ambiguous: ambiguous ? ambiguous.buffer : null,
			level,
			margin,
			width,
		},
		height,
		workers,
	);
	if (p === null) return null;
	await p;
	return { fg, ambiguous };
}

module.exports = {
	buildIntegralParallel,
	buildGrayTableParallel,
	dilateParallel,
	defectParallel,
	binarizeParallel,
	warpParallel,
	refineLocallyParallel,
	objectiveBatchParallel,
	rectifyParallel,
};

// The polish objective splits by *candidate*, not by rows, so the row-split
// threshold is the wrong economics: one candidate is a whole warp of the
// objective canvas, on the order of a millisecond, where one row is
// microseconds. Using MIN_PIXELS_TO_SPLIT here sent the entire polish
// serial for any golden past roughly 2.5:1 - a legitimate label shape - at
// the pattern search's full serial cost. 100k total pixels is ~10k per
// candidate on a 10-wide pinned batch, around half a millisecond each,
// which comfortably clears a dispatch.
const MIN_OBJECTIVE_PIXELS = 100000;

/**
 * Score a whole neighbourhood of candidate transforms at once, one
 * contiguous run of candidates per worker.
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
	// A single candidate is the polish's opening evaluation. Splitting one
	// warp across eight workers costs a dispatch to save nothing.
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

	// NaN, not zero. A score of 0 is "a perfect match" - it beats every
	// other candidate and passes the part - so a dispatch that silently
	// failed to write would steer the alignment rather than fail. Any
	// surviving NaN below is that bug, made loud.
	const scores = allocF64(n);
	scores.fill(NaN);

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
			scores: scores.buffer,
		},
		n,
		workers,
	);
	// getPool returns null on a host that resolves to one worker even though
	// the pixel gate passed - a 2-core machine, where defaultSize() is 1.
	// Without this the zero-filled scores would come back as a perfect match
	// for every candidate.
	if (p === null) return null;
	await p;

	const out = new Array(n);
	for (let i = 0; i < n; i++) {
		if (Number.isNaN(scores[i])) {
			throw new Error(
				`objective batch left candidate ${i} of ${n} unscored - a dispatch did not write its range`,
			);
		}
		out[i] = scores[i];
	}
	return out;
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
	// only the area-average path has a table to share; the bilinear path
	// reads the source directly and is rare here anyway
	if (!(mx > 1.001 || my > 1.001) || !table) return serial();

	const s = toShared(src);
	const integral = toShared(table.integral);
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
			sat: integral.buffer,
			satStride: table.stride,
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

/**
 * Per-tile refinement with both halves split: the field build over tile
 * rows, then - after a barrier, since the median filter reads the whole
 * field - the resampling over image rows.
 */
async function refineLocallyParallel(
	goldenGray,
	alignedTargetGray,
	width,
	height,
	cfg,
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
	const build = runRanges(
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
		},
		gridH,
		cfg.workers,
	);
	if (build === null) return null;
	await build;

	// small enough that splitting it would cost more than it saves
	const field = smoothField(raw);

	const out = allocU8(width * height);
	await runRanges(
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
		},
		height,
		cfg.workers,
	);
	return { gray: out, field, tile, stats: fieldStats(field) };
}
