/**
 * Deskew-and-crop a physical label out of a camera frame, using an OpenCV
 * engine as the pixel worker and keeping only low-resolution analysis in
 * JS. lib/engine.js supplies that engine: the native cpp-bridge of
 * @rosepetal/node-red-contrib-image-tools where it has a prebuilt binary,
 * otherwise the opencv.js WASM build in lib/cvjs.js.
 *
 * Why this shape (see ARCHITECTURE.md "label-crop"):
 *
 *  - The heavy stages belong to the engine: decode, resize, Otsu, rotate,
 *    crop and final encoding all run inside OpenCV. JS only touches the
 *    <= maxEdge detection mask (connected components + a convex-hull
 *    minimum-area rectangle), which is a few hundred kilobytes.
 *  - Encoded input is decoded exactly once (colorConvert(buffer, RGB)),
 *    and the output preserves the decoded channel layout through the
 *    rotate/crop chain.
 *  - Only a tight ROI around the label is ever rotated. Rotating the
 *    whole frame would cost the full canvas even for a small label, and
 *    the engine's rotate pads the canvas it is given - padding a small
 *    ROI is free, padding a 23MP frame is not.
 *  - Rotation uses the detected boundary angle with OpenCV's image-coordinate
 *    convention; the label rectangle becomes axis-aligned, so the final
 *    crop is the centred w x h rect - exactly tight to the label, no
 *    perspective correction, no content-aware decisions.
 *  - Confidence gates keep bad evidence from being trusted: a blob that
 *    is too small, touches the frame border, is not rectangular, is not
 *    dominant, or violates an optional expected aspect ratio is a
 *    **miss** (the caller keeps the original frame), never a wrong crop.
 *  - The engine is a setup dependency, not a fallback: if the bridge
 *    cannot be loaded this module throws, so the node can report a setup
 *    error instead of silently passing every frame through.
 *
 * The engine interface is the promisified cpp-bridge of
 * @rosepetal/node-red-contrib-image-tools:
 *
 *   colorConvert(image, targetColorSpace, [fmt], [q], [pngOpt]) -> {image, timing}
 *   resize(image, wMode, wVal, hMode, hVal, [fmt], [q], [pngOpt]) -> {image, timing}
 *   filter(image, type, kernel, intensity, [fmt], [q], [pngOpt])   -> {image, timing}
 *   crop(image, x, y, w, h, normalized, [fmt], [q], [pngOpt])      -> {image, timing}
 *   rotate(image, angleDeg, [padColor], [fmt], [q], [pngOpt])      -> {image, timing}
 *
 * with `image` either an encoded Buffer (decoded by the engine) or a raw
 * { data, width, height, channels, colorSpace, dtype } object.
 */

const { performance } = require("node:perf_hooks");
const { findLine, rectFromLines } = require("./lineFinder.js");

// Which OpenCV backend answers these ops - the native cpp-bridge (prebuilt
// for Linux x64/arm64, Alpine x64, macOS x64/arm64) or the opencv.js WASM
// build - is lib/engine.js's decision, not this module's.
const ENGINE_UNAVAILABLE_PREFIX = "label-crop: OpenCV engine unavailable: ";
const DEG = Math.PI / 180;

const OUTPUT_FORMATS = ["raw", "jpg", "png", "webp"];
const POLARITIES = ["auto", "light", "dark"];

const BOUNDARY_MODES = ["blob", "calipers"];

const DEFAULTS = {
	// "blob" thresholds the whole frame and takes the dominant region;
	// "calipers" fits the boundary from four drawn line-finder regions,
	// for a label whose own edge is fainter than the print inside it
	boundaryMode: "blob",
	// calipers mode only: { left, right, top, bottom }, each an object of
	// { x, y, width, height, angleDeg? } plus any lib/lineFinder.js option
	edgeRegions: null,
	// long edge of the detection copy, px
	maxEdge: 640,
	// how the label relates to the background: dark label on light
	// background = "dark", light label on dark background = "light"
	polarity: "auto",
	// component must cover at least this fraction of the frame
	minAreaFraction: 0.05,
	// blob area must fill at least this fraction of its exterior rectangle
	minRectangularity: 0.4,
	// fraction of the blob's bbox edges allowed to touch the frame border;
	// 0.5 permits a label clipped by two opposite frame edges while still
	// rejecting a full-frame background component
	maxBorderContact: 0.5,
	// reject a foreground region that implausibly consumes nearly the frame
	maxAreaFraction: 0.9,
	// the best blob must be at least this many times the second-best
	minDominance: 1.5,
	// overall gate; below this the detection is a miss
	minConfidence: 0.4,
	// optional expected w/h of the label in the deskewed frame
	aspectRatio: null,
	aspectTolerance: 0.15,
	// optional expected label area as a fraction of the frame (measured by
	// drawing over a representative sample); blank = no size gate
	expectedSizeFraction: null,
	sizeTolerance: 0.2,
	// extra ring around the label bbox before rotation, as a fraction of
	// the label's long dimension (keeps the rotate from sampling past the
	// ROI boundary); the ring is cropped away by the final tight crop
	cropMargin: 0.02,
	// below this angle the rotation is skipped and the label is cropped
	// directly from the frame
	minRotateAngleDeg: 0.5,
	outputFormat: "raw",
	outputQuality: 90,
	pngOptimize: false,
	padColor: "#000000",
};

// ---- engine loading ----------------------------------------------------

// undefined = ask lib/engine.js, null = forced unavailable by a test,
// object = injected by a test
let bridge;

/**
 * lib/engine.js picks between the native cpp-bridge and the opencv.js WASM
 * build; every op below is written against the shape they share, so which
 * one answers changes only timing (and the pixel-level notes marked
 * DIVERGES in lib/cvjs.js). An injected engine always wins.
 *
 * Throws (setup error) when no engine is available - the node treats that
 * as a configuration problem, not as "no label found".
 */
function fromSelection(selected) {
	if (!selected.engine) {
		throw new Error(
			ENGINE_UNAVAILABLE_PREFIX +
				(selected.error ? selected.error.message : "engine not installed"),
		);
	}
	return selected.engine;
}

/** Synchronous, best effort - see lib/engine.js on why that is not the
 * whole story for the native addon. */
function getBridge() {
	if (bridge !== undefined) {
		return fromSelection({ engine: bridge, error: null });
	}
	// eslint-disable-next-line global-require
	return fromSelection(require("./engine.js").candidate());
}

/** What the op path uses: waits for the native addon's own load result
 * before settling on an engine. */
