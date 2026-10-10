/**
 * @graciousstar/opencv5: a handful of OpenCV 5 vision ops on raw image
 * buffers - colorConvert, resize, filter (otsu, edge), crop, rotate and
 * imageAlign (ORB + RANSAC affine, ECC refinement) - over a small static
 * OpenCV in a plain N-API addon (native/opencv5.cc). Not general OpenCV
 * bindings.
 *
 * Every op is async and checks every length against the dimensions before
 * native code touches a byte. The argument positions and reply shapes are
 * those of the @rosepetal/node-red-contrib-image-tools cpp-bridge, which
 * this replaces for node-red-contrib-vision-tools: raw images in and out
 * as { data, width, height, channels, colorSpace, dtype }. An encoded
 * Buffer at colorConvert and a non-raw `fmt` go through sharp, so OpenCV
 * carries no codecs.
 *
 * Each binary is built for its arch's baseline and nothing else
 * (x86-64-v2, NEON): it runs on any CPU of its arch and gives the same
 * bytes on every one. It keys a reference image's ORB features by the
 * reference's content (a few of them kept), so they are found once per
 * reference.
 *
 * Every op copies its input before the work is queued and replies with
 * new buffers, so a caller may reuse, rewrite or transfer its buffers the
 * moment a call returns.
 *
 * The addon: prebuilds/<platform>-<arch>/opencv5[.glibc|.musl].node,
 * checked against prebuilds/manifest.json (size and SHA-256) before it is
 * opened - dlopen of a truncated shared object can take the process down
 * before any error reaches JavaScript; or OPENCV5_ADDON=<path>, loaded
 * unchecked, for a local build.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const PREBUILDS = path.join(__dirname, "prebuilds");
// native/opencv5.cc OPENCV5_ABI
const ABI = 3;

function libc() {
	if (process.platform !== "linux") return "";
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
	return fs.existsSync(`/lib/ld-musl-${arch}.so.1`) ? "musl" : "glibc";
}

/** The binaries this host could load, best first. */
function candidates() {
	if (process.env.OPENCV5_ADDON) return [path.resolve(process.env.OPENCV5_ADDON)];
	const dir = path.join(PREBUILDS, `${process.platform}-${process.arch}`);
	const tag = libc();
	const tags = tag === "" ? [""] : tag === "musl" ? [".musl", ".glibc"] : [".glibc", ".musl"];
	return tags.map((t) => path.join(dir, `opencv5${t}.node`));
}

/** Why a prebuild must not be loaded, or null. */
function unverified(file) {
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(PREBUILDS, "manifest.json"), "utf8"));
	} catch (err) {
		return `prebuilds/manifest.json: ${err.code || err.message}`;
	}
	const want = manifest[path.relative(PREBUILDS, file).split(path.sep).join("/")];
	if (!want) return "not in prebuilds/manifest.json";
	const bytes = fs.readFileSync(file);
	if (bytes.length !== want.size) return `${bytes.length} bytes, the manifest says ${want.size}`;
	if (crypto.createHash("sha256").update(bytes).digest("hex") !== want.sha256) {
		return "its SHA-256 is not the manifest's";
	}
	return null;
}

let addon;
let loadError = null;

/**
 * The addon, or a throw saying why not. Once per thread (a worker thread
 * loads its own instance), and a failure is remembered too: what decides
 * it - the files on disk, the manifest, OPENCV5_ADDON - does not change
 * under a running process, and retrying a failed dlopen on every op would
 * cost each one a stat and a hash. _reset() forgets it.
 */
function load() {
	if (addon) return addon;
	if (loadError) throw loadError;
	const explicit = Boolean(process.env.OPENCV5_ADDON);
	if (explicit && !fs.existsSync(path.resolve(process.env.OPENCV5_ADDON))) {
		loadError = new Error(`OPENCV5_ADDON is ${process.env.OPENCV5_ADDON}, which does not exist`);
		throw loadError;
	}
	const files = candidates().filter((f) => fs.existsSync(f));
	const reasons = [];
	for (const file of files) {
		try {
			const bad = explicit ? null : unverified(file);
			if (bad) throw new Error(bad);
			const a = require(file);
			if (a.abi !== ABI) throw new Error(`opencv5 ABI ${a.abi}, expected ${ABI}`);
			addon = a;
			return addon;
		} catch (err) {
			reasons.push(`${path.relative(__dirname, file)}: ${err.message.split("\n")[0]}`);
		}
	}
	loadError = new Error(
		reasons.length
			? reasons.join("; ")
			: `no opencv5 binary for ${process.platform}-${process.arch}${libc() ? ` (${libc()})` : ""}`,
	);
	throw loadError;
}

