/**
 * Input handling shared by the Node-RED nodes: bounded numeric settings
 * and the guarded image loader for msg.payload / msg.golden in every form
 * a flow hands over (Buffer / Uint8Array / ArrayBuffer, a file path, or an
 * object carrying `data` / `buffer` / `path`).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;

// Image inputs are capped before anything copies, hashes, or reads
// them: an unbounded buffer would be copied and SHA-1'd on every
// message for no inspection value, and an unbounded path read would
// hang or OOM on a special file like /dev/zero. 512MB is far past the
// largest capture this pipeline is meant for (a 23MP framebuffer is
// ~90MB).
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

// The byte cap does not bound a decode: a 16000x16000 white PNG is
// ~280KB and decodes to 256MB+. Every untrusted decode goes through
// sharpInput (or assertPixelsUnderCap, for engines that decode
// themselves), which refuses anything above this many pixels.
const MAX_INPUT_PIXELS = 64e6;

/** A checkbox or msg flag: true/"true" is on, blank keeps the fallback. */
function asBoolean(value, fallback = false) {
	if (value == null || value === "") return fallback;
	return value === true || value === "true";
}

function clampInt(value, fallback, [min, max]) {
	const n = parseInt(value, 10);
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function clampFloat(value, fallback, [min, max]) {
	const n = parseFloat(value);
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function pickMode(value, fallback, allowed) {
	return allowed.includes(value) ? value : fallback;
}

function isBytes(v) {
	return Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer;
}

/** The same memory as a Buffer, without copying it. A plain Array of
 * bytes has no memory to share, so it is copied into one. */
function asView(data) {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.from(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function assertUnderCap(data, label) {
	if (data.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(
			`${label} is ${data.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte cap`,
		);
	}
}

/**
 * Open an image file through one handle: open -> fstat -> guards. The
 * guards are the point. A pathExists() then readFile() pair is a race
 * (the file can be swapped between the two), and an unguarded path read
 * lets a flow point msg.golden at /dev/zero and hang the node on an
 * endless read. Returns null when the path does not exist, so callers
 * can keep distinguishing "missing" from "refused"; otherwise the open
 * handle with the stat the caller may fingerprint from. The caller
 * closes the handle.
 */
async function openRegularFile(p, label) {
	let fd;
	try {
		fd = await fsp.open(p, fs.constants.O_RDONLY);
	} catch (err) {
		if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
		throw err;
	}
	try {
		const stat = await fd.stat();
		if ((stat.mode & fs.constants.S_IFMT) !== fs.constants.S_IFREG) {
			throw new Error(
				`${label} is not a regular file: "${p}" - refusing to read it`,
			);
		}
		if (stat.size > MAX_IMAGE_BYTES) {
			throw new Error(
				`${label} is ${stat.size} bytes, above the ${MAX_IMAGE_BYTES}-byte cap: "${p}"`,
			);
		}
		return { handle: fd, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch (err) {
		await fd.close();
		throw err;
	}
}

/** open -> fstat -> guards -> read -> close; the bytes, or null when the
 * path does not exist. */
async function readRegularFile(p, label) {
	const open = await openRegularFile(p, label);
	if (!open) return null;
	try {
		return await open.handle.readFile();
	} finally {
		await open.handle.close();
	}
}

/** The byte-carrying forms, in one place - the top-level buffer and the
 * `data`/`buffer` member of an object descriptor are validated
 * identically. */
function bytesOf(source) {
	const data = isBytes(source)
		? source
		: source && typeof source === "object"
			? source.data || source.buffer
			: null;
	return isBytes(data) ? data : null;
}

const objectFormError = (label) =>
	`${label} object must contain "data"/"buffer" or an existing "path"`;

/**
 * Where an image source keeps its bytes: `{ data }` for the in-memory
 * forms, checked against the size cap, or `{ path, missing }` for a
 * file, `missing` being the error to raise if it is not there - a bare
 * path string and a path inside an object have always said different
 * things. Anything else is refused here.
 */
function locateSource(source, label) {
	if (source == null || source === "") throw new Error(`${label} is empty`);
	const data = bytesOf(source);
	if (data) {
		assertUnderCap(data, label);
		return { data };
	}
	if (typeof source === "string") {
		return { path: source, missing: `${label} does not exist on disk: "${source}"` };
	}
	if (typeof source === "object" && typeof source.path === "string") {
		return { path: source.path, missing: objectFormError(label) };
	}
	if (typeof source === "object") throw new Error(objectFormError(label));
	throw new Error(`unsupported ${label} type: ${typeof source}`);
}

/** Load an image source to a Buffer, with every guard above applied.
 * The caller's bytes are copied unless `copy: false`, which a node that
 * only reads them passes: a raw camera frame is 33 MB, ~20-28 ms to copy. */
async function resolveImage(source, label, { copy = true, raw = false } = {}) {
	const at = locateSource(source, label);
	if (at.data) {
		// raw pixels have no header to sniff; a { data, width, height,
		// channels } descriptor says it is raw itself
		if (!raw && !geometryOf(source)) assertImageSignature(asView(at.data), label);
		// Buffer.from(view) copies; Buffer.from(ArrayBuffer) would not.
		return copy ? Buffer.from(asView(at.data)) : asView(at.data);
	}
	const file = await readRegularFile(at.path, label);
	if (!file) throw new Error(at.missing);
	if (!raw) assertImageSignature(file, label);
	return file;
}

/** An input refused by the guards below, as opposed to one that failed
 * to decode: perspective-rectify fails these rather than passing the
 * frame through. */
function refused(message) {
	const err = new Error(message);
	err.code = "ERR_IMAGE_REFUSED";
	return err;
}

const ascii = (b, at, s) => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;

/**
 * Only the formats an inspection camera or a rendered golden comes in
 * reach a decoder, by their leading signature. Everything else is
 * refused - SVG above all, in any wrapping (BOM, whitespace, gzip):
 * librsvg is a large attack surface (GHSA-wq5f-xc86-pv6w) and no
 * inspection input is vector artwork.
 */
function assertImageSignature(bytes, label) {
	const b = asView(bytes);
	const ok =
		(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
		ascii(b, 0, "\x89PNG\r\n\x1a\n") ||
		(ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) ||
		ascii(b, 0, "GIF87a") ||
		ascii(b, 0, "GIF89a") ||
		ascii(b, 0, "II*\0") || // TIFF, little-endian
		ascii(b, 0, "MM\0*") || // TIFF, big-endian
		ascii(b, 4, "ftyp"); // HEIF / AVIF
	if (!ok) throw refused(`${label}: not a supported image (JPEG, PNG, WebP, GIF, TIFF, HEIF)`);
}

/** For an encoded image handed to an engine that decodes it itself
 * (both engines decode with sharp): the signature, a header read, then
 * a named error above the cap. */
async function assertPixelsUnderCap(bytes, label) {
	assertImageSignature(bytes, label);
	const { width: w, height: h } = await require("sharp")(bytes, { limitInputPixels: false }).metadata();
	if (w * h > MAX_INPUT_PIXELS) {
		throw refused(`${label}: ${w}x${h} is above the ${MAX_INPUT_PIXELS / 1e6}M pixel cap`);
	}
}

/** sharp() for an untrusted encoded image, after assertPixelsUnderCap.
 * limitInputPixels stays on the instance as a second line of defence.
 * Not for raw pixels. */
async function sharpInput(bytes, label) {
	await assertPixelsUnderCap(bytes, label);
	return require("sharp")(bytes, { limitInputPixels: MAX_INPUT_PIXELS });
}


/**
 * Geometry for pixels that arrive with no container around them.
 * Undefined unless all three are present and sane - a partial
 * descriptor is worse than none, because sharp would read past the end
 * of the buffer rather than tell you the numbers are wrong.
 */
function geometryOf(source) {
	if (!source || typeof source !== "object") return undefined;
	const width = Number(source.width);
	const height = Number(source.height);
	const channels = Number(source.channels);
	if (!Number.isInteger(width) || width <= 0) return undefined;
	if (!Number.isInteger(height) || height <= 0) return undefined;
	if (!Number.isInteger(channels) || channels < 1 || channels > 4)
		return undefined;
	// A descriptor past the decode cap is a mistake, not a sensor: 64M
	// pixels at 4 channels is 256MB, far beyond anything this inspection runs.
	// Capping here keeps such a descriptor from reaching sharp's raw
	// path, where the length mismatch would surface only as libvips's
	// generic 'memory area too small' error.
	if (width * height > MAX_INPUT_PIXELS) return undefined;
	return { width, height, channels };
}

/** pdf-to-image's convention: raw bytes on the payload, geometry on
 * msg.images[] (raw pixels have no container to carry it). */
function geometryFromImages(msg) {
	if (!msg || String(msg.format).toUpperCase() !== "RAW") return undefined;
	const images = Array.isArray(msg.images) ? msg.images : null;
	if (!images || images.length === 0) return undefined;
	const match =
		(msg.page != null && images.find((i) => i && i.page === msg.page)) ||
		images[0];
	return geometryOf(match);
}

/**
 * Raw geometry `{ width, height, channels }` for the image `source` (the
 * payload) travelling on `msg`, or undefined when it is an encoded file.
 * In order: the self-describing object form `{ data, width, height,
 * channels }`; `msg.rawInfo`; pdf-to-image's `msg.images[]` - the last
 * only when no `msg.golden` rides on the same message, because then
 * msg.images describes the golden's render, not the camera frame, and
 * decoding a capture at the artwork's dimensions gives a confident wrong
 * answer rather than an error. golden-compare reads its frame through this.
 */
function rawGeometry(msg, source) {
	const direct = geometryOf(source);
	if (direct) return direct;
	if (!msg) return undefined;
	const explicit = geometryOf(msg.rawInfo);
	if (explicit) return explicit;
	if (msg.golden != null) return undefined;
	return geometryFromImages(msg);
}

/** A raw descriptor that cannot fit in the buffer it travels with
 * would be decoded past the end by sharp (libvips's generic 'memory
 * area too small') - refuse with the actual numbers before sharp is
 * involved. No descriptor: nothing to check. */
function assertRawFits(buffer, raw, label) {
	if (!raw) return;
	const need = raw.width * raw.height * raw.channels;
	if (buffer.byteLength < need) {
		throw new Error(
			`${label} raw descriptor ${raw.width}x${raw.height}x${raw.channels} needs ` +
				`${need} bytes but the buffer holds ${buffer.byteLength}`,
		);
	}
}

module.exports = {
	MAX_INPUT_PIXELS,
	assertImageSignature,
	sharpInput,
	assertPixelsUnderCap,
	asBoolean,
	clampInt,
	clampFloat,
	pickMode,
	isBytes,
	asView,
	assertUnderCap,
	openRegularFile,
	readRegularFile,
	locateSource,
	resolveImage,
	geometryOf,
	geometryFromImages,
	rawGeometry,
	assertRawFits,
};
