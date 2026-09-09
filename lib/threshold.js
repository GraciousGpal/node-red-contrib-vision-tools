/**
 * Foreground (ink) thresholding strategies.
 *
 * "Foreground" is always the dark side: ink/print/marks on a lighter
 * substrate.
 *
 *  - "fixed"    - one hand-set grey level. Fastest and perfectly
 *                 repeatable, but it silently drifts out of calibration
 *                 with the lighting: a slightly darker exposure turns
 *                 substrate into ink and floods the background check.
 *  - "otsu"     - one level per image, chosen to maximally separate the
 *                 two intensity modes. Absorbs uniform exposure changes,
 *                 which is the common failure on a production line where
 *                 lamps age and ambient light shifts.
 *  - "sauvola"  - a per-pixel level from the local mean and standard
 *                 deviation. Absorbs *gradients* (one edge of the part
 *                 lit brighter than the other), which a single global
 *                 level cannot. In blank regions the local deviation
 *                 collapses, so the threshold sinks well below the local
 *                 mean and the substrate is correctly left as background
 *                 - that property is why this beats a plain local-mean
 *                 threshold, which speckles blank areas with noise.
 *
 * Otsu and Sauvola both make golden and target independently
 * self-normalizing, which is the point: they no longer have to have been
 * shot under identical light to be comparable.
 *
 * Whichever mode is used, the decision is still a hard cut, and features
 * that sit near the level land arbitrarily on one side of it. That is not
 * hypothetical: comparing PDF artwork against a photograph of the print,
 * a screened tint renders light in the PDF (above its level, so not ink)
 * and prints heavier through dot gain (below its level, so ink). The
 * design element is identical; only the quantization differs.
 *
 * Worse, the level itself is not stable. Otsu re-derives it from each
 * image's histogram, and the histogram changes with resolution: on this
 * project's artwork the level walks from 160 at workingSize 1024 down to
 * 145 at 3072, which is enough to flip a solid grey "RX" panel sitting at
 * 155 from ink to background and light up a whole region of false extra
 * ink. Neither side is wrong; the panel is simply too close to the cut
 * for the cut to mean anything.
 *
 * So each threshold also reports an `ambiguous` mask - pixels within
 * `cfg.inkMargin` grey levels of the level they were judged against, on
 * *either* side of it. Both blemish checks drop a pixel from the evidence
 * when either image is ambiguous there. See computeExtraInkDefect in
 * compare.js.
 */

"use strict";

const { buildIntegral, blockSum } = require("./integral.js");
const { allocU8 } = require("./shared.js");

/** Standard histogram-based Otsu: the level maximizing between-class variance. */
function otsuThreshold(gray) {
	const hist = new Uint32Array(256);
	for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
	const total = gray.length;

	let sumAll = 0;
	for (let t = 0; t < 256; t++) sumAll += t * hist[t];

	let sumB = 0;
	let weightB = 0;
	let maxVariance = 0;
	let threshold = 0;
	for (let t = 0; t < 256; t++) {
		weightB += hist[t];
		if (weightB === 0) continue;
		const weightF = total - weightB;
		if (weightF === 0) break;
		sumB += t * hist[t];
		const meanB = sumB / weightB;
		const meanF = (sumAll - sumB) / weightF;
		const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
		if (variance > maxVariance) {
			maxVariance = variance;
			threshold = t;
		}
	}
	return threshold;
}

/** foreground = dark pixels, against one global level. */
function thresholdFgFixed(gray, level) {
	const n = gray.length;
	const out = allocU8(n);
	for (let i = 0; i < n; i++) out[i] = gray[i] < level ? 1 : 0;
	return out;
}

/**
 * Pixels too close to a global level for the level to have decided
 * anything: within `margin` grey levels either side. Null when the margin
 * is disabled, so callers can skip the test entirely rather than walk an
 * all-zero mask.
 */
function ambiguousFixed(gray, level, margin) {
	if (!(margin > 0)) return null;
	const n = gray.length;
	const out = allocU8(n);
	const lo = level - margin;
	const hi = level + margin;
	for (let i = 0; i < n; i++) {
		const v = gray[i];
		out[i] = v >= lo && v <= hi ? 1 : 0;
	}
	return out;
}

