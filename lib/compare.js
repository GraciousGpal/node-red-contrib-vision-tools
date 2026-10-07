/**
 * Golden-template AOI comparison:
 *
 *  - Print position is measured and checked against a tolerance band
 *    (not silently corrected away) - a real position defect fails the
 *    part on its own, independent of blemish detection.
 *  - Blemish detection is two independent checks with independent
 *    tolerances, mirroring their Blemish Print / Blemish Background
 *    tools: "print" = golden has ink the target is missing (even after a
 *    small dilation tolerance); "background" = target has ink the golden
 *    never has (even after its own tolerance). A pixel cannot be both
 *    (see computeDefect below), so the two checks are genuinely
 *    independent.
 *
 * Unlike their encoder-triggered line-scan rig (which frames every label
 * near-identically), the golden here is normally the *PDF artwork for the
 * label* and the frame a photograph of that label printed. Nothing about
 * those two shares a coordinate system: the render DPI is unrelated to
 * the camera's px-per-mm, raw captures include background beyond the
 * label, a part can sit slightly off square, and the press stretches the
 * print along its media-feed axis relative to the artwork. So the frame
 * is decoded preserving its own aspect ratio (never stretched to golden's
 * dimensions) and lib/align.js recovers independent x/y magnification,
 * rotation and translation. lib/warp.js then resamples that region into
 * golden's frame for the pixel diff.
 *
 * The recovered transform does double duty: it is what gets diffed
 * against, *and* its deviation from nominal is reported and gated as the
 * position check. Nominal is "centered in whatever margin the frame has,
 * square to it" - there is no separate trained-nominal capture step,
 * unlike their trained nominal from label-edge geometry.
 *
 * Kept independent of Node-RED (plain functions over Buffers/typed
 * arrays, mm/px passed in as a plain number) so it can be exercised from
 * a standalone script without booting the runtime.
 *
 * Coordinate space: all pixel coordinates in the returned result (region
 * boxes, the heat map images) are in the *working resolution*
 * (`golden.width` x `golden.height`, i.e. `workingSize`-downscaled), not
 * the original camera resolution.
 */

"use strict";

const sharp = require("sharp");
const { dilate } = require("./dilate.js");
const { buildIntegral64, blockSum } = require("./integral.js");
const { excessOver, quantizeDensity } = require("./nuisanceMap.js");
const { thresholdForeground, otsuThreshold } = require("./threshold.js");
const { componentsFromSeeds } = require("./components.js");
const { toShared, allocU8, allocU32, allocF32 } = require("./shared.js");
const { runRanges, shouldParallelise, poolSize } = require("./pool.js");
const { toneHistRows, toneCompareRows } = require("./toneRows.js");
const { refineLocally, measureRegister, slackMapFits, slackLevel } = require("./localAlign.js");
const {
	dilateParallel,
	defectParallel,
	binarizeParallel,
	warpParallel,
	refineLocallyParallel,
	objectiveBatchParallel,
	buildIntegralParallel,
	buildGrayTableParallel,
} = require("./parallel.js");
const { buildGoldenSignature, findTransform } = require("./align.js");
const { warpGray } = require("./warp.js");
const nativeSeed = require("./nativeSeed.js");

// Long edges (in cells) of the three lattices the transform search runs
// on. Stage 1 sweeps the whole frame at COARSE and must stay cheap
// because its cost is multiplied by the whole scale ladder; MEDIUM and
// FINE only ever refine inside a bounded neighbourhood, so they can
// afford more cells. FINE only has to land within a few pixels: the
// polish stage that follows it refines against actual pixel disagreement,
// so buying accuracy here with a denser lattice costs real time for
// something the next stage does better and cheaper.
const COARSE_GRID = 24;
const MEDIUM_GRID = 64;
const FINE_GRID = 96;

// Ceiling on the target's working canvas, as a multiple of workingSize on
// the long edge. Without calibration the canvas is sized by golden's own
// native->working scale, which is unbounded when a small golden is paired
// with a big sensor (a 400px template against a 23MP frame would ask for
// a 23MP working canvas). Since the transform search recovers the
// magnification anyway, shrinking an over-large canvas costs a little
// resolution and nothing else - far better than the memory and time an
// uncapped canvas would take.
const TARGET_CANVAS_LONG_EDGE_LIMIT = 2.5;

// The polish objective's canvas: enough pixels to rank sub-percent
// transform nudges, and no more. See prepareGolden.
//
// 320 rather than something more generous because the polish is the
// single largest cost in a frame and it responds almost linearly: on a
// 1844x2656 golden, dropping from a 640 canvas (divisor 4) to this one
// (divisor 8) took the search from 590ms to 255ms and, if anything,
// found the demo scratch better - four regions at density 0.172 instead
// of two at 0.156. Halving it again is where it breaks: at divisor 16
// the objective can no longer rank candidates and a clean part comes
// back with 1207 false regions. There is no gentle degradation here, so
// do not tune this down without re-running a clean part.
const OBJECTIVE_LONG_EDGE = 320;
// Registration grading. Correctly paired labels measured 0.02-0.05 here,
// so "good" sits just above that; the mismatch ratio floor is an order of
// magnitude above the worst genuinely bad part on hand (0.006/0.011).
const GRADE_GOOD = 0.06;
const MISMATCH_RATIO = 0.02;

function now() {
	return performance.now();
}

// Golden and target MUST come through the same decode path with the same
// resize semantics: a golden decoded via fit:"inside" and a target
// decoded via fit:"fill" land on slightly different resampling even at
// identical output dimensions, which shows up as a scatter of phantom
// defect pixels when an image is compared against itself. So both sides
// compute their output size explicitly (goldenWorkingSize /
// computeTargetWorkingSize) and hand it to this one function.
/**
 * `raw`, when given, is { width, height, channels } describing pixels that
 * arrive with no container around them - a PDF renderer or a camera SDK
 * handing over its framebuffer directly. There is nothing in such a buffer
 * for sharp to infer a geometry from, so it has to be told; without it the
 * decode fails with "unsupported image format", which is a confusing way
 * to learn that the geometry went missing.
 *
 * Worth taking when it is on offer: on a 4096x5500 frame, PNG decode is
 * ~300ms of a ~1.35s inspection, and it is the single largest serial cost
 * left. Raw input removes it outright.
 */