async function getBridgeAsync() {
	if (bridge !== undefined) {
		return fromSelection({ engine: bridge, error: null });
	}
	// eslint-disable-next-line global-require
	return fromSelection(await require("./engine.js").resolve());
}

/** True when an engine can be loaded (or was injected). */
function available() {
	try {
		return getBridge() !== null;
	} catch {
		return false;
	}
}

/** Test seam: replace the lazily loaded engine (or force the unavailable
 * state with null). */
function _setBridge(fake) {
	bridge = fake;
}

/** Test seam: forget the cached loader state. */
function _resetBridge() {
	bridge = undefined;
}

// ---- config -------------------------------------------------------------

function normalizeCfg(cfg = {}) {
	const out = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS)) {
		const v = cfg[k];
		if (v !== undefined && v !== null && v !== "") out[k] = v;
	}
	const finiteOr = (value, fallback) => {
		const n = Number(value);
		return Number.isFinite(n) ? n : fallback;
	};
	if (!BOUNDARY_MODES.includes(out.boundaryMode)) {
		out.boundaryMode = DEFAULTS.boundaryMode;
	}
	if (out.edgeRegions != null && typeof out.edgeRegions !== "object") {
		out.edgeRegions = null;
	}
	if (!POLARITIES.includes(out.polarity)) out.polarity = DEFAULTS.polarity;
	if (!OUTPUT_FORMATS.includes(out.outputFormat))
		out.outputFormat = DEFAULTS.outputFormat;
	out.maxEdge = Math.max(
		32,
		Math.min(4096, Math.round(finiteOr(out.maxEdge, DEFAULTS.maxEdge))),
	);
	out.minAreaFraction = Math.max(
		0.001,
		Math.min(0.9, finiteOr(out.minAreaFraction, DEFAULTS.minAreaFraction)),
	);
	out.maxAreaFraction = Math.max(
		out.minAreaFraction,
		Math.min(0.999, finiteOr(out.maxAreaFraction, DEFAULTS.maxAreaFraction)),
	);
	out.minRectangularity = Math.max(
		0.05,
		Math.min(1, finiteOr(out.minRectangularity, DEFAULTS.minRectangularity)),
	);
	out.maxBorderContact = Math.max(
		0,
		Math.min(1, finiteOr(out.maxBorderContact, DEFAULTS.maxBorderContact)),
	);
	out.minDominance = Math.max(
		1.01,
		finiteOr(out.minDominance, DEFAULTS.minDominance),
	);
	out.minConfidence = Math.max(
		0.01,
		Math.min(1, finiteOr(out.minConfidence, DEFAULTS.minConfidence)),
	);
	out.cropMargin = Math.max(
		0,
		Math.min(0.25, finiteOr(out.cropMargin, DEFAULTS.cropMargin)),
	);
	out.minRotateAngleDeg = Math.max(
		0,
		Math.min(10, finiteOr(out.minRotateAngleDeg, DEFAULTS.minRotateAngleDeg)),
	);
	out.aspectTolerance = Math.max(
		0.01,
		Math.min(1, finiteOr(out.aspectTolerance, DEFAULTS.aspectTolerance)),
	);
	out.sizeTolerance = Math.max(
		0.01,
		Math.min(1, finiteOr(out.sizeTolerance, DEFAULTS.sizeTolerance)),
	);
	out.outputQuality = Math.max(
		1,
		Math.min(
			100,
			Math.round(finiteOr(out.outputQuality, DEFAULTS.outputQuality)),
		),
	);
	out.pngOptimize = !!out.pngOptimize;
	if (out.aspectRatio != null && out.aspectRatio !== "") {
		const a = Number(out.aspectRatio);
		out.aspectRatio = Number.isFinite(a) && a > 0 ? a : null;
	}
	if (out.expectedSizeFraction != null && out.expectedSizeFraction !== "") {
		const s = Number(out.expectedSizeFraction);
		out.expectedSizeFraction = Number.isFinite(s) && s > 0 && s < 1 ? s : null;
	}
	return out;
}

// ---- input handling -----------------------------------------------------

function isRawImage(v) {
	return (
		v !== null &&
		typeof v === "object" &&
		typeof v.width === "number" &&
		typeof v.height === "number" &&
		(ArrayBuffer.isView(v.data) || Buffer.isBuffer(v.data))
	);
}

/** Copy a raw descriptor into the engine's canonical shape without copying
 * its pixels: the data view is shared, not cloned. */
function normalizeRaw(v) {
	const data = Buffer.isBuffer(v.data)
		? v.data
		: Buffer.from(v.data.buffer, v.data.byteOffset, v.data.byteLength);
	const width = Number(v.width);
	const height = Number(v.height);
	const channels = Number(v.channels || (v.colorSpace === "GRAY" ? 1 : 3));
	const dtype = v.dtype || "uint8";
	if (
		!Number.isInteger(width) ||
		width <= 0 ||
		!Number.isInteger(height) ||
		height <= 0
	) {
		throw new Error("label-crop: raw width and height must be positive integers");
	}
	if (![1, 3, 4].includes(channels)) {
		throw new Error("label-crop: raw channels must be 1, 3, or 4");
	}
	if (dtype !== "uint8") {
		throw new Error("label-crop: raw dtype must be uint8");
	}
	const expectedBytes = width * height * channels;
	if (!Number.isSafeInteger(expectedBytes) || data.byteLength < expectedBytes) {
		throw new Error(
			`label-crop: raw data is shorter than ${width}x${height}x${channels}`,
		);
	}
	let defaultColorSpace = "RGB";
	if (channels === 1) defaultColorSpace = "GRAY";
	else if (channels === 4) defaultColorSpace = "RGBA";
	return {
		data,
		width,
		height,
		channels,
		colorSpace: v.colorSpace || defaultColorSpace,
		dtype,
	};
}

// ---- low-resolution analysis (the only JS pixel work) -------------------

