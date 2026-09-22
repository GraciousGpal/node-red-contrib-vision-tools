/**
 * Recovering the transform that places the golden template inside a
 * camera frame: independent x/y magnification, rotation, translation.
 *
 * The original node searched translation only, which assumes the golden
 * and the frame already share a pixel scale and orientation. That holds
 * for a re-trained golden off the same fixtured rig and nothing else.
 * This node's actual job is comparing a *PDF of a label* against a
 * photograph of that label printed, where the artwork has no reason to
 * match the camera's px-per-mm at all.
 *
 * Scale has to be anisotropic, which is the part that is easy to get
 * wrong. Measured on the real pairs here, the print comes out ~4% longer
 * than the artwork along one axis with the other axis correct - ordinary
 * behaviour for a press whose media feed and print-head axes are not
 * calibrated to each other. A single isotropic scale cannot represent
 * that: the best it can do is split the error, leaving every feature
 * several pixels out toward the ends of the long axis. On body text
 * several pixels is the whole stroke, so ~12% of all pixels disagree and
 * both blemish checks fail on a perfectly good part. Independent mx and
 * my remove it.
 *
 * The model, mapping a golden-working-resolution pixel (gx,gy) into the
 * frame's working canvas - scale first, then rotate, then translate:
 *
 *   target_x = ox + cos(theta)*mx*gx - sin(theta)*my*gy
 *   target_y = oy + sin(theta)*mx*gx + cos(theta)*my*gy
 *
 * mx/my are "frame px per golden px"; greater than 1 means the frame
 * resolves the part more finely than the golden does.
 *
 * Scoring is mean absolute difference of *ink density*, sampled on a
 * lattice of cells: each golden cell has a precomputed density, and the
 * matching frame density is a box average read in O(1) from a summed-area
 * table over the frame's foreground mask. One candidate therefore costs
 * (number of grid cells), independent of either image's resolution -
 * which is what makes sweeping whole ladders of scale affordable.
 *
 * Small angles are handled by mapping each cell's *center* through the
 * rotation and reading an axis-aligned box there, rather than summing a
 * true rotated rectangle. Over the few degrees this covers it is the
 * cell-center displacement that carries the signal, the shape error
 * within a cell is negligible, and every read stays O(1).
 *
 * The search runs coarse-to-fine, each stage refining only within a
 * bounded neighbourhood of the previous stage's winner:
 *
 *   1. scale sweep  - wide ladder of isotropic scale, no rotation, coarse
 *                     grid, full translation range over the whole frame
 *   2. joint refine - overall scale, stretch and angle together on a
 *                     medium grid, translation bounded to a few cells
 *                     around stage 1. Stretch has to be searched here,
 *                     jointly - see the note in findTransform
 *   3. fine refine  - the fine grid, each axis nudged independently,
 *                     ending in a single-pixel translation sweep
 *   4. polish       - alternating sub-percent refinement of mx, my, angle
 *                     and translation against real pixel disagreement
 */

"use strict";

const { buildIntegral } = require("./integral.js");

const DEG = Math.PI / 180;

/**
 * Precompute golden's ink density on a gridW x gridH lattice, plus each
 * cell's center in golden pixel coordinates - the fixed side of every
 * candidate comparison.
 */
function buildGoldenSignature(fg, width, height, gridW, gridH) {
	const table = buildIntegral(fg, width, height);
	const { integral, stride } = table;
	const density = new Float32Array(gridW * gridH);
	const centerX = new Float32Array(gridW);
	const centerY = new Float32Array(gridH);
	for (let gy = 0; gy < gridH; gy++) {
		const y0 = Math.floor((gy * height) / gridH);
		const y1 = Math.floor(((gy + 1) * height) / gridH);
		centerY[gy] = (y0 + y1) / 2;
		for (let gx = 0; gx < gridW; gx++) {
			const x0 = Math.floor((gx * width) / gridW);
			const x1 = Math.floor(((gx + 1) * width) / gridW);
			if (gy === 0) centerX[gx] = (x0 + x1) / 2;
			const area = (x1 - x0) * (y1 - y0);
			const sum =
				integral[y1 * stride + x1] -
				integral[y0 * stride + x1] -
				integral[y1 * stride + x0] +
				integral[y0 * stride + x0];
			density[gy * gridW + gx] = area > 0 ? sum / area : 0;
		}
	}
	return {
		density,
		centerX,
		centerY,
		gridW,
		gridH,
		cellW: width / gridW,
		cellH: height / gridH,
		width,
		height,
	};
}

