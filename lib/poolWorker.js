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
const { warpRows: rectifyRows } = require("./rectify.js");
const { fieldRows, applyRows } = require("./localAlign.js");

let scratch = null;
function deque(n) {
	if (scratch === null || scratch.length < n) scratch = new Int32Array(n);
	return scratch;
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

	// per-tile displacement - tile rows are independent
	localField(
		{
			golden,
			target,
			fx,
			fy,
			valid,
			width,
			height,
			gridW,
			tile,
			maxOffset,
			minStdDev,
		},
		lo,
		hi,
	) {
		fieldRows(
			new Uint8Array(golden),
			new Uint8Array(target),
			width,
			height,
			{ tile, maxOffset, minStdDev },
			{
				fx: new Float32Array(fx),
				fy: new Float32Array(fy),
				valid: new Uint8Array(valid),
				gridW,
			},
			lo,
			hi,
		);
	},

	// resample under the displacement field - rows are independent
	localApply(
		{ target, out, fx, fy, width, height, gridW, gridH, tile },
		lo,
		hi,
	) {
		applyRows(
			new Uint8Array(out),
			new Uint8Array(target),
			width,
			height,
			{ fx: new Float32Array(fx), fy: new Float32Array(fy), gridW, gridH },
			tile,
			lo,
			hi,
		);
	},

	// Score a contiguous run of candidate transforms for the alignment
	// polish - candidates are independent, so this splits by candidate
	// rather than by rows.
	//
	// It has to reproduce warpGray + the serial scorer *exactly*, not
	// closely: these numbers are compared against each other to choose a
	// transform, so a last-bit difference that depended on how the batch
	// was split would make the chosen alignment a function of the machine's
	// core count. Hence the same fill of 255, the same mx/my > 1.001 test
	// for the area-average path, and warpRows itself rather than a copy.
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
			scores,
		},
		lo,
		hi,
	) {
		const src = new Uint8Array(gray);
		const fg = new Uint8Array(fgObj);
		const p = new Float64Array(params);
		const outScores = new Float64Array(scores);
		const table = {
			integral: new Float64Array(sat),
			stride: satStride,
			width: srcW,
			height: srcH,
		};
		// one scratch canvas for this worker's whole run of candidates
		const out = new Uint8Array(outW * outH);
		for (let c = lo; c < hi; c++) {
			const mx = p[c * 5];
			const my = p[c * 5 + 1];
			const theta = p[c * 5 + 2];
			const ox = p[c * 5 + 3];
			const oy = p[c * 5 + 4];
			// warpGray allocates a fresh canvas and fills it before warping;
			// refilling the scratch is the same thing without the allocation
			out.fill(255);
			warpRows(
				out,
				src,
				srcW,
				srcH,
				mx,
				my,
				theta,
				ox,
				oy,
				outW,
				mx > 1.001 || my > 1.001 ? table : null,
				0,
				outH,
			);
			let mismatch = 0;
			for (let i = 0; i < out.length; i++) {
				if ((out[i] < level ? 1 : 0) !== fg[i]) mismatch++;
			}
			outScores[c] = mismatch / out.length;
		}
	},

	// grey -> ink mask against one global level, plus the ambiguity band
	binarize({ gray, fg, ambiguous, level, margin, width }, lo, hi) {
		const G = new Uint8Array(gray);
		const F = new Uint8Array(fg);
		const A = ambiguous ? new Uint8Array(ambiguous) : null;
		const floor = level - margin;
		const ceil = level + margin;
		for (let y = lo; y < hi; y++) {
			const row = y * width;
			for (let x = 0; x < width; x++) {
				const i = row + x;
				const v = G[i];
				F[i] = v < level ? 1 : 0;
				if (A !== null) A[i] = v >= floor && v <= ceil ? 1 : 0;
			}
		}
	},
};

// Every reply carries the id of the dispatch it answers. The pool used to
// settle a dispatch on the next message from its worker, whichever dispatch
// that message actually belonged to - see lib/pool.js.
parentPort.on("message", ({ kernel, ctx, lo, hi, index, id }) => {
	try {
		kernels[kernel](ctx, lo, hi, index);
		parentPort.postMessage({ id });
	} catch (err) {
		parentPort.postMessage({ id, error: `${kernel}: ${err.message}` });
	}
});