function connectedComponentsStats(mask, width, height) {
	const n = width * height;
	const visited = new Uint8Array(n);
	const stack = new Int32Array(n);
	const comps = [];
	for (let start = 0; start < n; start++) {
		if (!mask[start] || visited[start]) continue;
		let sp = 0;
		visited[start] = 1;
		stack[sp++] = start;
		let area = 0;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let sumX = 0;
		let sumY = 0;
		const seed = start;
		while (sp > 0) {
			const idx = stack[--sp];
			const x = idx % width;
			const y = (idx / width) | 0;
			area++;
			sumX += x;
			sumY += y;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			if (x > 0 && mask[idx - 1] && !visited[idx - 1]) {
				visited[idx - 1] = 1;
				stack[sp++] = idx - 1;
			}
			if (x < width - 1 && mask[idx + 1] && !visited[idx + 1]) {
				visited[idx + 1] = 1;
				stack[sp++] = idx + 1;
			}
			if (y > 0 && mask[idx - width] && !visited[idx - width]) {
				visited[idx - width] = 1;
				stack[sp++] = idx - width;
			}
			if (y < height - 1 && mask[idx + width] && !visited[idx + width]) {
				visited[idx + width] = 1;
				stack[sp++] = idx + width;
			}
		}
		comps.push({
			area,
			cx: sumX / area,
			cy: sumY / area,
			x0: minX,
			y0: minY,
			x1: maxX + 1,
			y1: maxY + 1,
			seed,
		});
	}
	return comps;
}

function collectPixels(mask, width, height, seed) {
	const n = width * height;
	const visited = new Uint8Array(n);
	const stack = new Int32Array(n);
	const px = new Int32Array(n);
	let sp = 0;
	let count = 0;
	visited[seed] = 1;
	stack[sp++] = seed;
	while (sp > 0) {
		const idx = stack[--sp];
		px[count++] = idx;
		const x = idx % width;
		if (x > 0 && mask[idx - 1] && !visited[idx - 1]) {
			visited[idx - 1] = 1;
			stack[sp++] = idx - 1;
		}
		if (x < width - 1 && mask[idx + 1] && !visited[idx + 1]) {
			visited[idx + 1] = 1;
			stack[sp++] = idx + 1;
		}
		if (idx >= width && mask[idx - width] && !visited[idx - width]) {
			visited[idx - width] = 1;
			stack[sp++] = idx - width;
		}
		if (idx < n - width && mask[idx + width] && !visited[idx + width]) {
			visited[idx + width] = 1;
			stack[sp++] = idx + width;
		}
	}
	return px.subarray(0, count);
}

/** Exterior points are enough for the physical boundary and deliberately
 * ignore printed holes, whose asymmetric mass badly biases PCA moments. */
function exteriorPoints(px, width, height) {
	const left = new Int32Array(height);
	const right = new Int32Array(height);
	left.fill(width);
	right.fill(-1);
	for (let k = 0; k < px.length; k++) {
		const idx = px[k];
		const x = idx % width;
		const y = (idx / width) | 0;
		if (x < left[y]) left[y] = x;
		if (x > right[y]) right[y] = x;
	}
	const points = [];
	for (let y = 0; y < height; y++) {
		if (right[y] < 0) continue;
		points.push({ x: left[y], y });
		if (right[y] !== left[y]) points.push({ x: right[y], y });
	}
	return points;
}

function convexHull(points) {
	if (points.length <= 2) return points;
	points.sort((a, b) => a.x - b.x || a.y - b.y);
	const cross = (o, a, b) =>
		(a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower = [];
	for (const point of points) {
		while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) {
			lower.pop();
		}
		lower.push(point);
	}
	const upper = [];
	for (let i = points.length - 1; i >= 0; i--) {
		const point = points[i];
		while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) {
			upper.pop();
		}
		upper.push(point);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
}

/** Minimum-area rectangle around the component's convex exterior. This is
 * the contour/minAreaRect equivalent for the small JS mask. */
function exteriorRect(px, width, height) {
	const hull = convexHull(exteriorPoints(px, width, height));
	if (hull.length < 2) return null;
	let bestTheta = 0;
	let bestArea = Infinity;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		const theta = Math.atan2(b.y - a.y, b.x - a.x);
		const ca = Math.cos(theta);
		const sa = Math.sin(theta);
		let minU = Infinity;
		let maxU = -Infinity;
		let minV = Infinity;
		let maxV = -Infinity;
		for (const point of hull) {
			const u = point.x * ca + point.y * sa;
			const v = -point.x * sa + point.y * ca;
			if (u < minU) minU = u;
			if (u > maxU) maxU = u;
			if (v < minV) minV = v;
			if (v > maxV) maxV = v;
		}
		const area = (maxU - minU) * (maxV - minV);
		if (area < bestArea) {
			bestArea = area;
			bestTheta = theta;
		}
	}

	while (bestTheta > Math.PI / 4) bestTheta -= Math.PI / 2;
	while (bestTheta < -Math.PI / 4) bestTheta += Math.PI / 2;
	const ca = Math.cos(bestTheta);
	const sa = Math.sin(bestTheta);
	let minU = Infinity;
	let maxU = -Infinity;
	let minV = Infinity;
	let maxV = -Infinity;
	for (const point of hull) {
		const u = point.x * ca + point.y * sa;
		const v = -point.x * sa + point.y * ca;
		if (u < minU) minU = u;
		if (u > maxU) maxU = u;
		if (v < minV) minV = v;
		if (v > maxV) maxV = v;
	}
	const centerU = (minU + maxU) / 2;
	const centerV = (minV + maxV) / 2;
	return {
		cx: centerU * ca - centerV * sa,
		cy: centerU * sa + centerV * ca,
		theta: bestTheta,
		w: maxU - minU,
		h: maxV - minV,
		area: px.length,
	};
}

/**
 * Analyse a foreground mask (0/255, 1 byte per pixel) and decide whether
 * it contains one dominant, rectangle-like blob. Pure JS, exported for
 * tests: everything below the maxEdge detection copy runs here.
 *
 * Returns { detected, reason, confidence, polarity (set by caller),
 * center, angleDeg, width, height, corners, areaFraction,
 * rectangularity, dominance, borderContact }.
 */
