/**
 * Caliper line finder: find a straight edge inside a user-drawn search
 * region.
 *
 * Why this exists (see ARCHITECTURE.md "line-finder"):
 *
 * `lib/labelCrop.js` finds the label by thresholding the whole frame and
 * taking the dominant blob. That works when the part sits on a
 * contrasting background. It does not work when the *strongest* edge
 * near the boundary belongs to the artwork rather than to the part: on
 * the Inspection rig the label's own boundary is a 4-10 grey-level step
 * while the printed rules a few millimetres inside it are 25-90, so the
 * global search locks onto the print and the resulting rectangle swings
 * by half its area from frame to frame.
 *
 * A caliper finder removes the ambiguity by construction. The operator
 * draws a box over the edge they mean; nothing outside that box can win.
 * The contrast that matters is then the only contrast in the search.
 *
 * The method, per region:
 *
 *  1. Sample the region in its own (scan, line) axes with bilinear
 *     interpolation, so a rotated region costs no extra code path.
 *  2. Split the line axis into `calipers` bands and average each band
 *     across its full width. Averaging is the whole trick: a 4-level
 *     step under 3 levels of sensor noise is invisible in one row and
 *     obvious across two hundred.
 *  3. Smooth each band's profile, differentiate it, and take the
 *     extremum that matches the configured polarity - with parabolic
 *     sub-pixel interpolation, since a half-pixel bias over a 3000px
 *     frame is a millimetre of crop error.
 *  4. Fit a line to the caliper points by total least squares, dropping
 *     outliers, so one caliper that found a speck of dirt cannot tilt
 *     the result.
 *
 * Pure JS on a grayscale raster: no OpenCV engine, no image decode. That
 * keeps it unit-testable on any platform (the bridge ships no
 * win32 binary) and cheap enough to run four times per frame, since only
 * the region's own pixels are ever touched.
 */

"use strict";

const DEG = Math.PI / 180;

const SCAN_DIRECTIONS = ["right", "left", "down", "up"];
const POLARITIES = ["either", "darkToLight", "lightToDark"];
const EDGE_SELECTS = ["best", "first", "last"];

const DEFAULTS = {
	// which way the calipers travel across the region; the edge being
	// found is perpendicular to this
	scanDirection: "right",
	// darkToLight/lightToDark are named for what the caliper sees as it
	// travels *along* scanDirection
	polarity: "either",
	// how many independent scans across the region's length
	calipers: 16,
	// grey levels per pixel of travel the step must reach; below this a
	// caliper reports nothing rather than guessing
	contrastThreshold: 2,
	// box-smoothing half-width applied to each profile before
	// differentiating, in scan pixels
	filterHalfWidth: 2,
	// which candidate to keep when a caliper sees several qualifying edges
	edgeSelect: "best",
	// skip this many qualifying edges before selecting; lets an operator
	// step past a known first edge (a frame vignette, say)
	ignoreCount: 0,
	// a caliper point further than this from the fitted line is dropped
	outlierTolerancePx: 2.5,
	// fraction of calipers that must survive the fit for a "found"
	minCaliperFraction: 0.5,
	// reject a fit that leans this far from the region's own orientation;
	// null disables the check
	angleToleranceDeg: 10,
};

function finiteOr(value, fallback) {
	const n = typeof value === "number" ? value : Number.parseFloat(value);
	return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
	return Math.min(hi, Math.max(lo, value));
}

