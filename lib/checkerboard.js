/**
 * Checkerboard-grid detection and pixel-to-mm scale measurement, for the
 * checkerboard-calibrate node.
 *
 * Scope: centroid/pitch-based measurement - no sub-pixel corner
 * refinement and no lens-distortion model. Consistent with this project's
 * fixed-rig scope: this answers "has the scale/geometry drifted since the
 * last calibration," not general camera geometric calibration.
 *
 * The one piece of camera geometry it does measure is the plane
 * homography (measurePerspective): the same square centroids that give
 * the pitch also say how far the camera is off-axis, and that is a
 * property of the rig a production frame can be corrected for once, not
 * something to re-solve per label.
 */

"use strict";

const sharp = require("sharp");
const { otsuThreshold } = require("./threshold.js");
const { connectedComponents } = require("./components.js");
const { dilate } = require("./dilate.js");
const {
	fitSimilarity,
	applySimilarity,
	fitHomography,
	applyHomography,
	reprojection,
} = require("./homography.js");

const DEG = Math.PI / 180;

function median(values) {
	// An empty list has no median: return undefined rather than NaN, so a
	// caller can tell "no data" from "a real number" - NaN propagates
	// silently into downstream math (mm/px scale = pitch/targetPitch)
	// and reads as a successful measurement.
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The two shapes a checkerboard's dark squares can take, given
 * `expectedCols` dark squares in its longest row.
 *
 * A board with an *even* number of square columns puts the same number of
 * dark squares in every row: 16 columns gives 8 per row, whichever colour
 * leads. An *odd* number cannot - 17 columns gives 9 dark squares in the
 * rows that start dark and 8 in the rows that start light - so the rows
 * alternate, beginning with whichever colour the top-left square is.
 *
 * `expectedCols` counts the longest row in both cases, so an even board
 * still means exactly what it always did.
 */
function matchesShape(rows, expectedCols, expectedRows) {
	if (rows.length !== expectedRows) return false;
	if (rows.every((r) => r.length === expectedCols)) return true;
	// A one-square-wide board has no shorter row to alternate with.
	if (expectedCols < 2) return false;
	const lengths = [expectedCols, expectedCols - 1];
	const startsLong = rows[0].length === expectedCols;
	if (!startsLong && rows[0].length !== lengths[1]) return false;
	const offset = startsLong ? 0 : 1;
	return rows.every((r, i) => r.length === lengths[(i + offset) % 2]);
}

/**
 * Fewest dark squares any accepted shape can hold. The blob count is only
 * a fast-fail before the real shape check, so sizing it against the
 * smallest shape keeps an odd-column board from being turned away for
 * "missing" squares it was never going to have.
 */
function minimumSquares(expectedCols, expectedRows) {
	const uniform = expectedCols * expectedRows;
	if (expectedCols < 2) return uniform;
	const long = Math.ceil(expectedRows / 2);
	const short = expectedRows - long;
	return Math.min(
		uniform,
		long * expectedCols + short * (expectedCols - 1),
		long * (expectedCols - 1) + short * expectedCols,
	);
}

/**
 * Find a checkerboard's dark-square centroids and arrange them into a
 * expectedRows x expectedCols grid (row-major, each row sorted by x).
 * Rows of an odd-column board alternate between expectedCols and one
 * fewer - see matchesShape(). Blob candidates are filtered adaptively
 * (relative to the median found blob, not an absolute pixel size) so this
 * works across different checkerboard prints/resolutions without extra
 * config.
 *
 * The mask is eroded by 1px first, on a background-padded copy:
 *  - same-colour squares of a checkerboard touch diagonally at their
 *    corners, and any resampling or blur (the board sitting a couple of
 *    degrees off square, Bayer demosaic, JPEG, a soft lens) smears those
 *    corner contacts into a 1-2px bridge that 4-connected labelling then
 *    merges - a 3-degree rotation merged one pair of squares on this
 *    project's synthetic board, 8 degrees merged three, and the blob
 *    count dropped below the expected grid size. One 3x3 erosion severs
 *    every bridge while shrinking each square symmetrically.
 *  - the padding matters because the erosion is border-clamped: a square
 *    touching the image edge erodes on its inner sides only, shifting its
 *    centroid by half a pixel and corrupting the pitch by ~0.3%. On the
 *    padded copy every square is interior, so centroids (and therefore
 *    the pitch measurement) stay exact.
 *
 * The centroids are then de-rotated (a sweep over plausible board
 * rotations, smallest |angle| first) before row clustering, because the
 * y-gap row grouping only works when rows are horizontal: at 8 degrees
 * the y-drift across a 640px row is ~90px, larger than the gap between
 * rows, and squares from neighbouring rows interleave into garbage rows.
 * Distances are rotation-invariant, so the de-rotated centroids measure
 * the true pitch exactly even when the sweep's angle is off by a fraction
 * of a degree.
 */
function detectGrid(mask, width, height, expectedCols, expectedRows) {
	const expectedCount = minimumSquares(expectedCols, expectedRows);
	const p = 1;
	const pw = width + 2 * p;
	const ph = height + 2 * p;
	const padded = new Uint8Array(pw * ph);
	for (let y = 0; y < height; y++) {
		padded.set(mask.subarray(y * width, (y + 1) * width), (y + p) * pw + p);
	}
	const inv = new Uint8Array(pw * ph);
	for (let i = 0; i < inv.length; i++) inv[i] = padded[i] ? 0 : 1;
	const dilated = dilate(inv, pw, ph, 1);
	for (let i = 0; i < inv.length; i++) padded[i] = dilated[i] ? 0 : 1;

	const rawBlobs = connectedComponents(padded, pw, ph, { minArea: 4 });
	if (rawBlobs.length < expectedCount) {
		return {
			detected: false,
			reason: `found only ${rawBlobs.length} candidate blob(s), need at least ${expectedCount}`,
			centroids: [],
		};
	}

	const areas = rawBlobs.map((b) => b.area);
	const medianArea = median(areas);
	const candidates = rawBlobs.filter((b) => {
		const w = b.x1 - b.x0;
		const h = b.y1 - b.y0;
		const aspect = w / h;
		return (
			b.area > medianArea * 0.3 &&
			b.area < medianArea * 3 &&
			aspect > 0.5 &&
			aspect < 2.0
		);
	});
	if (candidates.length < expectedCount) {
		return {
			detected: false,
			reason: `found ${candidates.length} plausible square(s) after filtering, need ${expectedCount}`,
			centroids: [],
		};
	}

	const cx = width / 2 + p;
	const cy = height / 2 + p;
	const medianHeight = median(candidates.map((b) => b.y1 - b.y0));
	// Sweep rotations outward from 0, cluster each de-rotated set into rows,
	// and require the exact expected shape. The shape check alone is not
	// enough: at residual rotations up to ~15 degrees the within-row y-drift
	// stays below the gap threshold, so several wrong angles also arrange
	// into a clean grid. The true angle is the one that makes the rows
	// horizontal - score every passing candidate by within-row y-variance
	// and keep the minimum (a least-squares fit to the grid rotation in
	// disguise). A residual of under half a degree costs a fraction of a
	// pixel of pitch, so the integer-degree sweep needs no refinement.
	let best = null;
	for (let deg = 0; deg <= 15; deg++) {
		const signs = deg === 0 ? [0] : [1, -1];
		for (const sign of signs) {
			const a = sign * deg * DEG;
			const cosT = Math.cos(a);
			const sinT = Math.sin(a);
			// sx/sy keep the un-rotated image coordinate (padding removed)
			// alongside the de-rotated one: the pitch is measured on x/y,
			// the homography is fitted on sx/sy
			const pts = candidates.map((b) => ({
				x: cx + (b.cx - cx) * cosT - (b.cy - cy) * sinT,
				y: cy + (b.cx - cx) * sinT + (b.cy - cy) * cosT,
				sx: b.cx - p,
				sy: b.cy - p,
			}));
			const rows = clusterRows(pts, medianHeight);
			if (!matchesShape(rows, expectedCols, expectedRows)) continue;
			let variance = 0;
			for (const row of rows) {
				const meanY = row.reduce((s, q) => s + q.y, 0) / row.length;
				for (const q of row) variance += (q.y - meanY) * (q.y - meanY);
			}
			if (!best || variance < best.variance) {
				best = { rows, variance };
			}
		}
	}
	if (best) return { detected: true, centroids: best.rows };

	return {
		detected: false,
		reason:
			`grid shape mismatch: no rotation of ${candidates.length} blob(s) arranges into ` +
			`${expectedRows}x${expectedCols}` +
			(expectedCols >= 2
				? ` (or ${expectedRows} rows alternating ${expectedCols}/${expectedCols - 1})`
				: ""),
		centroids: [],
	};
}

// Sort centroids by y and split into rows wherever the gap to the running
// row average exceeds 0.6x the median square height; then sort each row by
// x. Callers de-rotate first, so rows are horizontal here.
function clusterRows(pts, medianHeight) {
	const byY = [...pts].sort((a, b) => a.y - b.y);
	const rows = [];
	let currentRow = [byY[0]];
	for (let i = 1; i < byY.length; i++) {
		const rowAvgY =
			currentRow.reduce((sum, b) => sum + b.y, 0) / currentRow.length;
		if (byY[i].y - rowAvgY > medianHeight * 0.6) {
			rows.push(currentRow);
			currentRow = [byY[i]];
		} else {
			currentRow.push(byY[i]);
		}
	}
	rows.push(currentRow);
	for (const row of rows) row.sort((a, b) => a.x - b.x);
	return rows;
}

/**
 * Median pixel pitch between adjacent same-color squares, row-wise (x)
 * and column-wise (y). Median rather than mean so one stray misdetection
 * doesn't skew the measurement.
 *
 * Only same-color (dark) squares are detected as blobs, so adjacent
 * *rows* of a real checkerboard are horizontally staggered by one
 * square - detectGrid()'s row r and row r+1 do NOT share x positions.
 * Rows r and r+2 do (the pattern repeats every 2 rows), so the y-pitch
 * is measured two rows apart to match physical squares up - giving a
 * quantity directly comparable to the x-pitch (both "distance between
 * same-color adjacent squares", i.e. two square-widths).
 */
function measurePitch(centroids) {
	const xDiffs = [];
	for (const row of centroids) {
		for (let i = 1; i < row.length; i++) xDiffs.push(row[i].x - row[i - 1].x);
	}
	// Only even-indexed rows are stepped through, and on an odd-column board
	// those all share row 0's length (the alternation has period 2), so this
	// bound stays inside every row it indexes.
	const cols = centroids[0].length;
	const yDiffs = [];
	for (let c = 0; c < cols; c++) {
		for (let r = 2; r < centroids.length; r += 2) {
			yDiffs.push(centroids[r][c].y - centroids[r - 2][c].y);
		}
	}
	return { pitchXPx: median(xDiffs), pitchYPx: median(yDiffs) };
}

/**
 * How far off-axis the camera is, as the homography that flattens it.
 *
 * The detected grid says where each dark square *is*; the pitch says
 * where each one *would be* on a board seen square-on - a lattice with
 * rows `pitchY/2` apart and squares `pitchX` apart along a row, alternate
 * rows shifted by half a pitch. Fitting that lattice to the measured
 * centroids with a similarity (scale, rotation, translation) places the
 * ideal board over the photo without correcting anything; what is left
 * between the two is the perspective. The homography is then fitted from
 * the measured centroids to the placed lattice, so applying it to a frame
 * removes the keystone while leaving position, scale and rotation alone -
 * on a square-on camera it is the identity, and production frames are
 * not moved or rotated for no reason.
 *
 * The lattice takes the two pitches separately on purpose. The rig this
 * was first run on measures pitchY/pitchX = 0.855 - a rectangular print
 * or the camera's own aspect, and one photo cannot say which - and a
 * square lattice turned that into a 10% anisotropic scale in the
 * homography, 46px rms of "keystone" that was nothing of the kind.
 * Aspect is scale, and scale is left alone: golden-compare's independent
 * mx/my absorb it per label, and the mm/px figure already averages it.
 *
 * Reported in pixels, before and after:
 *   rmsBeforePx / maxBeforePx - the perspective itself: how far the
 *     squares sit from where a flat board would put them. Below a pixel
 *     the camera is square-on for practical purposes.
 *   rmsAfterPx / maxAfterPx - what the homography could not explain:
 *     centroid noise and lens distortion. Should be well under a pixel;
 *     if it is not, the board or the photo is the problem, not the rig.
 *   maxCornerShiftPx - how far the homography moves the frame's own
 *     corners, i.e. how much of the edge the rectified frame will lose
 *     to border replication.
 *
 * `centroids` are detectGrid's rows, each point carrying both the
 * de-rotated (x, y) and the source (sx, sy) coordinate.
 */
function measurePerspective(centroids, pitchXPx, pitchYPx, width, height) {
	const halfX = pitchXPx / 2;
	const halfY = pitchYPx / 2;
	const ideal = [];
	const source = [];
	const x0 = centroids[0][0].x;
	for (let r = 0; r < centroids.length; r++) {
		const row = centroids[r];
		// each row is offset from row 0 by a whole number of half pitches
		// (0 or +/-1 on a real board); read it off the de-rotated first
		// square rather than assuming which colour leads
		const k = Math.round((row[0].x - x0) / halfX);
		for (let c = 0; c < row.length; c++) {
			ideal.push({ x: c * pitchXPx + k * halfX, y: r * halfY });
			source.push({ x: row[c].sx, y: row[c].sy });
		}
	}
	const sim = fitSimilarity(ideal, source);
	const target = ideal.map((p) => applySimilarity(sim, p));
	const before = reprojection([1, 0, 0, 0, 1, 0, 0, 0, 1], source, target);
	const homography = fitHomography(source, target);
	const after = reprojection(homography, source, target);
	let maxCornerShiftPx = 0;
	for (const [x, y] of [
		[0, 0],
		[width, 0],
		[0, height],
		[width, height],
	]) {
		const q = applyHomography(homography, x, y);
		maxCornerShiftPx = Math.max(maxCornerShiftPx, Math.hypot(q.x - x, q.y - y));
	}
	return {
		homography,
		rmsBeforePx: before.rms,
		maxBeforePx: before.max,
		rmsAfterPx: after.rms,
		maxAfterPx: after.max,
		maxCornerShiftPx,
		boardAngleDeg: sim.angleDeg,
		points: source.length,
	};
}

function computeScale(pitchXPx, pitchYPx, targetPitchMm) {
	const avgPitchPx = (pitchXPx + pitchYPx) / 2;
	return targetPitchMm / avgPitchPx;
}

/**
 * End-to-end: decode -> Otsu threshold -> detect grid -> measure pitch ->
 * mm/px scale, at the image's native (undownscaled) resolution for
 * maximum measurement precision.
 */
async function measureCheckerboard(buffer, cfg) {
	const { data, info } = await sharp(buffer)
		.removeAlpha()
		.grayscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { width, height } = info;

	const threshold = otsuThreshold(data);
	// Otsu's class B (accumulated into weightB above) is "value <= threshold",
	// so foreground must be selected inclusively here - a strict "<" would
	// misclassify every pixel when the histogram is a two-spike extreme
	// (e.g. a clean synthetic black/white checkerboard with threshold 0).
	const mask = new Uint8Array(width * height);
	for (let i = 0; i < data.length; i++) mask[i] = data[i] <= threshold ? 1 : 0;

	const grid = detectGrid(
		mask,
		width,
		height,
		cfg.checkerboardCols,
		cfg.checkerboardRows,
	);
	if (!grid.detected) {
		return { detected: false, reason: grid.reason, width, height, threshold };
	}

	const { pitchXPx, pitchYPx } = measurePitch(grid.centroids);
	// A grid that is too thin to measure (fewer than 3 rows, or fewer
	// than 2 columns, leaves one of the diff lists empty and its pitch
	// undefined) must not report detected:true - a NaN mm/px scale would
	// be saved as a baseline and silently disable the mm position gate.
	if (
		!(pitchXPx > 0) ||
		!Number.isFinite(pitchXPx) ||
		!(pitchYPx > 0) ||
		!Number.isFinite(pitchYPx)
	) {
		return {
			detected: false,
			reason:
				`could not measure a finite pitch from the detected grid ` +
				`(pitchX=${pitchXPx}, pitchY=${pitchYPx}) - use a grid with at least 2 ` +
				`columns and 3 rows of dark squares`,
			width,
			height,
			threshold,
		};
	}
	const mmPerPixel = computeScale(pitchXPx, pitchYPx, cfg.targetPitchMm);
	const perspective = measurePerspective(
		grid.centroids,
		pitchXPx,
		pitchYPx,
		width,
		height,
	);
	return {
		detected: true,
		width,
		height,
		threshold,
		pitchXPx,
		pitchYPx,
		mmPerPixel,
		perspective,
	};
}

module.exports = {
	otsuThreshold,
	detectGrid,
	measurePitch,
	measurePerspective,
	computeScale,
	measureCheckerboard,
};
