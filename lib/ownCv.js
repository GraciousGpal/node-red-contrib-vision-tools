/**
 * PROTOTYPE, opt-in: the OpenCV engine as our own addon over OpenCV 5
 * (native/opencv/vision-cv.cc), selected by VISION_TOOLS_ENGINE=own and
 * by nothing else - lib/engine.js's "auto" never picks it.
 *
 * Why it exists: the rosepetal cpp-bridge is built for AVX2 (it can take
 * a pre-2013 x64 CPU down with an illegal instruction), has no win32
 * build (Windows falls to the opencv.js WASM build, which fails after a
 * few dozen large-frame alignments), and finds a golden's cached
 * features by hashing 768 of its bytes. This one is built for each arch's
 * baseline with the wider loops picked at run time, has a Windows build,
 * and keys a golden's features by the identity of its buffer.
 *
 * Same op surface, argument positions and reply shapes as the bridge and
 * lib/cvjs.js, so lib/nativeSeed.js and lib/labelCrop.js take it
 * unchanged. Raw images in and out; an encoded Buffer at colorConvert and
 * a non-raw `fmt` go through sharp, as in lib/cvjs.js, so OpenCV carries
 * no codecs.
 *
 * Where results can differ from the bridge's (OpenCV 5 against its 4.x,
 * and no fast-math), not just their timing: alignment moves by hundredths
 * of a pixel (bench numbers in the commit that added this), and
 * rotate()'s bilinear warp follows OpenCV 5's revised interpolation.
 *
 * The addon: prebuilds/<platform>-<arch>/vision-cv[.glibc|.musl].node,
 * checked against prebuilds/manifest.json before it is loaded, as
 * lib/nativeKernels.js does; or VISION_TOOLS_CV_ADDON=<path>, loaded
 * unchecked, for a local build.
 *
 * imageAlign()'s reply image is a buffer this thread reuses: it holds
 * until the event loop's next turn after the reply (lib/nativeSeed.js
 * copies out of it at once), not for as long as the caller keeps it.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.join(__dirname, "..");
const PREBUILDS = path.join(ROOT, "prebuilds");
// native/opencv/vision-cv.cc VT_CV_ABI
const ABI = 1;

function libc() {
	if (process.platform !== "linux") return "";
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
	return fs.existsSync(`/lib/ld-musl-${arch}.so.1`) ? "musl" : "glibc";
}

function candidates() {
	if (process.env.VISION_TOOLS_CV_ADDON) return [path.resolve(process.env.VISION_TOOLS_CV_ADDON)];
	const dir = path.join(PREBUILDS, `${process.platform}-${process.arch}`);
	const tag = libc();
	const tags = tag === "" ? [""] : tag === "musl" ? [".musl", ".glibc"] : [".glibc", ".musl"];
	return tags.map((t) => path.join(dir, `vision-cv${t}.node`));
}

/** Why a prebuild must not be loaded, or null (lib/nativeKernels.js). */
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

/** The addon, or a throw saying why not. Once per thread. */
function load() {
	if (addon) return addon;
	if (loadError) throw loadError;
	const explicit = Boolean(process.env.VISION_TOOLS_CV_ADDON);
	const files = candidates().filter((f) => fs.existsSync(f));
	const reasons = [];
	for (const file of files) {
		try {
			const bad = explicit ? null : unverified(file);
			if (bad) throw new Error(bad);
			const a = require(file);
			if (a.abi !== ABI) throw new Error(`vision-cv ABI ${a.abi}, expected ${ABI}`);
			addon = a;
			return addon;
		} catch (err) {
			reasons.push(`${path.relative(ROOT, file)}: ${err.message.split("\n")[0]}`);
		}
	}
	loadError = new Error(
		reasons.length
			? reasons.join("; ")
			: `no vision-cv addon for ${process.platform}-${process.arch}${libc() ? ` (${libc()})` : ""}`,
	);
	throw loadError;
}

function available() {
	try {
		load();
		return true;
	} catch {
		return false;
	}
}

async function ready() {
	return load();
}

/** Test seam: forget the load. */
function _reset() {
	addon = undefined;
	loadError = null;
}