/** True when the addon loads here. */
function available() {
	try {
		load();
		return true;
	} catch {
		return false;
	}
}

/** Resolves once the addon is loaded (it loads synchronously; this is for
 * callers that expect an engine to have a ready()). */
async function ready() {
	return load();
}

/** Test seam: forget the load, so OPENCV5_ADDON is read again. */
function _reset() {
	addon = undefined;
	loadError = null;
}

// ---- images ----------------------------------------------------------------

const COLOR_SPACE_BY_CHANNELS = { 1: "GRAY", 3: "RGB", 4: "RGBA" };

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

/** True for a store whose length can change under a view. */
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

// the largest input the addon takes: 65536 a side, 1 GiB in all
const MAX_INPUT_SIDE = 65536;
const MAX_INPUT_BYTES = 2 ** 30;

/**
 * { view, width, height, channels, colorSpace } of a raw image, every
 * property read exactly once (a getter cannot answer one check and then
 * something else), and the view made over the bytes through the engine's
 * own accessors.
 */
function describeRaw(image) {
	if (!image || typeof image !== "object") {
		throw new TypeError("opencv5: expected a raw { data, width, height, channels } image");
	}
	const data = image.data;
	const widthIn = image.width;
	const heightIn = image.height;
	const channelsIn = image.channels;
	const colorSpaceIn = image.colorSpace;
	const dtype = image.dtype;
	// 8-bit data only: a Float32Array or a DataView over the same bytes
	// would be read as something it is not
	if (!ArrayBuffer.isView(data)) {
		throw new TypeError("opencv5: expected a raw { data, width, height, channels } image");
	}
	if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
		throw new TypeError(`opencv5: raw data must be a Buffer or Uint8Array, not a ${Object.prototype.toString.call(data).slice(8, -1)}`);
	}
	const width = Number(widthIn);
	const height = Number(heightIn);
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new Error("opencv5: raw width and height must be positive integers");
	}
	if (dtype !== undefined && dtype !== "uint8") {
		throw new Error(`opencv5: dtype ${dtype} is not supported (uint8 only)`);
	}
	const channels = Number(channelsIn || (colorSpaceIn === "GRAY" ? 1 : 3));
	if (!COLOR_SPACE_BY_CHANNELS[channels]) throw new Error(`opencv5: unsupported channel count ${channels}`);
	const colorSpace = String(colorSpaceIn || COLOR_SPACE_BY_CHANNELS[channels]).toUpperCase();
	const bytes = width * height * channels;
	if (width > MAX_INPUT_SIDE || height > MAX_INPUT_SIDE || bytes > MAX_INPUT_BYTES) {
		throw new RangeError(`opencv5: a ${width}x${height}x${channels} image is past 65536 a side or 1 GiB`);
	}
	// real typed-array internals from here: nothing below runs caller code
	const buffer = viewBuffer.call(data);
	const offset = viewOffset.call(data);
	if (viewLength.call(data) < bytes) throw new Error(`opencv5: raw data is shorter than ${width}x${height}x${channels}`);
	// The addon copies the input on this thread before the op is queued,
	// so a resize afterwards changes nothing it reads, and a store resized
	// before then is caught by the addon's own length check. Refused anyway:
	// the length checked here is not a property such a store keeps.
	if (resizableStore(buffer)) {
		throw new Error("opencv5: raw data on a resizable or growable buffer is not supported");
	}
	const view = new Uint8Array(buffer, offset, bytes);
	return { view, width, height, channels, colorSpace };
}

function rawImage(data, width, height, channels, colorSpace) {
	return {
		data,
		width,
		height,
		channels,
		colorSpace: colorSpace || COLOR_SPACE_BY_CHANNELS[channels],
		dtype: "uint8",
	};
}