/** Fill in and range-check a caller's options. */
function normalizeCfg(cfg = {}) {
	const out = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS)) {
		if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== "") out[k] = cfg[k];
	}
	// angleToleranceDeg is the one option whose "off" value is null, so a
	// caller passing null has to reach it - the loop above cannot, since
	// for every other option null means "not supplied, use the default".
	if (cfg.angleToleranceDeg === null || cfg.angleToleranceDeg === "") {
		out.angleToleranceDeg = null;
	}
	if (!SCAN_DIRECTIONS.includes(out.scanDirection)) {
		out.scanDirection = DEFAULTS.scanDirection;
	}
	if (!POLARITIES.includes(out.polarity)) out.polarity = DEFAULTS.polarity;
	if (!EDGE_SELECTS.includes(out.edgeSelect)) out.edgeSelect = DEFAULTS.edgeSelect;
	out.calipers = clamp(
		Math.round(finiteOr(out.calipers, DEFAULTS.calipers)),
		1,
		512,
	);
	out.contrastThreshold = clamp(
		finiteOr(out.contrastThreshold, DEFAULTS.contrastThreshold),
		0,
		255,
	);
	out.filterHalfWidth = clamp(
		Math.round(finiteOr(out.filterHalfWidth, DEFAULTS.filterHalfWidth)),
		0,
		64,
	);
	out.ignoreCount = clamp(
		Math.round(finiteOr(out.ignoreCount, DEFAULTS.ignoreCount)),
		0,
		64,
	);
	out.outlierTolerancePx = clamp(
		finiteOr(out.outlierTolerancePx, DEFAULTS.outlierTolerancePx),
		0.1,
		1000,
	);
	out.minCaliperFraction = clamp(
		finiteOr(out.minCaliperFraction, DEFAULTS.minCaliperFraction),
		0.05,
		1,
	);
	out.angleToleranceDeg =
		out.angleToleranceDeg == null
			? null
			: clamp(finiteOr(out.angleToleranceDeg, DEFAULTS.angleToleranceDeg), 0, 90);
	return out;
}

/**
 * Normalise a search region.
 *
 * `{ x, y, width, height }` is the un-rotated box with (x, y) its
 * top-left corner; `angleDeg` then rotates it clockwise about its own
 * centre (clockwise because image y runs downwards, so this matches what
 * an operator sees when they rotate the box in the editor).
 */
function normalizeRegion(region) {
	if (!region || typeof region !== "object") {
		throw new Error("line-finder: region must be { x, y, width, height }");
	}
	const x = finiteOr(region.x, Number.NaN);
	const y = finiteOr(region.y, Number.NaN);
	const width = finiteOr(region.width, Number.NaN);
	const height = finiteOr(region.height, Number.NaN);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error("line-finder: region needs finite x and y");
	}
	if (!(width > 0) || !(height > 0)) {
		throw new Error("line-finder: region needs positive width and height");
	}
	return {
		x,
		y,
		width,
		height,
		angleDeg: finiteOr(region.angleDeg, 0),
		cx: x + width / 2,
		cy: y + height / 2,
	};
}

/**
 * Region-local frame for a scan direction.
 *
 * `scan` is the unit vector the calipers travel along, `line` the unit
 * vector the edge is expected to run along, and `origin` the image point
 * where (scan=0, line=0) sits. `depth`/`length` are the region's extents
 * along those two axes.
 */
function regionFrame(region, scanDirection) {
	const a = region.angleDeg * DEG;
	const ca = Math.cos(a);
	const sa = Math.sin(a);
	// the region's own axes in image coordinates
	const ex = { x: ca, y: sa }; // local +x
	const ey = { x: -sa, y: ca }; // local +y
	const hw = region.width / 2;
	const hh = region.height / 2;

	// `start` is the local-space corner the scan starts from; scan/line
	// the image-space unit vectors it advances along.
	let scan;
	let line;
	let depth;
	let length;
	let start;
	switch (scanDirection) {
		case "right":
			scan = ex;
			line = ey;
			depth = region.width;
			length = region.height;
			start = { u: -hw, v: -hh };
			break;
		case "left":
			scan = { x: -ex.x, y: -ex.y };
			line = ey;
			depth = region.width;
			length = region.height;
			start = { u: hw, v: -hh };
			break;
		case "down":
			scan = ey;
			line = ex;
			depth = region.height;
			length = region.width;
			start = { u: -hw, v: -hh };
			break;
		default: // "up"
			scan = { x: -ey.x, y: -ey.y };
			line = ex;
			depth = region.height;
			length = region.width;
			start = { u: -hw, v: hh };
			break;
	}
	// start corner in image coordinates
	const origin = {
		x: region.cx + start.u * ex.x + start.v * ey.x,
		y: region.cy + start.u * ex.y + start.v * ey.y,
	};
	return { scan, line, origin, depth, length };
}