/**
 * Mean absolute density difference between the golden signature and the
 * frame under one candidate transform. Cells landing outside the frame
 * are skipped, and a candidate that pushes too much of the template
 * off-frame is rejected outright - otherwise a transform that hangs the
 * template over the edge could "win" on a handful of conveniently
 * matching cells.
 */
function scoreCandidate(sig, targetTable, tW, tH, mx, my, theta, ox, oy) {
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const halfW = (mx * sig.cellW) / 2;
	const halfH = (my * sig.cellH) / 2;
	const { density, centerX, centerY, gridW, gridH } = sig;
	// This is the innermost loop of the whole node - a few million
	// iterations per frame - so the summed-area lookups are inlined rather
	// than going through blockSum(), and the bounds are clamped before
	// truncation so the per-cell work is four array reads and no calls.
	const integral = targetTable.integral;
	const stride = targetTable.stride;
	const xFromGx = cos * mx;
	const yFromGx = sin * mx;
	const xFromGy = -sin * my;
	const yFromGy = cos * my;

	let sum = 0;
	let count = 0;
	for (let gy = 0; gy < gridH; gy++) {
		const cy = centerY[gy];
		const rowBase = gy * gridW;
		const baseX = ox + xFromGy * cy;
		const baseY = oy + yFromGy * cy;
		for (let gx = 0; gx < gridW; gx++) {
			const cx = centerX[gx];
			const tx = baseX + xFromGx * cx;
			const ty = baseY + yFromGx * cx;
			if (tx < 0 || ty < 0 || tx >= tW || ty >= tH) continue;
			let x0 = tx + 0.5 - halfW;
			let y0 = ty + 0.5 - halfH;
			let x1 = tx + 0.5 + halfW;
			let y1 = ty + 0.5 + halfH;
			if (x0 < 0) x0 = 0;
			if (y0 < 0) y0 = 0;
			if (x1 > tW) x1 = tW;
			if (y1 > tH) y1 = tH;
			const ix0 = x0 | 0;
			const iy0 = y0 | 0;
			let ix1 = x1 | 0;
			let iy1 = y1 | 0;
			if (ix1 <= ix0) ix1 = ix0 + 1 > tW ? tW : ix0 + 1;
			if (iy1 <= iy0) iy1 = iy0 + 1 > tH ? tH : iy0 + 1;
			const area = (ix1 - ix0) * (iy1 - iy0);
			if (area <= 0) continue;
			const rowTop = iy0 * stride;
			const rowBottom = iy1 * stride;
			const cellSum =
				integral[rowBottom + ix1] -
				integral[rowTop + ix1] -
				integral[rowBottom + ix0] +
				integral[rowTop + ix0];
			const diff = density[rowBase + gx] - cellSum / area;
			sum += diff < 0 ? -diff : diff;
			count++;
		}
	}
	// require most of the template to actually be on-frame
	if (count < gridW * gridH * 0.6) return Infinity;
	return sum / count;
}

/**
 * Geometric ladder of magnifications spanning [min,max]. The relative
 * step stays constant, which is the right spacing for a scale - what
 * matters is the ratio, not the absolute difference.
 *
 * Anchored on exactly 1.0 rather than on `min`, so that "the frame and
 * the golden are already at the same scale" is always one of the
 * hypotheses tested exactly. Spacing the ladder from the endpoints
 * instead can miss 1.0 entirely (0.75..1.5 in 11 steps straddles it at
 * 0.9897 and 1.0608), which quietly denies the same-rig case - the common
 * one - the ability to score a perfect match.
 */
function scaleLadder(min, max, steps) {
	// A degenerate ladder is a single point at `min`. This matters, not
	// just a guard: the calibrated/pinned path sets scaleSearchMin ==
	// scaleSearchMax, and returning [1] there would silently search at
	// 1.0 instead of the pinned magnification - every frame aligned at
	// the wrong scale.
	if (!(min > 0)) {
		// callers clamp, but 0/negative min would make the ratio below
		// degenerate and the ladder loop grow an unbounded array
		throw new RangeError(`scaleLadder: min must be positive, got ${min}`);
	}
	if (steps <= 1 || max <= min) return [min];
	const ratio = (max / min) ** (1 / (steps - 1));
	const out = [];
	for (let k = Math.ceil(Math.log(min) / Math.log(ratio)); ; k++) {
		const m = ratio ** k;
		if (m > max * 1.0001) break;
		out.push(m);
	}
	return out.length ? out : [min];
}