// Sum of squares needs more range than a Uint32 integral gives
// (n*255^2 overflows past ~66k pixels), and Float32's 24-bit mantissa
// loses the low bits that the corner-subtraction depends on - so the
// squares table is Float64.
function buildSquaredIntegral(gray, width, height) {
	const stride = width + 1;
	const integral = new Float64Array(stride * (height + 1));
	for (let y = 0; y < height; y++) {
		let rowSum = 0;
		const srcRow = y * width;
		const intRow = (y + 1) * stride;
		const intPrevRow = y * stride;
		for (let x = 0; x < width; x++) {
			const v = gray[srcRow + x];
			rowSum += v * v;
			integral[intRow + x + 1] = integral[intPrevRow + x + 1] + rowSum;
		}
	}
	return { integral, stride, width, height };
}

/**
 * Sauvola: T(x,y) = m * (1 + k*(s/R - 1)), with m/s the local mean and
 * standard deviation over a (2r+1)^2 window and R=128 the dynamic-range
 * normalizer. Both windows come from integral images, so cost is
 * O(width*height) independent of the radius.
 */
function thresholdFgSauvola(gray, width, height, radius, k, margin) {
	const sum = buildIntegral(gray, width, height);
	const sqSum = buildSquaredIntegral(gray, width, height);
	const out = new Uint8Array(width * height);
	// the level is per-pixel here, so "too close to call" has to be decided
	// inside the loop - there is no single level to compare against after
	const ambiguous = margin > 0 ? new Uint8Array(width * height) : null;
	const R = 128;
	for (let y = 0; y < height; y++) {
		const y0 = y - radius;
		const y1 = y + radius + 1;
		for (let x = 0; x < width; x++) {
			const x0 = x - radius;
			const x1 = x + radius + 1;
			const cx0 = x0 < 0 ? 0 : x0;
			const cy0 = y0 < 0 ? 0 : y0;
			const cx1 = x1 > width ? width : x1;
			const cy1 = y1 > height ? height : y1;
			const area = (cx1 - cx0) * (cy1 - cy0);
			if (area <= 0) continue;
			const mean = blockSum(sum, cx0, cy0, cx1, cy1) / area;
			const meanSq = blockSum(sqSum, cx0, cy0, cx1, cy1) / area;
			const variance = meanSq - mean * mean;
			const std = variance > 0 ? Math.sqrt(variance) : 0;
			const t = mean * (1 + k * (std / R - 1));
			const i = y * width + x;
			const v = gray[i];
			out[i] = v < t ? 1 : 0;
			if (ambiguous !== null) {
				ambiguous[i] = v >= t - margin && v <= t + margin ? 1 : 0;
			}
		}
	}
	return { fg: out, ambiguous };
}

/**
 * Threshold to a foreground mask under the configured mode. Returns
 * { fg, level, ambiguous }:
 *
 *  - `level` is the global grey level actually used (null for sauvola,
 *    which has no single level), reported for diagnostics so a drifting
 *    exposure is visible rather than merely absorbed.
 *  - `ambiguous` marks pixels within cfg.inkMargin grey levels of the
 *    level they were judged against, either side of it - too close to the
 *    cut for the cut to carry a defect claim. Null when inkMargin is 0,
 *    which restores the plain hard-threshold behaviour exactly.
 *
 * `fg` itself is never narrowed by the margin: alignment scores against
 * the full mask, where an ambiguous pixel is still perfectly good
 * evidence of where the label is. The margin only withholds it from the
 * *defect* decision.
 */
function thresholdForeground(gray, width, height, cfg) {
	const margin = cfg.inkMargin > 0 ? cfg.inkMargin : 0;
	switch (cfg.thresholdMode) {
		case "otsu": {
			const level = otsuThreshold(gray);
			return {
				fg: thresholdFgFixed(gray, level),
				level,
				ambiguous: ambiguousFixed(gray, level, margin),
			};
		}
		case "sauvola": {
			const { fg, ambiguous } = thresholdFgSauvola(
				gray,
				width,
				height,
				cfg.sauvolaRadius,
				cfg.sauvolaK,
				margin,
			);
			return { fg, level: null, ambiguous };
		}
		default: {
			const level = cfg.threshold;
			return {
				fg: thresholdFgFixed(gray, level),
				level,
				ambiguous: ambiguousFixed(gray, level, margin),
			};
		}
	}
}

module.exports = {
	otsuThreshold,
	thresholdFgFixed,
	ambiguousFixed,
	thresholdFgSauvola,
	thresholdForeground,
};
