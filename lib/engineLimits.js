/**
 * What the opencv.js engine (lib/cvjs.js, lib/cvjsAlign.js) refuses, and
 * how: exactly what @graciousstar/opencv5 refuses, with the same error
 * types, so a flow behaves the same on whichever engine loaded. These
 * mirror @graciousstar/opencv5's checks rather than import them: this engine is
 * the fallback for a host where that package is missing, so it cannot
 * depend on it. test/opencv5Engine.test.js runs one table of bad inputs
 * through both engines and compares what each throws.
 */

"use strict";

const COLOR_SPACE_BY_CHANNELS = { 1: "GRAY", 3: "RGB", 4: "RGBA" };

// the largest input opencv5 takes (65536 a side, 1 GiB), and the largest
// output an op makes (64 megapixels, 16384 a side)
const MAX_INPUT_SIDE = 65536;
const MAX_INPUT_BYTES = 2 ** 30;
const MAX_OUTPUT_SIDE = 16384;
const MAX_OUTPUT_PIXELS = 64 * 1024 * 1024;
// ECC's iterations, and the alignment copy's smallest side (ORB's
// five-level pyramid)
const MAX_ITERATIONS = 500;
const MIN_ALIGN_SIDE = 32;
// filter kernels: Gaussian for otsu, Sobel for edge - chosen bounds, the
// same on both engines, not correctness limits
const MAX_KERNEL = { otsu: 31, edge: 7 };

// The engine's own accessors, captured once: a typed array or buffer can
// carry an own `buffer`, `byteLength` or `resizable` getter that says
// something else, and these cannot be fooled by one.
const getter = (proto, key) => {
	const d = Object.getOwnPropertyDescriptor(proto, key);
	return d && d.get;
};
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const viewBuffer = getter(TYPED_ARRAY, "buffer");
const viewOffset = getter(TYPED_ARRAY, "byteOffset");
const viewLength = getter(TYPED_ARRAY, "byteLength");
const abResizable = getter(ArrayBuffer.prototype, "resizable");
const sabGrowable = typeof SharedArrayBuffer === "function" ? getter(SharedArrayBuffer.prototype, "growable") : undefined;

function resizableStore(buffer) {
	for (const get of [abResizable, sabGrowable]) {
		if (!get) continue;
		try {
			return get.call(buffer) === true;
		} catch {
			// not that kind of buffer
		}
	}
	return false;
}

// descriptors this module made, so an op handed one does not read the
// caller's object a second time
const described = new WeakSet();

/**
 * { view, width, height, channels, colorSpace } of a raw image: every
 * property read once, the bytes reached through the engine's own
 * accessors. A descriptor this function returned passes straight through.
 */
function describeRaw(image) {
	if (image && described.has(image)) return image;
	if (!image || typeof image !== "object") {
		throw new TypeError("cvjs: expected a raw { data, width, height, channels } image");
	}
	const data = image.data;
	const widthIn = image.width;
	const heightIn = image.height;
	const channelsIn = image.channels;
	const colorSpaceIn = image.colorSpace;
	const dtype = image.dtype;
	if (!ArrayBuffer.isView(data)) {
		throw new TypeError("cvjs: expected a raw { data, width, height, channels } image");
	}
	if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
		throw new TypeError(`cvjs: raw data must be a Buffer or Uint8Array, not a ${Object.prototype.toString.call(data).slice(8, -1)}`);
	}
	const width = Number(widthIn);
	const height = Number(heightIn);
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new Error("cvjs: raw width and height must be positive integers");
	}
	if (dtype !== undefined && dtype !== "uint8") {
		throw new Error(`cvjs: dtype ${dtype} is not supported (uint8 only)`);
	}
	const channels = Number(channelsIn || (colorSpaceIn === "GRAY" ? 1 : 3));
	if (!COLOR_SPACE_BY_CHANNELS[channels]) throw new Error(`cvjs: unsupported channel count ${channels}`);
	const colorSpace = String(colorSpaceIn || COLOR_SPACE_BY_CHANNELS[channels]).toUpperCase();
	const bytes = width * height * channels;
	if (width > MAX_INPUT_SIDE || height > MAX_INPUT_SIDE || bytes > MAX_INPUT_BYTES) {
		throw new RangeError(`cvjs: a ${width}x${height}x${channels} image is past 65536 a side or 1 GiB`);
	}
	const buffer = viewBuffer.call(data);
	const offset = viewOffset.call(data);
	if (viewLength.call(data) < bytes) throw new Error(`cvjs: raw data is shorter than ${width}x${height}x${channels}`);
	if (resizableStore(buffer)) {
		throw new Error("cvjs: raw data on a resizable or growable buffer is not supported");
	}
	const raw = { view: new Uint8Array(buffer, offset, bytes), width, height, channels, colorSpace };
	described.add(raw);
	return raw;
}