function linSpread(center, halfRange, steps) {
	if (steps <= 1 || halfRange <= 0) return [center];
	const out = [];
	for (let i = 0; i < steps; i++) {
		out.push(center - halfRange + (2 * halfRange * i) / (steps - 1));
	}
	return out;
}

// Offsets stepping outward from `center`, covering +/- halfRange.
// Built symmetrically about the center rather than walked from one end,
// so the center itself is ALWAYS evaluated: a refine stage that can miss
// its own starting point is free to drift away from a position an earlier
// stage got exactly right, and at stage 1 the center is the nominal
// "part sits centered in the frame" hypothesis.
function offsetsAround(center, halfRange, step) {
	// A non-finite or non-positive range/step must not enter the walk:
	// `for (d = step; d <= halfRange; d += step)` with both Infinity is
	// true forever, which freezes the whole event loop. Reachable in
	// practice only via a corrupted trained transform (mx*my*golden
	// overflowing centerX/halfRange), but a hang is too expensive a
	// failure mode to leave to the caller's luck - degrade to searching
	// the exact center, which is always a legal candidate.
	if (
		!(halfRange > 0) ||
		!(step > 0) ||
		!Number.isFinite(halfRange) ||
		!Number.isFinite(step)
	) {
		return [center];
	}
	const out = [center];
	for (let d = step; d <= halfRange; d += step) {
		out.push(center - d, center + d);
	}
	return out;
}

/**
 * Sweep translation over a symmetric box around (cx,cy) for every
 * (scale pair, angle) combination, returning the best placement found
 * for each scale pair, ordered best-first. `scales` is a list of [mx,my]
 * pairs.
 *
 * One entry per *scale pair* rather than the k best raw candidates: the
 * k best raw candidates are almost always k translations of the same
 * scale, which is no diversity at all. What the caller needs is
 * genuinely different scale hypotheses to arbitrate between.
 */
function sweepRanked(
	sig,
	targetTable,
	tW,
	tH,
	scales,
	angles,
	cx,
	cy,
	halfRange,
	step,
) {
	const xs = offsetsAround(cx, halfRange, step);
	const ys = offsetsAround(cy, halfRange, step);
	const perPair = [];
	for (const pair of scales) {
		const mx = pair[0];
		const my = pair[1];
		let best = { mx, my, theta: angles[0], ox: cx, oy: cy, score: Infinity };
		for (const theta of angles) {
			for (const oy of ys) {
				for (const ox of xs) {
					const score = scoreCandidate(
						sig,
						targetTable,
						tW,
						tH,
						mx,
						my,
						theta,
						ox,
						oy,
					);
					if (score < best.score) best = { mx, my, theta, ox, oy, score };
				}
			}
		}
		perPair.push(best);
	}
	perPair.sort((a, b) => a.score - b.score);
	return perPair;
}

/** The single best placement - sweepRanked's winner. */
function sweep(
	sig,
	targetTable,
	tW,
	tH,
	scales,
	angles,
	cx,
	cy,
	halfRange,
	step,
) {
	return sweepRanked(
		sig,
		targetTable,
		tW,
		tH,
		scales,
		angles,
		cx,
		cy,
		halfRange,
		step,
	)[0];
}

/**
 * Re-express a candidate at a new scale/angle while keeping the
 * template's *center* pinned to the same point in the frame.
 *
 * The raw (mx, my, theta, ox, oy) parametrization scales and rotates
 * about the template's top-left corner, so nudging a scale by a percent
 * swings the far corner by a large fraction of the template - a
 * refinement step in mx alone would wreck the alignment it is trying to
 * improve, and the search would reject the better scale for the wrong
 * reason. Anchoring at the center decouples the parameters, which is what
 * lets the polish refine scale, aspect and angle in small independent
 * steps.
 */