/**
 * The region's four corners in image coordinates, in scan order:
 * [scan-start/line-start, scan-end/line-start, scan-end/line-end,
 * scan-start/line-end]. Exported so a preview can draw the box the
 * operator actually configured, rather than an axis-aligned
 * approximation of it that would hide a rotation mistake.
 */
function regionCorners(region, scanDirection = DEFAULTS.scanDirection) {
	const reg = normalizeRegion(region);
	const f = regionFrame(reg, scanDirection);
	const at = (u, v) => ({
		x: f.origin.x + f.scan.x * u + f.line.x * v,
		y: f.origin.y + f.scan.y * u + f.line.y * v,
	});
	return [at(0, 0), at(f.depth, 0), at(f.depth, f.length), at(0, f.length)];
}

/** Bilinear sample; returns NaN outside the image so callers can skip. */
function sampleBilinear(gray, width, height, x, y) {
	if (!(x >= 0) || !(y >= 0) || x > width - 1 || y > height - 1) return Number.NaN;
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, width - 1);
	const y1 = Math.min(y0 + 1, height - 1);
	const fx = x - x0;
	const fy = y - y0;
	const row0 = y0 * width;
	const row1 = y1 * width;
	const a = gray[row0 + x0] * (1 - fx) + gray[row0 + x1] * fx;
	const b = gray[row1 + x0] * (1 - fx) + gray[row1 + x1] * fx;
	return a * (1 - fy) + b * fy;
}

/** Box-smooth a profile into a new array (the input itself when halfWidth is 0). */
function smooth(profile, halfWidth) {
	if (halfWidth <= 0) return profile;
	const n = profile.length;
	const out = new Float64Array(n);
	// prefix sums keep this O(n) regardless of the window size
	const sum = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + profile[i];
	for (let i = 0; i < n; i++) {
		const lo = Math.max(0, i - halfWidth);
		const hi = Math.min(n, i + halfWidth + 1);
		out[i] = (sum[hi] - sum[lo]) / (hi - lo);
	}
	return out;
}

/**
 * Candidate edges in one profile, as { at, strength } with `at` in
 * profile samples and `strength` signed (positive = brighter along the
 * scan). Candidates are local extrema of the first derivative, which is
 * where the step is steepest.
 */
function findEdges(profile, cfg) {
	const n = profile.length;
	if (n < 3) return [];
	const d = new Float64Array(n);
	// central difference: the derivative sits on the sample, not between
	// two of them, which keeps the parabolic refinement below unbiased
	for (let i = 1; i < n - 1; i++) d[i] = (profile[i + 1] - profile[i - 1]) / 2;

	const wantSign =
		cfg.polarity === "darkToLight" ? 1 : cfg.polarity === "lightToDark" ? -1 : 0;
	const out = [];
	for (let i = 2; i < n - 2; i++) {
		const v = d[i];
		if (wantSign !== 0 && Math.sign(v) !== wantSign) continue;
		const mag = Math.abs(v);
		if (mag < cfg.contrastThreshold) continue;
		// strict on one side, non-strict on the other, so a plateau of
		// equal derivatives yields exactly one candidate
		if (mag < Math.abs(d[i - 1]) || mag <= Math.abs(d[i + 1])) continue;
		// parabolic refinement on |d| through the peak and its neighbours
		const y0 = Math.abs(d[i - 1]);
		const y1 = mag;
		const y2 = Math.abs(d[i + 1]);
		const denom = y0 - 2 * y1 + y2;
		const offset = denom === 0 ? 0 : clamp((0.5 * (y0 - y2)) / denom, -1, 1);
		out.push({ at: i + offset, strength: v, magnitude: mag });
	}
	return out;
}