async function decodeGray(buffer, width, height, raw) {
	const { data, info } = await sharp(buffer, raw ? { raw } : undefined)
		.removeAlpha()
		.grayscale()
		.resize(width, height, { fit: "fill" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	if (info.channels !== 1) {
		throw new Error(`expected a single grayscale channel, got ${info.channels}`);
	}
	return data;
}

// Golden's working canvas: long edge scaled to workingSize, aspect ratio
// preserved, never enlarged (an already-small golden stays native -
// upscaling invents no detail and only costs time).
function goldenWorkingSize(nativeWidth, nativeHeight, workingSize) {
	const scale = Math.min(1, workingSize / Math.max(nativeWidth, nativeHeight));
	return {
		width: Math.max(1, Math.round(nativeWidth * scale)),
		height: Math.max(1, Math.round(nativeHeight * scale)),
	};
}

/**
 * How large should the target's working canvas be, preserving its own
 * native aspect ratio (never stretched)?
 *
 * With a calibrated scale (cfg.mmPerPixelNative + golden.mmPerWorkingPx),
 * this converts the frame's native px directly to golden's physical
 * scale - the geometrically correct answer, independent of either image's
 * pixel dimensions. This is the reliable path; calibrate for production
 * use.
 *
 * Without calibration it falls back to golden's own native->working
 * scale: the assumption that both came off the same rig, so one native
 * pixel spans the same distance in each. That is exactly right for a
 * re-trained golden, and it makes the degenerate case exact - the same
 * image against itself yields the same canvas, hence a zero-offset,
 * zero-defect result.
 *
 * Either way this only sets the canvas the search runs on; it does not
 * have to be right. The magnification the search recovers absorbs the
 * error, which is what lets an artwork golden work at all. A canvas that
 * would exceed TARGET_CANVAS_LONG_EDGE_LIMIT is scaled down to fit.
 */
function computeTargetWorkingSize(nativeWidth, nativeHeight, golden, cfg) {
	// Identical native framing (the degenerate "target *is* the golden"
	// case, and the same-camera-same-crop case) must produce byte-identical
	// working canvases, so take golden's own decoded size rather than
	// re-deriving it and risking an off-by-one from a second rounding.
	if (
		nativeWidth === golden.nativeWidth &&
		nativeHeight === golden.nativeHeight
	) {
		return { width: golden.width, height: golden.height };
	}
	let scale;
	if (cfg.mmPerPixelNative != null && golden.mmPerWorkingPx != null) {
		scale = cfg.mmPerPixelNative / golden.mmPerWorkingPx;
	} else if (golden.nativeWidth != null) {
		// golden's *realized* scale, which is 1.0 when golden was small
		// enough that goldenWorkingSize left it at native size. Deriving
		// the target's scale from cfg.workingSize instead would upscale the
		// frame while golden stayed put, so even an identical image would
		// be compared against a magnified copy of itself.
		scale =
			Math.max(golden.width, golden.height) /
			Math.max(golden.nativeWidth, golden.nativeHeight);
	} else {
		scale = cfg.workingSize / Math.max(nativeWidth, nativeHeight);
	}

	const limit = cfg.workingSize * TARGET_CANVAS_LONG_EDGE_LIMIT;
	const longEdge = Math.max(nativeWidth, nativeHeight) * scale;
	if (longEdge > limit) scale *= limit / longEdge;

	return {
		width: Math.max(1, Math.round(nativeWidth * scale)),
		height: Math.max(1, Math.round(nativeHeight * scale)),
	};
}

// Drop every flagged pixel where either image was too close to its own
// ink level to have decided anything (see thresholdForeground). A defect
// claim is a claim about *both* images - "ink here, none there" - so
// ambiguity on either side voids it, not just on the side that carries
// the ink. Either mask may be null, meaning inkMargin is off.
function dropAmbiguous(defect, count, a, b) {
	if (!a && !b) return count;
	const n = defect.length;
	for (let i = 0; i < n; i++) {
		if (!defect[i]) continue;
		if ((a && a[i]) || (b && b[i])) {
			defect[i] = 0;
			count--;
		}
	}
	return count;
}

/**
 * How well the two images registered, and whether they look like the same
 * label at all.
 *
 * The alignment residual on its own grades registration: on this project's
 * samples a correctly paired label lands at 0.02-0.05, a badly printed one
 * around 0.10, and artwork for a *different product* around 0.18.
 *
 * That last case deserves saying out loud, because everything downstream
 * reports it as a catastrophe: comparing one product's artwork against
 * another's photograph produced 1145 print regions and a 6% defect ratio,
 * which reads as a spectacularly bad print rather than the wrong golden.
 * The distinguishing signal is not the size of the disagreement but its
 * *shape*: a defective part disagrees in one direction and in places,
 * while two different labels disagree in both directions and everywhere.
 *
 * So a mismatch is only claimed when the registration is poor **and** both
 * blemish checks are saturated. Requiring both is what keeps a genuinely
 * bad print out of it - NOK_009, the worst real part here, registers at
 * 0.10 but its two ratios are 0.006 and 0.011, an order of magnitude below
 * a true mismatch and lopsided besides.
 */
function gradeMatch(score, coverage, printBlemish, backgroundBlemish, cfg) {
	const mismatchScore = cfg.mismatchScore != null ? cfg.mismatchScore : 0.15;
	// The mismatch rule above needs both blemish checks saturated, and a
	// frame with no ink in it saturates neither - the ambiguity band voids
	// every claim - so it is not the rule that catches a blank tray.
	// Coverage is: none of the golden's ink is in the frame, so there is
	// nothing to judge, and "nothing wrong" is the wrong answer.
	const minCoverage = cfg.minCoverage != null ? cfg.minCoverage : 0.5;
	const labelMissing = minCoverage > 0 && coverage < minCoverage;
	const bothSaturated = Math.min(
		printBlemish.defectRatio,
		backgroundBlemish.defectRatio,
	);
	// independent of labelMissing: another product's artwork covers some
	// of this one's ink and saturates both channels, and is both
	const suspected =
		mismatchScore > 0 &&
		score >= mismatchScore &&
		bothSaturated >= MISMATCH_RATIO;
	return {
		score,
		coverage,
		// registration only - says nothing about whether the part is good,
		// except that a frame with nothing in it did not register at all
		grade: labelMissing
			? "poor"
			: score < GRADE_GOOD
				? "good"
				: score < mismatchScore
					? "marginal"
					: "poor",
		labelMissing,
		mismatchSuspected: suspected,
		// the more specific claim first: "different label" says what is in
		// the frame, "missing" only that this label is not
		reason: suspected
			? `alignment residual ${score.toFixed(3)} with both blemish checks saturated ` +
				`(print ${printBlemish.defectRatio.toFixed(4)}, background ` +
				`${backgroundBlemish.defectRatio.toFixed(4)}) - this looks like a different ` +
				`label rather than a defective one`
			: labelMissing
				? `label missing or unreadable: ${(coverage * 100).toFixed(0)}% of the golden's ` +
					`ink is in the frame, under minCoverage ${minCoverage}`
				: null,
	};
}

// Ink in `fg` that `otherFgDilated` lacks - the serial twin of the pool's
// "defect" kernel, same argument order as defectParallel.
//
//   "Blemish Print":      fg = golden, other = target dilated by
//                         printTolerance px - ink the target is missing
//   "Blemish Background": fg = target, other = golden dilated by
//                         backgroundTolerance px - ink the golden never has
//
// The ambiguity exclusion is what makes the background check usable
// against artwork. Two distinct things trip it on a good part: a screened
// tint that is white in the PDF prints heavy enough to cross the photo's
// level by a hair (ambiguous on the target side), and a solid grey panel
// that sits within a few levels of the *artwork's* own level, which Otsu
// moves around as the working resolution changes (ambiguous on the golden
// side). Neither is a blemish. A real mark is far from both levels and
// survives.
function computeDefect(fg, otherFgDilated, ambiguousA, ambiguousB) {
	const n = fg.length;
	const defect = new Uint8Array(n);
	let count = 0;
	for (let i = 0; i < n; i++) {
		const d = fg[i] & ~otherFgDilated[i] & 1;
		defect[i] = d;
		count += d;
	}
	count = dropAmbiguous(defect, count, ambiguousA, ambiguousB);
	return { defect, count };
}

// Zero the outermost `margin` px of a defect mask on every side and return
// the count with those pixels removed. The golden's edge is where the
// label's own edge lands, and what sits just past the printed artwork -
// the die-cut's substrate, a lifted edge's shadow, the tray - creeps in
// by a few px as the cut and the placement vary. On the rig it arrived
// as one block column at x=0, full height, growing frame by frame from
// density 0.25 to 0.875 while the alignment stayed put, and failed good
// parts on the background density gate. That strip is not a blemish on
// the artwork; it is the world outside it, and the position check already
// guards how far the label may sit from where it should.
// Zero the outer `m` px of a mask on every side; returns how many set
// pixels went. The inner rows are walked only at their two ends.
function clearBorder(mask, width, height, m) {
	m = Math.min(m, Math.floor(width / 2), Math.floor(height / 2));
	if (!(m > 0)) return 0;
	let removed = 0;
	const clearRun = (from, to) => {
		for (let i = from; i < to; i++) {
			removed += mask[i];
			mask[i] = 0;
		}
	};
	clearRun(0, m * width);
	clearRun((height - m) * width, height * width);
	for (let y = m; y < height - m; y++) {
		const row = y * width;
		clearRun(row, row + m);
		clearRun(row + width - m, row + width);
	}
	return removed;
}

function clearEdge(defect, count, width, height, margin) {
	return count - clearBorder(defect, width, height, margin);
}

// The fraction of a block's area a defect mask covers and - when a
// reference mask is given - the fraction of the reference's own pixels in
// that block the defect covers. The second is what makes thin type
// judgeable: body text is 10-15% ink, so a block that lost every stroke it
// had reads 0.12 by area and 1.0 against its reference. Blocks whose
// reference ink is under MISSING_MIN_INK of the block stay at 0: a stroke
// clipping a block's corner leaves too few pixels for a fraction to mean
// anything, and registration residue would otherwise read as "lost all of
// it".
const MISSING_MIN_INK = 0.06;

function buildHeatmapGrid(defect, width, height, blockSize, reference = null) {
	// Blocks never overlap: count each pixel once instead of allocating and
	// writing a full-resolution integral table for each blemish channel.
	const gridW = Math.ceil(width / blockSize);
	const gridH = Math.ceil(height / blockSize);
	const density = new Float32Array(gridW * gridH);
	const missing = reference ? new Float32Array(gridW * gridH) : null;
	for (let gy = 0; gy < gridH; gy++) {
		const y0 = gy * blockSize;
		const y1 = Math.min(height, y0 + blockSize);
		for (let gx = 0; gx < gridW; gx++) {
			const x0 = gx * blockSize;
			const x1 = Math.min(width, x0 + blockSize);
			let count = 0;
			let ref = 0;
			for (let y = y0; y < y1; y++) {
				const row = y * width;
				if (reference) {
					for (let x = x0; x < x1; x++) {
						count += defect[row + x];
						ref += reference[row + x];
					}
				} else {
					for (let x = x0; x < x1; x++) count += defect[row + x];
				}
			}
			const area = (x1 - x0) * (y1 - y0);
			const i = gy * gridW + gx;
			density[i] = area > 0 ? count / area : 0;
			if (missing) {
				const minInk = Math.max(4, Math.round(area * MISSING_MIN_INK));
				missing[i] = ref >= minInk ? Math.min(1, count / ref) : 0;
			}
		}
	}
	return { density, gridW, gridH, missing };
}

// 4-connected flood fill over flagged grid cells -> bounding boxes in
// working-resolution pixel coordinates, sorted worst-first.
function findRegions(
	density,
	gridW,
	gridH,
	blockThreshold,
	blockSize,
	width,
	height,
	missing = null,
	missingThreshold = 0,
) {
	const n = gridW * gridH;
	const flagged = new Uint8Array(n);
	// a block is in by area, or by how much of its own ink it lost
	const byMissing = missing && missingThreshold > 0;
	for (let i = 0; i < n; i++) {
		flagged[i] =
			density[i] >= blockThreshold ||
			(byMissing && missing[i] >= missingThreshold)
				? 1
				: 0;
	}
	const visited = new Uint8Array(n);
	const regions = [];
	const stack = [];

	for (let start = 0; start < n; start++) {
		if (!flagged[start] || visited[start]) continue;
		visited[start] = 1;
		stack.push(start);
		let minX = gridW;
		let minY = gridH;
		let maxX = -1;
		let maxY = -1;
		let sum = 0;
		let count = 0;
		let maxDensity = 0;
		let maxMissing = 0;

		while (stack.length) {
			const idx = stack.pop();
			const gx = idx % gridW;
			const gy = (idx / gridW) | 0;
			if (gx < minX) minX = gx;
			if (gx > maxX) maxX = gx;
			if (gy < minY) minY = gy;
			if (gy > maxY) maxY = gy;
			sum += density[idx];
			count++;
			if (density[idx] > maxDensity) maxDensity = density[idx];
			if (missing && missing[idx] > maxMissing) maxMissing = missing[idx];

			if (gx > 0 && flagged[idx - 1] && !visited[idx - 1]) {
				visited[idx - 1] = 1;
				stack.push(idx - 1);
			}
			if (gx < gridW - 1 && flagged[idx + 1] && !visited[idx + 1]) {
				visited[idx + 1] = 1;
				stack.push(idx + 1);
			}
			if (gy > 0 && flagged[idx - gridW] && !visited[idx - gridW]) {
				visited[idx - gridW] = 1;
				stack.push(idx - gridW);
			}
			if (gy < gridH - 1 && flagged[idx + gridW] && !visited[idx + gridW]) {
				visited[idx + gridW] = 1;
				stack.push(idx + gridW);
			}
		}

		const x0 = minX * blockSize;
		const y0 = minY * blockSize;
		const x1 = Math.min(width, (maxX + 1) * blockSize);
		const y1 = Math.min(height, (maxY + 1) * blockSize);
		regions.push({
			x: x0,
			y: y0,
			w: x1 - x0,
			h: y1 - y0,
			density: maxDensity,
			avgDensity: sum / count,
			// the most ink any block in the region lost, as a fraction of
			// what the golden has there; 0 for the background channel
			missing: maxMissing,
			cells: count,
		});
	}

	regions.sort((a, b) => b.density - a.density);
	return regions;
}

async function renderHeatmap(
	targetGray,
	width,
	height,
	density,
	gridW,
	gridH,
	blockSize,
	blockThreshold,
	cfg,
	missing = null,
	missingThreshold = 0,
) {
	// Whether each block is drawn red, and how red, decided once per block
	// rather than once per pixel: per pixel it was a grid lookup, two
	// divisions and Math.min/max for every pixel of a frame that is mostly
	// unflagged grey - 15-20 ms a heat map at 3 MP, five heat maps a frame
	// with the preview on. -1 is "not flagged".
	const alphas = new Float64Array(gridW * gridH);
	for (let b = 0; b < alphas.length; b++) {
		const d = density[b];
		const m = missing ? missing[b] : 0;
		alphas[b] =
			d >= blockThreshold || (missingThreshold > 0 && m >= missingThreshold)
				? Math.min(1, Math.max(d, m))
				: -1;
	}
	// every byte is written below, so no zero-fill
	const rgb = Buffer.allocUnsafe(width * height * 3);
	for (let y = 0; y < height; y++) {
		const gRowBase = Math.min(gridH - 1, (y / blockSize) | 0) * gridW;
		const row = y * width;
		for (let gx = 0; gx < gridW; gx++) {
			// the last column takes whatever is left, as the clamp did
			const x0 = gx * blockSize;
			const x1 = gx === gridW - 1 ? width : Math.min(width, x0 + blockSize);
			const alpha = alphas[gRowBase + gx];
			if (alpha < 0) {
				for (let x = x0; x < x1; x++) {
					const gray = targetGray[row + x];
					const i = (row + x) * 3;
					rgb[i] = gray;
					rgb[i + 1] = gray;
					rgb[i + 2] = gray;
				}
			} else {
				for (let x = x0; x < x1; x++) {
					const gray = targetGray[row + x];
					const i = (row + x) * 3;
					rgb[i] = Math.round(gray * (1 - alpha) + 255 * alpha);
					rgb[i + 1] = Math.round(gray * (1 - alpha));
					rgb[i + 2] = Math.round(gray * (1 - alpha));
				}
			}
		}
	}
	return encodeImage(rgb, width, height, 3, cfg);
}

/**
 * Encode a heat map or debug stage for msg. JPEG by default: these are
 * pictures for a person, and on a 1475x2125 working canvas with real
 * frame content a PNG at zlib's default level 6 took 153ms per image -
 * two heat maps were ~300ms of a 460ms frame, seven debug stages another
 * ~1.2s - against 22ms for JPEG q85, at a seventh of the bytes (350KB vs
 * 2.4MB, which also matters once the buffer rides a websocket to a
 * dashboard). The compose loop above is 9ms; the codec was the cost.
 *
 *   "jpg"  22ms  350KB   the default
 *   "png"  25ms  3.7MB   zlib level 1 - lossless, and the fastest deflate
 *                        worth having (level 0 stores 9.2MB in 11ms)
 *   "raw"   0ms  9.4MB   no codec: the same { data, width, height,
 *                        channels, colorSpace, dtype } object label-crop
 *                        and perspective-rectify emit, for a flow that
 *                        resizes or overlays before anything is displayed
 */
function encodeImage(pixels, width, height, channels, cfg) {
	const format = cfg && cfg.heatmapFormat;
	if (format === "raw") {
		return {
			data: pixels,
			width,
			height,
			channels,
			colorSpace: channels === 1 ? "GRAY" : "RGB",
			dtype: "uint8",
		};
	}
	const img = sharp(pixels, { raw: { width, height, channels } });
	if (format === "png") {
		return img.png({ compressionLevel: 1 }).toBuffer();
	}
	const quality = cfg && cfg.heatmapQuality != null ? cfg.heatmapQuality : 85;
	return img.jpeg({ quality }).toBuffer();
}

// Every check on one picture. The four heat maps each show one check's
// evidence per block, which is right for tuning that check and wrong for
// looking at a part: a person wants to see what failed, where, and which
// check said so. So this draws, over the aligned grey, each check's
// regions as a box in its own colour with the mask's own pixels filled
// inside it - the evidence, not the block - specks grown a couple of px
// so a three-pixel one can be seen at all. Background blue, print red,
// tone amber, specks green; drawn in that order so the rarer checks sit
// on top.
const OVERLAY_COLOURS = {
	background: [30, 136, 229],
	print: [229, 57, 53],
	tone: [255, 179, 0],
	speck: [0, 230, 118],
};
// a speck's pixels are drawn this many px fat, else a three-pixel one is
// invisible; only up to this area, since a region of thousands of pixels
// blended 25 times over was 98 ms of JavaScript for nothing a box does
// not already show
const OVERLAY_SPECK_GROW = 2;
const OVERLAY_GROW_MAX_AREA = 64;
const OVERLAY_FILL_ALPHA = 0.6;
const OVERLAY_GROW_ALPHA = 0.8;
const OVERLAY_BOX_ALPHA = 0.9;

function renderOverlay(targetGray, width, height, layers, cfg) {
	const n = width * height;
	const rgb = Buffer.allocUnsafe(n * 3);
	for (let i = 0; i < n; i++) {
		const g = targetGray[i];
		rgb[i * 3] = g;
		rgb[i * 3 + 1] = g;
		rgb[i * 3 + 2] = g;
	}
	const blend = (i, c, a) => {
		const o = i * 3;
		rgb[o] = Math.round(rgb[o] * (1 - a) + c[0] * a);
		rgb[o + 1] = Math.round(rgb[o + 1] * (1 - a) + c[1] * a);
		rgb[o + 2] = Math.round(rgb[o + 2] * (1 - a) + c[2] * a);
	};
	for (const L of layers) {
		for (const r of L.regions) {
			const grow = L.grow && !(r.area > OVERLAY_GROW_MAX_AREA) ? L.grow : 0;
			const x0 = Math.max(0, r.x);
			const y0 = Math.max(0, r.y);
			const x1 = Math.min(width, r.x + r.w);
			const y1 = Math.min(height, r.y + r.h);
			// the evidence inside the box
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					if (!L.mask[y * width + x]) continue;
					if (!grow) {
						blend(y * width + x, L.rgb, OVERLAY_FILL_ALPHA);
						continue;
					}
					for (let dy = -grow; dy <= grow; dy++) {
						const yy = y + dy;
						if (yy < 0 || yy >= height) continue;
						for (let dx = -grow; dx <= grow; dx++) {
							const xx = x + dx;
							if (xx >= 0 && xx < width) blend(yy * width + xx, L.rgb, OVERLAY_GROW_ALPHA);
						}
					}
				}
			}
			// the box, two px, just outside the region
			const bx0 = Math.max(0, x0 - 2);
			const by0 = Math.max(0, y0 - 2);
			const bx1 = Math.min(width, x1 + 2);
			const by1 = Math.min(height, y1 + 2);
			for (let x = bx0; x < bx1; x++) {
				for (const y of [by0, by0 + 1, by1 - 2, by1 - 1]) {
					if (y >= 0 && y < height) blend(y * width + x, L.rgb, OVERLAY_BOX_ALPHA);
				}
			}
			for (let y = by0; y < by1; y++) {
				for (const x of [bx0, bx0 + 1, bx1 - 2, bx1 - 1]) {
					if (x >= 0 && x < width) blend(y * width + x, L.rgb, OVERLAY_BOX_ALPHA);
				}
			}
		}
	}
	return encodeImage(rgb, width, height, 3, cfg);
}