function reanchor(cand, gW, gH, mx, my, theta) {
	const cx = gW / 2;
	const cy = gH / 2;
	const cosOld = Math.cos(cand.theta);
	const sinOld = Math.sin(cand.theta);
	const fixedX = cand.ox + cosOld * cand.mx * cx - sinOld * cand.my * cy;
	const fixedY = cand.oy + sinOld * cand.mx * cx + cosOld * cand.my * cy;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	return {
		mx,
		my,
		theta,
		ox: fixedX - (cos * mx * cx - sin * my * cy),
		oy: fixedY - (sin * mx * cx + cos * my * cy),
		score: Infinity,
	};
}

const POLISH_STEPS = [0.02, 0.01, 0.005, 0.0025, 0.00125];

/** Translation step, in px, for a given relative step size. Works out as
 * [2, 1, 1, 1, 1] - Math.round(0.5) is 1, and 0.25 and 0.125 round to 0 and
 * are floored to 1. */
function translationStep(relStep) {
	return Math.max(1, Math.round(relStep * 100));
}

/**
 * The candidates one step out from `centre`, in every direction the polish
 * is allowed to move.
 *
 * Built from one fixed centre and never mutating it, which is what makes
 * the whole set safe to score out of order - or on eight different
 * threads. The previous polish regenerated each probe from whatever had
 * been adopted so far *within* the round, so the set could not be batched
 * without changing what it searched.
 *
 * 4 scale + 2 angle + 8 translation = 14; 10 when the magnification is
 * pinned. The centre itself is deliberately not included: it has already
 * been scored, and re-scoring it per round would be a fifteenth evaluation
 * bought for nothing.
 */
function neighbourhood(centre, gW, gH, relStep, maxAngleDeg, lockScale) {
	const out = [];
	// each axis independently: moved together they are overall scale,
	// moved apart they are the print stretch this node has to tolerate
	if (!lockScale) {
		for (const factor of [1 - relStep, 1 + relStep]) {
			out.push(reanchor(centre, gW, gH, centre.mx * factor, centre.my, centre.theta));
			out.push(reanchor(centre, gW, gH, centre.mx, centre.my * factor, centre.theta));
		}
	}
	if (maxAngleDeg > 0) {
		const angleStep = relStep * 25 * DEG;
		for (const delta of [-angleStep, angleStep]) {
			out.push(reanchor(centre, gW, gH, centre.mx, centre.my, centre.theta + delta));
		}
	}
	const step = translationStep(relStep);
	for (const dy of [-step, 0, step]) {
		for (const dx of [-step, 0, step]) {
			if (dx === 0 && dy === 0) continue;
			out.push({
				mx: centre.mx,
				my: centre.my,
				theta: centre.theta,
				ox: centre.ox + dx,
				oy: centre.oy + dy,
				score: Infinity,
			});
		}
	}
	return out;
}

/**
 * Alternating refinement of the two magnifications, the angle and the
 * translation, at shrinking step sizes.
 *
 * The staged search leaves a residual bounded by its ladder spacing, and
 * on a full-page template even a fraction of a percent of scale error is
 * several pixels of drift by the far edge - which reads downstream as a
 * defect outline traced along every printed stroke, indistinguishable
 * from real blemish. It is worth a few dozen extra evaluations to remove.
 *
 * `scoreBatch` is supplied by the caller and, unlike the coarse density
 * score driving the staged search, measures the thing that actually
 * matters: how many pixels disagree once the frame is resampled into the
 * golden's grid. The two stop agreeing at this scale - the density score
 * can be improved by a nudge that makes pixel-level stroke alignment
 * worse, because a lattice cell several pixels across cannot see a
 * one-pixel outline. Refining against the cheap proxy right up to the
 * point of measurement is how you get an alignment that scores well and
 * inspects badly.
 *
 * It takes a whole neighbourhood at once and returns the scores in the
 * order given, so the evaluations can go to the worker pool. That makes
 * this a pattern search rather than the first-improvement walk it
 * replaced: every probe is measured from the same fixed centre, and the
 * best of them is adopted. The walk compounded improvements *within* a
 * round - it re-derived each probe from whatever had just been accepted -
 * which is both why it needed fewer evaluations and why it could not be
 * batched at all.
 *
 * That difference is why the walk's early break did not survive here. The
 * walk stopped when a whole compounding round improved nothing; the
 * closest equivalent is "this step size improved nothing", and stopping
 * there is measurably worse. A poll only moves along one axis at a time,
 * so it runs out of single-axis improvements well before the alignment has
 * actually converged - and the break then skipped the three finest step
 * sizes entirely. On a clean bench pair that cost a 15% worse residual and
 * put a false background region on a good part, which is precisely the
 * failure this stage exists to prevent.
 *
 * So every step size runs. It costs more evaluations than the walk did,
 * and those are the evaluations the pool now absorbs; measured against a
 * fixed pin, the residual comes out better than the walk's on every
 * fixture tried - clean and defective, searched and pinned.
 *
 * No test in the suite can see this distinction: both forms tie the walk
 * on the spec fixture. It is measured on the bench pair instead.
 */