function analyzeMask(mask, width, height, cfg) {
	const opts = normalizeCfg(cfg);
	const frameArea = width * height;
	const minArea = Math.max(1, Math.round(opts.minAreaFraction * frameArea));
	const maxArea = Math.max(
		minArea,
		Math.round(opts.maxAreaFraction * frameArea),
	);
	const comps = connectedComponentsStats(mask, width, height);

	if (comps.length === 0) {
		return { detected: false, reason: "no-component", confidence: 0 };
	}
	const largeEnough = comps.filter((c) => c.area >= minArea);
	if (largeEnough.length === 0) {
		return { detected: false, reason: "too-small", confidence: 0 };
	}
	const candidates = largeEnough.filter((c) => c.area <= maxArea);
	if (candidates.length === 0) {
		return { detected: false, reason: "too-large", confidence: 0 };
	}
	candidates.sort((a, b) => b.area - a.area);
	const best = candidates[0];
	const second = candidates[1];
	const dominance = second ? best.area / second.area : Infinity;
	if (dominance < opts.minDominance) {
		return { detected: false, reason: "ambiguous", confidence: 0 };
	}

	const touches =
		(best.x0 === 0 ? 1 : 0) +
		(best.y0 === 0 ? 1 : 0) +
		(best.x1 === width ? 1 : 0) +
		(best.y1 === height ? 1 : 0);
	const borderContact = touches / 4;
	if (borderContact > opts.maxBorderContact) {
		return { detected: false, reason: "border-contact", confidence: 0 };
	}

	const px = collectPixels(mask, width, height, best.seed);
	const rect = exteriorRect(px, width, height);
	if (!rect || rect.w <= 0 || rect.h <= 0) {
		return { detected: false, reason: "degenerate-boundary", confidence: 0 };
	}
	const areaFraction = best.area / frameArea;
	const rectangularity = rect.area / (rect.w * rect.h);
	if (rectangularity < opts.minRectangularity) {
		return { detected: false, reason: "low-rectangularity", confidence: 0 };
	}

	let aspectMismatch = 0;
	if (opts.aspectRatio != null) {
		const aspect = rect.w / rect.h;
		aspectMismatch = Math.abs(Math.log(aspect / opts.aspectRatio));
		if (aspectMismatch > opts.aspectTolerance) {
			return { detected: false, reason: "aspect-mismatch", confidence: 0 };
		}
	}

	const areaFactor = Math.min(1, areaFraction / (4 * opts.minAreaFraction));
	const rectFactor = Math.min(1, rectangularity / opts.minRectangularity);
	const aspectFactor =
		opts.aspectRatio == null
			? 1
			: Math.max(0, Math.min(1, 1 - aspectMismatch / opts.aspectTolerance));
	const confidence = areaFactor * rectFactor * aspectFactor;

	if (confidence < opts.minConfidence) {
		return { detected: false, reason: "low-confidence", confidence };
	}

	const corners = rectangleCorners(rect.cx, rect.cy, rect.w, rect.h, rect.theta);

	return {
		detected: true,
		reason: "ok",
		confidence,
		center: { x: rect.cx, y: rect.cy },
		angleDeg: rect.theta / DEG,
		width: rect.w,
		height: rect.h,
		corners,
		areaFraction,
		rectangularity,
		dominance,
		borderContact,
	};
}

/** The four corners of a rectangle, in a stable order. */
function rectangleCorners(cx, cy, w, h, theta) {
	const ca = Math.cos(theta);
	const sa = Math.sin(theta);
	const hw = w / 2;
	const hh = h / 2;
	return [
		{ x: cx + hw * ca - hh * sa, y: cy + hw * sa + hh * ca },
		{ x: cx + hw * ca + hh * sa, y: cy + hw * sa - hh * ca },
		{ x: cx - hw * ca + hh * sa, y: cy - hw * sa - hh * ca },
		{ x: cx - hw * ca - hh * sa, y: cy - hw * sa + hh * ca },
	];
}

/**
 * Snap each side of the region rectangle to the visible label boundary.
 * The blob rectangle always *contains* the label, so the true boundary is
 * found scanning inward from each side. Two signals are accumulated into
 * 1-D histograms along the rect's axes (u = along theta, v = perpendicular):
 *
 *  - **brightness**: the fraction of the rect's extent that is label-tone
 *    (>= the bright mode for a light label, <= the dark mode for a dark
 *    one). The label interior is solid label-tone, while a bright halo or
 *    a similar-tone table outside it is not - so the boundary is where a
 *    run of three columns/rows first reaches ~85%. This is what separates
 *    "proper white" from "grayish" when the table has bright patches.
 *  - **edges** (fallback): Sobel magnitude, a full-length boundary line
 *    becomes one tall bin. Used only when brightness finds nothing, e.g. a
 *    seam/shadow boundary on a similarly-toned surface.
 *
 * A side with no evidence (clipped at the frame, or a smooth table) keeps
 * its region position.
 *
 * @param {Uint8Array} grayData small gray copy (label-tone fractions)
 * @param {Uint8Array|null} edgeData Sobel magnitude on the same copy
 * @param {number} width, height detection copy dimensions
 * @param {object} rect { cx, cy, w, h, theta (rad) } from the region pass
 * @param {string} polarity "light" | "dark"
 * @returns {{ cx, cy, w, h, theta, sides: Array<{side, from, to, snapped}> }}
 *   never null - callers apply it directly (unsnapped sides keep `from`).
 */