/** Apply ignoreCount + edgeSelect to one caliper's candidate list. */
function selectEdge(candidates, cfg) {
	if (candidates.length === 0) return null;
	// `first`/`last` are in scan order; `best` is by contrast. ignoreCount
	// always steps along scan order, which is what "skip the vignette"
	// means to an operator.
	const ordered = candidates.slice().sort((a, b) => a.at - b.at);
	const remaining = ordered.slice(cfg.ignoreCount);
	if (remaining.length === 0) return null;
	if (cfg.edgeSelect === "first") return remaining[0];
	if (cfg.edgeSelect === "last") return remaining[remaining.length - 1];
	let best = remaining[0];
	for (const c of remaining) if (c.magnitude > best.magnitude) best = c;
	return best;
}

/**
 * Total-least-squares line through points, as a centroid plus a unit
 * direction. Ordinary least squares cannot represent a vertical line, and
 * two of the four edges of an upright label are vertical.
 */
function fitLine(points) {
	const n = points.length;
	let sx = 0;
	let sy = 0;
	for (const p of points) {
		sx += p.x;
		sy += p.y;
	}
	const cx = sx / n;
	const cy = sy / n;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of points) {
		const dx = p.x - cx;
		const dy = p.y - cy;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	// principal axis of the scatter matrix
	const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	return { cx, cy, dx: Math.cos(theta), dy: Math.sin(theta) };
}

/** Signed distance from a point to a fitted line (left of it is positive). */
function distanceTo(line, p) {
	return -line.dy * (p.x - line.cx) + line.dx * (p.y - line.cy);
}

/**
 * Per-band mean profiles along the scan axis.
 *
 * Each band averages its whole slice of the region before anything looks for
 * an edge in it, and that averaging is the sensitivity: a four-grey-level
 * step is invisible in one row and unambiguous across a hundred and seventy
 * five. Returns one entry per band - a Float64Array of `scanSteps` means, or
 * null for a band that is not wholly inside the image, since a band with a
 * moving sample count would have a step where the coverage changes rather
 * than where the edge is.
 */
function profilesGeneral(gray, width, height, frame, geom) {
	const { bands, scanSteps, bandLength, rowsPerBand } = geom;
	const out = new Array(bands);
	for (let b = 0; b < bands; b++) {
		const profile = new Float64Array(scanSteps);
		const counts = new Float64Array(scanSteps);
		for (let r = 0; r < rowsPerBand; r++) {
			// centre of row r within band b, along the line axis
			const v = bandLength * b + ((r + 0.5) * bandLength) / rowsPerBand;
			const baseX = frame.origin.x + frame.line.x * v;
			const baseY = frame.origin.y + frame.line.y * v;
			for (let s = 0; s < scanSteps; s++) {
				const u = (s + 0.5) * (frame.depth / scanSteps);
				const px = baseX + frame.scan.x * u;
				const py = baseY + frame.scan.y * u;
				const value = sampleBilinear(gray, width, height, px, py);
				if (Number.isNaN(value)) continue;
				profile[s] += value;
				counts[s] += 1;
			}
		}
		let complete = true;
		for (let s = 0; s < scanSteps; s++) {
			if (counts[s] < rowsPerBand) {
				complete = false;
				break;
			}
			profile[s] /= counts[s];
		}
		out[b] = complete ? profile : null;
	}
	return out;
}

/**
 * The same numbers for a region whose axes are the image's, which is every
 * unrotated region - all four edges of an upright label included.
 *
 * The interpolation cannot be skipped even then: the scan samples at
 * (s + 0.5) while sampleBilinear puts pixel centres on whole numbers, so
 * every sample sits between two columns and dropping the blend would move
 * every measurement half a pixel. What it can skip is the *bookkeeping*.
 * Position along the scan axis depends only on s, so each step's two
 * neighbours and their weight are resolved once for the whole region rather
 * than once per sample, and the cross-axis pair is resolved once per row.
 * That leaves four array reads in the inner loop instead of a call that
 * recomputes two floors and a bounds test every time - measured at 2.2x on
 * this rig's four regions, and bit-identical to profilesGeneral, which
 * test/lineFinderSampling.test.js checks value by value.
 */