async function polish(scoreBatch, start, gW, gH, maxAngleDeg, lockScale) {
	let best = { ...start };
	best.score = (await scoreBatch([best]))[0];

	for (const relStep of POLISH_STEPS) {
		for (;;) {
			const cands = neighbourhood(best, gW, gH, relStep, maxAngleDeg, lockScale);
			const scores = await scoreBatch(cands);
			// strict `<`, scanned in index order, so the lowest index wins a
			// tie and the choice cannot depend on how the batch was split
			// across workers
			let pick = -1;
			let pickScore = best.score;
			for (let i = 0; i < cands.length; i++) {
				if (scores[i] < pickScore) {
					pickScore = scores[i];
					pick = i;
				}
			}
			if (pick < 0) break;
			best = { ...cands[pick], score: pickScore };
		}
	}
	return best;
}

/**
 * Full coarse-to-fine search.
 *
 * `signatures` holds the golden's three precomputed density lattices
 * ({ coarse, medium, fine } from buildGoldenSignature) - they depend only
 * on the golden, so they are built once when it is cached rather than per
 * frame. `opts`:
 *   scaleMin/scaleMax/scaleSteps - stage 1 ladder; set min == max to pin
 *                                  the magnification (the calibrated case)
 *   maxAspect/aspectSteps        - stage 3 range for my/mx, as a fraction
 *                                  either side of 1 (0 disables)
 *   maxAngleDeg/angleSteps       - stage 2 rotation range; 0 disables
 *   slackPx                      - translation slack beyond the pure size
 *                                  difference, in frame px
 *   objective                    - optional pixel-level scorer for stage 4
 *
 * Returns { mx, my, theta, thetaDeg, ox, oy, score }.
 */
