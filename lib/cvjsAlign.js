/**
 * PROTOTYPE: imageAlign for the WASM engine (see lib/cvjs.js).
 *
 * lib/cvAlign.js calls the engine's imageAlign to solve the
 * frame-to-golden affine and hand back the already-warped, golden-sized
 * grayscale frame. This is the same op on opencv.js: ORB features for the
 * gross solve, ECC for the refinement, one warp for the output.
 *
 * The contract cvAlign decodes against, and which this reproduces:
 *
 *  - the target is first normalised to the reference's dimensions, and
 *    `matrix2x3` maps REFERENCE coordinates into that normalised target
 *    (cvAlign.decodeTransform scales each row by tW/gW and tH/gH to get
 *    back into the target's own working canvas);
 *  - the returned image is the target resampled into the reference frame,
 *    always reference-sized and single-channel.
 *
 * DIVERGES: the warp fills uncovered pixels with 255, not 0.
 *
 * The opencv5 engine has no border-value parameter and fills with 0, the
 * darkest possible ink, so cvAlign.blankOutsideSource walks the result
 * and rewrites every pixel whose source coordinate fell outside the frame
 * back to 255 - blank substrate, the same convention lib/warp.js uses,
 * because "no ink here" is a print defect the frame really does show,
 * while a solid bar of ink is a background defect it does not.
 *
 * That rewrite cannot reach the pixels one step INSIDE the boundary: they
 * are covered, so they keep their value, and bilinear interpolation has
 * already mixed that value with the black fill next door. The result is a
 * dark rim exactly one pixel wide. On a 512x640 synthetic shifted by 6px it
 * is enough to flag a background block (0.24% defect ratio, over the 0.2%
 * failRatio) and fail a frame the JS aligner passes.
 *
 * Filling with 255 removes the rim - the ramp now runs toward blank
 * substrate - and makes blankOutsideSource's rewrite a no-op rather than a
 * patch. It is a real difference from the opencv5 engine, in the direction
 * this codebase already calls correct.
 */

"use strict";

const { performance } = require("node:perf_hooks");

const cvjs = require("./cvjs.js");
const limits = require("./engineLimits.js");
const { scope, toGrayMat, fromMat, timing, deliver, asError } = cvjs._internals;

// Enough correspondences to fit 6 affine parameters with margin; below this
// the solve is noise.
const MIN_MATCHES = 8;
// Cap on the correspondences handed to RANSAC - ORB on a 2600px label can
// return thousands and the tail is all noise.
const MAX_MATCHES = 400;
const ORB_FEATURES = 2000;

const MOTION = {
	translation: "MOTION_TRANSLATION",
	euclidean: "MOTION_EUCLIDEAN",
	affine: "MOTION_AFFINE",
};