// visualize a grayscale (0-255) buffer as-is
function renderGray(gray, width, height, cfg) {
	return encodeImage(gray, width, height, 1, cfg);
}

// visualize a binary (0/1) mask as black/white. Never JPEG, whatever
// heatmapFormat says: two-level content deflates in a few ms at any
// level, JPEG's cost does not depend on content, and JPEG ringing on a
// mask puts grey where the pipeline has none - the wrong thing to show
// someone debugging a threshold. Raw is honoured (it is cheaper still).
function renderMask(mask, width, height, cfg) {
	// zero-filled, so only the set pixels need writing: a mask is mostly
	// clear, and eight of these a frame with the preview on
	const vis = Buffer.alloc(width * height);
	for (let i = 0; i < mask.length; i++) if (mask[i]) vis[i] = 255;
	const format = cfg && cfg.heatmapFormat === "raw" ? "raw" : "png";
	return encodeImage(vis, width, height, 1, { heatmapFormat: format });
}

/** Promise.all over an object's values, keeping the keys. */
async function allProps(obj) {
	const keys = Object.keys(obj);
	const values = await Promise.all(keys.map((k) => obj[k]));
	const out = {};
	keys.forEach((k, i) => {
		out[k] = values[i];
	});
	return out;
}

// ------------------------------------------------------------------ tone

// The tone check: grey, not the ink mask. A smudge, a ghost or faded
// print stays on one side of the ink threshold, so both binary checks
// score it 0% by construction (bench/synth-findings.md). A pixel's
// expected grey is the golden's grey mapped linearly between the paper
// and ink levels the frame shows in that pixel's TONE_CELL cell, so
// lighting cancels and a grey panel in the artwork is expected grey; the
// deviation is a fraction of that paper-to-ink span.
//
// Registration is never exact: edges sit a few px off after the local
// alignment, and blur spreads them wider. So a pixel is held to the grey
// the golden predicts anywhere within `toneMargin` px of it - the
// darkest and lightest golden grey in that window set the band - the way
// printTolerance does for the binary checks. Next to an ink edge the
// window runs from paper to ink and accepts anything. A hairline or a
// speck there is lost, and thin type is the missing-ink gate's job
// anyway. The slack is the rig's and not the same everywhere on it, so
// when training measured it per tile (cfg.toneSlackMap,
// lib/localAlign.js measureRegister) each tile takes its own window: a
// dot on a line is lost only where the rig really is off register, not
// across the whole label because one corner is. A map that does not fit
// the golden's grid is ignored and toneMargin applies everywhere. The
// outer TONE_BORDER px of the canvas, or the largest slack if wider, are
// out as well: the warp's fill, the label's own edge and its shadow meet
// there.
//
// Levels are the 80th percentile of paper and the 20th of ink per cell,
// so a defect must cover most of a cell to move its own reference, and
// they are sampled only where the golden is within TONE_SAMPLE_BAND of
// its own paper and ink extremes and as far clear of the other class as
// the largest slack in play: a grey panel sampled as paper became its
// own cell's paper level, and a rule off register by more than the
// clearance hands its cell frame paper as its ink level. Artwork too thin
// to leave any pure ink at that clearance falls back to TONE_SAMPLE_CLEAR
// px rather than to no check. The extremes come from the golden itself
// (the median of its ink mask and of its paper), not from 0 and 255: a
// cream artwork, or a golden photographed off the rig, has no pixel at
// 255, and a fixed cut-off left it with no samples and a check that
// silently passed everything.
//
// Per frame the work is one histogram pass and one comparison pass. The
// comparison is a table lookup: for each cell and each golden grey value
// the frame grey that is just acceptable, low and high, so the inner loop
// has no division and no float arithmetic; the window's darkest grey
// reads the low table and its lightest the high one.
const TONE_CELL = 128;
const TONE_MIN_SAMPLES = 32;
const TONE_MIN_SPAN = 24;
const TONE_BORDER = 16;
const TONE_SAMPLE_BAND = 16;
const TONE_SAMPLE_CLEAR = 3;
const TONE_MIN_CONTRAST = 64;
// the class byte, one per golden pixel
const TONE_MEASURED = 1;
const TONE_PAPER_SAMPLE = 4;
const TONE_INK_SAMPLE = 8;

function percentileOf(hist, offset, fraction, minSamples) {
	let n = 0;
	for (let v = 0; v < 256; v++) n += hist[offset + v];
	if (n < Math.max(1, minSamples || 0)) return -1;
	const target = Math.max(1, Math.ceil(n * fraction));
	let acc = 0;
	for (let v = 0; v < 256; v++) {
		acc += hist[offset + v];
		if (acc >= target) return v;
	}
	return 255;
}

/**
 * The golden's own paper and ink levels, once per golden: the median grey
 * of its ink mask and of everything else. Medians, not extremes - a
 * resampled golden rings a few pixels past its true ink level, and an
 * extreme taken there put the "pure ink" band below every real stroke.
 */
function toneReference(golden) {
	if (golden.toneReference) return golden.toneReference;
	const histInk = new Uint32Array(256);
	const histPaper = new Uint32Array(256);
	const { gray, fg } = golden;
	for (let i = 0; i < gray.length; i++) (fg[i] ? histInk : histPaper)[gray[i]]++;
	const paper = percentileOf(histPaper, 0, 0.5);
	const ink = percentileOf(histInk, 0, 0.5);
	golden.toneReference = {
		paper,
		ink,
		measurable: paper >= 0 && ink >= 0 && paper - ink >= TONE_MIN_CONTRAST,
	};
	return golden.toneReference;
}