function refineRectBoundary(grayData, edgeData, width, height, rect, polarity) {
	const { cx, cy, w, h, theta } = rect;
	const ca = Math.cos(theta);
	const sa = Math.sin(theta);
	const extent = Math.max(width, height);
	const accSize = 2 * extent + 1;
	const off = extent;
	const n = width * height;
	const uc = cx * ca + cy * sa;
	const vc = -cx * sa + cy * ca;
	const u0 = Math.round(uc - w / 2);
	const u1 = Math.round(uc + w / 2);
	const v0 = Math.round(vc - h / 2);
	const v1 = Math.round(vc + h / 2);
	const edgeFloor = 24;

	// Label tone level: the 98th-percentile gray value (bright mode for a
	// light label, dark mode for a dark label), a small margin inside it.
	const hist = new Int32Array(256);
	for (let i = 0; i < n; i++) hist[grayData[i]]++;
	const target = n * 0.02;
	let level = -1;
	if (polarity === "dark") {
		let acc = 0;
		for (let g = 0; g < 256; g++) {
			acc += hist[g];
			if (acc >= target) {
				level = g + 8;
				break;
			}
		}
	} else {
		let acc = 0;
		for (let g = 255; g >= 0; g--) {
			acc += hist[g];
			if (acc >= target) {
				level = g - 8;
				break;
			}
		}
	}
	const isLabel = (g) => (polarity === "dark" ? g <= level : g >= level);

	// Per-axis accumulators, restricted to the rect's extent so distant
	// table regions cannot dilute the fractions.
	const countU = new Int32Array(accSize);
	const countV = new Int32Array(accSize);
	const labelU = new Int32Array(accSize);
	const labelV = new Int32Array(accSize);
	const edgeU = new Float64Array(accSize);
	const edgeV = new Float64Array(accSize);
	for (let i = 0; i < n; i++) {
		const x = i % width;
		const y = (i / width) | 0;
		const u = x * ca + y * sa;
		const v = -x * sa + y * ca;
		const g = grayData[i];
		const m = edgeData ? edgeData[i] : 0;
		if (v >= v0 && v <= v1) {
			const bin = off + Math.round(u);
			if (bin >= 0 && bin < accSize) {
				countU[bin]++;
				if (isLabel(g)) labelU[bin]++;
				if (m >= edgeFloor) edgeU[bin] += m;
			}
		}
		if (u >= u0 && u <= u1) {
			const bin = off + Math.round(v);
			if (bin >= 0 && bin < accSize) {
				countV[bin]++;
				if (isLabel(g)) labelV[bin]++;
				if (m >= edgeFloor) edgeV[bin] += m;
			}
		}
	}
	const fracU = new Float64Array(accSize);
	const fracV = new Float64Array(accSize);
	for (let i = 0; i < accSize; i++) {
		if (countU[i] > 0) fracU[i] = labelU[i] / countU[i];
		if (countV[i] > 0) fracV[i] = labelV[i] / countV[i];
	}

	// Inward search window: deep enough to reach a boundary even when the
	// region side is clamped at the frame edge (clipped label).
	const win = Math.max(
		12,
		Math.round(0.5 * Math.min(w, h)),
		Math.round(0.35 * Math.min(width, height)),
	);
	// The brightness threshold adapts to how much of the rect the label
	// actually fills: the region rect can be taller/wider than the label
	// (halo, clipped table), which dilutes the label-tone fraction. The
	// boundary is where the fraction reaches ~70% of its own maximum in the
	// frame; a label filling < 30% of the rect is too weak to trust.
	let maxFracU = 0;
	let maxFracV = 0;
	for (let i = 0; i < accSize; i++) {
		if (countU[i] >= 8 && fracU[i] > maxFracU) maxFracU = fracU[i];
		if (countV[i] >= 8 && fracV[i] > maxFracV) maxFracV = fracV[i];
	}
	const threshU = maxFracU >= 0.3 ? 0.7 * maxFracU : Infinity;
	const threshV = maxFracV >= 0.3 ? 0.7 * maxFracV : Infinity;
	// A boundary spans the perpendicular side's length, so scale the edge
	// floor by it: left/right sides run h, top/bottom sides run w.
	const floorU = Math.max(300, Math.round(h * 15));
	const floorV = Math.max(300, Math.round(w * 15));

	const brightnessAt = (frac, count, p, dir, thresh) =>
		count[p + off] >= 8 &&
		frac[p + off] >= thresh &&
		count[p + dir + off] >= 8 &&
		frac[p + dir + off] >= thresh &&
		count[p + 2 * dir + off] >= 8 &&
		frac[p + 2 * dir + off] >= thresh;
	const scanBrightness = (start, dir, frac, count, thresh) => {
		for (let i = 0; i <= win; i++) {
			const p = start + dir * i;
			if (p + 2 * dir + off < 0 || p + 2 * dir + off >= accSize) break;
			if (brightnessAt(frac, count, p, dir, thresh)) return p;
		}
		return null;
	};
	const scanEdge = (start, dir, edge, floor) => {
		for (let i = 0; i <= win; i++) {
			const p = start + dir * i;
			if (p + 2 * dir + off < 0 || p + 2 * dir + off >= accSize) break;
			const a = edge[p + off];
			const b = edge[p + dir + off];
			const c = edge[p + 2 * dir + off];
			if (a >= floor && b >= floor && c >= floor) return p;
		}
		return null;
	};

	// A snap must move the side by a meaningful distance (a 1-2px drift is
	// boundary rounding, and letting it count would block the seam fallback)
	// - and a scan that merely confirms the region position is no snap at
	// all. Brightness first; the edge seam is only trusted when the strip
	// between it and the region side is weaker than the label tone itself -
	// otherwise the "edge" is printed content inside the label (a barcode
	// band reads exactly like a seam on the Sobel accumulator).
	const stripAvg = (frac, from, to) => {
		const a = Math.min(from, to);
		const b = Math.max(from, to);
		let sum = 0;
		let cnt = 0;
		for (let i = a; i <= b; i++) {
			const v = frac[i + off];
			if (Number.isFinite(v)) {
				sum += v;
				cnt++;
			}
		}
		return cnt > 0 ? sum / cnt : 0;
	};
	const improve = (region, brightness, edge, frac, maxFrac) => {
		if (brightness !== null && Math.abs(brightness - region) >= 3) {
			return brightness;
		}
		if (edge !== null && Math.abs(edge - region) >= 3) {
			if (stripAvg(frac, region, edge) < 0.9 * maxFrac) {
				return edge;
			}
		}
		return region;
	};
	const left = improve(
		u0,
		scanBrightness(u0, 1, fracU, countU, threshU),
		scanEdge(u0, 1, edgeU, floorU),
		fracU,
		maxFracU,
	);
	const right = improve(
		u1,
		scanBrightness(u1, -1, fracU, countU, threshU),
		scanEdge(u1, -1, edgeU, floorU),
		fracU,
		maxFracU,
	);
	const top = improve(
		v0,
		scanBrightness(v0, 1, fracV, countV, threshV),
		scanEdge(v0, 1, edgeV, floorV),
		fracV,
		maxFracV,
	);
	const bottom = improve(
		v1,
		scanBrightness(v1, -1, fracV, countV, threshV),
		scanEdge(v1, -1, edgeV, floorV),
		fracV,
		maxFracV,
	);

	const newW = right - left;
	const newH = bottom - top;
	// Degenerate snap (a huge window crossed the opposite side): revert.
	if (newW < 8) {
		return {
			cx,
			cy,
			w,
			h,
			theta,
			sides: [
				{ side: "left", from: left, to: left, snapped: false },
				{ side: "right", from: right, to: right, snapped: false },
				{ side: "top", from: top, to: top, snapped: false },
				{ side: "bottom", from: bottom, to: bottom, snapped: false },
			],
		};
	}
	if (newH < 8) {
		return {
			cx,
			cy,
			w,
			h,
			theta,
			sides: [
				{ side: "left", from: left, to: left, snapped: false },
				{ side: "right", from: right, to: right, snapped: false },
				{ side: "top", from: top, to: top, snapped: false },
				{ side: "bottom", from: bottom, to: bottom, snapped: false },
			],
		};
	}
	const newUc = (left + right) / 2;
	const newVc = (top + bottom) / 2;
	return {
		cx: newUc * ca - newVc * sa,
		cy: newUc * sa + newVc * ca,
		w: newW,
		h: newH,
		theta,
		sides: [
			{
				side: "left",
				from: Math.round(uc - w / 2),
				to: left,
				snapped: left !== Math.round(uc - w / 2),
			},
			{
				side: "right",
				from: Math.round(uc + w / 2),
				to: right,
				snapped: right !== Math.round(uc + w / 2),
			},
			{
				side: "top",
				from: Math.round(vc - h / 2),
				to: top,
				snapped: top !== Math.round(vc - h / 2),
			},
			{
				side: "bottom",
				from: Math.round(vc + h / 2),
				to: bottom,
				snapped: bottom !== Math.round(vc + h / 2),
			},
		],
	};
}

