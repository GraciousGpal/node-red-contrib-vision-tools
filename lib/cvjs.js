/**
 * PROTOTYPE: the OpenCV engine as WASM instead of a native addon.
 *
 * lib/labelCrop.js and lib/nativeSeed.js both call the promisified
 * cpp-bridge of @rosepetal/node-red-contrib-image-tools. That bridge ships
 * prebuilt binaries for linux-x64, linux-arm64, linuxmusl-x64, darwin-x64
 * and darwin-arm64 only - on win32 it throws at require() time, so
 * label-crop (which treats the engine as a setup dependency, not a
 * fallback) cannot run there at all.
 *
 * This module implements the same op surface on @techstark/opencv-js, the
 * stock opencv.js WASM build, so the engine loads anywhere Node does.
 * Object shapes, argument positions and return values match the bridge, so
 * it drops into the `engine` seam both callers already have.
 *
 * RAW ONLY. The bridge decodes an encoded Buffer and can encode its result
 * to jpg/png/webp; opencv.js is built without image codecs, and the rig
 * feeds raw frames anyway, so every op here takes and returns
 * { data, width, height, channels, colorSpace, dtype }. The two places the
 * bridge contract genuinely requires a codec - an encoded Buffer arriving
 * at colorConvert, and a non-raw `fmt` on the final crop - are delegated to
 * sharp, which is already a direct dependency. Nothing on the hot path
 * touches those.
 *
 * Behaviour that can differ from the native engine in results, not just in
 * timing, is marked DIVERGES.
 */

"use strict";

const { performance } = require("node:perf_hooks");

const MODULE_ID = "@techstark/opencv-js";

// undefined = not yet attempted, null = load failed, object/Promise = the
// module export (v5 resolves a Promise, v4 fires onRuntimeInitialized)
let moduleExport;
let loadError = null;
// the resolved cv namespace, once the WASM runtime has initialised
let api = null;
let apiPromise = null;

function requireModule() {
	if (moduleExport === undefined) {
		try {
			moduleExport = require(MODULE_ID);
		} catch (err) {
			moduleExport = null;
			loadError = err;
		}
	}
	return moduleExport;
}

/** True when the WASM module is installed. Says nothing about whether its
 * runtime has finished initialising - every op awaits that itself. */
function available() {
	return requireModule() !== null;
}

/**
 * Resolve the cv namespace, initialising the WASM runtime on first call
 * (~200ms). Cached, so every later op sees a resolved promise. Call it at
 * node startup to keep that cost off the first frame.
 */
function ready() {
	if (api) return Promise.resolve(api);
	if (apiPromise) return apiPromise;
	const mod = requireModule();
	if (mod === null) {
		return Promise.reject(
			new Error(
				`${MODULE_ID} is not installed` +
					(loadError ? `: ${loadError.message}` : ""),
			),
		);
	}
	apiPromise = (async () => {
		// v5 exports a Promise; v4 exports the namespace and signals through
		// onRuntimeInitialized; an already-warm module just has Mat.
		const cv = typeof mod.then === "function" ? await mod : mod;
		if (typeof cv.Mat !== "function") {
			await new Promise((resolve) => {
				cv.onRuntimeInitialized = resolve;
			});
		}
		if (typeof cv.Mat !== "function") {
			throw new Error(`${MODULE_ID} loaded but exposes no Mat`);
		}
		api = cv;
		return cv;
	})();
	apiPromise.catch(() => {
		apiPromise = null;
	});
	return apiPromise;
}

/** Test seam: forget the cached runtime. */
function _reset() {
	moduleExport = undefined;
	loadError = null;
	api = null;
	apiPromise = null;
}

// ---- Mat lifecycle ------------------------------------------------------

// Every Mat is a WASM heap allocation the GC knows nothing about. Ops
// collect theirs in a scope and free them in a finally, including on the
// error path - a leak here grows the heap until the runtime aborts.
function scope() {
	const mats = [];
	return {
		keep(mat) {
			mats.push(mat);
			return mat;
		},
		free() {
			for (const mat of mats) {
				try {
					mat.delete();
				} catch {
					/* already deleted */
				}
			}
			mats.length = 0;
		},
	};
}

const COLOR_SPACE_BY_CHANNELS = { 1: "GRAY", 3: "RGB", 4: "RGBA" };

function matTypeFor(cv, channels) {
	if (channels === 1) return cv.CV_8UC1;
	if (channels === 3) return cv.CV_8UC3;
	if (channels === 4) return cv.CV_8UC4;
	throw new Error(`cvjs: unsupported channel count ${channels}`);
}