const CHANNELS_OF = { GRAY: 1, RGB: 3, BGR: 3, RGBA: 4, BGRA: 4 };

function timing(t0, op, reply) {
	return {
		totalMs: performance.now() - t0,
		taskMs: reply && reply.timing ? reply.timing.taskMs : undefined,
		engine: "opencv5",
		op,
	};
}

// ---- codecs (sharp) ----------------------------------------------------

let sharpModule;
function getSharp() {
	sharpModule ||= require("sharp");
	return sharpModule;
}

const RAW_FORMATS = new Set([undefined, null, "", "raw"]);

/**
 * An encoded image as the bridge's imdecode(IMREAD_UNCHANGED) hands it on:
 * its own channel count (1, 3 or 4; grey + alpha comes out as RGBA), 8 bit,
 * no EXIF rotation.
 */
async function decodeBuffer(buffer) {
	let { data, info } = await getSharp()(buffer).raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
	if (info.channels === 2) {
		({ data, info } = await getSharp()(buffer)
			.toColourspace("srgb")
			.ensureAlpha()
			.raw({ depth: "uchar" })
			.toBuffer({ resolveWithObject: true }));
	}
	return rawImage(data, info.width, info.height, info.channels);
}

/**
 * A copy of the pixels in the R-G-B order sharp reads raw input in: a
 * BGR or BGRA image has its first and third channels swapped, so it is
 * not encoded with red and blue exchanged.
 */
function rgbOrder(raw) {
	const out = Buffer.from(raw.view);
	if (raw.colorSpace !== "BGR" && raw.colorSpace !== "BGRA") return out;
	const c = raw.channels;
	for (let i = 0; i < out.length; i += c) {
		const b = out[i];
		out[i] = out[i + 2];
		out[i + 2] = b;
	}
	return out;
}

/** Raw straight through; jpg/png/webp through sharp. pngOptimize trades
 * time for size: zlib level 9 with adaptive filtering, else level 1. */
async function deliver(image, fmt, quality, pngOptimize) {
	if (RAW_FORMATS.has(fmt)) return image;
	const raw = describeRaw(image);
	const pipeline = getSharp()(rgbOrder(raw), {
		raw: { width: raw.width, height: raw.height, channels: raw.channels },
	});
	const q = Number.isFinite(quality) ? quality : 90;
	if (fmt === "jpg" || fmt === "jpeg") return pipeline.jpeg({ quality: q }).toBuffer();
	if (fmt === "png") {
		return pipeline.png(pngOptimize ? { compressionLevel: 9, adaptiveFiltering: true } : { compressionLevel: 1 }).toBuffer();
	}
	if (fmt === "webp") return pipeline.webp({ quality: q }).toBuffer();
	throw new Error(`opencv5: unsupported output format "${fmt}"`);
}

// ---- ops ---------------------------------------------------------------

/** A finite number, or a TypeError/RangeError naming the argument. */
function finite(value, name) {
	if (typeof value !== "number") throw new TypeError(`opencv5: ${name} must be a number, got ${typeof value}`);
	if (!Number.isFinite(value)) throw new RangeError(`opencv5: ${name} must be finite, got ${value}`);
	return value;
}

// the largest output an op makes: 64 megapixels, 16384 a side (the addon
// refuses 65536)
function checkSize(width, height, op) {
	if (width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
		throw new RangeError(`opencv5: ${op} would make a ${width}x${height} image, past 64 megapixels or 16384 a side`);
	}
}

async function convert(raw, target) {
	const cv = load();
	const code = cv.colorCodes[`${raw.colorSpace}>${target}`];
	if (code === undefined) throw new Error(`opencv5: no conversion from ${raw.colorSpace} to ${target}`);
	const channels = CHANNELS_OF[target];
	const reply = await cv.cvtColor(raw.view, raw.width, raw.height, raw.channels, code, channels);
	return { image: rawImage(reply.data, raw.width, raw.height, channels, target), reply };
}