// ---- images ----------------------------------------------------------------

const COLOR_SPACE_BY_CHANNELS = { 1: "GRAY", 3: "RGB", 4: "RGBA" };

function describeRaw(image) {
	if (!image || typeof image !== "object" || !ArrayBuffer.isView(image.data)) {
		throw new Error("ownCv: expected a raw { data, width, height, channels } image");
	}
	const width = Number(image.width);
	const height = Number(image.height);
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new Error("ownCv: raw width and height must be positive integers");
	}
	if (image.dtype !== undefined && image.dtype !== "uint8") {
		throw new Error(`ownCv: dtype ${image.dtype} is not supported (uint8 only)`);
	}
	const channels = Number(image.channels || (image.colorSpace === "GRAY" ? 1 : 3));
	if (!COLOR_SPACE_BY_CHANNELS[channels]) throw new Error(`ownCv: unsupported channel count ${channels}`);
	const colorSpace = String(image.colorSpace || COLOR_SPACE_BY_CHANNELS[channels]).toUpperCase();
	const bytes = width * height * channels;
	const { data } = image;
	if (data.byteLength < bytes) throw new Error(`ownCv: raw data is shorter than ${width}x${height}x${channels}`);
	const view = new Uint8Array(data.buffer, data.byteOffset, bytes);
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
		engine: "own",
		op,
	};
}

// ---- codecs (sharp, as lib/cvjs.js) ------------------------------------

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

async function deliver(image, fmt, quality) {
	if (RAW_FORMATS.has(fmt)) return image;
	const raw = describeRaw(image);
	const pipeline = getSharp()(Buffer.from(raw.view), {
		raw: { width: raw.width, height: raw.height, channels: raw.channels },
	});
	const q = Number.isFinite(quality) ? quality : 90;
	if (fmt === "jpg" || fmt === "jpeg") return pipeline.jpeg({ quality: q }).toBuffer();
	if (fmt === "png") return pipeline.png().toBuffer();
	if (fmt === "webp") return pipeline.webp({ quality: q }).toBuffer();
	throw new Error(`ownCv: unsupported output format "${fmt}"`);
}

// ---- ops ---------------------------------------------------------------

async function convert(raw, target) {
	const cv = load();
	const code = cv.colorCodes[`${raw.colorSpace}>${target}`];
	if (code === undefined) throw new Error(`ownCv: no conversion from ${raw.colorSpace} to ${target}`);
	const channels = CHANNELS_OF[target];
	const out = Buffer.allocUnsafeSlow(raw.width * raw.height * channels);
	const reply = await cv.cvtColor(raw.view, raw.width, raw.height, raw.channels, code, out, channels);
	return { image: rawImage(out, raw.width, raw.height, channels, target), reply };
}

/** colorConvert(image, targetColorSpace, [fmt], [quality]) -> {image, timing} */
async function colorConvert(image, targetColorSpace, fmt, quality) {
	const t0 = performance.now();
	const target = String(targetColorSpace || "RGB").toUpperCase();
	if (!CHANNELS_OF[target]) throw new Error(`ownCv: unsupported colour space ${target}`);
	const raw = describeRaw(Buffer.isBuffer(image) ? await decodeBuffer(image) : image);
	if (raw.colorSpace === target) {
		const copy = Buffer.allocUnsafeSlow(raw.view.byteLength);
		copy.set(raw.view);
		return {
			image: await deliver(rawImage(copy, raw.width, raw.height, raw.channels, target), fmt, quality),
			timing: timing(t0, "colorConvert"),
		};
	}
	const { image: out, reply } = await convert(raw, target);
	return { image: await deliver(out, fmt, quality), timing: timing(t0, "colorConvert", reply) };
}