/**
 * Per golden pixel: a class byte - measured at all, and whether it is
 * pure enough paper or ink to sample a level from - and, per distinct
 * slack in play, the darkest and lightest golden grey within that many
 * px of it, with the slack each tile takes. Depends only on the golden,
 * the margin and the map, so it is built once per golden and kept on it;
 * only the last combination is kept, since a flow that changes them per
 * message would otherwise grow the golden by 6 MB a level.
 */
function toneClasses(golden, margin, slackMap) {
	const { width, height, fg, gray } = golden;
	// the map applies when it describes this golden's grid; else the one
	// margin everywhere, as a map with a single tile
	const fits = slackMapFits(slackMap, width, height);
	// rounded up to the levels training writes (lib/localAlign.js), so a
	// hand-edited map costs no more windows than a trained one
	const grid = fits
		? { ...slackMap, slackPx: slackMap.slackPx.map(slackLevel) }
		: { tile: Math.max(width, height), gridW: 1, gridH: 1, slackPx: [margin] };
	const mapKey = fits ? `${grid.tile}:${grid.gridW}x${grid.gridH}:${grid.slackPx.join(",")}` : "";
	if (
		golden.toneClasses &&
		golden.toneClasses.margin === margin &&
		golden.toneClasses.mapKey === mapKey
	) {
		return golden.toneClasses;
	}
	const distinct = [...new Set(grid.slackPx)].sort((a, b) => a - b);
	const slackMax = distinct[distinct.length - 1];
	const n = width * height;
	const ref = toneReference(golden);
	const paperFrom = ref.paper - TONE_SAMPLE_BAND;
	const inkTo = ref.ink + TONE_SAMPLE_BAND;
	const border = Math.max(slackMax, TONE_BORDER);
	const sampled = (clear) => {
		const nearInk = dilate(fg, width, height, clear);
		const notInk = new Uint8Array(n);
		for (let i = 0; i < n; i++) notInk[i] = fg[i] ? 0 : 1;
		const nearPaper = dilate(notInk, width, height, clear);
		const classes = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			let c = TONE_MEASURED;
			if (!nearInk[i]) {
				if (gray[i] >= paperFrom) c |= TONE_PAPER_SAMPLE;
			} else if (!nearPaper[i]) {
				if (gray[i] <= inkTo) c |= TONE_INK_SAMPLE;
			}
			classes[i] = c;
		}
		clearBorder(classes, width, height, border);
		let paper = 0;
		let ink = 0;
		for (let i = 0; i < n; i++) {
			if (classes[i] & TONE_PAPER_SAMPLE) paper++;
			else if (classes[i] & TONE_INK_SAMPLE) ink++;
		}
		return { classes, paper, ink };
	};
	let s = sampled(slackMax);
	if (slackMax > TONE_SAMPLE_CLEAR && (s.paper < TONE_MIN_SAMPLES || s.ink < TONE_MIN_SAMPLES)) {
		s = sampled(TONE_SAMPLE_CLEAR);
	}
	// one window per distinct slack: a grey dilation is a sliding max,
	// and the min is the max of the inverse
	const inverse = new Uint8Array(n);
	for (let i = 0; i < n; i++) inverse[i] = 255 - gray[i];
	const levels = [];
	for (const px of distinct) {
		const lightest = dilate(gray, width, height, px);
		const darkest = dilate(inverse, width, height, px);
		for (let i = 0; i < n; i++) darkest[i] = 255 - darkest[i];
		levels.push({ px, darkest, lightest });
	}
	const tileLevel = new Uint8Array(grid.gridW * grid.gridH);
	for (let c = 0; c < tileLevel.length; c++) tileLevel[c] = distinct.indexOf(grid.slackPx[c]);
	// in shared memory once, here, rather than copied for the pool on
	// every frame; the windows are shared already (dilate allocates so)
	golden.toneClasses = {
		margin,
		mapKey,
		classes: toShared(s.classes),
		levels,
		tileLevel: toShared(tileLevel),
		tile: grid.tile,
		gridW: grid.gridW,
		slackMin: distinct[0],
		slackMax: distinct[distinct.length - 1],
		mapApplied: fits,
	};
	return golden.toneClasses;
}

/**
 * The tone defect mask: 1 where a pixel sits at least `cfg.toneThreshold`
 * of its cell's paper-to-ink span from every grey the golden predicts
 * within its slack (the tile's from cfg.toneSlackMap when that fits, else
 * cfg.toneMargin). `speck` is the same test at
 * `cfg.speckThreshold`, with `seeds` listing its set pixels for the
 * component fill; `map` is the deviation beyond the accepted range as
 * 0-255 for the stage viewer. `enabled` is false, with a `reason`, when
 * the golden gives nothing to measure against.
 */
async function toneDefect(golden, targetGray, cfg, wantMap) {
	const { width, height } = golden;
	const ref = toneReference(golden);
	if (!ref.measurable) {
		return { enabled: false, reason: `the golden's paper and ink are ${ref.paper - ref.ink} grey levels apart; the tone check needs ${TONE_MIN_CONTRAST}` };
	}
	const margin = cfg.toneMargin > 0 ? Math.round(cfg.toneMargin) : 0;
	const { classes, levels, tileLevel, tile, gridW: slackGridW, slackMin, slackMax, mapApplied } =
		toneClasses(golden, margin, cfg.toneSlackMap);
	const cellsW = Math.ceil(width / TONE_CELL);
	const cellsH = Math.ceil(height / TONE_CELL);
	const cells = cellsW * cellsH;

	const n = width * height;
	// Both passes are split over the pool when the frame is big enough,
	// as the masks before them are: one pass alone was 20-40 ms of serial
	// JavaScript at 3 MP. lib/toneRows.js holds the one implementation
	// both ways run.
	// a host with no second worker gains nothing from shared buffers
	const pooled = shouldParallelise(n, cfg.workers) && poolSize(cfg.workers) > 1;
	const shared = pooled ? toShared(targetGray) : targetGray;
	const rows = {
		classes,
		gray: shared,
		width,
		height,
		cell: TONE_CELL,
		cellsW,
		paperBit: TONE_PAPER_SAMPLE,
		inkBit: TONE_INK_SAMPLE,
		measuredBit: TONE_MEASURED,
	};
	// true when the pool ran it; false when the caller is to run it here
	const onPool = async (kernel, t, total, extra = {}) => {
		if (!pooled) return false;
		const buffers = {};
		for (const [key, v] of Object.entries(t)) {
			buffers[key] = ArrayBuffer.isView(v) ? v.buffer : Array.isArray(v) ? v.map((a) => a.buffer) : v;
		}
		const p = runRanges(kernel, { ...buffers, ...extra }, total, cfg.workers);
		if (p === null) return false;
		await p;
		return true;
	};

	// one pass: the frame's grey where the golden is pure paper or pure ink,
	// split by whole rows of cells so no two ranges share a histogram, and
	// the whole-frame totals summed from the cells after
	const histP = pooled ? allocU32(cells * 256) : new Uint32Array(cells * 256);
	const histK = pooled ? allocU32(cells * 256) : new Uint32Array(cells * 256);
	const hist = { ...rows, histP, histK };
	if (!(await onPool("toneHist", hist, cellsH))) toneHistRows(hist, 0, cellsH);
	const totalP = new Uint32Array(256);
	const totalK = new Uint32Array(256);
	for (let c = 0; c < cells; c++) {
		const off = c << 8;
		for (let v = 0; v < 256; v++) {
			totalP[v] += histP[off + v];
			totalK[v] += histK[off + v];
		}
	}
	const paperLevel = percentileOf(totalP, 0, 0.8, TONE_MIN_SAMPLES);
	const inkLevel = percentileOf(totalK, 0, 0.2, TONE_MIN_SAMPLES);
	if (paperLevel < 0 || inkLevel < 0) {
		return {
			enabled: false,
			reason: `the frame shows too little of the golden's ${paperLevel < 0 ? "paper" : "ink"} to measure a level`,
		};
	}

	// the tables: per cell, per golden grey, the lowest and highest frame
	// grey still inside each threshold
	const threshold = cfg.toneThreshold > 0 ? cfg.toneThreshold : 0;
	const speckThreshold = cfg.speckThreshold > 0 ? cfg.speckThreshold : 0;
	//
	// Held as whole grey levels: the frame grey is an integer, so `t <= lo`
	// is `t <= floor(lo)` and `t >= hi` is `t >= ceil(hi)` exactly - taken
	// of the Float32 the tables used to hold, so not one pixel moves - and
	// the inner loop compares integers. -32768 and 32767 stand for the
	// infinities of a threshold that is off: no grey reaches either.
	const i16 = (len) => (pooled ? new Int16Array(allocU8(len * 2).buffer) : new Int16Array(len));
	const f32 = (len) => (pooled ? allocF32(len) : new Float32Array(len));
	const u8 = (len) => (pooled ? allocU8(len) : new Uint8Array(len));
	const lo = i16(cells * 256);
	const hi = i16(cells * 256);
	const speckLo = speckThreshold ? i16(cells * 256) : null;
	const speckHi = speckThreshold ? i16(cells * 256) : null;
	const expected = wantMap ? f32(cells * 256) : null;
	const spans = f32(cells);
	const refSpan = ref.paper - ref.ink;
	// clamped to the type: a threshold a library caller sets past 1 would
	// otherwise wrap, and ±Infinity would become 0
	const floorOf = (v) => Math.max(-32768, Math.min(32767, Math.floor(Math.fround(v))));
	const ceilOf = (v) => Math.max(-32768, Math.min(32767, Math.ceil(Math.fround(v))));
	for (let c = 0; c < cells; c++) {
		const off = c << 8;
		let p = percentileOf(histP, off, 0.8, TONE_MIN_SAMPLES);
		let k = percentileOf(histK, off, 0.2, TONE_MIN_SAMPLES);
		if (p < 0) p = paperLevel;
		if (k < 0) k = inkLevel;
		const span = p - k;
		if (!(span >= TONE_MIN_SPAN)) continue;
		spans[c] = span;
		for (let g = 0; g < 256; g++) {
			const m = Math.min(1, Math.max(0, (g - ref.ink) / refSpan));
			const e = k + m * span;
			lo[off + g] = threshold ? floorOf(e - threshold * span) : -32768;
			hi[off + g] = threshold ? ceilOf(e + threshold * span) : 32767;
			if (speckLo) {
				speckLo[off + g] = floorOf(e - speckThreshold * span);
				speckHi[off + g] = ceilOf(e + speckThreshold * span);
			}
			if (expected) expected[off + g] = e;
		}
	}

	const defect = u8(n);
	const speck = speckLo ? u8(n) : null;
	const map = wantMap ? u8(n) : null;
	const compare = {
		...rows,
		darkest: levels.map((l) => l.darkest),
		lightest: levels.map((l) => l.lightest),
		tileLevel,
		tile,
		slackGridW,
		spans,
		lo,
		hi,
		speckLo,
		speckHi,
		expected,
		defect,
		speck,
		map,
	};
	// [defects, specks], summed over the workers' pairs of slots
	const tally = [0, 0];
	const slots = pooled ? allocU32(2 * Math.max(1, poolSize(cfg.workers))) : null;
	if (await onPool("toneCompare", compare, height, { counts: slots && slots.buffer })) {
		for (let i = 0; i < slots.length; i += 2) {
			tally[0] += slots[i];
			tally[1] += slots[i + 1];
		}
	} else {
		toneCompareRows(compare, 0, height, tally);
	}
	const count = tally[0];
	// The speck fill's seeds: every set pixel, in raster order, found by
	// indexOf - it runs over the bytes natively - into an array the
	// counts above already sized.
	let seeds = null;
	if (speck) {
		seeds = new Int32Array(tally[1]);
		let found = 0;
		for (let i = speck.indexOf(1); i >= 0; i = speck.indexOf(1, i + 1)) seeds[found++] = i;
	}
	return {
		enabled: true,
		defect,
		count,
		speck,
		seeds,
		map,
		paperLevel,
		inkLevel,
		slackMin,
		slackMax,
		mapApplied,
	};
}