/** colorConvert(image, targetColorSpace, [fmt], [quality]) -> {image, timing} */
async function colorConvert(image, targetColorSpace, fmt, quality, pngOptimize) {
	const t0 = performance.now();
	const target = String(targetColorSpace || "RGB").toUpperCase();
	if (!CHANNELS_OF[target]) throw new Error(`opencv5: unsupported colour space ${target}`);
	const raw = describeRaw(Buffer.isBuffer(image) ? await decodeBuffer(image) : image);
	if (raw.colorSpace === target) {
		const copy = Buffer.allocUnsafeSlow(raw.view.byteLength);
		copy.set(raw.view);
		return {
			image: await deliver(rawImage(copy, raw.width, raw.height, raw.channels, target), fmt, quality, pngOptimize),
			timing: timing(t0, "colorConvert"),
		};
	}
	const { image: out, reply } = await convert(raw, target);
	return { image: await deliver(out, fmt, quality, pngOptimize), timing: timing(t0, "colorConvert", reply) };
}

/** A target size: num, pct/percent, scale/multiply; 0/NaN keeps the aspect ratio. */
function resolveDimension(mode, value, source) {
	const n = Number(value);
	if (mode === "pct" || mode === "percent") {
		if (!Number.isFinite(n) || n <= 0) throw new RangeError(`opencv5: resize needs a positive percentage, got ${value}`);
		return Math.max(1, Math.round(source * (n / 100)));
	}
	if (mode === "scale" || mode === "multiply") {
		if (!Number.isFinite(n) || n <= 0) throw new RangeError(`opencv5: resize needs a positive scale factor, got ${value}`);
		return Math.max(1, Math.round(source * n));
	}
	if (n === 0 || Number.isNaN(n)) return null;
	if (!Number.isFinite(n) || n < 0) throw new RangeError(`opencv5: resize needs a positive size, got ${value}`);
	return Math.max(1, Math.round(n));
}

/** resize(image, wMode, wVal, hMode, hVal, [fmt], [quality]) -> {image, timing}; INTER_LINEAR */
async function resize(image, wMode, wVal, hMode, hVal, fmt, quality, pngOptimize) {
	const t0 = performance.now();
	const cv = load();
	const raw = describeRaw(image);
	let width = resolveDimension(wMode, wVal, raw.width);
	let height = resolveDimension(hMode, hVal, raw.height);
	if (width === null && height === null) throw new RangeError("opencv5: resize needs at least one positive size");
	if (width === null) width = Math.max(1, Math.round((height * raw.width) / raw.height));
	if (height === null) height = Math.max(1, Math.round((width * raw.height) / raw.width));
	checkSize(width, height, "resize");
	const reply = await cv.resize(raw.view, raw.width, raw.height, raw.channels, width, height);
	return {
		image: await deliver(rawImage(reply.data, width, height, raw.channels, raw.colorSpace), fmt, quality, pngOptimize),
		timing: timing(t0, "resize", reply),
	};
}

/**
 * filter(image, type, kernel, intensity, [fmt], [quality])
 *   -> {image, blurred?, timing}
 *
 *   "otsu" - GaussianBlur(kernel, sigma 0; kernel 3-31), then a global Otsu
 *            threshold to a 0/255 mask. `blurred` is the blurred grey, a
 *            raw image of its own. (The rosepetal bridge wrote it back over
 *            the caller's input instead; nothing here writes to an input.)
 *   "edge" - Sobel magnitude, |gx|/2 + |gy|/2 scaled by `intensity`; a
 *            continuous grey map, not a binary edge map. Kernel 3-7: a
 *            chosen bound, the same on both engines, not a correctness
 *            limit (the 16-bit derivative saturates on a strong step at 7
 *            as at 9).
 */
async function filter(image, type, kernel, intensity, fmt, quality, pngOptimize) {
	const t0 = performance.now();
	const cv = load();
	const kind = String(type || "").toLowerCase();
	if (kind !== "otsu" && kind !== "edge") {
		throw new Error(`opencv5: filter type "${type}" is not implemented (otsu, edge)`);
	}
	const k = Number.isFinite(kernel) && kernel >= 3 ? Math.round(kernel) | 1 : 3;
	if (k > (kind === "edge" ? 7 : 31)) {
		throw new RangeError(`opencv5: filter "${kind}" takes a kernel up to ${kind === "edge" ? 7 : 31}, got ${kernel}`);
	}
	const weight = Number.isFinite(intensity) && intensity > 0 ? intensity : 1;
	const raw = describeRaw(image);
	const gray = raw.channels === 1 ? raw : describeRaw((await convert(raw, "GRAY")).image);
	const reply = await cv.filter(gray.view, raw.width, raw.height, kind === "otsu" ? 0 : 1, k, weight);
	const out = {
		image: await deliver(rawImage(reply.data, raw.width, raw.height, 1, "GRAY"), fmt, quality, pngOptimize),
		timing: timing(t0, kind, reply),
	};
	if (reply.blurred) out.blurred = rawImage(reply.blurred, raw.width, raw.height, 1, "GRAY");
	return out;
}

