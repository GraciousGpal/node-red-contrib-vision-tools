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

// Subsample the tile when matching. This runs (2r+1)^2 times per tile
// over several hundred tiles, so it is worth being stingy: going from
// every 2nd pixel to every 3rd took local refinement from ~170ms to
// ~120ms on a 1844x2656 golden with no measurable change to the field it
// produces. The tile is 96px, so even at step 3 there are ~1000 samples
// behind each offset.
const SSD_STEP = 3;

/**
 * Mean squared difference between the golden tile and the frame shifted
 * by (dx,dy), sampled every SSD_STEP px in both axes.
 */
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

/**
 * tileSsd for a tile whose every sample stays inside the frame at this
 * offset, so the sample count is known before it starts - `count` - and
 * the search can stop a candidate as soon as it cannot win: the sum only
 * grows, and division by the same count never orders two sums the other
 * way, so once the running mean is at `best` the finished one would be
 * too. Returns the mean, or Infinity for a candidate stopped early. The
 * search keeps a candidate only when it is strictly below `best`, so the
 * field is the one the full sums give, to the bit; at localAlignMax 6
 * most of the 169 offsets of a tile are out after a few rows.
 */
function tileSsdBelow(golden, target, w, x0, y0, x1, y1, dx, dy, count, best) {
	let sum = 0;
	for (let y = y0; y < y1; y += SSD_STEP) {
		const gRow = y * w;
		const tRow = (y + dy) * w + dx;
		for (let x = x0; x < x1; x += SSD_STEP) {
			const d = golden[gRow + x] - target[tRow + x];
			sum += d * d;
		}
		if (sum / count >= best) return Infinity;
	}
	return sum / count;
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
	// a neighbour with no sample in range is Infinity, and Infinity over
	// Infinity is NaN, which would pass the clamp below and poison every
	// maximum taken over it
	if (!Number.isFinite(before) || !Number.isFinite(at) || !Number.isFinite(after)) return 0;
	const denom = before - 2 * at + after;
	if (Math.abs(denom) < 1e-9) return 0;
	const shift = (0.5 * (before - after)) / denom;
	return shift > 1 || shift < -1 ? 0 : shift;
}

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
			// every offset in the box keeps every sample inside the frame:
			// the count is fixed, and a losing offset can stop early
			const inside =
				x0 - maxOffset >= 0 &&
				y0 - maxOffset >= 0 &&
				x1 - 1 + maxOffset < width &&
				y1 - 1 + maxOffset < height;
			const count = Math.ceil((x1 - x0) / SSD_STEP) * Math.ceil((y1 - y0) / SSD_STEP);
			for (let dy = -maxOffset; dy <= maxOffset; dy++) {
				for (let dx = -maxOffset; dx <= maxOffset; dx++) {
					const v = inside
						? tileSsdBelow(goldenGray, targetGray, width, x0, y0, x1, y1, dx, dy, count, bestVal)
						: tileSsd(goldenGray, targetGray, width, height, x0, y0, x1, y1, dx, dy);
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

/**
 * Per-tile displacement of the frame relative to the golden, in golden
 * pixels: the golden's pixel (x,y) is found in the frame at
 * (x + fx, y + fy).
 */
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

/**
 * Resample the frame under the displacement field: interpolated smoothly
 * between tile centres, then rounded to whole pixels for the sample
 * itself. See sampleNearest for why the image is never interpolated.
 */
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

// ----------------------------------------------------------- register

// How far off register the frame still is after the alignment it was
// given, measured on a training frame and written down, so the tone and
// speck checks take the slack this rig needs instead of a guess. The
// search (16 px) is wider than the local alignment's default cap, since
// the residual is what that cap did not reach.
//
// Each axis is measured from the edges that can see it - a long bar's
// edges are blind to a shift along it and would drown its end's few
// pixels that are not. So the x residual comes from the golden's
// vertical edges only, the y residual from its horizontal ones, each a
// one-dimensional search - a vertical edge is as good as invariant to a
// shift along itself, so the two do not need each other.
//
// The frame is a photograph: its paper is not 255 nor its ink 0, and a
// raw difference carries that lighting as a floor every offset pays, so
// the true match never beat a wrong one by much - a 5 px residual read
// as 3, the near search's edge. Each tile's frame grey is first mapped
// onto the golden's by its own 10th and 90th percentiles, and the
// difference is taken from there.
//
// A wide search is easily fooled: a barcode or a line of type shifted by
// one period scores about as well as the true match. So each axis is
// first matched close in - and when that minimum sits on the near
// range's edge, followed outward while the difference keeps falling,
// since a steady descent is not an alias - and the far minimum replaces
// it only when it is clearly the better match; ties go to the smaller
// offset; and a tile more than 1.5 px off counts only when at least two
// of its neighbours (or all it has, when fewer) moved with it, since a
// rig's residual is coherent over several tiles while a spurious match
// is on its own. A tile whose best offset sits on
// the edge of the range has a residual past it; it is counted and not
// measured. The slack is the worst coherent tile plus one for the blur,
// between 2 and 16 px - and, since a rig's residual is not the same
// everywhere (one corner of a label at 4 px while the rest sits at half
// a pixel), also a map of it per tile: each tile's own residual plus
// one, a tile that measured nothing taking the worst of its neighbours
// or else the whole frame's, and every tile then taking the worst of its
// neighbours too, so a region's residual reaches one tile past where it
// was seen. The checks then allow 5 px where the rig needs 5 and 2 where
// it needs 2, instead of paying the worst corner's price across the
// whole label.
//
// One frame is not the rig: parts do not all sit alike, so consecutive
// training frames merge, the worst each tile saw (mergeRegister), and a
// map is only as good as the spread of the frames it was trained on.
const REGISTER_SEARCH_PX = 16;
const REGISTER_NEAR_PX = 3;
// the far minimum must beat the near one by this much to be believed
const REGISTER_FAR_GAIN = 0.5;
// a tile is coherent when this many neighbours agree within this far
const REGISTER_COHERENT_NEIGHBOURS = 2;
const REGISTER_COHERENT_PX = 2;
// a tile this close to register has nothing to be spurious about
const REGISTER_STILL_PX = 1.5;
// offsets whose SSD is within this fraction of each other are a tie, and
// a tie goes to the smaller offset
const REGISTER_TIE = 0.05;
// a golden pixel is an edge for an axis when its grey steps this much
// across it, and an axis is measurable in a tile with this many of them
// (a lone bar end is about twenty). An axis a tile cannot see takes the
// worst seen along that axis within this many tiles, not zero: a bar's
// interior is blind to the shift its own ends show, and those are along
// the bar, not above or below it
const REGISTER_EDGE_STEP = 32;
const REGISTER_MIN_EDGE_PX = 12;
const REGISTER_BORROW_TILES = 3;
const REGISTER_SLACK_MIN = 2;
const REGISTER_SLACK_MAX = 16;
// the slack is rounded up to one of these, so a golden holds at most nine
// tone windows however many values a map carries; the checks round a
// map's values the same way (lib/compare.js), so a record says what runs
const SLACK_LEVELS = [2, 3, 4, 5, 6, 8, 10, 12, 16];
const slackLevel = (v) => SLACK_LEVELS.find((l) => l >= v) || REGISTER_SLACK_MAX;

function measureRegister(goldenGray, targetGray, width, height, cfg) {
	const tile = Math.max(8, cfg.localAlignTile | 0);
	const search = REGISTER_SEARCH_PX;
	const gridW = Math.max(1, Math.ceil(width / tile));
	const gridH = Math.max(1, Math.ceil(height / tile));
	const fx = new Float32Array(gridW * gridH);
	const fy = new Float32Array(gridW * gridH);
	const seenX = new Uint8Array(gridW * gridH);
	const seenY = new Uint8Array(gridW * gridH);
	const valid = new Uint8Array(gridW * gridH);
	let beyond = 0;

	// one axis of one tile: the mean squared difference over that axis's
	// edge pixels at each offset along it, near first, then the range.
	// The lowest value wins; among values within the tie of it, the
	// smallest offset.
	const pick = (ssd, from, to) => {
		let minV = Infinity;
		for (let d = from; d <= to; d++) minV = Math.min(minV, ssd(d));
		let bestD = 0;
		let bestV = Infinity;
		for (let d = from; d <= to; d++) {
			const v = ssd(d);
			if (v <= minV * (1 + REGISTER_TIE) && (bestV === Infinity || Math.abs(d) < Math.abs(bestD))) {
				bestD = d;
				bestV = v;
			}
		}
		return { d: bestD, v: bestV };
	};
	const axis = (ssd) => {
		let near = pick(ssd, -REGISTER_NEAR_PX, REGISTER_NEAR_PX);
		// a minimum on the near range's edge is not a minimum: follow it
		// outward while the difference keeps falling
		if (Math.abs(near.d) === REGISTER_NEAR_PX) {
			const step = near.d > 0 ? 1 : -1;
			for (let d = near.d + step; Math.abs(d) <= search; d += step) {
				const v = ssd(d);
				if (v >= near.v) break;
				near = { d, v };
			}
		}
		const far = pick(ssd, -search, search);
		let best = near;
		if (far.v < REGISTER_FAR_GAIN * near.v) best = far;
		if (Math.abs(best.d) >= search) return null;
		return best.d + parabolic(ssd(best.d - 1), best.v, ssd(best.d + 1));
	};

	// the frame's grey mapped onto the golden's for one tile: the two
	// 10th-90th percentile spans brought together, so lighting is not a
	// floor under every offset
	const hist = new Uint32Array(256);
	const span = (src, x0, y0, x1, y1) => {
		hist.fill(0);
		let n = 0;
		for (let y = y0; y < y1; y += 2)
			for (let x = x0; x < x1; x += 2) {
				hist[src[y * width + x]]++;
				n++;
			}
		const at = (f) => {
			let acc = 0;
			for (let v = 0; v < 256; v++) {
				acc += hist[v];
				if (acc >= n * f) return v;
			}
			return 255;
		};
		return [at(0.1), at(0.9)];
	};

	const listX = new Int32Array(tile * tile);
	const listY = new Int32Array(tile * tile);
	for (let gy = 0; gy < gridH; gy++) {
		const y0 = Math.max(1, gy * tile);
		const y1 = Math.min(height - 1, (gy + 1) * tile);
		for (let gx = 0; gx < gridW; gx++) {
			const x0 = Math.max(1, gx * tile);
			const x1 = Math.min(width - 1, (gx + 1) * tile);
			let nx = 0;
			let ny = 0;
			for (let y = y0; y < y1; y++) {
				const row = y * width;
				for (let x = x0; x < x1; x++) {
					const i = row + x;
					if (Math.abs(goldenGray[i + 1] - goldenGray[i - 1]) >= REGISTER_EDGE_STEP) listX[nx++] = i;
					if (Math.abs(goldenGray[i + width] - goldenGray[i - width]) >= REGISTER_EDGE_STEP) listY[ny++] = i;
				}
			}
			const seesX = nx >= REGISTER_MIN_EDGE_PX;
			const seesY = ny >= REGISTER_MIN_EDGE_PX;
			if (!seesX && !seesY) continue;
			const [gLo, gHi] = span(goldenGray, x0, y0, x1, y1);
			const [tLo, tHi] = span(targetGray, x0, y0, x1, y1);
			// a frame tile with no spread of its own cannot be mapped; take
			// it as it is
			const spans = tHi - tLo >= 16 && gHi - gLo >= 16;
			const gain = spans ? (gHi - gLo) / (tHi - tLo) : 1;
			const lift = spans ? gLo - gain * tLo : 0;
			const ssdX = (dx) => {
				let sum = 0;
				let count = 0;
				for (let k = 0; k < nx; k++) {
					const i = listX[k];
					const sx = (i % width) + dx;
					if (sx < 0 || sx >= width) continue;
					const d = goldenGray[i] - (gain * targetGray[i + dx] + lift);
					sum += d * d;
					count++;
				}
				return count ? sum / count : Infinity;
			};
			const ssdY = (dy) => {
				let sum = 0;
				let count = 0;
				const step = dy * width;
				for (let k = 0; k < ny; k++) {
					const i = listY[k];
					const sy = ((i / width) | 0) + dy;
					if (sy < 0 || sy >= height) continue;
					const d = goldenGray[i] - (gain * targetGray[i + step] + lift);
					sum += d * d;
					count++;
				}
				return count ? sum / count : Infinity;
			};
			const dx = seesX ? axis(ssdX) : 0;
			const dy = seesY ? axis(ssdY) : 0;
			if (dx === null || dy === null) {
				beyond++;
				continue;
			}
			const cell = gy * gridW + gx;
			fx[cell] = dx;
			fy[cell] = dy;
			seenX[cell] = seesX ? 1 : 0;
			seenY[cell] = seesY ? 1 : 0;
			valid[cell] = 1;
		}
	}
	// an axis a tile could not see: the worst seen along that axis nearby
	const borrow = (f, seen, stepX, stepY) => {
		const out = Float32Array.from(f);
		for (let gy = 0; gy < gridH; gy++)
			for (let gx = 0; gx < gridW; gx++) {
				const cell = gy * gridW + gx;
				if (!valid[cell] || seen[cell]) continue;
				let worst = 0;
				for (let k = -REGISTER_BORROW_TILES; k <= REGISTER_BORROW_TILES; k++) {
					const nx = gx + k * stepX;
					const ny = gy + k * stepY;
					if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
					const n = ny * gridW + nx;
					if (valid[n] && seen[n] && Math.abs(f[n]) > Math.abs(worst)) worst = f[n];
				}
				out[cell] = worst;
			}
		return out;
	};
	const fxFull = borrow(fx, seenX, 1, 0);
	const fyFull = borrow(fy, seenY, 0, 1);
	fx.set(fxFull);
	fy.set(fyFull);

	// keep a tile that is near register, or that moved with its neighbours
	const magnitudes = [];
	const kept = new Float32Array(gridW * gridH).fill(-1);
	let spurious = 0;
	for (let gy = 0; gy < gridH; gy++) {
		for (let gx = 0; gx < gridW; gx++) {
			const cell = gy * gridW + gx;
			if (!valid[cell]) continue;
			const m = Math.hypot(fx[cell], fy[cell]);
			if (m < REGISTER_STILL_PX) {
				magnitudes.push(m);
				kept[cell] = m;
				continue;
			}
			let agree = 0;
			let around = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = gy + dy;
				if (ny < 0 || ny >= gridH) continue;
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = gx + dx;
					if (nx < 0 || nx >= gridW) continue;
					const n = ny * gridW + nx;
					if (!valid[n]) continue;
					around++;
					if (Math.hypot(fx[n] - fx[cell], fy[n] - fy[cell]) <= REGISTER_COHERENT_PX) agree++;
				}
			}
			// a tile with no measured neighbour has nobody to vouch for it:
			// an isolated offset is as likely an alias as a residual
			if (around > 0 && agree >= Math.min(REGISTER_COHERENT_NEIGHBOURS, around)) {
				magnitudes.push(m);
				kept[cell] = m;
			} else spurious++;
		}
	}
	magnitudes.sort((a, b) => a - b);
	const localised = magnitudes.length;
	const at = (f) =>
		localised ? magnitudes[Math.min(localised - 1, Math.floor(f * localised))] : 0;
	const max = localised ? magnitudes[localised - 1] : 0;
	const slackOf = (m) =>
		slackLevel(Math.min(REGISTER_SLACK_MAX, Math.max(REGISTER_SLACK_MIN, Math.ceil(m) + 1)));
	const slackPx = localised ? slackOf(max) : null;

	// the map: each tile's own slack, the unmeasured filled from their
	// neighbours or the whole frame's, then one tile of spread
	const cells = gridW * gridH;
	const own = new Uint8Array(cells);
	for (let c = 0; c < cells; c++) own[c] = kept[c] >= 0 ? slackOf(kept[c]) : 0;
	const neighbourMax = (src, gx, gy) => {
		let best = 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = gy + dy;
			if (ny < 0 || ny >= gridH) continue;
			for (let dx = -1; dx <= 1; dx++) {
				const nx = gx + dx;
				if (nx < 0 || nx >= gridW) continue;
				const v = src[ny * gridW + nx];
				if (v > best) best = v;
			}
		}
		return best;
	};
	const filled = new Uint8Array(cells);
	for (let gy = 0; gy < gridH; gy++)
		for (let gx = 0; gx < gridW; gx++) {
			const c = gy * gridW + gx;
			filled[c] = own[c] || neighbourMax(own, gx, gy) || slackPx || REGISTER_SLACK_MIN;
		}
	const spread = new Uint8Array(cells);
	for (let gy = 0; gy < gridH; gy++)
		for (let gx = 0; gx < gridW; gx++) spread[gy * gridW + gx] = neighbourMax(filled, gx, gy);

	return {
		frames: 1,
		tiles: cells,
		localised,
		spurious,
		beyond,
		searchPx: search,
		medianPx: at(0.5),
		p98Px: at(0.98),
		maxPx: max,
		slackPx,
		slack: localised ? { tile, gridW, gridH, slackPx: Array.from(spread) } : null,
	};
}

