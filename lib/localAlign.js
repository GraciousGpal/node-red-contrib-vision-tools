/**
 * Local (per-tile) alignment refinement.
 *
 * The global transform gets the label into place; it cannot get all of it
 * into place. Measured on this project's own good pair - artwork against
 * a photograph of the print, after a correctly recovered 5-DOF transform
 * - the leftover displacement has a median of 0.73px, a 90th percentile
 * of 1.55px, and individual regions sitting 4-5px out that match their
 * golden counterpart near-perfectly once shifted.
 *
 * That field is not smooth, so raising the global model does not reach
 * it: fitting a homography (8 DOF) to it removed 18% of the residual, and
 * a full quadratic (12 DOF) only 27%. A global warp cannot pull one
 * corner 5px left while leaving the two-thirds of the label that is
 * already sub-pixel untouched. The physical reason is that a label on a
 * formed tray is not a plane - regions lift and bow independently - and
 * no global parametrisation describes that.
 *
 * So each tile finds its own small offset. Two properties matter for
 * correctness:
 *
 *  - The offsets are **capped** (maxOffset). Uncapped, a tile could slide
 *    onto neighbouring ink and quietly align a genuine fault away. The
 *    cap is what keeps this a registration refinement rather than a
 *    licence to match anything.
 *  - Tiles without enough contrast to localise are **not trusted**. A
 *    blank tile matches equally well everywhere, so its "best" offset is
 *    noise; it is filled from its neighbours instead.
 *
 * The field is median-filtered (a spurious match is a lone disagreeing
 * tile, while real substrate movement is coherent across several) and
 * then interpolated bilinearly between tile centres when resampling.
 * Applying a piecewise-constant shift per tile would step at every tile
 * boundary and manufacture a seam of false defects along each one.
 */

"use strict";

const { allocU8, allocF32 } = require("./shared.js");

/**
 * Whole-pixel sample with edge clamping - deliberately NOT interpolated.
 *
 * Bilinear resampling here was tried and is actively harmful. Interpolating
 * at a fractional offset is a low-pass filter, and the features this node
 * has to see are one to two pixels wide: on the demo capture it blurred
 * the pen mark until it no longer crossed the ink level, dropping the
 * defect ratio by 82% and turning a failing part into a passing one. It
 * quietly ate real ink everywhere else too, taking a clean part's
 * background ratio from 0.00009 to exactly 0.
 *
 * So the displacement field is interpolated smoothly and then rounded,
 * and pixels are moved rather than mixed. The cost is that correction is
 * quantised to whole pixels - the measured median residual is ~0.75px, so
 * roughly half of it survives - but the several-pixel outliers that
 * actually manufacture false regions are removed, and no contrast is lost
 * doing it. Sharpness is worth more than sub-pixel here.
 */
function sampleNearest(src, w, h, x, y) {
	if (x < 0) x = 0;
	else if (x > w - 1) x = w - 1;
	if (y < 0) y = 0;
	else if (y > h - 1) y = h - 1;
	return src[y * w + x];
}

/**
 * Mean squared difference between the golden tile and the frame shifted
 * by (dx,dy). Subsampled by 2 in both axes - this is called (2r+1)^2
 * times per tile and the extra precision buys nothing at this scale.
 */
// Subsample the tile when matching. This runs (2r+1)^2 times per tile
// over several hundred tiles, so it is worth being stingy: going from
// every 2nd pixel to every 3rd took local refinement from ~170ms to
// ~120ms on a 1844x2656 golden with no measurable change to the field it
// produces. The tile is 96px, so even at step 3 there are ~1000 samples
// behind each offset.
const SSD_STEP = 3;

function tileSsd(golden, target, w, h, x0, y0, x1, y1, dx, dy) {
	let sum = 0;
	let count = 0;
	for (let y = y0; y < y1; y += SSD_STEP) {
		const sy = y + dy;
		if (sy < 0 || sy >= h) continue;
		const gRow = y * w;
		const tRow = sy * w;
		for (let x = x0; x < x1; x += SSD_STEP) {
			const sx = x + dx;
			if (sx < 0 || sx >= w) continue;
			const d = golden[gRow + x] - target[tRow + sx];
			sum += d * d;
			count++;
		}
	}
	return count ? sum / count : Infinity;
}

/** Standard deviation of a golden tile - its ability to localise at all. */
function tileStdDev(golden, w, x0, y0, x1, y1) {
	let sum = 0;
	let sumSq = 0;
	let n = 0;
	for (let y = y0; y < y1; y += 2) {
		const row = y * w;
		for (let x = x0; x < x1; x += 2) {
			const v = golden[row + x];
			sum += v;
			sumSq += v * v;
			n++;
		}
	}
	if (n === 0) return 0;
	const mean = sum / n;
	const variance = sumSq / n - mean * mean;
	return variance > 0 ? Math.sqrt(variance) : 0;
}