/** crop(image, x, y, w, h, normalized, [fmt], [quality]) -> {image, timing}; clamped into the frame */
async function crop(image, x, y, w, h, normalized, fmt, quality, pngOptimize) {
	const t0 = performance.now();
	const raw = describeRaw(image);
	for (const [v, name] of [[x, "x"], [y, "y"], [w, "width"], [h, "height"]]) finite(v, `crop ${name}`);
	if (!(w > 0) || !(h > 0)) throw new RangeError(`opencv5: crop width and height must be positive, got ${w}x${h}`);
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
	const c = raw.channels;
	const out = Buffer.allocUnsafeSlow(cw * ch * c);
	for (let row = 0; row < ch; row++) {
		const from = ((y0 + row) * raw.width + x0) * c;
		out.set(raw.view.subarray(from, from + cw * c), row * cw * c);
	}
	return {
		image: await deliver(rawImage(out, cw, ch, c, raw.colorSpace), fmt, quality, pngOptimize),
		timing: timing(t0, "crop"),
	};
}

/** "#rrggbb" (anything else: black) to a pad colour; a grey image takes its luma */
function padColour(padColor, channels) {
	let r = 0;
	let g = 0;
	let b = 0;
	if (typeof padColor === "string" && /^#?[0-9a-f]{6}$/i.test(padColor)) {
		const hex = padColor.replace("#", "");
		r = parseInt(hex.slice(0, 2), 16);
		g = parseInt(hex.slice(2, 4), 16);
		b = parseInt(hex.slice(4, 6), 16);
	}
	if (channels === 1) {
		const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		return [y, y, y, 255];
	}
	return [r, g, b, 255];
}

/**
 * rotate(image, angleDeg, [padColor], [fmt], [quality]) -> {image, timing}
 *
 * getRotationMatrix2D(centre, +angleDeg) into a canvas grown to hold the
 * rotated frame (each side Math.trunc of the rotated extent), re-centred.
 * INTER_LINEAR, the border in `padColor`.
 */
async function rotate(image, angleDeg, padColor, fmt, quality, pngOptimize) {
	const t0 = performance.now();
	const cv = load();
	const raw = describeRaw(image);
	const angle = angleDeg === undefined || angleDeg === null ? 0 : finite(angleDeg, "rotate angle");
	const rad = (angle * Math.PI) / 180;
	const ca = Math.abs(Math.cos(rad));
	const sa = Math.abs(Math.sin(rad));
	const dstW = Math.max(1, Math.trunc(raw.height * sa + raw.width * ca));
	const dstH = Math.max(1, Math.trunc(raw.height * ca + raw.width * sa));
	checkSize(dstW, dstH, "rotate");
	const [p0, p1, p2, p3] = padColour(padColor, raw.channels);
	const reply = await cv.rotate(raw.view, raw.width, raw.height, raw.channels, dstW, dstH, angle, p0, p1, p2, p3);
	return {
		image: await deliver(rawImage(reply.data, dstW, dstH, raw.channels, raw.colorSpace), fmt, quality, pngOptimize),
		timing: timing(t0, "rotate", reply),
	};
}

// ---- alignment -------------------------------------------------------------

// "WxH:scale:content hash" -> addon handle holding that reference's ORB
// features, most recently used last. Keyed by the reference's content, so
// a buffer rewritten in place is a new golden, and bounded, so a caller
// cycling through scales or goldens does not keep every one alive: each
// holds the grey, its small copy and that copy as float.
const goldens = new Map();
const MAX_GOLDENS = 4;