function resized(cv, s, mat, width, height) {
	if (mat.cols === width && mat.rows === height) return mat;
	const out = s.keep(new cv.Mat());
	// INTER_LINEAR, matching both the opencv5 engine and lib/cvjs.js resize
	cv.resize(mat, out, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
	return out;
}

/**
 * ORB + crosschecked Hamming matching + RANSAC affine. Returns the 6
 * matrix values (reference -> target, in the coordinates of the images it
 * was given) or null when the pair does not produce a usable solve.
 */
function solveByFeatures(cv, s, refMat, targetMat) {
	let orb;
	let matcher;
	try {
		orb = new cv.ORB(ORB_FEATURES);
		const kpRef = s.keep(new cv.KeyPointVector());
		const kpTarget = s.keep(new cv.KeyPointVector());
		const descRef = s.keep(new cv.Mat());
		const descTarget = s.keep(new cv.Mat());
		const noMask = s.keep(new cv.Mat());
		orb.detectAndCompute(refMat, noMask, kpRef, descRef);
		orb.detectAndCompute(targetMat, noMask, kpTarget, descTarget);
		if (descRef.rows < MIN_MATCHES || descTarget.rows < MIN_MATCHES) return null;

		matcher = new cv.BFMatcher(cv.NORM_HAMMING, true);
		const matches = s.keep(new cv.DMatchVector());
		matcher.match(descRef, descTarget, matches);
		const total = matches.size();
		if (total < MIN_MATCHES) return null;

		const pairs = [];
		for (let i = 0; i < total; i++) {
			const m = matches.get(i);
			pairs.push({ q: m.queryIdx, t: m.trainIdx, d: m.distance });
		}
		// Best-first, then keep the strongest slice: RANSAC copes with
		// outliers but not with a majority of them.
		pairs.sort((a, b) => a.d - b.d);
		const kept = pairs.slice(0, Math.min(MAX_MATCHES, pairs.length));
		const from = [];
		const to = [];
		for (const pair of kept) {
			const p = kpRef.get(pair.q).pt;
			const q = kpTarget.get(pair.t).pt;
			from.push(p.x, p.y);
			to.push(q.x, q.y);
		}
		const fromMatPts = s.keep(cv.matFromArray(kept.length, 1, cv.CV_32FC2, from));
		const toMatPts = s.keep(cv.matFromArray(kept.length, 1, cv.CV_32FC2, to));
		const inliers = s.keep(new cv.Mat());
		const affine = s.keep(
			cv.estimateAffine2D(fromMatPts, toMatPts, inliers, cv.RANSAC, 3, 2000, 0.99, 10),
		);
		if (!affine || affine.rows !== 2 || affine.cols !== 3) return null;
		const m = Array.from(affine.data64F.subarray(0, 6));
		return m.every(Number.isFinite) ? m : null;
	} finally {
		if (orb) orb.delete();
		if (matcher) matcher.delete();
	}
}

/**
 * ECC refinement in place. `seed` is the feature solve (or null for a cold
 * identity start). Returns the refined 6 values, or null when ECC does not
 * converge - which it signals by throwing, not by a return code.
 */
function refineByEcc(cv, s, refMat, targetMat, seed, motionType, iterations, epsilon) {
	const warp = s.keep(
		cv.matFromArray(
			2,
			3,
			cv.CV_32F,
			seed ? seed.map(Number) : [1, 0, 0, 0, 1, 0],
		),
	);
	const eps = cv.TermCriteria_EPS ?? cv.TERM_CRITERIA_EPS;
	const count = cv.TermCriteria_COUNT ?? cv.TERM_CRITERIA_COUNT;
	const criteria = new cv.TermCriteria(eps | count, iterations, epsilon);
	const noMask = s.keep(new cv.Mat());
	try {
		cv.findTransformECC(refMat, targetMat, warp, motionType, criteria, noMask, 5);
	} catch {
		// Non-convergence, a degenerate patch, or a seed too far off: the
		// caller keeps whatever the feature stage found.
		return null;
	}
	const m = Array.from(warp.data32F.subarray(0, 6));
	return m.every(Number.isFinite) ? m : null;
}

/**
 * imageAlign(reference, target, scale, iterations, epsilon, [fmt], [quality],
 *            [pngOptimize], [returnImage], [mask], [motion], [method],
 *            [eccRefine], [detector]) -> {success, transformMatrix, image, timing}
 *
 * Argument positions follow the opencv5 engine exactly, because
 * lib/cvAlign.js passes all fourteen positionally. What it refuses is
 * what opencv5 refuses (lib/engineLimits.js): affine, features+ecc, orb
 * and no polygon only; grey images; `scale` in (0, 1] with an alignment
 * copy of at least 32 px a side; 1-500 `iterations`; a positive
 * `epsilon`. cvAlign catches a refusal and keeps its JS alignment.
 */
async function imageAlign(
	reference,
	target,
	scale,
	iterations,
	epsilon,
	fmt,
	quality,
	pngOptimize,
	returnImage,
	mask,
	motion,
	method,
	eccRefine,
	detector,
) {
	const t0 = performance.now();
	const cv = await cvjs.ready();
	const ref = limits.describeRaw(reference);
	const tgt = limits.describeRaw(target);
	// ECC's iterations are capped at 500 as in opencv5: here a huge count
	// would hold the event loop (this engine is single-threaded) for minutes
	const { s: solveScale, its: iters, eps } = limits.alignArgs(
		ref, tgt, scale, iterations, epsilon, mask, motion, method, detector,
	);
	const motionType = cv[MOTION.affine];
	const alwaysEcc = String(eccRefine || "auto").toLowerCase() === "always";

	const s = scope();
	try {
		const refFull = toGrayMat(cv, s, ref);
		const targetGray = toGrayMat(cv, s, tgt);
		const gW = refFull.cols;
		const gH = refFull.rows;
		// imageAlign's contract normalises the target onto the reference
		// canvas before solving; the returned matrix lives in those
		// coordinates.
		const targetFull = resized(cv, s, targetGray, gW, gH);

		const solveW = Math.round(gW * solveScale);
		const solveH = Math.round(gH * solveScale);
		const refSolve = resized(cv, s, refFull, solveW, solveH);
		const targetSolve = resized(cv, s, targetFull, solveW, solveH);

		let m = solveByFeatures(cv, s, refSolve, targetSolve);
		if (m || alwaysEcc) {
			const refined = refineByEcc(
				cv,
				s,
				refSolve,
				targetSolve,
				m,
				motionType,
				iters,
				eps,
			);
			if (refined) m = refined;
		}
		if (!m) {
			return {
				success: false,
				transformMatrix: null,
				image: null,
				timing: timing(t0, "imageAlign"),
			};
		}

		// Solved on a copy scaled by S = diag(sx, sy) about the origin, so
		// the full-size transform is S^-1 A S for the linear part and
		// S^-1 t for the translation. The off-diagonal terms only survive
		// that when sx != sy, which rounding to whole pixels can produce.
		const sx = solveW / gW;
		const sy = solveH / gH;
		const matrix = [
			m[0],
			m[1] * (sy / sx),
			m[2] / sx,
			m[3] * (sx / sy),
			m[4],
			m[5] / sy,
		];

		let image = null;
		if (returnImage !== false) {
			const warpMat = s.keep(cv.matFromArray(2, 3, cv.CV_64F, matrix));
			const aligned = s.keep(new cv.Mat());
			// WARP_INVERSE_MAP because `matrix` maps reference -> target and
			// this samples the target at each reference pixel. The 255 fill
			// is deliberate - see DIVERGES in the file header.
			cv.warpAffine(
				targetFull,
				aligned,
				warpMat,
				new cv.Size(gW, gH),
				cv.INTER_LINEAR | cv.WARP_INVERSE_MAP,
				cv.BORDER_CONSTANT,
				new cv.Scalar(255, 255, 255, 255),
			);
			image = await deliver(fromMat(cv, aligned, "GRAY"), fmt, quality, pngOptimize);
		}

		return {
			success: true,
			transformMatrix: { matrix2x3: matrix },
			image,
			timing: { ...timing(t0, "imageAlign"), scale: solveScale },
		};
	} catch (err) {
		throw asError(cv, err);
	} finally {
		s.free();
	}
}

module.exports = { imageAlign };