/** A finite number, or a TypeError/RangeError naming the argument. */
function finite(value, name) {
	if (typeof value !== "number") throw new TypeError(`cvjs: ${name} must be a number, got ${typeof value}`);
	if (!Number.isFinite(value)) throw new RangeError(`cvjs: ${name} must be finite, got ${value}`);
	return value;
}

function checkSize(width, height, op) {
	if (width > MAX_OUTPUT_SIDE || height > MAX_OUTPUT_SIDE || width * height > MAX_OUTPUT_PIXELS) {
		throw new RangeError(`cvjs: ${op} would make a ${width}x${height} image, past 64 megapixels or 16384 a side`);
	}
}

/**
 * A target size: "num" pixels, "pct"/"percent" a percentage, "scale" /
 * "multiply" a factor; 0 or NaN keeps the aspect ratio (null).
 *
 * "pct" and "scale" are separate modes on purpose. They used to share one
 * branch that guessed between the two by magnitude (values over 5 read as
 * a percentage), which silently turned a request for 5% into a 5x
 * upscale.
 */
function resolveDimension(mode, value, source) {
	const n = Number(value);
	if (mode === "pct" || mode === "percent") {
		if (!Number.isFinite(n) || n <= 0) throw new RangeError(`cvjs: resize needs a positive percentage, got ${value}`);
		return Math.max(1, Math.round(source * (n / 100)));
	}
	if (mode === "scale" || mode === "multiply") {
		if (!Number.isFinite(n) || n <= 0) throw new RangeError(`cvjs: resize needs a positive scale factor, got ${value}`);
		return Math.max(1, Math.round(source * n));
	}
	if (n === 0 || Number.isNaN(n)) return null;
	if (!Number.isFinite(n) || n < 0) throw new RangeError(`cvjs: resize needs a positive size, got ${value}`);
	return Math.max(1, Math.round(n));
}

/** resize's output size, as opencv5 resolves it. */
function resizeTarget(raw, wMode, wVal, hMode, hVal) {
	let width = resolveDimension(wMode, wVal, raw.width);
	let height = resolveDimension(hMode, hVal, raw.height);
	if (width === null && height === null) throw new RangeError("cvjs: resize needs at least one positive size");
	if (width === null) width = Math.max(1, Math.round((height * raw.width) / raw.height));
	if (height === null) height = Math.max(1, Math.round((width * raw.height) / raw.width));
	checkSize(width, height, "resize");
	return { width, height };
}

/** filter's kind and odd kernel, or the error opencv5 throws. */
function filterArgs(type, kernel) {
	const kind = String(type || "").toLowerCase();
	if (kind !== "otsu" && kind !== "edge") {
		throw new Error(`cvjs: filter type "${type}" is not implemented (otsu, edge)`);
	}
	const k = Number.isFinite(kernel) && kernel >= 3 ? Math.round(kernel) | 1 : 3;
	if (k > MAX_KERNEL[kind]) {
		throw new RangeError(`cvjs: filter "${kind}" takes a kernel up to ${MAX_KERNEL[kind]}, got ${kernel}`);
	}
	return { kind, k };
}