/** Sub-pixel minimum from a parabola through three SSD samples. */
function parabolic(before, at, after) {
	const denom = before - 2 * at + after;
	if (Math.abs(denom) < 1e-9) return 0;
	const shift = (0.5 * (before - after)) / denom;
	return shift > 1 || shift < -1 ? 0 : shift;
}

/**
 * Per-tile displacement of the frame relative to the golden, in golden
 * pixels: the golden's pixel (x,y) is found in the frame at
 * (x + fx, y + fy).
 */
/**
 * Fill tile rows [gyLo,gyHi) of an existing field. Tile rows are
 * independent, so this is the unit the worker pool splits - and it calls
 * this same function, so there is one implementation rather than a copy
 * that could drift from it.
 */
function fieldRows(goldenGray, targetGray, width, height, opts, out, gyLo, gyHi) {
	const tile = opts.tile;
	const maxOffset = opts.maxOffset;
	const minStdDev = opts.minStdDev;
	const { fx, fy, valid, gridW } = out;

	for (let gy = gyLo; gy < gyHi; gy++) {
		const y0 = gy * tile;
		const y1 = Math.min(height, y0 + tile);
		for (let gx = 0; gx < gridW; gx++) {
			const x0 = gx * tile;
			const x1 = Math.min(width, x0 + tile);
			const cell = gy * gridW + gx;
			if (tileStdDev(goldenGray, width, x0, y0, x1, y1) < minStdDev) continue;

			let bestDx = 0;
			let bestDy = 0;
			let bestVal = Infinity;
			for (let dy = -maxOffset; dy <= maxOffset; dy++) {
				for (let dx = -maxOffset; dx <= maxOffset; dx++) {
					const v = tileSsd(goldenGray, targetGray, width, height, x0, y0, x1, y1, dx, dy);
					if (v < bestVal) {
						bestVal = v;
						bestDx = dx;
						bestDy = dy;
					}
				}
			}
			// a minimum sitting on the edge of the search box is not a
			// minimum - the true one is outside the cap, and trusting it
			// would be extrapolating past where we agreed to look
			if (Math.abs(bestDx) === maxOffset || Math.abs(bestDy) === maxOffset) continue;

			const sx = parabolic(
				tileSsd(goldenGray, targetGray, width, height, x0, y0, x1, y1, bestDx - 1, bestDy),
				bestVal,
				tileSsd(goldenGray, targetGray, width, height, x0, y0, x1, y1, bestDx + 1, bestDy),
			);
			const sy = parabolic(
				tileSsd(goldenGray, targetGray, width, height, x0, y0, x1, y1, bestDx, bestDy - 1),
				bestVal,
				tileSsd(goldenGray, targetGray, width, height, x0, y0, x1, y1, bestDx, bestDy + 1),
			);
			fx[cell] = bestDx + sx;
			fy[cell] = bestDy + sy;
			valid[cell] = 1;
		}
	}
}

function buildDisplacementField(goldenGray, targetGray, width, height, opts) {
	const gridW = Math.max(1, Math.ceil(width / opts.tile));
	const gridH = Math.max(1, Math.ceil(height / opts.tile));
	const out = {
		fx: allocF32(gridW * gridH),
		fy: allocF32(gridW * gridH),
		valid: allocU8(gridW * gridH),
		gridW,
		gridH,
	};
	fieldRows(goldenGray, targetGray, width, height, opts, out, 0, gridH);
	return out;
}

/**
 * 3x3 median over valid neighbours, which also fills the invalid tiles.
 * A tile that matched something spurious disagrees with everything around
 * it, while real substrate movement is coherent over several tiles - so
 * the median keeps the second and discards the first. Filling blank tiles
 * from their neighbours matters as much: leaving them at zero would put a
 * step between a blank tile and a genuinely displaced one beside it, and
 * the resampling would smear ink across that step.
 */
