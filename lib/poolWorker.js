/**
 * Worker side of the pool. Each kernel does the same arithmetic as its
 * serial twin, over a contiguous range of rows or columns.
 *
 * The serial implementations stay the reference: they are what the tests
 * assert against, and `test/parallel.test.js` asserts these produce
 * byte-identical output. Keep them in step - a divergence here shows up
 * as a defect that appears or vanishes depending on how many cores the
 * machine has, which is close to the worst bug this project could have.
 */

"use strict";

const { parentPort } = require("node:worker_threads");
const { slidingMax1D } = require("./dilate.js");
const { warpRows } = require("./warp.js");
const { scoreCandidate } = require("./align.js");
const { warpRows: rectifyRows } = require("./rectify.js");
const { fieldCells, applyCells } = require("./localAlign.js");
const { toneHistCells, toneCompareRows } = require("./toneRows.js");
const { diffRows, blockCountRows } = require("./diffRows.js");

const u8 = (b) => new Uint8Array(b);
const orNull = (b, Ctor) => (b ? new Ctor(b) : null);

/**
 * The tone comparison of one chunk of rows, for this worker: its defect
 * and speck counts in its own pair of `toneCounts` slots. The masks may
 * hold the last frame's pixels (lib/compare.js tonePrepare), so a chunk's
 * rows are cleared before they are compared.
 */
function toneCompareChunk(ctx, index) {
	// a block's count is a plain ++ from whichever worker has the row, so
	// a chunk must be whole rows of blocks (lib/compare.js rowChunk)
	if (ctx.blocks && ctx.chunk % ctx.blockSize !== 0) {
		throw new Error(`a chunk of ${ctx.chunk} rows splits the ${ctx.blockSize} px rows of blocks`);
	}
	const t = toneViews(ctx);
	const tally = new Uint32Array(ctx.toneCounts, index * 8, 2);
	const { width } = ctx;
	return (from, to) => {
		t.defect.fill(0, from * width, to * width);
		if (t.speck !== null) t.speck.fill(0, from * width, to * width);
		toneCompareRows(t, from, to, tally);
	};
}

/** A tone dispatch's buffers as the typed arrays lib/toneRows.js reads. */
function toneViews(ctx) {
	return {
		...ctx,
		classes: u8(ctx.classes),
		gray: u8(ctx.gray),
		histP: orNull(ctx.histP, Uint32Array),
		histK: orNull(ctx.histK, Uint32Array),
		darkest: ctx.darkest ? ctx.darkest.map(u8) : null,
		lightest: ctx.lightest ? ctx.lightest.map(u8) : null,
		tileLevel: orNull(ctx.tileLevel, Uint8Array),
		spans: orNull(ctx.spans, Float32Array),
		lo: orNull(ctx.lo, Int16Array),
		hi: orNull(ctx.hi, Int16Array),
		speckLo: orNull(ctx.speckLo, Int16Array),
		speckHi: orNull(ctx.speckHi, Int16Array),
		expected: orNull(ctx.expected, Float32Array),
		defect: orNull(ctx.defect, Uint8Array),
		speck: orNull(ctx.speck, Uint8Array),
		map: orNull(ctx.map, Uint8Array),
		rowSpecks: orNull(ctx.rowSpecks, Uint32Array),
		blocks: orNull(ctx.blocks, Uint32Array),
	};
}

/**
 * Run `fn(lo, hi)` over [0, ctx.total) a ctx.chunk at a time, each chunk
 * claimed off the dispatch's shared counter, until none is left: every
 * worker of the dispatch does the same, so the quick ones take the work a
 * paused one has not got to. The range the pool handed this worker only
 * says it takes part.
 */
function eachClaimed(ctx, fn) {
	const next = new Uint32Array(ctx.next);
	const { total, chunk } = ctx;
	for (let k = Atomics.add(next, 0, 1); k * chunk < total; k = Atomics.add(next, 0, 1)) {
		fn(k * chunk, Math.min(total, (k + 1) * chunk));
	}
}

let scratch = null;
function deque(n) {
	if (scratch === null || scratch.length < n) scratch = new Int32Array(n);
	return scratch;
}