/** Accept the raw descriptor both callers pass and this module returns. */
function describeRaw(image) {
	if (!image || typeof image !== "object") {
		throw new Error(
			"cvjs: expected a raw { data, width, height, channels } image",
		);
	}
	const { data } = image;
	if (!ArrayBuffer.isView(data)) {
		throw new Error("cvjs: raw image data must be a Buffer or typed array");
	}
	const width = Number(image.width);
	const height = Number(image.height);
	if (
		!Number.isInteger(width) ||
		width <= 0 ||
		!Number.isInteger(height) ||
		height <= 0
	) {
		throw new Error("cvjs: raw width and height must be positive integers");
	}
	const channels = Number(image.channels || (image.colorSpace === "GRAY" ? 1 : 3));
	const colorSpace =
		image.colorSpace || COLOR_SPACE_BY_CHANNELS[channels] || "RGB";
	const bytes = width * height * channels;
	const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (view.byteLength < bytes) {
		throw new Error(
			`cvjs: raw data is shorter than ${width}x${height}x${channels}`,
		);
	}
	return { view: view.subarray(0, bytes), width, height, channels, colorSpace };
}

function toMat(cv, s, image) {
	const raw = describeRaw(image);
	const mat = s.keep(
		new cv.Mat(raw.height, raw.width, matTypeFor(cv, raw.channels)),
	);
	mat.data.set(raw.view);
	return mat;
}

/**
 * Copy a Mat out of the WASM heap into a raw descriptor. The copy is not
 * optional: mat.data is a view onto heap memory that delete() invalidates.
 *
 * mat.data is also only meaningful on a continuous Mat. On a view - a
 * crop's roi() - it starts at the view's origin and then runs straight on
 * through the PARENT's rows, so reading rows*cols bytes from it interleaves
 * pixels from outside the rect. copyTo into a fresh Mat is what actually
 * compacts the rows; clone() does not, because this build's clone keeps the
 * parent's step (its pixel accessors stay correct, its .data does not).
 */
function fromMat(cv, mat, colorSpace) {
	const channels = mat.channels();
	const bytes = mat.rows * mat.cols * channels;
	let src = mat;
	if (!mat.isContinuous()) {
		src = new cv.Mat(mat.rows, mat.cols, mat.type());
		mat.copyTo(src);
	}
	const out = {
		data: Buffer.from(src.data.subarray(0, bytes)),
		width: mat.cols,
		height: mat.rows,
		channels,
		colorSpace: colorSpace || COLOR_SPACE_BY_CHANNELS[channels] || "RGB",
		dtype: "uint8",
	};
	if (src !== mat) src.delete();
	return out;
}

/** The raw descriptor for an image that needs no OpenCV work at all. */
function passThrough(raw) {
	return {
		data: Buffer.from(raw.view),
		width: raw.width,
		height: raw.height,
		channels: raw.channels,
		colorSpace: raw.colorSpace,
		dtype: "uint8",
	};
}

function timing(t0, op) {
	return { totalMs: performance.now() - t0, engine: "opencv-js", op };
}

// ---- codecs (delegated; see the header) --------------------------------

let sharpModule;
function getSharp() {
	sharpModule ||= require("sharp");
	return sharpModule;
}

const RAW_FORMATS = new Set([undefined, null, "", "raw"]);
const SHARP_CHANNELS = { GRAY: 1, RGB: 3, RGBA: 4 };

async function decodeBuffer(buffer, colorSpace) {
	const want = SHARP_CHANNELS[colorSpace] || 3;
	let pipeline = getSharp()(buffer);
	if (want === 1) pipeline = pipeline.greyscale();
	else if (want === 4) pipeline = pipeline.ensureAlpha();
	else pipeline = pipeline.removeAlpha();
	const { data, info } = await pipeline
		.raw({ depth: "uchar" })
		.toBuffer({ resolveWithObject: true });
	return {
		data,
		width: info.width,
		height: info.height,
		channels: info.channels,
		colorSpace: COLOR_SPACE_BY_CHANNELS[info.channels] || "RGB",
		dtype: "uint8",
	};
}

async function encodeRaw(image, fmt, quality) {
	const raw = describeRaw(image);
	const pipeline = getSharp()(Buffer.from(raw.view), {
		raw: { width: raw.width, height: raw.height, channels: raw.channels },
	});
	const q = Number.isFinite(quality) ? quality : 90;
	if (fmt === "jpg" || fmt === "jpeg") {
		return pipeline.jpeg({ quality: q }).toBuffer();
	}
	if (fmt === "png") return pipeline.png().toBuffer();
	if (fmt === "webp") return pipeline.webp({ quality: q }).toBuffer();
	throw new Error(`cvjs: unsupported output format "${fmt}"`);
}