// --------------------------------------------------------------- specks

// Dust and pinholes: one to three px each, so no block reaches
// blockThreshold and, after blur, too few reach ink level for failRatio
// (a medium dust case: 600 specks, 4000 px on 1500x2100). They are
// counted instead, as components of the tone deviation, so the edge band
// and border are out here too.
const SPECK_REGIONS_KEPT = 200;
// a block holding this share of its area in speck is drawn fully red
const SPECK_HEAT_SATURATION = 0.05;
// renderHeatmap's threshold, set so any block with a speck in it draws
const SPECK_HEAT_ANY = 1e-6;

async function speckCheck(golden, tone, cfg, targetGray, wantHeatmap, toneRegions) {
	const { width, height } = golden;
	const minArea = cfg.speckMinArea > 0 ? Math.round(cfg.speckMinArea) : 1;
	// A speck is what the tone check is too coarse to see. A component the
	// tone check has already failed - a block at failThreshold over it -
	// is tone's evidence, not a speck: without this a missing bar or a
	// smudge is one giant "speck" on top of the finding that matters.
	const tonesFailed = toneRegions.filter((r) => r.density >= cfg.failThreshold);
	const inFailedTone = (b) =>
		tonesFailed.some(
			(r) => b.cx >= r.x && b.cx < r.x + r.w && b.cy >= r.y && b.cy < r.y + r.h,
		);
	const blobs = componentsFromSeeds(tone.speck, width, height, tone.seeds, { minArea }).filter(
		(b) => !inFailedTone(b),
	);
	let area = 0;
	let largest = 0;
	for (const b of blobs) {
		area += b.area;
		if (b.area > largest) largest = b.area;
	}
	const count = blobs.length;
	const maxCount = cfg.speckMaxCount > 0 ? cfg.speckMaxCount : Infinity;
	const maxArea = cfg.speckMaxArea > 0 ? cfg.speckMaxArea : Infinity;
	// biggest first, and only so many: a large dust case is thousands of
	// specks, and the message does not need every one to say where
	blobs.sort((a, b) => b.area - a.area);
	return {
		enabled: true,
		pass: count < maxCount && largest < maxArea,
		count,
		area,
		largest,
		defectRatio: area / (width * height),
		// density 1: a speck is all defect, which is what the report's
		// largest-region line and the overlay read
		regions: blobs.slice(0, SPECK_REGIONS_KEPT).map((b) => ({
			x: b.x0,
			y: b.y0,
			w: b.x1 - b.x0,
			h: b.y1 - b.y0,
			area: b.area,
			density: 1,
		})),
		heatmap: wantHeatmap ? await speckHeatmap(targetGray, width, height, blobs, cfg) : null,
	};
}

// Every block that holds a speck lights up, redder with more of it: a
// speck is a few pixels, so the block density the other heat maps draw
// would never show one.
function speckHeatmap(targetGray, width, height, blobs, cfg) {
	const blockSize = cfg.blockSize;
	const gridW = Math.ceil(width / blockSize);
	const gridH = Math.ceil(height / blockSize);
	const density = new Float32Array(gridW * gridH);
	const saturate = blockSize * blockSize * SPECK_HEAT_SATURATION;
	for (const b of blobs) {
		const gx = Math.min(gridW - 1, (b.cx / blockSize) | 0);
		const gy = Math.min(gridH - 1, (b.cy / blockSize) | 0);
		const i = gy * gridW + gx;
		density[i] = Math.min(1, density[i] + b.area / saturate);
	}
	return renderHeatmap(targetGray, width, height, density, gridW, gridH, blockSize, SPECK_HEAT_ANY, cfg);
}

// Shared by the print, background and tone checks: block-summarize a defect mask
// into a heat-map grid, flood-fill into regions, and score pass/fail.
async function buildBlemishResult(
	defect,
	defectCount,
	width,
	height,
	targetGray,
	cfg,
	wantHeatmap,
	reference = null,
) {
	// `reference` is the mask the defect is a subset of - the golden's ink
	// for the print channel - and turns on the missing-fraction gate when
	// cfg.printMissingFraction is set. The background channel has no
	// reference: there is no "what should be here" for extra ink.
	const missingThreshold =
		reference && cfg.printMissingFraction > 0 ? cfg.printMissingFraction : 0;
	const { density, gridW, gridH, missing } = buildHeatmapGrid(
		defect,
		width,
		height,
		cfg.blockSize,
		missingThreshold > 0 ? reference : null,
	);
	const regions = findRegions(
		density,
		gridW,
		gridH,
		cfg.blockThreshold,
		cfg.blockSize,
		width,
		height,
		missing,
		missingThreshold,
	);
	const defectRatio = defectCount / (width * height);
	const worstDensity = regions.length ? regions[0].density : 0;
	let worstMissing = 0;
	for (const r of regions) if (r.missing > worstMissing) worstMissing = r.missing;
	// How far the dirtiest block exceeds what this same block does on known-
	// good product. Without a trained map this is just the raw density and
	// the gate below is disabled, so an untrained rig behaves exactly as it
	// did before. See lib/nuisanceMap.js for why location beats magnitude.
	const { worst: worstExcess } = cfg.nuisanceBaseline
		? excessOver(density, cfg.nuisanceBaseline)
		: { worst: 0 };
	const noveltyPass =
		!cfg.nuisanceBaseline ||
		!(cfg.noveltyThreshold > 0) ||
		worstExcess < cfg.noveltyThreshold;
	const pass =
		worstDensity < cfg.failThreshold &&
		defectRatio < cfg.failRatio &&
		(missingThreshold === 0 || worstMissing < missingThreshold) &&
		noveltyPass;
	const heatmap = wantHeatmap
		? await renderHeatmap(
				targetGray,
				width,
				height,
				density,
				gridW,
				gridH,
				cfg.blockSize,
				cfg.blockThreshold,
				cfg,
				missing,
				missingThreshold,
			)
		: null;
	// The grid itself only travels while a map is being trained: it is
	// gridW*gridH bytes (~49KB at the deployed geometry) and the inspection
	// runs in a worker, so shipping it on every frame would be pure waste.
	// Quantized to a byte per cell, which is the precision the map stores.
	const densityBytes = cfg.trainNuisance
		? quantizeDensity(density)
		: undefined;
	return {
		defectRatio,
		regions,
		pass,
		heatmap,
		worstMissing,
		worstExcess,
		noveltyPass,
		densityBytes,
		gridW,
		gridH,
	};
}

/**
 * Position check: is the measured placement within tolerance of nominal
 * (centered in the available margin, square to the frame)? dxPx/dyPx are
 * already the deviation from that by the time this is called, expressed
 * in golden working pixels. Uses mm if the rig has been calibrated
 * (golden.mmPerWorkingPx != null), else falls back to a pixel tolerance.
 *
 * Rotation is gated separately rather than folded into the same number: a
 * part that is square but offset and a part that is centered but skewed
 * are different faults with different causes on the line, so collapsing
 * them would throw away the more actionable half.
 *
 * `stretchPercent` - how far the two recovered magnifications differ - is
 * reported but deliberately not gated. Some stretch is simply what the
 * press does, and its normal value depends on media and machine, so a
 * default threshold would be a guess that fails good parts. It is worth
 * watching, though: a stretch that moves is a press drifting.
 */
function evaluatePosition(
	dxPx,
	dyPx,
	angleDeg,
	scaleX,
	scaleY,
	mmPerWorkingPx,
	cfg,
) {
	const anglePass = Math.abs(angleDeg) <= cfg.positionToleranceAngleDeg;
	const stretchPercent = (scaleY / scaleX - 1) * 100;
	const common = {
		dxPx,
		dyPx,
		angleDeg,
		anglePass,
		scale: Math.sqrt(scaleX * scaleY),
		scaleX,
		scaleY,
		stretchPercent,
	};
	if (mmPerWorkingPx != null) {
		const dxMm = dxPx * mmPerWorkingPx;
		const dyMm = dyPx * mmPerWorkingPx;
		const pass =
			Math.abs(dxMm) <= cfg.positionToleranceXMm &&
			Math.abs(dyMm) <= cfg.positionToleranceYMm &&
			anglePass;
		return { ...common, dxMm, dyMm, pass };
	}
	const pass =
		Math.abs(dxPx) <= cfg.positionToleranceXPx &&
		Math.abs(dyPx) <= cfg.positionToleranceYPx &&
		anglePass;
	return { ...common, dxMm: null, dyMm: null, pass };
}

/**
 * Area-average a grayscale image down to outW x outH.
 *
 * The alignment polish compares this against the frame resampled by
 * warpGray's area-average path, and the two sides must be built by the
 * *same* operator or the comparison acquires a bias that has nothing to
 * do with alignment. Downsampling golden's ink mask by majority vote
 * instead - superficially the more natural choice for a binary image -
 * is not the same operator as "average the greys, then threshold", and
 * the difference is enough to move the objective's minimum a pixel off
 * the true transform. An image compared against itself would then be
 * reported as a pixel out of position.
 */
function decimateGrayBy2(gray, width, height, outW, outH) {
	// grey table, so the Float64 accumulator: a Uint32 table over a large
	// grey canvas wraps (see buildIntegral64) and the polish objective
	// would be scored against garbage sums.
	const table = buildIntegral64(gray, width, height);
	const out = new Uint8Array(outW * outH);
	// Exactly 2x2 boxes rather than a proportional mapping: the frame's
	// side of the comparison is generated from the transform, so the two
	// grids only line up if this side's decimation factor is exactly the
	// factor that mapping assumes. An odd trailing row or column of golden
	// simply goes unused - the objective ranks candidate transforms, it
	// does not have to see every pixel.
	for (let y = 0; y < outH; y++) {
		const y0 = 2 * y;
		const y1 = Math.min(height, y0 + 2);
		for (let x = 0; x < outW; x++) {
			const x0 = 2 * x;
			const x1 = Math.min(width, x0 + 2);
			const area = (x1 - x0) * (y1 - y0);
			out[y * outW + x] =
				area > 0 ? Math.round(blockSum(table, x0, y0, x1, y1) / area) : 255;
		}
	}
	return out;
}

function gridFor(width, height, longEdge) {
	const scale = Math.min(1, longEdge / Math.max(width, height));
	return {
		w: Math.max(2, Math.round(width * scale)),
		h: Math.max(2, Math.round(height * scale)),
	};
}