function smoothField(field) {
	const { fx, fy, valid, gridW, gridH } = field;
	const outX = allocF32(fx.length);
	const outY = allocF32(fy.length);
	const outValid = allocU8(valid.length);
	const bufX = [];
	const bufY = [];
	const median = (arr) => {
		arr.sort((a, b) => a - b);
		const mid = arr.length >> 1;
		return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
	};

	for (let gy = 0; gy < gridH; gy++) {
		for (let gx = 0; gx < gridW; gx++) {
			const cell = gy * gridW + gx;
			bufX.length = 0;
			bufY.length = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = gy + dy;
				if (ny < 0 || ny >= gridH) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const nx = gx + dx;
					if (nx < 0 || nx >= gridW) continue;
					const n = ny * gridW + nx;
					if (!valid[n]) continue;
					bufX.push(fx[n]);
					bufY.push(fy[n]);
				}
			}
			if (bufX.length === 0) continue;
			outX[cell] = median(bufX);
			outY[cell] = median(bufY);
			outValid[cell] = 1;
		}
	}
	return { fx: outX, fy: outY, valid: outValid, gridW, gridH };
}

/**
 * Resample the frame under the displacement field: interpolated smoothly
 * between tile centres, then rounded to whole pixels for the sample
 * itself. See sampleNearest for why the image is never interpolated.
 */
/** Resample rows [yLo,yHi) under the field. Rows are independent. */
function applyRows(out, targetGray, width, height, field, tile, yLo, yHi) {
	const { fx, fy, gridW, gridH } = field;
	for (let y = yLo; y < yHi; y++) {
		// tile centres sit at (g + 0.5) * tile, so the field coordinate of
		// an image row is y/tile - 0.5
		let gyf = y / tile - 0.5;
		if (gyf < 0) gyf = 0;
		else if (gyf > gridH - 1) gyf = gridH - 1;
		const gy0 = Math.floor(gyf);
		const gy1 = gy0 + 1 < gridH ? gy0 + 1 : gy0;
		const wy = gyf - gy0;
		const row = y * width;
		for (let x = 0; x < width; x++) {
			let gxf = x / tile - 0.5;
			if (gxf < 0) gxf = 0;
			else if (gxf > gridW - 1) gxf = gridW - 1;
			const gx0 = Math.floor(gxf);
			const gx1 = gx0 + 1 < gridW ? gx0 + 1 : gx0;
			const wx = gxf - gx0;

			const i00 = gy0 * gridW + gx0;
			const i01 = gy0 * gridW + gx1;
			const i10 = gy1 * gridW + gx0;
			const i11 = gy1 * gridW + gx1;
			const top = fx[i00] + (fx[i01] - fx[i00]) * wx;
			const bot = fx[i10] + (fx[i11] - fx[i10]) * wx;
			const dx = top + (bot - top) * wy;
			const topY = fy[i00] + (fy[i01] - fy[i00]) * wx;
			const botY = fy[i10] + (fy[i11] - fy[i10]) * wx;
			const dy = topY + (botY - topY) * wy;

			out[row + x] = sampleNearest(
				targetGray,
				width,
				height,
				x + Math.round(dx),
				y + Math.round(dy),
			);
		}
	}
}

function applyField(targetGray, width, height, field, tile) {
	const out = allocU8(width * height);
	applyRows(out, targetGray, width, height, field, tile, 0, height);
	return out;
}

/**
 * Refine an already globally-aligned frame tile by tile. Returns the
 * corrected grey plus what it had to move, so a caller can see whether
 * the rig is drifting rather than only that it was compensated for.
 */
function refineLocally(goldenGray, alignedTargetGray, width, height, cfg) {
	const tile = Math.max(8, cfg.localAlignTile | 0);
	const maxOffset = Math.max(1, cfg.localAlignMax | 0);
	const raw = buildDisplacementField(goldenGray, alignedTargetGray, width, height, {
		tile,
		maxOffset,
		minStdDev: cfg.localAlignMinStdDev != null ? cfg.localAlignMinStdDev : 12,
	});
	const field = smoothField(raw);

	return {
		gray: applyField(alignedTargetGray, width, height, field, tile),
		field,
		tile,
		stats: fieldStats(field),
	};
}

/** How far the field had to move things - reported so a drifting rig is
 * visible rather than merely compensated for. */
function fieldStats(field) {
	let localised = 0;
	let sum = 0;
	let max = 0;
	const magnitudes = [];
	for (let i = 0; i < field.valid.length; i++) {
		if (!field.valid[i]) continue;
		const m = Math.hypot(field.fx[i], field.fy[i]);
		magnitudes.push(m);
		localised++;
		sum += m;
		if (m > max) max = m;
	}
	magnitudes.sort((a, b) => a - b);
	return {
		tiles: field.valid.length,
		localised,
		meanPx: localised ? sum / localised : 0,
		medianPx: magnitudes.length ? magnitudes[magnitudes.length >> 1] : 0,
		maxPx: max,
	};
}

module.exports = {
	refineLocally,
	buildDisplacementField,
	fieldRows,
	smoothField,
	applyField,
	applyRows,
	fieldStats,
};