/**
 * Two measurements of the same golden as one: the worst each tile saw,
 * the worst of the whole-frame numbers, the frames counted. Maps on
 * different grids cannot be merged; the later one then stands alone.
 */
function mergeRegister(a, b) {
	if (!a) return b;
	if (!b) return a;
	const sameGrid =
		a.slack && b.slack &&
		a.slack.tile === b.slack.tile &&
		a.slack.gridW === b.slack.gridW &&
		a.slack.gridH === b.slack.gridH;
	if (a.slack && b.slack && !sameGrid) return b;
	const slack = sameGrid
		? { ...b.slack, slackPx: b.slack.slackPx.map((v, i) => Math.max(v, a.slack.slackPx[i])) }
		: b.slack || a.slack;
	const worst = (k) => (a[k] == null ? b[k] : b[k] == null ? a[k] : Math.max(a[k], b[k]));
	return {
		...b,
		frames: (a.frames || 1) + (b.frames || 1),
		spurious: a.spurious + b.spurious,
		beyond: a.beyond + b.beyond,
		medianPx: worst("medianPx"),
		p98Px: worst("p98Px"),
		maxPx: worst("maxPx"),
		slackPx: worst("slackPx"),
		slack,
	};
}

/** A slack map the tone check can apply to a golden of this size: the
 * grid it describes is the grid that tile makes of the golden. */
function slackMapFits(map, width, height) {
	if (!map || typeof map !== "object") return false;
	const { tile, gridW, gridH, slackPx } = map;
	if (!(Number.isInteger(tile) && tile >= 8)) return false;
	if (gridW !== Math.ceil(width / tile) || gridH !== Math.ceil(height / tile)) return false;
	if (!Array.isArray(slackPx) || slackPx.length !== gridW * gridH) return false;
	return slackPx.every((v) => Number.isInteger(v) && v >= 0 && v <= REGISTER_SLACK_MAX);
}

module.exports = {
	refineLocally,
	measureRegister,
	mergeRegister,
	slackMapFits,
	slackLevel,
	SLACK_LEVELS,
	buildDisplacementField,
	fieldRows,
	smoothField,
	applyField,
	applyRows,
	fieldStats,
};