function profilesAxisAligned(gray, width, height, frame, geom) {
	const { bands, scanSteps, bandLength, rowsPerBand } = geom;
	const stepU = frame.depth / scanSteps;
	// which image axis the calipers travel along; the other one is the line
	// axis the bands are stacked along
	const alongX = frame.scan.y === 0;
	const scanLimit = (alongX ? width : height) - 1;
	const crossLimit = (alongX ? height : width) - 1;
	const scanBase = alongX ? frame.origin.x : frame.origin.y;
	const scanDir = alongX ? frame.scan.x : frame.scan.y;
	const crossBase = alongX ? frame.origin.y : frame.origin.x;
	const crossDir = alongX ? frame.line.y : frame.line.x;

	const lo = new Int32Array(scanSteps);
	const hi = new Int32Array(scanSteps);
	const frac = new Float64Array(scanSteps);
	for (let s = 0; s < scanSteps; s++) {
		const p = scanBase + scanDir * ((s + 0.5) * stepU);
		if (!(p >= 0) || p > scanLimit) {
			// off the image along the scan: every row would be NaN there, so no
			// band can be complete
			return new Array(bands).fill(null);
		}
		const f = Math.floor(p);
		lo[s] = f;
		hi[s] = Math.min(f + 1, scanLimit);
		frac[s] = p - f;
	}

	const out = new Array(bands);
	for (let b = 0; b < bands; b++) {
		const profile = new Float64Array(scanSteps);
		let rows = 0;
		for (let r = 0; r < rowsPerBand; r++) {
			const v = bandLength * b + ((r + 0.5) * bandLength) / rowsPerBand;
			const q = crossBase + crossDir * v;
			if (!(q >= 0) || q > crossLimit) continue;
			const q0 = Math.floor(q);
			const q1 = Math.min(q0 + 1, crossLimit);
			const fq = q - q0;
			const gq = 1 - fq;
			rows++;
			if (alongX) {
				const rowA = q0 * width;
				const rowB = q1 * width;
				for (let s = 0; s < scanSteps; s++) {
					const f = frac[s];
					const g = 1 - f;
					const a = gray[rowA + lo[s]] * g + gray[rowA + hi[s]] * f;
					const c = gray[rowB + lo[s]] * g + gray[rowB + hi[s]] * f;
					profile[s] += a * gq + c * fq;
				}
			} else {
				// the calipers run down a column, so lo/hi are rows and the
				// interpolation pair q0/q1 are columns
				for (let s = 0; s < scanSteps; s++) {
					const f = frac[s];
					const rowA = lo[s] * width;
					const rowB = hi[s] * width;
					const a = gray[rowA + q0] * gq + gray[rowA + q1] * fq;
					const c = gray[rowB + q0] * gq + gray[rowB + q1] * fq;
					profile[s] += a * (1 - f) + c * f;
				}
			}
		}
		if (rows < rowsPerBand) {
			out[b] = null;
			continue;
		}
		for (let s = 0; s < scanSteps; s++) profile[s] /= rows;
		out[b] = profile;
	}
	return out;
}

/**
 * True when the region's own axes are the image's, so the cheap profile
 * builder applies. Tested on the frame vectors rather than on the angle
 * because that is exactly what the fast path relies on, and because only an
 * angle of 0 gives exact axis alignment - Math.sin(Math.PI) is 1.2e-16, not
 * zero, and a snapped angle would no longer be bit-identical.
 */
function isAxisAligned(frame) {
	return (
		(frame.scan.x === 0 || frame.scan.y === 0) &&
		(frame.line.x === 0 || frame.line.y === 0)
	);
}

/**
 * Find one straight edge inside `region`.
 *
 * @param {Uint8Array|Uint8ClampedArray} gray single-channel image
 * @param {number} width image width
 * @param {number} height image height
 * @param {object} region { x, y, width, height, angleDeg? }
 * @param {object} [cfg] see DEFAULTS
 * @returns {object} { found, reason, line, angleDeg, score, calipers,
 *   residualPx, points }
 */