// ---- the op -------------------------------------------------------------

const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;

function buildMissMetadata(analysis, timings, smallW, smallH, sx, sy) {
	let dominance = null;
	if (analysis && analysis.dominance !== Infinity) {
		dominance = round3(analysis.dominance);
	}
	return {
		detected: false,
		reason: analysis ? analysis.reason : "no-component",
		polarity: analysis ? analysis.polarity : null,
		angleDeg: null,
		center: null,
		corners: null,
		width: null,
		height: null,
		confidence: analysis ? round3(analysis.confidence) : 0,
		areaFraction: analysis ? round4(analysis.areaFraction || 0) : 0,
		rectangularity: analysis ? round3(analysis.rectangularity || 0) : 0,
		dominance,
		borderContact: analysis ? round3(analysis.borderContact || 0) : 0,
		smallSize: { width: smallW, height: smallH },
		scale: { x: round4(sx), y: round4(sy) },
		crop: null,
		// calipers mode reports each edge's own outcome, so a region that
		// needs re-aiming can be identified without re-running the frame
		...(analysis && analysis.edges ? { edges: analysis.edges } : {}),
		timings,
	};
}

/**
 * Deskew-and-crop a label.
 *
 * @param {Buffer|object} input encoded image Buffer or raw image object
 * @param {object} [cfg] options (see DEFAULTS)
 * @param {object} [engine] engine to use; defaults to the lazily loaded
 *   native bridge. Pass null to force the "unavailable" setup error.
 * @returns {Promise<{image, detected, metadata}>} on a miss, `image` is
 *   the original input unchanged.
 */
async function labelCrop(input, cfg = {}, engine) {
	const tStart = performance.now();
	const eng = engine === undefined ? await getBridgeAsync() : engine;
	if (!eng) {
		throw new Error(ENGINE_UNAVAILABLE_PREFIX + "engine not installed");
	}
	const opts = normalizeCfg(cfg);
	const original = input;

	// ---- decode / normalise once -------------------------------------
	let full;
	const timings = {
		decodeMs: 0,
		detectCopyMs: 0,
		maskMs: 0,
		analysisMs: 0,
		edgeMs: 0,
		refineMs: 0,
		rotateMs: 0,
		cropMs: 0,
		totalMs: 0,
		engine: [],
	};
	if (Buffer.isBuffer(input)) {
		const d0 = performance.now();
		const res = await eng.colorConvert(input, "RGB", "raw");
		timings.decodeMs = performance.now() - d0;
		timings.engine.push({ op: "decode", ...res.timing });
		full = res.image;
	} else if (isRawImage(input)) {
		full = normalizeRaw(input);
	} else {
		throw new Error(
			"label-crop: input must be an encoded image Buffer or a raw " +
				"{ data, width, height, channels } image object",
		);
	}

	// ---- calipers boundary mode ---------------------------------------
	// Four operator-drawn line finders instead of a whole-frame blob
	// search, for a boundary whose own contrast is weaker than the
	// artwork's. Produces the same `best` shape the blob path does, so
	// the rotate/crop tail below is shared unchanged.
	if (opts.boundaryMode === "calipers") {
		const found = await boundaryByCalipers(eng, full, opts, timings);
		if (!found.best.detected) {
			timings.totalMs = performance.now() - tStart;
			return {
				image: original,
				detected: false,
				metadata: buildMissMetadata(
					found.best,
					timings,
					found.smallW,
					found.smallH,
					1,
					1,
				),
			};
		}
		return cropToRect({
			eng,
			full,
			opts,
			timings,
			original,
			tStart,
			best: found.best,
			smallW: found.smallW,
			smallH: found.smallH,
		});
	}

	// ---- detection copy: <= maxEdge long edge, grey -------------------
	const scale = Math.min(1, opts.maxEdge / Math.max(full.width, full.height));
	const smallW = Math.max(1, Math.round(full.width * scale));
	const smallH = Math.max(1, Math.round(full.height * scale));
	let det = full;
	if (scale < 1) {
		const d0 = performance.now();
		const res = await eng.resize(full, "num", smallW, "num", smallH, "raw");
		timings.detectCopyMs += performance.now() - d0;
		timings.engine.push({ op: "resize", ...res.timing });
		det = res.image;
	}
	if ((det.channels || 1) !== 1) {
		const d0 = performance.now();
		const res = await eng.colorConvert(det, "GRAY", "raw");
		timings.detectCopyMs += performance.now() - d0;
		timings.engine.push({ op: "colorConvert", ...res.timing });
		det = res.image;
	}

	// ---- Otsu once; invert the small mask in JS for dark polarity -------
	const maskStarted = performance.now();
	const thresholded = await eng.filter(det, "otsu", 3, 0, "raw");
	timings.maskMs = performance.now() - maskStarted;
	timings.engine.push({ op: "filter", ...thresholded.timing });
	const mask = thresholded.image;
	const lightMask = new Uint8Array(
		mask.data.buffer,
		mask.data.byteOffset,
		mask.width * mask.height,
	);
	let polarities = ["light"];
	if (opts.polarity === "auto") polarities = ["light", "dark"];
	else if (opts.polarity === "dark") polarities = ["dark"];
	let darkMask;
	let best = null;
	for (const polarity of polarities) {
		const a0 = performance.now();
		let pixels = lightMask;
		if (polarity === "dark") {
			darkMask ||= Uint8Array.from(lightMask, (value) => (value ? 0 : 255));
			pixels = darkMask;
		}
		const analysis = analyzeMask(pixels, mask.width, mask.height, opts);
		timings.analysisMs += performance.now() - a0;
		analysis.polarity = polarity;
		if (!best || analysis.confidence > best.confidence) best = analysis;
	}

	if (!best || !best.detected) {
		timings.totalMs = performance.now() - tStart;
		return {
			image: original,
			detected: false,
			metadata: buildMissMetadata(best, timings, smallW, smallH, scale, scale),
		};
	}

	// ---- boundary refinement: snap each side to the label's visible edge
	// (brightness step, Sobel as fallback) so a clipped or table-blended
	// label crops to its real boundary ---
	const edgeStarted = performance.now();
	const edgeRes = await eng.filter(det, "edge", 3, 1.0, "raw");
	timings.edgeMs = performance.now() - edgeStarted;
	timings.engine.push({ op: "edge", ...edgeRes.timing });
	const refineStarted = performance.now();
	const refined = refineRectBoundary(
		new Uint8Array(det.data.buffer, det.data.byteOffset, det.data.byteLength),
		new Uint8Array(
			edgeRes.image.data.buffer,
			edgeRes.image.data.byteOffset,
			edgeRes.image.data.byteLength,
		),
		smallW,
		smallH,
		{
			cx: best.center.x,
			cy: best.center.y,
			w: best.width,
			h: best.height,
			theta: best.angleDeg * DEG,
		},
		best.polarity,
	);
	timings.refineMs = performance.now() - refineStarted;
	best.center.x = refined.cx;
	best.center.y = refined.cy;
	best.width = refined.w;
	best.height = refined.h;
	best.angleDeg = refined.theta / DEG;
	best.corners = rectangleCorners(
		refined.cx,
		refined.cy,
		refined.w,
		refined.h,
		refined.theta,
	);
	best.snappedSides = refined.sides.filter((s) => s.snapped).map((s) => s.side);

	// ---- expected-size gate: the refined label must cover roughly the
	// fraction of the frame the user drew on a representative sample. This
	// turns a badly-detected rect (halo included, wrong product) into a
	// clean miss instead of a wrong crop. Compared after refinement, so the
	// clipped/table-blended extents the refinement removes are not counted.
	if (opts.expectedSizeFraction != null) {
		const refinedAreaFraction = (refined.w * refined.h) / (smallW * smallH);
		const sizeMismatch = Math.abs(
			Math.log(refinedAreaFraction / opts.expectedSizeFraction),
		);
		if (sizeMismatch > opts.sizeTolerance) {
			timings.totalMs = performance.now() - tStart;
			return {
				image: original,
				detected: false,
				metadata: buildMissMetadata(
					{ ...best, reason: "size-mismatch" },
					timings,
					smallW,
					smallH,
					scale,
					scale,
				),
			};
		}
	}

	return cropToRect({
		eng,
		full,
		opts,
		timings,
		original,
		tStart,
		best,
		smallW,
		smallH,
	});
}