/** Every op ends here: raw straight through, anything else via sharp. */
async function deliver(image, fmt, quality) {
	if (RAW_FORMATS.has(fmt)) return image;
	return encodeRaw(image, fmt, quality);
}

// ---- ops ---------------------------------------------------------------

/**
 * colorConvert(image, targetColorSpace, [fmt], [quality]) -> {image, timing}
 *
 * `image` may be an encoded Buffer (decoded by sharp) or a raw descriptor.
 * Conversions go through cv.COLOR_<FROM>2<TO>, so any pair opencv.js names
 * is supported; GRAY/RGB/RGBA/BGR are the ones the callers use.
 */
async function colorConvert(image, targetColorSpace, fmt, quality) {
	const t0 = performance.now();
	const target = String(targetColorSpace || "RGB").toUpperCase();
	if (Buffer.isBuffer(image)) {
		const decoded = await decodeBuffer(image, target);
		return {
			image: await deliver(decoded, fmt, quality),
			timing: timing(t0, "decode"),
		};
	}
	const cv = await ready();
	const raw = describeRaw(image);
	if (raw.colorSpace === target) {
		return {
			image: await deliver(passThrough(raw), fmt, quality),
			timing: timing(t0, "colorConvert"),
		};
	}
	const code = cv[`COLOR_${raw.colorSpace}2${target}`];
	if (code === undefined) {
		throw new Error(`cvjs: no conversion from ${raw.colorSpace} to ${target}`);
	}
	const s = scope();
	try {
		const src = toMat(cv, s, image);
		const dst = s.keep(new cv.Mat());
		cv.cvtColor(src, dst, code);
		const out = fromMat(cv, dst, target);
		return {
			image: await deliver(out, fmt, quality),
			timing: timing(t0, "colorConvert"),
		};
	} finally {
		s.free();
	}
}

/**
 * A target dimension in pixels.
 *
 * "num" is a pixel count. "pct"/"percent" is a percentage of the source, and
 * "scale" is a multiplier - kept as separate modes on purpose. They used to
 * share one branch that guessed between the two by magnitude (values over 5
 * read as a percentage, the rest as a multiplier), which silently turned a
 * request for 5% into a 5x upscale. Nothing in this package asks for a
 * downscale that small, so it never bit; it was still a trap sitting in the
 * one function every op routes through.
 */
function resolveDimension(mode, value, source) {
	const n = Number(value);
	if (mode === "pct" || mode === "percent") {
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`cvjs: resize needs a positive percentage, got ${value}`);
		}
		return Math.max(1, Math.round(source * (n / 100)));
	}
	if (mode === "scale") {
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`cvjs: resize needs a positive scale factor, got ${value}`);
		}
		return Math.max(1, Math.round(source * n));
	}
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`cvjs: resize needs a positive size, got ${value}`);
	}
	return Math.max(1, Math.round(n));
}

/**
 * resize(image, wMode, wVal, hMode, hVal, [fmt], [quality]) -> {image, timing}
 *
 * INTER_LINEAR in both directions, which is what the native engine uses:
 * over a random-texture downscale its output matches OpenCV's INTER_LINEAR
 * on 100% of pixels, and nothing else comes close (bench/resize-probe
 * measured INTER_AREA at 34 mean absolute difference, CUBIC at 14).
 *
 * INTER_AREA is the textbook choice for a detection copy - it anti-aliases
 * thin print instead of dropping it between samples - and this used it at
 * first. It is the wrong call here anyway. `refineRectBoundary` snaps each
 * side of the label to the strongest edge near it, and on an axis-aligned
 * label whose printed rules run parallel to its own boundary those two
 * candidates are close enough that a sub-pixel difference in the detection
 * copy decides between them: at angle 0 the AREA copy snapped the top edge
 * onto the first printed bar, cropping 169px short of the label, while the
 * native engine cropped correctly. Matching the native filter exactly is
 * worth more than a better filter - a rig tuned against one engine has to
 * keep its behaviour on the other.
 */