/** lib/cvjs.js resolveDimension: num, pct/percent, scale; 0/NaN = keep aspect. */
function resolveDimension(mode, value, source) {
	const n = Number(value);
	if (mode === "pct" || mode === "percent") {
		if (!Number.isFinite(n) || n <= 0) throw new Error(`ownCv: resize needs a positive percentage, got ${value}`);
		return Math.max(1, Math.round(source * (n / 100)));
	}
	if (mode === "scale" || mode === "multiply") {
		if (!Number.isFinite(n) || n <= 0) throw new Error(`ownCv: resize needs a positive scale factor, got ${value}`);
		return Math.max(1, Math.round(source * n));
	}
	if (n === 0 || Number.isNaN(n)) return null;
	if (!Number.isFinite(n) || n < 0) throw new Error(`ownCv: resize needs a positive size, got ${value}`);
	return Math.max(1, Math.round(n));
}

/** resize(image, wMode, wVal, hMode, hVal, [fmt], [quality]) -> {image, timing}; INTER_LINEAR */
async function resize(image, wMode, wVal, hMode, hVal, fmt, quality) {
	const t0 = performance.now();
	const cv = load();
	const raw = describeRaw(image);
	let width = resolveDimension(wMode, wVal, raw.width);
	let height = resolveDimension(hMode, hVal, raw.height);
	if (width === null && height === null) throw new Error("ownCv: resize needs at least one positive size");
	if (width === null) width = Math.max(1, Math.round((height * raw.width) / raw.height));
	if (height === null) height = Math.max(1, Math.round((width * raw.height) / raw.width));
	const out = Buffer.allocUnsafeSlow(width * height * raw.channels);
	const reply = await cv.resize(raw.view, raw.width, raw.height, raw.channels, out, width, height);
	return {
		image: await deliver(rawImage(out, width, height, raw.channels, raw.colorSpace), fmt, quality),
		timing: timing(t0, "resize", reply),
	};
}

/**
 * filter(image, type, kernel, intensity, [fmt], [quality]) -> {image, timing}
 *
 * "otsu" and "edge" only, as lib/cvjs.js (its filter() explains both,
 * and why "otsu" blurs a single-channel input in place).
 */
async function filter(image, type, kernel, intensity, fmt, quality) {
	const t0 = performance.now();
	const cv = load();
	const kind = String(type || "").toLowerCase();
	if (kind !== "otsu" && kind !== "edge") {
		throw new Error(`ownCv: filter type "${type}" is not implemented (otsu, edge)`);
	}
	const k = Number.isFinite(kernel) && kernel >= 3 ? Math.round(kernel) | 1 : 3;
	const weight = Number.isFinite(intensity) && intensity > 0 ? intensity : 1;
	const raw = describeRaw(image);
	const gray = raw.channels === 1 ? raw : describeRaw((await convert(raw, "GRAY")).image);
	const out = Buffer.allocUnsafeSlow(raw.width * raw.height);
	const reply = await cv.filter(gray.view, raw.width, raw.height, kind === "otsu" ? 0 : 1, k, weight, out);
	return {
		image: await deliver(rawImage(out, raw.width, raw.height, 1, "GRAY"), fmt, quality),
		timing: timing(t0, kind, reply),
	};
}

/** crop(image, x, y, w, h, normalized, [fmt], [quality]) -> {image, timing}; clamped as lib/cvjs.js */
async function crop(image, x, y, w, h, normalized, fmt, quality) {
	const t0 = performance.now();
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
	const c = raw.channels;
	const out = Buffer.allocUnsafeSlow(cw * ch * c);
	for (let row = 0; row < ch; row++) {
		const from = ((y0 + row) * raw.width + x0) * c;
		out.set(raw.view.subarray(from, from + cw * c), row * cw * c);
	}
	return {
		image: await deliver(rawImage(out, cw, ch, c, raw.colorSpace), fmt, quality),
		timing: timing(t0, "crop"),
	};
}

/** "#rrggbb" (anything else: black) to a pad colour, as lib/cvjs.js padScalar */
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
 * rotated frame, re-centred - lib/cvjs.js rotate(), whose convention
 * lib/labelCrop.js predicts sizes and positions from.
 */