/**
 * Boundary from four operator-drawn line finders.
 *
 * Runs at **full resolution**, not on the maxEdge detection copy. The
 * blob search can afford a 640px copy because it is looking for a shape;
 * a caliper is looking for a position, and on a 3700px frame that copy
 * costs a factor of six in every measurement it makes. The regions are
 * small, so full resolution is affordable here in a way a whole-frame
 * search would not be - a caliper only touches the box it was given.
 *
 * Returns `{ best, smallW, smallH }` with `best` in the same shape
 * `analyzeMask` produces and `smallW/smallH` equal to the frame, so the
 * shared tail's scale factors come out as 1 and no rounding is
 * introduced on the way back up.
 */
async function boundaryByCalipers(eng, full, opts, timings) {
	const smallW = full.width;
	const smallH = full.height;
	const fail = (reason, extra = {}) => ({
		best: { detected: false, reason, confidence: 0, ...extra },
		smallW,
		smallH,
	});

	const sides = ["left", "right", "top", "bottom"];
	const configured = opts.edgeRegions || {};
	const missingCfg = sides.filter((s) => !configured[s]);
	if (missingCfg.length) {
		return fail(`calipers-unconfigured:${missingCfg.join("+")}`);
	}

	// One grayscale conversion of the whole frame, reused by all four
	// regions. Cropping four ROIs natively instead would be four engine
	// round-trips for the same pixels.
	const g0 = performance.now();
	let gray = full;
	if ((full.channels || 1) !== 1) {
		const res = await eng.colorConvert(full, "GRAY", "raw");
		timings.engine.push({ op: "colorConvert", ...res.timing });
		gray = res.image;
	}
	timings.grayMs = performance.now() - g0;
	const pixels = new Uint8Array(
		gray.data.buffer,
		gray.data.byteOffset,
		gray.width * gray.height,
	);

	// The scan direction each side implies, so an operator who drew a box
	// over the left edge does not also have to say "scan rightwards".
	const impliedScan = { left: "right", right: "left", top: "down", bottom: "up" };

	const c0 = performance.now();
	const results = {};
	for (const side of sides) {
		const spec = configured[side];
		const { x, y, width, height, angleDeg, ...rest } = spec;
		results[side] = findLine(
			pixels,
			gray.width,
			gray.height,
			{ x, y, width, height, angleDeg },
			{ scanDirection: impliedScan[side], ...rest },
		);
	}
	timings.caliperMs = performance.now() - c0;

	const rect = rectFromLines(results);
	const edges = {};
	for (const side of sides) {
		const r = results[side];
		edges[side] = {
			found: r.found,
			reason: r.reason,
			score: round3(r.score),
			angleDeg: r.angleDeg == null ? null : round3(r.angleDeg),
			residualPx: r.residualPx == null ? null : round3(r.residualPx),
			calipers: r.calipers,
			line: r.found ? { x: round1(r.line.x), y: round1(r.line.y) } : null,
		};
	}
	if (!rect.ok) {
		// A frame whose boundary cannot be located is not inspectable, so
		// this is a miss rather than a crop against a guessed rectangle -
		// the same rule the blob path applies to weak evidence.
		return fail(`calipers:${rect.reason}`, { edges });
	}

	return {
		smallW,
		smallH,
		best: {
			detected: true,
			reason: "ok",
			polarity: "calipers",
			confidence: rect.score,
			center: { x: rect.cx, y: rect.cy },
			width: rect.width,
			height: rect.height,
			angleDeg: rect.angleDeg,
			corners: rect.corners,
			// the blob path's shape descriptors have no meaning here: the
			// rectangle came from four fitted lines, not from a region of
			// connected pixels. Reported as null rather than as a plausible
			// looking number nothing measured.
			areaFraction: (rect.width * rect.height) / (smallW * smallH),
			rectangularity: null,
			dominance: null,
			borderContact: null,
			snappedSides: [],
			edges,
			residualPx: rect.residualPx,
		},
	};
}