// The objective's canvas, kept between dispatches: the polish sends one
// every round, a dozen or more a frame, all the same size.
const OBJECTIVE_BAND = 8;
let objCanvas = null;
function objectiveScratch(n) {
	if (objCanvas === null || objCanvas.length !== n) objCanvas = new Uint8Array(n);
	return objCanvas;
}

const kernels = {
	// perspective-rectify's warp, rows [lo, hi) of the output. The kernel
	// is the serial one, called on a range - no second implementation.
	rectify({ src, out, width, height, channels, inv }, lo, hi) {
		rectifyRows(
			new Uint8Array(src),
			width,
			height,
			channels,
			inv,
			new Uint8Array(out),
			lo,
			hi,
		);
	},
	// horizontal pass of the separable dilation: rows are independent
	dilateRows({ src, tmp, width, radius }, lo, hi) {
		const s = new Uint8Array(src);
		const t = new Uint8Array(tmp);
		const dq = deque(width);
		for (let y = lo; y < hi; y++) {
			const off = y * width;
			slidingMax1D(s, off, 1, width, radius, t, off, 1, dq);
		}
	},

	// Summed-area table, pass 1: each row's own prefix sum, rows
	// independent. The serial twin fuses this with the column
	// accumulation below, which is cache-friendly but carries a
	// dependency from one row to the next and so cannot be split.
	integralRows({ src, out, width, stride }, lo, hi) {
		const S = new Uint8Array(src);
		const O = new Uint32Array(out);
		for (let y = lo; y < hi; y++) {
			const srcRow = y * width;
			const intRow = (y + 1) * stride;
			let rowSum = 0;
			for (let x = 0; x < width; x++) {
				rowSum += S[srcRow + x];
				O[intRow + x + 1] = rowSum;
			}
		}
	},

	// Pass 2: accumulate each column downwards, columns independent.
	// `lo`/`hi` are a column range, but the loops are row-major inside it
	// so each worker walks a contiguous run of every row rather than
	// striding down memory - row y only needs row y-1, which the previous
	// iteration of this same loop already finished.
	integralCols({ out, height, stride }, lo, hi) {
		const O = new Uint32Array(out);
		for (let y = 0; y < height; y++) {
			const intRow = (y + 1) * stride;
			const intPrevRow = y * stride;
			for (let x = lo; x < hi; x++) {
				O[intRow + x + 1] += O[intPrevRow + x + 1];
			}
		}
	},

	// The grey twin of the two passes above. Float64 addition is not
	// associative in general, but every value here is an integer: greys
	// are 0-255 and the largest sum this canvas can reach is far below
	// 2^53, so each partial sum is exact and the split cannot change a
	// single bit - the same reasoning that made this table Float64 rather
	// than Uint32 in the first place.
	integralRows64({ src, out, width, stride }, lo, hi) {
		const S = new Uint8Array(src);
		const O = new Float64Array(out);
		for (let y = lo; y < hi; y++) {
			const srcRow = y * width;
			const intRow = (y + 1) * stride;
			let rowSum = 0;
			for (let x = 0; x < width; x++) {
				rowSum += S[srcRow + x];
				O[intRow + x + 1] = rowSum;
			}
		}
	},

	integralCols64({ out, height, stride }, lo, hi) {
		const O = new Float64Array(out);
		for (let y = 0; y < height; y++) {
			const intRow = (y + 1) * stride;
			const intPrevRow = y * stride;
			for (let x = lo; x < hi; x++) {
				O[intRow + x + 1] += O[intPrevRow + x + 1];
			}
		}
	},

	// vertical pass: columns are independent
	dilateCols({ tmp, out, width, height, radius }, lo, hi) {
		const t = new Uint8Array(tmp);
		const o = new Uint8Array(out);
		const dq = deque(height);
		for (let x = lo; x < hi; x++) {
			slidingMax1D(t, x, width, height, radius, o, x, width, dq);
		}
	},

	// defect = a AND NOT b, then cleared where either image was ambiguous
	defect({ a, b, ambiguousA, ambiguousB, out, counts, width }, lo, hi, index) {
		const A = new Uint8Array(a);
		const B = new Uint8Array(b);
		const O = new Uint8Array(out);
		const C = new Uint32Array(counts);
		const ambA = ambiguousA ? new Uint8Array(ambiguousA) : null;
		const ambB = ambiguousB ? new Uint8Array(ambiguousB) : null;
		let count = 0;
		for (let y = lo; y < hi; y++) {
			const row = y * width;
			for (let x = 0; x < width; x++) {
				const i = row + x;
				let d = A[i] & ~B[i] & 1;
				if (d && ((ambA !== null && ambA[i]) || (ambB !== null && ambB[i]))) d = 0;
				O[i] = d;
				count += d;
			}
		}
		// one slot per worker, summed by the caller - avoids an atomic in
		// the inner loop for a number only needed once at the end
		C[index] = count;
	},

	// resample the frame into golden's grid - rows are independent
	warp(
		{ src, out, srcW, srcH, mx, my, theta, ox, oy, outW, sat, satStride },
		lo,
		hi,
	) {
		// the grey summed-area table is Float64 (see buildGrayTable - a
		// Uint32 table wraps on large frames); keep this in step with the
		// serial path or the two stop being byte-identical
		const table = sat
			? {
					integral: new Float64Array(sat),
					stride: satStride,
					width: srcW,
					height: srcH,
				}
			: null;
		warpRows(
			new Uint8Array(out),
			new Uint8Array(src),
			srcW,
			srcH,
			mx,
			my,
			theta,
			ox,
			oy,
			outW,
			table,
			lo,
			hi,
		);
	},

	// per-tile displacement, tiles a claimed chunk at a time
	localField(ctx) {
		const { golden, target, fx, fy, valid, width, height, gridW, tile, maxOffset, minStdDev, searchable } = ctx;
		const g = u8(golden);
		const t = u8(target);
		const opts = { tile, maxOffset, minStdDev, searchable: u8(searchable) };
		const out = { fx: new Float32Array(fx), fy: new Float32Array(fy), valid: u8(valid), gridW };
		eachClaimed(ctx, (lo, hi) => fieldCells(g, t, width, height, opts, out, lo, hi));
	},

	// resample under the displacement field, cells a claimed chunk at a
	// time; the grey histogram, when asked for, in this worker's own bins
	localApply(ctx, lo, hi, index) {
		const { target, out, fx, fy, width, height, gridW, gridH, tile, cell, cellsW } = ctx;
		const counted = ctx.grey !== null || ctx.classes !== null;
		const t = {
			out: u8(out),
			target: u8(target),
			width,
			height,
			field: { fx: new Float32Array(fx), fy: new Float32Array(fy), gridW, gridH },
			tile,
			cell,
			cellsW,
			counts: counted
				? {
						grey: ctx.grey ? new Uint32Array(ctx.grey, index * 1024, 256) : null,
						classes: orNull(ctx.classes, Uint8Array),
						histP: orNull(ctx.histP, Uint32Array),
						histK: orNull(ctx.histK, Uint32Array),
						paperBit: ctx.paperBit,
						inkBit: ctx.inkBit,
						cell,
						cellsW,
					}
				: null,
		};
		eachClaimed(ctx, (from, to) => applyCells(t, from, to));
	},

	// Score a whole batch of candidate transforms for the alignment polish,
	// over output rows [lo, hi) of the objective canvas: every worker takes
	// every candidate, on its own band of rows, and counts each candidate's
	// disagreeing pixels there. The caller sums the bands.
	//
	// By rows, not by candidate, because the warp is bound by memory, not
	// arithmetic. Every candidate reads the frame's whole Float64 grey
	// table - 24 MB on the rig's canvas - and the candidates in a batch are
	// sub-pixel apart, so they read nearly the same bytes. One candidate per
	// worker sent ten copies of that table through memory at once and a
	// batch took twice as long as one candidate alone; a band of rows taken
	// candidate after candidate reads its strip of the table once and then
	// from cache. OBJECTIVE_BAND rows keeps the strip in a core's own cache
	// at the rig's ~4x footprint.
	//
	// It has to reproduce warpGray + the serial scorer *exactly*, not
	// closely: these numbers are compared against each other to choose a
	// transform, so a last-bit difference that depended on how the batch
	// was split would make the chosen alignment a function of the machine's
	// core count. Hence the same fill of 255, the same mx/my > 1.001 test
	// for the area-average path, and warpRows itself rather than a copy.
	// Rows are independent in warpRows, and a count summed over bands is
	// the count over the canvas - integers, so the sum is exact.
	objective(
		{
			gray,
			fgObj,
			sat,
			satStride,
			srcW,
			srcH,
			outW,
			outH,
			level,
			params,
			counts,
			rows,
			slots,
		},
		lo,
		hi,
		index,
	) {
		const src = new Uint8Array(gray);
		const fg = new Uint8Array(fgObj);
		const p = new Float64Array(params);
		const n = p.length / 5;
		const table = {
			integral: new Float64Array(sat),
			stride: satStride,
			width: srcW,
			height: srcH,
		};
		const out = objectiveScratch(outW * outH);
		const mismatch = new Float64Array(n);
		for (let band = lo; band < hi; band += OBJECTIVE_BAND) {
			const bandEnd = band + OBJECTIVE_BAND < hi ? band + OBJECTIVE_BAND : hi;
			const from = band * outW;
			const to = bandEnd * outW;
			for (let c = 0; c < n; c++) {
				const mx = p[c * 5];
				const my = p[c * 5 + 1];
				// warpGray fills a fresh canvas before warping; refilling
				// this band of the scratch is the same thing for these rows
				out.fill(255, from, to);
				warpRows(
					out,
					src,
					srcW,
					srcH,
					mx,
					my,
					p[c * 5 + 2],
					p[c * 5 + 3],
					p[c * 5 + 4],
					outW,
					mx > 1.001 || my > 1.001 ? table : null,
					band,
					bandEnd,
				);
				let m = 0;
				for (let i = from; i < to; i++) {
					if ((out[i] < level ? 1 : 0) !== fg[i]) m++;
				}
				mismatch[c] += m;
			}
		}
		const C = new Uint32Array(counts);
		for (let c = 0; c < n; c++) C[c * slots + index] = mismatch[c];
		// how many rows this worker covered, so the caller can tell a band
		// that was never scored from a band with nothing wrong in it
		new Uint32Array(rows)[index] = hi - lo;
	},

	// The transform search's density score for candidates [lo, hi) - the
	// serial scoreCandidate itself, over the same golden lattice and the
	// same frame summed-area table, so a score cannot depend on which
	// thread computed it.
	density(
		{
			density,
			centerX,
			centerY,
			gridW,
			gridH,
			cellW,
			cellH,
			integral,
			stride,
			tW,
			tH,
			params,
			scores,
		},
		lo,
		hi,
	) {
		const sig = {
			density: new Float32Array(density),
			centerX: new Float32Array(centerX),
			centerY: new Float32Array(centerY),
			gridW,
			gridH,
			cellW,
			cellH,
		};
		const table = { integral: new Uint32Array(integral), stride };
		const p = new Float64Array(params);
		const out = new Float64Array(scores);
		for (let c = lo; c < hi; c++) {
			const k = c * 5;
			out[c] = scoreCandidate(sig, table, tW, tH, p[k], p[k + 1], p[k + 2], p[k + 3], p[k + 4]);
		}
	},

	// the tone check's histogram pass, whole cells a claimed chunk at a time
	toneHist(ctx) {
		const t = toneViews(ctx);
		eachClaimed(ctx, (lo, hi) => toneHistCells(t, lo, hi));
	},

	// the tone check's comparison, rows a claimed chunk at a time; the
	// defect and speck counts go in this worker's own pair of slots
	toneCompare(ctx, lo, hi, index) {
		const compare = toneCompareChunk(ctx, index);
		eachClaimed(ctx, compare);
	},

	// grey -> ink mask against one global level, plus the ambiguity band,
	// rows a claimed chunk at a time; with a golden mask, also this
	// worker's [golden ink, of it covered, pixels that disagree] in its own
	// three slots. With the tone check's buffers (`toneCounts`, from
	// lib/compare.js toneRide), each chunk's tone comparison too: the same
	// rows, so one dispatch where there were two.
	binarize(ctx, lo, hi, index) {
		const { gray, fg, ambiguous, level, margin, width, golden, counts } = ctx;
		const G = new Uint8Array(gray);
		const F = new Uint8Array(fg);
		const A = ambiguous ? new Uint8Array(ambiguous) : null;
		const R = golden ? new Uint8Array(golden) : null;
		const floor = level - margin;
		const ceil = level + margin;
		const tone = ctx.toneCounts ? toneCompareChunk(ctx, index) : null;
		let ink = 0;
		let covered = 0;
		let mismatch = 0;
		eachClaimed(ctx, (from, to) => {
			for (let y = from; y < to; y++) {
				const row = y * width;
				for (let x = 0; x < width; x++) {
					const i = row + x;
					const v = G[i];
					F[i] = v < level ? 1 : 0;
					if (A !== null) A[i] = v >= floor && v <= ceil ? 1 : 0;
				}
			}
			if (R !== null) {
				for (let i = from * width; i < to * width; i++) {
					const g = R[i];
					const f = F[i];
					ink += g;
					covered += g & f;
					if (f !== g) mismatch++;
				}
			}
			if (tone !== null) tone(from, to);
		});
		if (R === null) return;
		const C = new Uint32Array(counts, index * 12, 3);
		C[0] = ink;
		C[1] = covered;
		C[2] = mismatch;
	},

	// a 256-bin grey histogram of rows [lo, hi), in this worker's own bins
	histogram({ gray, hist, width }, lo, hi, index) {
		const G = new Uint8Array(gray);
		const H = new Uint32Array(hist, index * 1024, 256);
		for (let i = lo * width; i < hi * width; i++) H[G[i]]++;
	},

	// both binary blemish checks over block rows [lo, hi): see lib/diffRows.js
	// - block rows a claimed chunk at a time, each chunk dilating its own
	// halo, and this worker's two counts summed over its chunks
	diff(ctx, lo, hi, index) {
		const tally = [0, 0];
		const t = diffViews(ctx);
		eachClaimed(ctx, (from, to) => diffRows(t, from, to, tally, diffScratch));
		const C = new Uint32Array(ctx.counts, index * 8, 2);
		C[0] = tally[0];
		C[1] = tally[1];
	},

	// set pixels per block of a 0/1 mask, block rows [lo, hi)
	blockCounts({ mask, out, width, height, blockSize }, lo, hi) {
		blockCountRows(new Uint8Array(mask), width, height, blockSize, new Uint32Array(out), lo, hi);
	},

	// the overlay's canvas: grey -> RGB, pixels a claimed chunk at a time,
	// into a spare shared canvas (lib/compare.js expandGray)
	expandGray(ctx) {
		const G = u8(ctx.gray);
		const rgb = u8(ctx.rgb);
		eachClaimed(ctx, (from, to) => {
			for (let i = from, o = from * 3; i < to; i++, o += 3) {
				const g = G[i];
				rgb[o] = g;
				rgb[o + 1] = g;
				rgb[o + 2] = g;
			}
		});
	},

	// The same into a new canvas of this worker's own, moved back to the
	// caller (lib/pool.js runOne, on the worker beside the pool): one that
	// leaves with the message, so neither a spare nor shared memory - a
	// new shared buffer every frame was 9.4 MB more for every worker to
	// collect (noteBytes below), and cost the alignment of the frames
	// after it more than it saved. The fresh pages are this worker's to
	// touch, not the inspector thread's.
	expandGrayOwn({ gray, n }) {
		const G = u8(gray);
		const store = new ArrayBuffer(n * 3);
		const rgb = new Uint8Array(store);
		for (let i = 0, o = 0; i < n; i++, o += 3) {
			const g = G[i];
			rgb[o] = g;
			rgb[o + 1] = g;
			rgb[o + 2] = g;
		}
		return { value: store, transfer: [store] };
	},
};