/**
 * Preprocess and cache a golden reference. Call once per golden image, not
 * per frame - this is the expensive-but-amortized half of the pipeline.
 * The three density signatures the transform search compares against are
 * built here too, so the per-frame cost is only the target side.
 *
 * cfg.mmPerPixelNative (optional): mm-per-pixel measured by
 * checkerboard-calibrate, at that calibration photo's own native
 * resolution. Rescaled here to golden's working resolution via the ratio
 * of the calibration photo's native size to the golden's working size
 * (cfg.calibrationNativeWidth/Height, falling back to the golden's own
 * native size for files written before the geometry was recorded), since
 * mm/px is a property of the fixed physical rig, not of any particular
 * downscale.
 */
async function prepareGolden(buffer, cfg) {
	const nativeMeta = cfg.raw
		? { width: cfg.raw.width, height: cfg.raw.height }
		: await sharp(buffer).metadata();
	const { width, height } = goldenWorkingSize(
		nativeMeta.width,
		nativeMeta.height,
		cfg.workingSize,
	);
	const pixels = await decodeGray(buffer, width, height, cfg.raw);
	const {
		fg,
		level,
		ambiguous: fgAmbiguous,
	} = thresholdForeground(pixels, width, height, cfg);
	const fgDilatedBackground = dilate(fg, width, height, cfg.backgroundTolerance);

	const coarse = gridFor(width, height, COARSE_GRID);
	const medium = gridFor(width, height, MEDIUM_GRID);
	const fine = gridFor(width, height, FINE_GRID);
	const signatures = {
		coarse: buildGoldenSignature(fg, width, height, coarse.w, coarse.h),
		medium: buildGoldenSignature(fg, width, height, medium.w, medium.h),
		fine: buildGoldenSignature(fg, width, height, fine.w, fine.h),
	};

	// Decimated ink mask for the alignment polish to score candidates
	// against. Built the same way the polish builds the frame's side -
	// average the greys, then threshold - see decimateGrayBy2.
	//
	// A *fixed canvas*, not a fixed fraction of the golden. The polish only
	// has to rank sub-percent transform nudges, and how many pixels that
	// takes depends on the label, not on the working size; tying it to
	// workingSize made every objective call four times dearer at 3072 than
	// at 1024 for no gain, and the polish is the single largest cost in the
	// frame. The divisor stays a power of two so decimation is exact 2x2
	// box averaging, with no resampling error creeping into the objective.
	let objDivisor = 1;
	while (Math.max(width, height) / (objDivisor * 2) >= OBJECTIVE_LONG_EDGE)
		objDivisor *= 2;
	if (objDivisor < 2) objDivisor = 2;
	// A per-pixel mode has no single level to reuse here, so the objective
	// falls back to one global level on both sides; it only has to rank
	// candidate transforms consistently, not reproduce the real ink mask.
	const objectiveLevel = level != null ? level : otsuThreshold(pixels);
	let objGray = pixels;
	let objWidth = width;
	let objHeight = height;
	for (let d = 1; d < objDivisor; d *= 2) {
		const w = Math.max(1, objWidth >> 1);
		const h = Math.max(1, objHeight >> 1);
		objGray = decimateGrayBy2(objGray, objWidth, objHeight, w, h);
		objWidth = w;
		objHeight = h;
	}
	const fgObj = new Uint8Array(objGray.length);
	for (let i = 0; i < objGray.length; i++)
		fgObj[i] = objGray[i] < objectiveLevel ? 1 : 0;

	// Debug stages are rendered only when asked for: three PNG encodes of
	// the full golden, retained on the cached golden for the node's whole
	// lifetime - an unconditional render taxes every frame of every flow
	// that never looks at them. cfg.debugStages is baked into the golden
	// cache key in golden-compare.js so a flip of the flag re-prepares.
	// The three encodes run concurrently - sharp encodes off the JS thread,
	// so awaiting them one at a time was leaving the codec threads idle.
	const stages = cfg.debugStages
		? await allProps({
				goldenGray: renderGray(pixels, width, height, cfg),
				goldenFg: renderMask(fg, width, height, cfg),
				goldenFgDilatedBackground: renderMask(
					fgDilatedBackground,
					width,
					height,
					cfg,
				),
			})
		: null;
	// Raw, these ride on every frame's result, and the inspector's reply
	// to the calling thread copied all three (9 MB at 3 MP) every frame.
	// In shared memory the reply carries a handle instead.
	if (stages) {
		for (const key of Object.keys(stages)) {
			const image = stages[key];
			if (!Buffer.isBuffer(image) && image.data) {
				const shared = toShared(image.data);
				stages[key] = { ...image, data: Buffer.from(shared.buffer, shared.byteOffset, shared.byteLength) };
			}
		}
	}

	let mmPerWorkingPx = null;
	if (cfg.mmPerPixelNative != null) {
		// mmPerPixelNative was measured on the calibration photo, so the
		// conversion is expressed against *that* photo's native size, not the
		// golden's: the golden's own native resolution cancels out of the
		// ratio (calibration native / golden native) * (golden native / golden
		// working). Files written before the calibration recorded its own
		// geometry fall back to the golden's native size - the assumption
		// that golden and calibration photo are the same resolution.
		const nativeMaxDim =
			cfg.calibrationNativeWidth != null && cfg.calibrationNativeHeight != null
				? Math.max(cfg.calibrationNativeWidth, cfg.calibrationNativeHeight)
				: Math.max(nativeMeta.width, nativeMeta.height);
		const workingMaxDim = Math.max(width, height);
		mmPerWorkingPx = cfg.mmPerPixelNative * (nativeMaxDim / workingMaxDim);
	}

	// The golden is prepared once and then read by every frame, including
	// from worker threads. Left on ordinary buffers, each frame copied all
	// of it into shared memory again - toShared() on golden.gray, .fg,
	// .fgAmbiguous (twice) and .fgDilatedBackground, ~4ms a frame at 4.9MP,
	// to re-share something that has not changed since it was cached.
	// Sharing it here makes those calls the identity.
	//
	// The `x ? ... : null` is not defensive noise: fgAmbiguous is null
	// whenever inkMargin is 0, and toShared(null) throws.
	const share = (x) => (x ? toShared(x) : null);
	return {
		width,
		height,
		// native (pre-downscale) size, so the target can be brought to
		// golden's *realized* working scale - see computeTargetWorkingSize
		nativeWidth: nativeMeta.width,
		nativeHeight: nativeMeta.height,
		gray: share(pixels),
		fg: share(fg),
		// withheld from both checks' evidence, not from alignment
		fgAmbiguous: share(fgAmbiguous),
		fgObj: share(fgObj),
		objWidth,
		objHeight,
		objDivisor,
		objectiveLevel,
		fgDilatedBackground: share(fgDilatedBackground),
		thresholdLevel: level,
		signatures,
		stages,
		mmPerWorkingPx,
	};
}

/**
 * Compare one camera frame against a prepared golden reference. Safe to
 * call repeatedly against the same `golden` object (the hot path).
 */