function findLine(gray, width, height, region, cfg = {}) {
	const opts = normalizeCfg(cfg);
	const reg = normalizeRegion(region);
	const frame = regionFrame(reg, opts.scanDirection);

	const scanSteps = Math.max(5, Math.round(frame.depth));
	const bands = opts.calipers;
	// Enough rows per band that averaging actually buys noise rejection,
	// but never fewer than one.
	const bandLength = frame.length / bands;
	const rowsPerBand = Math.max(1, Math.round(bandLength));

	const geom = { bands, scanSteps, bandLength, rowsPerBand };
	const profiles = isAxisAligned(frame)
		? profilesAxisAligned(gray, width, height, frame, geom)
		: profilesGeneral(gray, width, height, frame, geom);

	const points = [];
	let found = 0;
	for (let b = 0; b < bands; b++) {
		// null means the band was not wholly inside the image
		const profile = profiles[b];
		if (!profile) continue;

		const edge = selectEdge(
			findEdges(smooth(profile, opts.filterHalfWidth), opts),
			opts,
		);
		if (!edge) continue;
		found++;
		// back to image coordinates: the edge sits `u` along the scan axis
		// from this band's start point
		const u = (edge.at + 0.5) * (frame.depth / scanSteps);
		const v = bandLength * (b + 0.5);
		points.push({
			x: frame.origin.x + frame.line.x * v + frame.scan.x * u,
			y: frame.origin.y + frame.line.y * v + frame.scan.y * u,
			contrast: Math.abs(edge.strength),
			strength: edge.strength,
			band: b,
			used: true,
		});
	}

	const minUsed = Math.max(2, Math.ceil(bands * opts.minCaliperFraction));
	const miss = (reason, usedCount = 0) => ({
		found: false,
		reason,
		line: null,
		angleDeg: null,
		score: 0,
		calipers: { total: bands, found, used: usedCount },
		residualPx: null,
		points,
	});
	if (points.length < 2) return miss("no-edge");
	if (points.length < minUsed) return miss("too-few-calipers");

	// Peel the single worst point per pass rather than every point over
	// tolerance at once. One caliper that landed on a speck drags the
	// first fit far enough that a batch trim rejects the *inliers* too -
	// they are all on the same side of a line the outlier tilted - and the
	// finder then throws away a perfectly good edge. Removing one at a
	// time cannot do that, and is deterministic, which RANSAC is not.
	// The inlier fraction here is high by construction (the operator drew
	// the box around one edge), so no sampling method is needed.
	let used = points.slice();
	let line = fitLine(used);
	while (used.length > minUsed) {
		let worst = -1;
		let worstAt = -1;
		for (let i = 0; i < used.length; i++) {
			const d = Math.abs(distanceTo(line, used[i]));
			if (d > worst) {
				worst = d;
				worstAt = i;
			}
		}
		if (worst <= opts.outlierTolerancePx) break;
		used.splice(worstAt, 1);
		line = fitLine(used);
	}
	const usedSet = new Set(used.map((p) => p.band));
	for (const p of points) p.used = usedSet.has(p.band);

	let sq = 0;
	for (const p of used) {
		const d = distanceTo(line, p);
		sq += d * d;
	}
	const residualPx = Math.sqrt(sq / used.length);

	// Report the angle of the fitted line, folded to (-90, 90].
	const fold = (deg) => {
		while (deg > 90) deg -= 180;
		while (deg <= -90) deg += 180;
		return deg;
	};
	const angleDeg = fold(Math.atan2(line.dy, line.dx) / DEG);

	if (opts.angleToleranceDeg != null) {
		// the orientation the region says to expect, folded the same way
		const expected = fold(Math.atan2(frame.line.y, frame.line.x) / DEG);
		let delta = Math.abs(angleDeg - expected);
		if (delta > 90) delta = 180 - delta;
		if (delta > opts.angleToleranceDeg) {
			return { ...miss("angle-out-of-tolerance", used.length), angleDeg };
		}
	}

	// Score blends coverage with fit quality: a line found by half the
	// calipers, or one they only loosely agree on, is worth reporting but
	// not worth trusting as much as a tight full-length fit.
	const coverage = used.length / bands;
	const tightness = 1 / (1 + residualPx / opts.outlierTolerancePx);
	const score = clamp(coverage * tightness, 0, 1);

	// Endpoints clipped to the region's length, for drawing and for
	// intersecting with a neighbouring edge.
	const half = frame.length / 2;
	const midV = { x: frame.origin.x + frame.line.x * half, y: frame.origin.y + frame.line.y * half };
	const t = (midV.x - line.cx) * line.dx + (midV.y - line.cy) * line.dy;
	const mid = { x: line.cx + line.dx * t, y: line.cy + line.dy * t };
	return {
		found: true,
		reason: "ok",
		line: {
			// a point on the line and a unit direction along it
			x: line.cx,
			y: line.cy,
			dx: line.dx,
			dy: line.dy,
			p0: { x: mid.x - line.dx * half, y: mid.y - line.dy * half },
			p1: { x: mid.x + line.dx * half, y: mid.y + line.dy * half },
		},
		angleDeg,
		score,
		calipers: { total: bands, found, used: used.length },
		residualPx,
		points,
	};
}