/** crop's rect in pixels, clamped into the frame. */
function cropRect(raw, x, y, w, h, normalized) {
	for (const [v, name] of [[x, "x"], [y, "y"], [w, "width"], [h, "height"]]) finite(v, `crop ${name}`);
	if (!(w > 0) || !(h > 0)) throw new RangeError(`cvjs: crop width and height must be positive, got ${w}x${h}`);
	const sx = normalized ? raw.width : 1;
	const sy = normalized ? raw.height : 1;
	let x0 = Math.round(x * sx);
	let y0 = Math.round(y * sy);
	let cw = Math.round(w * sx);
	let ch = Math.round(h * sy);
	x0 = Math.max(0, Math.min(x0, raw.width - 1));
	y0 = Math.max(0, Math.min(y0, raw.height - 1));
	cw = Math.max(1, Math.min(cw, raw.width - x0));
	ch = Math.max(1, Math.min(ch, raw.height - y0));
	return { x0, y0, cw, ch };
}

/** rotate's angle (missing: 0) and grown canvas. */
function rotateTarget(raw, angleDeg) {
	const angle = angleDeg === undefined || angleDeg === null ? 0 : finite(angleDeg, "rotate angle");
	const rad = (angle * Math.PI) / 180;
	const ca = Math.abs(Math.cos(rad));
	const sa = Math.abs(Math.sin(rad));
	const dstW = Math.max(1, Math.trunc(raw.height * sa + raw.width * ca));
	const dstH = Math.max(1, Math.trunc(raw.height * ca + raw.width * sa));
	checkSize(dstW, dstH, "rotate");
	return { angle, dstW, dstH };
}

/**
 * imageAlign's arguments as opencv5 takes them - affine, features+ecc,
 * orb, no polygon, grey images, scale in (0, 1] with a copy of at least 32
 * px a side, 1-500 iterations, a positive epsilon - or its error.
 */
function alignArgs(ref, tgt, scale, iterations, epsilon, polygon, motion, pipeline, detector) {
	if ((motion || "affine") !== "affine" || (pipeline || "features+ecc") !== "features+ecc" || (detector || "orb") !== "orb" || polygon) {
		throw new Error(
			`cvjs: imageAlign supports affine, features+ecc, orb and no polygon (got ${motion}, ${pipeline}, ${detector}${polygon ? ", a polygon" : ""})`,
		);
	}
	if (ref.channels !== 1 || tgt.channels !== 1) throw new Error("cvjs: imageAlign takes grey images");
	const s = Number(scale);
	if (!(s > 0 && s <= 1)) throw new RangeError(`cvjs: imageAlign scale must be in (0, 1], got ${scale}`);
	const its = Math.round(finite(iterations, "imageAlign iterations"));
	if (its < 1 || its > MAX_ITERATIONS) {
		throw new RangeError(`cvjs: imageAlign iterations must be 1-${MAX_ITERATIONS}, got ${iterations}`);
	}
	const eps = finite(epsilon, "imageAlign epsilon");
	if (!(eps > 0)) throw new RangeError(`cvjs: imageAlign epsilon must be positive, got ${epsilon}`);
	const small = [Math.round(ref.width * s), Math.round(ref.height * s)];
	if (Math.min(...small) < MIN_ALIGN_SIDE) {
		throw new RangeError(`cvjs: imageAlign's copy at scale ${s} would be ${small.join("x")} px; it needs at least ${MIN_ALIGN_SIDE} a side`);
	}
	return { s, its, eps };
}

module.exports = {
	COLOR_SPACE_BY_CHANNELS,
	describeRaw,
	finite,
	resizeTarget,
	filterArgs,
	cropRect,
	rotateTarget,
	alignArgs,
};