async function compareFrame(buffer, golden, cfg) {
	const t0 = now();
	// The full native prototype also owns decode. PNG inflate is the largest
	// serial cost on high-compression rejects; OpenCV can decode directly to
	// grayscale and avoids entering sharp at all. Any native decode/resize
	// failure falls back to the established sharp path.
	const nativeDecoded =
		cfg.nativeFastAlign && nativeSeed.available()
			? await nativeSeed.decodeGray(buffer, cfg.targetRaw)
			: null;
	let targetMeta;
	if (nativeDecoded) {
		targetMeta = { width: nativeDecoded.width, height: nativeDecoded.height };
	} else if (cfg.targetRaw) {
		targetMeta = { width: cfg.targetRaw.width, height: cfg.targetRaw.height };
	} else {
		targetMeta = await sharp(buffer).metadata();
	}
	const targetWorking = computeTargetWorkingSize(
		targetMeta.width,
		targetMeta.height,
		golden,
		cfg,
	);
	const nativeGray = nativeDecoded
		? await nativeSeed.resizeGray(
				nativeDecoded,
				targetWorking.width,
				targetWorking.height,
			)
		: null;
	const targetGray =
		nativeGray ||
		(await decodeGray(
			buffer,
			targetWorking.width,
			targetWorking.height,
			cfg.targetRaw,
		));
	const decodeMs = now() - t0;

	const t1 = now();
	// Aggressive prototype: let OpenCV solve the full affine transform and
	// return the already-warped golden-sized grayscale frame. Try it before
	// thresholding: on success the full-resolution target mask is another
	// large allocation and scan that no later stage needs.
	const tNative = now();
	let nativeAligned =
		cfg.nativeFastAlign && nativeSeed.available()
			? await nativeSeed.alignFrame(
					golden.gray,
					golden.width,
					golden.height,
					targetGray,
					targetWorking.width,
					targetWorking.height,
					{
						scale: cfg.nativeFastAlignScale,
						eccRefine: cfg.nativeFastEccRefine,
					},
				)
			: null;
	const nativeAlignMs = now() - tNative;
	// why the frame is on the JS path when it was asked for OpenCV: the
	// validator's reason, or the engine producing nothing at all
	let nativeFallback =
		cfg.nativeFastAlign && nativeSeed.available() && !nativeAligned
			? "OpenCV returned no alignment"
			: null;
	if (nativeAligned) {
		nativeFallback = nativeSeed.validateAlignment(
			nativeAligned.transform,
			cfg.pinnedScale,
			cfg.maxAngleDeg,
		);
		if (nativeFallback) nativeAligned = null;
	}

	// The JS search needs the frame mask. OpenCV does not; it only needs the
	// scalar ink level later when the aligned canvas is thresholded. Preserve
	// targetFg under debugStages because it is a documented debug image.
	let targetFg = null;
	let targetLevel = null;
	if (nativeAligned) {
		if (cfg.thresholdMode === "fixed") targetLevel = cfg.threshold;
		if (cfg.debugStages) {
			const thresholded = thresholdForeground(
				targetGray,
				targetWorking.width,
				targetWorking.height,
				cfg,
			);
			targetFg = thresholded.fg;
			targetLevel = thresholded.level;
		}
	} else {
		const thresholded = thresholdForeground(
			targetGray,
			targetWorking.width,
			targetWorking.height,
			cfg,
		);
		targetFg = thresholded.fg;
		targetLevel = thresholded.level;
	}

	// One summed-area table over the frame's greys, shared by every
	// candidate warp in the polish stage and by the final full-resolution
	// warp below. The native fast path needs neither consumer.
	const tTable = now();
	const grayTable = nativeAligned
		? null
		: await buildGrayTableParallel(
				targetGray,
				targetWorking.width,
				targetWorking.height,
				cfg.workers,
			);
	const tableMs = nativeAligned ? 0 : now() - tTable;

	// One shared copy of the frame's greys for every JS stage that dispatches
	// to the pool. OpenCV consumed the original view directly and has already
	// produced the only aligned canvas the fast path needs.
	const sharedTargetGray = nativeAligned ? targetGray : toShared(targetGray);

	// The polish objective: resample the frame into a half-resolution
	// golden grid under the candidate transform, threshold it at the
	// frame's own level, and count pixels that disagree with golden's ink.
	// A fixed level (rather than re-deriving one per candidate) keeps the
	// comparison between candidates honest - otherwise a transform could
	// improve its score by shifting the level rather than the alignment.
	let objectiveLevel = 0;
	if (!nativeAligned) {
		objectiveLevel =
			targetLevel != null ? targetLevel : otsuThreshold(targetGray);
	}
	const D = golden.objDivisor;
	// Half-resolution pixel x covers golden pixels 2x and 2x+1, so an
	// objective pixel x covers golden pixels Dx .. Dx+D-1 and its centre
	// sits at golden index Dx + (D-1)/2. The transform has to be
	// re-expressed for that grid - magnifications scaled by D, origin
	// shifted by the half-cell through the same rotation - rather than
	// simply scaled, which would sample half a cell off.
	//
	// Done here rather than inside the scorer so that both the serial and
	// the batched forms score candidates in identical coordinates: the
	// worker kernel deliberately does no conversion of its own.
	const toObjectiveGrid = (c) => {
		const cos = Math.cos(c.theta);
		const sin = Math.sin(c.theta);
		const half = (D - 1) / 2;
		return {
			mx: c.mx * D,
			my: c.my * D,
			theta: c.theta,
			ox: c.ox + half * (cos * c.mx - sin * c.my),
			oy: c.oy + half * (sin * c.mx + cos * c.my),
		};
	};

	// The serial scorer stays the reference implementation: resample the
	// frame into the decimated golden grid under the candidate transform,
	// threshold it at the frame's own level, and count pixels that disagree
	// with golden's ink.
	const scoreOne = (g) => {
		const gray = warpGray(
			sharedTargetGray,
			targetWorking.width,
			targetWorking.height,
			g.mx,
			g.my,
			g.theta,
			g.ox,
			g.oy,
			golden.objWidth,
			golden.objHeight,
			255,
			grayTable,
		);
		let mismatch = 0;
		for (let i = 0; i < gray.length; i++) {
			const fgPixel = gray[i] < objectiveLevel ? 1 : 0;
			if (fgPixel !== golden.fgObj[i]) mismatch++;
		}
		return mismatch / gray.length;
	};

	// The frame descriptor the batched scorer needs. Built once per frame:
	// toShared() on a 17.5MP frame costs ~3ms, and the polish asks for ten
	// to twenty batches, so building it per batch would cost more than the
	// parallelism saves.
	const objectiveFrame = {
		gray: sharedTargetGray,
		width: targetWorking.width,
		height: targetWorking.height,
		table: grayTable,
		outW: golden.objWidth,
		outH: golden.objHeight,
		level: objectiveLevel,
		fgObj: golden.fgObj,
	};

	const objectiveBatch = async (cands) => {
		const grid = cands.map(toObjectiveGrid);
		const par = await objectiveBatchParallel(grid, objectiveFrame, cfg.workers);
		return par || grid.map(scoreOne);
	};

	// PROTOTYPE, off unless nativeAlignSeed is set and the optional engine
	// is installed: hand the pinned search a starting point measured by
	// ORB+ECC instead of one found by sweeping. Falls back to the sweeps
	// on anything unexpected - a missing engine, a failed alignment, or a
	// seed outside the physically plausible range.
	//
	// Never after the fast path has failed on this frame. The seed is the
	// same engine call at full resolution with more iterations, so it can
	// only repeat the failure at greater cost - and on the rig it did, on
	// every heavily defective frame: 0.3s to produce nothing again, 4-7s
	// to produce a seed the polish then made nothing of. That was the
	// whole of why a fail took seconds and a pass 150ms.
	let seed = null;
	let seedMs = 0;
	if (
		!nativeAligned &&
		!nativeFallback &&
		cfg.nativeAlignSeed &&
		cfg.pinnedScale &&
		nativeSeed.available()
	) {
		const tSeed = now();
		seed = await nativeSeed.seedTransform(
			golden.gray,
			golden.width,
			golden.height,
			targetGray,
			targetWorking.width,
			targetWorking.height,
		);
		seedMs = now() - tSeed;
	}

	const tSearch = now();
	let transform;
	if (nativeAligned) {
		transform = {
			...nativeAligned.transform,
			thetaDeg: (nativeAligned.transform.theta * 180) / Math.PI,
			score: NaN,
			pinned: false,
			native: true,
		};
	} else {
		transform = await findTransform(
			golden.width,
			golden.height,
			targetFg,
			targetWorking.width,
			targetWorking.height,
			golden.signatures,
			{
				scaleMin: cfg.scaleSearchMin,
				scaleMax: cfg.scaleSearchMax,
				scaleSteps: cfg.scaleSearchSteps,
				maxAspect: cfg.maxAspect,
				aspectSteps: cfg.aspectSteps,
				// how many stage-2 scale hypotheses survive to be judged on
				// pixels rather than on the coarse density proxy
				rankedCandidates: cfg.alignCandidates,
				// a trained transform pins magnification and stretch, leaving
				// only the per-part unknowns (where it sits, how square) to solve
				pinnedScale: cfg.pinnedScale || null,
				maxAngleDeg: cfg.maxAngleDeg,
				angleSteps: cfg.angleSteps,
				slackPx: cfg.alignSearch,
				objectiveBatch,
				// the frame's summed-area table is per-frame work over the whole
				// canvas; the pool is otherwise idle while it is built
				buildTable: (fg, w, h) => buildIntegralParallel(fg, w, h, cfg.workers),
				seed,
			},
		);
		if (nativeFallback) transform.nativeFallback = nativeFallback;
	}

	const searchMs = nativeAligned ? nativeAlignMs : now() - tSearch;

	const tWarp = now();
	let alignedTargetGray = nativeAligned
		? nativeAligned.gray
		: await warpParallel(
				sharedTargetGray,
				targetWorking.width,
				targetWorking.height,
				transform.mx,
				transform.my,
				transform.theta,
				transform.ox,
				transform.oy,
				golden.width,
				golden.height,
				255,
				grayTable,
				cfg.workers,
			);
	const warpMs = nativeAligned ? 0 : now() - tWarp;

	// The global transform places the label; it cannot place all of it.
	// What is left is a non-smooth field - most of the frame sub-pixel,
	// some regions several px out - which no higher-order global model
	// reaches. See lib/localAlign.js.
	const tLocal = now();
	let localAlign = null;
	if (cfg.localAlign) {
		const refined =
			(await refineLocallyParallel(
				golden.gray,
				alignedTargetGray,
				golden.width,
				golden.height,
				cfg,
			)) ||
			refineLocally(
				golden.gray,
				alignedTargetGray,
				golden.width,
				golden.height,
				cfg,
			);
		alignedTargetGray = refined.gray;
		localAlign = refined;
	}

	const localAlignMs = now() - tLocal;

	// On a training frame: how far off register the frame still sits
	// after the alignment above, which is what the tone and speck checks
	// have to allow for (lib/localAlign.js measureRegister)
	let register = null;
	let registerMs = 0;
	if (cfg.measureRegister) {
		const tRegister = now();
		register = measureRegister(golden.gray, alignedTargetGray, golden.width, golden.height, cfg);
		registerMs = now() - tRegister;
	}

	const tThresh = now();
	// Sauvola has no single level to hand the workers, so it stays serial.
	let alignedTargetFg;
	let alignedTargetAmbiguous;
	const globalLevel =
		cfg.thresholdMode === "sauvola"
			? null
			: cfg.thresholdMode === "otsu"
				? otsuThreshold(alignedTargetGray)
				: cfg.threshold;
	// The native path never needed to threshold the unaligned 22MP frame.
	// Report the level actually used on its aligned canvas instead.
	if (nativeAligned && targetLevel == null) targetLevel = globalLevel;
	const binarized =
		globalLevel === null
			? null
			: await binarizeParallel(
					alignedTargetGray,
					golden.width,
					golden.height,
					globalLevel,
					cfg.inkMargin > 0 ? cfg.inkMargin : 0,
					cfg.workers,
				);
	if (binarized) {
		alignedTargetFg = binarized.fg;
		alignedTargetAmbiguous = binarized.ambiguous;
	} else {
		const serial = thresholdForeground(
			alignedTargetGray,
			golden.width,
			golden.height,
			cfg,
		);
		alignedTargetFg = serial.fg;
		alignedTargetAmbiguous = serial.ambiguous;
	}

	// How much of the golden's ink the frame contains at all. Every check
	// below assumes the label is there and asks what is wrong with it, and
	// a frame with no ink answers each of them "nothing": the search sits
	// at nominal because every placement scores alike, and with a wide
	// inkMargin the ambiguity band voids every blemish claim - so a blank
	// tray passed on the rig as a clean part. Counted on the aligned mask,
	// so a label that is there but printed badly still scores high: a
	// print missing 8% of its ink covers 92%. gradeMatch turns it into a
	// verdict.
	let goldenInk = 0;
	let coveredInk = 0;
	for (let i = 0; i < golden.fg.length; i++) {
		if (golden.fg[i]) {
			goldenInk++;
			if (alignedTargetFg[i]) coveredInk++;
		}
	}
	const coverage = goldenInk ? coveredInk / goldenInk : 1;

	if (nativeAligned) {
		// imageAlign does not expose ECC's correlation. Use the actual full-size
		// post-alignment mask disagreement instead; this is deliberately allowed
		// to differ from the JS polish's 320px pre-local-refinement objective.
		let mismatch = 0;
		for (let i = 0; i < alignedTargetFg.length; i++) {
			if (alignedTargetFg[i] !== golden.fg[i]) mismatch++;
		}
		transform.score = mismatch / alignedTargetFg.length;
		// Disagreement cannot tell a misaligned frame from a defective one.
		// Under a trained transform it does not have to: validateAlignment
		// has already held OpenCV's scale to within 3% of the trained one
		// and its angle within the limit, which is the misalignment check,
		// so what is left in the disagreement is the frame's own defects.
		// Gating on it there sent every heavily defective print through the
		// full JS search - seconds on the rig, against 70ms - to reach the
		// same verdict. Without a pin there is nothing to hold the scale
		// against, so the gate stays for the unpinned search.
		const maxNativeScore = 0.15;
		if (!cfg.pinnedScale && transform.score > maxNativeScore) {
			const attemptedMs = now() - t0;
			const fallback = await compareFrame(buffer, golden, {
				...cfg,
				nativeFastAlign: false,
				nativeAlignSeed: false,
			});
			fallback.transform.nativeFallback = `OpenCV score ${transform.score.toFixed(4)} exceeds ${maxNativeScore.toFixed(2)}`;
			fallback.timings.nativeFallbackMs = attemptedMs;
			fallback.timings.totalMs += attemptedMs;
			return fallback;
		}
	}
	const thresholdMs = now() - tThresh;
	const alignMs = now() - t1;

	// Placement is measured at the label's centre against the frame's
	// centre - nominal being the same magnification and squareness,
	// centred in whatever margin the frame has, which degrades to (0,0)
	// when frame and golden are the same size at m = 1.
	//
	// Not at the corner. The model maps golden (gx, gy) to
	// ox + cos*mx*gx - sin*my*gy, oy + sin*mx*gx + cos*my*gy, so (ox, oy)
	// is where the golden's top-left corner lands - and a label rotated
	// about its own centre moves that corner by about half its height
	// times sin(theta): 12-14px at 0.7 degrees on a 2100px label, charged
	// against the position tolerance as an offset the part did not have.
	// The synthetic benchmark's clean frames failed on position for
	// exactly that. At the centre a rotation is a rotation and an offset
	// is an offset; at theta = 0 the two measurements are identical.
	const cosT = Math.cos(transform.theta);
	const sinT = Math.sin(transform.theta);
	const halfW = golden.width / 2;
	const halfH = golden.height / 2;
	const centreX = transform.ox + cosT * transform.mx * halfW - sinT * transform.my * halfH;
	const centreY = transform.oy + sinT * transform.mx * halfW + cosT * transform.my * halfH;
	// reported in golden working px, so it shares units with the region
	// boxes and converts to mm with the one mmPerWorkingPx factor
	const dxPx = Math.round((centreX - targetWorking.width / 2) / transform.mx);
	const dyPx = Math.round((centreY - targetWorking.height / 2) / transform.my);
	const position = evaluatePosition(
		dxPx,
		dyPx,
		transform.thetaDeg,
		transform.mx,
		transform.my,
		golden.mmPerWorkingPx,
		cfg,
	);

	const t2 = now();
	const targetFgDilatedPrint = await dilateParallel(
		alignedTargetFg,
		golden.width,
		golden.height,
		cfg.printTolerance,
		cfg.workers,
	);
	const printPar = await defectParallel(
		golden.fg,
		targetFgDilatedPrint,
		golden.fgAmbiguous,
		alignedTargetAmbiguous,
		golden.width,
		golden.height,
		cfg.workers,
	);
	const { defect: printDefect, count: printDefectRaw } =
		printPar ||
		computeDefect(
			golden.fg,
			targetFgDilatedPrint,
			golden.fgAmbiguous,
			alignedTargetAmbiguous,
		);
	const backgroundPar = await defectParallel(
		alignedTargetFg,
		golden.fgDilatedBackground,
		alignedTargetAmbiguous,
		golden.fgAmbiguous,
		golden.width,
		golden.height,
		cfg.workers,
	);
	const { defect: backgroundDefect, count: backgroundDefectRaw } =
		backgroundPar ||
		computeDefect(
			alignedTargetFg,
			golden.fgDilatedBackground,
			alignedTargetAmbiguous,
			golden.fgAmbiguous,
		);
	// Both channels, so the masks, stages and heat maps agree on what was
	// judged: the outer edgeMargin px of the golden are nobody's evidence.
	const printDefectCount = clearEdge(
		printDefect,
		printDefectRaw,
		golden.width,
		golden.height,
		cfg.edgeMargin,
	);
	const backgroundDefectCount = clearEdge(
		backgroundDefect,
		backgroundDefectRaw,
		golden.width,
		golden.height,
		cfg.edgeMargin,
	);
	const diffMs = now() - t2;

	// The two blemish results are independent, and each ends in an encode
	// that runs off the JS thread: awaiting them in sequence serialised
	// the codec work for no reason.
	const t3 = now();
	// The nuisance map is trained from the background channel and says
	// what "extra ink" looks like on a good part, block by block. It has
	// nothing to say about missing ink, so the print channel is judged
	// without it - with it, any print block at the novelty threshold
	// failed against a baseline that was never measured for print.
	const printCfg = cfg.nuisanceBaseline ? { ...cfg, nuisanceBaseline: null } : cfg;
	const [printBlemish, backgroundBlemish] = await Promise.all([
		buildBlemishResult(
			printDefect,
			printDefectCount,
			golden.width,
			golden.height,
			alignedTargetGray,
			printCfg,
			cfg.outputPrintHeatmap,
			golden.fg,
		),
		buildBlemishResult(
			backgroundDefect,
			backgroundDefectCount,
			golden.width,
			golden.height,
			alignedTargetGray,
			cfg,
			cfg.outputBackgroundHeatmap,
		),
	]);
	const heatmapMs = now() - t3;

	// The tone and speck checks, after the two binary ones: the same
	// aligned grey, the same golden ink, the same block machinery, so their
	// regions live in the same working pixels.
	const tTone = now();
	// one shape for a check that did not run, so every consumer reads the
	// same fields; `reason` says why when it was asked for and could not
	const off = (reason) => ({
		enabled: false,
		pass: true,
		defectRatio: 0,
		regions: [],
		heatmap: null,
		...(reason ? { reason } : {}),
	});
	let tone = null;
	let toneBlemish = null;
	if (cfg.toneThreshold > 0 || cfg.speckThreshold > 0) {
		tone = await toneDefect(golden, alignedTargetGray, cfg, !!cfg.debugStages);
		if (tone.enabled) {
			const toneCount = clearEdge(tone.defect, tone.count, golden.width, golden.height, cfg.edgeMargin);
			if (tone.speck) clearBorder(tone.speck, golden.width, golden.height, cfg.edgeMargin);
			if (tone.map) clearBorder(tone.map, golden.width, golden.height, cfg.edgeMargin);
			if (cfg.toneThreshold > 0) {
				// no nuisance baseline: the map is trained on the background
				// channel's density and says nothing about tone
				const toneCfg = cfg.nuisanceBaseline ? { ...cfg, nuisanceBaseline: null } : cfg;
				toneBlemish = await buildBlemishResult(
					tone.defect,
					toneCount,
					golden.width,
					golden.height,
					alignedTargetGray,
					toneCfg,
					cfg.outputToneHeatmap,
				);
				toneBlemish.enabled = true;
				toneBlemish.paperLevel = tone.paperLevel;
				toneBlemish.slackMin = tone.slackMin;
				toneBlemish.slackMax = tone.slackMax;
				toneBlemish.slackMapApplied = tone.mapApplied;
				toneBlemish.inkLevel = tone.inkLevel;
			}
		} else {
			toneBlemish = off(tone.reason);
		}
	}
	if (!toneBlemish) toneBlemish = off();
	const toneMs = now() - tTone;

	const tSpeck = now();
	let speckBlemish;
	if (tone && tone.enabled && tone.speck) {
		speckBlemish = await speckCheck(
			golden,
			tone,
			cfg,
			alignedTargetGray,
			cfg.outputSpeckHeatmap,
			toneBlemish.enabled ? toneBlemish.regions : [],
		);
	} else {
		speckBlemish = { ...off(tone && !tone.enabled ? tone.reason : null), count: 0, area: 0, largest: 0 };
	}
	const speckMs = now() - tSpeck;
	// the slack the tone and speck checks ran with, whichever of them was
	// on: toneBlemish is off() when only the specks are
	const toneSlack =
		tone && tone.enabled ? { min: tone.slackMin, max: tone.slackMax, mapApplied: tone.mapApplied } : null;

	// the one picture, only when asked: every region of every check on the
	// aligned frame, each in its own colour
	const tOverlay = now();
	const heatmap = cfg.outputHeatmap
		? await renderOverlay(
				alignedTargetGray,
				golden.width,
				golden.height,
				[
					{ mask: backgroundDefect, regions: backgroundBlemish.regions, rgb: OVERLAY_COLOURS.background },
					{ mask: printDefect, regions: printBlemish.regions, rgb: OVERLAY_COLOURS.print },
					...(toneBlemish.enabled
						? [{ mask: tone.defect, regions: toneBlemish.regions, rgb: OVERLAY_COLOURS.tone }]
						: []),
					...(speckBlemish.enabled
						? [{ mask: tone.speck, regions: speckBlemish.regions, rgb: OVERLAY_COLOURS.speck, grow: OVERLAY_SPECK_GROW }]
						: []),
				],
				cfg,
			)
		: null;
	const overlayMs = now() - tOverlay;

	let stages = null;
	const t4 = now();
	if (cfg.debugStages) {
		const { width, height } = golden;
		stages = {
			...golden.stages,
			...(await allProps({
				// full pre-warp canvas, so you can see where the match landed
				// within the whole frame - generally a different size than
				// golden's (that's the point)
				targetGray: renderGray(
					targetGray,
					targetWorking.width,
					targetWorking.height,
					cfg,
				),
				targetFg: renderMask(
					targetFg,
					targetWorking.width,
					targetWorking.height,
					cfg,
				),
				// golden-sized from here on: the matched region, resampled
				targetGrayAligned: renderGray(alignedTargetGray, width, height, cfg),
				targetFgAligned: renderMask(alignedTargetFg, width, height, cfg),
				...(tone && tone.enabled && tone.map
					? { toneDeviation: renderGray(tone.map, width, height, cfg) }
					: {}),
				targetFgDilatedPrint: renderMask(
					targetFgDilatedPrint,
					width,
					height,
					cfg,
				),
				printDefect: renderMask(printDefect, width, height, cfg),
				backgroundDefect: renderMask(backgroundDefect, width, height, cfg),
				// The trained nuisance baseline, drawn over the golden the way
				// a heat map is drawn over the frame: every block that was ever
				// dirty on a good part, as red as its baseline is high. Only
				// when a map is loaded - there is nothing to draw otherwise.
				...(cfg.nuisanceBaseline && backgroundBlemish.gridW
					? {
							nuisanceBaseline: renderHeatmap(
								golden.gray,
								width,
								height,
								cfg.nuisanceBaseline,
								backgroundBlemish.gridW,
								backgroundBlemish.gridH,
								cfg.blockSize,
								// one quantisation step: any non-zero baseline shows
								1 / 255,
								cfg,
							),
						}
					: {}),
			})),
		};
	}
	const stagesMs = now() - t4;

	const match = gradeMatch(
		transform.score,
		coverage,
		printBlemish,
		backgroundBlemish,
		cfg,
	);
	const pass =
		position.pass &&
		printBlemish.pass &&
		backgroundBlemish.pass &&
		toneBlemish.pass &&
		speckBlemish.pass &&
		!match.labelMissing;

	return {
		pass,
		match,
		position,
		printBlemish,
		backgroundBlemish,
		toneBlemish,
		speckBlemish,
		toneSlack,
		heatmap,
		stages,
		width: golden.width,
		height: golden.height,
		transform: {
			pinned: !!transform.pinned,
			native: !!transform.native,
			nativeFallback: transform.nativeFallback || null,
			// PROTOTYPE: true when the pinned search started from a native
			// ORB+ECC seed rather than the staged sweeps. Reported because a
			// flag you cannot see the effect of is a flag you cannot trust.
			seeded: !!transform.seeded,
			scaleX: transform.mx,
			scaleY: transform.my,
			scale: Math.sqrt(transform.mx * transform.my),
			stretchPercent: (transform.my / transform.mx - 1) * 100,
			angleDeg: transform.thetaDeg,
			ox: transform.ox,
			oy: transform.oy,
			score: transform.score,
		},
		thresholds: { golden: golden.thresholdLevel, target: targetLevel },
		localAlign: localAlign ? localAlign.stats : null,
		register,
		targetWorking,
		timings: {
			decodeMs,
			alignMs,
			// the align bucket broken out - it dominates, and its parts
			// respond to completely different settings
			nativeAlignMs: cfg.nativeFastAlign ? nativeAlignMs : 0,
			seedMs,
			tableMs,
			searchMs,
			warpMs,
			localAlignMs,
			registerMs,
			thresholdMs,
			diffMs,
			heatmapMs,
			toneMs,
			speckMs,
			overlayMs,
			stagesMs,
			totalMs: decodeMs + alignMs + diffMs + heatmapMs + toneMs + speckMs + overlayMs + stagesMs,
		},
	};
}

module.exports = {
	prepareGolden,
	compareFrame,
	// exported for unit testing
	computeTargetWorkingSize,
	buildHeatmapGrid,
};