function goldenHandle(cv, ref, scale) {
	// every byte hashed natively: about 0.2 ms for a 3 MP golden
	const key = `${ref.width}x${ref.height}:${scale}:${cv.contentKey(ref.view)}`;
	let handle = goldens.get(key);
	if (handle) goldens.delete(key);
	// The hash is fast, not collision-proof: an image can be built to share
	// another's key. So a hit is reused only when the golden holds exactly
	// these bytes (a memcmp, about 0.3 ms for 3 MP) - which also catches a
	// shared buffer rewritten between the hash and an earlier create.
	if (!handle || !cv.sameGolden(handle, ref.view, ref.width, ref.height)) {
		handle = cv.createGolden(ref.view, ref.width, ref.height, scale);
		while (goldens.size >= MAX_GOLDENS) goldens.delete(goldens.keys().next().value);
	}
	goldens.set(key, handle);
	return handle;
}

/**
 * imageAlign(reference, target, scale, iterations, epsilon, fmt, quality,
 *   pngOptimize, returnImage, polygon, motion, pipeline, eccRefine, detector)
 *   -> { success, image, transformMatrix: { matrix2x3 }, inliers, timing }
 *
 * The bridge's imageAlign, for grey images, affine motion and the
 * "features+ecc" pipeline with ORB; anything else is refused rather than
 * approximated. `scale` sizes the internal alignment copy, which must be
 * at least 32 px a side; `iterations` is ECC's, 1-500. The matrix maps
 * reference coordinates into the target resized to the reference's size,
 * and the image - a new buffer every reply - is the target warped onto the
 * reference (0 where it does not reach). eccRefine "always" runs ECC after
 * the feature seed; "auto" skips it when the seed has 50 inliers or more.
 */
async function imageAlign(reference, target, scale, iterations, epsilon, fmt, quality, pngOptimize, returnImage, polygon, motion, pipeline, eccRefine, detector) {
	const t0 = performance.now();
	const cv = load();
	if ((motion || "affine") !== "affine" || (pipeline || "features+ecc") !== "features+ecc" || (detector || "orb") !== "orb" || polygon) {
		throw new Error(
			`opencv5: imageAlign supports affine, features+ecc, orb and no polygon (got ${motion}, ${pipeline}, ${detector}${polygon ? ", a polygon" : ""})`,
		);
	}
	const ref = describeRaw(reference);
	const tgt = describeRaw(target);
	if (ref.channels !== 1 || tgt.channels !== 1) throw new Error("opencv5: imageAlign takes grey images");
	const s = Number(scale);
	if (!(s > 0 && s <= 1)) throw new RangeError(`opencv5: imageAlign scale must be in (0, 1], got ${scale}`);
	const its = Math.round(finite(iterations, "imageAlign iterations"));
	if (its < 1 || its > cv.maxIterations) {
		throw new RangeError(`opencv5: imageAlign iterations must be 1-${cv.maxIterations}, got ${iterations}`);
	}
	const eps = finite(epsilon, "imageAlign epsilon");
	if (!(eps > 0)) throw new RangeError(`opencv5: imageAlign epsilon must be positive, got ${epsilon}`);
	const small = [Math.round(ref.width * s), Math.round(ref.height * s)];
	if (Math.min(...small) < cv.minAlignSide) {
		throw new RangeError(
			`opencv5: imageAlign's copy at scale ${s} would be ${small.join("x")} px; it needs at least ${cv.minAlignSide} a side`,
		);
	}
	const handle = goldenHandle(cv, ref, s);
	const r = await cv.align(handle, tgt.view, tgt.width, tgt.height, its, eps, eccRefine === "always");
	const image = r.success || returnImage !== false ? await deliver(rawImage(r.data, ref.width, ref.height, 1, "GRAY"), fmt, quality, pngOptimize) : null;
	return {
		success: r.success,
		image,
		transformMatrix: r.success ? { matrix2x3: r.matrix } : undefined,
		inliers: r.inliers,
		timing: { ...timing(t0, "imageAlign", r), stages: r.stages, ecc: r.ecc },
	};
}

module.exports = {
	available,
	ready,
	load,
	colorConvert,
	resize,
	filter,
	crop,
	rotate,
	imageAlign,
	candidates,
	_reset,
};