/**
 * Intersection of two fitted lines, or null when they are near-parallel.
 * `line` is the shape `findLine` returns on `result.line`.
 */
function intersectLines(a, b) {
	const denom = a.dx * -b.dy - a.dy * -b.dx;
	// ~0.5 degrees; below this the intersection point is numerically
	// meaningless and a corner built from it would be worse than no corner
	if (Math.abs(denom) < 1e-3) return null;
	const rx = b.x - a.x;
	const ry = b.y - a.y;
	const t = (rx * -b.dy - ry * -b.dx) / denom;
	return { x: a.x + a.dx * t, y: a.y + a.dy * t };
}

/**
 * Turn four found edges into the oriented rectangle they bound.
 *
 * Takes `{ left, right, top, bottom }` of `findLine` results and returns
 * the rectangle in the form `lib/labelCrop.js` already rotates and crops
 * with: centre, size, angle and the four corners.
 */
function rectFromLines(edges) {
	const { left, right, top, bottom } = edges;
	const missing = Object.keys(edges).filter((k) => !edges[k] || !edges[k].found);
	if (missing.length) {
		return { ok: false, reason: `missing-edge:${missing.join("+")}`, missing };
	}
	const tl = intersectLines(left.line, top.line);
	const tr = intersectLines(right.line, top.line);
	const br = intersectLines(right.line, bottom.line);
	const bl = intersectLines(left.line, bottom.line);
	if (!tl || !tr || !br || !bl) {
		return { ok: false, reason: "parallel-edges", missing: [] };
	}
	const corners = [tl, tr, br, bl];
	const cx = (tl.x + tr.x + br.x + bl.x) / 4;
	const cy = (tl.y + tr.y + br.y + bl.y) / 4;
	// Width from the two horizontal spans, height from the two vertical
	// ones: averaging both sides cancels the residual tilt each edge
	// carries, which a single span would bake into the crop.
	const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
	const w = (dist(tl, tr) + dist(bl, br)) / 2;
	const h = (dist(tl, bl) + dist(tr, br)) / 2;
	// The rectangle's angle is the top/bottom edges' shared orientation;
	// take the mean so neither edge alone decides the deskew.
	const angleDeg = (top.angleDeg + bottom.angleDeg) / 2;
	const score = Math.min(left.score, right.score, top.score, bottom.score);
	return {
		ok: true,
		reason: "ok",
		cx,
		cy,
		width: w,
		height: h,
		angleDeg,
		corners,
		score,
		residualPx: Math.max(
			left.residualPx,
			right.residualPx,
			top.residualPx,
			bottom.residualPx,
		),
	};
}

module.exports = {
	findLine,
	intersectLines,
	rectFromLines,
	regionCorners,
	// exported for tests
	normalizeCfg,
	normalizeRegion,
	regionFrame,
	profilesGeneral,
	profilesAxisAligned,
	isAxisAligned,
	findEdges,
	fitLine,
	DEFAULTS,
	SCAN_DIRECTIONS,
	POLARITIES,
	EDGE_SELECTS,
};