async function rotate(image, angleDeg, padColor, fmt, quality) {
	const t0 = performance.now();
	const cv = load();
	const raw = describeRaw(image);
	const angle = Number(angleDeg) || 0;
	const rad = (angle * Math.PI) / 180;
	const ca = Math.abs(Math.cos(rad));
	const sa = Math.abs(Math.sin(rad));
	const dstW = Math.max(1, Math.trunc(raw.height * sa + raw.width * ca));
	const dstH = Math.max(1, Math.trunc(raw.height * ca + raw.width * sa));
	const out = Buffer.allocUnsafeSlow(dstW * dstH * raw.channels);
	const reply = await cv.rotate(
		raw.view,
		raw.width,
		raw.height,
		raw.channels,
		out,
		dstW,
		dstH,
		angle,
		padColour(padColor, raw.channels),
	);
	return {
		image: await deliver(rawImage(out, dstW, dstH, raw.channels, raw.colorSpace), fmt, quality),
		timing: timing(t0, "rotate", reply),
	};
}

// ---- alignment -------------------------------------------------------------

// golden buffer -> Map("offset:WxH:scale" -> addon handle). A prepared
// golden's grey is never rewritten (lib/compare.js shares it read-only
// with every frame), so the buffer's identity is the golden's; the
// handle, holding the golden's ORB features, goes with the buffer.
const goldens = new WeakMap();
// this thread's reply image, reused while no other align is in flight:
// a fresh 5 MP buffer a frame is pages to fault in every time
let spare = null;
let inFlight = 0;

function goldenHandle(cv, ref, scale) {
	const key = ref.data.buffer;
	let byKey = goldens.get(key);
	if (!byKey) goldens.set(key, (byKey = new Map()));
	const id = `${ref.view.byteOffset}:${ref.width}x${ref.height}:${scale}`;
	let handle = byKey.get(id);
	if (!handle) byKey.set(id, (handle = cv.createGolden(ref.view, ref.width, ref.height, scale)));
	return handle;
}

/**
 * imageAlign(reference, target, scale, iterations, epsilon, fmt, quality,
 *   pngOptimize, returnImage, polygon, motion, pipeline, eccRefine, detector)
 *   -> { success, image, transformMatrix: { matrix2x3 }, timing }
 *
 * The bridge's imageAlign for what lib/nativeSeed.js asks of it: grey
 * images, affine motion, the "features+ecc" pipeline with ORB; anything
 * else is refused rather than approximated.
 */
async function imageAlign(reference, target, scale, iterations, epsilon, fmt, quality, pngOptimize, returnImage, polygon, motion, pipeline, eccRefine, detector) {
	const t0 = performance.now();
	const cv = load();
	if ((motion || "affine") !== "affine" || (pipeline || "features+ecc") !== "features+ecc" || (detector || "orb") !== "orb" || polygon) {
		throw new Error(
			`ownCv: imageAlign supports affine, features+ecc, orb and no polygon (got ${motion}, ${pipeline}, ${detector}${polygon ? ", a polygon" : ""})`,
		);
	}
	const ref = describeRaw(reference);
	const tgt = describeRaw(target);
	if (ref.channels !== 1 || tgt.channels !== 1) throw new Error("ownCv: imageAlign takes grey images");
	ref.data = reference.data;
	const s = Number(scale);
	if (!(s > 0 && s <= 1)) throw new Error(`ownCv: imageAlign scale must be in (0, 1], got ${scale}`);
	const handle = goldenHandle(cv, ref, s);
	const n = ref.width * ref.height;
	let out;
	// taken, not shared: until the setImmediate below gives it back, an
	// align started meanwhile gets a fresh buffer
	if (inFlight === 0 && spare !== null && spare.length === n) {
		out = spare;
		spare = null;
	} else {
		out = Buffer.allocUnsafeSlow(n);
	}
	inFlight++;
	let r;
	try {
		r = await cv.align(handle, tgt.view, tgt.width, tgt.height, out, Math.round(iterations), Number(epsilon), eccRefine === "always");
	} finally {
		inFlight--;
	}
	// free for reuse once this reply's caller has had its turn: what it
	// does with the image straight after the await runs before this
	setImmediate(() => {
		spare = out;
	});
	const image = r.success || returnImage !== false ? await deliver(rawImage(out, ref.width, ref.height, 1, "GRAY"), fmt, quality) : null;
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