async function findTransform(gW, gH, targetFg, tW, tH, signatures, opts) {
	// `buildTable` arrives the same way `objectiveBatch` does - through
	// opts rather than an import - so this module keeps knowing nothing
	// about the worker pool, and the serial twin stays the default for any
	// caller outside this package.
	const targetTable = opts.buildTable
		? await opts.buildTable(targetFg, tW, tH)
		: buildIntegral(targetFg, tW, tH);

	// One scorer for the three places that need pixel-level evidence.
	// `objectiveBatch` is preferred - it is what lets the polish hand a
	// whole neighbourhood to the worker pool - but the single-candidate
	// `objective` stays supported, because it is the documented shape for
	// any caller outside this package.
	const scoreBatch = opts.objectiveBatch
		? (cands) => opts.objectiveBatch(cands)
		: opts.objective
			? async (cands) =>
					cands.map((c) => opts.objective(c.mx, c.my, c.theta, c.ox, c.oy))
			: null;

	// ---- pinned magnification: the rig's standoff and the press's stretch
	// do not change between frames, so once they have been measured there
	// is nothing to search for. Only where the part sits, and how square
	// it sits, vary. Re-solving the constant every frame is not merely
	// wasted time: it hands the search a chance to be wrong, and on a
	// badly printed label - exactly when the evidence is poorest - it
	// takes it.
	if (opts.pinnedScale) {
		const { mx, my } = opts.pinnedScale;

		// A seed replaces the four sweeps' *guess*, never their verdict:
		// polish still refines it against real pixels and still produces the
		// score. The magnifications stay the trained ones - a seed is not
		// allowed to re-open the constant that pinning exists to fix - so
		// only the angle and the placement come from it, reanchored about
		// the golden's centre so substituting mx/my cannot shift the frame.
		if (opts.seed && scoreBatch) {
			const seeded = reanchor(
				{ ...opts.seed, score: Infinity },
				gW,
				gH,
				mx,
				my,
				opts.seed.theta,
			);
			const polished = await polish(
				scoreBatch,
				seeded,
				gW,
				gH,
				opts.maxAngleDeg,
				true,
			);
			return {
				mx: polished.mx,
				my: polished.my,
				theta: polished.theta,
				thetaDeg: polished.theta / DEG,
				ox: polished.ox,
				oy: polished.oy,
				score: polished.score,
				pinned: true,
				seeded: true,
			};
		}

		const centerX = (tW - mx * gW) / 2;
		const centerY = (tH - my * gH) / 2;
		const halfRange =
			Math.max(Math.abs(centerX), Math.abs(centerY)) + opts.slackPx;
		const angles = linSpread(0, opts.maxAngleDeg * DEG, opts.angleSteps);

		let pinned = sweep(
			signatures.coarse,
			targetTable,
			tW,
			tH,
			[[mx, my]],
			[0],
			centerX,
			centerY,
			halfRange,
			Math.max(1, Math.round(mx * signatures.coarse.cellW)),
		);
		const mediumReach = Math.max(2, Math.round(mx * signatures.coarse.cellW));
		pinned = sweep(
			signatures.medium,
			targetTable,
			tW,
			tH,
			[[mx, my]],
			angles,
			pinned.ox,
			pinned.oy,
			mediumReach,
			Math.max(1, Math.round(mediumReach / 3)),
		);
		// The angle is left to the polish, which judges it on real pixels.
		// Re-sweeping it here on the fine grid was tried and is worse: with
		// the scale pinned there is no longer a scale nudge to keep the
		// density proxy honest, so it happily buys a small rotation that
		// lines ink up cell-wise while making the actual overlap worse. On
		// the demo capture that turned a clean part into nine false regions.
		const fineReach = Math.max(2, Math.round(mx * signatures.medium.cellW));
		pinned = sweep(
			signatures.fine,
			targetTable,
			tW,
			tH,
			[[mx, my]],
			[pinned.theta],
			pinned.ox,
			pinned.oy,
			fineReach,
			Math.max(1, Math.round(fineReach / 2)),
		);
		pinned = sweep(
			signatures.fine,
			targetTable,
			tW,
			tH,
			[[mx, my]],
			[pinned.theta],
			pinned.ox,
			pinned.oy,
			3,
			1,
		);
		if (scoreBatch) {
			pinned = await polish(scoreBatch, pinned, gW, gH, opts.maxAngleDeg, true);
		}
		return {
			mx: pinned.mx,
			my: pinned.my,
			theta: pinned.theta,
			thetaDeg: pinned.theta / DEG,
			ox: pinned.ox,
			oy: pinned.oy,
			score: pinned.score,
			pinned: true,
		};
	}

	// ---- stage 1: wide scale ladder, isotropic, no rotation, whole frame
	const coarse = signatures.coarse;
	const scales = scaleLadder(opts.scaleMin, opts.scaleMax, opts.scaleSteps);
	let best = {
		mx: scales[0],
		my: scales[0],
		theta: 0,
		ox: 0,
		oy: 0,
		score: Infinity,
	};
	let ranked = [best];
	for (const m of scales) {
		// centered on the nominal placement for this magnification, reaching
		// out over the whole margin the frame has plus the jitter slack
		const centerX = (tW - m * gW) / 2;
		const centerY = (tH - m * gH) / 2;
		const halfRange =
			Math.max(Math.abs(centerX), Math.abs(centerY)) + opts.slackPx;
		// one full cell per step: this stage only has to get within a cell,
		// and halving the step would quadruple a sweep that is paid once per
		// rung of the ladder
		const step = Math.max(1, Math.round(m * coarse.cellW));
		const hit = sweep(
			coarse,
			targetTable,
			tW,
			tH,
			[[m, m]],
			[0],
			centerX,
			centerY,
			halfRange,
			step,
		);
		if (hit.score < best.score) best = hit;
	}

	const ladderRatio = scales.length > 1 ? scales[1] / scales[0] : 1.05;

	// ---- stage 2: scale, stretch and rotation together on a medium grid.
	//
	// The aspect ratio has to enter HERE rather than in a later stage. Held
	// isotropic, the best-scoring scale on a stretched print lands between
	// the two true axis scales - so committing to one isotropic rung first
	// and only then looking for stretch starts the split from a wrong
	// centre, and a later stage searching a narrow band around it can no
	// longer reach the right answer. Searching them jointly costs one
	// medium-grid sweep and removes the whole failure mode.
	const medium = signatures.medium;
	{
		const reach = Math.max(2, Math.round(best.mx * coarse.cellW));
		const step = Math.max(1, Math.round(reach / 3));
		const aspects = linSpread(1, opts.maxAspect, opts.aspectSteps);
		const refineScales = [];
		for (const m of [best.mx / ladderRatio, best.mx, best.mx * ladderRatio]) {
			for (const aspect of aspects) refineScales.push([m, m * aspect]);
		}
		// Scale and stretch jointly, then angle - rather than one sweep over
		// the product of all three. Scale and stretch have to be joint
		// because they trade off directly against each other; the angle does
		// not interact with either at these magnitudes (a couple of degrees
		// looks nothing like a few percent of stretch), and splitting it out
		// turns a product into a sum: about a third of the candidates.
		ranked = sweepRanked(
			medium,
			targetTable,
			tW,
			tH,
			refineScales,
			[0],
			best.ox,
			best.oy,
			reach,
			step,
		);
		const angles = linSpread(0, opts.maxAngleDeg * DEG, opts.angleSteps);
		if (angles.length > 1) {
			ranked = ranked.map((cand) =>
				sweep(
					medium,
					targetTable,
					tW,
					tH,
					[[cand.mx, cand.my]],
					angles,
					cand.ox,
					cand.oy,
					reach,
					step,
				),
			);
		}
		best = ranked[0];
	}

	// ---- stage 3: fine grid, each axis nudged independently.
	//
	// Run for the top few stage-2 hypotheses rather than only the winner.
	// Stage 2 ranks by the density proxy, which counts ink per cell and so
	// cannot tell a correctly scaled match from one a few percent off that
	// happens to land its ink in the same cells. On a dense label the two
	// score within noise of each other, and picking wrong there is
	// unrecoverable: every later stage searches a narrow band around the
	// choice. The symptom is a whole frame failing at ~0.5% residual scale
	// error - about 10px of drift across the label, total disagreement on
	// 1-2px strokes - while a far better placement existed all along.
	const fine = signatures.fine;
	const refineOne = (cand) => {
		const angleStepDeg =
			opts.angleSteps > 1 ? (2 * opts.maxAngleDeg) / (opts.angleSteps - 1) : 0;
		const angles = linSpread(
			cand.theta,
			(angleStepDeg / 2) * DEG,
			angleStepDeg > 0 ? 3 : 1,
		);
		const aspectStep =
			opts.aspectSteps > 1 ? opts.maxAspect / (opts.aspectSteps - 1) : 0.01;
		const nudges = [1 - aspectStep, 1, 1 + aspectStep];
		const refineScales = [];
		for (const nx of nudges) {
			for (const ny of nudges) refineScales.push([cand.mx * nx, cand.my * ny]);
		}
		const reach = Math.max(2, Math.round(cand.mx * medium.cellW));
		const out = sweep(
			fine,
			targetTable,
			tW,
			tH,
			refineScales,
			angles,
			cand.ox,
			cand.oy,
			reach,
			Math.max(1, Math.round(reach / 2)),
		);
		return sweep(
			fine,
			targetTable,
			tW,
			tH,
			[[out.mx, out.my]],
			[out.theta],
			out.ox,
			out.oy,
			3,
			1,
		);
	};

	{
		const keep = Math.max(1, Math.min(opts.rankedCandidates || 1, ranked.length));
		const refined = [];
		for (let i = 0; i < keep; i++) refined.push(refineOne(ranked[i]));

		// Arbitrate on real pixel disagreement, not the proxy that got us
		// here. One objective call per candidate is cheap next to a sweep,
		// and it is the only measure that can actually separate them.
		best = refined[0];
		if (scoreBatch && refined.length > 1) {
			// one batch, not one call per candidate: these are independent and
			// there may be up to alignCandidates of them
			const scores = await scoreBatch(refined);
			let bestObj = Infinity;
			for (let i = 0; i < refined.length; i++) {
				if (scores[i] < bestObj) {
					bestObj = scores[i];
					best = refined[i];
				}
			}
		}
	}

	// ---- stage 4: sub-percent polish against real pixel disagreement
	if (scoreBatch) {
		best = await polish(scoreBatch, best, gW, gH, opts.maxAngleDeg, false);
	}

	return { ...best, thetaDeg: best.theta / DEG };
}

module.exports = {
	buildGoldenSignature,
	neighbourhood,
	scaleLadder,
	offsetsAround,
	reanchor,
	polish,
	findTransform,
};