/**
 * Rotate and crop the frame to the detected rectangle.
 *
 * Split out because both boundary modes end here: `best` is in
 * `smallW x smallH` detection coordinates (the blob path's maxEdge copy,
 * or the full frame itself when the calipers found the rectangle
 * directly), and everything from here is the same either way.
 */
async function cropToRect({
	eng,
	full,
	opts,
	timings,
	original,
	tStart,
	best,
	smallW,
	smallH,
}) {
	// ---- scale the analysis into the full-resolution frame -------------
	const sx = full.width / smallW;
	const sy = full.height / smallH;
	const cx = best.center.x * sx;
	const cy = best.center.y * sy;
	const w = best.width * sx;
	const h = best.height * sy;
	const angleDeg = best.angleDeg;
	const ca = Math.cos(angleDeg * DEG);
	const sa = Math.sin(angleDeg * DEG);

	// ---- tight ROI: the label bbox + a small margin, clamped -----------
	const margin = Math.max(2, Math.round(opts.cropMargin * Math.max(w, h)));
	const bboxW = Math.abs(w * ca) + Math.abs(h * sa);
	const bboxH = Math.abs(w * sa) + Math.abs(h * ca);
	const imgW = full.width;
	const imgH = full.height;
	const clampX = (v) => Math.max(0, Math.min(v, imgW));
	const clampY = (v) => Math.max(0, Math.min(v, imgH));
	let cx0 = clampX(Math.round(cx - bboxW / 2 - margin));
	let cy0 = clampY(Math.round(cy - bboxH / 2 - margin));
	const cx1 = clampX(Math.round(cx + bboxW / 2 + margin));
	const cy1 = clampY(Math.round(cy + bboxH / 2 + margin));
	cx0 = Math.min(cx0, cx1 - 1);
	cy0 = Math.min(cy0, cy1 - 1);
	const cw = cx1 - cx0;
	const ch = cy1 - cy0;
	if (cw < 2 || ch < 2) {
		timings.totalMs = performance.now() - tStart;
		return {
			image: original,
			detected: false,
			metadata: buildMissMetadata(
				{ ...best, reason: "off-frame" },
				timings,
				smallW,
				smallH,
				sx,
				sy,
			),
		};
	}

	// The label's centre relative to the ROI centre. This is OpenCV's
	// getRotationMatrix2D(+angle) linear part in image coordinates.
	const dx = cx - (cx0 + cw / 2);
	const dy = cy - (cy0 + ch / 2);
	const dxr = dx * ca + dy * sa;
	const dyr = -dx * sa + dy * ca;
	// Match the engine's own rotate exactly: cv::Size receives truncated ints.
	const dstW = Math.trunc(ch * Math.abs(sa) + cw * Math.abs(ca));
	const dstH = Math.trunc(ch * Math.abs(ca) + cw * Math.abs(sa));
	const dstCx = dstW / 2 + dxr;
	const dstCy = dstH / 2 + dyr;

	// ---- rotate only the ROI (skip when the angle is negligible) -------
	let rotated = full;
	let rotateMs = 0;
	if (Math.abs(angleDeg) >= opts.minRotateAngleDeg) {
		const d0 = performance.now();
		const roi = await eng.crop(full, cx0, cy0, cw, ch, false, "raw");
		timings.rotateMs += performance.now() - d0;
		timings.engine.push({ op: "crop", ...roi.timing });
		const d1 = performance.now();
		// OpenCV's image-coordinate rotation matrix levels the boundary axis
		// (cos(theta), sin(theta)) when passed +theta, not -theta.
		const rot = await eng.rotate(roi.image, angleDeg, opts.padColor, "raw");
		timings.rotateMs += performance.now() - d1;
		timings.engine.push({ op: "rotate", ...rot.timing });
		rotated = rot.image;
		rotateMs = timings.rotateMs;
	}

	// ---- the final tight crop: the centred w x h label rect ------------
	const fw = Math.max(1, Math.round(w));
	const fh = Math.max(1, Math.round(h));
	let fx;
	let fy;
	if (Math.abs(angleDeg) < opts.minRotateAngleDeg) {
		// no rotation: the crop rect sits at the label centre in the frame
		fx = Math.max(0, Math.min(Math.round(cx - fw / 2), imgW - fw));
		fy = Math.max(0, Math.min(Math.round(cy - fh / 2), imgH - fh));
	} else {
		fx = Math.max(0, Math.min(Math.round(dstCx - fw / 2), dstW - fw));
		fy = Math.max(0, Math.min(Math.round(dstCy - fh / 2), dstH - fh));
	}

	const d2 = performance.now();
	const final = await eng.crop(
		rotated,
		fx,
		fy,
		fw,
		fh,
		false,
		opts.outputFormat,
		opts.outputQuality,
		opts.pngOptimize,
	);
	timings.cropMs = performance.now() - d2;
	timings.engine.push({ op: "final-crop", ...final.timing });
	timings.totalMs = performance.now() - tStart;

	const corners = best.corners.map((c) => ({
		x: round1(c.x * sx),
		y: round1(c.y * sy),
	}));
	const metadata = {
		detected: true,
		reason: "ok",
		polarity: best.polarity,
		angleDeg: round3(angleDeg),
		center: { x: round1(cx), y: round1(cy) },
		corners,
		width: round1(w),
		height: round1(h),
		confidence: round3(best.confidence),
		areaFraction: round4(best.areaFraction),
		rectangularity: round3(best.rectangularity),
		dominance: best.dominance === Infinity ? null : round3(best.dominance),
		borderContact: round3(best.borderContact),
		refinedSides: best.snappedSides || [],
		...(best.edges ? { edges: best.edges } : {}),
		...(best.residualPx != null ? { residualPx: round3(best.residualPx) } : {}),
		smallSize: { width: smallW, height: smallH },
		scale: { x: round4(sx), y: round4(sy) },
		crop: {
			x: cx0,
			y: cy0,
			width: cw,
			height: ch,
			rotatedWidth: dstW,
			rotatedHeight: dstH,
			finalX: fx,
			finalY: fy,
			finalWidth: fw,
			finalHeight: fh,
			rotated: rotateMs > 0,
		},
		timings,
	};

	return { image: final.image, detected: true, metadata };
}

module.exports = {
	labelCrop,
	analyzeMask,
	refineRectBoundary,
	getBridge,
	getBridgeAsync,
	available,
	_setBridge,
	_resetBridge,
	DEFAULTS,
	BOUNDARY_MODES,
	ENGINE_UNAVAILABLE_PREFIX,
};