// What a dispatch runs: these, with the native twins of five of them in
// place when the addon loads in this worker - the same bytes, faster
// (lib/nativeKernels.js). The JS above stays the reference and runs
// wherever the addon does not.
const run = require("./nativeKernels.js").withNative(kernels);

// the diff kernel's horizontal rows and column counts, kept between frames
const diffScratch = { rows: new Uint8Array(0), cols: new Int32Array(0) };

/** A diff dispatch's buffers as the typed arrays lib/diffRows.js reads. */
function diffViews(ctx) {
	return {
		...ctx,
		targetFg: u8(ctx.targetFg),
		goldenFg: u8(ctx.goldenFg),
		goldenFgDilatedBackground: u8(ctx.goldenFgDilatedBackground),
		goldenAmbiguous: orNull(ctx.goldenAmbiguous, Uint8Array),
		targetAmbiguous: orNull(ctx.targetAmbiguous, Uint8Array),
		dilated: orNull(ctx.dilated, Uint8Array),
		printDefect: u8(ctx.printDefect),
		backgroundDefect: u8(ctx.backgroundDefect),
		printBlocks: new Uint32Array(ctx.printBlocks),
		backgroundBlocks: new Uint32Array(ctx.backgroundBlocks),
	};
}

// A shared buffer is freed only once every isolate that viewed it has let
// go, and nothing makes a pool worker's collector run: the view is a few
// bytes on a heap of a few megabytes, and the megabytes it points at are
// not charged to this isolate (the measurements are in lib/shared.js). So
// each worker counts the shared bytes its dispatches bring and collects
// once GC_EVERY_BYTES have gone past.
//
// When, matters. A dispatch ends at a barrier - the frame waits for the
// slowest worker - so a pause taken in the message handler (4-13 ms, a
// full collection of a small heap) lands on the frame: at 4096 px,
// where one objective round ships 124 MB and the polish runs fifteen of
// them, collecting in the handler every interval was three collections
// per worker per frame and 12-18% of frame time. So a worker collects
// when it has had no message for GC_IDLE_MS once GC_IDLE_BYTES have
// passed - between frames, or in any longer gap inside one - and in the
// handler only when a frame has run it past the interval without one,
// which at 4096 px a frame still does once or twice. The count is of
// buffers this worker sees for the first time, which the pool works out
// on its side, where a buffer keeps its identity (lib/pool.js newBytesFor).
//
// Frames sent back to back have no idle gap between them, only inside
// them, so a collection lands in a frame whichever way it is timed, and
// costs it 5-10 ms alone but 90 ms when every worker collects at once,
// which they did: each is shown the same buffers, so all crossed the
// interval in the same frame. Each starts at its own point of the
// interval instead (lib/pool.js gcPhase), so about one collects in a
// frame: good frames on the rig (12 workers, 9 MB of new buffers a
// frame, mostly the rectified frame) at p95 119 ms against ~175. The
// interval is half GC_EVERY_BYTES, not a quarter: half the collections,
// for some 80 MB more held (RSS flat at ~820 MB over 970 frames, against
// ~740).
const { workerData } = require("node:worker_threads");
const { collectGarbage, GC_EVERY_BYTES } = require("./shared.js");
const GC_IDLE_MS = 20;
const GC_IDLE_BYTES = GC_EVERY_BYTES / 2;
let bytesSinceGc = ((workerData && workerData.gcPhase) || 0) * GC_IDLE_BYTES;
let idleTimer = null;

function collectNow() {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	bytesSinceGc = 0;
	collectGarbage();
}

function noteBytes(bytes) {
	bytesSinceGc += bytes;
	if (bytesSinceGc >= GC_EVERY_BYTES) {
		collectNow();
		return;
	}
	if (idleTimer !== null) clearTimeout(idleTimer);
	idleTimer = null;
	if (bytesSinceGc >= GC_IDLE_BYTES) idleTimer = setTimeout(collectNow, GC_IDLE_MS);
}

// Every reply carries the id of the dispatch it answers. The pool used to
// settle a dispatch on the next message from its worker, whichever dispatch
// that message actually belonged to - see lib/pool.js.
// (no parentPort when a test requires this file for its kernels)
if (parentPort) {
	parentPort.on("message", ({ kernel, ctx, lo, hi, index, id, newBytes }) => {
		try {
			// a kernel returns nothing, or a value and the stores to move
			const out = run[kernel](ctx, lo, hi, index);
			if (out) parentPort.postMessage({ id, value: out.value }, out.transfer);
			else parentPort.postMessage({ id });
		} catch (err) {
			parentPort.postMessage({ id, error: `${kernel}: ${err.message}` });
		}
		noteBytes(newBytes || 0);
	});
}

module.exports = { kernels, run };