async function resize(image, wMode, wVal, hMode, hVal, fmt, quality) {
	const t0 = performance.now();
	const cv = await ready();
	const raw = describeRaw(image);
	const width = resolveDimension(wMode, wVal, raw.width);
	const height = resolveDimension(hMode, hVal, raw.height);
	const s = scope();
	try {
		const src = toMat(cv, s, image);
		const dst = s.keep(new cv.Mat());
		cv.resize(src, dst, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
		const out = fromMat(cv, dst, raw.colorSpace);
		return {
			image: await deliver(out, fmt, quality),
			timing: timing(t0, "resize"),
		};
	} finally {
		s.free();
	}
}

function toGrayMat(cv, s, image) {
	const raw = describeRaw(image);
	const src = toMat(cv, s, image);
	if (raw.channels === 1) return src;
	const code = cv[`COLOR_${raw.colorSpace}2GRAY`];
	if (code === undefined) {
		throw new Error(`cvjs: cannot take ${raw.colorSpace} to GRAY`);
	}
	const gray = s.keep(new cv.Mat());
	cv.cvtColor(src, gray, code);
	return gray;
}

/**
 * filter(image, type, kernel, intensity, [fmt], [quality]) -> {image, timing}
 *
 * Only the two types label-crop asks for:
 *
 *   "otsu" - GaussianBlur(kernel x kernel, sigma 0), then a global Otsu
 *            threshold to a 0/255 single-channel mask. `intensity` is
 *            accepted for signature parity and ignored; the level is
 *            whatever Otsu derives.
 *   "edge" - Sobel gradient magnitude (|gx|/2 + |gy|/2, scaled by
 *            `intensity`), single channel. refineRectBoundary consumes this
 *            as a continuous magnitude against a floor of 24, so it must
 *            NOT be a binary Canny map.
 *
 * DIVERGES, deliberately, in the direction of the native engine: "otsu"
 * writes its blurred copy back over THE CALLER'S input buffer, because the
 * native engine does (verified bit-for-bit against GaussianBlur 3x3
 * sigma 0 - see bench/blur-probe.js) and label-crop depends on it.
 *
 * label-crop calls filter(det, "otsu") and then filter(det, "edge") on the
 * same `det`. On the native engine the second call therefore sees the
 * blurred image, and so does refineRectBoundary, which gets `det` as its
 * grayData. That blur is load-bearing: it softens thin printed rules more
 * than it softens the label's own boundary step, which is exactly the
 * discrimination the boundary refinement needs. Without it, an
 * axis-aligned label whose rules run parallel to its edge refines onto the
 * first rule instead - measured at 169px short on a 1200x750 label at
 * angle 0, while the native engine cropped it correctly.
 *
 * Mutating a caller's buffer is a bad contract and the real fix belongs in
 * label-crop, which should ask for the blurred copy it actually wants
 * rather than inherit one as a side effect. Until it does, an engine that
 * did not reproduce this would silently crop differently.
 */
async function filter(image, type, kernel, intensity, fmt, quality) {
	const t0 = performance.now();
	const cv = await ready();
	const kind = String(type || "").toLowerCase();
	const k = Number.isFinite(kernel) && kernel >= 3 ? Math.round(kernel) | 1 : 3;
	const s = scope();
	try {
		const gray = toGrayMat(cv, s, image);
		const dst = s.keep(new cv.Mat());
		if (kind === "otsu") {
			const blurred = s.keep(new cv.Mat());
			cv.GaussianBlur(gray, blurred, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT);
			// the write-back the native engine does; see the note above. Only
			// when the caller handed us a single-channel image of matching
			// size - anything else has no meaningful place to put it.
			const raw = describeRaw(image);
			if (raw.channels === 1 && blurred.rows === raw.height && blurred.cols === raw.width) {
				raw.view.set(blurred.data.subarray(0, raw.width * raw.height));
			}
			cv.threshold(blurred, dst, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
		} else if (kind === "edge") {
			const weight = Number.isFinite(intensity) && intensity > 0 ? intensity : 1;
			const gx = s.keep(new cv.Mat());
			const gy = s.keep(new cv.Mat());
			const ax = s.keep(new cv.Mat());
			const ay = s.keep(new cv.Mat());
			cv.Sobel(gray, gx, cv.CV_16S, 1, 0, k);
			cv.Sobel(gray, gy, cv.CV_16S, 0, 1, k);
			cv.convertScaleAbs(gx, ax);
			cv.convertScaleAbs(gy, ay);
			cv.addWeighted(ax, 0.5 * weight, ay, 0.5 * weight, 0, dst);
		} else {
			throw new Error(
				`cvjs: filter type "${type}" is not implemented (otsu, edge)`,
			);
		}
		const out = fromMat(cv, dst, "GRAY");
		return { image: await deliver(out, fmt, quality), timing: timing(t0, kind) };
	} finally {
		s.free();
	}
}

/**
 * crop(image, x, y, w, h, normalized, [fmt], [quality]) -> {image, timing}
 *
 * `normalized` reads x/y/w/h as fractions of the source dimensions. The
 * rect is clamped into the frame rather than throwing: label-crop derives
 * its final rect from a scaled-up detection and can land a pixel outside.
 */
async function crop(image, x, y, w, h, normalized, fmt, quality) {
	const t0 = performance.now();
	const cv = await ready();
	const raw = describeRaw(image);
	const sx = normalized ? raw.width : 1;
	const sy = normalized ? raw.height : 1;
	let x0 = Math.round(Number(x) * sx);
	let y0 = Math.round(Number(y) * sy);
	let cw = Math.round(Number(w) * sx);
	let ch = Math.round(Number(h) * sy);
	x0 = Math.max(0, Math.min(x0, raw.width - 1));
	y0 = Math.max(0, Math.min(y0, raw.height - 1));
	cw = Math.max(1, Math.min(cw, raw.width - x0));
	ch = Math.max(1, Math.min(ch, raw.height - y0));
	const s = scope();
	try {
		const src = toMat(cv, s, image);
		const roi = s.keep(src.roi(new cv.Rect(x0, y0, cw, ch)));
		const out = fromMat(cv, roi, raw.colorSpace);
		return { image: await deliver(out, fmt, quality), timing: timing(t0, "crop") };
	} finally {
		s.free();
	}
}

/** "#rrggbb" (or anything we cannot parse, as black) to a padding scalar. */
function padScalar(cv, padColor, channels) {
	let r = 0;
	let g = 0;
	let b = 0;
	const hex =
		typeof padColor === "string" && /^#?[0-9a-f]{6}$/i.test(padColor)
			? padColor.replace("#", "")
			: null;
	if (hex) {
		r = parseInt(hex.slice(0, 2), 16);
		g = parseInt(hex.slice(2, 4), 16);
		b = parseInt(hex.slice(4, 6), 16);
	}
	if (channels === 1) {
		// one grey matching the colour's luma, so a gray run and an RGB run
		// pad to the same tone
		const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		return new cv.Scalar(y, y, y, 255);
	}
	return new cv.Scalar(r, g, b, 255);
}

/**
 * rotate(image, angleDeg, [padColor], [fmt], [quality]) -> {image, timing}
 *
 * getRotationMatrix2D(centre, +angleDeg) - whose linear part is
 * [[cos, sin], [-sin, cos]] in image coordinates - into a canvas grown to
 * hold the rotated frame. lib/labelCrop.js predicts both that destination
 * size and the label's position inside it from exactly this convention
 * (cv::Size truncation included), so neither may drift.
 */
async function rotate(image, angleDeg, padColor, fmt, quality) {
	const t0 = performance.now();
	const cv = await ready();
	const raw = describeRaw(image);
	const angle = Number(angleDeg) || 0;
	const rad = (angle * Math.PI) / 180;
	const ca = Math.abs(Math.cos(rad));
	const sa = Math.abs(Math.sin(rad));
	const dstW = Math.max(1, Math.trunc(raw.height * sa + raw.width * ca));
	const dstH = Math.max(1, Math.trunc(raw.height * ca + raw.width * sa));
	const s = scope();
	try {
		const src = toMat(cv, s, image);
		const m = s.keep(
			cv.getRotationMatrix2D(
				new cv.Point(raw.width / 2, raw.height / 2),
				angle,
				1,
			),
		);
		// re-centre the rotated content in the grown canvas
		m.data64F[2] += dstW / 2 - raw.width / 2;
		m.data64F[5] += dstH / 2 - raw.height / 2;
		const dst = s.keep(new cv.Mat());
		cv.warpAffine(
			src,
			dst,
			m,
			new cv.Size(dstW, dstH),
			cv.INTER_LINEAR,
			cv.BORDER_CONSTANT,
			padScalar(cv, padColor, raw.channels),
		);
		const out = fromMat(cv, dst, raw.colorSpace);
		return {
			image: await deliver(out, fmt, quality),
			timing: timing(t0, "rotate"),
		};
	} finally {
		s.free();
	}
}

module.exports = {
	available,
	ready,
	colorConvert,
	resize,
	filter,
	crop,
	rotate,
	// shared with ./cvjsAlign.js, which implements imageAlign on top of
	// these; lib/engine.js composes the two into one engine object
	_internals: { scope, toGrayMat, fromMat, timing },
	_reset,
};
